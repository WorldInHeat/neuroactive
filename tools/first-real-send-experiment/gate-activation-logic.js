// gate-activation-logic.js — FOR REVIEW ONLY. NOT EXECUTED as a mutation path.
//
// PURE, directly-unit-testable decision functions for the gate-aware first-real-send
// activation controller (Step 3C-9). Zero Firestore/network access anywhere in this file —
// every function here is a plain function of its inputs, exactly like
// reminderDeliveryLogic.ts's own pure-decision functions that armGate.js and
// reminderDeliverySender.ts already reuse rather than reimplement. Never prints anything;
// never accepts or returns UID/reminderId/installationId as a bare label meant for display
// (callers are responsible for never logging the values these functions operate on).
'use strict';

const { createHash, randomBytes } = require('node:crypto');

// ---------------------------------------------------------------------------------------
// APPROVED CENSUS / SCHEDULE BASELINES — Codex Step 3C-9 repair pass 2, items 2 and 5.
// Hardcoded to the exact values Codex reviewed. Deliberately NOT auto-derived from
// whatever production happens to show at run time — if production has since drifted, the
// controller must fail closed and require a fresh review, never silently adopt new
// "expected" values.
// ---------------------------------------------------------------------------------------
const APPROVED_CENSUS_BASELINE = Object.freeze({
  reminders: Object.freeze({ total: 7, terminal: 7, nonterminal: 0 }),
  deliveries: Object.freeze({ total: 4, terminal: 4, nonterminal: 0 }),
});

function isApprovedCensusBaseline(counts) {
  if (!counts || !counts.reminders || !counts.deliveries) return false;
  const r = counts.reminders;
  const d = counts.deliveries;
  const R = APPROVED_CENSUS_BASELINE.reminders;
  const D = APPROVED_CENSUS_BASELINE.deliveries;
  return r.total === R.total && r.terminal === R.terminal && r.nonterminal === R.nonterminal && d.total === D.total && d.terminal === D.terminal && d.nonterminal === D.nonterminal;
}

const APPROVED_SCHEDULE_BASELINE = Object.freeze({
  revision: 8,
  scheduleType: 'daily',
  weekdays: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  localTime: '21:15',
  timezone: 'America/Chicago',
});

function isApprovedScheduleBaseline(schedule) {
  if (!schedule) return false;
  const S = APPROVED_SCHEDULE_BASELINE;
  return (
    schedule.revision === S.revision &&
    schedule.scheduleType === S.scheduleType &&
    JSON.stringify(schedule.weekdays) === JSON.stringify(S.weekdays) &&
    schedule.localTime === S.localTime &&
    schedule.timezone === S.timezone
  );
}

// ---------------------------------------------------------------------------------------
// TIMING WINDOW — Codex Step 3C-9 section 10. Activation is legal only in a narrow window
// 10-15 minutes before the exact bound occurrence; the independent watchdog's absolute
// containment deadline is 20 minutes after it.
// ---------------------------------------------------------------------------------------
const ACTIVATION_WINDOW_MIN_MS = 10 * 60 * 1000;
const ACTIVATION_WINDOW_MAX_MS = 15 * 60 * 1000;
const CONTAINMENT_DEADLINE_AFTER_MS = 20 * 60 * 1000;

function computeActivationTiming(nowMs, scheduledForMs) {
  const remainingMs = scheduledForMs - nowMs;
  return {
    remainingMs,
    tooEarly: remainingMs > ACTIVATION_WINDOW_MAX_MS,
    tooLate: remainingMs < ACTIVATION_WINDOW_MIN_MS,
    containmentDeadlineMs: scheduledForMs + CONTAINMENT_DEADLINE_AFTER_MS,
  };
}

function isWithinActivationWindow(nowMs, scheduledForMs) {
  const t = computeActivationTiming(nowMs, scheduledForMs);
  return !t.tooEarly && !t.tooLate;
}

function isPastContainmentDeadline(nowMs, containmentDeadlineMs) {
  return nowMs >= containmentDeadlineMs;
}

// Codex repair pass 3, item 10: no controller observation loop may keep experiment rollout
// open beyond the ABSOLUTE containment deadline, regardless of any locally-requested/default
// observation budget that would otherwise extend further.
function capObservationDeadline(locallyRequestedObservationDeadlineMs, containmentDeadlineMs) {
  return Math.min(locallyRequestedObservationDeadlineMs, containmentDeadlineMs);
}

