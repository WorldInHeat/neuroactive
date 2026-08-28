// activation-runner.js — FOR REVIEW ONLY. NOT EXECUTED against real production this turn.
// Codex Step 3C-9 repair pass 4, items 11-19.
//
// The single reviewed production entry point for the eventual first-real-send experiment.
// NOT deployed application code — a scratchpad orchestration script, run manually by the
// operator under a SEPARATE, explicit future execution authorization. Accepts NO CLI
// arguments of any kind (no UID/reminderId/installationId/token/schedule/gate identity/
// rollout mode/deadline/fake-store path/timing override) — every sensitive value is derived
// internally from the validated production gate and production state, exactly like
// activation-controller.js and activation-watchdog.js already do.
//
// STRUCTURAL NO-EXECUTION GUARD: this file exports every function below for review/testing,
// but its own `require.main === module` entry point (at the bottom) performs ONLY a
// read-only preflight dry-run (identical in spirit to activation-controller.js's own dry-run
// entry point) and refuses to launch a watchdog or attempt activation. Running
// `node activation-runner.js` directly this turn cannot mutate rollout, the gate, or launch
// any child process — a SEPARATE, explicit future execution authorization is required to
// invoke `runActivation()` for real.
//
// PROCESS TOPOLOGY (Codex item 15): the watchdog is spawned DETACHED (`detached: true`,
// `stdio: 'ignore'`, then `child.unref()`) so it is not a member of this runner's own
// process group and is NOT automatically terminated if the runner exits (normally or
// abnormally) — Windows/Node's `detached` option creates the child in a new process group,
// which is the mechanism available on this platform for "survives the parent's exit." The
// runner positively verifies the watchdog is independently alive (OS-level PID check, then
// full readiness+heartbeat-advancement verification) BEFORE ever proceeding to activation.
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const executionMode = require('./execution-mode');
const productionTiming = require('./production-timing');
const gal = require('./gate-activation-logic');
const gateIo = require('./gate-io');
const rolloutMutation = require('./rollout-mutation');
const readinessArtifact = require('./readiness-artifact');
const controller = require('./activation-controller');
const { validateExperimentGateSchema } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryAuth.js');
const { isValidIdForPath } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryLogic.js');

const RUNNER_START_WINDOW_MIN_MS = gal.ACTIVATION_WINDOW_MIN_MS; // 10 min before occurrence
const RUNNER_START_WINDOW_MAX_MS = gal.ACTIVATION_WINDOW_MAX_MS; // 15 min before occurrence

function log(label, value) {
  if (value === undefined) console.log(label);
  else console.log(label + ':', value);
}

// ---------------------------------------------------------------------------------------
// PRECONDITIONS — Codex item 12. Read-only. Every one of these must pass before this file
// does anything mutation-capable.
// ---------------------------------------------------------------------------------------
async function runRunnerPreconditions(db) {
  const gate = await gateIo.loadArmedGate(db);
  if (!gate) return { ok: false, reason: 'gate-not-armed' };

  const preflight = await controller.runActivationPreflight(db, gate);
  if (!preflight.ok) return { ok: false, reason: preflight.reason, gate };

  return { ok: true, gate, baseline: preflight };
}

// Codex item 13: derives the start window and containment deadline ONLY from the validated
// gate occurrence and the already-reviewed rules (10-15 min before occurrence; deadline =
// occurrence + 20 min) — never a hardcoded wall-clock string.
function deriveRunnerTimingWindow(gate) {
  const earliestStartMs = gate.expectedScheduledForMs - RUNNER_START_WINDOW_MAX_MS;
  const latestStartMs = gate.expectedScheduledForMs - RUNNER_START_WINDOW_MIN_MS;
  const containmentDeadlineMs = gate.expectedScheduledForMs + gal.CONTAINMENT_DEADLINE_AFTER_MS;
  return { earliestStartMs, latestStartMs, containmentDeadlineMs };
}

function requireWithinStartWindow(nowMs, window) {
  if (nowMs < window.earliestStartMs) return { ok: false, reason: 'runner-started-too-early' };
  if (nowMs > window.latestStartMs) return { ok: false, reason: 'runner-started-too-late' };
  return { ok: true };
}

