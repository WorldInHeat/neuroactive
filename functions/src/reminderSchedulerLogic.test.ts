// functions/src/reminderSchedulerLogic.test.ts
// Phase 3A-3 Step 2 (fifth Codex repair round) — real, repository-local test file for
// the scheduler's pure logic.
//
// This repo has no test runner configured (no jest/mocha in functions/package.json), so
// this file is a small, dependency-free, self-contained assertion script rather than
// reaching for new test infrastructure. It imports the ACTUAL functions the production
// scheduler uses (from reminderSchedulerLogic.ts) — nothing here is a re-implementation.
//
// HOW TO RUN:
//   cd functions
//   npm run build
//   node lib/reminderSchedulerLogic.test.js
//
// SCOPE / HONESTY NOTE: this file exercises every PURE function in
// reminderSchedulerLogic.ts, including a plain-JS model of Firestore's documented query
// matching rules (an equality filter matches only an exact stored value; a `<=` range
// filter additionally requires the field to be present and of a comparable type — see
// matchesRecoverableWorkFilter below). It does NOT and cannot exercise actual Firestore
// query execution, index behavior, or transaction races under real concurrent writes —
// that would require a Firestore emulator, unavailable in this development environment
// (no Java runtime present). Those scenarios are instead verified by architectural
// reasoning in the implementation report, stated there explicitly as reasoning rather
// than executed test results.
import {
  getZonedParts,
  localWallTimeToUtcMs,
  computeNextOccurrenceMs,
  isValidExistingRevision,
  validateSchedule,
  normalizeWeekdaysForComparison,
  classifyProgress,
  buildReminderId,
  computeQuarantineDueMs,
  PREFERENCE_QUARANTINE_SENTINEL_MS,
  computeLeaseExpiresAtMs,
  PROCESSING_LEASE_DURATION_MS,
  isValidAttemptCount,
  isValidUidForPath,
  validateReminderSchema,
  buildQuarantineUpdate,
  buildTerminalWorkStateFields,
  buildUnknownStatusNeutralizationUpdate,
  expectedWorkStateForStatus,
  classifyWorkTuple,
  decideQueueOutcome,
  revalidateConsent,
  processWithBoundedConcurrency,
  isAllowedTransition,
  isTerminalStatus,
  requireAllowedTransition,
  TOTAL_DNS_COURSE_DAYS,
  COURSE_COMPLETE_DAY,
  REMINDER_STATUSES,
  type ScheduleSnapshot,
} from './reminderSchedulerLogic';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

// ============================================================================
// Timezone / DST regression (unchanged algorithm — re-verified against the exact
// production module).
// ============================================================================
console.log('=== Timezone / DST regression ===');
{
  const p = getZonedParts(new Date(localWallTimeToUtcMs(2026, 3, 8, 2, 30, 'America/Chicago')), 'America/Chicago');
  check('Chicago spring gap 02:30 -> 03:30', `${p.hour}:${p.minute}` === '3:30');
}
{
  const p = getZonedParts(new Date(localWallTimeToUtcMs(2026, 10, 4, 2, 15, 'Australia/Lord_Howe')), 'Australia/Lord_Howe');
  check('Lord Howe spring gap 02:15 -> 02:45', `${p.hour}:${p.minute}` === '2:45');
}
{
  const p = getZonedParts(new Date(localWallTimeToUtcMs(2026, 11, 1, 1, 30, 'America/Chicago')), 'America/Chicago');
  check('Chicago fall fold 01:30 -> earlier occurrence, exact 01:30', `${p.hour}:${p.minute}` === '1:30');
}
{
  const p = getZonedParts(new Date(localWallTimeToUtcMs(2026, 4, 5, 1, 45, 'Australia/Lord_Howe')), 'Australia/Lord_Howe');
  check('Lord Howe fall fold 01:45 -> earlier occurrence, exact 01:45', `${p.hour}:${p.minute}` === '1:45');
}

// ============================================================================
// Coalescing.
// ============================================================================
console.log('\n=== Coalescing ===');
{
  const now = new Date(Date.UTC(2026, 0, 12, 20, 0, 0)); // Monday Jan 12 2026, 14:00 Chicago
  const next = computeNextOccurrenceMs(now, 'America/Chicago', '07:00', [1, 3, 5]);
  const p = getZonedParts(new Date(next), 'America/Chicago');
  const weekday = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
  check('basic due: Monday after 7am -> next due Wednesday', weekday === 3 && `${p.year}-${p.month}-${p.day}` === '2026-1-14');
}
{
  const staleOverdue = localWallTimeToUtcMs(2026, 1, 5, 7, 0, 'America/Chicago');
  const actualNow = new Date(Date.UTC(2026, 0, 12, 20, 0, 0));
  const advancedTo = computeNextOccurrenceMs(actualNow, 'America/Chicago', '07:00', [1, 3, 5]);
  check('downtime coalescing: advancement from actual-now, strictly after stale occurrence', advancedTo > staleOverdue);
}

// ============================================================================
// Reminder ID identity.
// ============================================================================
console.log('\n=== Reminder ID identity ===');
check('same uid+scheduledFor -> identical id', buildReminderId('uidA', 1700000000000) === buildReminderId('uidA', 1700000000000));
check('same uid, different scheduledFor -> different id', buildReminderId('uidA', 1700000000000) !== buildReminderId('uidA', 1700000300000));
check('different uid, same scheduledFor -> different id', buildReminderId('uidA', 1700000000000) !== buildReminderId('uidB', 1700000000000));

// ============================================================================
// Revision validity / validateSchedule (unchanged from prior rounds).
// ============================================================================
console.log('\n=== Revision validity ===');
check('missing revision invalid', !isValidExistingRevision(undefined));
check('zero invalid', !isValidExistingRevision(0));
check('negative invalid', !isValidExistingRevision(-1));
check('fractional invalid', !isValidExistingRevision(1.5));
check('NaN invalid', !isValidExistingRevision(NaN));
check('unsafe integer invalid', !isValidExistingRevision(Number.MAX_SAFE_INTEGER + 10));
check('valid 1 accepted', isValidExistingRevision(1));

