// production-entry.js — Codex Step 3C-9 repair pass 6. THE SINGLE reviewed production
// activation command for the first-real-send experiment. FOR REVIEW ONLY. NOT EXECUTED
// against real production this turn — the real activation path (runProductionActivation's
// call into the private production orchestrator) was never invoked; only
// requireOperatorAuthorizationForTest (a pure local function touching neither Firestore nor
// ADC) was unit-tested, and the file's structure was verified statically.
//
// Accepts NO arguments of any kind: no UID/reminderId/installationId/scheduledTime/database/
// project/dependency-object/watchdog-launcher/clock-or-timing-override/readiness-override/
// containment-override/rollout-value/test-mode-value/prompt-injection. Every sensitive
// experiment identity is derived internally from the validated production gate. Hard-binds
// project=neuroactive, database=(default), app=neuroactive-prod via production-preflight.js/
// gate-io.js — never overridable from here.
//
// Codex Step 3C-9 repair pass 6 changes on top of pass 5:
//   1. runProductionActivation() is now LITERALLY zero-argument — no deps.promptFn escape
//      hatch. A separate, explicitly test-gated requireOperatorAuthorizationForTest() exists
//      for this file's own tests; the real production path can reach ONLY the real,
//      non-injectable requireOperatorAuthorization() (real stdin, no parameters).
//   2. The former activation-runner.js-exported runActivationProduction() is GONE — its logic
//      now lives here, as a PRIVATE (non-exported) function, so there is no longer any
//      exported zero-authorization production runner anywhere in this package.
//   3. Immediately after successful (real, non-injectable) operator authorization, mints a
//      one-per-process activation-capability token (see activation-capability.js) and threads
//      it into the orchestration call — the real activation CAS is unreachable without it.
//   4. Threads the ADC binding context captured by the initial runPreflight() into the
//      orchestration as deps.adcBindingContext, so activation-controller.js can perform a
//      FINAL ADC binding re-checkpoint immediately before the activation CAS (see that file).
//   5. Exit-code discipline: this file's own require.main===module entry point exits 0 ONLY
//      for a conclusively-contained, Firestore-authoritative-safe terminal outcome. Every
//      other outcome — STOP, definite noncommit, unresolved ambiguity, unexpected rollout,
//      failed/unverified watchdog termination, containment failure, unsafe final state,
//      configuration/preflight failure, unrecognized result, or a raw exception — exits
//      nonzero, using a distinct fixed code per category.
//
// This file's own activation path is reachable ONLY via `node production-entry.js` directly
// (require.main === module, at the very bottom). Requiring this module from anywhere else
// executes nothing.
'use strict';

const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');

const executionMode = require('./execution-mode');
const { runPreflight } = require('./production-preflight');
const activationCapability = require('./activation-capability');
const runnerInternals = require('./activation-runner');
const controller = require('./activation-controller');
const readinessArtifact = require('./readiness-artifact');
const gal = require('./gate-activation-logic');

function log(label, value) {
  if (value === undefined) console.log(label);
  else console.log(label + ':', value);
}

const SAFE_FAILURE_PHASES = Object.freeze({
  CONTROLLER_DATABASE_CONSTRUCTION: 'controller-database-construction',
  SECOND_PREFLIGHT: 'second-preflight',
  READINESS_CLEANUP: 'readiness-cleanup',
  WATCHDOG_LAUNCH: 'watchdog-launch',
  READINESS_ESTABLISHMENT: 'readiness-establishment',
  CONTROLLER_ORCHESTRATION_PRE_CAS: 'controller-orchestration-pre-cas',
  CAS_OR_AMBIGUITY: 'cas-or-ambiguity',
  UNCLASSIFIED: 'unclassified',
});
const SAFE_FAILURE_PHASE_VALUES = new Set(Object.values(SAFE_FAILURE_PHASES));

class SafePhaseError extends Error {
  constructor(phase) {
    super('production-entry-safe-phase-failure');
    this.safePhase = SAFE_FAILURE_PHASE_VALUES.has(phase) ? phase : SAFE_FAILURE_PHASES.UNCLASSIFIED;
  }
}

function safePhaseOf(err) {
  return err && SAFE_FAILURE_PHASE_VALUES.has(err.safePhase) ? err.safePhase : SAFE_FAILURE_PHASES.UNCLASSIFIED;
}

function runSyncPhase(phase, fn) {
  try {
    return fn();
  } catch {
    throw new SafePhaseError(phase);
  }
}

