// functions/src/calendarPreferences.ts
// Calendar Integration Phase 1, Stage 2 — calendar SCHEDULE PREFERENCES only. No ICS
// generation, no public feed endpoint, no Settings UI, no Hosting change, no OAuth/CalDAV/
// Google/Microsoft integration anywhere in this file. This is a data model + server-
// authoritative mutation callable, nothing else.
//
// DECOUPLING GUARANTEE (product contract, not merely a style preference): this file has NO
// dependency on, and takes NO input from, notificationPreferences.ts, reminderScheduler.ts,
// reminderDeliveryWorker.ts, or any course-progress/dnsCourse state. It does not import any
// of those modules, and does not read src/data/dnsCourse.ts-shaped data. A future
// "Use my reminder schedule" UI feature is a ONE-TIME CLIENT-SIDE COPY (the client reads its
// current notification preferences and simply PRE-FILLS this callable's input fields with
// them) — it is explicitly NOT a server-side dependency, and no code path in this file ever
// reads notificationPreferences state to compute or default calendar preferences. Changing
// notification preferences later never changes calendarPreferences/main, and vice versa,
// because there is no code anywhere that would make that happen.
//
// TRUST MODEL: the client never writes artifacts/{appId}/users/{uid}/calendarPreferences
// directly (see firestore.rules — write is denied entirely). The only way this document is
// ever created or changed is the updateCalendarPreferences callable below, which
// re-validates and re-normalizes every field server-side.
//
// WEEKDAY REPRESENTATION: 0=Sunday..6=Saturday — deliberately the SAME numbering
// notificationPreferences.ts uses (matches JS Date.getDay()/getUTCDay() exactly), for
// developer familiarity and so a future "copy my reminder schedule" client-side prefill
// needs no translation layer. This is a DUPLICATED, INDEPENDENT constant/type, not a shared
// import — see the DECOUPLING GUARANTEE above. Canonical form is always deduplicated and
// sorted ascending (see requireWeekdays), so any two semantically-equal weekday sets are
// always byte-for-byte identical once stored, which is what makes the idempotent-resubmit
// check below a simple array comparison. Suitable for later direct conversion into an ICS
// RRULE BYDAY value by a future feed implementation (NOT built here): the eventual mapping
// is 0->SU, 1->MO, 2->TU, 3->WE, 4->TH, 5->FR, 6->SA.
//
// DURATION: sessionDurationMinutes is this Stage's OWN explicit, user-chosen input — never
// derived from video length, lesson content, course progress, or reminder data (there is no
// such data available to derive it from in this file, by construction). Bounds are defined
// and justified where the constants are declared below.
//
// REVISION / CAS / IDEMPOTENT-RESUBMIT CONTRACT: conceptually modeled on
// notificationPreferences.ts's already-reviewed optimistic-concurrency scheme (see that
// file's own header for the fuller history of why a client-wall-clock scheme was rejected in
// favor of this one) — duplicated and adapted here, NOT imported, per the DECOUPLING
// GUARANTEE above. A missing document is revision 0. Every ACCEPTED semantic change sets
// revision = currentRevision + 1. A client must submit expectedRevision (the revision its
// draft was read against); if it does not match the document's CURRENT revision at
// transaction time, no write occurs and a distinct 'aborted' conflict error is thrown
// instead (see the transaction body below) — this is what stops a stale/concurrent client
// from silently overwriting newer preferences. Stage 2 adds ONE behavior beyond the
// notificationPreferences precedent: if the SUBMITTED semantic fields (weekdays, localTime,
// timezone, sessionDurationMinutes) are byte-for-byte identical to the CURRENTLY STORED
// semantic fields, the write is a deterministic no-op — the document is not touched at all
// and the CURRENT revision is returned unchanged, rather than manufacturing an artificial
// revision bump for a resubmission that changed nothing. This comparison is done against a
// STRICTLY re-validated read of the existing document (see parseStoredCalendarPreferences)
// specifically so a corrupted/malformed stored document can never be mistaken for "matches
// what the client just sent" — any parse failure fails the same way a corrupted revision
// does: a thrown 'data-loss' error, no write, no silent coercion.
//
// STRICT STORED-STATE CONTRACT (Codex repair pass 1) — the point of this contract is that
// persisted state is trusted MORE, not less, than fresh request input: a stored document is
// only ever written by this file's own transaction below, so it must ALREADY be exactly
// canonical, and parseStoredCalendarPreferences's job is to PROVE that, not to repair or
// tolerate drift. Concretely, this is stricter than request-side validation in three
// specific ways:
//   1. EXACT SCHEMA: the stored document must contain exactly the six own fields
//      {weekdays, localTime, timezone, sessionDurationMinutes, revision, updatedAt} — no
//      fewer, no extra, no inherited/prototype-chain fields, not an array. See
//      hasExactOwnKeys/isPlainRecord below.
//   2. CANONICAL WEEKDAY ORDER: stored `weekdays` must already be strictly ascending with no
//      duplicates — [1,3,5] is valid stored state, [5,1,3] and [1,1,3] are NOT and are
//      treated as corruption. This function NEVER sorts or deduplicates stored data (compare
//      requireWeekdays below, which DOES sort/dedupe — but only fresh REQUEST input, never a
//      read-back of already-persisted state).
//   3. CANONICAL TIMEZONE: stored `timezone` must be BYTE-FOR-BYTE equal to what
//      Intl.DateTimeFormat resolves it to, not merely a valid alias of it — 'America/Chicago'
//      is valid stored state; 'US/Central' is not, even though it is a perfectly valid
//      REQUEST input (which requireTimezone below canonicalizes to 'America/Chicago' before
//      it is ever persisted). This is the deliberate, asymmetric distinction the header
//      above already draws for revision/semantic-field handling: REQUEST input may accept
//      and normalize aliases; the STORED DOCUMENT must already contain the canonical form
//      that normalization produces, because nothing in this file's write path would ever
//      persist anything else.
//   4. GENUINE TIMESTAMP: stored `updatedAt` must be a real instance of the `Timestamp`
//      class imported above — not a Date, a number, a string, null, a plain
//      {seconds,nanoseconds}-shaped object, or any other sentinel-shaped value. This is what
//      a real Firestore read-back of a `FieldValue.serverTimestamp()` write actually
//      produces; anything else read back from that field is corruption by construction.
// Any violation of the above is treated exactly like an invalid revision: a thrown
// 'data-loss' error, zero writes, no silent repair of the stored document.
//
// INITIALIZATION: a missing calendarPreferences/main document means "this user has not
// configured a calendar schedule" — this is the ONLY defined no-document state, and nothing
// in this file ever fabricates a document from notificationPreferences, course progress, or
// any other source. The client must submit a complete, valid payload (with
// expectedRevision: 0) to create the document for the first time; there are no server-side
// defaults for weekdays/localTime/timezone/sessionDurationMinutes.
//
// ACCOUNT DELETION: deliberately NOT handled by any Auth-deletion trigger in this file.
// calendarPreferences/main is inert schedule DATA, not a credential — unlike Stage 1's
// calendarSubscriptions (a bearer secret whose hash-index entry grants read access to a
// future feed and therefore MUST be invalidated on deletion), leaving this document
// unmodified after account deletion grants no one any access to anything: the document was
// already owner-read-only and write-denied before deletion, and remains exactly as
// inaccessible to every other party afterward. This also matches this project's own
// existing, explicit precedent: notificationPreferences, entitlement, and userData are
// NOT cleaned up on account deletion today either (see calendarSubscriptions.ts's own
// header: "It does not attempt to solve this project's broader (currently nonexistent)
// account-deletion/data-lifecycle problem."). Building deletion cleanup for exactly one more
// non-credential preference document, while every other preference document in the project
// remains untouched, would be new scope inconsistent with that precedent, not a narrow
// integration into it. If a general account-deletion data-lifecycle project is ever
// undertaken, calendarPreferences/main should be included in it alongside
// notificationPreferences, entitlement, and userData — not handled as a one-off here.
// STAGE 1'S SECURITY-CRITICAL TOMBSTONE/HASH TRANSACTION IN calendarSubscriptions.ts IS NOT
// MODIFIED, REFERENCED, OR DEPENDED ON BY ANY CODE IN THIS FILE.
//
// TESTING SEAM: matching this project's established convention, all actual logic lives in
// plain, exported, db-parameterized "Core" functions below. The onCall-wrapped export at the
// bottom is a thin wrapper that supplies the real module-level `db` and nothing else — tests
// call the Core function directly against a fake db, never the wrapped export.
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

