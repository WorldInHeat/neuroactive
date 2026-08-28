// activation-watchdog.js — FOR REVIEW ONLY. NOT EXECUTED against real production this turn.
// Codex Step 3C-9 repair pass 4.
//
// A REAL, independently-alive OS process. PRODUCTION MODE IS THE DEFAULT (Codex item 2/3):
// the very first thing this file does is check execution-mode.js's
// requireCleanProductionEnvironment() — in production mode, ANY prohibited test/fake/
// timing-override environment variable present is a hard configuration failure, checked
// BEFORE readiness, BEFORE any Firestore access, BEFORE anything else. Only when the
// explicit ACTIVATION_TEST_MODE=true sentinel is present are WATCHDOG_FAKE_*/override
// variables ever honored at all.
//
// In production mode: project is hard-bound to 'neuroactive' (via armGate.js's own
// PROJECT_ID), database is hard-bound to (default) (via armGate.js's runPreflight()),
// heartbeat/advancement timing is hard-bound to production-timing.js's shared constants, and
// the containment deadline is derived ONLY from the validated production gate
// (expectedScheduledForMs + 20 minutes) — no override of any kind is possible.
//
// DEADLINE DETECTION (Codex item 5): uses a DEDICATED one-shot timer set for the exact
// remaining duration until the deadline, separate from the recurring heartbeat timer — a
// 5-second heartbeat interval can therefore never delay containment initiation past the
// actual deadline instant (the previous "only checked at each heartbeat tick" design could
// overshoot by up to one full interval).
//
// HEARTBEAT-WRITE-FAILURE ISOLATION (Codex item 9): a heartbeat write failure AFTER the
// watchdog has already published initial readiness is caught, logged safely, and does NOT
// stop the heartbeat timer or prevent the deadline timer from firing and attempting
// containment — only a failure during the INITIAL publish (before any activation could have
// occurred) prevents readiness from ever being established at all.
//
// EXIT CODES / FINAL STATUS (Codex items 7/8): see watchdog-exit-codes.js for the shared
// map. A caller must never infer containment success from exit code alone without also
// reading the final local, non-secret status artifact this file writes.
//
// It must NOT, and structurally cannot (no import/reference anywhere in this file):
//   - touch the gate document (no write verb anywhere in this file; GATE_DOC_PATH is not
//     even imported — this file never constructs a doc ref for it);
//   - touch deliveries/reminders/preferences/installations/token claims;
//   - invoke Scheduler/Functions;
//   - send FCM;
//   - repair/requeue/resend anything.
// Its ONLY possible Firestore mutation is the single exact allowlisted(for expectedUid) ->
// exact paused rollout write (via rollout-mutation.js's attemptPauseCas), attempted only
// through the bounded containment-retry loop, and only at/after the deadline it derived from
// the gate itself.
'use strict';

const { createHash } = require('node:crypto');

const executionMode = require('./execution-mode');
const { PROJECT_ID, runPreflight } = require('./production-preflight');
const gal = require('./gate-activation-logic');
const gateIo = require('./gate-io');
const rolloutMutation = require('./rollout-mutation');
const readinessArtifact = require('./readiness-artifact');
const { WATCHDOG_STATUS, exitCodeForStatus } = require('./watchdog-exit-codes');
const productionTiming = require('./production-timing');

function log(label, value) {
  if (value === undefined) console.log(label);
  else console.log(label + ':', value);
}

function buildRealDb() {
  const { getFirestore } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');
  const { initializeApp, applicationDefault } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/app/index.js');
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID }, 'activation-watchdog');
  return getFirestore(app);
}

function statusPathFor(readinessPath) {
  return process.env.WATCHDOG_STATUS_PATH || `${readinessPath}.status.json`;
}

function writeFinalStatus(statusPath, fields) {
  try {
    readinessArtifact.writeReadiness(statusPath, { ...fields, writtenAtMs: Date.now() });
  } catch {
    // Best-effort only — the process exit code remains the authoritative signal if even the
    // local status write itself fails.
  }
}

async function exitWith(statusPath, statusFields) {
  writeFinalStatus(statusPath, statusFields);
  process.exitCode = exitCodeForStatus(statusFields.status);
}

