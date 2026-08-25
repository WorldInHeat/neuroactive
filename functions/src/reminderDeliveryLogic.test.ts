// functions/src/reminderDeliveryLogic.test.ts
// Phase 3A-3 Step 3C-1 — repository-local test file for the pure delivery-state-machine
// logic. Same established pattern as reminderSchedulerLogic.test.ts/
// pushInstallationEpochLogic.test.ts/fcmTransport.test.ts: this repo has no test runner
// configured, so this is a small, dependency-free, self-contained assertion script.
//
// CODEX REPAIR ROUND (runtime fail-closed hardening): rewritten alongside
// reminderDeliveryLogic.ts's move to accepting `unknown` at nearly every exported
// boundary. This file's job is now largely adversarial: prove that a malformed/
// fabricated runtime value — never merely a wrong TypeScript type — can never authorize
// a retry, a send, a fanout, or a fourth attempt.
//
// HOW TO RUN:
//   cd functions
//   npm run build
//   node lib/reminderDeliveryLogic.test.js
import {
  DELIVERY_STATES,
  isTerminalDeliveryState,
  isAllowedDeliveryTransition,
  requireAllowedDeliveryTransition,
  expectedWorkStateForDeliveryState,
  classifyDeliveryWorkTuple,
  computeDeliveryLeaseExpiresAtMs,
  validateDeliverySchema,
  decideDeliveryQueueOutcome,
  buildDeliveryTerminalWorkStateFields,
  buildDeliveryQuarantineUpdate,
  buildUnknownDeliveryStateNeutralizationUpdate,
  MAX_SEND_ATTEMPTS,
  canAuthorizeNewSendIntent,
  isValidSendAttemptCountAfterAttempt,
  decideSendOutcomeAction,
  isAuthorizedRetryTransition,
  requireAuthorizedRetryTransition,
  isValidAttemptHistoryEntry,
  validateAttemptHistory,
  appendAttemptHistoryEntry,
  parseRolloutConfig,
  decideShouldFanOut,
  decideRealSendAuthorization,
  deriveDeliveryPublicId,
  isValidInstallationIdShape,
  isValidReminderId,
  isValidFirestoreDocumentId,
  FIRESTORE_DOCUMENT_ID_MAX_BYTES,
  isValidEpochMs,
  FANOUT_NONCE_BYTE_LENGTH,
  MAX_TARGET_INSTALLATIONS,
  FANOUT_QUERY_LIMIT,
  decideFanoutOutcome,
  buildPreExistingChildCorruptionOutcome,
  validateFanoutTuple,
  OPAQUE_ID_BYTE_LENGTH,
  OPAQUE_ID_LENGTH,
  isValidOpaqueIdFormat,
  validatePersistedDeliveryForProcessing,
  type DeliverySchemaCheck,
  type AttemptHistoryEntry,
  type TargetSnapshot,
  type DeliverySendOutcomeKind,
  // Step 3C-4 additions
  decideStagedRealSendAuthorization,
  buildDeliverySendingIntentFields,
  isMatchingActiveSendIntent,
  computeDeliveryRetryAvailableAtMs,
  DELIVERY_RETRY_BACKOFF_MS,
  type RealDeliveryStage,
} from './reminderDeliveryLogic';

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

function throws(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const VALID_SNAPSHOT: TargetSnapshot = { generation: 1, tokenVersion: 1, installationAudienceId: 'aud-abc123' };
const VALID_INSTALLATION_ID = 'a1b2c3d4-e5f6-4789-8abc-def012345678'; // well-formed UUID v4 shape.

function validSchemaData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 'uid-1',
    installationId: VALID_INSTALLATION_ID,
    sendAttemptCount: 0,
    processingAttemptCount: 0,
    targetSnapshot: VALID_SNAPSHOT,
    ...overrides,
  };
}

function validSchemaCheck(overrides: Record<string, unknown> = {}): DeliverySchemaCheck {
  const check = validateDeliverySchema(validSchemaData(overrides));
  if (!check.valid) throw new Error('test setup: expected valid schema');
  return check;
}

// A representative set of adversarial "not a valid count" runtime values, reused across
// several sections below.
const MALFORMED_COUNT_VALUES: unknown[] = [-1, NaN, Infinity, -Infinity, 0.5, '2', null, undefined, true, {}, [], Number.MAX_SAFE_INTEGER + 10];

// =========================================================================
// 1. Delivery states / transition table.
// =========================================================================
console.log('=== delivery states and transition table ===');

check('exactly nine delivery states', DELIVERY_STATES.length === 9);
check(
  'terminal states are exactly the six terminal states',
  ['accepted-by-fcm', 'rejected-final', 'unknown-outcome', 'cancelled', 'dry-run-validated', 'invalid-delivery'].every(isTerminalDeliveryState) &&
    !isTerminalDeliveryState('queued') &&
    !isTerminalDeliveryState('preparing') &&
    !isTerminalDeliveryState('sending')
);

check('queued -> preparing allowed', isAllowedDeliveryTransition('queued', 'preparing'));
check('queued -> invalid-delivery allowed', isAllowedDeliveryTransition('queued', 'invalid-delivery'));
check('queued -> sending NOT allowed (must go through preparing)', !isAllowedDeliveryTransition('queued', 'sending'));
check('preparing -> sending allowed', isAllowedDeliveryTransition('preparing', 'sending'));
check('preparing -> dry-run-validated allowed', isAllowedDeliveryTransition('preparing', 'dry-run-validated'));
check('preparing -> cancelled allowed', isAllowedDeliveryTransition('preparing', 'cancelled'));
check('preparing -> invalid-delivery allowed', isAllowedDeliveryTransition('preparing', 'invalid-delivery'));
check('sending -> accepted-by-fcm allowed', isAllowedDeliveryTransition('sending', 'accepted-by-fcm'));
check('sending -> rejected-final allowed', isAllowedDeliveryTransition('sending', 'rejected-final'));
check('sending -> unknown-outcome allowed', isAllowedDeliveryTransition('sending', 'unknown-outcome'));
check(
  "[3C-4 CODEX REPAIR ROUND] sending -> invalid-delivery is NOT allowed (an earlier round of this repair added it, reasoning it was a safe quarantine of data this worker owns; Codex correctly rejected that — once 'sending' is committed, an FCM request may already have occurred, and rewriting the record to 'invalid-delivery' would erase that durable fact. A post-send persistence failure must instead leave the document in 'sending' untouched — see reminderDeliverySender.ts's commitSendOutcome, which performs zero Firestore mutation on that path)",
  !isAllowedDeliveryTransition('sending', 'invalid-delivery') && throws(() => requireAllowedDeliveryTransition('sending', 'invalid-delivery'))
);
check('[3C-4] sending -> cancelled is NOT allowed (only preparing may cancel)', !isAllowedDeliveryTransition('sending', 'cancelled'));
check('[3C-4] sending -> dry-run-validated is NOT allowed', !isAllowedDeliveryTransition('sending', 'dry-run-validated'));
check('[3C-4] sending has EXACTLY the three original Step 3C-1 outgoing transitions — no more, no fewer', (() => {
  const ALL_STATES = ['queued', 'preparing', 'sending', 'accepted-by-fcm', 'rejected-final', 'unknown-outcome', 'cancelled', 'dry-run-validated', 'invalid-delivery'];
  const allowedFromSending = ALL_STATES.filter((s) => isAllowedDeliveryTransition('sending', s));
  return JSON.stringify(allowedFromSending.sort()) === JSON.stringify(['accepted-by-fcm', 'rejected-final', 'unknown-outcome'].sort());
})());
check(
  '[3] CRITICAL: sending -> queued is NOT generically authorized (the retry bypass) — requireAllowedDeliveryTransition must throw',
  !isAllowedDeliveryTransition('sending', 'queued') && throws(() => requireAllowedDeliveryTransition('sending', 'queued'))
);

for (const terminal of ['accepted-by-fcm', 'rejected-final', 'unknown-outcome', 'cancelled', 'dry-run-validated', 'invalid-delivery'] as const) {
  check(`[2] ${terminal} has ZERO outgoing transitions (cannot requeue)`, !isAllowedDeliveryTransition(terminal, 'queued') && !isAllowedDeliveryTransition(terminal, 'preparing'));
  for (const target of DELIVERY_STATES) {
    if (target === terminal) continue;
    check(`[2] ${terminal} -> ${target} is never allowed`, !isAllowedDeliveryTransition(terminal, target));
  }
}

check('requireAllowedDeliveryTransition does not throw for a legal transition', !throws(() => requireAllowedDeliveryTransition('queued', 'preparing')));
check('requireAllowedDeliveryTransition throws for an illegal transition', throws(() => requireAllowedDeliveryTransition('accepted-by-fcm', 'queued')));
check('requireAllowedDeliveryTransition throws for an unrecognized state', throws(() => requireAllowedDeliveryTransition('bogus', 'queued')));

// =========================================================================
// [3] The protected retry-transition helper — the ONLY authorization surface for
// sending -> queued.
// =========================================================================
console.log('\n=== isAuthorizedRetryTransition / requireAuthorizedRetryTransition ===');

const RETRYABLE: DeliverySendOutcomeKind = { kind: 'rejected', category: 'retryable-later' };
const ACCEPTED: DeliverySendOutcomeKind = { kind: 'accepted' };
const UNAUTHENTICATED: DeliverySendOutcomeKind = { kind: 'rejected', category: 'unauthenticated' };
const UNKNOWN_OUTCOME: DeliverySendOutcomeKind = { kind: 'unknown-outcome' };

check('[3] sending + retryable-later + count=1 -> authorized', isAuthorizedRetryTransition('sending', RETRYABLE, 1));
check('[3] sending + retryable-later + count=2 -> authorized', isAuthorizedRetryTransition('sending', RETRYABLE, 2));
check('[3] sending + retryable-later + count=3 (exhausted) -> NOT authorized', !isAuthorizedRetryTransition('sending', RETRYABLE, 3));
check('[3] sending + accepted -> NOT authorized', !isAuthorizedRetryTransition('sending', ACCEPTED, 1));
check('[3] sending + unauthenticated -> NOT authorized', !isAuthorizedRetryTransition('sending', UNAUTHENTICATED, 1));
check('[3] sending + unknown-outcome -> NOT authorized', !isAuthorizedRetryTransition('sending', UNKNOWN_OUTCOME, 1));
check('[3] NOT currentState="sending" (e.g. "preparing") -> NEVER authorized, even with a retryable-later outcome', !isAuthorizedRetryTransition('preparing', RETRYABLE, 1));
check('[3] currentState="queued" -> NEVER authorized', !isAuthorizedRetryTransition('queued', RETRYABLE, 1));
check('[3] malformed sendAttemptCount -> NEVER authorized', MALFORMED_COUNT_VALUES.every((v) => !isAuthorizedRetryTransition('sending', RETRYABLE, v)));
check('requireAuthorizedRetryTransition does not throw when authorized', !throws(() => requireAuthorizedRetryTransition('sending', RETRYABLE, 1)));
check('requireAuthorizedRetryTransition throws when not authorized', throws(() => requireAuthorizedRetryTransition('sending', ACCEPTED, 1)));

// =========================================================================
// Work-state model.
// =========================================================================
console.log('\n=== work-state model ===');

check("queued -> expected workState 'queued'", expectedWorkStateForDeliveryState('queued') === 'queued');
check("preparing -> expected workState 'queued'", expectedWorkStateForDeliveryState('preparing') === 'queued');
check("sending -> expected workState 'terminal' (immediately, at commit, despite having real outgoing transitions)", expectedWorkStateForDeliveryState('sending') === 'terminal');
for (const terminal of ['accepted-by-fcm', 'rejected-final', 'unknown-outcome', 'cancelled', 'dry-run-validated', 'invalid-delivery']) {
  check(`${terminal} -> expected workState 'terminal'`, expectedWorkStateForDeliveryState(terminal) === 'terminal');
}
check('unrecognized state -> expected workState null', expectedWorkStateForDeliveryState('bogus') === null);

console.log('\n=== isValidEpochMs ===');
check('0 is valid', isValidEpochMs(0));
check('a real epoch ms value is valid', isValidEpochMs(1_700_000_000_000));
check('negative is invalid', !isValidEpochMs(-1));
check('NaN is invalid', !isValidEpochMs(NaN));
check('Infinity is invalid', !isValidEpochMs(Infinity));
check('fractional is invalid', !isValidEpochMs(1.5));
check('string is invalid', !isValidEpochMs('1000'));
check('null is invalid', !isValidEpochMs(null));

