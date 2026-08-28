// functions/src/calendarSubscriptions.ts
// Calendar Integration Phase 1, Stage 1 — account-deletion + token-lifecycle foundation
// ONLY. No ICS generation, no public feed endpoint, no calendar schedule preferences, and
// no dependency on DNS course progress anywhere in this file.
//
// TRUST MODEL: the client never writes either Firestore collection below directly (see
// firestore.rules — write is denied entirely on both). The only ways a calendar
// subscription's owner-facing metadata or hash-index entry are ever created, revoked, or
// removed are the three callables and the one Auth-deletion trigger in this file.
//
// TOKEN MODEL (per the reviewed architecture — the full-random-token/hash-index design,
// NOT an "id.secret" split): the raw subscription secret is a single, 256-bit,
// cryptographically random value, generated server-side, returned to the authenticated
// caller exactly once (in the createCalendarSubscription response) and NEVER persisted
// raw, anywhere, by this file. Only its SHA-256 hash is ever stored — as the DOCUMENT ID
// of a server-only lookup-index collection (artifacts/{appId}/calendarSubscriptionsByHash),
// mirroring the already-reviewed pushTokenClaims pattern elsewhere in this project (a
// hash-keyed index, never the raw credential). The owner-facing document
// (artifacts/{appId}/users/{uid}/calendarSubscriptions/{subscriptionId}) ALSO stores that
// same hash (never the raw secret) — this is not a speculative convenience field: it is
// the only way revokeCalendarSubscription (which receives a subscriptionId, never the raw
// secret) can find and remove the corresponding hash-index entry. A hash is not the secret
// itself (SHA-256 is preimage-resistant), so storing it on an owner-readable document
// leaks nothing to anyone who doesn't already possess the raw value.
//
// FUTURE FEED AUTHORIZATION CONTRACT — Codex repair pass, item 3; extended in Codex repair
// pass 2 to add step 6 (the tombstone introduced by that pass). NOT IMPLEMENTED in this
// file (there is no public feed endpoint in Stage 1) — this is a LOCKED contract for
// whatever implements it later, specifically so that future implementation does not treat
// hash-index existence ALONE as sufficient authorization. A future feed request may serve
// an ICS response ONLY if ALL SIX of the following hold, checked in this order, failing
// closed at the first unmet condition:
//   1. sha256(presented raw secret) resolves to a hash-index mapping in
//      calendarSubscriptionsByHash (i.e. the document exists at all).
//   2. The corresponding owner subscription document (by the hash-index entry's
//      `subscriptionId`, under the hash-index entry's `uid`) exists.
//   3. That owner subscription document's OWN `secretHash` field matches the hash computed
//      in step 1 (defense in depth against the two ever independently drifting).
//   4. That owner subscription document's `revokedAt` is exactly `null`.
//   5. The Firebase Auth account for that `uid` still exists (an account-deletion race
//      between the trigger completing and a feed request arriving must still fail closed).
//   6. NO calendarAccountState/{uid} deletion tombstone exists for that uid. Kept as an
//      independent, explicit condition rather than folded into step 5 — the tombstone is
//      this project's OWN authoritative, permanent, transactionally-consistent record of
//      "this uid's calendar credentials must never be honored again," and must be checked
//      even in a hypothetical future where step 5's Auth-existence check is itself somehow
//      unavailable, delayed, or bypassed.
// Unknown (step 1 fails), malformed, revoked (step 4 fails), deleted-account (step 5
// fails), tombstoned (step 6 fails), missing-owner (step 2 fails), or mismatched (step 3
// fails) records must ALL eventually produce the exact same sanitized "not found" response
// — never a differentiated one, and never a response that lets a caller distinguish WHICH
// of the six conditions failed. See FutureFeedAuthorizationStep below for a typed,
// discoverable enumeration of these six steps, kept in sync with this comment.
export type FutureFeedAuthorizationStep =
  | 'hash-index-entry-exists'
  | 'owner-subscription-document-exists'
  | 'owner-secret-hash-matches'
  | 'owner-not-revoked'
  | 'auth-account-still-exists'
  | 'no-deletion-tombstone';
