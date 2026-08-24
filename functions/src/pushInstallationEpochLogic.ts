// functions/src/pushInstallationEpochLogic.ts
// Phase 3A-3 Step 3A (final migration-boundary repair round) — Push Installation Epoch
// Hardening. PURE LOGIC ONLY. Deliberately has zero imports from 'firebase-admin/*' or
// 'firebase-functions/*' — every exported function here is a plain, synchronous,
// dependency-free function of its inputs, so it can be exercised by a real
// repository-local test file (see pushInstallationEpochLogic.test.ts) without needing a
// Firestore emulator or any Firebase credentials, AND so it can be `require()`d directly
// (post-build, from functions/lib/) by the one-time, non-deployed migration script at
// functions/maintenance/migratePushInstallationEpochs.js. (`node:crypto`'s randomBytes is
// a Node builtin, not a Firebase SDK — using it here does not break this file's
// zero-Firebase-dependency contract.)
//
// THREE DISTINCT FIELDS, three distinct purposes — do not collapse them:
//   - `generation`   (already existed, Phase 3A-1): the installation's OWNERSHIP/
//     CREDENTIAL epoch. Incremented by every one of the six trusted transactions that
//     issues a new lease/transfer/recovery credential. Unrelated to token identity.
//   - `tokenVersion`  (new): the STORED FCM TOKEN's identity epoch. A
//     monotonically-increasing counter, advanced exactly once per committed change to
//     the stored `token` field, regardless of whether ownership (`generation`) also
//     changed in the same transaction. Exists so a future sender (Step 3) can detect
//     ANY token-identity change since it last observed one — including ordinary
//     same-owner rotation, which `generation` deliberately does not track.
//   - `installationAudienceId` (new): an OPAQUE, RANDOM, non-monotonic foreground-
//     ownership/audience discriminator. Exists so a future client can compare a
//     locally-held value against what a delivered push carries, and refuse to show a
//     foreground banner for a message that belongs to a PREVIOUS ownership epoch on the
//     same physical device (e.g. after an A->B account switch on a shared browser).
//
// ===========================================================================
// TWO-PHASE MIGRATION ARCHITECTURE (this round's repair — read before editing).
// ===========================================================================
// PHASE A — ONE-TIME MIGRATION (functions/maintenance/migratePushInstallationEpochs.js,
// never deployed, never imported by runtime): the ONLY code, ever, permitted to
// recognize a genuinely pre-Step-3A legacy record (epochSchemaVersion and tokenVersion
// BOTH physically absent) and establish fresh epoch fields for it, under strict,
// re-provable-at-write-time conditions. See the "MIGRATION-ONLY LOGIC" section below.
//
// PHASE B — ORDINARY RUNTIME LIFECYCLE (pushInstallations.ts, deployed): CLOSED. There is
// no runtime code path, anywhere, that treats a missing/null epoch field as legacy or
// self-normalizes it. The runtime establishment rule is exactly:
//   epochSchemaVersion === 1 AND a valid tokenVersion  -> usable migrated state
//   anything else (absent, explicit null, unsupported marker, missing/null/malformed
//   tokenVersion, or any partial combination)          -> fail closed
// This is deliberately impossible to route around: decideRuntimeEpochOnEstablish has NO
// "initialize-legacy" outcome at all — that outcome does not exist in this file's runtime
// API surface, so no runtime caller can accidentally reach it. Migration-only logic lives
// under separate, unmistakably-named exports (the `ForMigration` suffix) specifically so
// it cannot be casually imported into a runtime decision by mistake.
//
// Why this two-phase split exists at all: a runtime-permanent legacy-normalization branch
// (the prior round's design) was rejected by Codex because it can never be proven closed
// — if BOTH epochSchemaVersion and tokenVersion were ever deleted out-of-band after a
// record had already been migrated, the record would once again match the "genuinely
// legacy" shape, and permanent runtime code would silently re-normalize it, recycling an
// epoch value a future sender may already have observed. A ONE-TIME, reviewed,
// non-deployed migration followed by PERMANENT REMOVAL of runtime normalization closes
// this gap completely: after migration, runtime never again asks "could this be legacy,"
// it only ever asks "is this the exact migrated shape."
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------------------
// FIELD PRESENCE — explicit absent / null / present, everywhere. Firestore distinguishes
// a field that was NEVER WRITTEN (physically absent from the document) from a field that
// was explicitly written with the JS value `null` — `snap.data()` omits the key entirely
// for the former and includes it with value `null` for the latter. Callers must extract
// this via own-property inspection (see readFieldPresence), never via `data.field ===
// undefined` alone, so that "physically absent" and "explicitly null" can never be
// silently conflated at any call site, in either runtime or migration code.
// ---------------------------------------------------------------------------------------

