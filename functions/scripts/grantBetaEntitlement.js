// functions/scripts/grantBetaEntitlement.js
//
// One-off, manually-run Admin SDK script to grant DNS Foundations entitlement to a
// small, explicit list of beta-cohort Firebase UIDs. NOT part of the deployed Cloud
// Functions codebase — this file is never imported/exported by functions/src/index.ts,
// so `firebase deploy --only functions` cannot pick it up or expose it as a callable.
// It only ever reuses firebase-admin already installed in functions/node_modules.
//
// RUN FROM GOOGLE CLOUD SHELL (the only supported/documented method — see bottom of
// this file for exact commands). Cloud Shell is already authenticated as your own
// Google identity with Application Default Credentials available automatically — no
// service-account key file is downloaded, generated, or required.
//
// Safety properties:
//   - Fails closed on project: projectId is hardcoded to 'neuroactive', never inferred.
//   - Fails loudly: any Admin SDK / Firestore / auth error aborts immediately with a
//     clear message and non-zero exit code — never silently skips or continues.
//   - Dry-run by default: prints the full plan (every UID + what would happen) and
//     performs zero writes unless invoked with --execute.
//   - Only ever WRITES when a uid currently has no entitlement document at all. Every
//     other existing state (already beta-granted, already paid, or explicitly
//     false/revoked) is skipped — this script can never overwrite or downgrade
//     legitimate entitlement provenance, and never auto-re-grants a revoked account.
//   - UID list is explicit and hardcoded below — no email lookup, no resolution logic.
//   - Every UID is validated (type, trimmed, non-empty, no "/", safe character set) and
//     deduplicated BEFORE Admin SDK initialization or any Firestore access.
//   - The actual grant write at --execute time uses an atomic create-only operation
//     (DocumentReference.create), not a plan-then-set — if an entitlement document was
//     created by anything else (e.g. a real purchase) between planning and writing, the
//     create fails instead of silently overwriting it.

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- Explicit UID list -------------------------------------------------------------
// Fill in with the exact Firebase UIDs for the initial beta cohort (found via Firebase
// Console -> Authentication -> Users). Deliberately NOT resolved from email here — per
// requirements, only UIDs you've separately confirmed are accepted.
const BETA_COHORT_UIDS = [
  'hnf35g3YI5X4yKV2JZllK4DbX0c2',
];

// --- Fixed, non-configurable targets ------------------------------------------------
const PROJECT_ID = 'neuroactive';
const APP_ID = 'neuroactive-prod'; // must match APP_ID in functions/src/index.ts / src/App.tsx
const COHORT = 'initial_beta';

const EXECUTE = process.argv.includes('--execute');

function entitlementPath(uid) {
  return `artifacts/${APP_ID}/users/${uid}/entitlement/main`;
}

// Firebase Auth UIDs are drawn from a small, well-known character set. Rather than
// enumerate every disallowed case (whitespace, control characters, path separators,
// etc.) separately, everything not in this allow-list is simply rejected — the "/"
// check runs first only so a path-altering value gets a specifically clear message,
// since that's the more dangerous case (it changes which document gets written).
const SAFE_UID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Runs before Admin SDK init / any Firestore access — a bad UID here must never reach a
// Firestore call at all. Trims harmless outer whitespace and drops exact duplicates;
// anything else wrong with an entry is fatal for the whole run, not just that entry.
function validateAndDedupeUids(rawList) {
  const seen = new Set();
  const valid = [];
  const errors = [];

  rawList.forEach((raw, index) => {
    if (typeof raw !== 'string') {
      errors.push(`  [index ${index}] not a string: ${JSON.stringify(raw)}`);
      return;
    }

    const trimmed = raw.trim();
    if (trimmed !== raw) {
      console.log(`Note: trimmed outer whitespace from UID at index ${index}: ${JSON.stringify(raw)} -> ${JSON.stringify(trimmed)}`);
    }

    if (trimmed === '') {
      errors.push(`  [index ${index}] empty or whitespace-only: ${JSON.stringify(raw)}`);
      return;
    }

    if (trimmed.includes('/')) {
      errors.push(`  [index ${index}] contains "/", which would alter the Firestore document path: ${JSON.stringify(raw)}`);
      return;
    }

    if (!SAFE_UID_PATTERN.test(trimmed)) {
      errors.push(`  [index ${index}] contains characters outside the safe UID set [A-Za-z0-9_-]: ${JSON.stringify(raw)}`);
      return;
    }

    if (seen.has(trimmed)) {
      console.log(`Note: duplicate UID removed (already included): ${trimmed}`);
      return;
    }

    seen.add(trimmed);
    valid.push(trimmed);
  });

  if (errors.length > 0) {
    console.error('FATAL: invalid UID(s) found in BETA_COHORT_UIDS — fix these and re-run:');
    errors.forEach((e) => console.error(e));
    process.exit(1);
  }

  return valid;
}

