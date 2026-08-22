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
//   - Only ever touches the single `beta_grant` basis on the entitlement document (see
//     functions/src/dnsEntitlement.ts) — every other basis (a Stripe purchase, a $0
//     promotional Checkout) is read back unchanged and rewritten as-is, so this script
//     can grant beta access to an account that also has a real, or even a refunded,
//     purchase on it without touching that purchase's own basis either way. A uid whose
//     beta_grant basis is already active is skipped (idempotent, safe to re-run).
//   - UID list is explicit and hardcoded below — no email lookup, no resolution logic.
//   - Every UID is validated (type, trimmed, non-empty, no "/", safe character set) and
//     deduplicated BEFORE Admin SDK initialization or any Firestore access.
//   - The actual grant write at --execute time is a Firestore transaction: read the
//     current document, merge in an active beta_grant basis alongside every existing
//     basis untouched, recompute the derived dnsFoundationsEntitled/source fields from
//     the full merged set, write. A document with no existing entitlement at all, and a
//     document with other active bases, are both handled by the same transaction.

const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');

// --- Explicit UID list -------------------------------------------------------------
// Fill in with the exact Firebase UIDs for the initial beta cohort (found via Firebase
// Console -> Authentication -> Users). Deliberately NOT resolved from email here — per
// requirements, only UIDs you've separately confirmed are accepted.
const BETA_COHORT_UIDS = [
  'y8ZkA5HM93gcwGrhXHUMf3fBue32',
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

// Mirrors isValidActiveBasis in functions/src/dnsEntitlement.ts EXACTLY — the single
// validity predicate for "does this basis entry actually authorize DNS access."
// `active: true` alone is never sufficient: the basis's key, type, and provenance ID
// must all agree with one of the three recognized, structurally valid forms. Duplicated
// here (not imported) because this script runs standalone in Cloud Shell and is
// deliberately not part of the deployed Functions codebase (see header) — but the logic
// must stay identical, or this script could compute effective entitlement differently
// than the deployed Functions do. Keep the two in sync if the basis model ever changes.
function isValidActiveBasis(basisKey, basis) {
  if (!basis || basis.active !== true) return false;
  // A terminally revoked basis can never authorize, independent of key/type/provenance
  // checks below — this must hold even if `active: true` is also present due to
  // malformed, historical, or otherwise corrupt state.
  if (basis.terminal === true) return false;

  if (basisKey === 'beta_grant') {
    return basis.type === 'beta_grant';
  }

  const paidPrefix = 'stripe_program:';
  if (basisKey.startsWith(paidPrefix)) {
    const paymentIntentId = basisKey.slice(paidPrefix.length);
    return (
      basis.type === 'stripe_program' &&
      paymentIntentId.length > 0 &&
      basis.stripePaymentId === paymentIntentId
    );
  }

  const zeroTotalPrefix = 'stripe_program_zero_total:';
  if (basisKey.startsWith(zeroTotalPrefix)) {
    const checkoutSessionId = basisKey.slice(zeroTotalPrefix.length);
    return (
      basis.type === 'stripe_program_zero_total' &&
      checkoutSessionId.length > 0 &&
      basis.stripeCheckoutSessionId === checkoutSessionId
    );
  }

  // Every other key shape, including any `legacy_unknown:*` key, is never authorizing.
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

  // Is the beta_grant basis already active on this uid's document? Checks both the
  // current per-basis shape and the legacy flat shape (a document written before
  // per-basis tracking existed, which never had a `bases` field at all).
  function betaBasisAlreadyActive(data) {
    if (data.bases) return isValidActiveBasis('beta_grant', data.bases.beta_grant);
    return data.source === 'beta_grant' && data.dnsFoundationsEntitled === true;
  }

  // Plan is computed in full, for every uid, before any write happens — this is the
  // "print exactly which UIDs it will grant before writing" step, and it runs
  // identically in both dry-run and --execute mode. GRANT here means "ensure the
  // beta_grant basis is active" — it says nothing about, and never touches, any other
  // basis (a Stripe purchase, active or refunded) that may also be on the document.
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

    if (betaBasisAlreadyActive(data)) {
      plan.push({
        uid,
        action: 'SKIP',
        reason: 'beta_grant basis is already active — never re-writing an already-active basis',
      });
      continue;
    }

    if (!data.bases && data.dnsFoundationsEntitled === false) {
      plan.push({
        uid,
        action: 'FLAG_FOR_REVIEW',
        reason: `legacy document has dnsFoundationsEntitled explicitly false (source: ${JSON.stringify(data.source ?? null)}, updatedAt: ${formatTimestamp(data.updatedAt)}) — this predates per-basis tracking and no code path writes false automatically for a legacy document, so this can only be a deliberate manual revocation. NOT auto-granting beta access over it without review.`,
      });
      continue;
    }

    plan.push({
      uid,
      action: 'GRANT',
      reason: data.bases || data.dnsFoundationsEntitled === true
        ? `beta_grant basis not yet active (existing source: ${JSON.stringify(data.source ?? null)}) — other bases on this document, if any, are left untouched`
        : 'entitlement document exists in an unrecognized shape — granting beta_grant basis only, every other field is left untouched',
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

  // Mirrors applyDnsEntitlementBasis in functions/src/dnsEntitlement.ts — duplicated
  // here in plain JS rather than imported, since this script runs standalone in Cloud
  // Shell and is deliberately not part of the deployed Functions codebase (see header).
  // Keep the two in sync if the basis model ever changes.
  async function grantBetaBasis(uid) {
    const ref = db.doc(entitlementPath(uid));
    return db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const data = snap.exists ? snap.data() || {} : {};
      const bases = { ...(data.bases || {}) };
      const now = FieldValue.serverTimestamp();

      // One-time implicit migration: a legacy document (no `bases` field yet) that
      // already has some OTHER active grant must have that grant represented as its
      // own basis before this beta_grant basis is added, or it would silently vanish
      // from the effective computation the moment a second basis is ever recorded.
      if (!data.bases && data.dnsFoundationsEntitled === true && typeof data.source === 'string') {
        if (data.source === 'stripe:program' && typeof data.stripePaymentId === 'string') {
          bases[`stripe_program:${data.stripePaymentId}`] = {
            type: 'stripe_program',
            active: true,
            stripePaymentId: data.stripePaymentId,
            migratedFromLegacy: true,
            createdAt: now,
            updatedAt: now,
          };
        } else if (
          data.source === 'stripe:program:zero-total-checkout' &&
          typeof data.stripeCheckoutSessionId === 'string'
        ) {
          bases[`stripe_program_zero_total:${data.stripeCheckoutSessionId}`] = {
            type: 'stripe_program_zero_total',
            active: true,
            stripeCheckoutSessionId: data.stripeCheckoutSessionId,
            migratedFromLegacy: true,
            createdAt: now,
            updatedAt: now,
          };
        } else if (data.source !== 'beta_grant') {
          // Fail closed, not open: every source string this project has ever written is
          // one of the three handled above, so this should be structurally unreachable —
          // but an unrecognized state must never keep authorizing access just because it
          // used to. Migrated INACTIVE and flagged for manual review, matching
          // functions/src/dnsEntitlement.ts's migrateLegacyBasis exactly.
          console.warn(`  NOTE: ${uid} has an unrecognized legacy entitlement source (${JSON.stringify(data.source)}) — migrating as INACTIVE, flagged for manual review, not auto-granting access from it.`);
          bases[`legacy_unknown:${data.source}`] = {
            type: 'legacy_unknown',
            active: false,
            needsManualReview: true,
            unrecognizedLegacySource: data.source,
            migratedFromLegacy: true,
            createdAt: now,
            updatedAt: now,
          };
        }
      }

      const existingBetaBasis = bases.beta_grant;
      bases.beta_grant = {
        type: 'beta_grant',
        active: true,
        cohort: COHORT,
        createdAt: existingBetaBasis?.createdAt ?? now,
        updatedAt: now,
      };

      const effective = Object.entries(bases).some(([key, b]) => isValidActiveBasis(key, b));
      // legacy_unknown deliberately excluded — it never passes isValidActiveBasis, so it
      // never needs a display label, matching dnsEntitlement.ts's SOURCE_PRIORITY.
      const sourcePriority = ['stripe_program', 'stripe_program_zero_total', 'beta_grant'];
      const sourceStrings = {
        stripe_program: 'stripe:program',
        stripe_program_zero_total: 'stripe:program:zero-total-checkout',
        beta_grant: 'beta_grant',
      };
      let source = null;
      for (const type of sourcePriority) {
        const hit = Object.entries(bases).find(([key, b]) => b && b.type === type && isValidActiveBasis(key, b));
        if (hit) {
          source = sourceStrings[type];
          break;
        }
      }

      transaction.set(
        ref,
        {
          dnsFoundationsEntitled: effective,
          source,
          bases,
          updatedAt: now,
        },
        { merge: true }
      );
    });
  }

  console.log('');
  console.log('Writing grants...');
  for (const item of toGrant) {
    try {
      await grantBetaBasis(item.uid);
      console.log(`  granted: ${item.uid}`);
    } catch (err) {
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
