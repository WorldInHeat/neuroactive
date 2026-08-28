// activation-controller.js — FOR REVIEW ONLY. NOT EXECUTED. Codex Step 3C-9 repair pass 3.
//
// REPAIR PASS 3 changes on top of everything below (see rollout-mutation.js/gate-
// activation-logic.js for the shared machinery this file now delegates to instead of
// duplicating): (1) activation/pause mutations now return an EXPLICIT discriminated
// {outcome:'committed'|'definite-noncommit'|'ambiguous'} result — ambiguous:false is no
// longer used as a proxy for "committed", closing the gap where a definite noncommit could
// be treated as successful activation; (2) the watchdog readiness handshake now requires a
// controller-generated per-run challenge, a watchdog nonce, PID, and OS-level PID-liveness
// verification, PLUS observed heartbeat ADVANCEMENT across two reads (a single fresh-looking
// snapshot from an already-dead watchdog is no longer sufficient); (3) that full readiness
// check is repeated IMMEDIATELY before the activation transaction, not only once, early; (4)
// pause/containment now uses bounded retry/backoff (never activation retry) with an explicit
// terminal hard-containment-failure result when the retry horizon is exhausted while rollout
// is still exactly the expected experiment allowlist; (5) controller observation can never
// exceed the absolute containment deadline (gate.expectedScheduledForMs + 20 min), regardless
// of any larger locally-requested/default budget; (6) a gate merely containing
// state:'consumed' is no longer trusted at face value — full schema + identity-binding
// validation is required before any accepted/rejected/429 outcome is ever classified.
//
// The gate-aware first-real-send activation controller. Distinct from, and does NOT import
// or reuse, the old scratchpad realsend-controller. Reuses armGate.js's own reviewed
// preflight/ADC-binding-checkpoint machinery (runPreflight, performAdcBindingCheckpoint,
// PROJECT_ID), and gate-io.js's shared, read-only gate/installation/census helpers (shared
// with activation-watchdog.js so the two independent processes validate identically rather
// than diverging). All outcome/timing/mutation-payload/containment-classification DECISIONS
// are delegated to gate-activation-logic.js's pure functions.
//
// DERIVES ALL SENSITIVE IDENTIFIERS FROM PRODUCTION STATE. Accepts no UID, reminderId,
// installationId, token, or occurrence identity as a command-line parameter anywhere, and
// never prints any of them — only booleans, counts, timestamps, and fixed labels.
//
// STRUCTURAL NO-EXECUTION GUARD: this file exports every function below for review/testing,
// but its own `require.main === module` entry point (at the bottom) performs ONLY a
// read-only preflight dry-run and then refuses to proceed — it never calls
// attemptActivationMutation, attemptPauseMutation, or runControllerOrchestration. Running
// `node activation-controller.js` directly this turn is therefore incapable of mutating
// rollout, the gate, or anything else, regardless of what state production happens to be in.
//
// MUTATION SURFACE (once a SEPARATE future execution authorization exists): exactly two
// possible rollout mutations — (1) exact paused -> exact one-UID allowlisted rollout,
// (2) exact allowlisted(for the same UID) -> exact paused. This file can NEVER modify the
// gate document itself (no set/update/delete against the gate ref anywhere below — only
// .get(), via gate-io.js), never touches preferences/installations/token
// claims/reminders/deliveries (read-only everywhere except the two rollout mutations), never
// invokes Scheduler/Functions, never sends FCM, never mutates IAM, and never deploys.
'use strict';

const { getFirestore, Timestamp } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');
const { initializeApp, applicationDefault } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/app/index.js');

const { buildReminderId, validateSchedule } = require('C:/Users/adamb/neuroactive/functions/lib/reminderSchedulerLogic.js');
const { isValidIdForPath, isValidInstallationIdShape } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryLogic.js');

const { runPreflight, performAdcBindingCheckpoint, PROJECT_ID } = require('./production-preflight');
const { captureStrongCensus, censusUnchanged } = require('./canonicalSnapshot');
const gal = require('./gate-activation-logic');
const gateIo = require('./gate-io');
const rolloutMutation = require('./rollout-mutation');
const readinessArtifact = require('./readiness-artifact');
const productionTiming = require('./production-timing');
const executionMode = require('./execution-mode');
const activationCapability = require('./activation-capability');
const { WATCHDOG_STATUS, isConclusivelySafeStatus } = require('./watchdog-exit-codes');

const APP_ID = gateIo.APP_ID;
const GATE_DOC_PATH = gateIo.GATE_DOC_PATH;
const ROLLOUT_DOC_PATH = gateIo.ROLLOUT_DOC_PATH;

function log(label, value) {
  if (value === undefined) console.log(label);
  else console.log(label + ':', value);
}