// ---------------------------------------------------------------------------------------
// GATE VALIDATION — the eight-field reviewed schema plus the specific "armed, unconsumed"
// state values. `validateExperimentGateSchema` (imported by the IO layer from the real
// committed functions/lib/reminderDeliveryAuth.js) checks field shape/types; this adds the
// state-VALUE requirements the controller specifically needs before it may ever consider
// activating.
// ---------------------------------------------------------------------------------------
function isArmedUnconsumedGate(data, schemaValidator) {
  if (!data) return false;
  if (!schemaValidator(data).valid) return false;
  return data.state === 'armed' && data.consumedAt === null && data.consumedByExecutionId === null;
}

// Cheap, non-authoritative check only — "looks consumed." NEVER sufficient on its own to
// drive outcome classification; see isValidConsumedGateBoundTo below for the real,
// full-schema, identity-bound check required before any consumed gate may be trusted.
function isConsumedGate(data) {
  return !!data && data.state === 'consumed';
}

// Codex repair pass 3, item 11: a document merely containing state:'consumed' is not
// sufficient evidence of a legitimate consumption — the FULL reviewed schema (via the real
// committed validateExperimentGateSchema, which for state==='consumed' also requires a valid
// consumedAt Timestamp no earlier than createdAt and a well-formed opaque
// consumedByExecutionId) must validate, AND every identity field must still match the T0
// experiment target. A partial/malformed/drifted "consumed-looking" document must be
// rejected here, never treated as a normal accepted/rejected/429 outcome.
function gateIdentityMatches(data, expectedGate) {
  return (
    !!data &&
    data.expectedUid === expectedGate.expectedUid &&
    data.expectedReminderId === expectedGate.expectedReminderId &&
    data.expectedScheduledForMs === expectedGate.expectedScheduledForMs &&
    data.expectedInstallationId === expectedGate.expectedInstallationId
  );
}

function isValidConsumedGateBoundTo(data, expectedGate, schemaValidator) {
  if (!data) return false;
  if (!schemaValidator(data).valid) return false;
  if (data.state !== 'consumed') return false;
  return gateIdentityMatches(data, expectedGate);
}

// Codex repair pass 4, item 10: EVERY post-activation observation must classify the gate
// into exactly one of three states — never left as an implicit "not consumed yet, so keep
// waiting" default, which previously let a missing/deleted/malformed/re-identified gate go
// undetected until the deadline. 'armed' is the only state in which continued bounded
// observation is safe; 'consumed' triggers immediate pause + normal outcome classification;
// anything else ('drift') triggers immediate pause + an ambiguous-drift classification, no
// repair, no resend, STOP after containment is verified.
function classifyGateDriftState(gateData, expectedGate, schemaValidator) {
  if (isArmedUnconsumedGate(gateData, schemaValidator) && gateIdentityMatches(gateData, expectedGate)) return 'armed';
  if (isValidConsumedGateBoundTo(gateData, expectedGate, schemaValidator)) return 'consumed';
  return 'drift';
}

// ---------------------------------------------------------------------------------------
// ROLLOUT SOURCE/DESTINATION STATE — exact-shape checks, no tolerance for a superset.
// ---------------------------------------------------------------------------------------
function isExactlyPausedRollout(data) {
  return !!data && data.mode === 'paused' && Object.keys(data).length === 1;
}

function isExactlyAllowlistedForUid(data, uid) {
  return (
    !!data &&
    data.mode === 'allowlisted-real-send' &&
    Array.isArray(data.allowlistUids) &&
    data.allowlistUids.length === 1 &&
    data.allowlistUids[0] === uid &&
    Object.keys(data).length === 2
  );
}

// Builds the exact future activation payload. The UID must be internally derived from an
// already-validated gate — never hardcoded, never CLI-supplied, never printed by any caller.
function buildAllowlistedRolloutPayload(uid, isValidIdForPath) {
  if (!isValidIdForPath(uid)) {
    throw new Error('gate-activation-logic: refusing to build an activation payload for a structurally invalid uid.');
  }
  return { mode: 'allowlisted-real-send', allowlistUids: [uid] };
}