async function runAsyncPhase(phase, fn) {
  try {
    return await fn();
  } catch {
    throw new SafePhaseError(phase);
  }
}

// =========================================================================================
// EXIT-CODE MAPPING — Codex item 3. Exit 0 ONLY for a conclusively-contained result. Every
// other case gets a DISTINCT nonzero code so a caller/operator can tell categories apart
// without parsing text.
// =========================================================================================
const ACTIVATION_EXIT_CODES = Object.freeze({
  CONTAINED_SUCCESS: 0,
  STOP: 10,
  DEFINITE_NONCOMMIT: 11,
  UNRESOLVED_AMBIGUITY: 12,
  UNEXPECTED_ROLLOUT_STATE: 13,
  HARD_CONTAINMENT_FAILURE: 14,
  WATCHDOG_TERMINATION_UNVERIFIED: 15,
  CONFIGURATION_OR_PREFLIGHT_FAILURE: 16,
  OPERATOR_AUTHORIZATION_DECLINED: 17,
  UNRECOGNIZED_RESULT: 18,
  EXCEPTION: 19,
});

// Classifies a runProductionActivation() result into an exit code. A result is EXIT 0 ONLY
// when outcome==='contained' (Firestore-authoritative pause/consumption verified) AND, if a
// pre-activation watchdog termination was ever attempted on THIS run, it was verified — a
// 'contained' outcome with an unverified pre-activation termination is a contradiction that
// should never occur in practice (termination is only attempted when activation was NOT
// attempted, which is incompatible with outcome==='contained'), but is still checked
// defensively rather than assumed.
function exitCodeForActivationResult(result) {
  if (!result || typeof result !== 'object') return ACTIVATION_EXIT_CODES.UNRECOGNIZED_RESULT;
  if (result.watchdogTerminated === false) return ACTIVATION_EXIT_CODES.WATCHDOG_TERMINATION_UNVERIFIED;
  switch (result.outcome) {
    case 'contained':
      return ACTIVATION_EXIT_CODES.CONTAINED_SUCCESS;
    case 'stop':
      if (result.reason === 'operator-authorization-declined') return ACTIVATION_EXIT_CODES.OPERATOR_AUTHORIZATION_DECLINED;
      if (result.reason === 'production-environment-check-failed' || result.reason === 'production-preflight-failed' || result.reason === 'adc-binding-drift-at-final-checkpoint') {
        return ACTIVATION_EXIT_CODES.CONFIGURATION_OR_PREFLIGHT_FAILURE;
      }
      if (result.reason === 'activation-definite-noncommit') return ACTIVATION_EXIT_CODES.DEFINITE_NONCOMMIT;
      if (result.reason && result.reason.indexOf('ambiguous') === 0) return ACTIVATION_EXIT_CODES.UNRESOLVED_AMBIGUITY;
      return ACTIVATION_EXIT_CODES.STOP;
    case 'unexpected-rollout-state':
      return ACTIVATION_EXIT_CODES.UNEXPECTED_ROLLOUT_STATE;
    case 'hard-containment-failure':
      return ACTIVATION_EXIT_CODES.HARD_CONTAINMENT_FAILURE;
    default:
      return ACTIVATION_EXIT_CODES.UNRECOGNIZED_RESULT;
  }
}

// =========================================================================================
// OPERATOR AUTHORIZATION — Codex item 2. The REAL production function accepts NO parameters
// and always uses real readline against real stdin — there is no injection point of any kind.
// A caller cannot supply a function that manufactures "I AUTHORIZE ACTIVATION".
// =========================================================================================
const REQUIRED_AUTHORIZATION_PHRASE = 'I AUTHORIZE ACTIVATION';

function requireOperatorAuthorization() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    log('==========================================================');
    log('OPERATOR AUTHORIZATION REQUIRED');
    log('This will activate the CURRENTLY GATE-BOUND first-real-send experiment.');
    log('No identity, timing, database, or project value can be supplied here — all were');
    log('already derived from validated production state above, before this prompt.');
    log(`Type exactly: ${REQUIRED_AUTHORIZATION_PHRASE}`);
    log('==========================================================');
    rl.question('> ', (answer) => {
      rl.close();
      resolve(typeof answer === 'string' && answer.trim() === REQUIRED_AUTHORIZATION_PHRASE);
    });
  });
}

