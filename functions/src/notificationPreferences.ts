// functions/src/notificationPreferences.ts
// Phase 3A-3 Step 1 (second Codex repair round) — reminder PREFERENCES only. No
// scheduler, no reminder records, no sends exist anywhere in this file or project yet.
// This is deliberately a separate file from functions/src/pushInstallations.ts (device
// registration/ownership) — preferences are a distinct concern from installation
// ownership, and Phase 3A-1's reviewed file is left completely untouched by this
// addition, including its requireNonAnonymousAuth / CALLABLE_OPTIONS helpers, which are
// intentionally duplicated below rather than shared, so this addition can never be a
// source of regression in that already-approved file.
//
// TRUST MODEL: the client never writes artifacts/{appId}/users/{uid}/notificationPreferences
// directly (see firestore.rules — write is denied entirely). The only ways this document
// is ever created or changed are the two callables below, both of which re-validate and
// (for updateNotificationPreferences) re-normalize every field server-side and are the
// sole computers of nextReminderDueAt. The client can never set or influence that field,
// directly or indirectly, beyond the schedule inputs that legitimately determine it.
//
// MULTI-DEVICE TIMEZONE POLICY (V1, intentional, documented — not a bug): this
// preference document holds exactly one timezone, which follows whichever device most
// recently had NeuroActive open (see refreshNotificationTimezone below, called from the
// client's foreground/visibility check). If a phone in Chicago is used, reminders follow
// Chicago; if the user later opens NeuroActive on a device in New York, reminders follow
// New York from that point on. Per-device reminder timezones are explicitly out of scope
// for this phase.
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';