console.log('\n=== computeDeliveryLeaseExpiresAtMs ===');
check('computeDeliveryLeaseExpiresAtMs adds the 5-minute lease duration', computeDeliveryLeaseExpiresAtMs(1000) === 1000 + 5 * 60 * 1000);
check('[11] malformed nowMs (negative) fails closed (throws)', throws(() => computeDeliveryLeaseExpiresAtMs(-1)));
check('[11] malformed nowMs (NaN) fails closed (throws)', throws(() => computeDeliveryLeaseExpiresAtMs(NaN)));
check('[11] malformed nowMs (string) fails closed (throws)', throws(() => computeDeliveryLeaseExpiresAtMs('now' as unknown as number)));
check('[11] malformed nowMs (null) fails closed (throws)', throws(() => computeDeliveryLeaseExpiresAtMs(null as unknown as number)));

console.log('\n=== classifyDeliveryWorkTuple ===');
check('queued, consistent, due now -> recoverable', (() => {
  const r = classifyDeliveryWorkTuple('queued', 'queued', 1000, null, 2000);
  return r.consistent && r.recoverableNow === true;
})());
check('queued, consistent, due in future -> not recoverable', (() => {
  const r = classifyDeliveryWorkTuple('queued', 'queued', 5000, null, 2000);
  return r.consistent && r.recoverableNow === false;
})());
check('queued with a lease present -> inconsistent', !classifyDeliveryWorkTuple('queued', 'queued', 1000, 1000, 2000).consistent);
check('preparing, live lease -> not recoverable yet', (() => {
  const r = classifyDeliveryWorkTuple('preparing', 'queued', 5000, 5000, 2000);
  return r.consistent && r.recoverableNow === false;
})());
check('preparing, expired lease -> recoverable', (() => {
  const r = classifyDeliveryWorkTuple('preparing', 'queued', 1000, 1000, 2000);
  return r.consistent && r.recoverableNow === true;
})());
check('preparing missing lease -> inconsistent', !classifyDeliveryWorkTuple('preparing', 'queued', 1000, null, 2000).consistent);
check('preparing with workAvailableAt != leaseExpiresAt -> inconsistent', !classifyDeliveryWorkTuple('preparing', 'queued', 1000, 2000, 2000).consistent);
check('terminal state, canonical (null/null) -> consistent, never recoverable', (() => {
  const r = classifyDeliveryWorkTuple('accepted-by-fcm', 'terminal', null, null, 2000);
  return r.consistent && r.recoverableNow === false;
})());
check('terminal state with stale nonnull workAvailableAt -> inconsistent', !classifyDeliveryWorkTuple('accepted-by-fcm', 'terminal', 1000, null, 2000).consistent);
check('unrecognized state -> inconsistent', !classifyDeliveryWorkTuple('bogus', 'queued', 1000, null, 2000).consistent);
check('invalid workState string -> inconsistent', !classifyDeliveryWorkTuple('queued', 'bogus', 1000, null, 2000).consistent);

check('[11] malformed nowMs -> inconsistent, never accidentally recoverable', !classifyDeliveryWorkTuple('queued', 'queued', 1000, null, NaN).consistent);
check('[11] malformed nowMs (negative) -> inconsistent', !classifyDeliveryWorkTuple('queued', 'queued', 1000, null, -5).consistent);
check('[11] malformed workAvailableAtMs (string) -> inconsistent', !classifyDeliveryWorkTuple('queued', 'queued', '1000' as unknown as number, null, 2000).consistent);
check('[11] malformed workAvailableAtMs (Infinity) -> inconsistent', !classifyDeliveryWorkTuple('queued', 'queued', Infinity, null, 2000).consistent);
check('[11] malformed leaseExpiresAtMs (fractional) -> inconsistent', !classifyDeliveryWorkTuple('preparing', 'queued', 1000, 1000.5, 2000).consistent);

// Regression coverage for a real bug caught during the initial implementation round:
// `sending` has real outgoing transitions (not isTerminalDeliveryState), but its
// expected work state is 'terminal' immediately upon commit.
check('canonical sending (workState terminal, null/null) -> already-terminal-correct', (() => {
  const r = decideDeliveryQueueOutcome('sending', 'terminal', null, null, validSchemaCheck(), 2000);
  return r.action === 'already-terminal-correct';
})());
check(
  'CRITICAL: a `sending` record with a CORRUPTED, still-queue-visible tuple (workState=queued, due) -> repair-terminal-queue-state, NEVER still-leased/acquire (a stranded sending record must never be reclaimed for send)',
  decideDeliveryQueueOutcome('sending', 'queued', 1000, null, validSchemaCheck(), 2000).action === 'repair-terminal-queue-state'
);
check('sending with a corrupted queue-visible tuple that is NOT yet due -> STILL repair-terminal-queue-state, never still-leased (workState alone, not availability, decides this)', (() => {
  const r = decideDeliveryQueueOutcome('sending', 'queued', 5000, null, validSchemaCheck(), 2000);
  return r.action === 'repair-terminal-queue-state';
})());
check('classifyDeliveryWorkTuple("sending", canonical terminal shape) -> consistent, never recoverable', (() => {
  const r = classifyDeliveryWorkTuple('sending', 'terminal', null, null, 2000);
  return r.consistent && r.recoverableNow === false;
})());

// =========================================================================
// Delivery schema validation.
// =========================================================================
console.log('\n=== validateDeliverySchema ===');

check('fully valid schema -> valid', validateDeliverySchema(validSchemaData()).valid === true);
check('invalid uid (contains slash) -> invalid', validateDeliverySchema(validSchemaData({ uid: 'a/b' })).valid === false);
check('invalid installationId (empty) -> invalid', validateDeliverySchema(validSchemaData({ installationId: '' })).valid === false);
check('sendAttemptCount negative -> invalid', validateDeliverySchema(validSchemaData({ sendAttemptCount: -1 })).valid === false);
check(`sendAttemptCount > MAX_SEND_ATTEMPTS (${MAX_SEND_ATTEMPTS}) -> invalid`, validateDeliverySchema(validSchemaData({ sendAttemptCount: MAX_SEND_ATTEMPTS + 1 })).valid === false);
check(`sendAttemptCount === MAX_SEND_ATTEMPTS (${MAX_SEND_ATTEMPTS}) -> valid (boundary)`, validateDeliverySchema(validSchemaData({ sendAttemptCount: MAX_SEND_ATTEMPTS })).valid === true);
check('processingAttemptCount non-integer -> invalid', validateDeliverySchema(validSchemaData({ processingAttemptCount: 1.5 })).valid === false);
check('missing targetSnapshot -> invalid', validateDeliverySchema(validSchemaData({ targetSnapshot: undefined })).valid === false);
check('targetSnapshot.generation < 1 -> invalid', validateDeliverySchema(validSchemaData({ targetSnapshot: { ...VALID_SNAPSHOT, generation: 0 } })).valid === false);
check('targetSnapshot.tokenVersion < 1 -> invalid', validateDeliverySchema(validSchemaData({ targetSnapshot: { ...VALID_SNAPSHOT, tokenVersion: 0 } })).valid === false);
check('targetSnapshot.installationAudienceId empty -> invalid', validateDeliverySchema(validSchemaData({ targetSnapshot: { ...VALID_SNAPSHOT, installationAudienceId: '' } })).valid === false);

// =========================================================================
// Malformed queue tuples / terminal repair / still-leased.
// =========================================================================
console.log('\n=== decideDeliveryQueueOutcome (malformed-work handling) ===');

check('unrecognized state -> neutralize-unknown-state, regardless of tuple', (() => {
  const r = decideDeliveryQueueOutcome('bogus', 'queued', 1000, null, validSchemaCheck(), 2000);
  return r.action === 'neutralize-unknown-state';
})());
check('recognized terminal state with corrupt (still-queued) tuple -> repair-terminal-queue-state', (() => {
  const r = decideDeliveryQueueOutcome('accepted-by-fcm', 'queued', 1000, null, validSchemaCheck(), 2000);
  return r.action === 'repair-terminal-queue-state';
})());
check('recognized terminal state already canonical -> already-terminal-correct', (() => {
  const r = decideDeliveryQueueOutcome('accepted-by-fcm', 'terminal', null, null, validSchemaCheck(), 2000);
  return r.action === 'already-terminal-correct';
})());
check('queued/preparing with invalid schema -> quarantine-known-corruption', (() => {
  const invalidSchema = validateDeliverySchema(validSchemaData({ uid: '' }));
  const r = decideDeliveryQueueOutcome('queued', 'queued', 1000, null, invalidSchema, 2000);
  return r.action === 'quarantine-known-corruption';
})());
check('queued/preparing with inconsistent work tuple (valid schema) -> quarantine-known-corruption', (() => {
  const r = decideDeliveryQueueOutcome('preparing', 'queued', 1000, null, validSchemaCheck(), 2000); // preparing missing lease
  return r.action === 'quarantine-known-corruption';
})());
check('valid still-leased preparing -> still-leased', (() => {
  const r = decideDeliveryQueueOutcome('preparing', 'queued', 5000, 5000, validSchemaCheck(), 2000);
  return r.action === 'still-leased';
})());
check('valid, due queued -> acquire', (() => {
  const r = decideDeliveryQueueOutcome('queued', 'queued', 1000, null, validSchemaCheck(), 2000);
  return r.action === 'acquire';
})());
check('valid, due preparing (expired lease) -> acquire', (() => {
  const r = decideDeliveryQueueOutcome('preparing', 'queued', 1000, 1000, validSchemaCheck(), 2000);
  return r.action === 'acquire';
})());
check('buildDeliveryTerminalWorkStateFields shape', (() => {
  const f = buildDeliveryTerminalWorkStateFields();
  return f.workState === 'terminal' && f.workAvailableAt === null && f.leaseExpiresAt === null;
})());
check('buildDeliveryQuarantineUpdate shape', (() => {
  const u = buildDeliveryQuarantineUpdate('some-reason');
  return u.state === 'invalid-delivery' && u.workState === 'terminal' && u.invalidDeliveryReason === 'some-reason';
})());
check('buildUnknownDeliveryStateNeutralizationUpdate preserves the original corrupt state', (() => {
  const u = buildUnknownDeliveryStateNeutralizationUpdate('totally-bogus');
  return u.state === 'invalid-delivery' && u.originalCorruptState === 'totally-bogus' && u.invalidDeliveryReason === 'unknown-state';
})());

// =========================================================================
// [1] Send-attempt authorization — malformed counts must fail closed.
// =========================================================================
console.log('\n=== canAuthorizeNewSendIntent (runtime fail-closed hardening) ===');

check(`MAX_SEND_ATTEMPTS is exactly 3`, MAX_SEND_ATTEMPTS === 3);
check('0 < 3 -> may authorize', canAuthorizeNewSendIntent(0) === true);
check('1 < 3 -> may authorize', canAuthorizeNewSendIntent(1) === true);
check('2 < 3 -> may authorize', canAuthorizeNewSendIntent(2) === true);
check('3 >= 3 -> may NOT authorize a fourth send intent', canAuthorizeNewSendIntent(3) === false);
check('4 >= 3 -> may NOT authorize', canAuthorizeNewSendIntent(4) === false);

for (const bad of MALFORMED_COUNT_VALUES) {
  check(`[1] canAuthorizeNewSendIntent(${JSON.stringify(bad)}) -> false (never authorizes)`, canAuthorizeNewSendIntent(bad) === false);
}
check('[1] canAuthorizeNewSendIntent(Number.MAX_SAFE_INTEGER) -> false', canAuthorizeNewSendIntent(Number.MAX_SAFE_INTEGER) === false);

console.log('\n=== isValidSendAttemptCountAfterAttempt ===');
check('1 is valid', isValidSendAttemptCountAfterAttempt(1));
check('2 is valid', isValidSendAttemptCountAfterAttempt(2));
check('3 is valid', isValidSendAttemptCountAfterAttempt(3));
check('0 is invalid (at least one attempt must already exist)', !isValidSendAttemptCountAfterAttempt(0));
check('4 is invalid (exceeds MAX_SEND_ATTEMPTS)', !isValidSendAttemptCountAfterAttempt(4));
for (const bad of MALFORMED_COUNT_VALUES) {
  check(`isValidSendAttemptCountAfterAttempt(${JSON.stringify(bad)}) -> false`, !isValidSendAttemptCountAfterAttempt(bad));
}

// =========================================================================
// [1/2] Send-outcome decision — the central duplicate-avoidance invariant, including
// malformed-count fail-closed behavior.
// =========================================================================
console.log('\n=== decideSendOutcomeAction ===');

check('accepted -> terminalize accepted-by-fcm', (() => {
  const d = decideSendOutcomeAction({ kind: 'accepted' }, 1);
  return d.action === 'terminalize' && d.state === 'accepted-by-fcm';
})());

