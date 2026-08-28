// production-baseline.js — Codex Step 3C-9 repair pass 6, item 14. A SANITIZED, READ-ONLY
// production inspection tool. Structurally incapable of mutation: every Firestore call below
// is .get() or .count().get() — there is no .set(/.update(/.create(/.delete(/.add(/
// runTransaction(/WriteBatch anywhere in this file, and this file never imports rollout-
// mutation.js, gate-io.js's write-adjacent helpers, or any activation/containment module.
// Prints only booleans, counts, timestamps, and non-identifying schedule fields — never UID,
// reminderId, installationId, token, tokenHash, or audienceId.
//
// This is a DIAGNOSTIC tool only, run manually by the operator (`node production-baseline.js`)
// — it is not imported by, and does not import, any activation/containment/production-entry
// module, so it cannot be reached by, or itself reach, any mutation-capable path.
//
// Worker (Cloud Functions) revision/state and Cloud Scheduler job state are NOT queried by
// this Node tool — embedding broad Cloud Functions/Scheduler read APIs into this package would
// widen its dependency/credential-scope footprint for a diagnostic-only need. Use the exact
// read-only gcloud commands printed at the end of this tool's output instead.
'use strict';

const { initializeApp, applicationDefault } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/app/index.js');
const { getFirestore } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');
const { validateExperimentGateSchema } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryAuth.js');
const { PROJECT_ID } = require('./production-preflight');
const gal = require('./gate-activation-logic');
const gateIo = require('./gate-io');

const APP_ID = gateIo.APP_ID;

function log(label, value) {
  if (value === undefined) console.log(label);
  else console.log(label + ':', value);
}

async function runProductionBaseline() {
  const app = initializeApp({ credential: applicationDefault(), projectId: PROJECT_ID }, 'production-baseline');
  const db = getFirestore(app);

  log('=== IDENTITY ===');
  log('projectId used', app.options.projectId);
  log('database', '(default)');
  log('app (Firestore path prefix)', APP_ID);

  log('\n=== ROLLOUT ===');
  const rolloutSnap = await db.doc(gateIo.ROLLOUT_DOC_PATH).get();
  log('rollout exists', rolloutSnap.exists);
  let rolloutExactlyPaused = false;
  if (rolloutSnap.exists) {
    const r = rolloutSnap.data();
    rolloutExactlyPaused = gal.isExactlyPausedRollout(r);
    log('rollout.mode', r.mode);
    log('rollout key count', Object.keys(r).length);
    log('rollout is EXACTLY {mode:paused}', rolloutExactlyPaused);
  }

  log('\n=== GATE ===');
  const gateSnap = await db.doc(gateIo.GATE_DOC_PATH).get();
  log('gate exists', gateSnap.exists);
  let gv = { valid: false };
  if (gateSnap.exists) {
    const raw = gateSnap.data();
    gv = validateExperimentGateSchema(raw);
    log('gate raw key count', Object.keys(raw).length);
    log('gate schema valid (exact 8-field, per the committed validator)', gv.valid);
    if (gv.valid) {
      log('gate.state', gv.gate.state);
      log('gate.consumedAt is null (armed/unconsumed)', gv.gate.consumedAt === null);
      log('gate.createdAt is a genuine Timestamp', gv.gate.createdAt && typeof gv.gate.createdAt.toMillis === 'function');
      const nowMs = Date.now();
      const remainingMin = ((gv.gate.expectedScheduledForMs - nowMs) / 60000).toFixed(1);
      log('occurrence still future', gv.gate.expectedScheduledForMs > nowMs);
      log('remaining minutes to occurrence', remainingMin);
    }
  }

  if (gv.valid) {
    log('\n=== SELECTED GATE REMINDER ===');
    const remSnap = await db.doc(`artifacts/${APP_ID}/reminders/${gv.gate.expectedReminderId}`).get();
    log('selected gate reminder exists', remSnap.exists);

    log('\n=== INSTALLATION BINDING ===');
    const instSnap = await db.doc(`artifacts/${APP_ID}/pushInstallations/${gv.gate.expectedInstallationId}`).get();
    log('bound installation exists', instSnap.exists);
    if (instSnap.exists) {
      const idata = instSnap.data();
      log('bound installation.state', idata.state);
      log('bound installation.uid matches gate.expectedUid', idata.uid === gv.gate.expectedUid);
    }
    const activeQuery = await db
      .collection(`artifacts/${APP_ID}/pushInstallations`)
      .where('uid', '==', gv.gate.expectedUid)
      .where('state', '==', 'active')
      .count()
      .get();
    log('active installations for expectedUid, count', activeQuery.data().count);

    log('\n=== PREFERENCE BINDING ===');
    const prefSnap = await db.doc(`artifacts/${APP_ID}/users/${gv.gate.expectedUid}/notificationPreferences/main`).get();
    log('preference doc exists', prefSnap.exists);
    if (prefSnap.exists) {
      const p = prefSnap.data();
      log('preference.revision', p.revision);
      log('preference.enabled', p.enabled);
      if (p.nextReminderDueAt && typeof p.nextReminderDueAt.toMillis === 'function') {
        log('nextReminderDueAt === gate.expectedScheduledForMs', p.nextReminderDueAt.toMillis() === gv.gate.expectedScheduledForMs);
      }
    }
  }

  log('\n=== REMINDER / DELIVERY CENSUS (approved-baseline shape) ===');
  const censusCounts = await gateIo.captureApprovedCensusCounts(db);
  log('reminders total/terminal/nonterminal', `${censusCounts.reminders.total}/${censusCounts.reminders.terminal}/${censusCounts.reminders.nonterminal}`);
  log('deliveries total/terminal/nonterminal', `${censusCounts.deliveries.total}/${censusCounts.deliveries.terminal}/${censusCounts.deliveries.nonterminal}`);
  log('matches the reviewed approved census baseline (6/6/0 reminders, 4/4/0 deliveries)', gal.isApprovedCensusBaseline(censusCounts));

  const deliveryStateBreakdown = await gateIo.captureDeliveryStateBreakdown(db);
  log('zero FCM/transport evidence across all deliveries', gal.hasZeroFcmEvidence(deliveryStateBreakdown));

  log('\n=== WORKER / SCHEDULER — NOT queried by this tool ===');
  log('Run these exact READ-ONLY gcloud commands separately to establish worker/Scheduler state:');
  log('  gcloud functions describe notificationReminderDeliveryWorker --project=neuroactive --region=us-central1 --gen2 --format="value(state,serviceConfig.revision,serviceConfig.serviceAccountEmail,updateTime)"');
  log('  gcloud scheduler jobs describe firebase-schedule-notificationReminderDeliveryWorker-us-central1 --project=neuroactive --location=us-central1 --format="value(state,schedule,httpTarget.uri)"');

  log('\n=== DONE (read-only) ===');
}

module.exports = { runProductionBaseline };

if (require.main === module) {
  runProductionBaseline().catch((err) => {
    console.error('PRODUCTION_BASELINE: FAILED —', err && err.message);
    process.exitCode = 1;
  });
}