//
// TESTING SEAM: matching this project's established convention (see
// reminderDeliveryWorker.ts/.test.ts), all actual logic lives in plain, exported,
// db-parameterized "Core" functions below. The onCall/onUserDeleted-wrapped exports at the
// bottom are thin wrappers that supply the real module-level `db` and nothing else — tests
// call the Core functions directly against a fake db, never the wrapped exports.
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
// MECHANISM VERIFIED against the actually-installed firebase-functions version (7.3.2)
// before writing this file — not assumed:
//   - The bare default import (`require('firebase-functions')`) does NOT expose
//     `.auth.user()` in this version — confirmed directly (`typeof functions.auth ===
//     'undefined'`). Blindly writing `functions.auth.user().onDelete(...)` against the
//     default import, as the legacy v1 idiom is usually written, would not have compiled.
//   - `firebase-functions/v2/identity` DOES export `onUserDeleted` at the JS runtime
//     level, but it has NO TypeScript type declarations anywhere in this package version's
//     .d.ts files (confirmed by reading identity.d.ts directly — only the *blocking*
//     triggers, beforeUserCreated/beforeUserSignedIn/beforeEmailSent/beforeSmsSent, are
//     declared there). An export with no type surface in an otherwise fully-typed v2 API
//     is not something to build production Auth-deletion cleanup on.
//   - `firebase-functions/v1` (an explicit, separate, fully-typed subpath export — see its
//     own dedicated `./lib/v1/index.d.ts`, wired into this package's own `exports` map) DOES
//     provide `auth.user().onDelete()`, genuinely typed and currently shipped. This is NOT
//     the same thing as "blindly assume the legacy default import works" — it's an
//     explicit, still-supported, separately-exported API this project simply hasn't used
//     yet. Mixing v1 and v2 triggers in one Cloud Functions codebase (as opposed to mixing
//     import styles for the SAME trigger) is standard, fully-supported Firebase practice.
import * as functionsV1 from 'firebase-functions/v1';
import { randomBytes, createHash } from 'node:crypto';

const APP_ID = 'neuroactive-prod';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

// Duplicated from pushInstallations.ts/notificationPreferences.ts by established
// per-file convention in this codebase (see notificationPreferences.ts's own header for the
// stated rationale: each file's copy can never become a source of cross-file regression).
function requireNonAnonymousAuth(request: {
  auth?: { uid: string; token: { firebase?: { sign_in_provider?: string } } };
}): string {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  if (request.auth.token.firebase?.sign_in_provider === 'anonymous') {
    throw new HttpsError('permission-denied', 'A permanent account is required.');
  }
  return request.auth.uid;
}

// Same enforceAppCheck: true posture as every other reviewed callable in this project.
const CALLABLE_OPTIONS = { enforceAppCheck: true } as const;

const MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS = 5;
const MAX_LABEL_LENGTH = 60;

