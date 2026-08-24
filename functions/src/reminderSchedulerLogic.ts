// functions/src/reminderSchedulerLogic.ts
// Phase 3A-3 Step 2 (fourth Codex repair round) — PURE LOGIC ONLY. Deliberately has zero
// imports from 'firebase-admin/*' or 'firebase-functions/*' — every function here is a
// plain, synchronous, dependency-free function of its inputs, so it can be exercised by
// a real repository-local test file (see reminderSchedulerLogic.test.ts) without needing
// a Firestore emulator or any Firebase credentials.
//
// DRY-RUN INVARIANT: this file contains no reference to 'firebase-admin/messaging',
// `getMessaging`, `.send(`, `sendEach`, any FCM HTTP endpoint, and never reads a raw FCM
// token value. It is mechanically incapable of participating in a real send.

// ---------------------------------------------------------------------------------------
// Timezone math — unchanged, byte-for-byte the same algorithm as
// functions/src/notificationPreferences.ts (Codex-approved).
// ---------------------------------------------------------------------------------------

const TRANSITION_BRACKET_WINDOW_MS = 36 * 60 * 60 * 1000;

export function getZonedParts(date: Date, timeZone: string) {
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
  if (parts.hour === 24) parts.hour = 0;
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute, second: parts.second };
}

function offsetMsAt(instantMs: number, timeZone: string): number {
  const p = getZonedParts(new Date(instantMs), timeZone);
  const impliedMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, 0);
  return impliedMs - instantMs;
}

export function localWallTimeToUtcMs(
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
    return Math.min(candidateUsingBefore, candidateUsingAfter);
  }
  if (beforeConsistent) return candidateUsingBefore;
  if (afterConsistent) return candidateUsingAfter;
  return candidateUsingBefore;
}

export function computeNextOccurrenceMs(now: Date, timeZone: string, localTime: string, weekdays: number[]): number {
  const weekdaySet = new Set(weekdays);
  const [targetHour, targetMinute] = localTime.split(':').map(Number);
  const nowParts = getZonedParts(now, timeZone);
  const nowMs = now.getTime();

  for (let dayOffset = 0; dayOffset <= 8; dayOffset++) {
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

  throw new Error('Could not compute a future reminder occurrence.');
}

// ---------------------------------------------------------------------------------------
// Preference/schedule validation — mirrors notificationPreferences.ts's validation.
// ---------------------------------------------------------------------------------------

const VALID_WEEKDAYS = new Set([0, 1, 2, 3, 4, 5, 6]);
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidExistingRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

export type ValidatedSchedule = {
  scheduleType: 'daily' | 'weekdays';
  weekdays: number[];
  localTime: string;
  timezone: string;
};

// Canonical schedule validation, reused identically for BOTH a current preference
// document and a reminder's claim-time schedule snapshot (see validateReminderSchema) —
// exactly one definition of "what a valid schedule looks like" in this file.
export function validateSchedule(data: Record<string, unknown>): ValidatedSchedule | null {
  if (data.scheduleType !== 'daily' && data.scheduleType !== 'weekdays') return null;
  const scheduleType = data.scheduleType;

  let weekdays: number[];
  if (scheduleType === 'daily') {
    weekdays = [0, 1, 2, 3, 4, 5, 6];
  } else {
    if (!Array.isArray(data.weekdays) || data.weekdays.length === 0) return null;
    const seen = new Set<number>();
    for (const entry of data.weekdays) {
      if (typeof entry !== 'number' || !Number.isInteger(entry) || !VALID_WEEKDAYS.has(entry)) return null;
      seen.add(entry);
    }
    // Duplicate weekday entries are structurally invalid, not silently deduplicated into
    // validity — a canonical schedule never contains the same weekday twice, so an array
    // that does is corruption, and this returns null (invalid) rather than normalizing it.
    if (seen.size !== data.weekdays.length) return null;
    weekdays = [...seen];
  }

  if (typeof data.localTime !== 'string' || !TIME_PATTERN.test(data.localTime)) return null;

  if (typeof data.timezone !== 'string' || data.timezone.length === 0) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: data.timezone });
  } catch {
    return null;
  }

  return { scheduleType, weekdays, localTime: data.localTime, timezone: data.timezone };
}

export function normalizeWeekdaysForComparison(weekdays: number[]): string {
  return [...weekdays].sort((a, b) => a - b).join(',');
}