check('[2] retryable-later, count=1 -> requeue-retry', decideSendOutcomeAction(RETRYABLE, 1).action === 'requeue-retry');
check('[2] retryable-later, count=2 -> requeue-retry', decideSendOutcomeAction(RETRYABLE, 2).action === 'requeue-retry');
check('[2] retryable-later, count=3 (exhausted) -> terminalize rejected-final, NOT requeued', (() => {
  const d = decideSendOutcomeAction(RETRYABLE, 3);
  return d.action === 'terminalize' && d.state === 'rejected-final';
})());

console.log('\n=== [2] decideSendOutcomeAction: malformed count on a retryable-later outcome must NEVER requeue ===');
for (const bad of MALFORMED_COUNT_VALUES) {
  const d = decideSendOutcomeAction(RETRYABLE, bad);
  check(
    `[2] retryable-later + count=${JSON.stringify(bad)} -> NEVER requeue-retry (terminalizes as unknown-outcome, not rejected-final)`,
    d.action === 'terminalize' && d.state === 'unknown-outcome'
  );
}
check('[2] retryable-later + count=4 -> terminalize (never requeue; exceeds MAX_SEND_ATTEMPTS domain)', (() => {
  const d = decideSendOutcomeAction(RETRYABLE, 4);
  return d.action === 'terminalize';
})());

check('unauthenticated (401) -> terminalize rejected-final, no retry', (() => {
  const d = decideSendOutcomeAction(UNAUTHENTICATED, 1);
  return d.action === 'terminalize' && d.state === 'rejected-final';
})());
check('permission-denied (403) -> terminalize rejected-final, no retry', (() => {
  const d = decideSendOutcomeAction({ kind: 'rejected', category: 'permission-denied' }, 1);
  return d.action === 'terminalize' && d.state === 'rejected-final';
})());
check('invalid-argument -> terminalize rejected-final', (() => {
  const d = decideSendOutcomeAction({ kind: 'rejected', category: 'invalid-argument' }, 1);
  return d.action === 'terminalize' && d.state === 'rejected-final';
})());
check('unregistered -> terminalize rejected-final', (() => {
  const d = decideSendOutcomeAction({ kind: 'rejected', category: 'unregistered' }, 1);
  return d.action === 'terminalize' && d.state === 'rejected-final';
})());
check('other-definitive-rejection -> terminalize rejected-final', (() => {
  const d = decideSendOutcomeAction({ kind: 'rejected', category: 'other-definitive-rejection' }, 1);
  return d.action === 'terminalize' && d.state === 'rejected-final';
})());
check('unknown-outcome -> terminalize unknown-outcome, NEVER requeue-retry', (() => {
  const d = decideSendOutcomeAction(UNKNOWN_OUTCOME, 1);
  return d.action === 'terminalize' && d.state === 'unknown-outcome';
})());
check('request-not-attempted (structurally anomalous post-send-intent) -> terminalize unknown-outcome, NEVER requeue-retry', (() => {
  const d = decideSendOutcomeAction({ kind: 'request-not-attempted' }, 1);
  return d.action === 'terminalize' && d.state === 'unknown-outcome';
})());

check('the ONLY input shape that ever produces requeue-retry is {rejected, retryable-later} under the attempt cap', (() => {
  const allInputs: DeliverySendOutcomeKind[] = [
    { kind: 'accepted' },
    { kind: 'rejected', category: 'invalid-argument' },
    { kind: 'rejected', category: 'permission-denied' },
    { kind: 'rejected', category: 'unauthenticated' },
    { kind: 'rejected', category: 'unregistered' },
    { kind: 'rejected', category: 'other-definitive-rejection' },
    { kind: 'rejected', category: 'retryable-later' },
    { kind: 'unknown-outcome' },
    { kind: 'request-not-attempted' },
  ];
  const requeuers = allInputs.filter((i) => decideSendOutcomeAction(i, 1).action === 'requeue-retry');
  return requeuers.length === 1 && requeuers[0].kind === 'rejected' && (requeuers[0] as { category: string }).category === 'retryable-later';
})());

check('decideSendOutcomeAction output never contains anything beyond its fixed enum vocabulary', JSON.stringify(decideSendOutcomeAction(RETRYABLE, 1)) === '{"action":"requeue-retry"}');

// =========================================================================
// Attempt history — hardened append, allowlist-only fields, httpStatus/timestamp range
// validation, aliasing protection.
// =========================================================================
console.log('\n=== attempt history ===');

const entry1: AttemptHistoryEntry = { attemptNumber: 1, sendIntentAt: 1000, outcomeCategory: 'retryable-later', httpStatus: 429, outcomeRecordedAt: 1500 };
const entry2: AttemptHistoryEntry = { attemptNumber: 2, sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 };
const entry3: AttemptHistoryEntry = { attemptNumber: 3, sendIntentAt: 3000, outcomeCategory: 'unknown-outcome', httpStatus: null, outcomeRecordedAt: 3500 };

check('a well-formed entry validates', isValidAttemptHistoryEntry(entry1));
check('entry with unrecognized outcomeCategory is invalid (no free-text categories)', !isValidAttemptHistoryEntry({ ...entry1, outcomeCategory: 'some raw provider message' }));
check('attemptNumber 0 is invalid', !isValidAttemptHistoryEntry({ ...entry1, attemptNumber: 0 }));
check(`attemptNumber ${9} is invalid (exceeds MAX_SEND_ATTEMPTS)`, !isValidAttemptHistoryEntry({ ...entry1, attemptNumber: 9 }));
check(`attemptNumber > MAX_SEND_ATTEMPTS (${MAX_SEND_ATTEMPTS}) is invalid`, !isValidAttemptHistoryEntry({ ...entry1, attemptNumber: MAX_SEND_ATTEMPTS + 1 }));

console.log('\n=== [6] attempt-history httpStatus validation (100..599) ===');
check('httpStatus 200 valid for accepted', isValidAttemptHistoryEntry({ ...entry2, httpStatus: 200 }));
check('httpStatus 100 (boundary) valid', isValidAttemptHistoryEntry({ ...entry1, httpStatus: 100 }));
check('httpStatus 599 (boundary) valid', isValidAttemptHistoryEntry({ ...entry1, httpStatus: 599 }));
check('[6] httpStatus 99 invalid (below range)', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: 99 }));
check('[6] httpStatus 600 invalid (above range)', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: 600 }));
check('[6] httpStatus NaN invalid', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: NaN }));
check('[6] httpStatus Infinity invalid', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: Infinity }));
check('[6] httpStatus fractional (200.5) invalid', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: 200.5 }));
check('[6] httpStatus as string invalid', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: '429' }));
check('[6] non-unknown-outcome category REQUIRES a real httpStatus — null is invalid for it', !isValidAttemptHistoryEntry({ ...entry1, httpStatus: null }));
check('[6] unknown-outcome category permits null httpStatus (no HTTP response was ever observed)', isValidAttemptHistoryEntry({ ...entry3, httpStatus: null }));
check('unknown-outcome category ALSO permits a real httpStatus (e.g. a coherent 5xx still classified unknown-outcome upstream)', isValidAttemptHistoryEntry({ ...entry3, httpStatus: 503 }));

console.log('\n=== [7] attempt-history timestamp validation ===');
check('[7] sendIntentAt NaN invalid', !isValidAttemptHistoryEntry({ ...entry1, sendIntentAt: NaN }));
check('[7] sendIntentAt Infinity invalid', !isValidAttemptHistoryEntry({ ...entry1, sendIntentAt: Infinity }));
check('[7] sendIntentAt fractional invalid', !isValidAttemptHistoryEntry({ ...entry1, sendIntentAt: 1000.5 }));
check('[7] sendIntentAt negative invalid', !isValidAttemptHistoryEntry({ ...entry1, sendIntentAt: -1 }));
check('[7] outcomeRecordedAt NaN invalid', !isValidAttemptHistoryEntry({ ...entry1, outcomeRecordedAt: NaN }));
check('[7] outcomeRecordedAt Infinity invalid', !isValidAttemptHistoryEntry({ ...entry1, outcomeRecordedAt: Infinity }));
check('[7] outcomeRecordedAt negative invalid', !isValidAttemptHistoryEntry({ ...entry1, outcomeRecordedAt: -1 }));
check('valid nonnegative safe-integer millisecond timestamps are accepted', isValidAttemptHistoryEntry(entry1));

check('empty history is valid', validateAttemptHistory([]).valid === true);
check('single-entry history is valid', validateAttemptHistory([entry1]).valid === true);
check('two sequential entries [1,2] is valid', validateAttemptHistory([entry1, entry2]).valid === true);
check('entries out of sequence ([1,3], skipping 2) is invalid', validateAttemptHistory([entry1, entry3]).valid === false);
check('entries in wrong order ([2,1]) is invalid (index 0 must be attemptNumber 1)', validateAttemptHistory([entry2, entry1]).valid === false);
check('four entries (exceeds MAX_SEND_ATTEMPTS) is invalid', validateAttemptHistory([entry1, entry2, entry3, { ...entry1, attemptNumber: 4 }]).valid === false);
check('non-array input is invalid', validateAttemptHistory('not an array').valid === false);
check('array containing a malformed entry is invalid', validateAttemptHistory([entry1, { bogus: true }]).valid === false);

