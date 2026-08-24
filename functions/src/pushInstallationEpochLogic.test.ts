// functions/src/pushInstallationEpochLogic.test.ts
// Phase 3A-3 Step 3A (final migration-boundary repair round) — real, repository-local
// test file for the push-installation epoch hardening's pure logic.
//
// This repo has no test runner configured (no jest/mocha in functions/package.json), so
// this file is a small, dependency-free, self-contained assertion script rather than
// reaching for new test infrastructure — the same established pattern as
// reminderSchedulerLogic.test.ts. It imports the ACTUAL functions
// functions/src/pushInstallations.ts and functions/maintenance/migratePushInstallationEpochs.js
// use (from pushInstallationEpochLogic.ts) — nothing here is a re-implementation.
//
// HOW TO RUN:
//   cd functions
//   npm run build
//   node lib/pushInstallationEpochLogic.test.js
//
// SCOPE / HONESTY NOTE: this file exercises every PURE function in
// pushInstallationEpochLogic.ts, including the migration-only classification/proof
// functions (tested here as PURE functions of plain-object inputs — this does NOT
// exercise the migration script's actual Firestore pagination, transactional re-proof,
// or concurrency behavior, which would require a Firestore emulator, unavailable in this
// development environment). Firestore's transaction-retry guarantee (relevant to both
// runtime lifecycle transactions and the migration tool's per-record write transaction)
// is verified by architectural reasoning in the implementation report, not by an
// executed test.
import {
  readFieldPresence,
  isValidTokenVersion,
  classifyTokenVersionField,
  EPOCH_SCHEMA_VERSION,
  classifyEpochSchemaMarker,
  decideRuntimeEpochOnEstablish,
  decideRuntimeEpochOnRevoke,
  isValidAudienceId,
  classifyAudienceIdField,
  generateAudienceId,
  decideAudienceIdForSameOwnerTransaction,
  classifyLegacyEpochForMigration,
  proveLegacyActiveCandidateForMigration,
  proveLegacyRevokedTombstoneForMigration,
  buildLegacyMigrationWritePlan,
  type FieldPresence,
} from './pushInstallationEpochLogic';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

const ABSENT: FieldPresence = { kind: 'absent' };
const NULLV: FieldPresence = { kind: 'null' };
function present(value: unknown): FieldPresence {
  return { kind: 'present', value };
}

// ============================================================================
// readFieldPresence — the explicit absent/null/present extraction, exercised against
// plain objects shaped like real snap.data() output.
// ============================================================================
console.log('=== readFieldPresence ===');
check('key genuinely never set -> absent', readFieldPresence({ other: 1 }, 'tokenVersion').kind === 'absent');
check('key set to explicit null -> null', readFieldPresence({ tokenVersion: null }, 'tokenVersion').kind === 'null');
check('key set to a real value -> present, value preserved', (() => {
  const r = readFieldPresence({ tokenVersion: 5 }, 'tokenVersion');
  return r.kind === 'present' && r.value === 5;
})());
check('undefined source object -> absent (no throw)', readFieldPresence(undefined, 'tokenVersion').kind === 'absent');
check('null source object -> absent (no throw)', readFieldPresence(null, 'tokenVersion').kind === 'absent');
check(
  'does not confuse an inherited/prototype property with an own field (hasOwnProperty, not `in`)',
  readFieldPresence(Object.create({ tokenVersion: 5 }), 'tokenVersion').kind === 'absent'
);