// ---------------------------------------------------------------------------------------
// FULL PRETRANSACTION PREFLIGHT — Codex section 5 + repair pass 2 items 2/3/5. Read-only.
// Binds internally to the gate's own identifiers (never printed) and revalidates every one
// of the categories the spec lists, INCLUDING the exact approved census/schedule baselines
// and exactly-one-active-installation (a query, not a doc-by-id fetch).
// ---------------------------------------------------------------------------------------
async function runActivationPreflight(db, gate) {
  const rolloutSnap = await db.doc(ROLLOUT_DOC_PATH).get();
  if (!gal.isExactlyPausedRollout(rolloutSnap.exists ? rolloutSnap.data() : undefined)) {
    return { ok: false, reason: 'rollout-not-exactly-paused' };
  }

  // Item 2: EXACT approved census baseline required BEFORE any T0 baseline may be captured.
  // Fails closed (never auto-updates the expected values) if production has naturally
  // drifted since this baseline was reviewed.
  const censusCounts = await gateIo.captureApprovedCensusCounts(db);
  if (!gal.isApprovedCensusBaseline(censusCounts)) {
    return { ok: false, reason: 'census-not-approved-baseline' };
  }

  // Codex Step 3C-9 repair pass 5, item 3: the terminal/nonterminal COUNT match above does
  // NOT distinguish a delivery in 'dry-run-validated' from one that has since moved to
  // 'accepted-by-fcm'/'rejected-final'/'unknown-outcome'/'sending' — all are "terminal" (or,
  // for 'sending', in-flight) and so could pass the count-only baseline unnoticed. This
  // explicit state-level check closes that gap: any FCM/transport evidence at all fails
  // preflight closed, regardless of what the aggregate counts show.
  const deliveryStateBreakdown = await gateIo.captureDeliveryStateBreakdown(db);
  if (!gal.hasZeroFcmEvidence(deliveryStateBreakdown)) {
    return { ok: false, reason: 'fcm-evidence-present' };
  }

  const prefRef = db.doc(`artifacts/${APP_ID}/users/${gate.expectedUid}/notificationPreferences/main`);
  const prefSnap = await prefRef.get();
  if (!prefSnap.exists) return { ok: false, reason: 'preference-missing' };
  const pref = prefSnap.data();
  if (pref.enabled !== true) return { ok: false, reason: 'preference-disabled' };
  if (!(pref.nextReminderDueAt instanceof Timestamp)) return { ok: false, reason: 'preference-malformed' };
  const normalized = validateSchedule(pref);
  if (normalized === null) return { ok: false, reason: 'preference-malformed' };
  const currentScheduledForMs = pref.nextReminderDueAt.toMillis();
  if (currentScheduledForMs !== gate.expectedScheduledForMs) return { ok: false, reason: 'occurrence-changed' };
  const currentReminderId = buildReminderId(gate.expectedUid, currentScheduledForMs);
  if (currentReminderId !== gate.expectedReminderId) return { ok: false, reason: 'reminder-identity-mismatch' };
  if (!isValidIdForPath(gate.expectedUid)) return { ok: false, reason: 'malformed-uid' };

  const schedule = {
    revision: pref.revision,
    scheduleType: normalized.scheduleType,
    weekdays: [...normalized.weekdays],
    localTime: normalized.localTime,
    timezone: normalized.timezone,
    nextReminderDueAtMs: currentScheduledForMs,
  };
  // Item 5: pin the approved armed schedule baseline explicitly, in addition to occurrence
  // identity equality with the gate itself.
  if (!gal.isApprovedScheduleBaseline(schedule)) return { ok: false, reason: 'schedule-baseline-drift' };

  const reminderRef = db.doc(`artifacts/${APP_ID}/reminders/${gate.expectedReminderId}`);
  const reminderSnap = await reminderRef.get();
  if (reminderSnap.exists) return { ok: false, reason: 'selected-reminder-already-exists' };

  if (!isValidInstallationIdShape(gate.expectedInstallationId)) return { ok: false, reason: 'malformed-installation-id' };
  // Item 3: exactly-one-active-installation, via a QUERY (not a doc-by-id fetch) — a SECOND
  // active installation for this UID blocks activation even if it isn't the gate's own.
  const installResult = await gateIo.requireExactlyOneActiveInstallation(db, gate.expectedUid, gate.expectedInstallationId);
  if (!installResult.ok) return { ok: false, reason: installResult.reason };

  const census = await captureStrongCensus(db);

  const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
  if (timing.tooEarly) return { ok: false, reason: 'activation-too-early' };
  if (timing.tooLate) return { ok: false, reason: 'activation-too-late' };

  return {
    ok: true,
    schedule,
    installAuth: installResult.installAuth,
    census,
    timing,
  };
}