console.log('\n=== [5] appendAttemptHistoryEntry — allowlist-only construction, aliasing protection ===');
check('appendAttemptHistoryEntry appends attemptNumber 1 to an empty history', (() => {
  const result = appendAttemptHistoryEntry([], { sendIntentAt: 1000, outcomeCategory: 'retryable-later', httpStatus: 429, outcomeRecordedAt: 1500 });
  return result !== null && result.length === 1 && result[0].attemptNumber === 1;
})());
check('appendAttemptHistoryEntry appends attemptNumber 2 after one existing entry', (() => {
  const result = appendAttemptHistoryEntry([entry1], { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  return result !== null && result.length === 2 && result[1].attemptNumber === 2;
})());
check('appendAttemptHistoryEntry appends attemptNumber 3 after two existing entries', (() => {
  const result = appendAttemptHistoryEntry([entry1, entry2], { sendIntentAt: 3000, outcomeCategory: 'unknown-outcome', httpStatus: null, outcomeRecordedAt: 3500 });
  return result !== null && result.length === 3 && result[2].attemptNumber === 3;
})());
check('appendAttemptHistoryEntry REFUSES a 4th entry (returns null)', appendAttemptHistoryEntry([entry1, entry2, entry3], { sendIntentAt: 4000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 4500 }) === null);
check('[5.B] appendAttemptHistoryEntry REJECTS a malformed existing history (not an array)', appendAttemptHistoryEntry('bogus', { sendIntentAt: 1000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 1500 }) === null);
check('[5.B] appendAttemptHistoryEntry REJECTS an existing history with an out-of-sequence entry', appendAttemptHistoryEntry([entry1, entry3], { sendIntentAt: 4000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 4500 }) === null);
check('appendAttemptHistoryEntry REJECTS a malformed new entry (bad outcomeCategory)', appendAttemptHistoryEntry([], { sendIntentAt: 1000, outcomeCategory: 'raw provider text', httpStatus: 200, outcomeRecordedAt: 1500 }) === null);
check('appendAttemptHistoryEntry REJECTS a malformed new entry (fractional httpStatus)', appendAttemptHistoryEntry([], { sendIntentAt: 1000, outcomeCategory: 'accepted', httpStatus: 200.5, outcomeRecordedAt: 1500 }) === null);
check('appendAttemptHistoryEntry REJECTS a malformed new entry (NaN/Infinity timestamps)', appendAttemptHistoryEntry([], { sendIntentAt: NaN, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: Infinity }) === null);

check('[5.C/D] appendAttemptHistoryEntry NEVER carries arbitrary extra properties into the persisted entry, even if the caller supplies them', (() => {
  const hostileInput = {
    sendIntentAt: 1000,
    outcomeCategory: 'accepted',
    httpStatus: 200,
    outcomeRecordedAt: 1500,
    token: 'RAW-FCM-TOKEN-SHOULD-NOT-APPEAR',
    providerMessage: 'raw provider error text should not appear',
    accessToken: 'Bearer SECRET-SHOULD-NOT-APPEAR',
  };
  const result = appendAttemptHistoryEntry([], hostileInput as unknown as Parameters<typeof appendAttemptHistoryEntry>[1]);
  if (result === null) return false;
  const serialized = JSON.stringify(result);
  const keys = Object.keys(result[0]);
  const allowlist = ['attemptNumber', 'sendIntentAt', 'outcomeCategory', 'httpStatus', 'outcomeRecordedAt'];
  return (
    keys.length === allowlist.length &&
    allowlist.every((k) => keys.includes(k)) &&
    !serialized.includes('RAW-FCM-TOKEN') &&
    !serialized.includes('raw provider error text') &&
    !serialized.includes('SECRET')
  );
})());

check('[14] appendAttemptHistoryEntry does not mutate the existing array (pure)', (() => {
  const original = [entry1];
  appendAttemptHistoryEntry(original, { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  return original.length === 1;
})());
check('[14] mutating the ORIGINAL history array/entries AFTER append does not alter the returned array (aliasing severed)', (() => {
  const original = [{ ...entry1 }];
  const result = appendAttemptHistoryEntry(original, { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  if (result === null) return false;
  const before = JSON.stringify(result);
  original[0].outcomeCategory = 'unregistered'; // mutate the caller's original entry object in place
  original.push({ ...entry3 }); // and push a new element onto the caller's original array
  const after = JSON.stringify(result);
  return before === after;
})());
check('[14] mutating the RETURNED array/entries does not alter a subsequent independent read of the original', (() => {
  const original = [{ ...entry1 }];
  const result = appendAttemptHistoryEntry(original, { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  if (result === null) return false;
  result[0].outcomeCategory = 'unregistered';
  return original[0].outcomeCategory === 'retryable-later';
})());

// =========================================================================
// [4] Rollout parsing / fanout decision / real-send authorization — every exported
// boundary must fail closed against fabricated runtime input, not just parseRolloutConfig.
// =========================================================================
console.log('\n=== rollout config parsing ===');

check("'paused' parses cleanly", parseRolloutConfig({ mode: 'paused' }).mode === 'paused');
check("'dry-run' parses cleanly", parseRolloutConfig({ mode: 'dry-run' }).mode === 'dry-run');
check("'general-real-send' parses cleanly", parseRolloutConfig({ mode: 'general-real-send' }).mode === 'general-real-send');
check("'allowlisted-real-send' with a valid allowlist parses cleanly", (() => {
  const c = parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['uid-a', 'uid-b'] });
  return c.mode === 'allowlisted-real-send' && (c as { allowlistUids: string[] }).allowlistUids.length === 2;
})());
check('missing config (undefined) -> paused', parseRolloutConfig(undefined).mode === 'paused');
check('null config -> paused', parseRolloutConfig(null).mode === 'paused');
check('non-object config (string) -> paused', parseRolloutConfig('general-real-send').mode === 'paused');
check('unrecognized mode string -> paused', parseRolloutConfig({ mode: 'super-send' }).mode === 'paused');
check('allowlisted-real-send with missing allowlistUids -> paused', parseRolloutConfig({ mode: 'allowlisted-real-send' }).mode === 'paused');
check('allowlisted-real-send with non-array allowlistUids -> paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: 'uid-a' }).mode === 'paused');
check('allowlisted-real-send with a malformed entry in the array -> whole config fails closed to paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['uid-a', 42] }).mode === 'paused');
check('allowlisted-real-send with an empty-string entry -> paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['uid-a', ''] }).mode === 'paused');

check('[14] parseRolloutConfig never aliases the caller-supplied allowlistUids array', (() => {
  const rawAllowlist = ['uid-a', 'uid-b'];
  const parsed = parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: rawAllowlist });
  if (parsed.mode !== 'allowlisted-real-send') return false;
  const before = [...parsed.allowlistUids];
  rawAllowlist.push('uid-injected-after-parse');
  return JSON.stringify(parsed.allowlistUids) === JSON.stringify(before);
})());

console.log('\n=== [4] decideShouldFanOut — hardened against fabricated runtime input ===');
check('paused -> never fans out', decideShouldFanOut({ mode: 'paused' }, 'uid-1').shouldFanOut === false);
check('dry-run -> always fans out', decideShouldFanOut({ mode: 'dry-run' }, 'uid-1').shouldFanOut === true);
check('general-real-send -> always fans out', decideShouldFanOut({ mode: 'general-real-send' }, 'uid-1').shouldFanOut === true);
check('allowlisted-real-send, allowlisted uid -> fans out', decideShouldFanOut({ mode: 'allowlisted-real-send', allowlistUids: ['uid-1'] }, 'uid-1').shouldFanOut === true);
check('allowlisted-real-send, non-allowlisted uid -> does NOT fan out', decideShouldFanOut({ mode: 'allowlisted-real-send', allowlistUids: ['uid-other'] }, 'uid-1').shouldFanOut === false);

check('[4] bogus mode object passed DIRECTLY (bypassing parseRolloutConfig, e.g. via `as`) -> treated as paused, never fans out', decideShouldFanOut({ mode: 'super-send' }, 'uid-1').shouldFanOut === false);
check('[4] fabricated object claiming allowlisted-real-send with a malformed allowlist -> paused, never fans out', decideShouldFanOut({ mode: 'allowlisted-real-send', allowlistUids: 'not-an-array' }, 'uid-1').shouldFanOut === false);
check('[4] completely unknown/fabricated raw config object -> paused', decideShouldFanOut({ arbitrary: 'garbage' }, 'uid-1').shouldFanOut === false);
check('[4] null config -> paused, never fans out', decideShouldFanOut(null, 'uid-1').shouldFanOut === false);
check('[4] malformed uid (number) can never authorize fanout, even under general-real-send', decideShouldFanOut({ mode: 'general-real-send' }, 12345).shouldFanOut === false);
check('[4] malformed uid (empty string) can never authorize fanout', decideShouldFanOut({ mode: 'general-real-send' }, '').shouldFanOut === false);
check('[4] malformed uid (null) can never authorize fanout', decideShouldFanOut({ mode: 'general-real-send' }, null).shouldFanOut === false);
check('[4] malformed uid (object) can never authorize fanout', decideShouldFanOut({ mode: 'general-real-send' }, {}).shouldFanOut === false);

console.log('\n=== [4] decideRealSendAuthorization — hardened against fabricated runtime input ===');
check('paused -> never authorized', decideRealSendAuthorization({ mode: 'paused' }, 'uid-1').authorized === false);
check('dry-run -> never authorized (fans out, but never a real send)', decideRealSendAuthorization({ mode: 'dry-run' }, 'uid-1').authorized === false);
check('general-real-send -> authorized', decideRealSendAuthorization({ mode: 'general-real-send' }, 'uid-1').authorized === true);
check('allowlisted-real-send, allowlisted uid -> authorized', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['uid-1'] }, 'uid-1').authorized === true);
check('allowlisted-real-send, non-allowlisted uid -> NOT authorized', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['uid-other'] }, 'uid-1').authorized === false);
check('paused reason is "paused"', (() => {
  const d = decideRealSendAuthorization({ mode: 'paused' }, 'uid-1');
  return !d.authorized && d.reason === 'paused';
})());
check('dry-run reason is "dry-run-only"', (() => {
  const d = decideRealSendAuthorization({ mode: 'dry-run' }, 'uid-1');
  return !d.authorized && d.reason === 'dry-run-only';
})());
check('non-allowlisted reason is "not-allowlisted"', (() => {
  const d = decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: [] }, 'uid-1');
  return !d.authorized && d.reason === 'not-allowlisted';
})());

check('[4] bogus mode object passed DIRECTLY -> NEVER authorized', decideRealSendAuthorization({ mode: 'super-send' }, 'uid-1').authorized === false);
check('[4] fabricated allowlisted-real-send with a malformed allowlist -> NEVER authorized', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: null }, 'uid-1').authorized === false);
check('[4] unknown mode may NOT fall through into allowlisted behavior even if it superficially carries an allowlistUids array', decideRealSendAuthorization({ mode: 'super-allowlisted', allowlistUids: ['uid-1'] }, 'uid-1').authorized === false);
check('[4] completely unknown/fabricated raw config -> NEVER authorized', decideRealSendAuthorization(42, 'uid-1').authorized === false);
check('[4] malformed uid can never be authorized, even under general-real-send', (() => {
  const d = decideRealSendAuthorization({ mode: 'general-real-send' }, undefined);
  return !d.authorized && d.reason === 'invalid-uid';
})());
check('[4] malformed uid can never be authorized under allowlisted-real-send', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['uid-1'] }, ['uid-1']).authorized === false);

// =========================================================================
// [8/9] Public-ID derivation — full runtime hardening + edge cases.
// =========================================================================
console.log('\n=== deriveDeliveryPublicId ===');

const nonceA = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 0xaa);
// A syntactically valid opaque ID (correct length/alphabet) for fixtures that need ANY
// well-formed fanoutExecutionId but don't care about its actual randomness provenance.
const VALID_FANOUT_EXECUTION_ID = 'B'.repeat(OPAQUE_ID_LENGTH);
const VALID_FANOUT_EXECUTION_ID_2 = 'C'.repeat(OPAQUE_ID_LENGTH);
const nonceB = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 0xbb);
const VALID_INSTALL_ID_2 = 'b2c3d4e5-f607-4890-9bcd-ef0123456789';

check('deterministic: same inputs, same nonce -> identical output (retry-stable)', deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID) === deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID));
check('different reminderId -> different id', deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID) !== deriveDeliveryPublicId(nonceA, 'reminder-2', VALID_INSTALLATION_ID));
check('different installationId -> different id', deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID) !== deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALL_ID_2));
check('different nonce -> different id (same reminder/installation)', deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID) !== deriveDeliveryPublicId(nonceB, 'reminder-1', VALID_INSTALLATION_ID));

check('delimiter-like concatenation attack does not collide: ("reminderAB","...") != ("reminderA","B...")', (() => {
  const idHex = 'a1b2c3d4e5f67890abcdef0123456789'; // valid hex32.
  return deriveDeliveryPublicId(nonceA, 'AB', idHex) !== deriveDeliveryPublicId(nonceA, 'A', idHex);
})());

check('output is a nonempty base64url string with no padding/slashes/plus characters', (() => {
  const id = deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID);
  return id.length > 0 && /^[A-Za-z0-9_-]+$/.test(id);
})());

console.log('\n=== [8] deriveDeliveryPublicId: fanoutNonce runtime validation ===');
check('[8/9] wrong-length nonce (31 bytes) fails closed (throws)', throws(() => deriveDeliveryPublicId(Buffer.alloc(31), 'reminder-1', VALID_INSTALLATION_ID)));
check('[8/9] wrong-length nonce (33 bytes) fails closed (throws)', throws(() => deriveDeliveryPublicId(Buffer.alloc(33), 'reminder-1', VALID_INSTALLATION_ID)));
check('wrong-length nonce (16 bytes) fails closed (throws)', throws(() => deriveDeliveryPublicId(Buffer.alloc(16), 'reminder-1', VALID_INSTALLATION_ID)));
check('wrong-length nonce (64 bytes) fails closed (throws)', throws(() => deriveDeliveryPublicId(Buffer.alloc(64), 'reminder-1', VALID_INSTALLATION_ID)));
check('zero-length nonce fails closed (throws)', throws(() => deriveDeliveryPublicId(Buffer.alloc(0), 'reminder-1', VALID_INSTALLATION_ID)));
check('non-Buffer nonce (plain string) fails closed (throws)', throws(() => deriveDeliveryPublicId('not-a-buffer', 'reminder-1', VALID_INSTALLATION_ID)));
check('[9] Uint8Array masquerading as Buffer (same 32 bytes, NOT a real Buffer instance) fails closed (throws)', (() => {
  const fakeBuffer = new Uint8Array(32).fill(0xaa);
  return throws(() => deriveDeliveryPublicId(fakeBuffer, 'reminder-1', VALID_INSTALLATION_ID));
})());
check('[9] null nonce fails closed (throws)', throws(() => deriveDeliveryPublicId(null, 'reminder-1', VALID_INSTALLATION_ID)));
check('[9] undefined nonce fails closed (throws)', throws(() => deriveDeliveryPublicId(undefined, 'reminder-1', VALID_INSTALLATION_ID)));
check('[9] number nonce fails closed (throws)', throws(() => deriveDeliveryPublicId(42, 'reminder-1', VALID_INSTALLATION_ID)));
check('[9] plain object nonce (wrong runtime object) fails closed (throws)', throws(() => deriveDeliveryPublicId({ length: 32 }, 'reminder-1', VALID_INSTALLATION_ID)));