console.log('\n=== validateSchedule ===');
check('valid weekdays schedule accepted', validateSchedule({ scheduleType: 'weekdays', weekdays: [1, 3, 5], localTime: '07:00', timezone: 'America/Chicago' }) !== null);
check('empty weekdays array rejected', validateSchedule({ scheduleType: 'weekdays', weekdays: [], localTime: '07:00', timezone: 'UTC' }) === null);
check('invalid timezone rejected', validateSchedule({ scheduleType: 'daily', weekdays: [], localTime: '07:00', timezone: 'Not/AZone' }) === null);
check('duplicate weekdays REJECTED (not silently deduped)', validateSchedule({ scheduleType: 'weekdays', weekdays: [1, 1, 3], localTime: '07:00', timezone: 'UTC' }) === null);
check('missing scheduleType rejected', validateSchedule({ weekdays: [1], localTime: '07:00', timezone: 'UTC' }) === null);
check('invalid localTime pattern rejected', validateSchedule({ scheduleType: 'daily', weekdays: [], localTime: '25:00', timezone: 'UTC' }) === null);
check('normalizeWeekdaysForComparison is order-independent', normalizeWeekdaysForComparison([1, 3, 5]) === normalizeWeekdaysForComparison([5, 1, 3]));
check('normalizeWeekdaysForComparison distinguishes different sets', normalizeWeekdaysForComparison([1, 3, 5]) !== normalizeWeekdaysForComparison([1, 3]));

// ============================================================================
// Preference quarantine sentinel (unchanged from round 2).
// ============================================================================
console.log('\n=== Preference quarantine sentinel ===');
{
  const a = computeQuarantineDueMs();
  const b = computeQuarantineDueMs();
  check('quarantine sentinel is a FIXED value, not relative to call time (idempotent across repeated calls)', a === b);
  check('sentinel equals the documented constant', a === PREFERENCE_QUARANTINE_SENTINEL_MS);
  const nowMs = Date.now();
  check('sentinel is far in the future relative to now (> 50 years)', a - nowMs > 50 * 365 * 24 * 60 * 60 * 1000);
  // Firestore/protobuf Timestamp documented range: seconds since epoch up to year 9999.
  const sentinelSeconds = a / 1000;
  const maxDocumentedSeconds = 253402300799; // approx seconds at 9999-12-31T23:59:59Z
  check("sentinel seconds value is safely within Firestore Timestamp's documented range", sentinelSeconds > 0 && sentinelSeconds < maxDocumentedSeconds);
}

// ============================================================================
// BLOCKER 2 — UID validation. Firebase UIDs are nonempty strings up to 128
// characters; spaces are NOT forbidden by Firebase's actual contract. The ONLY
// reason '/' is rejected here is that this codebase interpolates uid into a
// slash-delimited Firestore path string — this is a path-construction constraint,
// not a general Firebase UID grammar, and must not be broadened.
// ============================================================================
console.log('\n=== UID validation (BLOCKER 2) ===');
check('empty-string uid invalid', !isValidUidForPath(''));
check('uid containing a path separator invalid', !isValidUidForPath('abc/def'));
check('uid containing a space IS VALID (Firebase does not forbid spaces)', isValidUidForPath('abc def'));
check('uid exactly 128 chars valid', isValidUidForPath('a'.repeat(128)));
check('uid 129 chars invalid', !isValidUidForPath('a'.repeat(129)));
check('reasonable-length real-shaped uid valid', isValidUidForPath('hnf35g3YI5X4yKV2JZllK4DbX0c2'));
check('uid with punctuation/unicode valid (not arbitrarily rejected)', isValidUidForPath("O'Br—ien_ID.42"));
check('non-string uid invalid', !isValidUidForPath(12345));
check('null uid invalid', !isValidUidForPath(null));