function calendarSubscriptionsCollection(db: FirebaseFirestore.Firestore, uid: string) {
  return db.collection(`artifacts/${APP_ID}/users/${uid}/calendarSubscriptions`);
}
function calendarSubscriptionRef(db: FirebaseFirestore.Firestore, uid: string, subscriptionId: string) {
  return calendarSubscriptionsCollection(db, uid).doc(subscriptionId);
}
function calendarHashRef(db: FirebaseFirestore.Firestore, secretHash: string) {
  return db.doc(`artifacts/${APP_ID}/calendarSubscriptionsByHash/${secretHash}`);
}
// Codex repair pass, item 2: the top-level hash-index COLLECTION (not a single doc), used
// so account-deletion cleanup can query `where('uid', '==', deletedUid)` directly — finding
// every credential belonging to a uid WITHOUT going through owner-facing metadata at all.
function calendarSubscriptionsByHashCollection(db: FirebaseFirestore.Firestore) {
  return db.collection(`artifacts/${APP_ID}/calendarSubscriptionsByHash`);
}
// Codex repair pass 2: the fixed, single, server-only per-uid deletion tombstone. A FIXED
// document PATH (not a query) so it can be read as an ordinary transactional document get
// from both createCalendarSubscriptionCore's transaction and the account-deletion
// transaction below — this is the shared Firestore contention point the create-versus-
// deletion serialization repair depends on. See CalendarAccountStateDoc for the (narrow,
// non-speculative) shape stored here.
function calendarAccountStateRef(db: FirebaseFirestore.Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/calendarAccountState/${uid}`);
}

// crypto.randomBytes(32).toString('base64url') is the SAME construction already used for
// opaque secrets elsewhere in this project (see pushInstallations.ts) — 256 bits of
// entropy, URL-safe, no padding characters to escape.
function generateCalendarSecret(): string {
  return randomBytes(32).toString('base64url');
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

// Optional, purely descriptive — never interpreted as device identity anywhere in this
// file or its data model. A missing/empty label is valid (stored as null, not an empty
// string, so a client rendering it never has to special-case "" vs undefined).
function requireOptionalLabel(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpsError('invalid-argument', 'label must be a string if provided.');
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_LABEL_LENGTH) {
    throw new HttpsError('invalid-argument', `label must be ${MAX_LABEL_LENGTH} characters or fewer.`);
  }
  return trimmed;
}

// Codex repair pass, item 5: strict allowlist matching the ACTUAL shape Firestore's own
// no-argument `.doc()` auto-ID generator produces (confirmed against the real Admin SDK —
// createCalendarSubscriptionCore uses exactly this call, `calendarSubscriptionsCollection(
// db, uid).doc()`, to allocate subscriptionRef.id) — a 20-character string drawn from
// [A-Za-z0-9]. Rejects path-separator characters (`/`, `\`), control characters, and
// oversized/malformed values BEFORE any path is ever constructed from the value — the
// callable fails closed on shape alone, never attempting a Firestore call with an
// unvalidated string.
const FIRESTORE_AUTO_ID_PATTERN = /^[A-Za-z0-9]{20}$/;

function requireSubscriptionId(value: unknown): string {
  if (typeof value !== 'string' || !FIRESTORE_AUTO_ID_PATTERN.test(value)) {
    throw new HttpsError('invalid-argument', 'subscriptionId must be a valid subscription identifier.');
  }
  return value;
}

type OwnerSubscriptionDoc = {
  label: string | null;
  createdAt: Timestamp | FirebaseFirestore.FieldValue;
  revokedAt: Timestamp | FirebaseFirestore.FieldValue | null;
  secretHash: string;
};

// Codex repair pass 2: minimum state only, per instruction — no speculative lifecycle
// fields. `deleted` is always `true` when this document exists at all; the document's mere
// EXISTENCE is itself the tombstone, and it is never removed once written (see
// handleCalendarUserDeletedCore's header comment).
type CalendarAccountStateDoc = {
  deleted: true;
  deletedAt: Timestamp | FirebaseFirestore.FieldValue;
};

// ---------------------------------------------------------------------------------------
// CREATE (core) — enforces the active-subscription cap, generates the secret, persists
// BOTH the owner-facing metadata and the hash-index entry atomically, returns the raw
// secret exactly once. Never touches, reads for mutation purposes, or otherwise affects
// any EXISTING subscription — the transaction below only ever reads existing docs to COUNT
// them for the cap check.
//
// Codex repair pass 2, PRIMARY HIGH FINDING (create-versus-account-deletion race): a
// caller's ID token can still be valid for a brief window after the corresponding Firebase
// Auth account (and this uid's calendar credentials) have already been deleted elsewhere —
// `request.auth` alone cannot rule that out, since authentication may have happened before
// a CONCURRENT deletion. This function therefore reads the uid's fixed
// calendarAccountState/{uid} tombstone document INSIDE this same transaction, before any
// write, and fails closed if it exists. Reading a FIXED document path (rather than, say,
// re-checking request.auth) is what gives this transaction a real, concrete Firestore
// contention point in common with the account-deletion transaction below — the two
// transactions can no longer commit an interleaving where deletion completes first but a
// usable credential still gets created afterward (see that function's own header for the
// two-serialization proof).
// ---------------------------------------------------------------------------------------
export async function createCalendarSubscriptionCore(
  db: FirebaseFirestore.Firestore,
  uid: string,
  labelInput: unknown
): Promise<{ subscriptionId: string; secret: string; label: string | null }> {
  const label = requireOptionalLabel(labelInput);

  const secret = generateCalendarSecret();
  const secretHash = hashSecret(secret);
  const subscriptionRef = calendarSubscriptionsCollection(db, uid).doc();
  const hashRef = calendarHashRef(db, secretHash);
  const tombstoneRef = calendarAccountStateRef(db, uid);

  await db.runTransaction(async (transaction) => {
    // ALL READS BEFORE ANY WRITE (required both by Firestore transaction semantics and by
    // this repair's own serialization proof).
    const tombstoneSnap = await transaction.get(tombstoneRef);
    // Revoked subscriptions do NOT count toward the active cap — a user who has created
    // and revoked several over time can still hold up to MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS
    // active ones at any given moment. Reading the actual matching documents (not merely a
    // count) inside the transaction keeps this check and the write below atomic; the
    // result set is bounded by the same cap this check enforces, so it is always small.
    const activeSnap = await transaction.get(
      calendarSubscriptionsCollection(db, uid).where('revokedAt', '==', null)
    );
    // A 256-bit hash collision against an existing index entry is astronomically
    // unlikely — checked anyway, rather than silently overwriting, because "silently
    // overwrite another subscription's lookup entry" is exactly the kind of failure mode
    // that must never happen even in a one-in-2^256 scenario.
    const hashSnap = await transaction.get(hashRef);

    if (tombstoneSnap.exists) {
      // Fail closed. No owner doc, no hash-index entry, no usable raw credential is ever
      // returned — the caller receives only this error, thrown before any write below.
      throw new HttpsError('permission-denied', 'Unable to create a calendar subscription for this account.');
    }
    if (activeSnap.size >= MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS) {
      throw new HttpsError(
        'resource-exhausted',
        `Maximum of ${MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS} active calendar subscriptions reached. Revoke one before creating another.`
      );
    }
    if (hashSnap.exists) {
      throw new HttpsError('internal', 'Could not allocate a unique subscription credential. Please try again.');
    }

    const ownerDoc: OwnerSubscriptionDoc = {
      label,
      createdAt: FieldValue.serverTimestamp(),
      revokedAt: null,
      secretHash,
    };
    transaction.set(subscriptionRef, ownerDoc);
    transaction.set(hashRef, { uid, subscriptionId: subscriptionRef.id });
  });

  // The ONLY point in this file's lifetime where the raw secret is ever returned or
  // exists outside local memory — never logged, never written anywhere above.
  return { subscriptionId: subscriptionRef.id, secret, label };
}

// ---------------------------------------------------------------------------------------
// REVOKE ONE (core) — proves ownership via the authenticated uid's own document path (a
// client cannot name another user's subscription; the Firestore path itself is
// uid-scoped), marks the owner-facing doc revoked, and deletes the hash-index entry so the
// credential becomes structurally unusable. Idempotent: a missing document or an
// already-revoked one is a silent no-op, never an error — a client retrying after a
// dropped response must never see a spurious failure for an action that already
// succeeded. Never touches any OTHER subscription document.
// ---------------------------------------------------------------------------------------
export async function revokeCalendarSubscriptionCore(
  db: FirebaseFirestore.Firestore,
  uid: string,
  subscriptionIdInput: unknown
): Promise<{ revoked: true }> {
  const subscriptionId = requireSubscriptionId(subscriptionIdInput);
  const subscriptionRef = calendarSubscriptionRef(db, uid, subscriptionId);

  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(subscriptionRef);
    if (!snap.exists) return; // never existed, or already fully processed — idempotent no-op.
    const data = snap.data() as OwnerSubscriptionDoc;
    if (data.revokedAt !== null) return; // already revoked — idempotent no-op.

    transaction.update(subscriptionRef, { revokedAt: FieldValue.serverTimestamp() });
    transaction.delete(calendarHashRef(db, data.secretHash));
  });

  return { revoked: true };
}