// ============================================================================
// tokenVersion / epochSchemaVersion — field-state classification.
// ============================================================================
console.log('\n=== isValidTokenVersion / classifyTokenVersionField ===');
check('1 is valid', isValidTokenVersion(1));
check('MAX_SAFE_INTEGER is valid (exhaustion is a separate, later check)', isValidTokenVersion(Number.MAX_SAFE_INTEGER));
check('0 is invalid', !isValidTokenVersion(0));
check('negative is invalid', !isValidTokenVersion(-1));
check('fractional is invalid', !isValidTokenVersion(1.5));
check('string is invalid', !isValidTokenVersion('1'));
check('NaN is invalid', !isValidTokenVersion(NaN));
check('Infinity is invalid', !isValidTokenVersion(Infinity));
check('unsafe integer is invalid', !isValidTokenVersion(Number.MAX_SAFE_INTEGER + 10));
check('absent presence -> absent', classifyTokenVersionField(ABSENT) === 'absent');
check('null presence -> null (distinct from absent)', classifyTokenVersionField(NULLV) === 'null');
check('present valid -> valid', classifyTokenVersionField(present(4)) === 'valid');
check('present malformed -> malformed', classifyTokenVersionField(present(0)) === 'malformed');

console.log('\n=== classifyEpochSchemaMarker ===');
check('EPOCH_SCHEMA_VERSION constant is 1', EPOCH_SCHEMA_VERSION === 1);
check('absent presence -> absent', classifyEpochSchemaMarker(ABSENT) === 'absent');
check('null presence -> null (distinct from absent)', classifyEpochSchemaMarker(NULLV) === 'null');
check('present, exactly 1 -> current', classifyEpochSchemaMarker(present(1)) === 'current');
check('present, 2 (future/unrecognized) -> unsupported', classifyEpochSchemaMarker(present(2)) === 'unsupported');
check('present, 0 -> unsupported', classifyEpochSchemaMarker(present(0)) === 'unsupported');
check('present, string -> unsupported', classifyEpochSchemaMarker(present('1')) === 'unsupported');
check('present, true -> unsupported (never coerce truthy values)', classifyEpochSchemaMarker(present(true)) === 'unsupported');

// ============================================================================
// decideRuntimeEpochOnEstablish — the CLOSED runtime boundary. R1-R13, exactly as
// required. Critically: no test here expects a legacy-initialization outcome, because
// that outcome no longer exists in the runtime API at all.
// ============================================================================
console.log('\n=== decideRuntimeEpochOnEstablish — closed runtime boundary (R1-R13) ===');

check('R1: marker absent + version absent -> fail-closed, missing-epoch-schema', (() => {
  const r = decideRuntimeEpochOnEstablish(ABSENT, ABSENT, false);
  return r.outcome === 'fail-closed' && r.reason === 'missing-epoch-schema';
})());
check('R2: marker null + version absent -> fail-closed, null-epoch-schema', (() => {
  const r = decideRuntimeEpochOnEstablish(NULLV, ABSENT, false);
  return r.outcome === 'fail-closed' && r.reason === 'null-epoch-schema';
})());
check('R3: marker absent + version null -> fail-closed, missing-epoch-schema (marker checked first)', (() => {
  const r = decideRuntimeEpochOnEstablish(ABSENT, NULLV, false);
  return r.outcome === 'fail-closed' && r.reason === 'missing-epoch-schema';
})());
check('R4: marker null + version null -> fail-closed, null-epoch-schema', (() => {
  const r = decideRuntimeEpochOnEstablish(NULLV, NULLV, false);
  return r.outcome === 'fail-closed' && r.reason === 'null-epoch-schema';
})());
check('R5: marker=1 + version absent -> fail-closed, missing-token-version', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), ABSENT, false);
  return r.outcome === 'fail-closed' && r.reason === 'missing-token-version';
})());
check('R6: marker=1 + version null -> fail-closed, null-token-version', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), NULLV, false);
  return r.outcome === 'fail-closed' && r.reason === 'null-token-version';
})());
check('R7: marker=1 + malformed version -> fail-closed, malformed-token-version', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), present(-1), false);
  return r.outcome === 'fail-closed' && r.reason === 'malformed-token-version';
})());
check('R8: marker absent + valid version -> fail-closed, missing-epoch-schema (never treated as legacy-ish)', (() => {
  const r = decideRuntimeEpochOnEstablish(ABSENT, present(3), false);
  return r.outcome === 'fail-closed' && r.reason === 'missing-epoch-schema';
})());
check('R9: marker unsupported + valid version -> fail-closed, unsupported-epoch-schema', (() => {
  const r = decideRuntimeEpochOnEstablish(present(2), present(3), true);
  return r.outcome === 'fail-closed' && r.reason === 'unsupported-epoch-schema';
})());
check('R10: marker=1 + valid version + same token -> preserve', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), present(5), false);
  return r.outcome === 'preserve' && r.tokenVersion === 5;
})());
check('R11: marker=1 + valid version + changed token -> increment', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), present(5), true);
  return r.outcome === 'increment' && r.tokenVersion === 6;
})());
check('R12: MAX_SAFE_INTEGER + same token -> preserve', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), present(Number.MAX_SAFE_INTEGER), false);
  return r.outcome === 'preserve' && r.tokenVersion === Number.MAX_SAFE_INTEGER;
})());
check('R13: MAX_SAFE_INTEGER + changed token -> fail-closed, token-version-exhausted', (() => {
  const r = decideRuntimeEpochOnEstablish(present(1), present(Number.MAX_SAFE_INTEGER), true);
  return r.outcome === 'fail-closed' && r.reason === 'token-version-exhausted';
})());