// Re-checks the SAME categories against a previously-captured baseline, immediately before
// the activation mutation — the same two-checkpoint discipline armGate.js itself uses.
// Item 4: additionally performs a FRESH, full gate re-read/re-validation (never reuses only
// the T0-loaded gate projection) with identity equality to the T0 target.
async function revalidateActivationBaselineUnchanged(db, gate, baseline) {
  const gateRecheck = await gateIo.rereadAndRevalidateGate(db, gate);
  if (!gateRecheck.ok) return gateRecheck;

  const fresh = await runActivationPreflight(db, gate);
  if (!fresh.ok) return fresh;
  const scheduleUnchanged =
    fresh.schedule.revision === baseline.schedule.revision &&
    fresh.schedule.scheduleType === baseline.schedule.scheduleType &&
    JSON.stringify(fresh.schedule.weekdays) === JSON.stringify(baseline.schedule.weekdays) &&
    fresh.schedule.localTime === baseline.schedule.localTime &&
    fresh.schedule.timezone === baseline.schedule.timezone &&
    fresh.schedule.nextReminderDueAtMs === baseline.schedule.nextReminderDueAtMs;
  if (!scheduleUnchanged) return { ok: false, reason: 'occurrence-changed' };
  const installUnchanged =
    fresh.installAuth.tokenVersion === baseline.installAuth.tokenVersion &&
    fresh.installAuth.generation === baseline.installAuth.generation &&
    fresh.installAuth.installationAudienceId === baseline.installAuth.installationAudienceId &&
    fresh.installAuth.tokenHash === baseline.installAuth.tokenHash;
  if (!installUnchanged) return { ok: false, reason: 'installation-drift' };
  if (!censusUnchanged(baseline.census, fresh.census)) return { ok: false, reason: 'census-drift' };
  return fresh;
}

// ---------------------------------------------------------------------------------------
// ACTIVATION CAS — Codex Step 3C-9 repair pass 7, item C1. PRIVATE (non-exported) — moved
// here, verbatim, from rollout-mutation.js's former attemptActivationCas, which was removed
// from that file's exports entirely because it was directly, independently callable by any
// script that required rollout-mutation.js, bypassing operator authorization, the
// activation-capability token, the final ADC checkpoint, and full production preflight. This
// is now the ONLY place in the reviewed production graph the real activation transaction is
// defined, and its only call site is inside runControllerOrchestration below, which itself
// refuses to reach this point without either ACTIVATION_TEST_MODE=true or a valid
// activation-capability token (see the capability gate at the top of that function).
// ---------------------------------------------------------------------------------------
async function performActivationCas(db, expectedGate, isValidIdForPath_) {
  const rolloutRef = db.doc(ROLLOUT_DOC_PATH);
  const gateRef = db.doc(GATE_DOC_PATH);
  const payload = gal.buildAllowlistedRolloutPayload(expectedGate.expectedUid, isValidIdForPath_);
  try {
    await db.runTransaction(async (tx) => {
      const gateSnap = await tx.get(gateRef);
      const gateData = gateSnap.exists ? gateSnap.data() : null;
      if (!gateIo.isTransactionalGateStillArmedAndBound(gateData, expectedGate)) {
        throw new Error('activation-precondition-failed');
      }
      const rolloutSnap = await tx.get(rolloutRef);
      if (!gal.isExactlyPausedRollout(rolloutSnap.exists ? rolloutSnap.data() : undefined)) {
        throw new Error('activation-precondition-failed');
      }
      tx.set(rolloutRef, payload);
    });
    return { outcome: 'committed' };
  } catch (err) {
    const classification = gal.classifyTransactionFailure(err && err.message);
    if (classification === 'definite-noncommit') return { outcome: 'definite-noncommit', reason: err.message };
    return { outcome: 'ambiguous', errorClass: 'genuinely-uncertain' };
  }
}

// TEST-ONLY: the ONLY way anything outside this file's own capability-gated
// runControllerOrchestration can exercise activation-CAS behavior — wraps the SAME
// performActivationCas above (never a second, separately-maintained copy). Hard-gated on the
// same ACTIVATION_TEST_MODE=true sentinel every other test-only escape hatch in this
// procedure requires — refuses immediately, before touching db/gate at all, if that sentinel
// is not literally 'true'. Cannot be used in production mode under any circumstance.
async function attemptActivationCasForTest(db, expectedGate, isValidIdForPath_) {
  if (!executionMode.isTestMode(process.env)) {
    throw new Error('activation-controller: attemptActivationCasForTest is test-only and requires ACTIVATION_TEST_MODE=true.');
  }
  return performActivationCas(db, expectedGate, isValidIdForPath_);
}

async function resolveActivationAmbiguity(db, gate) {
  const snap = await db.doc(ROLLOUT_DOC_PATH).get();
  return gal.classifyPostActivationRolloutState(snap.exists ? snap.data() : undefined, gate.expectedUid);
}

async function attemptPauseMutation(db, gate) {
  return rolloutMutation.attemptPauseCas(db, gate.expectedUid);
}

async function resolvePauseAmbiguity(db, gate) {
  return rolloutMutation.resolveRolloutState(db, gate.expectedUid);
}