// ---------------------------------------------------------------------------------------
// DNS progress classification — unchanged.
// ---------------------------------------------------------------------------------------

export const TOTAL_DNS_COURSE_DAYS = 84;
export const COURSE_COMPLETE_DAY = TOTAL_DNS_COURSE_DAYS + 1;

export type ProgressResult =
  | { kind: 'ok'; currentDay: number; courseComplete: boolean }
  | { kind: 'invalid' };

export function classifyProgress(userData: Record<string, unknown> | undefined): ProgressResult {
  if (!userData) return { kind: 'ok', currentDay: 1, courseComplete: false };

  const dnsCourse = userData.dnsCourse;
  if (dnsCourse === undefined || dnsCourse === null) {
    return { kind: 'ok', currentDay: 1, courseComplete: false };
  }
  if (typeof dnsCourse !== 'object') return { kind: 'invalid' };

  const currentDay = (dnsCourse as Record<string, unknown>).currentDay;
  const isValid =
    typeof currentDay === 'number' && Number.isInteger(currentDay) && currentDay >= 1 && currentDay <= COURSE_COMPLETE_DAY;
  if (!isValid) return { kind: 'invalid' };

  return { kind: 'ok', currentDay, courseComplete: currentDay > TOTAL_DNS_COURSE_DAYS };
}

// ---------------------------------------------------------------------------------------
// Reminder occurrence identity.
// ---------------------------------------------------------------------------------------

export function buildReminderId(uid: string, scheduledForMs: number): string {
  return `${uid}_${scheduledForMs}`;
}

// ---------------------------------------------------------------------------------------
// Preference quarantine sentinel — unchanged from the prior round (fixed far-future
// instant, not a relative duration).
// ---------------------------------------------------------------------------------------

export const PREFERENCE_QUARANTINE_SENTINEL_MS = Date.UTC(2100, 0, 1, 0, 0, 0);

export function computeQuarantineDueMs(): number {
  return PREFERENCE_QUARANTINE_SENTINEL_MS;
}

export type QuarantineReason = 'invalid-revision' | 'invalid-schedule' | 'invalid-due-timestamp';

// ---------------------------------------------------------------------------------------
// BLOCKER 2 fix — UID validation. The ONLY actual constraint comes from this codebase's
// path-construction method (`db.doc(`artifacts/${APP_ID}/users/${uid}/...`)`, used
// consistently across pushInstallations.ts, notificationPreferences.ts,
// dnsEntitlement.ts, and this file): a `/` inside uid would split into the wrong path
// segments. Firebase's own UID contract is nonempty, <=128 characters, with no character
// restriction beyond that (Codex correctly identified that a space-containing UID is
// Firebase-valid and must be accepted). Nothing else about this validator's job is to
// invent a narrower "Firebase UID grammar" — it exists solely to protect THIS specific
// string-interpolation path construction, nothing more.
// ---------------------------------------------------------------------------------------

export function isValidUidForPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

// ---------------------------------------------------------------------------------------
// attemptCount safety.
// ---------------------------------------------------------------------------------------

