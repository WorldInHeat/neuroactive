// functions/src/calendarFeedEndpoint.ts
// Calendar Integration Phase 1, Stage 4 — the private subscribed calendar feed endpoint.
//
// PRODUCT SHAPE: a single unauthenticated (in the Firebase-Auth-login sense) HTTP GET/HEAD
// endpoint at the stable path `/calendar/<43-char-token>.ics` (see firebase.json's Hosting
// rewrite, which routes that path to the `calendarFeed` function below, and
// STAGE4_LOGGING_SECURITY_PLAN.md for the pre-deployment logging-security plan this file's
// own header points to). The 43-character path segment is the RAW Stage 1 bearer secret —
// this is a capability URL, not an OAuth/session-cookie integration; possession of the URL
// is the entire authorization model, exactly as for any `webcal://`-style subscribed feed.
//
// LAYERING (per calendarIcsGenerator.ts's own "LAYERING" comment, which this file is the
// literal fulfillment of): this file owns exactly three responsibilities Stage 1-3
// deliberately left undone —
//   1. Resolving a raw bearer token to an owning, active, non-deleted subscription, by
//      implementing the SIX-STEP contract calendarSubscriptions.ts's own
//      "FUTURE FEED AUTHORIZATION CONTRACT" header locks in verbatim (see resolveSubscription
//      below — the step numbering in that function's comments matches that contract exactly).
//   2. Reading the two already-reviewed Stage 1/2 Firestore documents this token's owner
//      controls, converting their Firestore-native Timestamp fields to plain epoch-ms
//      numbers (the one conversion step calendarFeedAdapter.ts's own header explicitly
//      declines to own — "the intended design was that persisted timestamp conversion
//      happens outside the generator/adapter"), and handing the result to the ALREADY
//      REVIEWED calendarFeedAdapter.buildCalendarFeedInput / calendarIcsGenerator.
//      generateCalendarIcs pipeline unchanged. This file adds NO new weekday/timezone/
//      duration/revision/date-domain validation of its own — see the SHAPE-ONLY VALIDATION
//      note on isValidStoredPreferenceShape below for exactly why that split is safe.
//   3. Translating the result into an HTTP response with a deliberately narrow, low-
//      information contract (see FeedResponseOutcome below) — this file is the ONLY place
//      in Calendar Integration Phase 1 that talks HTTP, Firestore reads (never writes —
//      see READ-ONLY GUARANTEE below), or Firebase Auth existence-checking.
//
// NOT BUILT HERE, DELIBERATELY (matches this Stage's own authorization boundary): OAuth/
// CalDAV/Google/Microsoft provider integration, a renewable recurrence horizon (Stage 3's
// fixed 3,650-day horizon is unchanged and untouched by this file), any notification/
// reminder/course-content/entitlement read, and any general-purpose rate-limiting platform
// (see ABUSE / COST BOUNDARY below for what source-level protection IS in scope here).
//
// READ-ONLY GUARANTEE: every Firestore access in this file is a `.get()` on a single
// document. There is no `.set()`, `.update()`, `.delete()`, `.create()`, or
// `.runTransaction()` anywhere below — a feed request can never mutate a calendar
// subscription, a calendar preference document, the hash-index, the deletion tombstone, or
// any other collection in this project. Verified by both direct reading and by a dedicated
// static test in calendarFeedEndpoint.test.ts (mirroring the STATIC SCOPE / PURITY AUDIT
// convention already used by calendarIcsGenerator.test.ts and calendarFeedAdapter.test.ts).
//
// RAW-TOKEN LOGGING GUARANTEE: no `console.*` call anywhere in this file is ever passed the
// raw token, the resolved request path, or the resolved request URL — every log call below
// logs only a fixed literal message plus, where useful, a caught error's own `.message`
// (never the error's full object, which for some Firestore/Auth SDK errors can echo back
// part of the request that produced them). See summarizeError below. This is a SOURCE-CODE
// guarantee only — it says nothing about what Google/Firebase INFRASTRUCTURE logs about the
// raw incoming request path before this handler ever runs. See
// STAGE4_LOGGING_SECURITY_PLAN.md for that separate, deployment-gated concern.
//
// TESTING SEAM: matching this project's established convention (see calendarSubscriptions.
// ts's own header), every real function below is `db`-PARAMETERIZED (never reaching for the
// module-level `db` directly) so calendarFeedEndpoint.test.ts can exercise the full
// resolution/HTTP pipeline against a fake Firestore. Only the final `calendarFeed` wrapper
// at the bottom supplies the real module-level `db`.
'use strict';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getAuth, FirebaseAuthError } from 'firebase-admin/auth';
import { onRequest, Request } from 'firebase-functions/v2/https';
import type { Response } from 'express';
import { createHash } from 'node:crypto';
import {
  buildCalendarFeedInput,
  CalendarFeedAdapterError,
} from './calendarFeedAdapter';
import { generateCalendarIcs, IcsGenerationError } from './calendarIcsGenerator';
import type { CalendarFeedInput } from './calendarIcsGenerator';

