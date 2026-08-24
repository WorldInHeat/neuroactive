#!/usr/bin/env node
// functions/maintenance/repairInvalidRevisionPreference.js
//
// Phase 3A-3 Step 2 — TRUSTED OPERATOR-ONLY break-glass repair tool for the one
// corruption case a user genuinely cannot self-repair through Settings: a
// notificationPreferences document whose `revision` field fails validation.
//
// WHY THIS EXISTS (do not weaken Step 1 to avoid needing this):
//   - Step 1's updateNotificationPreferences (functions/src/notificationPreferences.ts)
//     deliberately refuses to write to a document whose existing revision is invalid —
//     it throws a 'data-loss' error rather than treating the corruption as revision 0.
//     This is intentional, reviewed, unmodified fail-closed behavior, not a bug.
//   - refreshNotificationTimezone has the identical guard.
//   - The scheduler (functions/src/reminderScheduler.ts) quarantines such a document
//     (pushes nextReminderDueAt to a fixed far-future sentinel) so it stops consuming
//     due-query capacity, but a quarantine is explicitly NOT a repair — it deliberately
//     never touches/interprets the corrupt fields.
//   - Net effect: an invalid-revision document stays broken until a human, with real
//     project credentials, deliberately decides what "known-valid" should mean for that
//     specific user and writes it — there is no automatic path, by design.
//
// STRUCTURAL SAFETY — this file can NEVER be deployed:
//   functions/tsconfig.json's `include` is `["src"]` only. This file lives under
//   functions/maintenance/, entirely outside that scope, so `tsc` never compiles it and
//   it is not reachable from functions/lib/index.js (the only thing
//   functions/package.json's "main" field, and therefore `firebase deploy --only
//   functions`, ever looks at). It is not imported by, and never will be imported by,
//   any file under functions/src. Nothing about running `npm run build` or `firebase
//   deploy` in this repository can pick this file up.
//
// HOW TO RUN (operator only, requires real project-owner/editor credentials — this
// script does NOT run under the Cloud Functions service account; it runs under
// whichever identity is authenticated on the machine that invokes it, e.g. via
// `gcloud auth application-default login` or a downloaded service account key set via
// GOOGLE_APPLICATION_CREDENTIALS):
//
//   Step 1 — dry preview (REQUIRED first step, makes no write):
//     node functions/maintenance/repairInvalidRevisionPreference.js <uid>
//   This prints the document's current raw content (no tokens/credentials are ever
//   present in this document — see functions/src/notificationPreferences.ts's schema —
//   so this is safe to read/print) for human review.
//
//   Step 2 — after reviewing the printed output, apply the repair explicitly:
//     node functions/maintenance/repairInvalidRevisionPreference.js <uid> --confirm
//   This REPLACES the entire document with a known-valid, DISABLED default state
//   (revision reset to 1, enabled:false, a harmless daily/07:00/UTC schedule that is
//   never acted on while disabled, nextReminderDueAt: null). The user's reminders are
//   left OFF — they must explicitly re-enable and reconfigure via Settings afterward;
//   this script never guesses or restores what their prior intended schedule was, since
//   that information may itself have been part of what was corrupted.
//
// This script is NEVER invoked automatically by any part of this project. It was not
// run against production as part of implementing this repair round — see the Step 2
// implementation report for confirmation.
'use strict';

const path = require('path');

// MEDIUM 4 (Step 2 third repair round): validate the operator-supplied UID BEFORE any
// Firestore read/write is attempted, using the exact same semantics as the scheduler's
// isValidUidForPath (functions/src/reminderSchedulerLogic.ts) — hand-duplicated here
// rather than required from functions/lib/, matching this codebase's established
// convention of duplicating small pure-logic checks across independently-reviewed files
// instead of introducing a cross-file dependency (this file must remain reachable and
// runnable even if functions/lib/ has never been built). The ONLY reason `/` is rejected
// is that this script, like the scheduler, interpolates the UID directly into a
// slash-delimited Firestore document path string below — this is not a general "Firebase
// UID grammar" and spaces are deliberately NOT rejected, since Firebase UIDs may
// legitimately contain them.
function isValidUidForPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

