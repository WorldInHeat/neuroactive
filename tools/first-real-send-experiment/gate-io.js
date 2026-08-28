// gate-io.js — FOR REVIEW ONLY. NOT EXECUTED as a mutation path. Codex Step 3C-9 repair
// pass 2.
//
// Shared, READ-ONLY Firestore I/O helpers used by BOTH activation-controller.js and
// activation-watchdog.js, so the two independent processes validate the gate/installation
// identically rather than each reimplementing (and potentially diverging on) the same
// invariant. Every function here performs only `.get()` calls — zero set/update/delete/
// create/batch/BulkWriter anywhere in this file.
'use strict';

const { createHash } = require('node:crypto');
const { validateExperimentGateSchema } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryAuth.js');
const {
  classifyEpochSchemaMarker,
  readFieldPresence,
  isValidTokenVersion,
  isValidAudienceId,
} = require('C:/Users/adamb/neuroactive/functions/lib/pushInstallationEpochLogic.js');
const gal = require('./gate-activation-logic');

const APP_ID = 'neuroactive-prod';
const GATE_DOC_PATH = `artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`;
const ROLLOUT_DOC_PATH = `artifacts/${APP_ID}/systemConfig/notificationRollout`;

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

// Identical composition to armGate.js's own extractInstallationAuthShape/
// installationAuthShapeReady — reuses the SAME real validators, not a divergent
// reimplementation of the invariant.
function extractInstallationAuthShape(installData) {
  const epochState = classifyEpochSchemaMarker(readFieldPresence(installData, 'epochSchemaVersion'));
  const tokenVersionValid = isValidTokenVersion(installData.tokenVersion);
  const audienceValid = isValidAudienceId(installData.installationAudienceId);
  const generationValid = typeof installData.generation === 'number' && Number.isSafeInteger(installData.generation) && installData.generation >= 1;
  const tokenPresent = typeof installData.token === 'string' && installData.token.length > 0;
  return {
    stateActive: installData.state === 'active',
    epochCurrent: epochState === 'current',
    tokenVersionValid,
    tokenVersion: tokenVersionValid ? installData.tokenVersion : null,
    audienceValid,
    installationAudienceId: audienceValid ? installData.installationAudienceId : null,
    generationValid,
    generation: generationValid ? installData.generation : null,
    tokenPresent,
    tokenHash: tokenPresent ? sha256Hex(installData.token) : null,
  };
}

function installationAuthShapeReady(shape) {
  return shape.stateActive && shape.epochCurrent && shape.tokenVersionValid && shape.audienceValid && shape.generationValid && shape.tokenPresent;
}

// Read-only. Never modifies the gate document anywhere in this file.
async function loadArmedGate(db) {
  const snap = await db.doc(GATE_DOC_PATH).get();
  if (!snap.exists) return null;
  const data = snap.data();
  if (!gal.isArmedUnconsumedGate(data, validateExperimentGateSchema)) return null;
  return {
    expectedUid: data.expectedUid,
    expectedReminderId: data.expectedReminderId,
    expectedScheduledForMs: data.expectedScheduledForMs,
    expectedInstallationId: data.expectedInstallationId,
  };
}

// Codex Step 3C-9 repair pass 5, item 6: unlike loadArmedGate above (which returns null for
// a CONSUMED gate — correct for the activation path, which must never act on a consumed
// gate, but wrong for emergency containment, which specifically needs to work AFTER a
// successful activation consumed the gate, since that is precisely the scenario where
// containment may be needed). Accepts either a fully schema-valid ARMED-unconsumed gate or a
// fully schema-valid CONSUMED gate (consumedAt/consumedByExecutionId shape already enforced
// by validateExperimentGateSchema for the consumed branch) — never a partial/malformed
// document of either state. Read-only; never writes the gate.
async function loadGateForContainment(db) {
  const snap = await db.doc(GATE_DOC_PATH).get();
  if (!snap.exists) return null;
  const data = snap.data();
  const validation = validateExperimentGateSchema(data);
  if (!validation.valid) return null; // malformed armed OR malformed consumed — refuse either way.
  const g = validation.gate;
  return {
    state: g.state, // 'armed' | 'consumed'
    expectedUid: g.expectedUid,
    expectedReminderId: g.expectedReminderId,
    expectedScheduledForMs: g.expectedScheduledForMs,
    expectedInstallationId: g.expectedInstallationId,
  };
}

// Codex repair pass 2, item 4: synchronous variant for use INSIDE a Firestore transaction,
// on already-fetched gate data — the activation transaction itself must establish these
// same gate invariants before ever checking rollout/writing. No read/write of its own; pure
// validation of data the caller already fetched via tx.get().
function isTransactionalGateStillArmedAndBound(gateData, expectedGate) {
  if (!gal.isArmedUnconsumedGate(gateData, validateExperimentGateSchema)) return false;
  return (
    gateData.expectedUid === expectedGate.expectedUid &&
    gateData.expectedReminderId === expectedGate.expectedReminderId &&
    gateData.expectedScheduledForMs === expectedGate.expectedScheduledForMs &&
    gateData.expectedInstallationId === expectedGate.expectedInstallationId
  );
}