// ---------------------------------------------------------------------------------------
// GATE-AWARE OBSERVER — read-only. Binds to the exact controlled child delivery bound by
// the gate; never "newest delivery after timestamp" logic. Codex repair pass 4, item 10:
// EVERY observation classifies the gate into exactly one of 'armed' / 'consumed' / 'drift'
// (gal.classifyGateDriftState) — a missing, deleted, malformed, or re-identified gate is no
// longer silently treated as "not consumed yet, keep waiting"; it triggers immediate
// containment exactly like a (looks-)consumed gate does.
// ---------------------------------------------------------------------------------------
async function observeOnce(db, gate, validateExperimentGateSchema) {
  const gateSnap = await db.doc(GATE_DOC_PATH).get();
  const gateData = gateSnap.exists ? gateSnap.data() : null;
  const deliveryPath = `artifacts/${APP_ID}/reminders/${gate.expectedReminderId}/deliveries/${gate.expectedInstallationId}`;
  const deliverySnap = await db.doc(deliveryPath).get();
  const deliveryData = deliverySnap.exists ? deliverySnap.data() : null;

  const driftState = gal.classifyGateDriftState(gateData, gate, validateExperimentGateSchema);

  if (driftState === 'armed') {
    return { gateData, deliveryData, driftState, gateValidatedConsumed: false, requiresContainment: false, classification: { kind: 'F-pending', requiresPause: false, terminal: false } };
  }
  if (driftState === 'consumed') {
    return { gateData, deliveryData, driftState, gateValidatedConsumed: true, requiresContainment: true, classification: gal.classifyControlledOutcome(gateData, deliveryData) };
  }
  // driftState === 'drift' — gate missing, deleted, malformed, or bound to a different
  // identity. Never reaches normal accepted/rejected/429 classification; containment is
  // mandatory regardless, and no repair/resend is ever attempted.
  return {
    gateData,
    deliveryData,
    driftState,
    gateValidatedConsumed: false,
    requiresContainment: true,
    classification: { kind: 'ambiguous-gate-drift', requiresPause: true, terminal: true, noRepair: true },
  };
}

// ---------------------------------------------------------------------------------------
// WATCHDOG READINESS VERIFICATION — Codex repair pass 3, items 4-7. The controller must
// prove the independent watchdog process is alive and freshly, genuinely progressing for
// THIS exact experiment run (challenge-bound) before EVER activating, and must repeat this
// proof immediately before the activation transaction itself — a single earlier check is not
// sufficient (Codex's own finding).
// ---------------------------------------------------------------------------------------
// Codex repair pass 4, item 1: production defaults now come from the ONE shared
// production-timing.js module (heartbeat 5s / advancement timeout 9s / advancement poll
// 500ms / max heartbeat age 15s) — no more mismatched magic numbers between this file and
// activation-watchdog.js. Test callers may still override via `opts` (see
// activation-controller.test.js), but nothing in this file's own production code path does.
const WATCHDOG_MAX_HEARTBEAT_AGE_MS = productionTiming.PRODUCTION_MAX_HEARTBEAT_AGE_MS;
const WATCHDOG_ADVANCEMENT_TIMEOUT_MS = productionTiming.PRODUCTION_ADVANCEMENT_TIMEOUT_MS;
const WATCHDOG_ADVANCEMENT_POLL_MS = productionTiming.PRODUCTION_ADVANCEMENT_POLL_MS;

// Codex repair pass 3, item 3: local-file-only cleanup — never touches Firestore/the gate.
// Thin re-export of the shared implementation so callers of this module don't need to
// require readiness-artifact.js separately.
const clearStaleReadinessArtifact = readinessArtifact.clearStaleReadinessArtifact;

// Codex repair pass 4, item 1: the advancement check now POLLS within a bounded timeout
// (never a single fixed sleep-then-check) — under healthy production operation with a 5s
// heartbeat and a 9s bounded window, advancement is detected as soon as the NEXT heartbeat
// lands (typically well under 5s), not only after the full window elapses. A watchdog that
// never advances within the bounded window fails closed.
async function verifyWatchdogFullyReady(readinessPath, gate, challenge, absoluteDeadlineMs, opts) {
  const maxHeartbeatAgeMs = (opts && opts.maxHeartbeatAgeMs) || WATCHDOG_MAX_HEARTBEAT_AGE_MS;
  const advancementTimeoutMs = (opts && opts.advancementTimeoutMs) || (opts && opts.advancementWaitMs) || WATCHDOG_ADVANCEMENT_TIMEOUT_MS;
  const advancementPollMs = (opts && opts.advancementPollMs) || WATCHDOG_ADVANCEMENT_POLL_MS;
  const expectation = gal.buildReadinessExpectation(gate, challenge, absoluteDeadlineMs);

  const r1 = readinessArtifact.readReadiness(readinessPath);
  if (!gal.readinessMatchesExpectation(r1, expectation)) return { ready: false, reason: 'readiness-mismatch' };
  if (!gal.readinessHeartbeatFresh(r1, Date.now(), maxHeartbeatAgeMs)) return { ready: false, reason: 'stale-heartbeat' };
  if (!gal.isPidAlive(r1.pid)) return { ready: false, reason: 'pid-not-alive' };

  const pollDeadline = Date.now() + advancementTimeoutMs;
  while (Date.now() < pollDeadline) {
    await new Promise((r) => setTimeout(r, Math.min(advancementPollMs, Math.max(0, pollDeadline - Date.now()))));
    const r2 = readinessArtifact.readReadiness(readinessPath);
    if (!gal.readinessMatchesExpectation(r2, expectation)) continue; // transient read/write race — keep polling until timeout.
    if (!gal.readinessAdvanced(r1, r2)) continue;
    if (!gal.isPidAlive(r2.pid)) return { ready: false, reason: 'pid-not-alive-on-recheck' };
    // Codex Step 3C-9 repair pass 6, item 5: the verified readiness snapshot (r2) is returned
    // so the caller can bind collectWatchdogFinalStatus's exact-equality checks to the ACTUAL
    // verified nonce/PID, never a bare typeof check.
    return { ready: true, readiness: r2 };
  }
  return { ready: false, reason: 'heartbeat-not-advanced' };
}

