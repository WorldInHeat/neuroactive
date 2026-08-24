#!/usr/bin/env node
// functions/maintenance/migratePushInstallationEpochs.js
//
// Phase 3A-3 Step 3A (final migration-boundary repair round) — ONE-TIME, TRUSTED
// OPERATOR-ONLY migration tool. This is PHASE A of the two-phase epoch-migration
// architecture documented in functions/src/pushInstallationEpochLogic.ts: it is the
// ONLY code, ever, permitted to recognize a genuinely pre-Step-3A legacy
// pushInstallations record (epochSchemaVersion AND tokenVersion both physically absent)
// and establish fresh epoch fields for it. PHASE B is the ordinary, permanently CLOSED
// runtime lifecycle in functions/src/pushInstallations.ts, which after this migration
// has run never again asks "could this be legacy" — only "is this the exact migrated
// shape." Codex specifically rejected an earlier design that let runtime code
// self-normalize legacy records forever, because that could never be proven closed: if
// epochSchemaVersion and tokenVersion were ever BOTH deleted out-of-band after a record
// had already been migrated, permanent runtime code would silently re-treat it as fresh
// legacy and recycle an epoch value a future sender may already have observed. Running
// this migration once, reviewing its output, and then permanently removing runtime
// normalization (already done, in the same round as this script) closes that gap.
//
// STRUCTURAL SAFETY — this file can NEVER be deployed:
//   functions/tsconfig.json's `include` is `["src"]` only. This file lives under
//   functions/maintenance/, entirely outside that scope, so `tsc` never compiles it and
//   it is not reachable from functions/lib/index.js (the only thing
//   functions/package.json's "main" field, and therefore `firebase deploy --only
//   functions`, ever looks at). It is not imported by, and never will be imported by,
//   any file under functions/src.
//
// WHY THIS SCRIPT REQUIRES THE COMPILED functions/lib/ OUTPUT (unlike the smaller UID
// check hand-duplicated in repairInvalidRevisionPreference.js): the classification logic
// here is materially more complex than a single UID-format check, and hand-duplicating
// it as plain JS would risk silent drift from the reviewed, tested TypeScript source in
// functions/src/pushInstallationEpochLogic.ts. This script instead `require()`s that
// module's COMPILED output directly, reusing the exact same functions
// functions/src/pushInstallations.ts and the repository-local test suite
// (pushInstallationEpochLogic.test.js) already exercise. You MUST run `npm run build` in
// functions/ before running this script.
//
// MODES:
//   Default (no flags) — READ-ONLY report. Enumerates every document, classifies it,
//     and prints a summary. Makes NO writes.
//   --confirm — performs the reviewed migration: for every record independently
//     re-proven migratable at write time, atomically establishes epochSchemaVersion,
//     tokenVersion, and installationAudienceId. Still makes NO writes to anything that
//     isn't a proven legacy candidate.
//   --verify — READ-ONLY real-delivery-readiness check: for every currently-'active'
//     installation, confirms it carries a fully valid migrated epoch (marker, version,
//     audience id) plus a coherent uid/token/claim. Prints READY or NOT READY. Never
//     normalizes anything, even in this mode.
//
// This script targets ONLY the `neuroactive` Firebase project (hardcoded below — not a
// CLI argument, so there is no way to accidentally point it elsewhere) and the
// `neuroactive-prod` app-id namespace already used throughout this codebase. It was NOT
// run against production as part of implementing this repair round — see the
// implementation report for confirmation.
//
// NEVER PRINTED, under any mode: raw FCM tokens, token hashes, lease hashes,
// recovery/transfer credentials, or installationAudienceId values. Document IDs ARE
// printed for records requiring operator attention (skipped/corrupt/manual-review), since
// installationId alone is not a credential (see the extensive header comment in
// pushInstallations.ts on this exact point) and an operator needs it to investigate.
'use strict';

const path = require('path');
const crypto = require('node:crypto');

const PROJECT_ID = 'neuroactive';
const APP_ID = 'neuroactive-prod';
const PAGE_SIZE = 200;

