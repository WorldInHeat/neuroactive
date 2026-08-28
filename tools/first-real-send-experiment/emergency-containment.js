// emergency-containment.js — FOR REVIEW ONLY. NOT EXECUTED. DO NOT RUN THIS TURN. Codex
// Step 3C-9 repair pass 4, item 17.
//
// ==========================================================================================
// EMERGENCY OPERATOR TOOL — CONTAINMENT ONLY. This file is DELIBERATELY separate from, and
// visually/structurally distinct from, activation-runner.js/activation-controller.js/
// activation-watchdog.js. It is for a human operator to run BY HAND, only in an emergency
// (e.g. both the runner and the independent watchdog have failed after activation and
// rollout must be made safe immediately). It is difficult to invoke accidentally: it has no
// heartbeat/challenge/readiness machinery, no watchdog process, no observation loop — it
// does exactly one thing, once, and exits.
// ==========================================================================================
//
// Codex Step 3C-9 repair pass 5, item 6 REPAIR: this file previously called gateIo's
// ARMED-only loadArmedGate(), which returns null for a CONSUMED gate. That is exactly
// backwards for an EMERGENCY tool: the scenario where emergency containment is most needed —
// both the runner/controller and the independent watchdog have died AFTER a successful
// activation consumed the gate — is precisely the scenario in which the gate is no longer
// "armed." A gate-not-armed refusal at that moment would have left rollout open with no
// automatic recovery path. Repaired to use gateIo.loadGateForContainment(), which accepts
// EITHER a fully schema-valid armed-unconsumed gate OR a fully schema-valid consumed gate
// (full 8-field schema, including consumedAt/consumedByExecutionId shape, still enforced by
// validateExperimentGateSchema either way) and derives expectedUid from either. This file's
// own containment behavior is otherwise UNCHANGED — it still never touches the gate document,
// still never activates anything (no attemptActivationCas import anywhere below).
//
// It may ONLY:
//   1. authenticate/verify production project/database (armGate.js's runPreflight());
//   2. load and validate the gate as EITHER armed-unconsumed OR consumed (read-only; used
//      ONLY to derive expectedUid internally — never printed, never accepted as an argument);
//   3. transactionally read rollout;
//   4. if rollout is exactly the reviewed one-UID experiment allowlist for that uid: write
//      exactly {mode:'paused'} (the SAME reviewed CAS as rollout-mutation.js's
//      attemptPauseCas — this file does not reimplement it);
//   5. if already exactly paused: succeed idempotently;
//   6. if unexpected: DO NOT overwrite;
//   7. verify the exact paused readback when a mutation occurred.
//
// It must NOT, and structurally cannot (no import/reference anywhere in this file):
//   - activate anything (no attemptActivationCas import at all);
//   - touch the gate document (no write verb anywhere in this file);
//   - touch reminders/deliveries/preferences/installations/token claims;
//   - send FCM;
//   - invoke Scheduler/Functions;
//   - mutate IAM.
//
// NO IDENTITY CLI ARGUMENTS of any kind — the UID is derived internally from the validated
// gate, exactly like every other file in this reviewed procedure.
'use strict';

const { runPreflight, PROJECT_ID } = require('./production-preflight');
const gateIo = require('./gate-io');
const rolloutMutation = require('./rollout-mutation');

function log(label, value) {
  if (value === undefined) console.log(label);
  else console.log(label + ':', value);
}

function buildDb() {
  const { getFirestore } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');
  const { initializeApp, applicationDefault } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/app/index.js');
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID }, 'emergency-containment');
  return getFirestore(app);
}