console.log('\n=== [9] deriveDeliveryPublicId: reminderId/installationId runtime type edge cases ===');
check('[9] reminderId as a number fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 12345, VALID_INSTALLATION_ID)));
check('[9] installationId as a number fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', 12345)));
check('[9] reminderId as null fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, null, VALID_INSTALLATION_ID)));
check('[9] installationId as null fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', null)));
check('[9] reminderId as a plain object fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, { id: 'reminder-1' }, VALID_INSTALLATION_ID)));
check('[9] installationId as a plain object fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', { id: VALID_INSTALLATION_ID })));
check('[9] reminderId as an array fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, ['reminder-1'], VALID_INSTALLATION_ID)));
check('[9] installationId as an array fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', [VALID_INSTALLATION_ID])));
check('[9] reminderId as a boxed String object (not a primitive string) fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, new String('reminder-1'), VALID_INSTALLATION_ID)));
check('[9] installationId as a boxed String object fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', new String(VALID_INSTALLATION_ID))));
check('[9] empty-string reminderId fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, '', VALID_INSTALLATION_ID)));
check('[9] empty-string installationId fails closed (throws — does not match UUID/hex32 grammar)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', '')));
const NUL = String.fromCharCode(0);
check('[9] NUL-containing reminderId does not throw (a NUL code point is well-formed Unicode and contains no "/", so isValidIdForPath permits it) and the length-prefixed encoding prevents NUL-based collisions between otherwise-different strings', (() => {
  const idA = deriveDeliveryPublicId(nonceA, 'reminder-a' + NUL + 'b', VALID_INSTALLATION_ID);
  const idC = deriveDeliveryPublicId(nonceA, 'reminder-a' + NUL + 'c', VALID_INSTALLATION_ID);
  const idARepeat = deriveDeliveryPublicId(nonceA, 'reminder-a' + NUL + 'b', VALID_INSTALLATION_ID);
  return idA !== idC && idA === idARepeat;
})());
check('[9] NUL-containing installationId fails closed (throws — does not match the UUID v4 / 32-hex grammar)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', 'a1b2c3d4-e5f6-4789-8abc-def012' + NUL + '345678')));
check('[9] installationId with a trailing slash fails closed (throws — does not match UUID/hex32 grammar)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID + '/')));

console.log('\n=== [9] deriveDeliveryPublicId: Unicode handling ===');
check('[9] Unicode reminderId does not throw and is deterministic', deriveDeliveryPublicId(nonceA, '提醒-📱-1', VALID_INSTALLATION_ID) === deriveDeliveryPublicId(nonceA, '提醒-📱-1', VALID_INSTALLATION_ID));
check('[9] emoji reminderId does not throw and is deterministic', deriveDeliveryPublicId(nonceA, 'reminder-🔔🎉', VALID_INSTALLATION_ID) === deriveDeliveryPublicId(nonceA, 'reminder-🔔🎉', VALID_INSTALLATION_ID));
check('[9] two different well-formed Unicode reminderIds never collide', deriveDeliveryPublicId(nonceA, '提醒-📱', VALID_INSTALLATION_ID) !== deriveDeliveryPublicId(nonceA, 'reminder-🔔', VALID_INSTALLATION_ID));
check('[9] unpaired UTF-16 surrogate in reminderId fails closed (throws — would otherwise lossily collide under UTF-8 encoding)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-\uD800-tail', VALID_INSTALLATION_ID)));
check('[9] a lone low surrogate also fails closed (throws)', throws(() => deriveDeliveryPublicId(nonceA, 'reminder-\uDC00-tail', VALID_INSTALLATION_ID)));
check('a well-formed surrogate PAIR (e.g. an emoji) is accepted, not confused with an unpaired surrogate', !throws(() => deriveDeliveryPublicId(nonceA, 'reminder-📱', VALID_INSTALLATION_ID)));

check(`FANOUT_NONCE_BYTE_LENGTH is 256 bits (32 bytes)`, FANOUT_NONCE_BYTE_LENGTH === 32);

console.log('\n=== isValidInstallationIdShape ===');
check('valid UUID v4 shape accepted', isValidInstallationIdShape(VALID_INSTALLATION_ID));
check('valid 32-char hex shape accepted', isValidInstallationIdShape('a1b2c3d4e5f67890abcdef0123456789'.slice(0, 32)));
check('an arbitrary Firebase-UID-shaped string is REJECTED (installationId is not a general uid)', !isValidInstallationIdShape('some-arbitrary-firebase-uid-12345'));
check('a number is rejected', !isValidInstallationIdShape(12345));
check('null is rejected', !isValidInstallationIdShape(null));

// =========================================================================
// [10/12] Fanout count / outcome model.
// =========================================================================
console.log('\n=== decideFanoutOutcome ===');

check(`MAX_TARGET_INSTALLATIONS is 10`, MAX_TARGET_INSTALLATIONS === 10);
check(`FANOUT_QUERY_LIMIT is 11 (MAX_TARGET_INSTALLATIONS + 1)`, FANOUT_QUERY_LIMIT === 11);

check('zero-target success: rawActiveCount=0 -> completed, count=0', (() => {
  const o = decideFanoutOutcome(0, 0, VALID_FANOUT_EXECUTION_ID);
  return o.deliveryFanoutState === 'completed' && o.targetInstallationCountAtFanout === 0;
})());
check('exact-cap success: rawActiveCount=10, none malformed -> completed, count=10', (() => {
  const o = decideFanoutOutcome(10, 0, VALID_FANOUT_EXECUTION_ID);
  return o.deliveryFanoutState === 'completed' && o.targetInstallationCountAtFanout === 10;
})());
check('malformed-exclusion arithmetic: rawActiveCount=10, excluded=3 -> count=7', (() => {
  const o = decideFanoutOutcome(10, 3, VALID_FANOUT_EXECUTION_ID);
  return o.deliveryFanoutState === 'completed' && o.targetInstallationCountAtFanout === 7 && o.excludedMalformedInstallationCount === 3;
})());
check('invariant holds: rawActiveCount === targetInstallationCountAtFanout + excludedMalformedInstallationCount', (() => {
  const o = decideFanoutOutcome(6, 2, VALID_FANOUT_EXECUTION_ID);
  if (o.deliveryFanoutState !== 'completed') return false;
  return 6 === (o.targetInstallationCountAtFanout as number) + o.excludedMalformedInstallationCount;
})());

console.log('\n=== [12] fanout count: ANY count >= FANOUT_QUERY_LIMIT fails closed, not just exactly 11 ===');
for (const count of [11, 12, 100]) {
  check(`[12] rawActiveCount=${count} -> fails closed, "at least 11", never claims an exact count`, (() => {
    const o = decideFanoutOutcome(count, 0, VALID_FANOUT_EXECUTION_ID);
    return (
      o.deliveryFanoutState === 'failed' &&
      o.targetingFailureReason === 'installation-count-exceeds-cap' &&
      o.targetInstallationCountAtFanout === null &&
      o.observedTargetCountAtLeast === FANOUT_QUERY_LIMIT
    );
  })());
}

check('negative rawActiveCount throws (malformed, not merely over-cap)', throws(() => decideFanoutOutcome(-1, 0, VALID_FANOUT_EXECUTION_ID)));
check('non-integer rawActiveCount throws', throws(() => decideFanoutOutcome(5.5, 0, VALID_FANOUT_EXECUTION_ID)));
check('NaN rawActiveCount throws', throws(() => decideFanoutOutcome(NaN, 0, VALID_FANOUT_EXECUTION_ID)));
check('string rawActiveCount throws', throws(() => decideFanoutOutcome('10' as unknown as number, 0, VALID_FANOUT_EXECUTION_ID)));
check('excludedMalformedCount exceeding rawActiveCount throws', throws(() => decideFanoutOutcome(3, 4, VALID_FANOUT_EXECUTION_ID)));
check('negative excludedMalformedCount throws', throws(() => decideFanoutOutcome(3, -1, VALID_FANOUT_EXECUTION_ID)));
check('non-integer excludedMalformedCount throws', throws(() => decideFanoutOutcome(3, 1.5, VALID_FANOUT_EXECUTION_ID)));

check('status is always "delivery-fanned-out" (per Codex note: preserved, not renamed)', decideFanoutOutcome(5, 0, VALID_FANOUT_EXECUTION_ID).status === 'delivery-fanned-out' && decideFanoutOutcome(11, 0, VALID_FANOUT_EXECUTION_ID).status === 'delivery-fanned-out');

// =========================================================================
// CODEX REPAIR ROUND (H1) — decideFanoutOutcome now requires a valid opaque
// fanoutExecutionId and embeds it ONLY on the 'completed' branch.
// =========================================================================
console.log('\n=== [H1] decideFanoutOutcome fanoutExecutionId provenance ===');
check('missing fanoutExecutionId throws', throws(() => decideFanoutOutcome(5, 0, undefined)));
check('malformed (too short) fanoutExecutionId throws', throws(() => decideFanoutOutcome(5, 0, 'A'.repeat(OPAQUE_ID_LENGTH - 1))));
check('malformed (bad alphabet) fanoutExecutionId throws', throws(() => decideFanoutOutcome(5, 0, '!'.repeat(OPAQUE_ID_LENGTH))));
check('non-string fanoutExecutionId throws', throws(() => decideFanoutOutcome(5, 0, 12345)));
check('completed outcome embeds the exact caller-supplied fanoutExecutionId', (() => {
  const o = decideFanoutOutcome(5, 0, VALID_FANOUT_EXECUTION_ID);
  return o.deliveryFanoutState === 'completed' && o.fanoutExecutionId === VALID_FANOUT_EXECUTION_ID;
})());
check('zero-target completed outcome STILL embeds fanoutExecutionId', (() => {
  const o = decideFanoutOutcome(0, 0, VALID_FANOUT_EXECUTION_ID);
  return o.deliveryFanoutState === 'completed' && o.fanoutExecutionId === VALID_FANOUT_EXECUTION_ID;
})());
check('over-cap FAILED outcome never embeds fanoutExecutionId (no such property at all)', (() => {
  const o = decideFanoutOutcome(11, 0, VALID_FANOUT_EXECUTION_ID);
  return o.deliveryFanoutState === 'failed' && !Object.prototype.hasOwnProperty.call(o, 'fanoutExecutionId');
})());
check('buildPreExistingChildCorruptionOutcome never embeds fanoutExecutionId', !Object.prototype.hasOwnProperty.call(buildPreExistingChildCorruptionOutcome(), 'fanoutExecutionId'));

console.log('\n=== buildPreExistingChildCorruptionOutcome ===');
check('pre-existing-child outcome fails closed with the exact expected shape', (() => {
  const o = buildPreExistingChildCorruptionOutcome();
  return o.status === 'delivery-fanned-out' && o.deliveryFanoutState === 'failed' && o.targetingFailureReason === 'unexpected-preexisting-delivery' && o.targetInstallationCountAtFanout === null;
})());

check('fanout outcome objects never contain any string value outside the fixed enum set OR the opaque fanoutExecutionId field', (() => {
  const FIXED_OUTCOME_ENUM_VALUES = new Set(['delivery-fanned-out', 'completed', 'failed', 'installation-count-exceeds-cap', 'unexpected-preexisting-delivery']);
  const outcomes = [decideFanoutOutcome(0, 0, VALID_FANOUT_EXECUTION_ID), decideFanoutOutcome(10, 3, VALID_FANOUT_EXECUTION_ID), decideFanoutOutcome(11, 0, VALID_FANOUT_EXECUTION_ID), buildPreExistingChildCorruptionOutcome()];
  return outcomes.every((o) =>
    Object.entries(o).every(
      ([key, value]) =>
        key === 'fanoutExecutionId' || value === null || typeof value === 'number' || (typeof value === 'string' && FIXED_OUTCOME_ENUM_VALUES.has(value))
    )
  );
})());

// =========================================================================
// [10] validateFanoutTuple — the complete parent-tuple validator.
// =========================================================================
console.log('\n=== validateFanoutTuple ===');

check('[10] valid success tuple validates', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
  });
  return r.valid === true && r.outcome.deliveryFanoutState === 'completed' && r.outcome.fanoutExecutionId === VALID_FANOUT_EXECUTION_ID;
})());
check('[10] valid zero-target success tuple validates', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 0,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
  });
  return r.valid === true;
})());