function hashToken(token) {
  // Must match pushInstallations.ts's hashCredential exactly (sha256, hex) — this is
  // the same function used for BOTH credential hashing and token-claim hashing there.
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function main() {
  const confirm = process.argv.includes('--confirm');
  const verify = process.argv.includes('--verify');
  if (confirm && verify) {
    console.error('Usage: choose at most one of --confirm or --verify (or neither, for a dry-run report).');
    process.exit(1);
  }

  let epochLogic;
  try {
    epochLogic = require(path.join(__dirname, '..', 'lib', 'pushInstallationEpochLogic.js'));
  } catch (err) {
    console.error('FATAL: could not load compiled pushInstallationEpochLogic.js. Run `npm run build` in functions/ first.');
    console.error(String(err && err.message ? err.message : err));
    process.exit(1);
  }
  const {
    readFieldPresence,
    classifyLegacyEpochForMigration,
    proveLegacyActiveCandidateForMigration,
    proveLegacyRevokedTombstoneForMigration,
    buildLegacyMigrationWritePlan,
    classifyEpochSchemaMarker,
    classifyTokenVersionField,
    isValidAudienceId,
  } = epochLogic;

  // Modular Admin SDK API (the installed firebase-admin version exposes only this
  // shape at its root — no `.apps`, no `.firestore()` method — matching exactly what
  // functions/src/pushInstallations.ts itself already imports from 'firebase-admin/app'
  // and 'firebase-admin/firestore'). This script binds to its OWN explicitly named Admin
  // app rather than any ambient default app: an ambient default (or another named) app
  // could exist and point at an unrelated project, and getFirestore() with no app
  // argument binds to whatever ambient default happens to be initialized rather than to
  // the exact app this script intends. getApp(name) throws a FirebaseAppError with code
  // 'app/no-app' (verified against the installed package) when no app of that name
  // exists yet; that is the only case in which this script initializes one itself. If a
  // same-named app already exists (e.g. this module was required twice in one process),
  // its projectId is re-validated below rather than trusted on name alone.
  const { getApp, initializeApp } = require('firebase-admin/app');
  const { getFirestore } = require('firebase-admin/firestore');
  const MAINTENANCE_APP_NAME = 'neuroactive-maintenance-epoch-migration';

  let app;
  try {
    app = getApp(MAINTENANCE_APP_NAME);
  } catch (err) {
    if (!err || err.code !== 'app/no-app') {
      throw err;
    }
    app = initializeApp({ projectId: PROJECT_ID }, MAINTENANCE_APP_NAME);
  }

  if (app.options.projectId !== PROJECT_ID) {
    throw new Error(
      `Refusing to operate: maintenance Firebase app "${MAINTENANCE_APP_NAME}" is bound to project ` +
        `${JSON.stringify(app.options.projectId)}, not the expected ${JSON.stringify(PROJECT_ID)}. No Firestore access was attempted.`
    );
  }

  const db = getFirestore(app);

  const installationsCollection = db.collection(`artifacts/${APP_ID}/pushInstallations`);
  function tokenClaimRef(hash) {
    return db.doc(`artifacts/${APP_ID}/pushTokenClaims/${hash}`);
  }

  if (verify) {
    await runVerify();
    return;
  }

  await runMigration();

  // =======================================================================
  // --verify: read-only real-delivery-readiness check over ACTIVE installations only.
  // =======================================================================
  async function runVerify() {
    console.log('=== REAL-DELIVERY READINESS VERIFICATION (read-only; no writes) ===');
    let lastDoc = null;
    let totalActive = 0;
    let ready = 0;
    const notReady = [];

    for (;;) {
      let query = installationsCollection.where('state', '==', 'active').orderBy('__name__').limit(PAGE_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        totalActive++;
        const data = doc.data();
        const reasons = [];

        if (classifyEpochSchemaMarker(readFieldPresence(data, 'epochSchemaVersion')) !== 'current') reasons.push('epochSchemaVersion-not-current');
        if (classifyTokenVersionField(readFieldPresence(data, 'tokenVersion')) !== 'valid') reasons.push('tokenVersion-not-valid');
        if (!isValidAudienceId(data.installationAudienceId)) reasons.push('installationAudienceId-not-valid');
        if (typeof data.uid !== 'string' || data.uid.length === 0) reasons.push('uid-invalid');
        if (typeof data.token !== 'string' || data.token.length === 0) reasons.push('token-missing');

        if (reasons.length === 0 && typeof data.token === 'string') {
          const claimSnap = await tokenClaimRef(hashToken(data.token)).get();
          const claim = claimSnap.exists ? claimSnap.data() : null;
          if (!claim || claim.installationId !== doc.id || claim.uid !== data.uid) {
            reasons.push('token-claim-mismatch-or-missing');
          }
        }

        if (reasons.length === 0) {
          ready++;
        } else {
          notReady.push({ id: doc.id, reasons });
        }
      }
      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < PAGE_SIZE) break;
    }

    console.log(JSON.stringify({ totalActive, ready, notReadyCount: notReady.length }, null, 2));
    if (notReady.length > 0) {
      console.log('\nNOT READY — the following active installation IDs failed one or more checks:');
      console.log(JSON.stringify(notReady, null, 2));
      console.log('\n*** REAL DELIVERY NOT READY ***');
    } else {
      console.log('\n*** REAL DELIVERY READY (all active installations pass) ***');
    }
  }

  // =======================================================================
  // Default / --confirm: full paginated enumeration, classification, and (only under
  // --confirm) the actual reviewed migration write.
  // =======================================================================
  async function runMigration() {
    console.log(confirm ? '=== MIGRATION (--confirm: writes WILL be performed) ===' : '=== MIGRATION DRY-RUN / REPORT-ONLY (no writes; re-run with --confirm to migrate) ===');

    const report = {
      total: 0,
      alreadyMigrated: 0,
      legacyCandidates: 0,
      migrated: 0,
      migratedBreakdown: { activeShaped: 0, revokedTombstone: 0 },
      skippedAmbiguous: 0, // looked migratable at enumeration time, but lost a concurrent race at write time
      corrupt: 0,
      manualReview: 0, // a legacy-candidate shape at the epoch-field level, but state-specific proof failed deterministically
    };
    const corruptIds = [];
    const manualReviewIds = [];
    const skippedAmbiguousIds = [];

    let lastDoc = null;
    for (;;) {
      // Full, unbounded-prefix-safe pagination — orderBy + startAfter guarantees every
      // document is eventually visited exactly once, regardless of collection size.
      let query = installationsCollection.orderBy('__name__').limit(PAGE_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      if (snap.empty) break;

      for (const doc of snap.docs) {
        report.total++;
        await classifyAndMaybeMigrate(doc.id, doc.data());
      }

      lastDoc = snap.docs[snap.docs.length - 1];
      if (snap.docs.length < PAGE_SIZE) break;
    }

    console.log(JSON.stringify(report, null, 2));
    if (skippedAmbiguousIds.length > 0) console.log('\nskippedAmbiguous IDs:', JSON.stringify(skippedAmbiguousIds));
    if (corruptIds.length > 0) console.log('\ncorrupt IDs (requires operator review):', JSON.stringify(corruptIds));
    if (manualReviewIds.length > 0) console.log('\nmanualReview IDs (requires operator review):', JSON.stringify(manualReviewIds));
    if (!confirm) {
      console.log('\nDry-run/report-only — no writes performed. Re-run with --confirm to perform the reviewed migration.');
    } else {
      console.log('\nMigration pass complete.');
    }

    async function classifyAndMaybeMigrate(installationId, data) {
      const shapeVerdict = classifyLegacyEpochForMigration(readFieldPresence(data, 'epochSchemaVersion'), readFieldPresence(data, 'tokenVersion'));

      if (shapeVerdict.verdict === 'already-migrated') {
        report.alreadyMigrated++;
        return;
      }
      if (shapeVerdict.verdict === 'corrupt') {
        report.corrupt++;
        corruptIds.push({ id: installationId, reason: shapeVerdict.reason });
        return;
      }

      // shapeVerdict.verdict === 'legacy-candidate'.
      report.legacyCandidates++;

      const state = data.state;
      let proof;
      let kind;
      if (state === 'revoked') {
        kind = 'revokedTombstone';
        proof = proveLegacyRevokedTombstoneForMigration({ state: data.state, token: data.token, uid: data.uid }) ? { proven: true } : { proven: false, reason: 'tombstone-shape-mismatch' };
      } else {
        kind = 'activeShaped';
        // Claim lookup only ever reads installationId/uid off the claim doc — never the
        // raw token, never any hash value into any log line.
        let claim = null;
        if (typeof data.token === 'string' && data.token.length > 0) {
          const claimSnap = await tokenClaimRef(hashToken(data.token)).get();
          claim = { exists: claimSnap.exists, installationId: claimSnap.exists ? claimSnap.data().installationId : undefined, uid: claimSnap.exists ? claimSnap.data().uid : undefined };
        }
        proof = proveLegacyActiveCandidateForMigration({ state: data.state, uid: data.uid, token: data.token, installationId, claim });
      }

      if (!proof.proven) {
        report.manualReview++;
        manualReviewIds.push({ id: installationId, reason: proof.reason });
        return;
      }

      if (!confirm) {
        // Dry-run: proven migratable, but no write is performed. Counted under
        // legacyCandidates/report only; not double-counted as migrated.
        return;
      }

      const outcome = await migrateOneRecord(installationId, kind);
      if (outcome === 'migrated') {
        report.migrated++;
        report.migratedBreakdown[kind]++;
      } else if (outcome === 'already-migrated') {
        report.alreadyMigrated++;
        report.legacyCandidates--; // it was counted as a candidate above; correct the double-count now that fresh data shows it was already done.
      } else {
        report.skippedAmbiguous++;
        skippedAmbiguousIds.push(installationId);
      }
    }

    // One Firestore transaction per record: re-reads fresh, re-proves from scratch
    // (never trusts the enumeration-time snapshot), and only then writes. Never
    // overwrites a newer/valid epoch — if the fresh read shows the record is already
    // migrated (a concurrent lifecycle transaction, or a previous migration run, beat
    // this one to it), this is an idempotent no-op. If the fresh read shows anything
    // else unexpected (state changed, claim changed), it skips safely rather than
    // guessing.
    async function migrateOneRecord(installationId, kind) {
      const ref = db.doc(`artifacts/${APP_ID}/pushInstallations/${installationId}`);
      return db.runTransaction(async (transaction) => {
        const snap = await transaction.get(ref);
        if (!snap.exists) return 'skipped';
        const fresh = snap.data();

        const freshShape = classifyLegacyEpochForMigration(readFieldPresence(fresh, 'epochSchemaVersion'), readFieldPresence(fresh, 'tokenVersion'));
        if (freshShape.verdict === 'already-migrated') return 'already-migrated';
        if (freshShape.verdict !== 'legacy-candidate') return 'skipped';

        let freshProof;
        if (kind === 'revokedTombstone') {
          freshProof = proveLegacyRevokedTombstoneForMigration({ state: fresh.state, token: fresh.token, uid: fresh.uid });
          if (!freshProof) return 'skipped';
        } else {
          let claim = null;
          if (typeof fresh.token === 'string' && fresh.token.length > 0) {
            const claimSnap = await transaction.get(tokenClaimRef(hashToken(fresh.token)));
            claim = { exists: claimSnap.exists, installationId: claimSnap.exists ? claimSnap.data().installationId : undefined, uid: claimSnap.exists ? claimSnap.data().uid : undefined };
          }
          const proof = proveLegacyActiveCandidateForMigration({ state: fresh.state, uid: fresh.uid, token: fresh.token, installationId, claim });
          if (!proof.proven) return 'skipped';
        }

        const plan = buildLegacyMigrationWritePlan(fresh.installationAudienceId);
        // Writes EXACTLY these three fields — never generation, token, uid, state,
        // lease/transfer/recovery credentials, activeCount, or any unrelated timestamp.
        transaction.set(
          ref,
          {
            epochSchemaVersion: plan.epochSchemaVersion,
            tokenVersion: plan.tokenVersion,
            installationAudienceId: plan.installationAudienceId,
          },
          { merge: true }
        );
        return 'migrated';
      });
    }
  }
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