// Exhaustive invariant: NO input combination to decideRuntimeEpochOnEstablish ever
// produces anything other than preserve/increment/fail-closed — there is no
// "initialize"/"legacy" outcome reachable, by construction (verified at the type level
// already; this is a runtime double-check across a representative input sweep).
console.log('\n=== invariant: runtime establish decision has no legacy/initialize outcome ===');
{
  const presences: FieldPresence[] = [ABSENT, NULLV, present(1), present(2), present(0), present(5), present(Number.MAX_SAFE_INTEGER), present('x')];
  let sawUnexpectedOutcome = false;
  for (const marker of presences) {
    for (const tv of presences) {
      for (const changed of [true, false]) {
        const r = decideRuntimeEpochOnEstablish(marker, tv, changed);
        if (r.outcome !== 'preserve' && r.outcome !== 'increment' && r.outcome !== 'fail-closed') {
          sawUnexpectedOutcome = true;
        }
      }
    }
  }
  check('exhaustive sweep: every outcome is preserve, increment, or fail-closed', !sawUnexpectedOutcome);
}

// ============================================================================
// decideRuntimeEpochOnRevoke — the tolerant escape hatch, now touching epoch fields
// ONLY when the record is already in the exact migrated shape. Never stamps the marker.
// ============================================================================
console.log('\n=== decideRuntimeEpochOnRevoke ===');
check('marker current + valid version -> increment', (() => {
  const r = decideRuntimeEpochOnRevoke(present(1), present(4));
  return r.tokenVersion === 5;
})());
check('marker absent (true legacy or otherwise) -> touches nothing, never stamps the marker anymore', (() => {
  const r = decideRuntimeEpochOnRevoke(ABSENT, present(4));
  return r.tokenVersion === undefined;
})());
check('marker null -> touches nothing', decideRuntimeEpochOnRevoke(NULLV, present(4)).tokenVersion === undefined);
check('marker unsupported -> touches nothing, even with a plausible version', decideRuntimeEpochOnRevoke(present(2), present(4)).tokenVersion === undefined);
check('marker current + version absent -> touches nothing (never invents a version)', decideRuntimeEpochOnRevoke(present(1), ABSENT).tokenVersion === undefined);
check('marker current + version null -> touches nothing', decideRuntimeEpochOnRevoke(present(1), NULLV).tokenVersion === undefined);
check('marker current + version malformed -> touches nothing', decideRuntimeEpochOnRevoke(present(1), present('x')).tokenVersion === undefined);
check('marker current + MAX_SAFE_INTEGER -> touches nothing (no overflow attempt)', decideRuntimeEpochOnRevoke(present(1), present(Number.MAX_SAFE_INTEGER)).tokenVersion === undefined);
check('decideRuntimeEpochOnRevoke never returns an epochSchemaVersion key at all (type-level: RuntimeEpochRevokeDecision has no such field)', (() => {
  const r = decideRuntimeEpochOnRevoke(ABSENT, present(4)) as Record<string, unknown>;
  return !('epochSchemaVersion' in r);
})());