// ---------------------------------------------------------------------------------------
// REVOKE ALL (core) — operates only on the authenticated uid's own subcollection
// (structurally cannot reach another user's subscriptions). Bounded by
// MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS (at most that many active documents can ever exist to
// process). Idempotent: repeated invocation finds nothing left to revoke and is a harmless
// no-op.
// ---------------------------------------------------------------------------------------
export async function revokeAllCalendarSubscriptionsCore(
  db: FirebaseFirestore.Firestore,
  uid: string
): Promise<{ revokedCount: number }> {
  const revokedCount = await db.runTransaction(async (transaction) => {
    const activeSnap = await transaction.get(
      calendarSubscriptionsCollection(db, uid).where('revokedAt', '==', null)
    );
    const now = FieldValue.serverTimestamp();
    for (const doc of activeSnap.docs) {
      const data = doc.data() as OwnerSubscriptionDoc;
      transaction.update(doc.ref, { revokedAt: now });
      transaction.delete(calendarHashRef(db, data.secretHash));
    }
    return activeSnap.size;
  });

  return { revokedCount };
}

// ---------------------------------------------------------------------------------------
// ACCOUNT DELETION (core) — Calendar Phase 1's OWN, narrow invariant only: every calendar
// subscription credential previously belonging to a deleted uid must become unusable, and
// must remain permanently unusable even if the uid is somehow reused or a create call was
// already in flight. This touches NOTHING else — no userData, entitlement,
// notificationPreferences, push installations, or Stripe state. It does not attempt to
// solve this project's broader (currently nonexistent) account-deletion/data-lifecycle
// problem.
//
// Codex repair pass, item 2 (HIGH finding, round 1): the PREVIOUS version of this function
// found credentials to invalidate by reading owner-facing metadata first (iterating
// calendarSubscriptions docs, then deleting each one's referenced hash entry) — meaning a
// missing, malformed, or otherwise-unreadable owner-facing document could leave its
// corresponding hash-index entry (the ACTUAL security-critical credential) untouched and
// still valid. Fixed by querying the hash-index collection DIRECTLY by `uid`.
//
// Codex repair pass 2 (HIGH finding, round 2 — create-versus-deletion race): querying and
// deleting hash entries was previously a SEPARATE, non-transactional step from anything
// else, which left a window where an already-running createCalendarSubscriptionCore call
// (started before deletion, reading no tombstone because none existed yet) could commit a
// brand-new owner+hash pair AFTER this function's hash query had already run and found
// nothing to delete. The STEP 1 block below closes that window by making tombstone-write
// and hash-deletion happen in ONE Firestore transaction that ALSO reads the same
// calendarAccountState/{uid} document createCalendarSubscriptionCore's own transaction
// reads — giving the two operations a shared, real Firestore contention point instead of
// two independent, un-ordered operations. Both required serializations now hold:
//   A. CREATE COMMITS FIRST: create's transaction reads no tombstone (none exists yet) and
//      commits owner+hash. This function's transaction then runs, finds that hash entry via
//      its uid-scoped query, and deletes it in the same transaction that writes the
//      tombstone. Final state: tombstone present, hash absent.
//   B. DELETION COMMITS FIRST: this function's transaction writes the tombstone and deletes
//      every hash entry that exists at that moment. A create call whose transaction has not
//      yet committed re-reads the tombstone (Firestore transactions restart on conflicting
//      writes) and now sees it exists, so it fails closed and commits nothing. Final state:
//      tombstone present, hash absent.
// In neither ordering can deletion complete while a usable hash entry survives.
//
// This version remains completely independent of owner-metadata integrity: an orphaned
// hash entry with no owner doc, or an owner doc with corrupted/missing fields, cannot
// prevent credential invalidation or tombstone creation, because owner metadata is never
// consulted to determine WHICH hashes to delete or whether to write the tombstone. Owner-
// facing docs are updated separately, AFTER the critical transaction, best-effort, purely
// for the management UI's own bookkeeping — that step's success or failure can neither
// undo the tombstone nor revive a deleted hash entry, and has no bearing on whether the
// credential itself is unusable.
//
// Idempotent and retry-safe: re-running finds the tombstone already present (skips
// rewriting it — see the `!tombstoneSnap.exists` guard below, which also keeps the
// original deletedAt stable across retries) and only already-deleted hash entries (an
// empty query result), and is a no-op either way. Cloud Functions Auth-event triggers are
// at-least-once (see the runWith retry configuration on the wrapped export below), so this
// property is load-bearing, not incidental. Bounded under normal API invariants: a uid can
// have at most MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS active hash entries at any time (the same
// invariant createCalendarSubscriptionCore's cap enforces), so this query result size is
// always small.
// ---------------------------------------------------------------------------------------
export async function handleCalendarUserDeletedCore(db: FirebaseFirestore.Firestore, uid: string): Promise<void> {
  const tombstoneRef = calendarAccountStateRef(db, uid);

  // STEP 1 (security-critical, always attempted, ONE transaction): read the tombstone and
  // every matching hash-index entry (ALL READS FIRST), then write the tombstone (if not
  // already present) and delete every matching hash entry (ALL WRITES AFTER). This alone is
  // sufficient to make every credential the uid ever held unusable, permanently — nothing
  // below this point is required for that guarantee to hold.
  await db.runTransaction(async (transaction) => {
    const tombstoneSnap = await transaction.get(tombstoneRef);
    const hashSnap = await transaction.get(calendarSubscriptionsByHashCollection(db).where('uid', '==', uid));

    if (!tombstoneSnap.exists) {
      const tombstoneDoc: CalendarAccountStateDoc = {
        deleted: true,
        deletedAt: FieldValue.serverTimestamp(),
      };
      transaction.set(tombstoneRef, tombstoneDoc);
    }
    for (const doc of hashSnap.docs) {
      transaction.delete(doc.ref);
    }
  });

  // STEP 2 (best-effort bookkeeping only): mark owner-facing docs revoked for UI/audit
  // purposes. Deliberately AFTER the critical transaction above, and deliberately
  // non-fatal — a failure or omission here never re-exposes a credential (the tombstone and
  // hash deletion already committed) and never blocks this function from completing
  // successfully, and can never undo or invalidate the critical transaction's result.
  try {
    const activeSnap = await calendarSubscriptionsCollection(db, uid).where('revokedAt', '==', null).get();
    if (!activeSnap.empty) {
      const ownerBatch = db.batch();
      const now = FieldValue.serverTimestamp();
      for (const doc of activeSnap.docs) {
        ownerBatch.update(doc.ref, { revokedAt: now });
      }
      await ownerBatch.commit();
    }
  } catch {
    // Best-effort only, per the header comment above — never rethrown, never allowed to
    // make this function's overall outcome look like a failure when the security-critical
    // step 1 already succeeded.
  }
}