// grpc.status.ALREADY_EXISTS — the code the Admin Firestore SDK surfaces when
// DocumentReference.create() targets a path that already has a document. Matched on
// both code and message text since error-wrapping has varied across SDK versions.
const FIRESTORE_ALREADY_EXISTS_CODE = 6;
function isAlreadyExistsError(err) {
  if (!err) return false;
  if (err.code === FIRESTORE_ALREADY_EXISTS_CODE) return true;
  if (typeof err.message === 'string' && /already exists/i.test(err.message)) return true;
  return false;
}

// Firestore Timestamp normally has .toDate(), but this is diagnostic display code
// reading a field nothing in this codebase writes as anything other than a Timestamp —
// don't let an unexpected shape here crash the plan report.
function formatTimestamp(value) {
  if (value && typeof value.toDate === 'function') {
    try {
      return value.toDate().toISOString();
    } catch {
      return '(missing/unreadable)';
    }
  }
  return '(missing/unreadable)';
}

async function main() {
  console.log(`Project: ${PROJECT_ID}`);
  console.log(`Mode: ${EXECUTE ? 'EXECUTE (writes will be performed)' : 'DRY RUN (no writes will be performed)'}`);
  console.log('');

  if (BETA_COHORT_UIDS.length === 0) {
    console.error('No UIDs configured in BETA_COHORT_UIDS — nothing to do. Edit this file to add the beta cohort\'s Firebase UIDs, then re-run.');
    process.exit(1);
  }

  // Validation/dedup happens before ANY Admin SDK or Firestore call — a malformed UID
  // must never reach a Firestore path.
  const uids = validateAndDedupeUids(BETA_COHORT_UIDS);

  if (uids.length === 0) {
    console.error('FATAL: no valid UIDs remained after validation — nothing to do.');
    process.exit(1);
  }

  console.log(`Validated ${uids.length} unique UID(s).`);
  console.log('');

  let app;
  try {
    app = initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    });
  } catch (err) {
    console.error('FATAL: could not initialize Firebase Admin SDK with Application Default Credentials.');
    console.error('This usually means you are not running inside an authenticated Google Cloud Shell session.');
    console.error(String(err));
    process.exit(1);
  }

  if (app.options.projectId !== PROJECT_ID) {
    // Defense in depth — this can only happen if PROJECT_ID above is ever edited
    // inconsistently, since we pass it explicitly ourselves. Catching it anyway rather
    // than silently trusting it.
    console.error(`FATAL: resolved project "${app.options.projectId}" does not match expected "${PROJECT_ID}". Aborting without writing anything.`);
    process.exit(1);
  }

  const db = getFirestore(app);

  // Plan is computed in full, for every uid, before any write happens — this is the
  // "print exactly which UIDs it will grant before writing" step, and it runs
  // identically in both dry-run and --execute mode.
  const plan = [];
  for (const uid of uids) {
    const ref = db.doc(entitlementPath(uid));
    let snap;
    try {
      snap = await ref.get();
    } catch (err) {
      console.error(`FATAL: could not read ${entitlementPath(uid)} — aborting the entire run rather than continuing with unreliable access.`);
      console.error('This usually means the signed-in Google account lacks Firestore access on this project (check IAM), or Application Default Credentials are missing/expired.');
      console.error(String(err));
      process.exit(1);
    }

    if (!snap.exists) {
      plan.push({ uid, action: 'GRANT', reason: 'no existing entitlement document' });
      continue;
    }

    const data = snap.data() || {};
    if (data.dnsFoundationsEntitled === true) {
      plan.push({
        uid,
        action: 'SKIP',
        reason: `already entitled (source: ${JSON.stringify(data.source ?? null)}) — never overwriting existing true entitlement`,
      });
      continue;
    }

    if (data.dnsFoundationsEntitled === false) {
      plan.push({
        uid,
        action: 'FLAG_FOR_REVIEW',
        reason: `dnsFoundationsEntitled is explicitly false (source: ${JSON.stringify(data.source ?? null)}, updatedAt: ${formatTimestamp(data.updatedAt)}) — no code path in this project ever writes false automatically, so this can only be a deliberate manual revocation (e.g. after a refund). NOT auto-granting. Review this account manually before deciding.`,
      });
      continue;
    }

    plan.push({
      uid,
      action: 'FLAG_FOR_REVIEW',
      reason: `entitlement document exists in an unexpected shape (raw: ${JSON.stringify(data)}) — not matching any known-good pattern. NOT auto-granting.`,
    });
  }

  console.log('Plan:');
  for (const item of plan) {
    console.log(`  [${item.action}] ${item.uid} — ${item.reason}`);
  }
  console.log('');

  const toGrant = plan.filter((p) => p.action === 'GRANT');
  const toSkip = plan.filter((p) => p.action === 'SKIP');
  const toFlag = plan.filter((p) => p.action === 'FLAG_FOR_REVIEW');

  console.log(`Summary: ${toGrant.length} to grant, ${toSkip.length} already entitled (skipped), ${toFlag.length} flagged for manual review.`);

  if (!EXECUTE) {
    console.log('');
    console.log('DRY RUN — no writes were performed. Re-run with --execute to apply the GRANT actions above.');
    return;
  }

  if (toGrant.length === 0) {
    console.log('');
    console.log('Nothing to write — no uid qualifies for a grant.');
    return;
  }

  console.log('');
  console.log('Writing grants...');
  for (const item of toGrant) {
    const ref = db.doc(entitlementPath(item.uid));
    try {
      // create(), not set()/merge — atomic, fails outright if a document now exists at
      // this path. Planning happened earlier and is not re-checked here, so this is the
      // only thing standing between "no document at plan time" and actually overwriting
      // something that appeared in between (e.g. a real purchase completing).
      await ref.create({
        dnsFoundationsEntitled: true,
        source: 'beta_grant',
        cohort: COHORT,
        updatedAt: FieldValue.serverTimestamp(),
      });
      console.log(`  granted: ${item.uid}`);
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        console.log(`  SKIPPED ${item.uid}: an entitlement document now exists that didn't exist during planning — not overwriting it. Re-run the script to see its current state.`);
        continue;
      }
      console.error(`  FAILED to write ${item.uid}: ${String(err)}`);
      console.error('Aborting remaining writes rather than continuing after a failure.');
      process.exit(1);
    }
  }
  console.log('');
  console.log('Done.');
}

main().catch((err) => {
  console.error('FATAL: unexpected error.');
  console.error(err);
  process.exit(1);
});

// --- How to run (Google Cloud Shell only) -------------------------------------------
//
// 1. Open Google Cloud Shell (console.cloud.google.com -> Activate Cloud Shell), signed
//    in as an account with Firestore write access on the neuroactive project.
// 2. Clone the repo and install the functions dependencies (firebase-admin lives there):
//      git clone https://github.com/WorldInHeat/neuroactive.git
//      cd neuroactive/functions
//      npm install
// 3. Edit scripts/grantBetaEntitlement.js in the Cloud Shell editor (or `nano`/`vim`) to
//    fill in BETA_COHORT_UIDS with the real Firebase UIDs for this cohort.
// 4. Dry run first (always):
//      node scripts/grantBetaEntitlement.js
// 5. Review the printed plan carefully. If it looks correct, apply it:
//      node scripts/grantBetaEntitlement.js --execute