// ============================================================================
// installationAudienceId — unchanged (Codex did not request a redesign here).
// ============================================================================
console.log('\n=== isValidAudienceId / classifyAudienceIdField / generateAudienceId ===');
check('a generated id is itself valid', isValidAudienceId(generateAudienceId()));
check('empty string is invalid', !isValidAudienceId(''));
check('non-string is malformed', classifyAudienceIdField(12345) === 'malformed');
check('missing is missing', classifyAudienceIdField(undefined) === 'missing');
{
  const a = generateAudienceId();
  const b = generateAudienceId();
  check('two generated ids are distinct', a !== b);
}
check('valid existing -> preserve', (() => {
  const r = decideAudienceIdForSameOwnerTransaction('AbCdEf012345_-QRSTUVWXyz');
  return r.outcome === 'preserve';
})());
check('missing/malformed -> generate', decideAudienceIdForSameOwnerTransaction(undefined).outcome === 'generate');

// ============================================================================
// MIGRATION-ONLY LOGIC — classifyLegacyEpochForMigration. M1-M12 exactly as required,
// plus additional lifecycle-state coverage.
// ============================================================================
console.log('\n=== classifyLegacyEpochForMigration (M1-M12) ===');

check('M1: physically absent marker + physically absent version -> legacy-candidate', classifyLegacyEpochForMigration(ABSENT, ABSENT).verdict === 'legacy-candidate');
check('M2: explicit null marker -> corrupt', classifyLegacyEpochForMigration(NULLV, ABSENT).verdict === 'corrupt');
check('M3: explicit null version (marker absent) -> corrupt', classifyLegacyEpochForMigration(ABSENT, NULLV).verdict === 'corrupt');
check('M3b: explicit null version (marker current) -> corrupt', classifyLegacyEpochForMigration(present(1), NULLV).verdict === 'corrupt');
check('M4: marker absent + valid version -> corrupt (partial migration)', (() => {
  const r = classifyLegacyEpochForMigration(ABSENT, present(3));
  return r.verdict === 'corrupt' && r.reason === 'partial-migration-marker-absent-version-present';
})());
check('M5: marker=1 + missing version -> corrupt', classifyLegacyEpochForMigration(present(1), ABSENT).verdict === 'corrupt');
check('M6: marker=1 + valid version -> already-migrated', classifyLegacyEpochForMigration(present(1), present(7)).verdict === 'already-migrated');
check('M7: unsupported marker -> corrupt/unsupported', (() => {
  const r = classifyLegacyEpochForMigration(present(2), ABSENT);
  return r.verdict === 'corrupt' && r.reason === 'unsupported-epoch-schema';
})());
check('M7b: unsupported marker even with a valid-looking version -> still corrupt', classifyLegacyEpochForMigration(present(2), present(3)).verdict === 'corrupt');
check('marker absent + malformed version -> corrupt', classifyLegacyEpochForMigration(ABSENT, present('garbage')).verdict === 'corrupt');
check('M12: already-migrated classification is stable across repeated calls (idempotent by construction — pure function)', (() => {
  const r1 = classifyLegacyEpochForMigration(present(1), present(7));
  const r2 = classifyLegacyEpochForMigration(present(1), present(7));
  return r1.verdict === 'already-migrated' && r2.verdict === 'already-migrated';
})());

// ============================================================================
// proveLegacyActiveCandidateForMigration — M8-M11, plus additional lifecycle states.
// ============================================================================
console.log('\n=== proveLegacyActiveCandidateForMigration (M8-M11) ===');
const baseCandidate = { state: 'active', uid: 'uid-1', token: 'token-1', installationId: 'inst-1' };