const APP_ID = 'neuroactive-prod';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

// ---------------------------------------------------------------------------------------
// DUPLICATED CONSTANTS — matching the SAME established per-file convention every other
// Calendar Integration file in this project already follows (see calendarFeedAdapter.ts's
// own comment on STAGE_1_SUBSCRIPTION_ID_PATTERN for the identical rationale): each file's
// own copy of a small, stable constant can never become a source of CROSS-FILE regression,
// and this file must not import calendarSubscriptions.ts's or calendarPreferences.ts's
// internals (both only expose their path-builders/hash function via their own test-only
// `__test__` seam, never as production exports — importing a `__test__` object into
// production code would be a far worse coupling than duplicating four one-line path
// template strings and a two-line hash function).
// ---------------------------------------------------------------------------------------

// Stage 1's OWN raw-secret shape (calendarSubscriptions.ts's generateCalendarSecret helper:
// 32 cryptographically random bytes, base64url-encoded), empirically confirmed to always be
// exactly 43 characters from the base64url alphabet (no padding characters are ever
// produced by Node's 'base64url' encoding) before writing this pattern, not assumed.
const RAW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
// Stage 1's own Firestore-auto-ID subscriptionId shape (calendarSubscriptions.ts's
// FIRESTORE_AUTO_ID_PATTERN) — used here only to validate the hash-index entry's own
// `subscriptionId` field before trusting it as a Firestore path segment.
const STAGE_1_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9]{20}$/;
// Firebase Auth's own documented uid length ceiling — used only to bound a corrupt-data
// check on the hash-index entry's `uid` field, never to validate a caller-supplied value.
const MAX_UID_LENGTH = 128;

// The full public path shape, matching firebase.json's Hosting rewrite exactly:
// `/calendar/<43-char-token>.ics`. Anchored on both ends, fixed-length capture group — no
// unbounded quantifier over attacker-controlled content, so this can never backtrack
// pathologically regardless of input length (checked against MAX_PATH_LENGTH first anyway,
// before this pattern is even evaluated, purely to reject oversized input cheaply).
const FEED_PATH_PATTERN = /^\/calendar\/([A-Za-z0-9_-]{43})\.ics$/;
// `/calendar/` (10) + 43 + `.ics` (4) = 57 exactly. A generous-but-bounded ceiling well
// above that lets this reject any pathological/oversized path in O(1) before the regex (or
// any Firestore work) ever runs.
const MAX_PATH_LENGTH = 128;

const PREFERENCE_STORED_KEYS = ['weekdays', 'localTime', 'timezone', 'sessionDurationMinutes', 'revision', 'updatedAt'] as const;

// A bearer-secret subscribed feed must never be cached by a SHARED cache (a CDN, a
// corporate proxy) — `private` forbids that per RFC 9111. Beyond that, every response
// (success included) uses `no-store`: a revoked/rotated credential must not leave a stale
// successful response sitting in a local disk cache that a client could still read after
// the credential stops working server-side (see the cache-hardening review this repair
// closes). This does NOT disable conditional requests — Last-Modified/If-Modified-Since
// (see isFreshFor below) still lets a well-behaved, periodically-repolling calendar client
// send a lightweight revalidation request and get a 304 back (and this file still avoids
// re-running the generator when nothing has changed); `no-store` only means the client may
// not skip that revalidation round-trip by trusting a locally cached copy's age.
const ALLOWED_METHODS = 'GET, HEAD, OPTIONS';