const APP_ID = 'neuroactive-prod';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function preferencesRef(uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/notificationPreferences/main`);
}

// Duplicated from pushInstallations.ts by design — see file header above.
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

// Same enforceAppCheck: true posture as the push lifecycle callables.
const CALLABLE_OPTIONS = { enforceAppCheck: true } as const;

type ScheduleType = 'daily' | 'weekdays';

// 0=Sunday..6=Saturday — matches JS Date.getDay()/getUTCDay() exactly, so no translation
// layer is ever needed at any call site, client or server.
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function requireEnabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new HttpsError('invalid-argument', 'enabled must be a boolean.');
  }
  return value;
}

function requireScheduleType(value: unknown): ScheduleType {
  if (value !== 'daily' && value !== 'weekdays') {
    throw new HttpsError('invalid-argument', 'scheduleType must be "daily" or "weekdays".');
  }
  return value;
}

// 'daily' is normalized to the full week server-side regardless of what the client sent
// for `weekdays` in that mode — the stored document is always self-consistent, so a
// future reader (e.g. a .ics generator) never needs to special-case "if daily, ignore
// weekdays".
function requireWeekdays(value: unknown, scheduleType: ScheduleType): number[] {
  if (scheduleType === 'daily') return [...VALID_WEEKDAYS];

  if (!Array.isArray(value) || value.length === 0) {
    throw new HttpsError(
      'invalid-argument',
      'weekdays must be a non-empty array when scheduleType is "weekdays".'
    );
  }
  const seen = new Set<number>();
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 6) {
      throw new HttpsError('invalid-argument', 'weekdays must contain only integers 0-6.');
    }
    seen.add(entry);
  }
  if (seen.size !== value.length) {
    throw new HttpsError('invalid-argument', 'weekdays must not contain duplicates.');
  }
  return [...seen].sort((a, b) => a - b);
}

function requireLocalTime(value: unknown): string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new HttpsError('invalid-argument', 'localTime must be in strict 24-hour HH:MM format.');
  }
  return value;
}

// Validates AND canonicalizes: the runtime's own resolved IANA identifier is persisted,
// not necessarily the exact string the client sent. Empirically confirmed this catches
// some but not all legacy aliases (e.g. 'US/Central' -> 'America/Chicago' resolves;
// 'Asia/Calcutta' does not resolve to 'Asia/Kolkata' under Node 20's ICU data) — still
// strictly better than persisting whatever the client sent verbatim, but not a complete
// alias-normalization guarantee across every historical IANA link.
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

// A missing document is still expected as revision 0 by the client — this validates the
// shape of what was submitted, not whether it happens to match current server state
// (that's the CAS comparison inside the transaction below).
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

// ---------------------------------------------------------------------------------------
// Timezone math — deterministic, non-iterative. No external tz-database dependency:
// Node 20's built-in Intl carries IANA transition data, and the derivation below reads
// it directly for the specific instants it needs rather than approximating via
// fixed-point iteration (an earlier version of this file used a 3-iteration convergence
// loop, which Codex correctly identified as producing wrong/backward-in-time results for
// edge cases like Australia/Lord_Howe's 30-minute transitions; a second version used a
// single "always apply the before-transition offset" closed form, which Codex's second
// review round correctly identified as failing to distinguish an ORDINARY local time
// that simply falls chronologically after a nearby transition from the transition's own
// gap/fold boundary time — both have been fully replaced by the self-consistency-checked
// version below, verified against both failure modes before being written here).
//
// APPROACH: sample the timezone's UTC offset at two points bracketing the requested
// local date (`offsetBefore`, `offsetAfter`). If they're equal, there's no nearby
// transition and the answer is unambiguous. If they differ, compute BOTH candidate
// instants (one using each offset) and check each for SELF-CONSISTENCY — does looking up
// the offset actually in effect at that candidate instant match the offset used to
// derive it?
//   - Only the before-candidate is self-consistent -> ordinary time, pre-transition.
//   - Only the after-candidate is self-consistent -> ordinary time, post-transition.
//   - BOTH are self-consistent -> FOLD (ambiguous local time) -> the required policy is
//     to choose the earlier occurrence, so the smaller of the two is returned.
//   - NEITHER is self-consistent -> GAP (nonexistent local time) -> the required policy
//     is to shift the requested wall-clock time forward by exactly the transition size;
//     this is algebraically identical to the before-candidate (see the code comment at
//     that return statement for the derivation), so no separate shift step is needed.
//
// The 36-hour bracketing window is sized for this product's actual scheduling horizon —
// reminders are computed for their next occurrence within roughly the coming week, so
// only the single nearest transition (if any) to a given target date is ever relevant.
// No claim is made here about every historical timezone transition in the IANA database;
// this is scoped to modern DST-style transitions as they behave today, which is what
// this feature's near-term scheduling needs.
// ---------------------------------------------------------------------------------------

const TRANSITION_BRACKET_WINDOW_MS = 36 * 60 * 60 * 1000;

function getZonedParts(date: Date, timeZone: string) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, number> = {};
  for (const part of dtf.formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
  }
  if (parts.hour === 24) parts.hour = 0; // some ICU builds render midnight as "24" under hour12:false
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

// Offset (ms) such that localAsUtcMs = instantMs + offset — i.e. how far the zone's wall
// clock reads ahead of/behind the UTC numeric axis at this instant.
function offsetMsAt(instantMs: number, timeZone: string): number {
  const p = getZonedParts(new Date(instantMs), timeZone);
  const impliedMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  return impliedMs - instantMs;
}

function localWallTimeToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string
): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetBefore = offsetMsAt(target - TRANSITION_BRACKET_WINDOW_MS, timeZone);
  const offsetAfter = offsetMsAt(target + TRANSITION_BRACKET_WINDOW_MS, timeZone);

  if (offsetBefore === offsetAfter) {
    return target - offsetBefore;
  }

  const candidateUsingBefore = target - offsetBefore;
  const candidateUsingAfter = target - offsetAfter;
  const beforeConsistent = offsetMsAt(candidateUsingBefore, timeZone) === offsetBefore;
  const afterConsistent = offsetMsAt(candidateUsingAfter, timeZone) === offsetAfter;

  if (beforeConsistent && afterConsistent) {
    // FOLD: both instants are genuinely valid for this local time — choose the earlier.
    return Math.min(candidateUsingBefore, candidateUsingAfter);
  }
  if (beforeConsistent) return candidateUsingBefore; // ordinary, pre-transition
  if (afterConsistent) return candidateUsingAfter; // ordinary, post-transition

  // GAP: neither is self-consistent -> nonexistent local time. Shifting the wall-clock
  // target forward by exactly the transition size and resolving with offsetAfter is
  // algebraically identical to candidateUsingBefore:
  //   (target + (offsetAfter-offsetBefore)) - offsetAfter = target - offsetBefore
  return candidateUsingBefore;
}

// Finds the next UTC instant, strictly after `now`, at which the user's local wall-clock
// time equals `localTime` on a local calendar day whose weekday is in `weekdays`. For
// EVERY candidate day (including today), the actual resolved instant is computed FIRST
// via localWallTimeToUtcMs, and eligibility is decided purely from `candidateMs > nowMs`
// — never from a nominal local hour/minute comparison, which is exactly what caused the
// gap-day eligibility bug Codex found (a nominal "02:30 < current 03:00" comparison
// wrongly skipped a day whose ACTUAL resolved occurrence, 03:30, was still in the
// future). The resolved instant is the sole source of truth for "has this occurrence
// passed." Strict semantics: exactly at the due instant counts as passed (`>`, not `>=`).
function computeNextOccurrenceMs(now: Date, timeZone: string, localTime: string, weekdays: number[]): number {
  const weekdaySet = new Set(weekdays);
  const [targetHour, targetMinute] = localTime.split(':').map(Number);
  const nowParts = getZonedParts(now, timeZone);
  const nowMs = now.getTime();

  // Up to 8 days of headroom: 7 covers every possible weekday, +1 extra margin.
  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
    // Calendar-date arithmetic in UTC-as-date-only space — only the correct Y-M-D and its
    // day-of-week are needed here, not a real instant, so the ambient timeZone doesn't
    // affect this step's correctness.
    const candidateDateOnly = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + dayOffset));
    if (!weekdaySet.has(candidateDateOnly.getUTCDay())) continue;

    const candidateMs = localWallTimeToUtcMs(
      candidateDateOnly.getUTCFullYear(),
      candidateDateOnly.getUTCMonth() + 1,
      candidateDateOnly.getUTCDate(),
      targetHour,
      targetMinute,
      timeZone
    );

    if (candidateMs > nowMs) return candidateMs;
  }

  throw new HttpsError('internal', 'Could not compute a future reminder occurrence.');
}

function computeNextReminderDueAt(
  enabled: boolean,
  timeZone: string,
  localTime: string,
  weekdays: number[]
): Timestamp | null {
  if (!enabled) return null;
  return Timestamp.fromMillis(computeNextOccurrenceMs(new Date(), timeZone, localTime, weekdays));
}

// ---------------------------------------------------------------------------------------

type StoredPreferences = {
  enabled: boolean;
  scheduleType: ScheduleType;
  weekdays: number[];
  localTime: string;
  timezone: string;
  revision: number;
};

// Strict validity check for a revision read off an EXISTING document. Deliberately
// rejects everything that isn't a clean, safe, positive integer: missing, null, string,
// NaN, +/-Infinity, fractional, negative, zero, and unsafe integers all fail this check.
// A missing document is a separate case entirely (see below) — this function is never
// called for that case and never implicitly returns 0.
function isValidExistingRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

// Only ever called after the caller has already confirmed `revision` is valid (or the
// document doesn't exist, handled separately) — this function no longer has its own
// silent revision fallback, closing the exact "silently coerced to 0" gap Codex found.
function toClientShape(data: FirebaseFirestore.DocumentData, revision: number): StoredPreferences {
  return {
    enabled: !!data.enabled,
    scheduleType: data.scheduleType === 'weekdays' ? 'weekdays' : 'daily',
    weekdays: Array.isArray(data.weekdays) ? data.weekdays : [...VALID_WEEKDAYS],
    localTime: typeof data.localTime === 'string' ? data.localTime : '07:00',
    timezone: typeof data.timezone === 'string' ? data.timezone : 'UTC',
    revision,
  };
}

const ALLOWED_INPUT_KEYS = new Set(['enabled', 'scheduleType', 'weekdays', 'localTime', 'timezone', 'expectedRevision']);

// REVISION / OPTIMISTIC-CONCURRENCY MODEL (replaces the earlier, Codex-rejected
// client-wall-clock `clientIntentAt` scheme entirely — no trace of that mechanism
// remains). ONLY a genuinely missing document implies revision 0 — see
// isValidExistingRevision above. An EXISTING document with a missing/malformed revision
// is treated as data corruption: no CAS comparison is attempted, no write occurs, and a
// distinct data-integrity error is thrown instead of silently treating it as revision 0
// (which would let a corrupted document be silently overwritten as though it were
// brand-new, destroying the evidence of corruption). Every successful explicit save on a
// clean document sets `revision = currentRevision + 1`. The client must submit
// `expectedRevision` (the revision its draft was read against); the write only applies
// if that matches the document's CURRENT revision at transaction time — otherwise no
// write occurs and a distinct conflict result is returned instead. This is a narrower,
// safer guarantee than the earlier scheme: it does not attempt to determine "true"
// chronological human intent across disconnected devices — it only guarantees that a
// client can never overwrite an authoritative version newer than the one it actually
// read.
export const updateNotificationPreferences = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);

  const data = request.data;
  if (typeof data !== 'object' || data === null) {
    throw new HttpsError('invalid-argument', 'Missing preferences payload.');
  }
  for (const key of Object.keys(data)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new HttpsError('invalid-argument', `Unknown field: ${key}`);
    }
  }

  const enabled = requireEnabled(data.enabled);
  const scheduleType = requireScheduleType(data.scheduleType);
  const weekdays = requireWeekdays(data.weekdays, scheduleType);
  const localTime = requireLocalTime(data.localTime);
  const timezone = requireTimezone(data.timezone);
  const expectedRevision = requireExpectedRevision(data.expectedRevision);

  const ref = preferencesRef(uid);

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);

    let currentRevision: number;
    let currentShape: StoredPreferences | null;
    if (!snap.exists) {
      currentRevision = 0;
      currentShape = null;
    } else {
      const rawRevision = snap.data()!.revision;
      if (!isValidExistingRevision(rawRevision)) {
        // Fail closed: do not proceed with CAS, do not treat this as revision 0, no
        // write. This intentionally propagates out of the transaction as a thrown
        // error — Firestore transactions never partially apply, so no write of any
        // kind reaches the document in this path.
        throw new HttpsError(
          'data-loss',
          'Stored preference revision is invalid or corrupted; refusing to write.'
        );
      }
      currentRevision = rawRevision;
      currentShape = toClientShape(snap.data()!, currentRevision);
    }

    if (expectedRevision !== currentRevision) {
      return {
        conflict: true as const,
        currentRevision,
        current: currentShape,
      };
    }

    // isValidExistingRevision already guarantees currentRevision is a safe integer, but
    // Number.MAX_SAFE_INTEGER itself passes that check (it IS safe) while
    // MAX_SAFE_INTEGER + 1 is NOT — incrementing past this boundary would create a
    // document whose own revision would fail validation on the very next read, silently
    // manufacturing the corruption state BLOCKER 3 exists to catch. Refuse before that
    // can happen: no write, no silent rollover, fail closed.
    if (currentRevision === Number.MAX_SAFE_INTEGER) {
      throw new HttpsError(
        'resource-exhausted',
        'Preference revision limit reached; cannot save further changes.'
      );
    }

    const nextRevision = currentRevision + 1;
    const nextReminderDueAt = computeNextReminderDueAt(enabled, timezone, localTime, weekdays);

    transaction.set(ref, {
      enabled,
      scheduleType,
      weekdays,
      localTime,
      timezone,
      revision: nextRevision,
      nextReminderDueAt,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return {
      conflict: false as const,
      revision: nextRevision,
      enabled,
      scheduleType,
      weekdays,
      localTime,
      timezone,
      nextReminderDueAt,
    };
  });

  if (result.conflict) {
    // Distinct, structured conflict result — the client uses `details` to reconcile
    // immediately without waiting on its Firestore listener (which may not have
    // delivered the newer snapshot yet).
    throw new HttpsError('aborted', 'Preference document has changed since it was last read.', {
      currentRevision: result.currentRevision,
      current: result.current,
    });
  }

  // FieldValue.serverTimestamp() is a write-time sentinel, not a real value — it is
  // deliberately never included in this callable's return payload. The client's own
  // Firestore listener (read-only, owner-scoped) is the source of truth for updatedAt.
  return {
    enabled: result.enabled,
    scheduleType: result.scheduleType,
    weekdays: result.weekdays,
    localTime: result.localTime,
    timezone: result.timezone,
    revision: result.revision,
    nextReminderDueAt: result.nextReminderDueAt ? result.nextReminderDueAt.toMillis() : null,
  };
});

// Narrow, timezone-ONLY maintenance operation for the client's automatic device-timezone-
// drift path (see src/hooks/useNotificationPreferences.ts). Deliberately does NOT accept
// or touch enabled/scheduleType/weekdays/localTime — it always reads the CURRENT
// authoritative values for those fields from Firestore, inside the same transaction that
// performs the write, and simply carries them forward unchanged alongside the new
// timezone. Deliberately does NOT touch `revision` either: an automatic timezone
// maintenance pass is not a user schedule edit, and since it structurally cannot carry a
// stale copy of the schedule (it never reads one from the client, only from the
// database, in the same transaction as the write), it can never invalidate a
// concurrently-in-flight explicit save's expectedRevision merely by having run. This is
// what prevents the last-write-wins data-loss race Codex originally found, and what
// keeps timezone maintenance from spuriously conflicting with a legitimate,
// otherwise-current explicit save.
//
// If no preferences document exists yet for this uid, this is a deliberate no-op: a
// device timezone change must never implicitly create a preferences document / opt a
// user into reminders they never configured. If a document exists but its revision is
// corrupted, this also refuses to write anything at all — touching any field on a known-
// corrupted document, even fields unrelated to revision, risks destroying evidence of
// the corruption before it can be investigated.
export const refreshNotificationTimezone = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);

  const data = request.data;
  if (typeof data !== 'object' || data === null) {
    throw new HttpsError('invalid-argument', 'Missing payload.');
  }
  for (const key of Object.keys(data)) {
    if (key !== 'timezone') {
      throw new HttpsError('invalid-argument', `Unknown field: ${key}`);
    }
  }
  const timezone = requireTimezone(data.timezone);
  const ref = preferencesRef(uid);

  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      return { updated: false };
    }

    const rawRevision = snap.data()!.revision;
    if (!isValidExistingRevision(rawRevision)) {
      throw new HttpsError(
        'data-loss',
        'Stored preference revision is invalid or corrupted; refusing to write.'
      );
    }

    const current = toClientShape(snap.data()!, rawRevision);
    const nextReminderDueAt = computeNextReminderDueAt(current.enabled, timezone, current.localTime, current.weekdays);

    // Partial update — only ever touches timezone/nextReminderDueAt/updatedAt. Every
    // other field, INCLUDING revision, is left completely untouched by construction —
    // this operation's Firestore call literally cannot name those keys.
    transaction.update(ref, {
      timezone,
      nextReminderDueAt,
      updatedAt: FieldValue.serverTimestamp(),
    });

    return { updated: true, timezone, nextReminderDueAt: nextReminderDueAt ? nextReminderDueAt.toMillis() : null };
  });
});