// =========================================================================
// CODEX REPAIR ROUND (H1) — validateFanoutTuple now requires fanoutExecutionId on
// 'completed' and forbids it (even well-formed) on 'failed'.
// =========================================================================
check('[H1] completed tuple MISSING fanoutExecutionId -> rejected', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'completed', targetInstallationCountAtFanout: 2, excludedMalformedInstallationCount: 0 });
  return r.valid === false && r.reason === 'invalid-fanout-execution-id';
})());
check('[H1] completed tuple with MALFORMED fanoutExecutionId -> rejected', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: 'too-short',
  });
  return r.valid === false && r.reason === 'invalid-fanout-execution-id';
})());
check('[H1] completed tuple with NULL fanoutExecutionId -> rejected (own-but-not-meaningful)', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: null,
  });
  return r.valid === false && r.reason === 'invalid-fanout-execution-id';
})());
check('[H1] FAILED (over-cap) tuple carrying a well-formed fanoutExecutionId -> rejected (must not masquerade as successful provenance)', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'failed',
    targetingFailureReason: 'installation-count-exceeds-cap',
    targetInstallationCountAtFanout: null,
    observedTargetCountAtLeast: FANOUT_QUERY_LIMIT,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
  });
  return r.valid === false && r.reason === 'failed-with-fanout-execution-id';
})());
check('[H1] FAILED (pre-existing-child) tuple carrying a well-formed fanoutExecutionId -> rejected', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'failed',
    targetingFailureReason: 'unexpected-preexisting-delivery',
    targetInstallationCountAtFanout: null,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
  });
  return r.valid === false && r.reason === 'failed-with-fanout-execution-id';
})());
check('[H1] a fanoutExecutionId inherited-only (not an own property) on a completed tuple does not falsely satisfy the check', (() => {
  const base = { fanoutExecutionId: VALID_FANOUT_EXECUTION_ID };
  const input = Object.assign(Object.create(base), {
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
  });
  const r = validateFanoutTuple(input);
  return r.valid === false && r.reason === 'invalid-fanout-execution-id';
})());
check('[10] valid over-cap failure tuple validates', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'failed',
    targetingFailureReason: 'installation-count-exceeds-cap',
    targetInstallationCountAtFanout: null,
    observedTargetCountAtLeast: FANOUT_QUERY_LIMIT,
  });
  return r.valid === true;
})());
check('[10] valid pre-existing-child failure tuple validates', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'failed', targetingFailureReason: 'unexpected-preexisting-delivery', targetInstallationCountAtFanout: null });
  return r.valid === true;
})());

check('[10] contradictory: completed WITH a failure reason present -> rejected', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetingFailureReason: 'installation-count-exceeds-cap',
    targetInstallationCountAtFanout: 5,
    excludedMalformedInstallationCount: 0,
  });
  return r.valid === false;
})());
check('[10] contradictory: failed WITHOUT any recognized reason -> rejected', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'failed', targetInstallationCountAtFanout: null });
  return r.valid === false;
})());
check('[10] contradictory: completed WITH a null count -> rejected', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'completed', targetInstallationCountAtFanout: null, excludedMalformedInstallationCount: 0 });
  return r.valid === false;
})());
check('[10] invalid arithmetic: completed with target+excluded exceeding MAX_TARGET_INSTALLATIONS -> rejected', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'completed', targetInstallationCountAtFanout: 8, excludedMalformedInstallationCount: 5 });
  return r.valid === false;
})());
check('[10] completed with target count exceeding the cap alone -> rejected', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'completed', targetInstallationCountAtFanout: 15, excludedMalformedInstallationCount: 0 });
  return r.valid === false;
})());
check('[10] over-cap failure with wrong observedTargetCountAtLeast -> rejected', (() => {
  const r = validateFanoutTuple({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'failed',
    targetingFailureReason: 'installation-count-exceeds-cap',
    targetInstallationCountAtFanout: null,
    observedTargetCountAtLeast: 5,
  });
  return r.valid === false;
})());
check('[10] failed with a nonnull target count -> rejected', (() => {
  const r = validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'failed', targetingFailureReason: 'unexpected-preexisting-delivery', targetInstallationCountAtFanout: 3 });
  return r.valid === false;
})());
check('[10] unrecognized status -> rejected', validateFanoutTuple({ status: 'something-else', deliveryFanoutState: 'completed' }).valid === false);
check('[10] unrecognized deliveryFanoutState -> rejected', validateFanoutTuple({ status: 'delivery-fanned-out', deliveryFanoutState: 'bogus' }).valid === false);
check('[10] non-object input -> rejected', validateFanoutTuple('bogus').valid === false);
check('[10] null input -> rejected', validateFanoutTuple(null).valid === false);

// =========================================================================
// CODEX REPAIR ROUND (H1) — isValidOpaqueIdFormat / OPAQUE_ID_BYTE_LENGTH: the shared
// format primitive both deliveryPublicId and fanoutExecutionId now reuse.
// =========================================================================
console.log('\n=== isValidOpaqueIdFormat / OPAQUE_ID_BYTE_LENGTH ===');
check('OPAQUE_ID_BYTE_LENGTH is 32 (256-bit)', OPAQUE_ID_BYTE_LENGTH === 32);
check('OPAQUE_ID_LENGTH is 43 (base64url of 32 bytes, no padding)', OPAQUE_ID_LENGTH === 43);
check('a real 32-random-byte base64url string round-trips as valid', isValidOpaqueIdFormat(nonceA.toString('base64url')) && nonceA.toString('base64url').length === OPAQUE_ID_LENGTH);
check('too short is rejected', !isValidOpaqueIdFormat('A'.repeat(OPAQUE_ID_LENGTH - 1)));
check('too long is rejected', !isValidOpaqueIdFormat('A'.repeat(OPAQUE_ID_LENGTH + 1)));
check('padding character "=" is rejected', !isValidOpaqueIdFormat('A'.repeat(OPAQUE_ID_LENGTH - 1) + '='));
check('slash is rejected', !isValidOpaqueIdFormat('A'.repeat(OPAQUE_ID_LENGTH - 1) + '/'));
check('whitespace is rejected', !isValidOpaqueIdFormat('A'.repeat(OPAQUE_ID_LENGTH - 1) + ' '));
check('non-string is rejected', !isValidOpaqueIdFormat(12345));
check('null is rejected', !isValidOpaqueIdFormat(null));

// =========================================================================
// CODEX REPAIR ROUND (H2/section 11) — validatePersistedDeliveryForProcessing, PROMOTED
// here from reminderDeliveryWorker.ts so it is the single shared source of truth for both
// queue acquisition and final authorization. Exhaustive per-field corruption coverage
// already exists in reminderDeliveryWorker.test.ts's [queue M1] suite (which exercises this
// exact function transactionally); these tests focus on the function's OWN direct contract,
// especially the NEW fanoutExecutionIdAtCreation check this repair round adds.
// =========================================================================
console.log('\n=== validatePersistedDeliveryForProcessing ===');

const VALID_AUDIENCE_ID = 'A'.repeat(20); // matches pushInstallationEpochLogic.ts's real AUDIENCE_ID_PATTERN (16-64 chars).

function validPersistedDeliveryData(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: 'uid-1',
    installationId: VALID_INSTALLATION_ID,
    sendAttemptCount: 0,
    processingAttemptCount: 0,
    targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: VALID_AUDIENCE_ID },
    deliveryPublicId: deriveDeliveryPublicId(nonceA, 'reminder-1', VALID_INSTALLATION_ID),
    attemptHistory: [],
    fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID,
    ...overrides,
  };
}

check('[H2] happy path validates and returns fanoutExecutionIdAtCreation unchanged', (() => {
  const r = validatePersistedDeliveryForProcessing(VALID_INSTALLATION_ID, validPersistedDeliveryData());
  return r.valid === true && r.fanoutExecutionIdAtCreation === VALID_FANOUT_EXECUTION_ID;
})());
check('[3C-4] happy path also returns sendAttemptCount (needed by authorization to compute the next send intent count)', (() => {
  const r = validatePersistedDeliveryForProcessing(VALID_INSTALLATION_ID, validPersistedDeliveryData({ sendAttemptCount: 2 }));
  return r.valid === true && r.sendAttemptCount === 2;
})());
check('[H2] missing fanoutExecutionIdAtCreation -> rejected', (() => {
  const data = validPersistedDeliveryData();
  delete (data as Record<string, unknown>).fanoutExecutionIdAtCreation;
  const r = validatePersistedDeliveryForProcessing(VALID_INSTALLATION_ID, data);
  return r.valid === false && r.reason === 'invalid-fanout-execution-id-format';
})());
check('[H2] malformed (too short) fanoutExecutionIdAtCreation -> rejected', (() => {
  const r = validatePersistedDeliveryForProcessing(VALID_INSTALLATION_ID, validPersistedDeliveryData({ fanoutExecutionIdAtCreation: 'too-short' }));
  return r.valid === false && r.reason === 'invalid-fanout-execution-id-format';
})());
check('[H2] a DIFFERENT but equally well-formed fanoutExecutionIdAtCreation still validates at the field-format level (equality-against-parent is final authorization\'s job, not this function\'s)', (() => {
  const r = validatePersistedDeliveryForProcessing(VALID_INSTALLATION_ID, validPersistedDeliveryData({ fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID_2 }));
  return r.valid === true && r.fanoutExecutionIdAtCreation === VALID_FANOUT_EXECUTION_ID_2;
})());
check('[H2] ref.id / stored installationId mismatch -> rejected', (() => {
  const r = validatePersistedDeliveryForProcessing('11111111-1111-4111-8111-111111111111', validPersistedDeliveryData());
  return r.valid === false && r.reason === 'ref-installation-id-mismatch';
})());
check('[H2] malformed deliveryPublicId -> rejected', (() => {
  const r = validatePersistedDeliveryForProcessing(VALID_INSTALLATION_ID, validPersistedDeliveryData({ deliveryPublicId: 'not-valid' }));
  return r.valid === false && r.reason === 'invalid-delivery-public-id-format';
})());
check('[H2] poisoned attemptHistory (nonsequential) -> rejected', (() => {
  const r = validatePersistedDeliveryForProcessing(
    VALID_INSTALLATION_ID,
    validPersistedDeliveryData({ attemptHistory: [{ attemptNumber: 2, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2 }] })
  );
  return r.valid === false && r.reason === 'invalid-attempt-history';
})());
check('[H2] malformed audience grammar (too short, unlike validateDeliverySchema\'s own looser check) -> rejected', (() => {
  const r = validatePersistedDeliveryForProcessing(
    VALID_INSTALLATION_ID,
    validPersistedDeliveryData({ targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'short' } })
  );
  return r.valid === false && r.reason === 'invalid-target-snapshot-audience-id';
})());

// =========================================================================
// SECOND CODEX REPAIR ROUND — blocker 1: reminder-ID validation must be compatible with
// the ACTUAL Step 2 format (`${uid}_${scheduledForMs}`, where uid may be up to 128
// characters), never the UID/path validator's own 128-character limit.
// =========================================================================
console.log('\n=== [blocker 1] isValidReminderId / isValidFirestoreDocumentId — Step 2 format compatibility ===');

const MAX_LENGTH_UID = 'u'.repeat(128); // the longest uid isValidIdForPath permits.
const REALISTIC_STEP2_REMINDER_ID = `${MAX_LENGTH_UID}_1700000000000`; // exact Step 2 format: `${uid}_${scheduledForMs}`, 13-digit ms timestamp.

check('[8.A] a max-length (128-char) valid Step 2 UID combined with a 13-digit timestamp produces a reminderId well over 128 characters, and it IS valid', (() => {
  return REALISTIC_STEP2_REMINDER_ID.length > 128 && isValidReminderId(REALISTIC_STEP2_REMINDER_ID);
})());
check('[8.A] deriveDeliveryPublicId SUCCEEDS for the exact Step 2-format reminderId (would have been wrongly rejected by the old 128-char-limited validator)', !throws(() => deriveDeliveryPublicId(nonceA, REALISTIC_STEP2_REMINDER_ID, VALID_INSTALLATION_ID)));
check('[8.B] the derived public ID for that Step 2-format reminderId is deterministic across repeated calls', deriveDeliveryPublicId(nonceA, REALISTIC_STEP2_REMINDER_ID, VALID_INSTALLATION_ID) === deriveDeliveryPublicId(nonceA, REALISTIC_STEP2_REMINDER_ID, VALID_INSTALLATION_ID));

check('[8.C] a slash-containing reminder ID is rejected by isValidReminderId', !isValidReminderId(`${MAX_LENGTH_UID}/extra_1700000000000`));
check('[8.C] deriveDeliveryPublicId fails closed (throws) for a slash-containing reminderId', throws(() => deriveDeliveryPublicId(nonceA, 'reminder/with/slash', VALID_INSTALLATION_ID)));