const PAUSED_ROLLOUT_PAYLOAD = Object.freeze({ mode: 'paused' });

// ---------------------------------------------------------------------------------------
// MUTATION-AMBIGUITY RESOLUTION — Codex section 12. After ANY ambiguous activation-mutation
// result, the controller must inspect rollout read-only and classify into exactly one of
// these three outcomes — never retry blindly.
// ---------------------------------------------------------------------------------------
function classifyPostActivationRolloutState(rolloutData, uid) {
  if (isExactlyAllowlistedForUid(rolloutData, uid)) return 'activation-committed';
  if (isExactlyPausedRollout(rolloutData)) return 'activation-not-committed';
  return 'unexpected-rollout-state';
}

// Codex repair pass 2, item 10: pause/containment classification must NEVER collapse every
// non-paused outcome into a single "not committed" bucket — a rollout that is still exactly
// the reviewed one-UID allowlist for expectedUid is a DIFFERENT, safe-to-wait situation than
// one showing a different UID, multiple UIDs, general-real-send, or a malformed shape (which
// must never be silently overwritten). Three-way classification, bound to expectedUid.
function classifyRolloutContainmentState(rolloutData, expectedUid) {
  if (isExactlyPausedRollout(rolloutData)) return 'paused';
  if (isExactlyAllowlistedForUid(rolloutData, expectedUid)) return 'still-allowlisted-for-expected-uid';
  return 'unexpected-rollout-state';
}

// Retained for callers that only need a binary paused/not-paused signal (e.g. the
// activation-mutation ambiguity resolver, which is checking for a DIFFERENT pair of exact
// states — see classifyPostActivationRolloutState). Deliberately thin: delegates to the
// three-way classifier so the two never drift apart.
function classifyPostPauseRolloutState(rolloutData, expectedUid) {
  const c = classifyRolloutContainmentState(rolloutData, expectedUid);
  return c === 'paused' ? 'pause-committed' : 'pause-not-committed';
}

// ---------------------------------------------------------------------------------------
// OUTCOME MODEL — Codex section 11, letters A-F. A pure classification of what the
// controlled child delivery/gate pair currently shows. Never inspects any OTHER delivery —
// callers must pass only the exact controlled child bound by the gate (see
// isControlledDeliveryPath below).
// ---------------------------------------------------------------------------------------
function classifyControlledOutcome(gateData, deliveryData) {
  if (!isConsumedGate(gateData)) {
    return { kind: 'F-pending', requiresPause: false, terminal: false };
  }
  // From here, gate.state === 'consumed' — pause-on-consumption always applies, regardless
  // of delivery outcome or even delivery existence (Codex section 8: do not wait for the
  // external FCM outcome before pausing).
  if (!deliveryData) {
    return { kind: 'D-stranded-ambiguous', requiresPause: true, terminal: false, noRepair: true };
  }
  switch (deliveryData.state) {
    case 'accepted-by-fcm':
      return { kind: 'A-accepted', requiresPause: true, terminal: true };
    case 'rejected-final':
      return { kind: 'B-permanent-failure', requiresPause: true, terminal: true };
    case 'unknown-outcome':
      return { kind: 'C-unknown-ambiguous', requiresPause: true, terminal: true };
    case 'sending':
      return { kind: 'D-stranded-sending', requiresPause: true, terminal: false, noRepair: true };
    case 'cancelled': {
      // Codex repair pass 2, item 11: `cancelled` alone is NOT sufficient evidence of the
      // coherent-429-then-gate-consumed sequence. Only classify the specific, well-evidenced
      // outcome when ALL of the exact non-secret fields agree: exactly one prior send
      // attempt, that attempt's own history entry categorized as retryable-later (proving a
      // real transport call was made and FCM's response was the coherent 429, not silence),
      // and no evidence of a second physical attempt (sendAttemptCount frozen at 1). Anything
      // short of that full agreement is an unexplained/ambiguous cancellation — still
      // requires pause, still no repair, but must never be mislabeled as the known-safe
      // experimental outcome.
      const history = Array.isArray(deliveryData.attemptHistory) ? deliveryData.attemptHistory : null;
      const isCoherent429Evidence =
        deliveryData.cancelReason === 'experiment-gate-consumed' &&
        deliveryData.sendAttemptCount === 1 &&
        history !== null &&
        history.length === 1 &&
        history[0] &&
        history[0].outcomeCategory === 'retryable-later';
      if (isCoherent429Evidence) {
        return { kind: 'E-coherent-cancelled-after-retry', requiresPause: true, terminal: true };
      }
      return { kind: 'E-ambiguous-cancellation', requiresPause: true, terminal: false, noRepair: true };
    }
    case 'queued':
      // Transiently observable between the coherent-429 requeue and the second worker's
      // cancellation write. Not yet a final answer; pause still applies immediately.
      return { kind: 'E-pending-cancellation', requiresPause: true, terminal: false };
    default:
      return { kind: 'D-stranded-ambiguous', requiresPause: true, terminal: false, noRepair: true };
  }
}