export type FieldPresence = { kind: 'absent' } | { kind: 'null' } | { kind: 'present'; value: unknown };

export function readFieldPresence(source: Record<string, unknown> | null | undefined, key: string): FieldPresence {
  if (!source || !Object.prototype.hasOwnProperty.call(source, key)) return { kind: 'absent' };
  const value = source[key];
  if (value === null) return { kind: 'null' };
  return { kind: 'present', value };
}

// ---------------------------------------------------------------------------------------
// tokenVersion — validation.
// ---------------------------------------------------------------------------------------

// Valid: a finite, non-fractional, safe, integer >= 1. Never 0, negative, fractional,
// unsafe, NaN, or Infinity. Never reset or decremented once established.
export function isValidTokenVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

export type TokenVersionFieldState = 'absent' | 'null' | 'valid' | 'malformed';

export function classifyTokenVersionField(presence: FieldPresence): TokenVersionFieldState {
  if (presence.kind === 'absent') return 'absent';
  if (presence.kind === 'null') return 'null';
  return isValidTokenVersion(presence.value) ? 'valid' : 'malformed';
}

// ---------------------------------------------------------------------------------------
// epochSchemaVersion — the durable migration-boundary marker. Only the exact
// currently-understood value is ever trusted. A present-but-different value (e.g. a
// future schema version this build predates) is treated identically to corruption for
// establishment purposes — never guessed, never assumed forward- or
// backward-compatible.
// ---------------------------------------------------------------------------------------

export const EPOCH_SCHEMA_VERSION = 1 as const;

export type EpochSchemaMarkerState = 'absent' | 'null' | 'current' | 'unsupported';

export function classifyEpochSchemaMarker(presence: FieldPresence): EpochSchemaMarkerState {
  if (presence.kind === 'absent') return 'absent';
  if (presence.kind === 'null') return 'null';
  return presence.value === EPOCH_SCHEMA_VERSION ? 'current' : 'unsupported';
}

// =========================================================================================
// RUNTIME (PHASE B) — CLOSED BOUNDARY. No legacy branch exists anywhere below this line
// until the "MIGRATION-ONLY LOGIC" section, which is never imported by pushInstallations.ts.
// =========================================================================================

export type RuntimeEpochFailReason =
  | 'missing-epoch-schema'
  | 'null-epoch-schema'
  | 'unsupported-epoch-schema'
  | 'missing-token-version'
  | 'null-token-version'
  | 'malformed-token-version'
  | 'token-version-exhausted';

export type RuntimeEpochDecision =
  | { outcome: 'preserve'; tokenVersion: number }
  | { outcome: 'increment'; tokenVersion: number }
  | { outcome: 'fail-closed'; reason: RuntimeEpochFailReason };

// Shared by registerPushInstallation (both the same-token-confirm and token-rotation
// paths), reclaimPushInstallation, and claimPushInstallationTransfer — the three
// transactions whose OUTPUT a future sender will trust for real-send targeting.
// `tokenIdentityChanged` must be computed by the caller as `existingToken !== newToken`.
// There is intentionally no "legacy" parameter and no legacy outcome: runtime never asks
// whether a record MIGHT be legacy, only whether it is EXACTLY the migrated shape.
export function decideRuntimeEpochOnEstablish(
  epochSchemaVersionPresence: FieldPresence,
  tokenVersionPresence: FieldPresence,
  tokenIdentityChanged: boolean
): RuntimeEpochDecision {
  const markerState = classifyEpochSchemaMarker(epochSchemaVersionPresence);
  if (markerState === 'absent') return { outcome: 'fail-closed', reason: 'missing-epoch-schema' };
  if (markerState === 'null') return { outcome: 'fail-closed', reason: 'null-epoch-schema' };
  if (markerState === 'unsupported') return { outcome: 'fail-closed', reason: 'unsupported-epoch-schema' };

  // markerState === 'current'.
  const tokenVersionState = classifyTokenVersionField(tokenVersionPresence);
  if (tokenVersionState === 'absent') return { outcome: 'fail-closed', reason: 'missing-token-version' };
  if (tokenVersionState === 'null') return { outcome: 'fail-closed', reason: 'null-token-version' };
  if (tokenVersionState === 'malformed') return { outcome: 'fail-closed', reason: 'malformed-token-version' };

  const current = (tokenVersionPresence as { kind: 'present'; value: unknown }).value as number;
  if (!tokenIdentityChanged) {
    return { outcome: 'preserve', tokenVersion: current };
  }
  if (current === Number.MAX_SAFE_INTEGER) {
    return { outcome: 'fail-closed', reason: 'token-version-exhausted' };
  }
  return { outcome: 'increment', tokenVersion: current + 1 };
}