// ---------------------------------------------------------------------------------------
// WATCHDOG LAUNCH — Codex items 3/15. Sanitized child environment (never a raw inherited
// copy); DETACHED so the child outlives this runner process if the runner itself dies.
// ---------------------------------------------------------------------------------------
function launchWatchdog(readinessPath, challenge) {
  const env = executionMode.buildSanitizedChildEnvironment(process.env, {
    WATCHDOG_READINESS_PATH: readinessPath,
    WATCHDOG_CONTROLLER_CHALLENGE: challenge,
    // Deliberately NOT setting ACTIVATION_TEST_MODE or any WATCHDOG_FAKE_*/override — a
    // production launch runs the watchdog in production mode, hard-bound to real GCP and
    // the shared production-timing.js constants.
  });
  const child = spawn(process.execPath, [path.join(__dirname, 'activation-watchdog.js')], {
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  return child;
}

// Codex Step 3C-9 repair pass 5, item 8: if the runner definitively STOPs BEFORE the
// activation CAS was ever attempted, the detached watchdog it already launched has nothing
// left to protect (rollout is still exactly paused — the watchdog's own containment retry
// would find that and no-op harmlessly at its deadline regardless, but leaving it running
// unmonitored for up to ~20 minutes is unnecessary and undesirable). Chosen design: the
// SIMPLER of the two options Codex offered — explicitly terminate and verify, rather than
// transferring/awaiting responsibility. Never called for a POST-activation-attempt stop —
// the watchdog's independence is the deliberate fallback there (see runActivationCore below).
async function terminateOrphanedWatchdog(child) {
  if (!child || typeof child.pid !== 'number') return { attempted: false, terminated: true };
  if (!gal.isPidAlive(child.pid)) return { attempted: true, terminated: true };
  try {
    child.kill();
  } catch {
    // already gone, or unsignalable — liveness check below is the actual verification.
  }
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!gal.isPidAlive(child.pid)) return { attempted: true, terminated: true };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { attempted: true, terminated: !gal.isPidAlive(child.pid) };
}

// ---------------------------------------------------------------------------------------
// FULL RUNNER ORCHESTRATION (CORE) — Codex item 14, steps 1-33. Renamed from the previous
// exported `runActivation` (Codex Step 3C-9 repair pass 5, item 2: this function itself is
// now PRIVATE — module-internal only, never exported — precisely because it accepts
// injectable db/deps and so must never be directly reachable by any caller. The only two
// exported entry points are runActivationForTest (below, explicit-test-mode-gated) and
// runActivationProduction (below, zero-argument, production-only). Neither this file nor any
// other reviewed file exports this function under any name.
// ---------------------------------------------------------------------------------------
async function runActivationCore(db, deps) {
  // 1. verify production mode / clean environment.
  const modeCheck = executionMode.requireCleanProductionEnvironment(process.env);
  if (!modeCheck.ok) return { outcome: 'stop', reason: 'runner-prohibited-test-variables', prohibitedVarNames: modeCheck.prohibitedVarNames };

  // 2-16 handled by runRunnerPreconditions (ADC/project/database/operator/IAM preflight is
  // inside armGate.js's runPreflight(), invoked by controller.runActivationPreflight's own
  // callers upstream of this function — see the entry-point dry-run below for the exact same
  // preflight reuse pattern).
  // 3. load/validate exact gate; 4. derive experiment identity internally.
  const precheck = await runRunnerPreconditions(db);
  if (!precheck.ok) return { outcome: 'stop', reason: precheck.reason };
  const { gate, baseline } = precheck;

  // 5. derive start window and containment deadline.
  const window = deriveRunnerTimingWindow(gate);

  // 6. require current time inside the start window. No operator override.
  const withinWindow = requireWithinStartWindow(Date.now(), window);
  if (!withinWindow.ok) return { outcome: 'stop', reason: withinWindow.reason };

  // 7/8. rollout paused + full approved baseline already proven by runRunnerPreconditions.

  const readinessPath = (deps && deps.readinessPath) || path.join(require('node:os').tmpdir(), 'activation-readiness.json');

  // 9. clear stale LOCAL readiness/status artifacts.
  readinessArtifact.clearStaleReadinessArtifact(readinessPath);
  try {
    require('node:fs').unlinkSync(readinessPath + '.status.json');
  } catch {}

  // 10. generate fresh controller challenge.
  const challenge = gal.generateChallenge();

  // 11. launch independent watchdog child using sanitized production environment.
  const watchdogLauncher = (deps && deps.launchWatchdog) || launchWatchdog;
  const child = watchdogLauncher(readinessPath, challenge);

  // 12. verify child started — OS-level PID check, THEN wait (bounded poll, not a fixed
  // guess) for the watchdog's OWN startup (module loading + its own preflight) to actually
  // reach its first readiness publish, so the orchestration below never mistakes "watchdog
  // hasn't finished starting yet" for "watchdog is not ready" (a real Node child process's
  // own require graph + preflight can legitimately take longer than a short fixed sleep).
  const postLaunchPollMs = (deps && deps.postLaunchPollMs) || 100;
  // Codex Step 3C-9 repair pass 5, item 10: raised from 8000ms to 30000ms. The watchdog's own
  // startup path (module load, then armGate.js's runPreflight() — a REAL network round trip
  // for ADC identity resolution + IAM checks, see activation-watchdog.js) can legitimately
  // exceed a few seconds under normal production conditions (cold start, network latency),
  // and must never be confused with a genuinely failed-to-start watchdog. 30s comfortably
  // exceeds the 9s advancement-verification window this is sequenced BEFORE, while still
  // failing closed well short of the 20-minute containment deadline. The 5s production
  // heartbeat itself is deliberately left untouched — this bounds STARTUP only.
  const postLaunchTimeoutMs = (deps && deps.postLaunchTimeoutMs) || 30000;
  if (!child || typeof child.pid !== 'number' || !gal.isPidAlive(child.pid)) {
    return { outcome: 'stop', reason: 'watchdog-failed-to-start', activationAttempted: false };
  }
  const startupDeadline = Date.now() + postLaunchTimeoutMs;
  let readinessFileAppeared = require('node:fs').existsSync(readinessPath);
  while (!readinessFileAppeared && Date.now() < startupDeadline) {
    if (!gal.isPidAlive(child.pid)) return { outcome: 'stop', reason: 'watchdog-failed-to-start', activationAttempted: false };
    await new Promise((r) => setTimeout(r, postLaunchPollMs));
    readinessFileAppeared = require('node:fs').existsSync(readinessPath);
  }
  if (!readinessFileAppeared) {
    // Codex item 8: readiness never appeared within the bounded startup deadline, but the
    // process may still be alive and stuck (not merely already dead) — explicitly terminate
    // and verify rather than leaving it running unmonitored.
    const termination = await terminateOrphanedWatchdog(child);
    return { outcome: 'stop', reason: 'watchdog-failed-to-start', activationAttempted: false, watchdogTerminated: termination.terminated };
  }

  // 13-19. controller.runControllerOrchestration performs: obtain positive readiness,
  // observe heartbeat advancement, verify nonce/PID/challenge/binding/deadline, verify OS
  // liveness (all via verifyWatchdogFullyReady, called twice — once early, once immediately
  // before activation), full activation preflight, immediate production revalidation, FINAL
  // watchdog readiness/heartbeat/liveness verification, then (20) the exact activation CAS,
  // then (21-29) natural-worker-only observation with immediate pause on ANY gate
  // consumption or drift, final containment verification, and outcome classification.
  const orchestrationDeps = {
    observePollMs: (deps && deps.observePollMs) || 30 * 1000,
    observeBudgetMs: Math.max(0, window.containmentDeadlineMs - Date.now()),
    containmentOpts: deps && deps.containmentOpts,
    readinessOpts: deps && deps.readinessOpts,
  };
  const result = await controller.runControllerOrchestration(db, readinessPath, challenge, orchestrationDeps);

  // Codex Step 3C-9 repair pass 5, item 8: `result.activationAttempted` (set by
  // activation-controller.js's runControllerOrchestration — false for every D/E/F/G stop
  // reason, true from the moment the single activation CAS call site executes onward) is the
  // exact boundary between "orphan — nothing to protect, terminate it" and "post-attempt —
  // its independence IS the protection, never touch it."
  let watchdogTerminated;
  if (!result.activationAttempted) {
    const termination = await terminateOrphanedWatchdog(child);
    watchdogTerminated = termination.terminated;
  }

  // 30. final report is the caller's responsibility (this function returns the full result);
  // 31. cleanup of local artifacts is deliberately NOT performed here — see Codex item 19:
  // local diagnostics must be preserved until the final rollout state is conclusively known
  // and the watchdog has exited or been intentionally, safely terminated. This function
  // leaves that decision, and the artifact, to the caller.
  return { ...result, readinessPath, watchdogPid: child && child.pid, ...(watchdogTerminated !== undefined ? { watchdogTerminated } : {}) };
}

// ---------------------------------------------------------------------------------------
// TEST-ONLY INJECTABLE INTERFACE — Codex Step 3C-9 repair pass 5, item 2B. The ONLY exported
// path that can reach runActivationCore with a caller-supplied db/deps. Hard-gated on the
// SAME explicit ACTIVATION_TEST_MODE=true sentinel execution-mode.js already uses everywhere
// else in this procedure — refuses immediately, before touching db/deps at all, if that
// sentinel is not literally 'true'.
// ---------------------------------------------------------------------------------------
async function runActivationForTest(db, deps) {
  if (!executionMode.isTestMode(process.env)) {
    return { outcome: 'stop', reason: 'test-interface-requires-explicit-test-mode', activationAttempted: false };
  }
  return runActivationCore(db, deps);
}

// Codex Step 3C-9 repair pass 6, item 1 REPAIR: the previous runActivationProduction() export
// was removed from this file entirely — it was flagged as an exported zero-authorization
// production runner, reachable by any code requiring this module directly, bypassing
// production-entry.js's preflight/authorization sequence. Its equivalent logic now lives as a
// PRIVATE function inside production-entry.js itself (the one sanctioned production
// executable), which reaches runActivationCore's watchdog-launch/readiness-wait/orphan-cleanup
// machinery via the pieces still legitimately exported below (runRunnerPreconditions,
// deriveRunnerTimingWindow, requireWithinStartWindow, launchWatchdog, terminateOrphanedWatchdog
// — none of which is itself a Firestore mutation) plus controller.runControllerOrchestration
// (which now requires either ACTIVATION_TEST_MODE=true or a valid activation-capability token
// — see that file's own capability gate).
module.exports = {
  RUNNER_START_WINDOW_MIN_MS,
  RUNNER_START_WINDOW_MAX_MS,
  runRunnerPreconditions,
  deriveRunnerTimingWindow,
  requireWithinStartWindow,
  launchWatchdog,
  terminateOrphanedWatchdog,
  runActivationForTest,
};

// =========================================================================================
// ENTRY POINT — STRUCTURAL NO-EXECUTION GUARD. Running `node activation-runner.js` directly
// performs ONLY a read-only preflight dry-run (gate load + full activation preflight +
// derived timing window, printed as booleans/labels only) and refuses to launch a watchdog
// or attempt activation. Codex Step 3C-9 repair pass 5, item 1: this file is DELIBERATELY NOT
// the reviewed production activation command — that is production-entry.js's
// runActivationProduction() call, which itself never accepts arguments and performs its own
// full preflight/authorization sequence before ever reaching runActivationCore. This file's
// own entry point below never calls runActivationCore/runActivationForTest/
// runActivationProduction at all.
// =========================================================================================
if (require.main === module) {
  (async () => {
    const modeCheck = executionMode.requireCleanProductionEnvironment(process.env);
    if (!modeCheck.ok) {
      console.log('RUNNER_DRY_RUN: FAILED — prohibited test variable(s) present in production mode. STOP.');
      process.exitCode = 1;
      return;
    }
    const db = controller.buildControllerDb();
    const precheck = await runRunnerPreconditions(db);
    if (!precheck.ok) {
      console.log('RUNNER_DRY_RUN: preflight ok = false, reason =', precheck.reason);
      console.log('RUNNER_DRY_RUN: this entry point NEVER launches a watchdog or activates rollout.');
      return;
    }
    const window = deriveRunnerTimingWindow(precheck.gate);
    const withinWindow = requireWithinStartWindow(Date.now(), window);
    console.log('RUNNER_DRY_RUN: preflight ok = true');
    console.log('RUNNER_DRY_RUN: within start window =', withinWindow.ok, withinWindow.ok ? '' : `reason=${withinWindow.reason}`);
    console.log('RUNNER_DRY_RUN: this entry point NEVER launches a watchdog or activates rollout — a separate future execution authorization is required.');
  })().catch(() => {
    console.log('RUNNER_DRY_RUN: FAILED (fixed label only).');
    process.exitCode = 1;
  });
}