// ============================================================================
// MEDIUM 1 — reminder schema validation, now including the claim-time schedule
// snapshot fields (scheduleTypeAtClaim/weekdaysAtClaim/localTimeAtClaim/
// timezoneAtClaim), validated with the SAME semantics as current preferences.
// ============================================================================
console.log('\n=== Reminder schema validation (MEDIUM 1: claim schedule snapshot) ===');
const validReminderBase = {
  uid: 'abc123XYZ',
  preferenceRevisionAtClaim: 3,
  attemptCount: 2,
  status: 'claimed',
  scheduleTypeAtClaim: 'weekdays',
  weekdaysAtClaim: [1, 3, 5],
  localTimeAtClaim: '07:00',
  timezoneAtClaim: 'America/Chicago',
};
check('valid claimed reminder (with valid snapshot) accepted', validateReminderSchema(validReminderBase).valid === true);
check('missing uid invalid', validateReminderSchema({ ...validReminderBase, uid: undefined }).valid === false);
check('uid containing a space still accepted at schema level', validateReminderSchema({ ...validReminderBase, uid: 'abc def' }).valid === true);
check('invalid preferenceRevisionAtClaim (0) invalid', validateReminderSchema({ ...validReminderBase, preferenceRevisionAtClaim: 0 }).valid === false);
check('NaN attemptCount invalid', validateReminderSchema({ ...validReminderBase, attemptCount: NaN }).valid === false);
check('Infinity attemptCount invalid', validateReminderSchema({ ...validReminderBase, attemptCount: Infinity }).valid === false);
check('fractional attemptCount invalid', validateReminderSchema({ ...validReminderBase, attemptCount: 1.5 }).valid === false);
check('negative attemptCount invalid', validateReminderSchema({ ...validReminderBase, attemptCount: -1 }).valid === false);
check('unsafe attemptCount invalid', validateReminderSchema({ ...validReminderBase, attemptCount: Number.MAX_SAFE_INTEGER + 1 }).valid === false);
check('MAX_SAFE_INTEGER attemptCount rejected for further acquisition (exhausted)', validateReminderSchema({ ...validReminderBase, attemptCount: Number.MAX_SAFE_INTEGER }).valid === false);
check('MAX_SAFE_INTEGER-1 attemptCount is valid (can still increment safely once)', validateReminderSchema({ ...validReminderBase, attemptCount: Number.MAX_SAFE_INTEGER - 1 }).valid === true);
check(
  'isValidAttemptCount rejects MAX_SAFE_INTEGER+1 but accepts MAX_SAFE_INTEGER itself (exhaustion is a SEPARATE explicit check, not a validity failure)',
  isValidAttemptCount(Number.MAX_SAFE_INTEGER) === true && isValidAttemptCount(Number.MAX_SAFE_INTEGER + 1) === false
);
check('missing claim-schedule snapshot entirely invalid', validateReminderSchema({ uid: 'abc', preferenceRevisionAtClaim: 1, attemptCount: 0, status: 'claimed' }).valid === false);
check('malformed scheduleTypeAtClaim invalid', validateReminderSchema({ ...validReminderBase, scheduleTypeAtClaim: 'monthly' }).valid === false);
check('malformed weekdaysAtClaim (non-array) invalid', validateReminderSchema({ ...validReminderBase, weekdaysAtClaim: 'not-an-array' }).valid === false);
check('duplicate weekdaysAtClaim REJECTED as invalid, not deduped', validateReminderSchema({ ...validReminderBase, weekdaysAtClaim: [1, 1, 3] }).valid === false);
check('invalid localTimeAtClaim invalid', validateReminderSchema({ ...validReminderBase, localTimeAtClaim: '99:99' }).valid === false);
check('invalid timezoneAtClaim (not a real IANA zone) invalid', validateReminderSchema({ ...validReminderBase, timezoneAtClaim: 'Not/AZone' }).valid === false);
check('daily scheduleTypeAtClaim with empty weekdaysAtClaim is valid (daily does not require weekdays)', validateReminderSchema({ ...validReminderBase, scheduleTypeAtClaim: 'daily', weekdaysAtClaim: [] }).valid === true);
{
  const result = validateReminderSchema(validReminderBase);
  check(
    'valid result carries the parsed claimSchedule through for consent revalidation reuse',
    result.valid === true && result.claimSchedule.timezone === 'America/Chicago' && result.claimSchedule.weekdays.join(',') === '1,3,5'
  );
}

console.log('\n=== buildQuarantineUpdate / buildTerminalWorkStateFields ===');
{
  const u = buildQuarantineUpdate('invalid-uid');
  check('quarantine update sets terminal status', u.status === 'invalid-reminder');
  check('quarantine update records the reason', u.invalidReminderReason === 'invalid-uid');
  check('quarantine update sets workState terminal (structural exclusion, not just a cleared timestamp)', u.workState === 'terminal');
  check('quarantine update clears workAvailableAt', u.workAvailableAt === null);
  check('quarantine update clears leaseExpiresAt', u.leaseExpiresAt === null);
}
{
  const t = buildTerminalWorkStateFields();
  check('terminal fields set workState terminal', t.workState === 'terminal');
  check('terminal fields clear workAvailableAt', t.workAvailableAt === null);
  check('terminal fields clear leaseExpiresAt', t.leaseExpiresAt === null);
}

console.log('\n=== expectedWorkStateForStatus (status/workState legal-pair mapping) ===');
check('claimed -> queued', expectedWorkStateForStatus('claimed') === 'queued');
check('processing -> queued', expectedWorkStateForStatus('processing') === 'queued');
check('dry-run-complete -> terminal', expectedWorkStateForStatus('dry-run-complete') === 'terminal');
check('cancelled -> terminal', expectedWorkStateForStatus('cancelled') === 'terminal');
check('invalid-progress -> terminal', expectedWorkStateForStatus('invalid-progress') === 'terminal');
check('course-complete -> terminal', expectedWorkStateForStatus('course-complete') === 'terminal');
check('invalid-reminder -> terminal', expectedWorkStateForStatus('invalid-reminder') === 'terminal');
check('unrecognized status -> null (fail closed, no guessed mapping)', expectedWorkStateForStatus('banana') === null);