check('M8: same-token active legacy + matching claim -> proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, claim: { exists: true, installationId: 'inst-1', uid: 'uid-1' } });
  return r.proven === true;
})());
check('M9: claim missing entirely -> not proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, claim: { exists: false } });
  return r.proven === false && r.reason === 'claim-missing';
})());
check('M9b: claim object itself absent (null) -> not proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, claim: null });
  return r.proven === false && r.reason === 'claim-missing';
})());
check('M10: claim exists but wrong installationId -> not proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, claim: { exists: true, installationId: 'inst-OTHER', uid: 'uid-1' } });
  return r.proven === false && r.reason === 'claim-installation-mismatch';
})());
check('M11: claim exists, correct installationId, wrong uid -> not proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, claim: { exists: true, installationId: 'inst-1', uid: 'uid-OTHER' } });
  return r.proven === false && r.reason === 'claim-uid-mismatch';
})());
check('activation-pending state is also a token-bearing candidate shape', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, state: 'activation-pending', claim: { exists: true, installationId: 'inst-1', uid: 'uid-1' } });
  return r.proven === true;
})());
check('transfer-pending state is also a token-bearing candidate shape (prepare never touches token)', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, state: 'transfer-pending', claim: { exists: true, installationId: 'inst-1', uid: 'uid-1' } });
  return r.proven === true;
})());
check('revoked state is NOT a token-bearing candidate shape (must use the tombstone proof instead)', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, state: 'revoked', claim: { exists: true, installationId: 'inst-1', uid: 'uid-1' } });
  return r.proven === false && r.reason === 'state-not-token-bearing';
})());
check('unrecognized/garbage state -> not proven, state-not-token-bearing', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, state: 'garbage', claim: { exists: true, installationId: 'inst-1', uid: 'uid-1' } });
  return r.proven === false && r.reason === 'state-not-token-bearing';
})());
check('missing/empty uid -> not proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, uid: '', claim: { exists: true, installationId: 'inst-1', uid: '' } });
  return r.proven === false && r.reason === 'uid-invalid';
})());
check('missing/empty token -> not proven', (() => {
  const r = proveLegacyActiveCandidateForMigration({ ...baseCandidate, token: '', claim: { exists: true, installationId: 'inst-1', uid: 'uid-1' } });
  return r.proven === false && r.reason === 'token-missing';
})());

// ============================================================================
// proveLegacyRevokedTombstoneForMigration.
// ============================================================================
console.log('\n=== proveLegacyRevokedTombstoneForMigration ===');
check('exact expected revoked shape -> proven', proveLegacyRevokedTombstoneForMigration({ state: 'revoked', token: null, uid: null }) === true);
check('revoked but token not null (ambiguous, never produced by the reviewed revoke transaction) -> NOT proven', proveLegacyRevokedTombstoneForMigration({ state: 'revoked', token: 'leftover', uid: null }) === false);
check('revoked but uid not null -> NOT proven', proveLegacyRevokedTombstoneForMigration({ state: 'revoked', token: null, uid: 'uid-1' }) === false);
check('state not revoked at all -> NOT proven', proveLegacyRevokedTombstoneForMigration({ state: 'active', token: null, uid: null }) === false);

// ============================================================================
// buildLegacyMigrationWritePlan.
// ============================================================================
console.log('\n=== buildLegacyMigrationWritePlan ===');
check('always epochSchemaVersion 1, tokenVersion 1 for any legacy candidate', (() => {
  const plan = buildLegacyMigrationWritePlan(undefined);
  return plan.epochSchemaVersion === 1 && plan.tokenVersion === 1;
})());
check('preserves an already-valid existing audience id rather than replacing it', (() => {
  const plan = buildLegacyMigrationWritePlan('AbCdEf012345_-QRSTUVWXyz');
  return plan.installationAudienceId === 'AbCdEf012345_-QRSTUVWXyz';
})());
check('generates a fresh audience id when missing', isValidAudienceId(buildLegacyMigrationWritePlan(undefined).installationAudienceId));
check('generates a fresh audience id when malformed', isValidAudienceId(buildLegacyMigrationWritePlan('not-valid!!!').installationAudienceId));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