export function isValidAttemptCount(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

// ---------------------------------------------------------------------------------------
// MEDIUM 1 fix — full reminder-record schema validation, INCLUDING the claim-time
// schedule snapshot, reusing validateSchedule's exact canonical semantics (same function,
// same rules — no separate, potentially-diverging "snapshot schedule" grammar). A
// reminder record is only ever safe to act on if uid, preferenceRevisionAtClaim,
// attemptCount, AND the full claim-time schedule snapshot are all valid — Phase B must
// distrust stored reminder state exactly as thoroughly as Phase A distrusts a
// preference document, since both are read back from Firestore, not freshly computed.
// ---------------------------------------------------------------------------------------

export type ReminderSchemaCheck =
  | {
      valid: true;
      uid: string;
      preferenceRevisionAtClaim: number;
      attemptCount: number;
      claimSchedule: ValidatedSchedule;
    }
  | { valid: false; reason: string };

export function validateReminderSchema(data: Record<string, unknown>): ReminderSchemaCheck {
  if (!isValidUidForPath(data.uid)) return { valid: false, reason: 'invalid-uid' };
  if (!isValidExistingRevision(data.preferenceRevisionAtClaim)) return { valid: false, reason: 'invalid-preference-revision-at-claim' };
  if (!isValidAttemptCount(data.attemptCount)) return { valid: false, reason: 'invalid-attempt-count' };
  if (data.attemptCount === Number.MAX_SAFE_INTEGER) return { valid: false, reason: 'attempt-count-exhausted' };

  const claimSchedule = validateSchedule({
    scheduleType: data.scheduleTypeAtClaim,
    weekdays: data.weekdaysAtClaim,
    localTime: data.localTimeAtClaim,
    timezone: data.timezoneAtClaim,
  });
  if (!claimSchedule) return { valid: false, reason: 'invalid-claim-schedule-snapshot' };

  return {
    valid: true,
    uid: data.uid as string,
    preferenceRevisionAtClaim: data.preferenceRevisionAtClaim as number,
    attemptCount: data.attemptCount as number,
    claimSchedule,
  };
}

// ---------------------------------------------------------------------------------------
// BLOCKER 1/2/3 fix (fourth repair round) — directly queryable, structurally poison-proof
// work-state model. The prior round's bounded background "integrity scan" is REMOVED: a
// bounded scan ordered by createdAt can never GUARANTEE eventual discovery of a corrupt
// record sitting behind an unbounded prefix of healthy, never-changing records — that was
// a probabilistic mechanism masquerading as a correctness guarantee, and Codex correctly
// rejected it as such. Recovery correctness must not depend on any background scan.
//
// Every reminder now carries a second server-owned field, `workState`, written ATOMICALLY
// with `status` on every mutation:
//   - status 'claimed' or 'processing'  -> workState 'queued'    (may appear in the queue)
//   - any terminal status (including
//     'invalid-reminder')                -> workState 'terminal'  (can NEVER appear)
// The main recovery query filters on `workState == 'queued'` FIRST, then `workAvailableAt
// <= now`. Because workState is set to 'terminal' in the SAME atomic write that sets a
// terminal status, a terminal record can never match the queue query merely because a
// leftover/corrupted `workAvailableAt` value happens to be in the past — the workState
// equality filter excludes it at the query/index level, independent of what `workAvailableAt`
// contains. This is what solves BLOCKER 2 (a stale terminal `dry-run-complete` record with
// `workAvailableAt: yesterday` can no longer poison the queue: workState='terminal' means
// it is never returned by `where('workState','==','queued')`, full stop).
//
// A still-leased 'processing' record keeps workState='queued' but has `workAvailableAt`
// set to the FUTURE `leaseExpiresAt`, so the `<= now` half of the filter excludes it until
// the lease genuinely expires — this is the same "future timestamp = invisible, not merely
// deprioritized" property from the third round, now composed with the workState filter
// rather than replacing it. This is what solves BLOCKER 1 (a stable prefix of still-leased
// 'queued' records cannot hide an expired 'queued' record: the expired record's
// `workAvailableAt` is in the past and matches the range filter regardless of how many
// still-leased records with future timestamps also happen to have workState='queued').
//
// A record whose `workState` is missing or some other value entirely (arbitrary external
// corruption, not something normal code ever produces) simply never matches
// `workState == 'queued'` — it fails CLOSED, silently absent from the queue, exactly as
// intended by the "we do not need a self-healing database scrubber" instruction: this is
// accepted as requiring trusted operator investigation, not a scheduler-correctness
// problem, because it cannot cause an incorrect send (there is no sender) and cannot
// consume a legitimate queue slot from other work (workState=='queued' is a precise
// equality filter, not a probabilistic sample).
// ---------------------------------------------------------------------------------------

export const WORK_STATES = ['queued', 'terminal'] as const;
export type WorkState = (typeof WORK_STATES)[number];

// The one place that defines "which workState a given status implies." Used both to build
// correct records on every write and to validate an existing tuple's internal consistency.
export function expectedWorkStateForStatus(status: string): WorkState | null {
  if (status === 'claimed' || status === 'processing') return 'queued';
  if (isTerminalStatus(status)) return 'terminal';
  return null; // status itself is not a recognized value at all.
}

export const PROCESSING_LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes.

export function computeLeaseExpiresAtMs(nowMs: number): number {
  return nowMs + PROCESSING_LEASE_DURATION_MS;
}

// BLOCKER 3 — the single pure validator for the complete operational work tuple
// (status, workState, workAvailableAt, leaseExpiresAt). This replaces the third round's
// separate classifyProcessingLease + decideAvailabilityRepair pair: there is exactly ONE
// question that matters before acquiring a lease — "is this stored tuple internally
// consistent, and if so, is it recoverable right now?" — and exactly one function answers
// it. Called with FRESH, transactionally-read data only; never with data from the
// discovery query snapshot (see acquireProcessingLease in reminderScheduler.ts).
export type WorkTupleClassification =
  | { consistent: true; recoverableNow: boolean }
  | { consistent: false; reason: string };

export function classifyWorkTuple(
  status: string,
  workState: unknown,
  workAvailableAtMs: number | null,
  leaseExpiresAtMs: number | null,
  nowMs: number
): WorkTupleClassification {
  const expected = expectedWorkStateForStatus(status);
  if (expected === null) return { consistent: false, reason: 'unrecognized-status' };

  if (typeof workState !== 'string' || !(WORK_STATES as readonly string[]).includes(workState)) {
    return { consistent: false, reason: 'invalid-work-state' };
  }
  if (workState !== expected) {
    return { consistent: false, reason: 'work-state-status-mismatch' };
  }

  if (expected === 'terminal') {
    // A terminal record can never be "recoverable" — this branch exists purely so the
    // validator can also flag leftover corruption on an already-terminal record (e.g. a
    // stale workAvailableAt that normal code would never leave behind) for completeness;
    // it is NOT relied on for queue correctness, since workState alone already excludes
    // terminal records from ever being discovered by the main query.
    if (workAvailableAtMs !== null) return { consistent: false, reason: 'terminal-with-nonnull-availability' };
    if (leaseExpiresAtMs !== null) return { consistent: false, reason: 'terminal-with-nonnull-lease' };
    return { consistent: true, recoverableNow: false };
  }

  // expected === 'queued' -> status is 'claimed' or 'processing'.
  if (workAvailableAtMs === null || !Number.isFinite(workAvailableAtMs)) {
    return { consistent: false, reason: 'queued-missing-availability' };
  }

  if (status === 'claimed') {
    if (leaseExpiresAtMs !== null) return { consistent: false, reason: 'claimed-with-lease' };
    return { consistent: true, recoverableNow: workAvailableAtMs <= nowMs };
  }

  // status === 'processing' -> a live lease must exist and must equal workAvailableAt
  // exactly (they are the same instant by construction — see acquireProcessingLease).
  if (leaseExpiresAtMs === null || !Number.isFinite(leaseExpiresAtMs)) {
    return { consistent: false, reason: 'processing-missing-lease' };
  }
  if (workAvailableAtMs !== leaseExpiresAtMs) {
    return { consistent: false, reason: 'processing-availability-lease-mismatch' };
  }
  return { consistent: true, recoverableNow: leaseExpiresAtMs <= nowMs };
}

// Pure payload for the quarantine mutation — deliberately excludes any
// firebase-admin-specific sentinel (e.g. FieldValue.serverTimestamp()); the orchestration
// layer merges `quarantinedAt` in itself. Setting workState to 'terminal' (not merely
// workAvailableAt to null) is what makes this exclusion structural rather than incidental
// — even if workAvailableAt were somehow later corrupted back to a past value, the
// workState filter alone still keeps this record out of the queue permanently.
export function buildQuarantineUpdate(reason: string): {
  status: 'invalid-reminder';
  workState: 'terminal';
  invalidReminderReason: string;
  workAvailableAt: null;
  leaseExpiresAt: null;
} {
  return { status: 'invalid-reminder', workState: 'terminal', invalidReminderReason: reason, workAvailableAt: null, leaseExpiresAt: null };
}

// Pure payload shared by every terminal-transition write (dry-run-complete, cancelled,
// invalid-progress, course-complete) — guarantees workState/workAvailableAt/leaseExpiresAt
// are cleared atomically with the status write itself, every single time, so there is no
// code path that can set a terminal status without also excluding it from the queue. Also
// reused, unchanged, as the TERMINAL QUEUE REPAIR payload (fifth repair round): when a
// recognized terminal status is found with a corrupted queued/due tuple, only these three
// operational fields are rewritten — no status change, no attemptCount change, no
// business-outcome change.
export function buildTerminalWorkStateFields(): { workState: 'terminal'; workAvailableAt: null; leaseExpiresAt: null } {
  return { workState: 'terminal', workAvailableAt: null, leaseExpiresAt: null };
}

// Pure payload for the UNKNOWN-STATUS corruption-neutralization write (fifth repair
// round, BLOCKER 1). This is deliberately NOT a normal status-machine transition — the
// source `status` value is, by definition, not one of the seven recognized values, so
// `requireAllowedTransition` cannot and must not be consulted for it (see
// decideQueueOutcome and its caller in reminderScheduler.ts, which never calls
// requireAllowedTransition on this path). The original corrupt value is preserved in
// `originalCorruptStatus` for operator diagnostics; the record otherwise becomes a
// perfectly ordinary, canonical `invalid-reminder` record afterward — this keeps exactly
// one source of truth for "is this record queued" (workState) rather than introducing a
// second, parallel exclusion mechanism.
export function buildUnknownStatusNeutralizationUpdate(originalStatus: string): {
  status: 'invalid-reminder';
  workState: 'terminal';
  workAvailableAt: null;
  leaseExpiresAt: null;
  invalidReminderReason: string;
  originalCorruptStatus: string;
} {
  return {
    status: 'invalid-reminder',
    workState: 'terminal',
    workAvailableAt: null,
    leaseExpiresAt: null,
    invalidReminderReason: 'unknown-status',
    originalCorruptStatus: originalStatus,
  };
}

// ---------------------------------------------------------------------------------------
// BLOCKER 1/2 fix (fifth repair round) — the shared queue-outcome decision helper. The
// fourth round's defect was that `acquireProcessingLease` returned early on an
// unrecognized or recognized-terminal `status` BEFORE considering whether the record's
// queue tuple (`workState`/`workAvailableAt`) still matched the recovery query — leaving
// a due+queued poisoned record completely untouched, so it reappeared on every subsequent
// tick forever. This function is the ONE place that decides what must happen to ANY
// record the recovery query could have returned, and production code (in
// reminderScheduler.ts) and tests both call it directly, eliminating the
// orchestration-vs-test mismatch that caused the defect. Its result is exhaustive: for
// every possible (status, workState, workAvailableAt, leaseExpiresAt) tuple, exactly one
// of these six actions applies, and every action maps to one of the three states required
// by the sole invariant this round enforces — acquired, temporarily ineligible
// ('still-leased'), or permanently excluded (all other actions) — see the exact mapping
// table in the implementation report.
// ---------------------------------------------------------------------------------------

export type QueueOutcome =
  | { action: 'acquire' }
  | { action: 'still-leased' }
  | { action: 'quarantine-known-corruption'; reason: string }
  | { action: 'repair-terminal-queue-state' }
  | { action: 'neutralize-unknown-status' }
  | { action: 'already-terminal-correct' };

export function decideQueueOutcome(
  status: string,
  workState: unknown,
  workAvailableAtMs: number | null,
  leaseExpiresAtMs: number | null,
  schemaCheck: ReminderSchemaCheck,
  nowMs: number
): QueueOutcome {
  if (expectedWorkStateForStatus(status) === null) {
    // BLOCKER 1: status is not one of the seven recognized values at all — pure
    // out-of-band corruption. Regardless of the current workState/availability values,
    // queue eligibility must be neutralized now; if this is somehow re-evaluated after
    // already being neutralized, reapplying the same terminal values is idempotent and
    // harmless.
    return { action: 'neutralize-unknown-status' };
  }

  if (isTerminalStatus(status)) {
    // BLOCKER 2: a recognized terminal status is not automatically safe just because the
    // status itself is legitimate — its QUEUE metadata may still be corrupted (the exact
    // "dry-run-complete with workState still 'queued'" poisoning case). Only a tuple that
    // is ALREADY the canonical terminal shape needs no repair.
    const alreadyCanonical = workState === 'terminal' && workAvailableAtMs === null && leaseExpiresAtMs === null;
    return alreadyCanonical ? { action: 'already-terminal-correct' } : { action: 'repair-terminal-queue-state' };
  }

  // status is 'claimed' or 'processing' — the only two statuses classifyWorkTuple accepts.
  if (!schemaCheck.valid) return { action: 'quarantine-known-corruption', reason: schemaCheck.reason };

  const tuple = classifyWorkTuple(status, workState, workAvailableAtMs, leaseExpiresAtMs, nowMs);
  if (!tuple.consistent) return { action: 'quarantine-known-corruption', reason: tuple.reason };
  if (!tuple.recoverableNow) return { action: 'still-leased' };
  return { action: 'acquire' };
}

// ---------------------------------------------------------------------------------------
// BLOCKER 4 / timezone-after-claim — post-claim consent AND full schedule-identity
// revalidation. Unchanged in substance from the second repair round (Codex passed this
// mechanism) — conservative: ANY material difference cancels the in-flight occurrence.
// ---------------------------------------------------------------------------------------

export type ScheduleSnapshot = {
  scheduleType: 'daily' | 'weekdays';
  weekdays: number[];
  localTime: string;
  timezone: string;
};

export type ConsentRevalidation =
  | { outcome: 'proceed' }
  | {
      outcome: 'cancelled';
      reason:
        | 'disabled-after-claim'
        | 'schedule-changed-after-claim'
        | 'timezone-changed-after-claim'
        | 'preference-missing-after-claim';
    };

export function revalidateConsent(
  claimRevision: number,
  claimSchedule: ScheduleSnapshot,
  current: { exists: boolean; enabled?: boolean; revision?: number; schedule?: ScheduleSnapshot }
): ConsentRevalidation {
  if (!current.exists) return { outcome: 'cancelled', reason: 'preference-missing-after-claim' };
  if (current.enabled !== true) return { outcome: 'cancelled', reason: 'disabled-after-claim' };
  if (current.revision !== claimRevision) return { outcome: 'cancelled', reason: 'schedule-changed-after-claim' };
  if (!current.schedule) return { outcome: 'cancelled', reason: 'schedule-changed-after-claim' };
  if (current.schedule.timezone !== claimSchedule.timezone) {
    return { outcome: 'cancelled', reason: 'timezone-changed-after-claim' };
  }
  if (current.schedule.scheduleType !== claimSchedule.scheduleType) {
    return { outcome: 'cancelled', reason: 'schedule-changed-after-claim' };
  }
  if (current.schedule.localTime !== claimSchedule.localTime) {
    return { outcome: 'cancelled', reason: 'schedule-changed-after-claim' };
  }
  if (normalizeWeekdaysForComparison(current.schedule.weekdays) !== normalizeWeekdaysForComparison(claimSchedule.weekdays)) {
    return { outcome: 'cancelled', reason: 'schedule-changed-after-claim' };
  }
  return { outcome: 'proceed' };
}

// ---------------------------------------------------------------------------------------
// Bounded-concurrency worker pool — unchanged.
// ---------------------------------------------------------------------------------------

export async function processWithBoundedConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let index = 0;
  async function runNext(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  }
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runNext()));
}