// The "escape hatch" decision, for revokePushInstallation ONLY. Revoke must never be
// blockable by unrelated field corruption (it is the one operation a legitimate owner
// must always be able to complete, e.g. to log out or free a device quota slot). Now
// that runtime legacy normalization is removed entirely, this is deliberately the
// SIMPLEST possible invariant: revoke touches tokenVersion ONLY when the record is
// already in the fully-migrated shape (marker current + tokenVersion valid); in every
// other case (absent, null, unsupported marker; absent, null, or malformed
// tokenVersion) it leaves epoch fields completely untouched — never invents, never
// stamps a marker, never pretends migration occurred. (An earlier round of this design
// had revoke opportunistically stamp the marker when tokenVersion was already valid but
// the marker was missing — that reasoning is now obsolete: with runtime migration
// removed everywhere else, revoke doing it too would just reintroduce a second, easy-to-
// miss place where epoch state gets established outside the one reviewed migration tool.
// Leaving epoch fields untouched on revoke is the cleaner, more defensible invariant.)
export type RuntimeEpochRevokeDecision = { tokenVersion?: number };

export function decideRuntimeEpochOnRevoke(
  epochSchemaVersionPresence: FieldPresence,
  tokenVersionPresence: FieldPresence
): RuntimeEpochRevokeDecision {
  const markerState = classifyEpochSchemaMarker(epochSchemaVersionPresence);
  if (markerState !== 'current') return {};
  const tokenVersionState = classifyTokenVersionField(tokenVersionPresence);
  if (tokenVersionState !== 'valid') return {};
  const current = (tokenVersionPresence as { kind: 'present'; value: unknown }).value as number;
  if (current === Number.MAX_SAFE_INTEGER) return {};
  return { tokenVersion: current + 1 };
}

// ---------------------------------------------------------------------------------------
// installationAudienceId — validation and generation. Opaque, random, 128-bit, base64url
// — the exact same reviewed pattern pushInstallations.ts already uses for lease/transfer/
// recovery credentials (`randomBytes(...).toString('base64url')`), sized smaller (16
// bytes vs. those functions' 32) because this value is a non-secret discriminator, not a
// bearer credential requiring resistance to online guessing. Unchanged this round —
// Codex did not request a redesign here.
// ---------------------------------------------------------------------------------------

const AUDIENCE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function isValidAudienceId(value: unknown): value is string {
  return typeof value === 'string' && AUDIENCE_ID_PATTERN.test(value);
}

export type AudienceIdFieldState = 'missing' | 'valid' | 'malformed';

export function classifyAudienceIdField(value: unknown): AudienceIdFieldState {
  if (value === undefined || value === null) return 'missing';
  return isValidAudienceId(value) ? 'valid' : 'malformed';
}

export function generateAudienceId(): string {
  return randomBytes(16).toString('base64url');
}

// The "same ownership epoch continues" decision. Used by registerPushInstallation (both
// same-token-confirm and rotation paths — ownership does not change in either) and
// cancelPushInstallationTransfer (ownership never actually left the original uid at the
// Firestore-field level during transfer-pending). Unlike tokenVersion, a malformed
// present value does NOT need to fail closed here: because this field is a random,
// non-monotonic discriminator rather than a counter, a fresh replacement value can never
// collide with or undercut a historical value the way an incorrectly-guessed counter
// could — so both "missing" and "malformed" self-heal identically, by generating a fresh
// value, inside any transaction that has already independently validated same-owner
// identity (uid, lease/credential, lifecycle state) for its own unrelated reasons. This
// is NOT legacy epoch normalization — installationAudienceId has no "migration boundary"
// concern the way tokenVersion does, since it is never used as a monotonic proof of
// anything; it is fine for ordinary runtime code to keep self-healing it.
export type AudienceIdSameOwnerDecision = { outcome: 'preserve'; audienceId: string } | { outcome: 'generate' };