async function main() {
  const readinessPath = process.env.WATCHDOG_READINESS_PATH;
  const challenge = process.env.WATCHDOG_CONTROLLER_CHALLENGE;
  if (!readinessPath) {
    log('WATCHDOG: FAILED (fixed label only) — WATCHDOG_READINESS_PATH not set');
    process.exitCode = exitCodeForStatus(WATCHDOG_STATUS.CONFIGURATION_FAILURE);
    return;
  }
  const statusPath = statusPathFor(readinessPath);
  if (!challenge) {
    log('WATCHDOG: FAILED (fixed label only) — WATCHDOG_CONTROLLER_CHALLENGE not set');
    await exitWith(statusPath, { status: WATCHDOG_STATUS.CONFIGURATION_FAILURE, reason: 'missing-challenge' });
    return;
  }

  // Codex items 2/3 — checked BEFORE readiness, BEFORE any Firestore access, BEFORE
  // anything else. In production mode (the default), any prohibited test/override variable
  // present is a hard, fail-closed configuration error.
  const modeCheck = executionMode.requireCleanProductionEnvironment(process.env);
  if (!modeCheck.ok) {
    log('WATCHDOG: FAILED (fixed label only) — prohibited test variable(s) present in production mode');
    await exitWith(statusPath, { status: WATCHDOG_STATUS.CONFIGURATION_FAILURE, reason: 'prohibited-test-variables', count: modeCheck.prohibitedVarNames.length });
    return;
  }
  const testMode = modeCheck.testMode;
  log('WATCHDOG_MODE:', testMode ? 'TEST_MODE' : 'PRODUCTION');

  const heartbeatMs = testMode && process.env.WATCHDOG_HEARTBEAT_MS ? Number(process.env.WATCHDOG_HEARTBEAT_MS) : productionTiming.PRODUCTION_HEARTBEAT_MS;
  const fakeStorePath = testMode ? process.env.WATCHDOG_FAKE_STORE_PATH : undefined;

  let db;
  if (fakeStorePath) {
    // TEST-ONLY path — reachable ONLY when testMode is true (already gated above). No ADC/
    // IAM preflight against a fake store.
    db = require('./fake-firestore-file-store').makeFileBackedDb(fakeStorePath);
    log('WATCHDOG_AUTH: TEST_MODE (fake file-backed store, no real ADC/IAM preflight)');
  } else {
    // Authenticate independently; verify project === neuroactive; verify database ===
    // (default). Reuses armGate.js's own reviewed preflight rather than reimplementing it.
    await runPreflight();
    log('WATCHDOG_AUTH: PASS (identity + project + database + IAM preflight)');
    db = buildRealDb();
  }

  // Load and validate the exact armed experiment gate; derive expected UID internally
  // (never printed) and the exact expected occurrence. The synthetic fake-identity path is
  // reachable ONLY in test mode.
  let gate;
  if (testMode && fakeStorePath && process.env.WATCHDOG_FAKE_UID) {
    gate = {
      expectedUid: process.env.WATCHDOG_FAKE_UID,
      expectedReminderId: process.env.WATCHDOG_FAKE_REMINDER_ID,
      expectedInstallationId: process.env.WATCHDOG_FAKE_INSTALLATION_ID,
      expectedScheduledForMs: Number(process.env.WATCHDOG_FAKE_SCHEDULED_FOR_MS),
    };
  } else {
    gate = await gateIo.loadArmedGate(db);
  }
  if (!gate) {
    log('WATCHDOG: gate not armed/unconsumed — STOP');
    await exitWith(statusPath, { status: WATCHDOG_STATUS.CONFIGURATION_FAILURE, reason: 'gate-not-armed' });
    return;
  }
  log('WATCHDOG_GATE: loaded and validated (armed, unconsumed)');

  // Establish the absolute containment deadline. The override is reachable ONLY in test
  // mode; production mode always derives it from the gate's own occurrence + 20 minutes.
  const deadlineOverrideMs = testMode && process.env.WATCHDOG_DEADLINE_OVERRIDE_MS ? Number(process.env.WATCHDOG_DEADLINE_OVERRIDE_MS) : null;
  const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
  const absoluteDeadlineMs = deadlineOverrideMs !== null ? deadlineOverrideMs : timing.containmentDeadlineMs;
  log('WATCHDOG_DEADLINE: established (never printed as an absolute value)');

  // Codex item 3: this watchdog instance creates a FRESH readiness artifact for this run —
  // clear any stale leftover first (local-file-only; never touches Firestore/the gate).
  readinessArtifact.clearStaleReadinessArtifact(readinessPath);
  try {
    require('node:fs').unlinkSync(statusPath);
  } catch {}

  // Codex item 4: bind to the controller-generated challenge (received at launch, never
  // generated by this file), plus this instance's own nonce and PID.
  const experimentBindingHash = gal.buildExperimentBindingHash(gate);
  const nonce = createHash('sha256').update(String(process.pid) + '-' + Date.now() + '-' + Math.random()).digest('hex').slice(0, 16);

  // Codex item 9: heartbeat publication BEFORE any activation could have occurred (i.e. the
  // very first publish, establishing readiness) must propagate a failure — no readiness, no
  // authorization. AFTER that point, a write failure must never stop the timer or block the
  // deadline-triggered containment attempt.
  function publishHeartbeat(isInitial) {
    const payload = { challenge, nonce, pid: process.pid, experimentBindingHash, absoluteDeadlineMs, heartbeatAtMs: Date.now() };
    if (isInitial) {
      readinessArtifact.writeReadiness(readinessPath, payload); // let a failure here throw/propagate.
      return;
    }
    try {
      readinessArtifact.writeReadiness(readinessPath, payload);
    } catch {
      log('WATCHDOG_HEARTBEAT_WRITE: FAILED (fixed label only) — continuing toward deadline regardless');
    }
  }
  publishHeartbeat(true);
  log('WATCHDOG_READY: fresh readiness artifact published (challenge-bound)');

  const heartbeatInterval = setInterval(() => publishHeartbeat(false), heartbeatMs);

  // Codex item 5: a DEDICATED one-shot timer targets the exact remaining duration until the
  // deadline — never discovered only on the next heartbeat tick. If the deadline has already
  // passed (or is effectively now), fire immediately.
  const remainingMs = Math.max(0, absoluteDeadlineMs - Date.now());

  await new Promise((resolve) => {
    const deadlineTimer = setTimeout(async () => {
      clearInterval(heartbeatInterval);
      try {
        const containment = await rolloutMutation.runBoundedContainmentRetry(db, gate.expectedUid);
        if (containment.outcome === 'paused') {
          const alreadyWasPaused = containment.viaCas === false;
          log('WATCHDOG_CONTAINMENT: PASS — rollout exactly paused (attempts=' + containment.attempts + ')');
          await exitWith(statusPath, {
            status: alreadyWasPaused ? WATCHDOG_STATUS.ALREADY_PAUSED_SUCCESS : WATCHDOG_STATUS.PAUSED_SUCCESS,
            challenge,
            nonce,
            pid: process.pid,
            experimentBindingHash,
            absoluteDeadlineMs,
            attempts: containment.attempts,
          });
        } else if (containment.outcome === 'unexpected-rollout-state') {
          log('==========================================================');
          log('WATCHDOG_CONTAINMENT: UNEXPECTED_ROLLOUT_STATE — refusing to overwrite. STOP.');
          log('==========================================================');
          await exitWith(statusPath, { status: WATCHDOG_STATUS.UNEXPECTED_ROLLOUT_STATE, challenge, nonce, pid: process.pid, experimentBindingHash, absoluteDeadlineMs, attempts: containment.attempts });
        } else {
          // 'hard-containment-failure'
          log('==========================================================');
          log('WATCHDOG_CONTAINMENT: HARD_CONTAINMENT_FAILURE — deadline passed, rollout could not be');
          log('  conclusively made safe within the bounded retry horizon. Operator intervention required.');
          log('  attempts:', containment.attempts);
          log('  lastErrorClass:', containment.lastErrorClass);
          log('==========================================================');
          await exitWith(statusPath, { status: WATCHDOG_STATUS.HARD_CONTAINMENT_FAILURE, challenge, nonce, pid: process.pid, experimentBindingHash, absoluteDeadlineMs, attempts: containment.attempts, lastErrorClass: containment.lastErrorClass });
        }
      } catch {
        log('WATCHDOG_CONTAINMENT: FAILED (fixed label only) — uncaught exception during containment, safe state NOT established');
        await exitWith(statusPath, { status: WATCHDOG_STATUS.CONTAINMENT_EXCEPTION, challenge, nonce, pid: process.pid, experimentBindingHash, absoluteDeadlineMs });
      }
      resolve();
    }, remainingMs);
    // The one-shot deadline timer alone must be able to keep the process alive even if the
    // heartbeat interval were ever cleared early elsewhere — Node keeps the event loop alive
    // as long as either active timer exists, which is already the case here.
  });
}

module.exports = {
  buildRealDb,
  statusPathFor,
};

if (require.main === module) {
  main().catch(() => {
    console.log('WATCHDOG: FAILED (fixed label only).');
    process.exitCode = 1;
  });
}