// The single reviewed operation this whole file exists to perform. Exported separately from
// the CLI entry point below so a test can exercise it against a fake db without touching
// production, and so this function's OWN behavior is identical to what an operator's real
// invocation would do.
async function runEmergencyContainment(db) {
  // Repaired (Codex Step 3C-9 repair pass 5, item 6): accepts EITHER state, so this tool
  // remains usable in the double-failure scenario (item 9) where the gate has already been
  // legitimately consumed and rollout may still be open. If the gate is neither a valid armed
  // nor a valid consumed document (missing, malformed, or some other state entirely), there is
  // no expectedUid this tool can safely bind to — it refuses rather than guessing.
  const gate = await gateIo.loadGateForContainment(db);
  if (!gate) {
    log('EMERGENCY_CONTAINMENT: gate not loadable as a valid armed-or-consumed document — refusing (no expectedUid to bind to)');
    return { outcome: 'stop', reason: 'gate-not-armed-or-consumed' };
  }
  const containment = await rolloutMutation.runBoundedContainmentRetry(db, gate.expectedUid, { maxAttempts: 1 });
  if (containment.outcome === 'paused') {
    log('EMERGENCY_CONTAINMENT: PASS — rollout exactly paused', containment.viaCas ? '(CAS committed)' : '(already paused)');
  } else if (containment.outcome === 'unexpected-rollout-state') {
    log('EMERGENCY_CONTAINMENT: UNEXPECTED_ROLLOUT_STATE — refusing to overwrite. Operator must inspect manually.');
  } else {
    log('EMERGENCY_CONTAINMENT: single attempt did not conclusively pause rollout — rerun or inspect manually.');
  }
  return containment;
}

// Codex Step 3C-9 repair pass 6, item 3: exit-code discipline. EXIT 0 ONLY when Firestore-
// authoritative state is conclusively either already-exactly-paused or successfully
// transitioned from the exact expected allowlist to exactly paused. Every refusal/unexpected/
// hard-failure/unresolved result exits nonzero, with a distinct code per category.
const EMERGENCY_EXIT_CODES = Object.freeze({
  PAUSED_CONCLUSIVE: 0,
  GATE_NOT_LOADABLE: 20,
  UNEXPECTED_ROLLOUT_STATE: 21,
  HARD_CONTAINMENT_FAILURE: 22,
  UNRECOGNIZED_RESULT: 23,
  PREFLIGHT_FAILURE: 24,
  EXCEPTION: 25,
});

function exitCodeForEmergencyResult(result) {
  if (!result || typeof result !== 'object') return EMERGENCY_EXIT_CODES.UNRECOGNIZED_RESULT;
  switch (result.outcome) {
    case 'paused':
      return EMERGENCY_EXIT_CODES.PAUSED_CONCLUSIVE;
    case 'stop':
      return EMERGENCY_EXIT_CODES.GATE_NOT_LOADABLE;
    case 'unexpected-rollout-state':
      return EMERGENCY_EXIT_CODES.UNEXPECTED_ROLLOUT_STATE;
    case 'hard-containment-failure':
      return EMERGENCY_EXIT_CODES.HARD_CONTAINMENT_FAILURE;
    case 'ambiguous':
    case 'definite-noncommit':
      // runBoundedContainmentRetry never returns these directly, but classified defensively
      // rather than falling through to a false-positive success code if that ever changes.
      return EMERGENCY_EXIT_CODES.UNRECOGNIZED_RESULT;
    default:
      return EMERGENCY_EXIT_CODES.UNRECOGNIZED_RESULT;
  }
}

module.exports = { buildDb, runEmergencyContainment, EMERGENCY_EXIT_CODES, exitCodeForEmergencyResult };

// =========================================================================================
// CLI ENTRY POINT — DO NOT RUN THIS TURN. No identity arguments accepted; process.argv is
// never read for anything beyond Node's own invocation.
// =========================================================================================
if (require.main === module) {
  (async () => {
    try {
      await runPreflight();
    } catch {
      console.log('EMERGENCY_CONTAINMENT: FAILED — preflight (fixed label only).');
      process.exitCode = EMERGENCY_EXIT_CODES.PREFLIGHT_FAILURE;
      return;
    }
    const db = buildDb();
    const result = await runEmergencyContainment(db);
    process.exitCode = exitCodeForEmergencyResult(result);
  })().catch(() => {
    console.log('EMERGENCY_CONTAINMENT: FAILED (fixed label only).');
    process.exitCode = EMERGENCY_EXIT_CODES.EXCEPTION;
  });
}