// TEST-ONLY: a SEPARATE, explicitly test-gated function accepting an injectable promptFn —
// this is the ONLY place in this file an injected prompt function is ever accepted, and it
// refuses outright unless ACTIVATION_TEST_MODE=true. The real requireOperatorAuthorization()
// above has no parameters and cannot be redirected by any caller.
function requireOperatorAuthorizationForTest(promptFn) {
  if (!executionMode.isTestMode(process.env)) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    promptFn('> ', (answer) => {
      resolve(typeof answer === 'string' && answer.trim() === REQUIRED_AUTHORIZATION_PHRASE);
    });
  });
}

// =========================================================================================
// PRIVATE PRODUCTION ORCHESTRATOR — Codex item 1/2: this function is NOT exported. It is the
// former activation-runner.js runActivationProduction(), relocated here so there is no
// standalone exported production runner anywhere in the package. Builds its own real db and
// uses the real, unmodified launchWatchdog — nothing here is injectable by any external
// caller, because nothing here is reachable except from this file's own
// runProductionActivation(), which itself accepts no arguments.
// =========================================================================================
async function runProductionOrchestration(capabilityToken, adcBindingContext) {
  const db = runSyncPhase(SAFE_FAILURE_PHASES.CONTROLLER_DATABASE_CONSTRUCTION, () => controller.buildControllerDb());
  const readinessPath = path.join(os.tmpdir(), 'first-real-send-production-readiness.json');

  // Inline the SAME watchdog-launch/readiness-wait/orphan-cleanup sequence
  // runActivationCore's test path uses, via the legitimately-exported (non-mutation-capable)
  // pieces of activation-runner.js, plus controller.runControllerOrchestration for the actual
  // mutation-capable orchestration (capability-gated — see that file).
  const precheck = await runAsyncPhase(SAFE_FAILURE_PHASES.SECOND_PREFLIGHT, () => runnerInternals.runRunnerPreconditions(db));
  if (!precheck.ok) return { outcome: 'stop', reason: precheck.reason, activationAttempted: false };
  const { gate } = precheck;

  const window = runnerInternals.deriveRunnerTimingWindow(gate);
  const withinWindow = runnerInternals.requireWithinStartWindow(Date.now(), window);
  if (!withinWindow.ok) return { outcome: 'stop', reason: withinWindow.reason, activationAttempted: false };

  runSyncPhase(SAFE_FAILURE_PHASES.READINESS_CLEANUP, () => {
    readinessArtifact.clearStaleReadinessArtifact(readinessPath);
    try {
      require('node:fs').unlinkSync(readinessPath + '.status.json');
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
  });

  const challenge = gal.generateChallenge();
  const child = runSyncPhase(SAFE_FAILURE_PHASES.WATCHDOG_LAUNCH, () => runnerInternals.launchWatchdog(readinessPath, challenge));

  const postLaunchPollMs = 100;
  const postLaunchTimeoutMs = 30000;
  if (!child || typeof child.pid !== 'number' || !gal.isPidAlive(child.pid)) {
    return { outcome: 'stop', reason: 'watchdog-failed-to-start', activationAttempted: false };
  }
  const startupDeadline = Date.now() + postLaunchTimeoutMs;
  let readinessFileAppeared = require('node:fs').existsSync(readinessPath);

  // Codex Step 3C-9 repair pass 7, item 3 (C2 repair): a MUTABLE object passed by reference
  // into runControllerOrchestration. That function flips
  // attemptState.activationMayHaveBeenAttempted to true IMMEDIATELY BEFORE the activation CAS
  // call begins — a write to THIS SAME object, visible here even if runControllerOrchestration
  // subsequently throws or its own return value is never received for any reason. The catch
  // block below reads this object DIRECTLY — it does NOT infer attempt state from whether the
  // orchestration call returned normally or from result.activationAttempted alone, precisely
  // because the previous design's exception path bypassed that field entirely.
  const attemptState = { activationMayHaveBeenAttempted: false };

  let activePhase = SAFE_FAILURE_PHASES.READINESS_ESTABLISHMENT;
  try {
    while (!readinessFileAppeared && Date.now() < startupDeadline) {
      if (!gal.isPidAlive(child.pid)) return { outcome: 'stop', reason: 'watchdog-failed-to-start', activationAttempted: false };
      await new Promise((r) => setTimeout(r, postLaunchPollMs));
      readinessFileAppeared = require('node:fs').existsSync(readinessPath);
    }
    if (!readinessFileAppeared) {
      const termination = await runnerInternals.terminateOrphanedWatchdog(child);
      return { outcome: 'stop', reason: 'watchdog-failed-to-start', activationAttempted: false, watchdogTerminated: termination.terminated };
    }

    const orchestrationDeps = {
      observePollMs: 30 * 1000,
      observeBudgetMs: Math.max(0, window.containmentDeadlineMs - Date.now()),
      capabilityToken,
      adcBindingContext,
      attemptState,
    };
    activePhase = SAFE_FAILURE_PHASES.CONTROLLER_ORCHESTRATION_PRE_CAS;
    let result = await controller.runControllerOrchestration(db, readinessPath, challenge, orchestrationDeps);
    if (result && result.outcome !== 'contained' && !result.safeFailurePhase) {
      result = {
        ...result,
        safeFailurePhase: result.activationAttempted
          ? SAFE_FAILURE_PHASES.CAS_OR_AMBIGUITY
          : SAFE_FAILURE_PHASES.CONTROLLER_ORCHESTRATION_PRE_CAS,
      };
    }

    // Codex item 4: the watchdog is terminated ONLY when activation is DEFINITELY not
    // attempted — checked via the externally-held attemptState object, not merely
    // result.activationAttempted (activation-controller.js's own internal post-CAS try/catch
    // already keeps these two in agreement on every normal return path; this is the
    // authoritative check regardless).
    let watchdogTerminated;
    if (!attemptState.activationMayHaveBeenAttempted && !result.activationAttempted) {
      const termination = await runnerInternals.terminateOrphanedWatchdog(child);
      watchdogTerminated = termination.terminated;
    }
    return { ...result, readinessPath, watchdogPid: child && child.pid, ...(watchdogTerminated !== undefined ? { watchdogTerminated } : {}) };
  } catch (err) {
    // Codex item 3/4 (C2 repair): an exception reached here — possibly from
    // runControllerOrchestration itself (though that function now catches its own pre- and
    // post-CAS exceptions and should not throw at all in normal operation), possibly from this
    // glue code. Regardless of WHERE it originated, attemptState is the authoritative,
    // exception-proof signal for whether the watchdog may still be needed.
    if (attemptState.activationMayHaveBeenAttempted) {
      // Activation MAY have been attempted — the independent watchdog's containment role may
      // still be required. NEVER terminate it here. Report an unresolved/unsafe result; the
      // CLI classifies this as nonzero (see exitCodeForActivationResult — falls through to the
      // generic STOP code, which is nonzero) and the watchdog remains running independently,
      // exactly as its whole design intends for this scenario.
      return { outcome: 'stop', reason: 'post-activation-exception-attempt-state-preserved', activationAttempted: true, safeFailurePhase: SAFE_FAILURE_PHASES.CAS_OR_AMBIGUITY };
    }
    // Activation was DEFINITELY not attempted (the exception occurred before the CAS call, in
    // this glue code) — safe to terminate the now-genuinely-orphaned watchdog, bounded + PID
    // verified, exactly as the normal pre-activation STOP path does.
    const termination = await runnerInternals.terminateOrphanedWatchdog(child);
    return { outcome: 'stop', reason: 'pre-activation-exception-in-runner-glue', activationAttempted: false, watchdogTerminated: termination.terminated, safeFailurePhase: activePhase };
  }
}

// ---------------------------------------------------------------------------------------
// THE PRODUCTION ACTIVATION SEQUENCE — Codex item 3 (preflight inside the executable path) +
// item 4 (final ADC checkpoint wiring) + item 1/2 (zero arguments, no injection).
// ---------------------------------------------------------------------------------------
async function runProductionActivation() {
  // Step 1: clean production environment — checked first, before anything else, before any
  // network call of any kind.
  const modeCheck = executionMode.requireCleanProductionEnvironment(process.env);
  if (!modeCheck.ok || modeCheck.testMode) {
    log('PRODUCTION_ENTRY: STOP — production environment check failed (test mode active or prohibited variables present).');
    return { outcome: 'stop', reason: 'production-environment-check-failed' };
  }
  log('PRODUCTION_ENTRY: production environment check PASS');

  // Steps 2-7: operator ADC identity / project=neuroactive / database=(default) / IAM drift /
  // datastore-create-permission preflight. Reused verbatim from production-preflight.js's own
  // already-reviewed runPreflight() — not reimplemented. The returned ADC binding context
  // (canonicalAdcPath/initialAdcSha256) is preserved and threaded through to the FINAL
  // pre-activation re-checkpoint (Codex item 4) — previously this context was established and
  // then discarded, with no re-verification immediately before the mutation.
  let adcBindingContext;
  try {
    const { canonicalAdcPath, initialAdcSha256 } = await runPreflight();
    adcBindingContext = { canonicalAdcPath, initialAdcSha256 };
  } catch {
    log('PRODUCTION_ENTRY: STOP — ADC/project/database/IAM preflight failed (fixed label only).');
    return { outcome: 'stop', reason: 'production-preflight-failed' };
  }
  log('PRODUCTION_ENTRY: ADC/project/database/IAM preflight PASS');

  // Steps 8-16: gate load+schema, approved census, zero FCM evidence, selected-reminder
  // absence, exactly-one-active-installation, installation/token binding, preference revision/
  // schedule/occurrence binding, rollout exactly paused, timing window. Reused from the SAME
  // reviewed preflight. This is an EARLY check only, purely so the operator is never prompted
  // for authorization when activation could not possibly proceed — the real orchestration
  // re-derives and re-validates all of this fresh, from scratch, independent of this check.
  const earlyDb = runSyncPhase(SAFE_FAILURE_PHASES.CONTROLLER_DATABASE_CONSTRUCTION, () => controller.buildControllerDb());
  const precheck = await runnerInternals.runRunnerPreconditions(earlyDb);
  if (!precheck.ok) {
    log('PRODUCTION_ENTRY: STOP — precondition failed:', precheck.reason);
    return { outcome: 'stop', reason: precheck.reason };
  }
  const window = runnerInternals.deriveRunnerTimingWindow(precheck.gate);
  const withinWindow = runnerInternals.requireWithinStartWindow(Date.now(), window);
  if (!withinWindow.ok) {
    log('PRODUCTION_ENTRY: STOP —', withinWindow.reason);
    return { outcome: 'stop', reason: withinWindow.reason };
  }
  log('PRODUCTION_ENTRY: early gate/census/installation/preference/rollout/timing precondition check PASS');

  // Step 4 (Codex item 4): operator authorization, occurring AFTER preflight and IMMEDIATELY
  // before the real orchestration/activation sequence begins. Real stdin only — no parameters.
  const authorized = await requireOperatorAuthorization();
  if (!authorized) {
    log('PRODUCTION_ENTRY: STOP — operator authorization not given (exact phrase required, case-sensitive, no partial match).');
    return { outcome: 'stop', reason: 'operator-authorization-declined' };
  }
  log('PRODUCTION_ENTRY: operator authorization PASS');

  // Codex item 1/3: mint the one-per-process activation-capability token, ONLY reachable from
  // this exact call site (see activation-capability.js's own caller-verification). Without a
  // valid token, activation-controller.js's runControllerOrchestration refuses in production
  // mode before touching Firestore, regardless of how it is invoked.
  const capabilityToken = activationCapability.mintOnce();

  log('PRODUCTION_ENTRY: handing off to the production orchestrator — the single call path capable of an actual activation CAS.');
  return runProductionOrchestration(capabilityToken, adcBindingContext);
}

module.exports = {
  runProductionActivation,
  requireOperatorAuthorizationForTest,
  REQUIRED_AUTHORIZATION_PHRASE,
  ACTIVATION_EXIT_CODES,
  exitCodeForActivationResult,
};

// =========================================================================================
// ENTRY POINT — THE ONLY REVIEWED PRODUCTION ACTIVATION COMMAND. `node production-entry.js`
// is the ONLY way this file's activation path executes. Requiring this module from elsewhere
// runs nothing. Codex item 3: exits 0 ONLY for a conclusively-contained result.
// =========================================================================================
if (require.main === module) {
  runProductionActivation()
    .then((result) => {
      log('PRODUCTION_ENTRY: final outcome:', result && result.outcome);
      if (result && result.reason) log('PRODUCTION_ENTRY: reason:', result.reason);
      if (result && SAFE_FAILURE_PHASE_VALUES.has(result.safeFailurePhase)) {
        log('PRODUCTION_ENTRY: fixed failure phase:', result.safeFailurePhase);
      }
      process.exitCode = exitCodeForActivationResult(result);
    })
    .catch((err) => {
      log('PRODUCTION_ENTRY: FAILED fixed phase:', safePhaseOf(err));
      process.exitCode = ACTIVATION_EXIT_CODES.EXCEPTION;
    });
}