// ---------------------------------------------------------------------------------------
// WATCHDOG FINAL-STATUS COLLECTION — Codex Step 3C-9 repair pass 5, item 7. Previously the
// runner/controller never read the watchdog's own final status artifact at all. This is
// ADDITIVE, DIAGNOSTIC-ONLY: direct Firestore rollout readback remains the sole source of
// truth for whether it is safe (see the caller below, which computes `finalState` from
// rolloutMutation.resolveRolloutState BEFORE this function is even consulted) — this
// function's output is never allowed to upgrade an unsafe/unresolved Firestore state to
// "safe," and its absence/failure never downgrades a Firestore-confirmed-paused state either;
// it only ever adds corroborating or contradicting DIAGNOSTIC information to the report.
// ---------------------------------------------------------------------------------------
const RECOGNIZED_WATCHDOG_STATUS_VALUES = new Set(Object.values(WATCHDOG_STATUS));

// Codex Step 3C-9 repair pass 6, item 5 REPAIR: previously accepted merely `typeof pid ===
// 'number'` and `typeof status === 'string'` — meaning ANY numeric PID and ANY string status
// would pass "binding" even if they belonged to a completely different watchdog run. Now
// requires EXACT equality against the verifiedReadiness snapshot (the r2 object
// verifyWatchdogFullyReady's final call actually confirmed alive/advancing/challenge-bound —
// never a value merely read fresh from the status file itself, which could be stale, forged,
// or left over from a prior run) for challenge/nonce/PID/binding-hash/deadline, and requires
// status to be one of the explicitly recognized WATCHDOG_STATUS enum values.
//
// Codex item 10: distinguishes FOUR phases, not just bound/unbound — 'pending' (no status
// artifact yet, but the watchdog's own deadline hasn't passed, so it is legitimately still
// independently running and has nothing to report yet) is a DIFFERENT, expected condition from
// 'malformed-or-unbound' (an artifact exists but doesn't match this run) or 'absent-past-
// deadline' (still nothing, even though the watchdog's own deadline has passed — worth
// surfacing as unusual, though Firestore readback is what actually determines safety).
function collectWatchdogFinalStatus(statusPath, verifiedReadiness, absoluteDeadlineMs) {
  const raw = readinessArtifact.readReadiness(statusPath);
  if (!raw) {
    const phase = Date.now() < absoluteDeadlineMs ? 'pending' : 'absent-past-deadline';
    return { available: false, phase, reason: 'status-artifact-absent-or-unreadable' };
  }
  const bound =
    raw.challenge === verifiedReadiness.challenge &&
    raw.nonce === verifiedReadiness.nonce &&
    raw.pid === verifiedReadiness.pid &&
    raw.experimentBindingHash === verifiedReadiness.experimentBindingHash &&
    raw.absoluteDeadlineMs === verifiedReadiness.absoluteDeadlineMs;
  if (!bound) return { available: true, bound: false, phase: 'malformed-or-unbound', reason: 'status-artifact-not-bound-to-this-run' };
  if (typeof raw.status !== 'string' || !RECOGNIZED_WATCHDOG_STATUS_VALUES.has(raw.status)) {
    return { available: true, bound: false, phase: 'malformed-or-unbound', reason: 'unrecognized-status-value' };
  }
  const safe = isConclusivelySafeStatus(raw.status);
  return {
    available: true,
    bound: true,
    phase: safe ? 'terminal-safe' : 'terminal-unsafe',
    status: raw.status,
    reportsSafe: safe,
    attempts: raw.attempts,
    lastErrorClass: raw.lastErrorClass,
  };
}