// ---------------------------------------------------------------------------------------
// THIN WRAPPERS — the actual deployed Cloud Functions. Each supplies the real module-level
// `db` and the authenticated uid (never client-supplied — see requireNonAnonymousAuth) to
// its Core function above, and nothing else. This is the ONLY place in this file the real
// db is used; every Core function above is fully db-agnostic and exercised in tests
// against a fake db instead.
// ---------------------------------------------------------------------------------------
export const createCalendarSubscription = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  return createCalendarSubscriptionCore(db, uid, (request.data as { label?: unknown } | undefined)?.label);
});

export const revokeCalendarSubscription = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  return revokeCalendarSubscriptionCore(db, uid, (request.data as { subscriptionId?: unknown } | undefined)?.subscriptionId);
});

export const revokeAllCalendarSubscriptions = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  return revokeAllCalendarSubscriptionsCore(db, uid);
});

// See the import comment at the top of this file for the full verification trail. This is
// `firebase-functions/v1`'s own, separately-exported, fully-typed `auth.user().onDelete()`
// — the correct, currently-supported mechanism for this specific trigger type in the
// installed firebase-functions version, not the bare default-import idiom (which does not
// work here) and not v2's untyped `onUserDeleted` (not part of this version's typed API).
//
// RETRY POLICY — Codex repair pass, item 1. VERIFIED against the installed v1 type surface
// (functions/node_modules/firebase-functions/lib/v1/function-configuration.d.ts,
// RuntimeOptions.failurePolicy) before writing this, not assumed: `failurePolicy: true` is
// the documented shorthand for "equivalent to providing an empty retry object" — i.e. this
// background/event function becomes eligible for Cloud Functions' automatic retry-on-
// failure behavior. `runWith(...)` returns a FunctionBuilder that itself exposes `.auth`
// (confirmed: `get auth(): { user: (...) => auth.UserBuilder }` in
// function-builder.d.ts), so `.auth.user().onDelete(...)` chains identically to the
// unconfigured form above — this is the same trigger, just deployed with retry enabled.
// Meaningful specifically BECAUSE handleCalendarUserDeletedCore's hash-index deletion (see
// its own header comment) is idempotent and safe to re-run: a transient failure (e.g. a
// dropped Firestore call) can be retried by the platform without any risk of double-
// processing or partial-state corruption.
//
// BULK-DELETE POLICY — Codex repair pass, item 4, locked here as the operationally
// relevant location: the Admin SDK's bulk `auth.deleteUsers([...])` does NOT emit
// individual `auth.user().onDelete()` events (confirmed Firebase/GCP platform behavior,
// not specific to this codebase) — meaning bulk deletion would silently bypass this
// trigger and leave calendar credentials for those accounts valid. Calendar Stage 1 does
// NOT build speculative bulk-deletion infrastructure to compensate. The operational policy
// instead is: NeuroActive account deletion MUST use an individual user-deletion path that
// emits this supported Auth deletion trigger (e.g. `auth.deleteUser(uid)`, or a user
// deleting their own account via the client SDK). Admin SDK bulk `deleteUsers()` is
// PROHIBITED for NeuroActive accounts unless a separately reviewed calendar-credential
// cleanup procedure is deliberately executed alongside it.
export const onCalendarUserDeleted = functionsV1.runWith({ failurePolicy: true }).auth.user().onDelete(async (user) => {
  await handleCalendarUserDeletedCore(db, user.uid);
});

// Exported for tests only — not part of the public callable surface.
export const __test__ = {
  APP_ID,
  MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS,
  MAX_LABEL_LENGTH,
  calendarSubscriptionsCollection,
  calendarSubscriptionRef,
  calendarHashRef,
  calendarSubscriptionsByHashCollection,
  calendarAccountStateRef,
  generateCalendarSecret,
  hashSecret,
  requireOptionalLabel,
  requireSubscriptionId,
  requireNonAnonymousAuth,
};