check(`FIRESTORE_DOCUMENT_ID_MAX_BYTES is exactly 1500`, FIRESTORE_DOCUMENT_ID_MAX_BYTES === 1500);
check('[8.D] a reminderId of exactly 1500 ASCII bytes (the boundary) is valid', isValidFirestoreDocumentId('a'.repeat(1500)));
check('[8.D] a reminderId of 1501 ASCII bytes (one over the Firestore document-ID limit) is REJECTED', !isValidFirestoreDocumentId('a'.repeat(1501)));
check('[8.D] deriveDeliveryPublicId fails closed (throws) for an over-limit reminderId', throws(() => deriveDeliveryPublicId(nonceA, 'a'.repeat(1501), VALID_INSTALLATION_ID)));

check('[8.E] multibyte Unicode reminderId is measured in UTF-8 BYTES, not JS UTF-16 code units: 600 copies of a 3-byte-UTF-8 character (600 JS chars, 1800 bytes) exceeds the limit and is REJECTED even though 600 < 1500', (() => {
  const multibyteChar = '中'; // '中' -- exactly 1 UTF-16 code unit, exactly 3 UTF-8 bytes.
  const nearLimitButOverInBytes = multibyteChar.repeat(600); // 600 JS chars, 1800 UTF-8 bytes.
  return nearLimitButOverInBytes.length === 600 && Buffer.byteLength(nearLimitButOverInBytes, 'utf-8') === 1800 && !isValidFirestoreDocumentId(nearLimitButOverInBytes);
})());
check('[8.E] the same multibyte character repeated only 400 times (400 JS chars, 1200 bytes) stays under the byte limit and IS valid', (() => {
  const multibyteChar = '中';
  const underLimitInBytes = multibyteChar.repeat(400);
  return Buffer.byteLength(underLimitInBytes, 'utf-8') === 1200 && isValidFirestoreDocumentId(underLimitInBytes);
})());

check('[8.F] an unpaired UTF-16 surrogate reminderId is rejected by isValidReminderId', !isValidReminderId('reminder-\uD800-tail'));
check('empty reminderId is rejected', !isValidReminderId(''));
check('"." reminderId is rejected (reserved Firestore document ID)', !isValidReminderId('.'));
check('".." reminderId is rejected (reserved Firestore document ID)', !isValidReminderId('..'));
check('a "__reserved__" shaped reminderId is rejected', !isValidReminderId('__reserved__'));
check('a non-string reminderId (number) is rejected', !isValidReminderId(12345));
check('a null reminderId is rejected', !isValidReminderId(null));

// =========================================================================
// SECOND CODEX REPAIR ROUND — blocker 2: lease-expiry arithmetic overflow.
// =========================================================================
console.log('\n=== [blocker 2] computeDeliveryLeaseExpiresAtMs — overflow protection ===');

check('a normal nowMs produces a normal result', computeDeliveryLeaseExpiresAtMs(1_700_000_000_000) === 1_700_000_000_000 + 5 * 60 * 1000);
check('[blocker 2] nowMs = Number.MAX_SAFE_INTEGER overflows the safe-integer domain once the lease duration is added -> fails closed (throws)', throws(() => computeDeliveryLeaseExpiresAtMs(Number.MAX_SAFE_INTEGER)));
check('[blocker 2] the exact boundary value (MAX_SAFE_INTEGER - lease duration) still succeeds', (() => {
  const boundary = Number.MAX_SAFE_INTEGER - 5 * 60 * 1000;
  const result = computeDeliveryLeaseExpiresAtMs(boundary);
  return result === Number.MAX_SAFE_INTEGER && Number.isSafeInteger(result);
})());
check('[blocker 2] one millisecond past that boundary overflows and fails closed (throws)', (() => {
  const justOverBoundary = Number.MAX_SAFE_INTEGER - 5 * 60 * 1000 + 1;
  return throws(() => computeDeliveryLeaseExpiresAtMs(justOverBoundary));
})());
check('the helper never returns a value its own isValidEpochMs validator would reject', isValidEpochMs(computeDeliveryLeaseExpiresAtMs(1_700_000_000_000)));

// =========================================================================
// SECOND CODEX REPAIR ROUND — blockers 3/4: attempt-history sanitization + strict
// existing-history own-key policy.
// =========================================================================
console.log('\n=== [blockers 3/4] attempt-history: existing-entry sanitization and strict own-key rejection ===');

check('[blocker 4] a well-formed entry with ONLY the 5 allowed own keys still validates (normal case unaffected)', isValidAttemptHistoryEntry(entry1));
check('[blocker 4] an entry carrying one extra own key ("token") is REJECTED outright by isValidAttemptHistoryEntry', !isValidAttemptHistoryEntry({ ...entry1, token: 'RAW-FCM-TOKEN-SECRET' }));
check('[blocker 4] an entry carrying an extra own key ("accessToken") is REJECTED', !isValidAttemptHistoryEntry({ ...entry1, accessToken: 'Bearer SECRET' }));
check('[blocker 4] an entry carrying an extra own key ("providerMessage") is REJECTED', !isValidAttemptHistoryEntry({ ...entry1, providerMessage: 'raw provider text SECRET' }));
check('[blocker 4] an entry carrying an extra own key ("error") is REJECTED', !isValidAttemptHistoryEntry({ ...entry1, error: 'SECRET error text' }));
check('[blocker 4] an entry carrying a nested extra object is REJECTED', !isValidAttemptHistoryEntry({ ...entry1, meta: { nested: 'SECRET' } }));

check('[blocker 4] validateAttemptHistory REJECTS a whole existing history whose entries carry unexpected own fields', (() => {
  const poisonedHistory = [{ ...entry1, token: 'SECRET' }];
  return validateAttemptHistory(poisonedHistory).valid === false;
})());