// ---------------------------------------------------------------------------------------
// FULL CONTROLLER ORCHESTRATION — Codex repair pass 3, item 7 ordering (D-H below; A-C —
// clearing stale readiness, generating the challenge, and launching the watchdog process —
// are the CALLER's responsibility, performed before this function is ever invoked, exactly
// as in pass 2's design where watchdog launch was never this function's job). Defined here
// in full for review, but NOT invoked by this file's own entry point below. A separate,
// explicit future execution authorization is required before this function may ever be
// called against real production. `deps` allows a test to inject bounded intervals/budgets;
// production defaults are conservative.
// ---------------------------------------------------------------------------------------
async function runControllerOrchestration(db, readinessPath, challenge, deps) {
  const { validateExperimentGateSchema } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryAuth.js');
  const observePollMs = (deps && deps.observePollMs) || 30 * 1000;
  const observeBudgetMs = (deps && deps.observeBudgetMs) || 30 * 60 * 1000;
  const containmentOpts = deps && deps.containmentOpts;
  const testMode = executionMode.isTestMode(process.env);
  // Codex Step 3C-9 repair pass 5, item 8: false until the activation CAS is actually
  // attempted — the caller uses this to decide whether a pre-activation STOP leaves a
  // genuinely orphaned watchdog that must be explicitly terminated.
  let activationAttempted = false;
  // Codex Step 3C-9 repair pass 7, item 3 (C2 repair): a MUTABLE object the caller may supply
  // (deps.attemptState) and hold its own reference to. Unlike the local `activationAttempted`
  // variable above — which is lost if this function's own return value is never received
  // because an exception propagated out of it entirely — writes to this object are visible to
  // the caller EVEN IF that happens, because the caller is mutating/reading the SAME object,
  // not a copy. Flips to true ONCE, immediately BEFORE the CAS call begins (never inferred
  // from whether the call returned, since a commit can occur before the client receives any
  // response, and the call can throw after a server-side commit) and NEVER flips back.
  const attemptState = (deps && deps.attemptState) || { activationMayHaveBeenAttempted: false };

  // Codex Step 3C-9 repair pass 6, item 1: capability gate. In production mode (the default),
  // this function refuses immediately — before touching Firestore at all — unless called with
  // the one-per-process capability token only production-entry.js's real authorization success
  // path can mint (see activation-capability.js). Test mode bypasses this via the SAME
  // ACTIVATION_TEST_MODE=true sentinel every other test-only escape hatch in this procedure
  // already requires — tests are not expected to mint a real capability.
  if (!testMode && !activationCapability.isValid(deps && deps.capabilityToken)) {
    return { outcome: 'stop', reason: 'capability-invalid', activationAttempted: false };
  }

  // Codex item 6/7: everything from the gate load through the final pre-CAS readiness check
  // (steps D-G) is wrapped so that ANY exception — not just a normal stop return — is caught
  // and converted into a safe, activationAttempted:false result. This is what lets the caller
  // (activation-runner.js's runActivationCore) reliably decide "orphan, safe to terminate the
  // watchdog" vs "may have activated, preserve independence" even when something throws,
  // rather than an uncaught exception silently skipping cleanup entirely.
  let gate, timing, statusPath, baseline, finalReady;
  try {
    gate = await gateIo.loadArmedGate(db);
    if (!gate) return { outcome: 'stop', reason: 'gate-not-armed', activationAttempted: false };

    timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
    const { statusPathFor } = require('./activation-watchdog');
    statusPath = statusPathFor(readinessPath);

    // D. establish initial readiness + heartbeat advancement.
    const initialReady = await verifyWatchdogFullyReady(readinessPath, gate, challenge, timing.containmentDeadlineMs, deps && deps.readinessOpts);
    if (!initialReady.ready) return { outcome: 'stop', reason: 'watchdog-not-ready-' + initialReady.reason, activationAttempted: false };

    // E. run full activation preflight.
    baseline = await runActivationPreflight(db, gate);
    if (!baseline.ok) return { outcome: 'stop', reason: baseline.reason, activationAttempted: false };

    // F. run immediate production revalidation.
    const revalidated = await revalidateActivationBaselineUnchanged(db, gate, baseline);
    if (!revalidated.ok) return { outcome: 'stop', reason: revalidated.reason, activationAttempted: false };

    // G. IMMEDIATELY BEFORE activation transaction: reread readiness, fresh — nothing lengthy
    // occurs between this check and H below except the ADC re-checkpoint and the activation
    // transaction itself.
    finalReady = await verifyWatchdogFullyReady(readinessPath, gate, challenge, timing.containmentDeadlineMs, deps && deps.readinessOpts);
    if (!finalReady.ready) return { outcome: 'stop', reason: 'watchdog-not-ready-at-final-recheck-' + finalReady.reason, activationAttempted: false };
  } catch {
    return { outcome: 'stop', reason: 'pre-activation-exception', activationAttempted: false };
  }

  // Codex item 4: FINAL ADC binding checkpoint, immediately before the activation transaction
  // — re-verifies the credential/project/database binding established at the initial
  // production preflight has not drifted across everything that happened since (production
  // state reads, operator think time, watchdog startup, readiness verification). Only present
  // in production mode (deps.adcBindingContext is supplied ONLY by production-entry.js's real
  // flow; test callers never set it, so this step is a no-op for tests, consistent with the
  // capability gate above). The activation CAS is unreachable if this checkpoint fails.
  if (deps && deps.adcBindingContext) {
    try {
      const { performAdcBindingCheckpoint: checkpoint } = require('./production-preflight');
      checkpoint(deps.adcBindingContext.canonicalAdcPath, deps.adcBindingContext.initialAdcSha256, 'pre-activation-cas');
    } catch {
      return { outcome: 'stop', reason: 'adc-binding-drift-at-final-checkpoint', activationAttempted: false };
    }
  }

  // Codex Step 3C-9 repair pass 7, item 3 (C2 repair): H onward — the CAS call itself and
  // EVERYTHING after it (ambiguity resolution, observation, containment, final status) — is
  // now wrapped in its own try/catch. Previously only the PRE-CAS steps (D-G) were protected;
  // an exception from any POST-CAS operation (a later read, observation, ambiguity-resolution
  // query, containment attempt, or final-status collection) propagated all the way out of this
  // function uncaught, reaching production-entry.js's outer catch, which incorrectly assumed
  // activation had NOT been attempted and could terminate the independent watchdog after
  // activation may have genuinely succeeded. This catch guarantees a POST-CAS exception always
  // returns a normal result with activationAttempted:true instead of throwing.
  try {
    // H. only now may the activation transaction execute. Explicit discriminated result —
    // 'ambiguous:false' is never used as a proxy for committed. attemptState flips to true
    // IMMEDIATELY BEFORE the call begins — never inferred from the call's return value, since
    // a commit can occur before the client receives any response, and the call can throw
    // after a server-side commit.
    attemptState.activationMayHaveBeenAttempted = true;
    activationAttempted = true;
    const activation = await performActivationCas(db, gate, isValidIdForPath);
    if (activation.outcome === 'definite-noncommit') {
      return { outcome: 'stop', reason: 'activation-definite-noncommit', activationAttempted };
    }
    if (activation.outcome === 'ambiguous') {
      const resolved = await resolveActivationAmbiguity(db, gate);
      if (resolved === 'unexpected-rollout-state') return { outcome: 'stop', reason: 'ambiguous-unexpected-rollout-state', activationAttempted };
      if (resolved === 'activation-not-committed') return { outcome: 'stop', reason: 'ambiguous-activation-not-committed-requires-new-authorization', activationAttempted };
      // resolved === 'activation-committed' -> proceed exactly as on a clean success.
    }
    // activation.outcome === 'committed' (or resolved ambiguity confirmed committed) -> proceed.

    // I. bounded observation of ONLY the exact gate-bound reminder/delivery, capped at the
    // ABSOLUTE containment deadline regardless of any larger requested/default budget. Codex
    // repair pass 4, item 10: EVERY observation classifies the gate into armed/consumed/drift
    // (observeOnce -> gal.classifyGateDriftState) — 'drift' (missing/deleted/malformed/
    // re-identified) triggers immediate containment exactly like 'consumed' does, never left
    // open waiting for the deadline.
    const observationDeadline = gal.capObservationDeadline(Date.now() + observeBudgetMs, timing.containmentDeadlineMs);
    let lastObservation = null;
    let paused = false;

    while (Date.now() < observationDeadline) {
      lastObservation = await observeOnce(db, gate, validateExperimentGateSchema);

      if (lastObservation.requiresContainment && !paused) {
        // J. pause IMMEDIATELY on gate consumption OR any gate drift — do not wait for a
        // fully-validated consumed gate before containing; containment is the safe action
        // regardless of whether the trigger later proves to be a legitimate consumption or an
        // ambiguous drift.
        const containment = await rolloutMutation.runBoundedContainmentRetry(db, gate.expectedUid, containmentOpts);
        if (containment.outcome === 'unexpected-rollout-state') {
          return { outcome: 'unexpected-rollout-state', reason: 'containment-found-unexpected-rollout', attempts: containment.attempts, activationAttempted };
        }
        if (containment.outcome === 'hard-containment-failure') {
          return { outcome: 'hard-containment-failure', attempts: containment.attempts, lastErrorClass: containment.lastErrorClass, deadlinePassed: Date.now() >= timing.containmentDeadlineMs, activationAttempted };
        }
        paused = true;
      }

      if (paused && lastObservation.classification.terminal) break;
      if (!lastObservation.requiresContainment || !lastObservation.classification.terminal) {
        // Codex repair pass 4, item 4: bound the sleep by the REMAINING time to the
        // (already-capped) observation deadline — a fixed observePollMs sleep could otherwise
        // overshoot past the deadline before the loop condition is next checked, delaying the
        // no-consumption containment fallback below.
        const remainingMs = observationDeadline - Date.now();
        if (remainingMs <= 0) break;
        await new Promise((r) => setTimeout(r, Math.min(observePollMs, remainingMs)));
        continue;
      }
      break;
    }

    // No consumption observed before the (capped) observation deadline.
    if (!paused) {
      const state = await rolloutMutation.resolveRolloutState(db, gate.expectedUid);
      if (state !== 'paused') {
        const containment = await rolloutMutation.runBoundedContainmentRetry(db, gate.expectedUid, containmentOpts);
        if (containment.outcome === 'unexpected-rollout-state') {
          return { outcome: 'unexpected-rollout-state', reason: 'no-consumption-containment-found-unexpected-rollout', attempts: containment.attempts, activationAttempted };
        }
        if (containment.outcome === 'hard-containment-failure') {
          return { outcome: 'hard-containment-failure', attempts: containment.attempts, lastErrorClass: containment.lastErrorClass, deadlinePassed: true, activationAttempted };
        }
      }
      return { outcome: 'stop', reason: 'no-gate-consumption-before-observation-deadline', activationAttempted };
    }

    // K. final containment verification. Codex item 7: Firestore readback (finalState) remains
    // the SOLE determinant of `outcome` — computed first, exactly as before this repair pass.
    // Watchdog status is collected and attached only AFTER that determination, purely as
    // diagnostic corroboration; see collectWatchdogFinalStatus's header for the non-override
    // guarantee (a "safe" watchdog report can never flip a non-paused finalState to 'contained',
    // and an absent/failed watchdog report can never flip a paused finalState away from it).
    const finalState = await rolloutMutation.resolveRolloutState(db, gate.expectedUid);
    const watchdogFinalStatus = collectWatchdogFinalStatus(statusPath, finalReady.readiness, timing.containmentDeadlineMs);
    if (finalState !== 'paused') return { outcome: 'stop', reason: 'final-pause-verification-failed', activationAttempted, watchdogFinalStatus };

    if (watchdogFinalStatus.available && watchdogFinalStatus.bound && !watchdogFinalStatus.reportsSafe) {
      log('CONTROLLER_DIAGNOSTIC: rollout is CONCLUSIVELY paused (Firestore-authoritative), but the independent watchdog reported a non-safe status — surfacing, not overriding:', watchdogFinalStatus.status);
    } else if (!watchdogFinalStatus.available || !watchdogFinalStatus.bound) {
      log('CONTROLLER_DIAGNOSTIC: rollout is CONCLUSIVELY paused (Firestore-authoritative); watchdog final status artifact was unresolved/unbound:', watchdogFinalStatus.reason);
    }

    return { outcome: 'contained', classification: lastObservation.classification.kind, gateValidatedConsumed: lastObservation.gateValidatedConsumed, activationAttempted, watchdogFinalStatus };
  } catch {
    // Codex item 3 (C2): a POST-CAS exception. activationAttempted is ALREADY true (set
    // immediately before the CAS call, before this try block's own risk begins) — returned as
    // such, never reset to false. No second activation CAS is ever attempted (the function
    // simply returns here; nothing loops back to H).
    return { outcome: 'stop', reason: 'post-activation-exception', activationAttempted: true };
  }
}