async function main() {
  const uid = process.argv[2];
  const confirm = process.argv.includes('--confirm');

  if (!uid || uid.startsWith('--')) {
    console.error('Usage: node repairInvalidRevisionPreference.js <uid> [--confirm]');
    process.exit(1);
  }

  if (!isValidUidForPath(uid)) {
    console.error(
      `Invalid uid: ${JSON.stringify(uid)}. A uid must be nonempty, at most 128 characters, and must not contain '/'. ` +
        'No Firestore read or write was attempted.'
    );
    process.exit(1);
  }

  // Loaded lazily, from the already-installed functions/node_modules, so this script
  // has no separate dependency footprint of its own.
  const admin = require(path.join(__dirname, '..', 'node_modules', 'firebase-admin'));

  if (admin.apps.length === 0) {
    admin.initializeApp({ projectId: 'neuroactive' });
  }
  const db = admin.firestore();

  const APP_ID = 'neuroactive-prod';
  const ref = db.doc(`artifacts/${APP_ID}/users/${uid}/notificationPreferences/main`);

  const snap = await ref.get();
  if (!snap.exists) {
    console.log(`No notificationPreferences document exists for uid ${uid}. Nothing to repair.`);
    process.exit(0);
  }

  const current = snap.data();
  console.log('=== CURRENT DOCUMENT CONTENT (review before confirming) ===');
  console.log(JSON.stringify(current, null, 2));
  console.log('=============================================================');

  const rawRevision = current.revision;
  const isValidRevision =
    typeof rawRevision === 'number' &&
    Number.isFinite(rawRevision) &&
    Number.isInteger(rawRevision) &&
    Number.isSafeInteger(rawRevision) &&
    rawRevision >= 1;

  if (isValidRevision) {
    console.log(
      `revision (${JSON.stringify(rawRevision)}) already passes validation for this document — this script is ` +
        'specifically for the invalid-revision case. If the corruption is elsewhere (schedule fields, ' +
        'nextReminderDueAt type), the user can self-repair via a normal explicit Settings save instead; no ' +
        'operator action is needed.'
    );
    process.exit(0);
  }

  console.log(`Detected invalid revision: ${JSON.stringify(rawRevision)}`);

  if (!confirm) {
    console.log('\nDry preview only — no write performed. Re-run with --confirm to apply the repair.');
    process.exit(0);
  }

  const knownValidReplacement = {
    enabled: false,
    scheduleType: 'daily',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    localTime: '07:00',
    timezone: 'UTC',
    revision: 1,
    nextReminderDueAt: null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(knownValidReplacement);

  console.log('\nRepair applied. The document has been fully replaced with a known-valid, DISABLED state:');
  console.log(JSON.stringify({ ...knownValidReplacement, updatedAt: '<server timestamp>' }, null, 2));
  console.log(
    '\nThe user must re-enable and reconfigure reminders via Settings — their prior intended schedule was ' +
      'not guessed or restored, since it may have been part of what was corrupted.'
  );

  // MEDIUM 3 (Step 2 third repair round): the client's revision watermark (see Step 1,
  // functions/src/notificationPreferences.ts / src/hooks/useNotificationPreferences.ts)
  // remembers the highest revision it has observed during the current session and will
  // reject a server revision lower than that watermark as a stale write. Resetting this
  // document's revision to 1 is correct and required for CAS safety (it MUST conflict
  // against any stale client still holding a higher expectedRevision) but is NOT visible
  // in an already-open client session until the watermark itself is reset. Do not "fix"
  // this by picking an arbitrarily large revision number to beat the watermark — that
  // would defeat the CAS guard for a different reason. The only correct next step is a
  // full client reload / re-auth.
  console.log(
    '\nRepair complete. The affected user must fully reload NeuroActive or sign out/in so the client revision watermark resets.'
  );
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