export function decideAudienceIdForSameOwnerTransaction(currentAudienceId: unknown): AudienceIdSameOwnerDecision {
  const state = classifyAudienceIdField(currentAudienceId);
  if (state === 'valid') return { outcome: 'preserve', audienceId: currentAudienceId as string };
  return { outcome: 'generate' };
}

// New-ownership-epoch transactions (initializePushInstallation, reclaimPushInstallation,
// claimPushInstallationTransfer) always generate a fresh audience id unconditionally,
// regardless of what the current value was — there is no "preserve" branch for them, by
// design: "once an ownership epoch has ended, its audience id is never reused." Since
// this is a one-line call (`generateAudienceId()`), no separate decision function is
// defined for it — the orchestration layer calls generateAudienceId() directly at each
// of those three call sites.

// =========================================================================================
// MIGRATION-ONLY LOGIC — used exclusively by the one-time, non-deployed maintenance
// script functions/maintenance/migratePushInstallationEpochs.js. NEVER imported by
// pushInstallations.ts or any other runtime lifecycle code. Every export in this section
// carries a `ForMigration` suffix specifically so it cannot be mistaken for, or
// accidentally substituted into, a runtime decision path — grep for `ForMigration` finding
// a hit inside pushInstallations.ts would itself be a review red flag.
// =========================================================================================

export type LegacyEpochMigrationVerdict =
  | { verdict: 'already-migrated' }
  | { verdict: 'legacy-candidate' }
  | { verdict: 'corrupt'; reason: string };

// The base shape classification — decides ONLY from the epoch fields themselves whether a
// record is already-migrated, a genuine legacy candidate (both fields physically absent),
// or corrupt/ambiguous (any other combination, including a present-but-invalid marker, an
// explicit null on either field, or a "partial migration" shape where exactly one field
// is present). This intentionally mirrors decideRuntimeEpochOnEstablish's classification
// order but returns a DIFFERENT verdict set — migration additionally needs to know "is
// this worth attempting to migrate at all," which runtime never needs to ask.
export function classifyLegacyEpochForMigration(
  epochSchemaVersionPresence: FieldPresence,
  tokenVersionPresence: FieldPresence
): LegacyEpochMigrationVerdict {
  const markerState = classifyEpochSchemaMarker(epochSchemaVersionPresence);
  const tokenVersionState = classifyTokenVersionField(tokenVersionPresence);

  if (markerState === 'unsupported') return { verdict: 'corrupt', reason: 'unsupported-epoch-schema' };
  if (markerState === 'null') return { verdict: 'corrupt', reason: 'null-epoch-schema' };

  if (markerState === 'current') {
    if (tokenVersionState === 'valid') return { verdict: 'already-migrated' };
    if (tokenVersionState === 'absent') return { verdict: 'corrupt', reason: 'missing-token-version-on-migrated-record' };
    if (tokenVersionState === 'null') return { verdict: 'corrupt', reason: 'null-token-version-on-migrated-record' };
    return { verdict: 'corrupt', reason: 'malformed-token-version-on-migrated-record' };
  }

  // markerState === 'absent' — the only branch that can ever yield 'legacy-candidate'.
  if (tokenVersionState === 'absent') return { verdict: 'legacy-candidate' };
  if (tokenVersionState === 'null') return { verdict: 'corrupt', reason: 'null-token-version-marker-absent' };
  if (tokenVersionState === 'valid') return { verdict: 'corrupt', reason: 'partial-migration-marker-absent-version-present' };
  return { verdict: 'corrupt', reason: 'malformed-token-version-marker-absent' };
}

// State-specific proof for a token-bearing legacy candidate (state 'active',
// 'activation-pending', or 'transfer-pending' — all three genuinely carry a live token
// and, in the current schema, a corresponding pushTokenClaims entry; 'transfer-pending'
// specifically because preparePushInstallationTransfer never touches `token`, so the
// original owner's token/claim relationship established before the transfer began is
// still exactly what it was). Proves the record's identity is internally consistent
// enough to safely assign a fresh baseline epoch, WITHOUT ever reading or storing the raw
// token itself here — only its presence and the claim record's own fields.
export type LegacyActiveProofFailReason =
  | 'state-not-token-bearing'
  | 'uid-invalid'
  | 'token-missing'
  | 'claim-missing'
  | 'claim-installation-mismatch'
  | 'claim-uid-mismatch';