// ---------------------------------------------------------------------------------------
// PRODUCTION FIRESTORE CLIENT — same repaired construction as armGate.js (applicationDefault
// + explicit named app), distinct app name to avoid any collision.
// ---------------------------------------------------------------------------------------
function buildControllerDb() {
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID }, 'activation-controller');
  return getFirestore(app);
}

module.exports = {
  APP_ID,
  GATE_DOC_PATH,
  ROLLOUT_DOC_PATH,
  loadArmedGate: gateIo.loadArmedGate,
  readGateRaw: async (db) => {
    const snap = await db.doc(GATE_DOC_PATH).get();
    return snap.exists ? snap.data() : null;
  },
  runActivationPreflight,
  revalidateActivationBaselineUnchanged,
  // Codex Step 3C-9 repair pass 7, item C1: the ONLY way anything outside this file's own
  // capability-gated runControllerOrchestration can exercise activation-CAS behavior — see
  // attemptActivationCasForTest's own header comment for the ACTIVATION_TEST_MODE=true gate.
  attemptActivationCasForTest,
  // Codex Step 3C-9 repair pass 6, item 1 REPAIR: attemptActivationMutation/
  // resolveActivationAmbiguity/attemptPauseMutation/resolvePauseAmbiguity and the blanket
  // rolloutMutation/readinessArtifact re-exports were REMOVED from this export list — they
  // were "for testing/reuse" but widened the same-process bypass surface for no real benefit
  // (nothing in the reviewed production/test paths ever called them). A test that genuinely
  // needs direct CAS access requires ./rollout-mutation directly, same as this file itself
  // does; nothing here hands it out as a convenience anymore.
  observeOnce,
  clearStaleReadinessArtifact,
  verifyWatchdogFullyReady,
  WATCHDOG_MAX_HEARTBEAT_AGE_MS,
  WATCHDOG_ADVANCEMENT_TIMEOUT_MS,
  WATCHDOG_ADVANCEMENT_POLL_MS,
  // Codex item 1: runControllerOrchestration remains exported (both the test interface and
  // production-entry.js's production path must reach it — see the capability gate at its own
  // top), but calling it in production mode without a valid activation-capability token now
  // refuses immediately, before any Firestore access.
  runControllerOrchestration,
  collectWatchdogFinalStatus,
  buildControllerDb,
  extractInstallationAuthShape: gateIo.extractInstallationAuthShape,
  installationAuthShapeReady: gateIo.installationAuthShapeReady,
};

// =========================================================================================
// ENTRY POINT — STRUCTURAL NO-EXECUTION GUARD. Running `node activation-controller.js`
// directly performs a READ-ONLY preflight dry-run only (gate load + runActivationPreflight)
// and then unconditionally refuses to proceed. No mutation function above is ever called
// from this block. A separate, explicit future execution authorization is required to wire
// up a real containment run.
// =========================================================================================
if (require.main === module) {
  (async () => {
    const db = buildControllerDb();
    const gate = await gateIo.loadArmedGate(db);
    if (!gate) {
      console.log('ACTIVATION_DRY_RUN: gate not armed/unconsumed — STOP.');
      return;
    }
    const preflight = await runActivationPreflight(db, gate);
    console.log('ACTIVATION_DRY_RUN: preflight ok =', preflight.ok, preflight.ok ? '' : `reason=${preflight.reason}`);
    console.log('ACTIVATION_DRY_RUN: this entry point NEVER activates rollout — a separate future execution authorization is required.');
  })().catch(() => {
    console.log('ACTIVATION_DRY_RUN: FAILED (fixed label only).');
    process.exitCode = 1;
  });
}