const APP_ID = 'neuroactive-prod';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function calendarPreferencesRef(db: FirebaseFirestore.Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/calendarPreferences/main`);
}

// Duplicated from pushInstallations.ts/notificationPreferences.ts/calendarSubscriptions.ts
// by established per-file convention in this codebase — see notificationPreferences.ts's
// own header for the stated rationale: each file's copy can never become a source of
// cross-file regression.
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

// 0=Sunday..6=Saturday — see the WEEKDAY REPRESENTATION section of the file header.
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Session duration bounds — this Stage's own explicit, justified choice, not derived from
// any other data (see the DURATION section of the file header). Lower bound (5 minutes)
// excludes a degenerate near-zero-length calendar event. Upper bound (120 minutes / 2
// hours) excludes a nonsensical, day-spanning single session while comfortably covering any
// realistic single NeuroActive training session length.
const MIN_SESSION_DURATION_MINUTES = 5;
const MAX_SESSION_DURATION_MINUTES = 120;

// Codex repair pass 1, REPAIR 5 / REPAIR 1: shared shape-validation primitives used for BOTH
// the callable's request payload (REPAIR 5) and the stored document's own shape (REPAIR 1).
// Deliberately accepts an ordinary `{}`-literal object (prototype === Object.prototype) OR a
// null-prototype record (Object.create(null)) — both are legitimate "plain data" shapes a
// JSON-like payload can take — while rejecting arrays, class instances (Date, Timestamp,
// custom prototypes), and any other non-object value.
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// `Object.keys` only ever returns OWN enumerable string keys (inherited/prototype-chain
// properties are structurally excluded already) — this additionally requires the key COUNT
// to match exactly, so both "missing a required key" and "an extra/unknown key present" are
// rejected, not just unrecognized keys.
function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expectedSet = new Set(expectedKeys);
  return actualKeys.every((k) => expectedSet.has(k));
}

const STORED_DOC_KEYS = ['weekdays', 'localTime', 'timezone', 'sessionDurationMinutes', 'revision', 'updatedAt'] as const;
const REQUEST_KEYS = ['weekdays', 'localTime', 'timezone', 'sessionDurationMinutes', 'expectedRevision'] as const;

function requireWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpsError('invalid-argument', 'weekdays must be a non-empty array.');
  }
  const validWeekdaySet = new Set<number>(VALID_WEEKDAYS);
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || !validWeekdaySet.has(entry)) {
      throw new HttpsError('invalid-argument', 'weekdays must contain only integers 0-6.');
    }
    seen.add(entry);
  }
  if (seen.size !== value.length) {
    throw new HttpsError('invalid-argument', 'weekdays must not contain duplicates.');
  }
  // Canonical ascending order — matches VALID_WEEKDAYS' own order and is what makes stored
  // documents byte-for-byte comparable for the idempotent-resubmit check below.
  return [...seen].sort((a, b) => a - b);
}

function requireLocalTime(value: unknown): string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new HttpsError('invalid-argument', 'localTime must be in strict 24-hour HH:MM format.');
  }
  return value;
}

// Validates AND canonicalizes: the runtime's own resolved IANA identifier is persisted, not
// necessarily the exact string the client sent. Never silently substitutes UTC or any other
// default — an unrecognized value is always rejected outright.
function requireTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new HttpsError('invalid-argument', 'Invalid timezone.');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new HttpsError('invalid-argument', 'timezone is not a recognized IANA timezone.');
  }
}

function requireSessionDurationMinutes(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < MIN_SESSION_DURATION_MINUTES ||
    value > MAX_SESSION_DURATION_MINUTES
  ) {
    throw new HttpsError(
      'invalid-argument',
      `sessionDurationMinutes must be an integer between ${MIN_SESSION_DURATION_MINUTES} and ${MAX_SESSION_DURATION_MINUTES}.`
    );
  }
  return value;
}

// A missing document is still expected as revision 0 by the client — this validates the
// shape of what was submitted, not whether it happens to match current server state (that's
// the CAS comparison inside the transaction below).
function requireExpectedRevision(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new HttpsError('invalid-argument', 'expectedRevision must be a non-negative safe integer.');
  }
  return value;
}

type StoredCalendarPreferences = {
  weekdays: number[];
  localTime: string;
  timezone: string;
  sessionDurationMinutes: number;
  revision: number;
};

// Strict validity check for a revision read off an EXISTING document. Deliberately rejects
// everything that isn't a clean, safe, positive integer: missing, null, string, NaN,
// +/-Infinity, fractional, negative, zero, and unsafe integers all fail this check. A
// missing document is a separate case entirely (see below) — this function is never called
// for that case and never implicitly returns 0.
function isValidExistingRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

// STRICT read-back parse of an existing document's semantic fields (weekdays/localTime/
// timezone/sessionDurationMinutes), independent of the revision check above. Returns null on
// ANY malformation — never silently falls back to a default value for a corrupted field.
// This strictness matters specifically because the caller uses the result for the
// idempotent-resubmit comparison (see isSemanticallyUnchanged): a version of this function
// that silently defaulted malformed fields could make a genuinely corrupted document look
// "identical" to whatever the client just sent, causing a real repair write to be silently
// skipped as a false "no-op". A null result is treated by the caller exactly like an invalid
// revision: a thrown 'data-loss' error, no write, no silent coercion.
function parseStoredCalendarPreferences(data: unknown, revision: number): StoredCalendarPreferences | null {
  // REPAIR 1: exact shape first — not a plain record, or not exactly the six expected own
  // keys, is corruption regardless of what any individual field looks like.
  if (!isPlainRecord(data)) return null;
  if (!hasExactOwnKeys(data, STORED_DOC_KEYS)) return null;

  // REPAIR 3: stored weekdays must ALREADY be canonical — non-empty, integers 0-6, no
  // duplicates, and STRICTLY ASCENDING. Deliberately never sorted/deduplicated here (compare
  // requireWeekdays, which sorts/dedupes fresh REQUEST input only) — [5,1,3] and [1,1,3] are
  // both corruption, not "valid but out of order".
  const weekdays = data.weekdays;
  if (
    !Array.isArray(weekdays) ||
    weekdays.length === 0 ||
    !weekdays.every((d: unknown) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    return null;
  }
  for (let i = 1; i < weekdays.length; i++) {
    if (weekdays[i] <= weekdays[i - 1]) return null; // catches both duplicates and any non-ascending order
  }

  if (typeof data.localTime !== 'string' || !TIME_PATTERN.test(data.localTime)) {
    return null;
  }

  // REPAIR 4: stored timezone must be BYTE-FOR-BYTE the canonical form Intl.DateTimeFormat
  // itself resolves it to — an alias that is merely VALID (e.g. 'US/Central') is still
  // corruption as STORED state, because nothing in this file's write path would ever persist
  // anything other than the already-canonicalized form. See the STRICT STORED-STATE
  // CONTRACT section of the file header for the full rationale.
  if (typeof data.timezone !== 'string' || data.timezone.length === 0) {
    return null;
  }
  let canonicalTimezone: string;
  try {
    canonicalTimezone = new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (data.timezone !== canonicalTimezone) return null;

  if (
    typeof data.sessionDurationMinutes !== 'number' ||
    !Number.isInteger(data.sessionDurationMinutes) ||
    data.sessionDurationMinutes < MIN_SESSION_DURATION_MINUTES ||
    data.sessionDurationMinutes > MAX_SESSION_DURATION_MINUTES
  ) {
    return null;
  }

  // REPAIR 2: stored updatedAt must be a genuine Timestamp instance — exactly what a real
  // Firestore read-back of a FieldValue.serverTimestamp() write produces. Anything else
  // (missing, null, a Date, a number, a string, a plain {seconds,nanoseconds}-shaped object,
  // or any other sentinel-shaped value) is corruption.
  if (!(data.updatedAt instanceof Timestamp)) return null;

  return {
    weekdays: weekdays as number[],
    localTime: data.localTime,
    timezone: data.timezone,
    sessionDurationMinutes: data.sessionDurationMinutes,
    revision,
  };
}

type SemanticPreferences = {
  weekdays: number[];
  localTime: string;
  timezone: string;
  sessionDurationMinutes: number;
};

// Both `current.weekdays` and `next.weekdays` are always canonically sorted ascending (see
// requireWeekdays and parseStoredCalendarPreferences), so an index-wise comparison after an
// equal-length check is a correct, order-independent set-equality check.
function isSemanticallyUnchanged(current: StoredCalendarPreferences | null, next: SemanticPreferences): boolean {
  if (current === null) return false;
  if (current.localTime !== next.localTime) return false;
  if (current.timezone !== next.timezone) return false;
  if (current.sessionDurationMinutes !== next.sessionDurationMinutes) return false;
  if (current.weekdays.length !== next.weekdays.length) return false;
  for (let i = 0; i < current.weekdays.length; i++) {
    if (current.weekdays[i] !== next.weekdays[i]) return false;
  }
  return true;
}

// Codex repair pass 1, REPAIR 5: the callable's request-payload shape check, factored out
// into its own directly-testable function rather than left inline in the onCall wrapper.
// Requires request.data to be a plain object or null-prototype record (never an array or
// any other non-object value) containing EXACTLY the five expected own keys — not a subset,
// not a superset. This is deliberately checked BEFORE any individual field's value is
// inspected; the per-field require* validators below remain the second, independent layer
// of validation (this function only proves the payload has the right SHAPE, not that each
// field's VALUE is valid).
function parseUpdateCalendarPreferencesRequest(data: unknown): {
  weekdays: unknown;
  localTime: unknown;
  timezone: unknown;
  sessionDurationMinutes: unknown;
  expectedRevision: unknown;
} {
  if (!isPlainRecord(data)) {
    throw new HttpsError('invalid-argument', 'Preferences payload must be a plain object.');
  }
  if (!hasExactOwnKeys(data, REQUEST_KEYS)) {
    throw new HttpsError(
      'invalid-argument',
      'Preferences payload must contain exactly these fields: weekdays, localTime, timezone, sessionDurationMinutes, expectedRevision.'
    );
  }
  return {
    weekdays: data.weekdays,
    localTime: data.localTime,
    timezone: data.timezone,
    sessionDurationMinutes: data.sessionDurationMinutes,
    expectedRevision: data.expectedRevision,
  };
}

type UpdateResult =
  | { conflict: true; currentRevision: number; current: StoredCalendarPreferences | null }
  | { conflict: false; revision: number; unchanged: boolean; weekdays: number[]; localTime: string; timezone: string; sessionDurationMinutes: number };

// ---------------------------------------------------------------------------------------
// UPDATE (core) — creates the document on first call (expectedRevision: 0) or updates it
// under CAS otherwise. See the REVISION / CAS / IDEMPOTENT-RESUBMIT CONTRACT section of the
// file header for the full behavioral contract. Never reads or writes any other uid's
// document (the path is uid-scoped) and never reads any other collection in this project.
// ---------------------------------------------------------------------------------------
export async function updateCalendarPreferencesCore(
  db: FirebaseFirestore.Firestore,
  uid: string,
  input: {
    weekdays: unknown;
    localTime: unknown;
    timezone: unknown;
    sessionDurationMinutes: unknown;
    expectedRevision: unknown;
  }
): Promise<UpdateResult> {
  const weekdays = requireWeekdays(input.weekdays);
  const localTime = requireLocalTime(input.localTime);
  const timezone = requireTimezone(input.timezone);
  const sessionDurationMinutes = requireSessionDurationMinutes(input.sessionDurationMinutes);
  const expectedRevision = requireExpectedRevision(input.expectedRevision);

  const ref = calendarPreferencesRef(db, uid);

  return db.runTransaction(async (transaction): Promise<UpdateResult> => {
    const snap = await transaction.get(ref);

    let currentRevision: number;
    let currentShape: StoredCalendarPreferences | null;
    if (!snap.exists) {
      currentRevision = 0;
      currentShape = null;
    } else {
      const rawRevision = snap.data()!.revision;
      if (!isValidExistingRevision(rawRevision)) {
        // Fail closed: do not proceed with CAS, do not treat this as revision 0, no write.
        // Firestore transactions never partially apply, so no write of any kind reaches the
        // document in this path.
        throw new HttpsError(
          'data-loss',
          'Stored calendar preference revision is invalid or corrupted; refusing to write.'
        );
      }
      currentRevision = rawRevision;
      const parsed = parseStoredCalendarPreferences(snap.data()!, currentRevision);
      if (parsed === null) {
        throw new HttpsError(
          'data-loss',
          'Stored calendar preferences are invalid or corrupted; refusing to write.'
        );
      }
      currentShape = parsed;
    }

    if (expectedRevision !== currentRevision) {
      return { conflict: true, currentRevision, current: currentShape };
    }

    const next: SemanticPreferences = { weekdays, localTime, timezone, sessionDurationMinutes };

    if (isSemanticallyUnchanged(currentShape, next)) {
      // Deterministic idempotent no-op — see the REVISION / CAS / IDEMPOTENT-RESUBMIT
      // CONTRACT section of the file header. No write of any kind occurs.
      return { conflict: false, revision: currentRevision, unchanged: true, ...next };
    }

    // isValidExistingRevision already guarantees currentRevision is a safe integer, but
    // Number.MAX_SAFE_INTEGER itself passes that check (it IS safe) while
    // MAX_SAFE_INTEGER + 1 is NOT — incrementing past this boundary would create a document
    // whose own revision would fail validation on the very next read. Refuse before that can
    // happen: no write, no silent rollover, fail closed. Checked AFTER the
    // isSemanticallyUnchanged short-circuit above, deliberately: a no-op resubmission must
    // never be blocked by this limit, since it would not actually increment anything.
    if (currentRevision === Number.MAX_SAFE_INTEGER) {
      throw new HttpsError(
        'resource-exhausted',
        'Calendar preference revision limit reached; cannot save further changes.'
      );
    }

    const nextRevision = currentRevision + 1;
    transaction.set(ref, {
      weekdays,
      localTime,
      timezone,
      sessionDurationMinutes,
      revision: nextRevision,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { conflict: false, revision: nextRevision, unchanged: false, ...next };
  });
}

// ---------------------------------------------------------------------------------------
// THIN WRAPPER — the actual deployed Cloud Function. Supplies the real module-level `db`
// and the authenticated uid (never client-supplied — see requireNonAnonymousAuth) to
// updateCalendarPreferencesCore, and nothing else.
// ---------------------------------------------------------------------------------------
export const updateCalendarPreferences = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const parsedRequest = parseUpdateCalendarPreferencesRequest(request.data);
  const result = await updateCalendarPreferencesCore(db, uid, parsedRequest);

  if (result.conflict) {
    // Distinct, structured conflict result — the client uses `details` to reconcile
    // immediately without waiting on its Firestore listener (which may not have delivered
    // the newer snapshot yet).
    throw new HttpsError('aborted', 'Calendar preference document has changed since it was last read.', {
      currentRevision: result.currentRevision,
      current: result.current,
    });
  }

  // FieldValue.serverTimestamp() is a write-time sentinel, not a real value — it is
  // deliberately never included in this callable's return payload. The client's own
  // Firestore listener (read-only, owner-scoped) is the source of truth for updatedAt.
  return {
    weekdays: result.weekdays,
    localTime: result.localTime,
    timezone: result.timezone,
    sessionDurationMinutes: result.sessionDurationMinutes,
    revision: result.revision,
    unchanged: result.unchanged,
  };
});

// Exported for tests only — not part of the public callable surface.
export const __test__ = {
  APP_ID,
  MIN_SESSION_DURATION_MINUTES,
  MAX_SESSION_DURATION_MINUTES,
  calendarPreferencesRef,
  requireWeekdays,
  requireLocalTime,
  requireTimezone,
  requireSessionDurationMinutes,
  requireExpectedRevision,
  requireNonAnonymousAuth,
  isValidExistingRevision,
  parseStoredCalendarPreferences,
  isSemanticallyUnchanged,
  isPlainRecord,
  hasExactOwnKeys,
  parseUpdateCalendarPreferencesRequest,
  STORED_DOC_KEYS,
  REQUEST_KEYS,
};