export type LegacyActiveProofResult = { proven: true } | { proven: false; reason: LegacyActiveProofFailReason };

const TOKEN_BEARING_STATES = new Set(['active', 'activation-pending', 'transfer-pending']);

export function proveLegacyActiveCandidateForMigration(input: {
  state: unknown;
  uid: unknown;
  token: unknown;
  installationId: string;
  claim: { exists: boolean; installationId?: unknown; uid?: unknown } | null | undefined;
}): LegacyActiveProofResult {
  if (typeof input.state !== 'string' || !TOKEN_BEARING_STATES.has(input.state)) {
    return { proven: false, reason: 'state-not-token-bearing' };
  }
  if (typeof input.uid !== 'string' || input.uid.length === 0) {
    return { proven: false, reason: 'uid-invalid' };
  }
  if (typeof input.token !== 'string' || input.token.length === 0) {
    return { proven: false, reason: 'token-missing' };
  }
  if (!input.claim || !input.claim.exists) {
    return { proven: false, reason: 'claim-missing' };
  }
  if (input.claim.installationId !== input.installationId) {
    return { proven: false, reason: 'claim-installation-mismatch' };
  }
  if (input.claim.uid !== input.uid) {
    return { proven: false, reason: 'claim-uid-mismatch' };
  }
  return { proven: true };
}

// State-specific proof for a legacy REVOKED tombstone. A revoked record has no live
// token to verify against a claim (revoke always clears token to null) — its
// unambiguous, provable shape is exactly `state === 'revoked' && token === null && uid
// === null`, which only the reviewed, stable revokePushInstallation transaction has ever
// produced. This is deliberately narrow: it does NOT attempt to migrate any tombstone
// whose fields deviate from that exact expected shape (see the implementation report for
// why an ambiguous tombstone is reported as corrupt/manual-review instead of guessed at).
export function proveLegacyRevokedTombstoneForMigration(input: { state: unknown; token: unknown; uid: unknown }): boolean {
  return input.state === 'revoked' && input.token === null && input.uid === null;
}

// The migration write plan for a proven legacy candidate — always tokenVersion: 1 (there
// is no prior valid value to increment from; that is the definition of a legacy record),
// always epochSchemaVersion: 1, and installationAudienceId either preserved (if the
// record already happens to carry a valid one) or freshly generated. Never touches
// generation, token, uid, state, lease/transfer/recovery credentials, activeCount, or any
// unrelated timestamp — the caller (migration script) must only ever merge exactly these
// three fields onto the document.
export type LegacyMigrationWritePlan = {
  epochSchemaVersion: 1;
  tokenVersion: 1;
  installationAudienceId: string;
};

export function buildLegacyMigrationWritePlan(currentAudienceIdValue: unknown): LegacyMigrationWritePlan {
  const audienceDecision = decideAudienceIdForSameOwnerTransaction(currentAudienceIdValue);
  return {
    epochSchemaVersion: EPOCH_SCHEMA_VERSION,
    tokenVersion: 1,
    installationAudienceId: audienceDecision.outcome === 'preserve' ? audienceDecision.audienceId : generateAudienceId(),
  };
}

// ---------------------------------------------------------------------------------------
// REAL-DELIVERY READINESS INVARIANT (documented now; enforced by Step 3, not this round).
// Before any future Step 3 real-delivery fan-out may target an installation, it MUST
// require, from a fresh read, all of:
//   - epochSchemaVersion === EPOCH_SCHEMA_VERSION (classifyEpochSchemaMarker === 'current')
//   - a valid tokenVersion (isValidTokenVersion)
//   - a valid installationAudienceId (isValidAudienceId)
//   - state === 'active'
//   - the expected uid
//   - a matching pushTokenClaims entry for the current token (installationId + uid both
//     matching)
// Real-delivery/fan-out code must NEVER perform legacy normalization and must NEVER
// import anything from this file's MIGRATION-ONLY section — it treats any
// missing/null/unsupported epoch state as simply untargetable (excluded from the send
// set), exactly as a malformed one would be. Normalization is the exclusive
// responsibility of the one-time migration tool, run once, before real-delivery code is
// ever enabled — never of runtime lifecycle code, and never of sender/fan-out code, at
// any point.
// ---------------------------------------------------------------------------------------