// Codex repair pass 2, item 4: fresh, full gate re-read/re-validation immediately before
// activation — never reuses only a previously loaded projection. Additionally requires
// identity equality with the T0 experiment target.
async function rereadAndRevalidateGate(db, expectedGate) {
  const fresh = await loadArmedGate(db);
  if (!fresh) return { ok: false, reason: 'gate-no-longer-armed' };
  if (
    fresh.expectedUid !== expectedGate.expectedUid ||
    fresh.expectedReminderId !== expectedGate.expectedReminderId ||
    fresh.expectedScheduledForMs !== expectedGate.expectedScheduledForMs ||
    fresh.expectedInstallationId !== expectedGate.expectedInstallationId
  ) {
    return { ok: false, reason: 'gate-identity-drift' };
  }
  return { ok: true, gate: fresh };
}

// Codex repair pass 2, item 3: exactly-one-active-installation enforcement, at BOTH the
// initial preflight and the immediate pre-activation revalidation — a query, not a
// doc-by-id fetch, so a SECOND active installation for the same UID is detected and blocks
// activation even if it is not the one the gate happens to name.
async function requireExactlyOneActiveInstallation(db, uid, expectedInstallationId) {
  const snap = await db.collection(`artifacts/${APP_ID}/pushInstallations`).where('uid', '==', uid).get();
  const active = snap.docs.filter((d) => d.data().state === 'active');
  if (active.length !== 1) return { ok: false, reason: 'installation-population-not-exactly-one-active' };
  if (active[0].id !== expectedInstallationId) return { ok: false, reason: 'active-installation-id-mismatch' };
  const installData = active[0].data();
  if (installData.uid !== uid) return { ok: false, reason: 'installation-uid-mismatch' };
  const shape = extractInstallationAuthShape(installData);
  if (!installationAuthShapeReady(shape)) return { ok: false, reason: 'installation-not-ready' };

  const claimRef = db.doc(`artifacts/${APP_ID}/pushTokenClaims/${shape.tokenHash}`);
  const claimSnap = await claimRef.get();
  if (!claimSnap.exists) return { ok: false, reason: 'token-claim-missing' };
  const claim = claimSnap.data();
  if (claim.installationId !== expectedInstallationId || claim.uid !== uid) {
    return { ok: false, reason: 'token-claim-mismatch' };
  }

  return { ok: true, installAuth: { tokenVersion: shape.tokenVersion, generation: shape.generation, installationAudienceId: shape.installationAudienceId, tokenHash: shape.tokenHash } };
}

// Codex repair pass 2, item 2: EXACT approved-census enforcement — total/terminal/
// nonterminal counts, not merely "whatever exists." Distinct from canonicalSnapshot.js's
// digest-based captureStrongCensus (which this file does not duplicate or replace) — this
// is a coarser, human-legible count used ONLY to gate whether the current production state
// is even eligible to become a T0 baseline at all.
async function captureApprovedCensusCounts(db) {
  const [remindersSnap, deliveriesSnap] = await Promise.all([
    db.collection(`artifacts/${APP_ID}/reminders`).get(),
    db.collectionGroup('deliveries').get(),
  ]);
  function countTerminal(docs) {
    let terminal = 0;
    for (const d of docs) {
      if (d.data().workState === 'terminal') terminal++;
    }
    return { total: docs.length, terminal, nonterminal: docs.length - terminal };
  }
  return {
    reminders: countTerminal(remindersSnap.docs),
    deliveries: countTerminal(deliveriesSnap.docs),
  };
}

// Codex Step 3C-9 repair pass 5, item 3: explicit STATE-level delivery breakdown (never just
// terminal/nonterminal COUNTS — see gate-activation-logic.js's hasZeroFcmEvidence for why
// counts alone are insufficient to prove zero FCM/transport evidence). Read-only.
async function captureDeliveryStateBreakdown(db) {
  const deliveriesSnap = await db.collectionGroup('deliveries').get();
  const breakdown = {};
  for (const d of deliveriesSnap.docs) {
    const state = d.data().state;
    const key = typeof state === 'string' ? state : 'MISSING';
    breakdown[key] = (breakdown[key] || 0) + 1;
  }
  return breakdown;
}

module.exports = {
  APP_ID,
  GATE_DOC_PATH,
  ROLLOUT_DOC_PATH,
  sha256Hex,
  extractInstallationAuthShape,
  installationAuthShapeReady,
  loadArmedGate,
  loadGateForContainment,
  isTransactionalGateStillArmedAndBound,
  rereadAndRevalidateGate,
  requireExactlyOneActiveInstallation,
  captureApprovedCensusCounts,
  captureDeliveryStateBreakdown,
};