// ---------------------------------------------------------------------------------------
// CONTROLLED-CHILD TARGETING — Codex section 7. The observer must bind to the EXACT
// occurrence/installation the gate names, never "newest delivery after timestamp" logic.
// ---------------------------------------------------------------------------------------
function isControlledDeliveryPath(candidatePath, appId, expectedReminderId, expectedInstallationId) {
  const expected = `artifacts/${appId}/reminders/${expectedReminderId}/deliveries/${expectedInstallationId}`;
  return candidatePath === expected;
}

// ---------------------------------------------------------------------------------------
// WATCHDOG READINESS HANDSHAKE — Codex repair pass 3, items 4-6. A binding hash over the
// exact experiment identity (never the raw identifiers themselves), PLUS a controller-
// generated per-run challenge, a watchdog-generated nonce, and the watchdog's own PID —
// every field must match exactly, on TWO separate reads separated by a bounded wait, with
// the heartbeat strictly advancing between them and the reported PID verified alive at the
// OS level both times. A single fresh-looking snapshot is deliberately NOT sufficient
// (Codex's own finding: a killed watchdog's last-written file still LOOKS fresh for up to
// its heartbeat-interval worth of time) — only genuine progression across two reads proves
// the process is still actually alive and iterating, not merely recently dead.
// ---------------------------------------------------------------------------------------
function buildExperimentBindingHash(gate) {
  const canonical = JSON.stringify({
    uid: gate.expectedUid,
    reminderId: gate.expectedReminderId,
    installationId: gate.expectedInstallationId,
    scheduledForMs: gate.expectedScheduledForMs,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

// Cryptographically strong, unpredictable per-run challenge. The controller generates
// exactly one of these per orchestration run and passes it to the watchdog at launch time
// (never printed in ordinary output); a readiness artifact from ANY other run — including an
// immediately prior run for the exact same experiment — carries a different challenge and so
// can never satisfy the current run's verification.
function generateChallenge() {
  return randomBytes(32).toString('hex');
}

function buildReadinessExpectation(gate, challenge, absoluteDeadlineMs) {
  return {
    expectedChallenge: challenge,
    expectedBindingHash: buildExperimentBindingHash(gate),
    expectedDeadlineMs: absoluteDeadlineMs,
  };
}

// Structural/identity match only — does NOT check heartbeat freshness or PID liveness (see
// the separate functions below); kept as its own check so a mismatch on identity can be
// distinguished (in caller diagnostics) from a mismatch on liveness.
function readinessMatchesExpectation(readiness, expectation) {
  return (
    !!readiness &&
    readiness.challenge === expectation.expectedChallenge &&
    readiness.experimentBindingHash === expectation.expectedBindingHash &&
    readiness.absoluteDeadlineMs === expectation.expectedDeadlineMs
  );
}

function readinessHeartbeatFresh(readiness, nowMs, maxHeartbeatAgeMs) {
  return (
    !!readiness &&
    typeof readiness.heartbeatAtMs === 'number' &&
    nowMs - readiness.heartbeatAtMs >= 0 &&
    nowMs - readiness.heartbeatAtMs <= maxHeartbeatAgeMs
  );
}

// Codex repair pass 3, item 6: requires the SAME challenge/nonce/pid/binding/deadline across
// both reads (proving it is the same live watchdog instance, not a replaced/restarted one),
// AND a strictly later heartbeat on the second read (proving genuine progression, not a
// frozen file left behind by a process that already died).
function readinessAdvanced(r1, r2) {
  return (
    !!r1 &&
    !!r2 &&
    r1.challenge === r2.challenge &&
    r1.nonce === r2.nonce &&
    r1.pid === r2.pid &&
    r1.experimentBindingHash === r2.experimentBindingHash &&
    r1.absoluteDeadlineMs === r2.absoluteDeadlineMs &&
    typeof r1.heartbeatAtMs === 'number' &&
    typeof r2.heartbeatAtMs === 'number' &&
    r2.heartbeatAtMs > r1.heartbeatAtMs
  );
}

// OS-level PID liveness check, Windows-safe: Node's process.kill(pid, 0) sends no actual
// signal (0 is the "check existence" pseudo-signal on both POSIX and the Node/libuv Windows
// shim) — it throws ESRCH if no such process exists, or (rarely, cross-user) EPERM if it
// exists but this process lacks permission to signal it, which still proves existence.
function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return !!err && err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------------------
// ACTIVATION-AMBIGUITY CLASSIFICATION — Codex repair pass 2, item 13. Distinguishes a
// KNOWN, definite transaction-precondition failure (the callback itself threw the fixed
// sentinel this design uses for "preconditions were not met" — the transaction provably
// never reached its write) from a genuinely uncertain SDK/process-level failure (network
// error, process crash, unknown exception) where the commit outcome cannot be assumed.
// ---------------------------------------------------------------------------------------
const KNOWN_PRECONDITION_SENTINELS = Object.freeze(['activation-precondition-failed', 'pause-precondition-failed']);

function classifyTransactionFailure(errorMessage) {
  if (KNOWN_PRECONDITION_SENTINELS.includes(errorMessage)) return 'definite-noncommit';
  return 'genuinely-uncertain';
}

// ---------------------------------------------------------------------------------------
// FCM/TRANSPORT EVIDENCE — Codex Step 3C-9 repair pass 5, item 3. The approved census
// baseline (total/terminal/nonterminal counts) alone does NOT distinguish a delivery in
// 'dry-run-validated' (terminal, no transport ever attempted) from one in 'accepted-by-fcm'/
// 'rejected-final'/'unknown-outcome' (also terminal, but each PROVES a real FCM call was
// made) — a state change among terminal deliveries could pass the count-only baseline check
// undetected. This explicit state-level check closes that gap.
// ---------------------------------------------------------------------------------------
const FCM_EVIDENCE_DELIVERY_STATES = Object.freeze(['sending', 'accepted-by-fcm', 'rejected-final', 'unknown-outcome']);

function hasZeroFcmEvidence(deliveryStateBreakdown) {
  if (!deliveryStateBreakdown) return false;
  return FCM_EVIDENCE_DELIVERY_STATES.every((s) => (deliveryStateBreakdown[s] || 0) === 0);
}

module.exports = {
  ACTIVATION_WINDOW_MIN_MS,
  ACTIVATION_WINDOW_MAX_MS,
  CONTAINMENT_DEADLINE_AFTER_MS,
  PAUSED_ROLLOUT_PAYLOAD,
  APPROVED_CENSUS_BASELINE,
  isApprovedCensusBaseline,
  APPROVED_SCHEDULE_BASELINE,
  isApprovedScheduleBaseline,
  computeActivationTiming,
  isWithinActivationWindow,
  isPastContainmentDeadline,
  capObservationDeadline,
  isArmedUnconsumedGate,
  isConsumedGate,
  gateIdentityMatches,
  isValidConsumedGateBoundTo,
  classifyGateDriftState,
  isExactlyPausedRollout,
  isExactlyAllowlistedForUid,
  buildAllowlistedRolloutPayload,
  classifyPostActivationRolloutState,
  classifyRolloutContainmentState,
  classifyPostPauseRolloutState,
  classifyControlledOutcome,
  isControlledDeliveryPath,
  buildExperimentBindingHash,
  generateChallenge,
  buildReadinessExpectation,
  readinessMatchesExpectation,
  readinessHeartbeatFresh,
  readinessAdvanced,
  isPidAlive,
  classifyTransactionFailure,
  FCM_EVIDENCE_DELIVERY_STATES,
  hasZeroFcmEvidence,
};