// ============================================================================
// BLOCKER 1/2 — unified workState+workAvailableAt recoverable-work query model.
// Firestore's documented matching rules (not something this environment can execute
// without an emulator): an equality filter (`workState == 'queued'`) matches only an
// exact stored value — a missing/different value never matches, regardless of any
// other field's contents; a `<=` range filter additionally requires the field to be
// present and of a comparable type. This function models exactly that COMBINED
// matching rule so the scenarios Codex specified can be verified as plain data-driven
// assertions. It is not a re-implementation of Firestore query execution or index
// behavior — it is the documented matching predicate that
// `.where('workState','==','queued').where('workAvailableAt','<=',now)` applies
// per-document.
// ============================================================================
console.log('\n=== Unified recoverable-work query model (workState + workAvailableAt) ===');
type SimRecord = { workState: unknown; workAvailableAtMs: number | null | undefined };
function matchesRecoverableWorkFilter(rec: SimRecord, nowMs: number): boolean {
  if (rec.workState !== 'queued') return false;
  return typeof rec.workAvailableAtMs === 'number' && Number.isFinite(rec.workAvailableAtMs) && rec.workAvailableAtMs <= nowMs;
}
{
  const now = Date.now();
  // A: 50 claimed (immediately available) + 1 expired processing record.
  const claimed: SimRecord[] = Array.from({ length: 50 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const expired: SimRecord[] = [{ workState: 'queued', workAvailableAtMs: now - 5000 }];
  const available = [...claimed, ...expired].filter((r) => matchesRecoverableWorkFilter(r, now));
  check('A: 50 claimed + 1 expired -> all 51 available, expired not hidden', available.length === 51);
}
{
  const now = Date.now();
  const claimed: SimRecord[] = Array.from({ length: 100 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const expired: SimRecord[] = Array.from({ length: 50 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const available = [...claimed, ...expired].filter((r) => matchesRecoverableWorkFilter(r, now));
  check('B: 100 claimed + 50 expired -> all 150 available', available.length === 150);
}
{
  const now = Date.now();
  const claimed: SimRecord[] = Array.from({ length: 5 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const expired: SimRecord[] = Array.from({ length: 100 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const available = [...claimed, ...expired].filter((r) => matchesRecoverableWorkFilter(r, now));
  check('C: 5 claimed + 100 expired -> all 105 available', available.length === 105);
}
{
  const now = Date.now();
  const claimed: SimRecord[] = Array.from({ length: 100 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const expired: SimRecord[] = Array.from({ length: 5 }, () => ({ workState: 'queued', workAvailableAtMs: now - 1 }));
  const available = [...claimed, ...expired].filter((r) => matchesRecoverableWorkFilter(r, now));
  check('D: 100 claimed + 5 expired -> all 105 available', available.length === 105);
}
{
  const now = Date.now();
  // 50 valid queued+available records drain oldest-first: sorting by workAvailableAt
  // ascending (what the real orderBy does) puts the smallest (oldest) timestamps
  // first, independent of insertion order.
  const shuffled: SimRecord[] = Array.from({ length: 50 }, (_, i) => ({ workState: 'queued', workAvailableAtMs: now - (50 - i) * 1000 }));
  const sorted = [...shuffled].sort((a, b) => (a.workAvailableAtMs as number) - (b.workAvailableAtMs as number));
  check('50 valid queued records drain oldest-first when ordered by workAvailableAt', sorted[0].workAvailableAtMs === now - 50000 && sorted[49].workAvailableAtMs === now - 1000);
}
{
  const now = Date.now();
  // 10,000 hypothetical future-dated queued records never match `<= now`, at any scale.
  const future: SimRecord[] = Array.from({ length: 10000 }, () => ({ workState: 'queued', workAvailableAtMs: now + 5 * 60 * 1000 }));
  const available = future.filter((r) => matchesRecoverableWorkFilter(r, now));
  check('10,000 future-dated queued records -> zero match <= now, unaffected by scale', available.length === 0);
}
{
  const now = Date.now();
  // BLOCKER 2's exact corrupt scenario: status=dry-run-complete (terminal), but
  // workAvailableAt was somehow left at a past value. Because normal terminal commits
  // set workState='terminal' in the SAME atomic write, this exact combination cannot
  // arise from normal code -- but even simulating the corrupted tuple directly, the
  // workState filter alone excludes it, independent of the stale timestamp.
  const corruptedTerminal: SimRecord = { workState: 'terminal', workAvailableAtMs: now - 24 * 60 * 60 * 1000 };
  check('terminal record with stale PAST workAvailableAt is excluded by workState filter, not by the timestamp', !matchesRecoverableWorkFilter(corruptedTerminal, now));
}
{
  const now = Date.now();
  // Corrupted/missing workState (arbitrary external corruption) -- fails closed.
  const missingWorkState: SimRecord = { workState: undefined, workAvailableAtMs: now - 1 };
  const wrongWorkState: SimRecord = { workState: 'bogus', workAvailableAtMs: now - 1 };
  check('missing workState excluded from the queue (fail closed)', !matchesRecoverableWorkFilter(missingWorkState, now));
  check('unrecognized workState value excluded from the queue (fail closed)', !matchesRecoverableWorkFilter(wrongWorkState, now));
}
{
  const now = Date.now();
  // New claims use later timestamps than existing older backlog; older work still
  // drains first under ascending order.
  const older: SimRecord = { workState: 'queued', workAvailableAtMs: now - 10000 };
  const newer: SimRecord = { workState: 'queued', workAvailableAtMs: now - 1 };
  const drainOrder = [older, newer].sort((a, b) => (a.workAvailableAtMs as number) - (b.workAvailableAtMs as number));
  check('older available work drains before newer arrivals', drainOrder[0] === older && drainOrder[1] === newer);
}
{
  const now = Date.now();
  // E/F equivalent under the combined model: a still-leased ('queued', future
  // workAvailableAt) prefix at both 25 and 10,000 scale cannot hide an expired
  // ('queued', past workAvailableAt) record behind it.
  const stillLeased25: SimRecord[] = Array.from({ length: 25 }, () => ({ workState: 'queued', workAvailableAtMs: now + 5 * 60 * 1000 }));
  const expiredBehind: SimRecord = { workState: 'queued', workAvailableAtMs: now - 1 };
  const available25 = [...stillLeased25, expiredBehind].filter((r) => matchesRecoverableWorkFilter(r, now));
  check('E: 25 still-leased + 1 expired behind them -> exactly the 1 expired record is available', available25.length === 1 && available25[0] === expiredBehind);

  const stillLeased10k: SimRecord[] = Array.from({ length: 10000 }, () => ({ workState: 'queued', workAvailableAtMs: now + 5 * 60 * 1000 }));
  const available10k = [...stillLeased10k, expiredBehind].filter((r) => matchesRecoverableWorkFilter(r, now));
  check('F: 10,000 still-leased + 1 expired -> exactly 1 available, unaffected by scale', available10k.length === 1);
}
{
  // H: one class entirely empty -- no crash, no special-casing required.
  const now = Date.now();
  const onlyExpired: SimRecord[] = [now - 1, now - 2, now - 3].map((ms) => ({ workState: 'queued', workAvailableAtMs: ms }));
  const onlyStillLeased: SimRecord[] = [now + 1000, now + 2000].map((ms) => ({ workState: 'queued', workAvailableAtMs: ms }));
  check('H: only expired processing present -> all found', onlyExpired.filter((r) => matchesRecoverableWorkFilter(r, now)).length === 3);
  check('H: only still-leased present -> none found (correctly none due yet)', onlyStillLeased.filter((r) => matchesRecoverableWorkFilter(r, now)).length === 0);
}

// ============================================================================
// BLOCKER 3 — classifyWorkTuple: the single pure validator for the complete
// (status, workState, workAvailableAt, leaseExpiresAt) tuple.
// ============================================================================
console.log('\n=== classifyWorkTuple (BLOCKER 3: transactional work-tuple validation) ===');
{
  const now = Date.now();
  // NORMAL, consistent tuples.
  check('claimed + queued + valid past workAvailableAt -> consistent, available', (() => {
    const r = classifyWorkTuple('claimed', 'queued', now - 1, null, now);
    return r.consistent === true && r.recoverableNow === true;
  })());
  check('processing + queued + live lease (workAvailableAt==leaseExpiresAt, future) -> consistent, NOT available yet', (() => {
    const live = now + 60000;
    const r = classifyWorkTuple('processing', 'queued', live, live, now);
    return r.consistent === true && r.recoverableNow === false;
  })());
  check('processing + queued + expired lease (workAvailableAt==leaseExpiresAt, past) -> consistent, available', (() => {
    const expired = now - 1;
    const r = classifyWorkTuple('processing', 'queued', expired, expired, now);
    return r.consistent === true && r.recoverableNow === true;
  })());
  check('terminal + terminal workState + null availability -> consistent, never available', (() => {
    const r = classifyWorkTuple('dry-run-complete', 'terminal', null, null, now);
    return r.consistent === true && r.recoverableNow === false;
  })());

  // INCONSISTENT tuples -- every one of these must be flagged, not silently accepted.
  check('claimed + terminal workState -> invalid', classifyWorkTuple('claimed', 'terminal', now - 1, null, now).consistent === false);
  check('claimed + queued + null availability -> invalid', classifyWorkTuple('claimed', 'queued', null, null, now).consistent === false);
  check('processing + queued + workAvailableAt != leaseExpiresAt -> invalid', classifyWorkTuple('processing', 'queued', now + 1000, now + 2000, now).consistent === false);
  check('processing + queued + missing lease -> invalid', classifyWorkTuple('processing', 'queued', now + 1000, null, now).consistent === false);
  check('processing + terminal workState -> invalid', classifyWorkTuple('processing', 'terminal', now + 1000, now + 1000, now).consistent === false);
  check(
    'terminal + queued workState + past availability -> invalid structurally (this exact tuple is what BLOCKER 2 forbids normal code from ever producing)',
    classifyWorkTuple('dry-run-complete', 'queued', now - 1000, null, now).consistent === false
  );
  check('invalid-reminder + queued -> invalid', classifyWorkTuple('invalid-reminder', 'queued', now - 1, null, now).consistent === false);
  check('unknown workState -> invalid/fail closed', classifyWorkTuple('claimed', 'bogus', now - 1, null, now).consistent === false);
  check('missing workState -> invalid/fail closed', classifyWorkTuple('claimed', undefined, now - 1, null, now).consistent === false);
  check('unrecognized status -> invalid/fail closed', classifyWorkTuple('banana', 'queued', now - 1, null, now).consistent === false);
  check('claimed + queued + a lease present (should be null for claimed) -> invalid', classifyWorkTuple('claimed', 'queued', now - 1, now + 1000, now).consistent === false);
  check('terminal + terminal workState + nonnull availability (leftover corruption) -> invalid, even though non-poisoning', classifyWorkTuple('cancelled', 'terminal', now - 1, null, now).consistent === false);
}

console.log('\n=== Lease acquisition invariants ===');
{
  const now = Date.now();
  const newLeaseMs = computeLeaseExpiresAtMs(now);
  check('a fresh lease acquisition would set workAvailableAt exactly equal to leaseExpiresAt', newLeaseMs === now + PROCESSING_LEASE_DURATION_MS);
  check('classifyWorkTuple accepts workAvailableAt==leaseExpiresAt as the only valid processing shape', classifyWorkTuple('processing', 'queued', newLeaseMs, newLeaseMs, now).consistent === true);
  check('lease expiry makes an identical tuple query-eligible automatically (same values, later "now")', (() => {
    const r = classifyWorkTuple('processing', 'queued', newLeaseMs, newLeaseMs, newLeaseMs + 1);
    return r.consistent === true && r.recoverableNow === true;
  })());
  check('terminal commit (buildTerminalWorkStateFields) removes eligibility regardless of prior lease values', (() => {
    const t = buildTerminalWorkStateFields();
    return !matchesRecoverableWorkFilter({ workState: t.workState, workAvailableAtMs: t.workAvailableAt }, now);
  })());
}

// ============================================================================
// Fifth repair round — decideQueueOutcome: the SAME shared decision function
// acquireProcessingLease calls in reminderScheduler.ts. This is the direct fix for the
// orchestration-vs-test mismatch that let the fourth round's poisoning defect through:
// the fourth round's classifyWorkTuple tests were all correct, but acquireProcessingLease
// returned early on unrecognized/terminal status BEFORE ever consulting them. These tests
// exercise the exhaustive action set end to end, exactly matching scenarios A-J from the
// fifth repair round instructions. The sole invariant under test: for every tuple a
// due+queued discovery-query result could contain, the decided action must NOT be
// equivalent to "leave it unchanged and still due+queued."
// ============================================================================
console.log('\n=== decideQueueOutcome (fifth repair round: poisoning-defect fix) ===');
{
  const now = Date.now();
  const validSchema = validateReminderSchema(validReminderBase);
  const invalidSchema = validateReminderSchema({ ...validReminderBase, weekdaysAtClaim: [1, 1, 3] }); // duplicate -> invalid

  // A. unknown status, queued, past availability -> MUST permanently neutralize.
  check('A: unknown status + queued + past availability -> neutralize-unknown-status', decideQueueOutcome('garbage-status', 'queued', now - 1000, null, validSchema, now).action === 'neutralize-unknown-status');

  // B/C/D. recognized terminal status, queued, past availability -> MUST repair terminal queue metadata.
  check('B: dry-run-complete + queued + past availability -> repair-terminal-queue-state', decideQueueOutcome('dry-run-complete', 'queued', now - 1000, null, validSchema, now).action === 'repair-terminal-queue-state');
  check('C: cancelled + queued + past availability -> repair-terminal-queue-state', decideQueueOutcome('cancelled', 'queued', now - 1000, null, validSchema, now).action === 'repair-terminal-queue-state');
  check('D: invalid-reminder + queued + past availability -> repair-terminal-queue-state', decideQueueOutcome('invalid-reminder', 'queued', now - 1000, null, validSchema, now).action === 'repair-terminal-queue-state');

  // E. proper terminal (canonical tuple) -> harmless, no work, no write needed.
  check('E: terminal status + workState terminal + availability null -> already-terminal-correct', decideQueueOutcome('course-complete', 'terminal', null, null, validSchema, now).action === 'already-terminal-correct');

  // F. claimed, valid, due -> acquire.
  check('F: claimed valid due -> acquire', decideQueueOutcome('claimed', 'queued', now - 1, null, validSchema, now).action === 'acquire');

  // G. processing, valid, expired lease -> acquire/recover.
  check('G: processing valid expired lease -> acquire', decideQueueOutcome('processing', 'queued', now - 1, now - 1, validSchema, now).action === 'acquire');

  // H. processing, valid, live lease -> temporarily unavailable, not acquired, not poisoning.
  check('H: processing valid live lease -> still-leased (temporarily ineligible)', decideQueueOutcome('processing', 'queued', now + 60000, now + 60000, validSchema, now).action === 'still-leased');

  // I/J. claimed/processing with a known-status but malformed tuple -> quarantine.
  check('I: claimed known-status malformed tuple (invalid schema) -> quarantine-known-corruption', decideQueueOutcome('claimed', 'queued', now - 1, null, invalidSchema, now).action === 'quarantine-known-corruption');
  check('I: claimed known-status malformed tuple (bad tuple shape: lease present) -> quarantine-known-corruption', decideQueueOutcome('claimed', 'queued', now - 1, now + 1000, validSchema, now).action === 'quarantine-known-corruption');
  check('J: processing known-status malformed tuple (availability != lease) -> quarantine-known-corruption', decideQueueOutcome('processing', 'queued', now + 1000, now + 2000, validSchema, now).action === 'quarantine-known-corruption');
  check('J: processing known-status malformed tuple (invalid schema) -> quarantine-known-corruption', decideQueueOutcome('processing', 'queued', now - 1, now - 1, invalidSchema, now).action === 'quarantine-known-corruption');

  // The exhaustive invariant check: for every due+queued scenario, SIMULATE the write the
  // decided action actually performs (using the exact same pure payload builders
  // acquireProcessingLease calls) and confirm the resulting tuple no longer matches the
  // recoverable-work filter — i.e., the record is never left "unchanged and still due."
  // 'acquire' is exempt (the record WAS acted on -- its new workAvailableAt equals the
  // future leaseExpiresAt, correctly making it temporarily ineligible, not poisoned).
  // 'still-leased' is exempt by definition (reached only when the record's OWN
  // workAvailableAt is already in the future, i.e. it was never actually "due" under a
  // fresh read — see scenario H below, not included in this due-scenario list).
  const dueScenarios: Array<{ label: string; status: string; workState: unknown; availMs: number | null; leaseMs: number | null }> = [
    { label: 'A', status: 'garbage-status', workState: 'queued', availMs: now - 1000, leaseMs: null },
    { label: 'B', status: 'dry-run-complete', workState: 'queued', availMs: now - 1000, leaseMs: null },
    { label: 'C', status: 'cancelled', workState: 'queued', availMs: now - 1000, leaseMs: null },
    { label: 'D', status: 'invalid-reminder', workState: 'queued', availMs: now - 1000, leaseMs: null },
    { label: 'F', status: 'claimed', workState: 'queued', availMs: now - 1, leaseMs: null },
    { label: 'G', status: 'processing', workState: 'queued', availMs: now - 1, leaseMs: now - 1 },
    { label: 'I', status: 'claimed', workState: 'queued', availMs: now - 1, leaseMs: now + 1000 },
    { label: 'J', status: 'processing', workState: 'queued', availMs: now + 1000, leaseMs: now + 2000 },
  ];
  const stillPoisoned = dueScenarios.filter((s) => {
    const decision = decideQueueOutcome(s.status, s.workState, s.availMs, s.leaseMs, validSchema, now);
    let resultingWorkState: unknown;
    let resultingAvailMs: number | null;
    switch (decision.action) {
      case 'acquire':
        return false; // acted on; new workAvailableAt is the future lease, not "unchanged."
      case 'neutralize-unknown-status': {
        const u = buildUnknownStatusNeutralizationUpdate(s.status);
        resultingWorkState = u.workState;
        resultingAvailMs = u.workAvailableAt;
        break;
      }
      case 'repair-terminal-queue-state': {
        const t = buildTerminalWorkStateFields();
        resultingWorkState = t.workState;
        resultingAvailMs = t.workAvailableAt;
        break;
      }
      case 'quarantine-known-corruption': {
        const q = buildQuarantineUpdate(decision.reason);
        resultingWorkState = q.workState;
        resultingAvailMs = q.workAvailableAt;
        break;
      }
      default:
        // 'still-leased' / 'already-terminal-correct' should not be reachable for any
        // scenario in this due-scenario list; if one were, that itself is the bug this
        // test exists to catch, so fall through to the still-matches check below using
        // the UNCHANGED input tuple.
        resultingWorkState = s.workState;
        resultingAvailMs = s.availMs;
    }
    return matchesRecoverableWorkFilter({ workState: resultingWorkState, workAvailableAtMs: resultingAvailMs }, now);
  });
  check('exhaustive invariant: simulating the actual write for every due scenario (A/B/C/D/F/G/I/J) always removes it from the queue', stillPoisoned.length === 0);
}

// ============================================================================
// buildUnknownStatusNeutralizationUpdate — the isolated corruption-repair payload for
// BLOCKER 1. Deliberately produces a canonical invalid-reminder/terminal record so there
// is exactly one source of truth for "is this queued" afterward.
// ============================================================================
console.log('\n=== buildUnknownStatusNeutralizationUpdate ===');
{
  const u = buildUnknownStatusNeutralizationUpdate('garbage-status');
  check('neutralization forces status to invalid-reminder', u.status === 'invalid-reminder');
  check('neutralization sets workState terminal', u.workState === 'terminal');
  check('neutralization clears workAvailableAt', u.workAvailableAt === null);
  check('neutralization clears leaseExpiresAt', u.leaseExpiresAt === null);
  check('neutralization records the reason', u.invalidReminderReason === 'unknown-status');
  check('neutralization preserves the original corrupt status value for diagnostics', u.originalCorruptStatus === 'garbage-status');
  check('the post-neutralization tuple is itself consistent under classifyWorkTuple', classifyWorkTuple(u.status, u.workState, u.workAvailableAt, u.leaseExpiresAt, Date.now()).consistent === true);
}

// ============================================================================
// Recovery / lease duration.
// ============================================================================
console.log('\n=== Lease duration ===');
{
  const now = Date.now();
  check('lease expiry is exactly PROCESSING_LEASE_DURATION_MS out', computeLeaseExpiresAtMs(now) === now + PROCESSING_LEASE_DURATION_MS);
}

// ============================================================================
// Consent + schedule revalidation (timezone-after-claim) — unchanged from round 2,
// re-verified against this round's rewritten module.
// ============================================================================
console.log('\n=== Consent + schedule revalidation (timezone-after-claim) ===');
const claimSchedule: ScheduleSnapshot = { scheduleType: 'weekdays', weekdays: [1, 3, 5], localTime: '07:00', timezone: 'America/Chicago' };
check('same revision, same schedule -> proceed', revalidateConsent(3, claimSchedule, { exists: true, enabled: true, revision: 3, schedule: claimSchedule }).outcome === 'proceed');
check('same revision, timezone changed only -> cancel (timezone-changed-after-claim)', (() => {
  const r = revalidateConsent(3, claimSchedule, { exists: true, enabled: true, revision: 3, schedule: { ...claimSchedule, timezone: 'America/New_York' } });
  return r.outcome === 'cancelled' && r.reason === 'timezone-changed-after-claim';
})());
check('same revision, equivalent (reordered) weekdays -> proceed', revalidateConsent(3, claimSchedule, { exists: true, enabled: true, revision: 3, schedule: { ...claimSchedule, weekdays: [5, 1, 3] } }).outcome === 'proceed');
check('weekdays actually changed -> cancel', (() => {
  const r = revalidateConsent(3, claimSchedule, { exists: true, enabled: true, revision: 3, schedule: { ...claimSchedule, weekdays: [1, 3] } });
  return r.outcome === 'cancelled' && r.reason === 'schedule-changed-after-claim';
})());
check('localTime changed -> cancel', (() => {
  const r = revalidateConsent(3, claimSchedule, { exists: true, enabled: true, revision: 3, schedule: { ...claimSchedule, localTime: '08:00' } });
  return r.outcome === 'cancelled' && r.reason === 'schedule-changed-after-claim';
})());
check('revision changed (explicit save) -> cancel', (() => {
  const r = revalidateConsent(3, claimSchedule, { exists: true, enabled: true, revision: 4, schedule: claimSchedule });
  return r.outcome === 'cancelled' && r.reason === 'schedule-changed-after-claim';
})());
check('disabled after claim -> cancel', (() => {
  const r = revalidateConsent(3, claimSchedule, { exists: true, enabled: false, revision: 3, schedule: claimSchedule });
  return r.outcome === 'cancelled' && r.reason === 'disabled-after-claim';
})());
check('preference missing after claim -> cancel', revalidateConsent(3, claimSchedule, { exists: false }).outcome === 'cancelled');

// ============================================================================
// Progress classification (unchanged).
// ============================================================================
console.log('\n=== Progress classification ===');
check('missing userData -> Day 1', classifyProgress(undefined).kind === 'ok' && (classifyProgress(undefined) as { currentDay: number }).currentDay === 1);
check('empty userData (no dnsCourse) -> Day 1', classifyProgress({}).kind === 'ok');
check('dnsCourse null -> Day 1', classifyProgress({ dnsCourse: null }).kind === 'ok');
check('dnsCourse present, currentDay missing -> invalid', classifyProgress({ dnsCourse: {} }).kind === 'invalid');
check('currentDay string -> invalid', classifyProgress({ dnsCourse: { currentDay: '14' } }).kind === 'invalid');
check('currentDay fractional -> invalid', classifyProgress({ dnsCourse: { currentDay: 14.5 } }).kind === 'invalid');
check('currentDay 0 -> invalid', classifyProgress({ dnsCourse: { currentDay: 0 } }).kind === 'invalid');
check('currentDay 1 -> ok, Day 1', (() => { const r = classifyProgress({ dnsCourse: { currentDay: 1 } }); return r.kind === 'ok' && r.currentDay === 1; })());
check('currentDay 84 -> ok, not complete', (() => { const r = classifyProgress({ dnsCourse: { currentDay: 84 } }); return r.kind === 'ok' && !r.courseComplete; })());
check('currentDay 85 -> ok, course complete', (() => { const r = classifyProgress({ dnsCourse: { currentDay: 85 } }); return r.kind === 'ok' && r.courseComplete; })());
check('currentDay 86 -> invalid', classifyProgress({ dnsCourse: { currentDay: 86 } }).kind === 'invalid');
check('corrupted established dnsCourse (non-object) -> invalid', classifyProgress({ dnsCourse: 'garbage' }).kind === 'invalid');
check('TOTAL_DNS_COURSE_DAYS is 84, COURSE_COMPLETE_DAY is 85', TOTAL_DNS_COURSE_DAYS === 84 && COURSE_COMPLETE_DAY === 85);

// ============================================================================
// Status transitions (includes invalid-reminder).
// ============================================================================
console.log('\n=== Status transitions ===');
check('claimed -> processing allowed', isAllowedTransition('claimed', 'processing'));
check('claimed -> invalid-reminder allowed (malformed-record quarantine)', isAllowedTransition('claimed', 'invalid-reminder'));
check('claimed -> dry-run-complete NOT allowed (must go through processing)', !isAllowedTransition('claimed', 'dry-run-complete'));
check('processing -> dry-run-complete allowed', isAllowedTransition('processing', 'dry-run-complete'));
check('processing -> cancelled allowed', isAllowedTransition('processing', 'cancelled'));
check('processing -> invalid-progress allowed', isAllowedTransition('processing', 'invalid-progress'));
check('processing -> course-complete allowed', isAllowedTransition('processing', 'course-complete'));
check('processing -> invalid-reminder allowed', isAllowedTransition('processing', 'invalid-reminder'));
check('processing -> processing allowed (lease re-acquisition)', isAllowedTransition('processing', 'processing'));
check('invalid-reminder -> anything NOT allowed (terminal)', !isAllowedTransition('invalid-reminder', 'processing'));
check('dry-run-complete -> anything NOT allowed (terminal)', !isAllowedTransition('dry-run-complete', 'processing'));
check('invalid-reminder is terminal', isTerminalStatus('invalid-reminder'));
check('claimed is NOT terminal', !isTerminalStatus('claimed'));
check('requireAllowedTransition does not throw for a valid transition', (() => { try { requireAllowedTransition('claimed', 'processing'); return true; } catch { return false; } })());
check('requireAllowedTransition throws for an invalid transition', (() => { try { requireAllowedTransition('dry-run-complete', 'processing'); return false; } catch { return true; } })());

// ============================================================================
// Phase 3A-3 Step 3C-2 Codex repair round (L1) — 'delivery-fanned-out' recognized by the
// shared status/work-state model, for the not-yet-deployed Firestore delivery worker
// (reminderDeliveryWorker.ts). This section proves: (1) the new status is a real member of
// REMINDER_STATUSES; (2) it maps to workState 'terminal'; (3) exactly the one legal
// transition (processing -> delivery-fanned-out) exists, with zero legal outgoing
// transitions from it; (4) Step 2's own queue-poisoning defense (decideQueueOutcome)
// correctly REPAIRS a hypothetically-corrupted, queue-visible 'delivery-fanned-out' parent
// instead of misclassifying it as an unrecognized status.
console.log("\n=== 'delivery-fanned-out' status recognition (Step 3C-2 Codex repair, L1) ===");
check("REMINDER_STATUSES includes 'delivery-fanned-out'", (REMINDER_STATUSES as readonly string[]).includes('delivery-fanned-out'));
check("expectedWorkStateForStatus('delivery-fanned-out') -> terminal", expectedWorkStateForStatus('delivery-fanned-out') === 'terminal');
check("isTerminalStatus('delivery-fanned-out') is true", isTerminalStatus('delivery-fanned-out'));
check("processing -> delivery-fanned-out allowed", isAllowedTransition('processing', 'delivery-fanned-out'));
check(
  "delivery-fanned-out has ZERO legal outgoing transitions (to any recognized status)",
  REMINDER_STATUSES.every((to) => !isAllowedTransition('delivery-fanned-out', to))
);
check(
  "no OTHER recognized status may transition directly to delivery-fanned-out (processing is the sole legal source)",
  REMINDER_STATUSES.filter((s) => s !== 'processing').every((from) => !isAllowedTransition(from, 'delivery-fanned-out'))
);
check(
  "requireAllowedTransition does not throw for processing -> delivery-fanned-out",
  (() => {
    try {
      requireAllowedTransition('processing', 'delivery-fanned-out');
      return true;
    } catch {
      return false;
    }
  })()
);
{
  const now = Date.now();
  const validSchema = validateReminderSchema(validReminderBase);
  // A queue-visible, corrupted 'delivery-fanned-out' parent (workState still 'queued',
  // exactly the poisoning shape Step 2's fifth repair round exists to defend against) must
  // be REPAIRED (queue fields only, status/business outcome untouched) — the same
  // treatment every other recognized terminal status already receives — never
  // misclassified as an unrecognized status.
  check(
    "decideQueueOutcome('delivery-fanned-out', 'queued', past, null) -> repair-terminal-queue-state (not neutralize-unknown-status)",
    decideQueueOutcome('delivery-fanned-out', 'queued', now - 1000, null, validSchema, now).action === 'repair-terminal-queue-state'
  );
  check(
    "decideQueueOutcome('delivery-fanned-out', 'terminal', null, null) -> already-terminal-correct",
    decideQueueOutcome('delivery-fanned-out', 'terminal', null, null, validSchema, now).action === 'already-terminal-correct'
  );
}

// ============================================================================
// Bounded concurrency worker pool (unchanged).
// ============================================================================
console.log('\n=== Bounded concurrency ===');
async function runConcurrencyTests(): Promise<void> {
  {
    let maxInFlight = 0;
    let current = 0;
    const items = Array.from({ length: 23 }, (_, i) => i);
    await processWithBoundedConcurrency(items, 5, async () => {
      current++;
      maxInFlight = Math.max(maxInFlight, current);
      await new Promise((resolve) => setTimeout(resolve, 1));
      current--;
    });
    check('never exceeds the configured concurrency limit', maxInFlight <= 5, `observed max in-flight: ${maxInFlight}`);
  }
  {
    const processed: number[] = [];
    const items = Array.from({ length: 17 }, (_, i) => i);
    await processWithBoundedConcurrency(items, 4, async (item) => {
      processed.push(item);
    });
    check('every item processed exactly once', processed.length === 17 && new Set(processed).size === 17);
  }
  {
    let ran = 0;
    await processWithBoundedConcurrency([], 5, async () => {
      ran++;
    });
    check('empty batch: no crash, worker never invoked', ran === 0);
  }
}

runConcurrencyTests()
  .then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail > 0) process.exit(1);
  })
  .catch((err) => {
    console.error('FATAL ERROR running concurrency tests:', err);
    process.exit(1);
  });