// ---------------------------------------------------------------------------------------
// Reminder status model — unchanged set of seven statuses from the second repair round.
// All transitions validated against this SAME table by production mutation code.
// ---------------------------------------------------------------------------------------

export const REMINDER_STATUSES = [
  'claimed',
  'processing',
  'dry-run-complete',
  'cancelled',
  'invalid-progress',
  'course-complete',
  'invalid-reminder',
] as const;
export type ReminderStatus = (typeof REMINDER_STATUSES)[number];

const TERMINAL_STATUSES = new Set<ReminderStatus>([
  'dry-run-complete',
  'cancelled',
  'invalid-progress',
  'course-complete',
  'invalid-reminder',
]);

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as ReminderStatus);
}

const ALLOWED_TRANSITIONS: Record<ReminderStatus, ReminderStatus[]> = {
  claimed: ['processing', 'invalid-reminder'],
  processing: ['processing', 'dry-run-complete', 'cancelled', 'invalid-progress', 'course-complete', 'invalid-reminder'],
  'dry-run-complete': [],
  cancelled: [],
  'invalid-progress': [],
  'course-complete': [],
  'invalid-reminder': [],
};

export function isAllowedTransition(from: string, to: string): boolean {
  const fromStatus = from as ReminderStatus;
  const toStatus = to as ReminderStatus;
  if (!REMINDER_STATUSES.includes(fromStatus) || !REMINDER_STATUSES.includes(toStatus)) return false;
  return ALLOWED_TRANSITIONS[fromStatus].includes(toStatus);
}

export function requireAllowedTransition(from: string, to: string): void {
  if (!isAllowedTransition(from, to)) {
    throw new Error(`Invalid reminder status transition: ${from} -> ${to}`);
  }
}