function calendarSubscriptionRef(db: FirebaseFirestore.Firestore, uid: string, subscriptionId: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/calendarSubscriptions/${subscriptionId}`);
}
function calendarHashRef(db: FirebaseFirestore.Firestore, secretHash: string) {
  return db.doc(`artifacts/${APP_ID}/calendarSubscriptionsByHash/${secretHash}`);
}
function calendarAccountStateRef(db: FirebaseFirestore.Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/calendarAccountState/${uid}`);
}
function calendarPreferencesRef(db: FirebaseFirestore.Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/calendarPreferences/main`);
}

// Identical construction to calendarSubscriptions.ts's own hashSecret — sha256 hex digest
// of the raw secret. "Hash the supplied raw token using the exact Stage 1 scheme" (Stage 4
// authorization boundary item 3) means byte-for-byte this algorithm, not merely "a strong
// hash" — a different algorithm or encoding would never match any stored secretHash/
// hash-index entry, silently making every real subscription unresolvable.
function hashToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactOwnKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  if (actual.length !== keys.length) return false;
  const expected = new Set(keys);
  return actual.every((k) => expected.has(k));
}

// SHAPE-ONLY VALIDATION: this checks exactly what only Stage 4 can know (that a genuine
// Firestore read-back has the six expected own keys and a genuine Timestamp instance for
// `updatedAt`) and NOTHING about the semantic validity of weekdays/localTime/timezone/
// sessionDurationMinutes/revision — those are re-validated, authoritatively and exactly
// once, by calendarFeedAdapter.buildCalendarFeedInput below. Duplicating THAT validation
// here as well would be exactly the "reimplementing canonical validation in a way likely to
// drift from existing modules" architectural smell the Stage 3 adversarial review warned
// against — this function deliberately stops short of it.
function isValidStoredPreferenceShape(data: unknown): data is Record<string, unknown> & { updatedAt: Timestamp } {
  if (!isPlainRecord(data)) return false;
  if (!hasExactOwnKeys(data, PREFERENCE_STORED_KEYS)) return false;
  return data.updatedAt instanceof Timestamp;
}

type SubscriptionResolution =
  | { ok: true; uid: string; subscriptionId: string; createdAtMs: number }
  | { ok: false };

// Whether a Firebase Auth account still exists for this uid — injected (never called via
// module-level `getAuth()` directly from resolveSubscription below) for the SAME reason
// `db` is threaded as a parameter everywhere in this file: it lets calendarFeedEndpoint.
// test.ts exercise the full six-step resolution contract, including step 5, against a fake
// implementation with no real Firebase Admin credentials or network access at all. Resolves
// `true`/`false` for "account exists"/"genuinely does not exist"; THROWS for anything else
// (network, permission, service outage) — see realAccountExists below for the one real
// implementation of this contract, and resolveSubscription's own step 5 comment for how
// that distinction is used.
type AccountExistsChecker = (uid: string) => Promise<boolean>;

// THE SIX-STEP CONTRACT — implements calendarSubscriptions.ts's own
// "FUTURE FEED AUTHORIZATION CONTRACT" header verbatim, in the SAME order, failing closed
// at the first unmet condition. Each numbered comment below corresponds exactly to that
// contract's own numbering; nothing here re-orders or skips a step. Can THROW (a genuine
// Firestore/Auth SDK failure) — callers must distinguish that from an ordinary `{ ok: false
// }` resolution failure, since the two map to different HTTP outcomes (see
// resolveCalendarFeedInputCore below).
async function resolveSubscription(
  db: FirebaseFirestore.Firestore,
  accountExists: AccountExistsChecker,
  rawToken: string
): Promise<SubscriptionResolution> {
  const secretHash = hashToken(rawToken);

  // Step 1: sha256(presented raw secret) resolves to a hash-index mapping.
  const hashSnap = await calendarHashRef(db, secretHash).get();
  if (!hashSnap.exists) return { ok: false };
  const hashData = hashSnap.data()!;
  const indexUid = hashData.uid;
  const indexSubscriptionId = hashData.subscriptionId;
  if (
    typeof indexUid !== 'string' ||
    indexUid.length === 0 ||
    indexUid.length > MAX_UID_LENGTH ||
    typeof indexSubscriptionId !== 'string' ||
    !STAGE_1_SUBSCRIPTION_ID_PATTERN.test(indexSubscriptionId)
  ) {
    // Corrupt hash-index entry — fail closed rather than trust a malformed uid/
    // subscriptionId pair into a Firestore path.
    return { ok: false };
  }

  // Step 2: the corresponding owner subscription document exists. The path is built ONLY
  // from server-resolved `indexUid`/`indexSubscriptionId` above — never from any
  // client-supplied value — which is what structurally prevents one subscription's token
  // from ever resolving another user's data (Stage 4 authorization boundary item 10):
  // there is no code path anywhere in this file that accepts a uid or subscriptionId
  // directly from the request.
  const ownerSnap = await calendarSubscriptionRef(db, indexUid, indexSubscriptionId).get();
  if (!ownerSnap.exists) return { ok: false };
  const ownerData = ownerSnap.data()!;
  if (
    typeof ownerData.secretHash !== 'string' ||
    !(ownerData.createdAt instanceof Timestamp) ||
    !(ownerData.revokedAt === null || ownerData.revokedAt instanceof Timestamp)
  ) {
    // Corrupt owner document shape — fail closed before evaluating steps 3/4 below, which
    // both depend on these fields being well-typed.
    return { ok: false };
  }

  // Step 3: the owner document's OWN secretHash matches the hash computed in step 1 —
  // defense in depth against the hash-index entry and the owner document ever
  // independently drifting (see calendarSubscriptions.ts's own header on this exact
  // point).
  if (ownerData.secretHash !== secretHash) return { ok: false };

  // Step 4: not revoked.
  if (ownerData.revokedAt !== null) return { ok: false };

  // Step 5: the Firebase Auth account for this uid still exists. `accountExists` itself
  // resolves `false` only for the specific, well-typed "no such user" case and THROWS for
  // anything else (network, permission, service outage) — letting that propagate here (and
  // out of resolveSubscription entirely) is what lets the caller distinguish "this
  // credential is genuinely invalid" from "we could not find out" (see
  // resolveCalendarFeedInputCore below, which maps the latter to a 503, never a 404).
  if (!(await accountExists(indexUid))) return { ok: false };

  // Step 6: no calendarAccountState/{uid} deletion tombstone exists.
  const tombstoneSnap = await calendarAccountStateRef(db, indexUid).get();
  if (tombstoneSnap.exists) return { ok: false };

  return {
    ok: true,
    uid: indexUid,
    subscriptionId: indexSubscriptionId,
    createdAtMs: ownerData.createdAt.toMillis(),
  };
}

type FeedInputResult =
  | { status: 'ok'; feedInput: CalendarFeedInput }
  // Uniform, deliberately low-information outcome for EVERY "this cannot ever succeed for
  // this token right now" case: malformed token, unknown/revoked/deleted-account/corrupt
  // token mapping (the SIX-STEP contract's own cases), missing calendar preferences, and
  // corrupt stored preference shape all collapse to this one value — see this file's HTTP
  // RESPONSE CONTRACT note below on why extending the "do not distinguish" requirement past
  // just the credential-resolution cases is the simpler, safer choice here.
  | { status: 'not-found' }
  // A genuine infrastructure/unexpected failure (a thrown Firestore/Auth error, or an
  // adapter/generator throwing something other than its own documented error class) — maps
  // to a 503, never a 404, so a well-behaved calendar client has a reason to retry later
  // instead of concluding this subscription is permanently gone.
  | { status: 'unavailable' };

// Exported as a plain, `db`-parameterized, testable "Core" function — matching this
// project's established testing seam (see calendarSubscriptions.ts's own header on this
// convention) — so calendarFeedEndpoint.test.ts can exercise the full resolution + mapping
// pipeline against a fake Firestore, with no live HTTP request/response involved at all.
export async function resolveCalendarFeedInputCore(
  db: FirebaseFirestore.Firestore,
  accountExists: AccountExistsChecker,
  rawTokenInput: unknown
): Promise<FeedInputResult> {
  if (typeof rawTokenInput !== 'string' || !RAW_TOKEN_PATTERN.test(rawTokenInput)) {
    return { status: 'not-found' };
  }
  const rawToken = rawTokenInput;

  let resolution: SubscriptionResolution;
  try {
    resolution = await resolveSubscription(db, accountExists, rawToken);
  } catch {
    return { status: 'unavailable' };
  }
  if (!resolution.ok) return { status: 'not-found' };

  let prefSnap: FirebaseFirestore.DocumentSnapshot;
  try {
    prefSnap = await calendarPreferencesRef(db, resolution.uid).get();
  } catch {
    return { status: 'unavailable' };
  }
  if (!prefSnap.exists) return { status: 'not-found' };
  const prefData = prefSnap.data();
  if (!isValidStoredPreferenceShape(prefData)) return { status: 'not-found' };

  try {
    const feedInput = buildCalendarFeedInput(
      { subscriptionId: resolution.subscriptionId, createdAtMs: resolution.createdAtMs },
      {
        weekdays: prefData.weekdays,
        localTime: prefData.localTime,
        timezone: prefData.timezone,
        sessionDurationMinutes: prefData.sessionDurationMinutes,
        revision: prefData.revision,
        updatedAtMs: prefData.updatedAt.toMillis(),
      }
    );
    return { status: 'ok', feedInput };
  } catch (error) {
    if (error instanceof CalendarFeedAdapterError) return { status: 'not-found' };
    return { status: 'unavailable' };
  }
}

function extractToken(path: string): string | null {
  if (typeof path !== 'string' || path.length === 0 || path.length > MAX_PATH_LENGTH) return null;
  const match = FEED_PATH_PATTERN.exec(path);
  return match ? match[1] : null;
}

function isFreshFor(ifModifiedSinceHeader: string | null, lastModifiedDate: Date): boolean {
  if (!ifModifiedSinceHeader) return false;
  const parsedMs = Date.parse(ifModifiedSinceHeader);
  if (Number.isNaN(parsedMs)) return false;
  return parsedMs >= lastModifiedDate.getTime();
}

// HTTP-date resolution is whole-seconds only (RFC 9110's IMF-fixdate has no sub-second
// field) — flooring here, once, keeps the Last-Modified header and the isFreshFor
// comparison exactly consistent with each other.
function flooredDate(ms: number): Date {
  return new Date(Math.floor(ms / 1000) * 1000);
}

type FeedResponseOutcome =
  | { kind: 'options' }
  | { kind: 'method-not-allowed' }
  | { kind: 'not-found' }
  | { kind: 'unavailable' }
  | { kind: 'not-modified'; lastModified: string }
  | { kind: 'ok'; body: string; contentLength: number; lastModified: string; includeBody: boolean };

// THE FULL REQUEST-HANDLING PIPELINE, expressed over plain primitive inputs rather than a
// live Express Request — matching the same "Core function" testability convention used
// throughout this project (see calendarSubscriptions.ts's header). The onRequest wrapper
// below is the ONLY code in this file that touches a real Request/Response object, and does
// nothing but plumb three primitive fields in and materialize the returned outcome.
export async function handleCalendarFeedRequestCore(
  db: FirebaseFirestore.Firestore,
  accountExists: AccountExistsChecker,
  input: { method: string; path: string; ifModifiedSince: string | null }
): Promise<FeedResponseOutcome> {
  if (input.method === 'OPTIONS') return { kind: 'options' };
  if (input.method !== 'GET' && input.method !== 'HEAD') return { kind: 'method-not-allowed' };

  const rawToken = extractToken(input.path);
  const result = await resolveCalendarFeedInputCore(db, accountExists, rawToken);
  if (result.status === 'unavailable') return { kind: 'unavailable' };
  if (result.status === 'not-found') return { kind: 'not-found' };

  const lastModifiedDate = flooredDate(result.feedInput.updatedAtMs);
  const lastModifiedHeader = lastModifiedDate.toUTCString();

  // Conditional-GET short-circuit: deliberately evaluated BEFORE generateCalendarIcs (the
  // expensive VTIMEZONE-transition-scanning step) runs — a well-behaved, periodically
  // repolling calendar client that already holds the current representation costs this
  // endpoint one Firestore-backed resolution and zero generator work. See ABUSE / COST
  // BOUNDARY in this file's own header.
  if (isFreshFor(input.ifModifiedSince, lastModifiedDate)) {
    return { kind: 'not-modified', lastModified: lastModifiedHeader };
  }

  let icsText: string;
  try {
    icsText = generateCalendarIcs(result.feedInput);
  } catch (error) {
    if (error instanceof IcsGenerationError) return { kind: 'not-found' };
    return { kind: 'unavailable' };
  }

  return {
    kind: 'ok',
    body: icsText,
    contentLength: Buffer.byteLength(icsText, 'utf8'),
    lastModified: lastModifiedHeader,
    includeBody: input.method === 'GET',
  };
}

// Logs only a fixed literal plus a caught error's own message — never the error object
// itself (which for some SDK errors can echo back part of the request that produced them),
// never the request path, never the token. See this file's own RAW-TOKEN LOGGING GUARANTEE
// header note.
function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : 'non-Error thrown value';
}

// Materializes a FeedResponseOutcome onto a real Response. Deliberately mechanical — every
// actual DECISION (what status, what body, whether to distinguish two failure cases) was
// already made by handleCalendarFeedRequestCore above; this function only ever reads the
// outcome's own `kind` and writes the corresponding fixed response.
function applyOutcome(response: Response, outcome: FeedResponseOutcome): void {
  // Applied to every outcome, success or failure alike: this is a bearer-secret capability
  // URL, so no response from this endpoint may ever be cached by a shared/CDN cache (see
  // the no-store rationale above), and hardening headers cost nothing to always set.
  response.set('X-Content-Type-Options', 'nosniff');
  response.set('Referrer-Policy', 'no-referrer');

  switch (outcome.kind) {
    case 'options':
      response.set('Allow', ALLOWED_METHODS);
      response.set('Cache-Control', 'private, no-store');
      response.status(204).end();
      return;
    case 'method-not-allowed':
      response.set('Allow', ALLOWED_METHODS);
      response.set('Cache-Control', 'private, no-store');
      response.status(405).type('text/plain').send('Method not allowed');
      return;
    case 'not-found':
      // Deliberately identical, in every externally observable way, for a malformed
      // token, an unknown token, a revoked token, a deleted-account token, a corrupt
      // token-mapping, a subscription with no calendar preferences configured yet, and a
      // subscription whose adapter/generator inputs are otherwise invalid — see
      // FeedInputResult's own comment above for why this endpoint deliberately extends
      // "do not distinguish" beyond just the six-step credential contract.
      response.set('Cache-Control', 'private, no-store');
      response.status(404).type('text/plain').send('Not found');
      return;
    case 'unavailable':
      response.set('Cache-Control', 'private, no-store');
      response.status(503).type('text/plain').send('Service unavailable');
      return;
    case 'not-modified':
      response.set('Cache-Control', 'private, no-store');
      response.set('Last-Modified', outcome.lastModified);
      response.status(304).end();
      return;
    case 'ok':
      response.set('Content-Type', 'text/calendar; charset=utf-8');
      response.set('Cache-Control', 'private, no-store');
      response.set('Last-Modified', outcome.lastModified);
      response.set('Content-Length', String(outcome.contentLength));
      // Deliberately no Content-Disposition: this is a SUBSCRIBED feed (periodic
      // background refetch by a calendar client), not a one-time download — an
      // `attachment` disposition invites some HTTP clients/browsers to treat this as a
      // file to save rather than a live webcal-style feed, which is the opposite of the
      // intended subscription-provider compatibility. `Content-Type: text/calendar` alone
      // is the standard signal calendar clients rely on for feed detection.
      response.status(200);
      if (outcome.includeBody) {
        response.send(outcome.body);
      } else {
        response.end();
      }
      return;
  }
}

// The one real implementation of AccountExistsChecker — see that type's own comment above.
// Not used by anything in this file except the calendarFeed wrapper below; every Core
// function above only ever sees it through the injected parameter.
async function realAccountExists(uid: string): Promise<boolean> {
  try {
    await getAuth().getUser(uid);
    return true;
  } catch (error) {
    if (error instanceof FirebaseAuthError && error.code === 'auth/user-not-found') {
      return false;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------------------
// THE DEPLOYED CLOUD FUNCTION — a thin wrapper matching this project's own established
// convention (see calendarSubscriptions.ts's header): all real logic lives in the
// `db`-parameterized Core functions above; this wrapper supplies only the real module-level
// `db`, the real Request's three relevant fields, and materializes the result.
//
// maxInstances is a deliberate, narrow, SOURCE-level cost/blast-radius bound for this
// specific publicly-callable-without-Firebase-login endpoint (Stage 4 authorization
// boundary: "request concurrency/cost amplification") — not a general-purpose rate-limiting
// platform. It bounds worst-case concurrent execution cost from an abuse campaign without
// requiring any deployment-time IAM/Cloud Armor configuration. Set to 5, deliberately below
// the Firebase Functions v2 platform default of 20: this is a public, bearer-token-gated
// endpoint serving low-volume individual calendar subscribers, and 5 instances at the
// platform's default maxInstanceRequestConcurrency: 80 still yields up to 400 concurrent
// requests — comfortably above any realistic legitimate load, while meaningfully reducing
// worst-case cost/abuse exposure compared to the platform default of 20 instances (1,600
// concurrent). Confirmed via real production inspection of a comparable existing function;
// see STAGE4_LOGGING_SECURITY_PLAN.md §7.
//
// cors: false IS REQUIRED, NOT OPTIONAL. For onRequest, an omitted `cors` key does NOT
// itself mean CORS is enabled — the framework's cors-wrapping middleware installs only when
// `"cors" in opts` (any value, including `false`) OR when FIREBASE_DEBUG_MODE is active with
// its "enableCors" debug feature. The real Firebase Functions emulator sets BOTH
// unconditionally for every function it spawns (confirmed directly against firebase-tools'
// own functionsEmulator.js), so an omitted `cors` key still triggers the middleware there —
// which answers every OPTIONS request itself (before handleCalendarFeedRequestCore ever
// runs) and reflects an arbitrary request `Origin` back as `Access-Control-Allow-Origin` —
// verified directly against a real emulator-hosted request with `Origin:
// https://evil.example.com`. (onCall, the adjacent v2 export, has its own different default
// — it resolves an omitted `cors` to `true` unconditionally; that default does not apply
// here.) Explicitly setting `cors: false` resolves to a falsy `origin` inside the installed
// `cors` package's own middleware wrapper, which — traced directly in its source — takes
// the early `next()` branch with no header manipulation and no OPTIONS auto-response, in
// both the normal and the debug/emulator case, letting every request reach this handler and
// `applyOutcome` exactly as designed. Not a general CORS policy choice (no legitimate
// browser-JS cross-origin use case exists for a bearer-secret calendar feed) — it is what
// makes this file's own response contract actually govern every real response.
// ---------------------------------------------------------------------------------------
export const calendarFeed = onRequest({ maxInstances: 5, cors: false }, async (request: Request, response: Response) => {
  let outcome: FeedResponseOutcome;
  try {
    outcome = await handleCalendarFeedRequestCore(db, realAccountExists, {
      method: request.method,
      path: request.path,
      ifModifiedSince: request.header('if-modified-since') ?? null,
    });
  } catch (error) {
    console.error('[Calendar Feed] Unexpected request-handling failure.', summarizeError(error));
    outcome = { kind: 'unavailable' };
  }
  applyOutcome(response, outcome);
});

// Exported for tests only — not part of the public callable surface.
export const __test__ = {
  APP_ID,
  RAW_TOKEN_PATTERN,
  STAGE_1_SUBSCRIPTION_ID_PATTERN,
  FEED_PATH_PATTERN,
  MAX_PATH_LENGTH,
  MAX_UID_LENGTH,
  ALLOWED_METHODS,
  PREFERENCE_STORED_KEYS,
  calendarSubscriptionRef,
  calendarHashRef,
  calendarAccountStateRef,
  calendarPreferencesRef,
  hashToken,
  isPlainRecord,
  hasExactOwnKeys,
  isValidStoredPreferenceShape,
  resolveSubscription,
  realAccountExists,
  extractToken,
  isFreshFor,
  flooredDate,
  applyOutcome,
  summarizeError,
};