for (const [label, hostileField] of [
  ['token', { token: 'RAW-FCM-TOKEN-SHOULD-NOT-SURVIVE' }],
  ['accessToken', { accessToken: 'Bearer SECRET-SHOULD-NOT-SURVIVE' }],
  ['providerMessage', { providerMessage: 'raw provider error text SHOULD-NOT-SURVIVE' }],
  ['error', { error: 'SECRET-ERROR-SHOULD-NOT-SURVIVE' }],
  ['nested object', { meta: { deep: { token: 'NESTED-SECRET-SHOULD-NOT-SURVIVE' } } }],
] as const) {
  check(`[blocker 3/4] appendAttemptHistoryEntry REJECTS (returns null) when the EXISTING history's entry carries a hostile "${label}" extra field — never laundered forward`, (() => {
    const poisonedExisting = [{ ...entry1, ...hostileField }];
    const result = appendAttemptHistoryEntry(poisonedExisting, { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
    return result === null;
  })());
}

check('[blocker 3] appendAttemptHistoryEntry sanitizes/reconstructs EVERY existing entry (not just the new one) via the explicit field allowlist — a prototype-chain trick cannot smuggle a secret through', (() => {
  // Not an own-key violation (Object.keys only sees the 5 allowed own keys), but the
  // object's PROTOTYPE carries a hostile `token` property that a plain `entry.token`
  // access would see. sanitizeValidatedAttemptEntry must still produce a clean object
  // whose only prototype is the ordinary Object.prototype.
  const hostileProto = { token: 'PROTOTYPE-SECRET-SHOULD-NOT-SURVIVE' };
  const entryWithHostileProto = Object.create(hostileProto);
  Object.assign(entryWithHostileProto, { ...entry1 });
  const result = appendAttemptHistoryEntry([entryWithHostileProto], { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  if (result === null) return false; // own-keys were fine, so this must succeed.
  const serialized = JSON.stringify(result);
  const protoLeaked = 'token' in result[0]; // `in` traverses the prototype chain.
  return !serialized.includes('PROTOTYPE-SECRET') && !protoLeaked;
})());

check('[blocker 3] normal append still succeeds and produces exactly the 5 allowed keys per entry (regression: strict policy does not break the ordinary case)', (() => {
  const result = appendAttemptHistoryEntry([entry1], { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  if (result === null) return false;
  return result.every((e) => Object.keys(e).length === 5);
})());

check('[blocker 3] aliasing remains severed after the sanitize-reconstruction fix: mutating the original existing entries after append does not alter the result', (() => {
  const original = [{ ...entry1 }];
  const result = appendAttemptHistoryEntry(original, { sendIntentAt: 2000, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2500 });
  if (result === null) return false;
  const before = JSON.stringify(result);
  (original[0] as Record<string, unknown>).outcomeCategory = 'unregistered';
  return JSON.stringify(result) === before;
})());

// =========================================================================
// SECOND CODEX REPAIR ROUND — blocker 5: rollout allowlist members must use the exact
// same UID validator authorization uses; any invalid member invalidates the whole config.
// =========================================================================
console.log('\n=== [blocker 5] rollout allowlist member validation ===');

const OVERLENGTH_UID = 'u'.repeat(129); // one over isValidIdForPath's 128-char limit.

check('[blocker 5] mixed valid+path-shaped ("bad/path") allowlist -> whole config fails closed to paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', 'bad/path'] }).mode === 'paused');
check('[blocker 5] mixed valid+empty-string allowlist -> paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', ''] }).mode === 'paused');
check('[blocker 5] mixed valid+overlength-UID allowlist -> paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', OVERLENGTH_UID] }).mode === 'paused');
check('[blocker 5] mixed valid+number allowlist -> paused', parseRolloutConfig({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', 123] }).mode === 'paused');

check('[blocker 5] decideShouldFanOut: a mixed valid+invalid allowlist must NEVER authorize fanout for the valid user', decideShouldFanOut({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', 'bad/path'] }, 'valid-user').shouldFanOut === false);
check('[blocker 5] decideShouldFanOut: mixed valid+overlength allowlist must NEVER authorize fanout for the valid user', decideShouldFanOut({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', OVERLENGTH_UID] }, 'valid-user').shouldFanOut === false);
check('[blocker 5] decideRealSendAuthorization: a mixed valid+invalid allowlist must NEVER authorize a real send for the valid user', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', 'bad/path'] }, 'valid-user').authorized === false);
check('[blocker 5] decideRealSendAuthorization: mixed valid+empty-string allowlist must NEVER authorize the valid user', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', ''] }, 'valid-user').authorized === false);
check('[blocker 5] decideRealSendAuthorization: mixed valid+number allowlist must NEVER authorize the valid user', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', 123] }, 'valid-user').authorized === false);

check('a fully well-formed allowlist (all valid members) still authorizes correctly (regression check)', decideRealSendAuthorization({ mode: 'allowlisted-real-send', allowlistUids: ['valid-user', 'other-user'] }, 'valid-user').authorized === true);

// =========================================================================
// SECOND CODEX REPAIR ROUND — blockers 6/7: fanout-tuple own-property validation.
// =========================================================================
console.log('\n=== [blockers 6/7] validateFanoutTuple — own-property (not merely inherited) validation ===');

check('[blocker 6] a tuple with ALL required success fields present only via the PROTOTYPE (none as own properties) is REJECTED', (() => {
  const hostileTuple = Object.create({
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
  });
  return validateFanoutTuple(hostileTuple).valid === false;
})());
check('[blocker 6] `status` present only via the prototype (own properties otherwise complete) is REJECTED', (() => {
  const hostileTuple = Object.create({ status: 'delivery-fanned-out' });
  Object.assign(hostileTuple, { deliveryFanoutState: 'completed', targetInstallationCountAtFanout: 2, excludedMalformedInstallationCount: 0 });
  return validateFanoutTuple(hostileTuple).valid === false;
})());
check('[blocker 6] `deliveryFanoutState` present only via the prototype (everything else own) is REJECTED', (() => {
  const hostileTuple = Object.create({ deliveryFanoutState: 'completed' });
  Object.assign(hostileTuple, { status: 'delivery-fanned-out', targetInstallationCountAtFanout: 2, excludedMalformedInstallationCount: 0 });
  return validateFanoutTuple(hostileTuple).valid === false;
})());
check('[blocker 6] `targetInstallationCountAtFanout` present only via the prototype is REJECTED', (() => {
  const hostileTuple = Object.create({ targetInstallationCountAtFanout: 2 });
  Object.assign(hostileTuple, { status: 'delivery-fanned-out', deliveryFanoutState: 'completed', excludedMalformedInstallationCount: 0 });
  return validateFanoutTuple(hostileTuple).valid === false;
})());
check('[blocker 6] `targetingFailureReason` present only via the prototype on an otherwise-valid "failed" tuple is REJECTED (own-`targetingFailureReason` is mandatory for failed)', (() => {
  const hostileTuple = Object.create({ targetingFailureReason: 'unexpected-preexisting-delivery' });
  Object.assign(hostileTuple, { status: 'delivery-fanned-out', deliveryFanoutState: 'failed' });
  return validateFanoutTuple(hostileTuple).valid === false;
})());
check('[blocker 6] `observedTargetCountAtLeast` present only via the prototype on an otherwise-valid over-cap tuple is REJECTED', (() => {
  const hostileTuple = Object.create({ observedTargetCountAtLeast: FANOUT_QUERY_LIMIT });
  Object.assign(hostileTuple, { status: 'delivery-fanned-out', deliveryFanoutState: 'failed', targetingFailureReason: 'installation-count-exceeds-cap' });
  return validateFanoutTuple(hostileTuple).valid === false;
})());
check('[blocker 6] a MIXED own/inherited tuple (some fields own, some only inherited) never validates solely because of the inherited ones', (() => {
  // status/deliveryFanoutState/excludedMalformedInstallationCount are genuine own
  // properties; targetInstallationCountAtFanout is ONLY on the prototype.
  const hostileTuple = Object.create({ targetInstallationCountAtFanout: 2 });
  Object.assign(hostileTuple, { status: 'delivery-fanned-out', deliveryFanoutState: 'completed', excludedMalformedInstallationCount: 0 });
  return validateFanoutTuple(hostileTuple).valid === false;
})());

check('a fully well-formed, all-own-properties success tuple still validates (regression check)', (() => {
  const tuple = {
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
  };
  return validateFanoutTuple(tuple).valid === true;
})());
check('an inherited `targetingFailureReason` on an otherwise-valid COMPLETED tuple does not falsely trigger completed-with-failure-reason (inherited is correctly ignored, not treated as present)', (() => {
  const tupleWithInheritedNoise = Object.create({ targetingFailureReason: 'installation-count-exceeds-cap' });
  Object.assign(tupleWithInheritedNoise, {
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 2,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
  });
  return validateFanoutTuple(tupleWithInheritedNoise).valid === true;
})());

// =========================================================================
// PHASE 3A-3 STEP 3C-4 — STAGED REAL-SEND AUTHORIZATION, SENDING-INTENT COMMIT SHAPE,
// ACTIVE-SEND-INTENT FENCE, AND RETRY BACKOFF.
// =========================================================================
console.log('\n=== decideStagedRealSendAuthorization ===');

// 'disabled' short-circuits BEFORE even parsing the rollout config (a deliberately
// stronger property than "authorization would fail anyway" — see the file's own comment
// on decideStagedRealSendAuthorization), so it always reports 'stage-disabled' regardless
// of what the rollout mode actually is. The OTHER two stages defer to
// decideRealSendAuthorization's own paused/dry-run-only reasons, since those stages do
// parse the rollout first.
const NON_DISABLED_STAGES: RealDeliveryStage[] = ['allowlisted-only', 'general'];

check("[3C-4] stage='disabled': paused rollout -> reason 'stage-disabled' (stage always wins first, regardless of rollout mode)", (() => {
  const d = decideStagedRealSendAuthorization('disabled', { mode: 'paused' }, 'user-1');
  return d.authorized === false && d.reason === 'stage-disabled';
})());
check("[3C-4] stage='disabled': dry-run rollout -> reason 'stage-disabled' (same — stage always wins first)", (() => {
  const d = decideStagedRealSendAuthorization('disabled', { mode: 'dry-run' }, 'user-1');
  return d.authorized === false && d.reason === 'stage-disabled';
})());

for (const stage of NON_DISABLED_STAGES) {
  check(`[3C-4] stage=${stage}: paused rollout -> never authorized (reason 'paused')`, (() => {
    const d = decideStagedRealSendAuthorization(stage, { mode: 'paused' }, 'user-1');
    return d.authorized === false && d.reason === 'paused';
  })());
  check(`[3C-4] stage=${stage}: dry-run rollout -> never authorized (reason 'dry-run-only')`, (() => {
    const d = decideStagedRealSendAuthorization(stage, { mode: 'dry-run' }, 'user-1');
    return d.authorized === false && d.reason === 'dry-run-only';
  })());
}

check("[3C-4] stage='disabled': allowlisted-real-send, uid ON allowlist -> still never authorized (reason 'stage-disabled', NOT 'not-allowlisted' — stage check runs first)", (() => {
  const d = decideStagedRealSendAuthorization('disabled', { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, 'user-1');
  return d.authorized === false && d.reason === 'stage-disabled';
})());
check("[3C-4] stage='disabled': general-real-send -> never authorized (reason 'stage-disabled')", (() => {
  const d = decideStagedRealSendAuthorization('disabled', { mode: 'general-real-send' }, 'user-1');
  return d.authorized === false && d.reason === 'stage-disabled';
})());
check("[3C-4] stage='disabled': malformed rollout entirely -> never authorized (reason 'stage-disabled' — short-circuits before even parsing)", (() => {
  const d = decideStagedRealSendAuthorization('disabled', 'garbage', 'user-1');
  return d.authorized === false && d.reason === 'stage-disabled';
})());

check("[3C-4] stage='allowlisted-only': allowlisted-real-send, uid ON allowlist -> authorized", (() => {
  const d = decideStagedRealSendAuthorization('allowlisted-only', { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, 'user-1');
  return d.authorized === true;
})());
check("[3C-4] stage='allowlisted-only': allowlisted-real-send, uid NOT on allowlist -> not authorized (reason 'not-allowlisted')", (() => {
  const d = decideStagedRealSendAuthorization('allowlisted-only', { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] }, 'user-1');
  return d.authorized === false && d.reason === 'not-allowlisted';
})());
check("[3C-4] stage='allowlisted-only': general-real-send -> NOT authorized even though the underlying rollout mode itself would be authorized at stage='general' (reason 'mode-not-permitted-at-current-stage')", (() => {
  const d = decideStagedRealSendAuthorization('allowlisted-only', { mode: 'general-real-send' }, 'user-1');
  return d.authorized === false && d.reason === 'mode-not-permitted-at-current-stage';
})());
check("[3C-4] stage='allowlisted-only': malformed uid against an otherwise-valid allowlisted-real-send -> not authorized (reason 'invalid-uid')", (() => {
  const d = decideStagedRealSendAuthorization('allowlisted-only', { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, { not: 'a string' });
  return d.authorized === false && d.reason === 'invalid-uid';
})());

check("[3C-4] stage='general': general-real-send -> authorized", (() => {
  const d = decideStagedRealSendAuthorization('general', { mode: 'general-real-send' }, 'user-1');
  return d.authorized === true;
})());
check("[3C-4] stage='general': allowlisted-real-send, uid ON allowlist -> STILL authorized (general stage permits allowlisted mode too)", (() => {
  const d = decideStagedRealSendAuthorization('general', { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, 'user-1');
  return d.authorized === true;
})());
check("[3C-4] stage='general': allowlisted-real-send, uid NOT on allowlist -> not authorized (allowlist membership still enforced even at the most permissive stage)", (() => {
  const d = decideStagedRealSendAuthorization('general', { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] }, 'user-1');
  return d.authorized === false && d.reason === 'not-allowlisted';
})());

console.log('\n=== buildDeliverySendingIntentFields ===');

check('[3C-4] returns the exact fixed shape: state sending, terminal work tuple, and the three intent fields verbatim', (() => {
  const fields = buildDeliverySendingIntentFields(VALID_FANOUT_EXECUTION_ID, 2, 1700000000000);
  return (
    fields.state === 'sending' &&
    fields.workState === 'terminal' &&
    fields.workAvailableAt === null &&
    fields.leaseExpiresAt === null &&
    fields.sendExecutionId === VALID_FANOUT_EXECUTION_ID &&
    fields.sendAttemptCount === 2 &&
    fields.sendIntentAtMs === 1700000000000
  );
})());
check('[3C-4] returned shape has exactly the expected 7 own keys — no stray fields', (() => {
  const fields = buildDeliverySendingIntentFields(VALID_FANOUT_EXECUTION_ID, 1, 1700000000000);
  const keys = Object.keys(fields).sort();
  return JSON.stringify(keys) === JSON.stringify(['leaseExpiresAt', 'sendAttemptCount', 'sendExecutionId', 'sendIntentAtMs', 'state', 'workAvailableAt', 'workState'].sort());
})());

console.log('\n=== isMatchingActiveSendIntent ===');

const VALID_SEND_INTENT_AT_MS = 1700000000000;

function activeSendIntentDoc(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: 'sending', sendAttemptCount: 1, sendExecutionId: VALID_FANOUT_EXECUTION_ID, sendIntentAtMs: VALID_SEND_INTENT_AT_MS, ...overrides };
}
function matches(docOverrides: Record<string, unknown>, expectedCount: unknown = 1, expectedId: unknown = VALID_FANOUT_EXECUTION_ID, expectedIntentAtMs: unknown = VALID_SEND_INTENT_AT_MS): boolean {
  return isMatchingActiveSendIntent(activeSendIntentDoc(docOverrides), expectedCount, expectedId, expectedIntentAtMs);
}

check('[3C-4] exact match on state+count+executionId+sendIntentAtMs -> true', matches({}));
check("[3C-4] state !== 'sending' (e.g. still 'preparing') -> false even with everything else matching", !matches({ state: 'preparing' }));
check("[3C-4] state !== 'sending' (e.g. already terminal 'accepted-by-fcm') -> false", !matches({ state: 'accepted-by-fcm' }));
check('[3C-4] sendAttemptCount mismatch (doc has 2, expected 1) -> false — proves a DIFFERENT, later-authorized intent is not silently accepted', !matches({ sendAttemptCount: 2 }));
check('[3C-4] sendExecutionId mismatch (different opaque ID, same count) -> false', !matches({ sendExecutionId: VALID_FANOUT_EXECUTION_ID_2 }));
check('[3C-4] malformed expectedSendAttemptCount (0, below the valid 1..MAX_SEND_ATTEMPTS domain) -> false, never coincidentally matches', !matches({ sendAttemptCount: 0 }, 0));
check('[3C-4] malformed expectedSendExecutionId (not opaque-ID-shaped) -> false, never coincidentally matches', !matches({ sendExecutionId: 'not-opaque' }, 1, 'not-opaque'));
check('[3C-4] malformed document sendAttemptCount (string) does not coincidentally satisfy strict equality against a valid expected count', !matches({ sendAttemptCount: '1' }));

// CODEX REPAIR ROUND (Step 3C-4, blocker 2) — sendIntentAtMs is now part of the complete
// fenced identity, not merely the other two fields.
check('[3C-4] persisted sendIntentAtMs differs by exactly +1ms -> false (proves the fence is exact equality, not a tolerance window)', !matches({ sendIntentAtMs: VALID_SEND_INTENT_AT_MS + 1 }));
check('[3C-4] persisted sendIntentAtMs malformed (negative) -> false, never coincidentally matches', !matches({ sendIntentAtMs: -1 }));
check('[3C-4] persisted sendIntentAtMs malformed (non-integer) -> false', !matches({ sendIntentAtMs: 1.5 }));
check('[3C-4] persisted sendIntentAtMs missing entirely -> false', !matches({ sendIntentAtMs: undefined }));
check('[3C-4] persisted sendIntentAtMs null -> false', !matches({ sendIntentAtMs: null }));
check(
  '[3C-4] expected sendIntentAtMs wrong while state/count/executionId all match the document -> false (proves sendIntentAtMs is independently REQUIRED, not merely checked when the others fail)',
  !matches({}, 1, VALID_FANOUT_EXECUTION_ID, VALID_SEND_INTENT_AT_MS + 999)
);
check('[3C-4] malformed expected sendIntentAtMs (string) -> false', !matches({}, 1, VALID_FANOUT_EXECUTION_ID, 'not-a-number'));

console.log('\n=== computeDeliveryRetryAvailableAtMs / DELIVERY_RETRY_BACKOFF_MS ===');

check('[3C-4] DELIVERY_RETRY_BACKOFF_MS is bounded and nonzero', DELIVERY_RETRY_BACKOFF_MS > 0 && DELIVERY_RETRY_BACKOFF_MS < 5 * 60 * 1000);
check('[3C-4] computeDeliveryRetryAvailableAtMs(now) === now + DELIVERY_RETRY_BACKOFF_MS exactly', computeDeliveryRetryAvailableAtMs(1700000000000) === 1700000000000 + DELIVERY_RETRY_BACKOFF_MS);
check('[3C-4] computeDeliveryRetryAvailableAtMs throws on malformed nowMs (negative)', throws(() => computeDeliveryRetryAvailableAtMs(-1)));
check('[3C-4] computeDeliveryRetryAvailableAtMs throws on malformed nowMs (non-integer)', throws(() => computeDeliveryRetryAvailableAtMs(1.5)));
check('[3C-4] computeDeliveryRetryAvailableAtMs throws on overflow (nowMs near MAX_SAFE_INTEGER)', throws(() => computeDeliveryRetryAvailableAtMs(Number.MAX_SAFE_INTEGER)));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
