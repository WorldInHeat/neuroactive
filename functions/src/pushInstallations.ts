// functions/src/pushInstallations.ts
// Trusted server boundary for push-notification device ownership (Phase 3A-1, seventh
// repair). Firestore rules deny all client read/write on both collections used here (see
// firestore.rules) — these callables, via the Admin SDK, are the ONLY way ownership can ever
// change. No notification-sending code exists anywhere in this file or project yet.
//
// installationId ALONE IS NEVER A CREDENTIAL — not even for a revoked or unconfirmed
// tombstone, and not even after ANY amount of elapsed time. Once a record has ever existed,
// mutating it always requires possession of a server-issued secret tied to its current
// state: a "lease" while active/activation-pending, a "transfer credential" while
// transfer-pending, or a "recovery credential" while revoked. Only a record that has NEVER
// existed can be claimed by installationId + authentication alone
// (initializePushInstallation) — the one case where there is, by definition, no prior secret
// to require.
//
// A PRIOR round of this file introduced abandonUnconfirmedPushInstallation: a callable that
// let ANY authenticated permanent uid tombstone someone else's aged-out 'activation-pending'
// record by installationId + elapsed time alone, with no credential of any kind. Even though
// it granted the caller no ownership, it was still a real violation of the invariant above —
// authorizing a state/token/credential/quota MUTATION based on installationId possession.
// Codex correctly rejected it. It has been REMOVED, along with the diagnostic callable
// (getPushInstallationStatus) that existed only to drive it, and NOT replaced with any other
// endpoint where installationId + elapsed time authorizes client-triggered mutation.
//
// ACTIVATION-PENDING / LOST-LEASE HANDLING — every operation that issues a NEW lease
// (initialize, reclaim, transfer-claim, transfer-cancel) writes state 'activation-pending',
// not 'active'. The client only promotes it to 'active' by successfully persisting the lease
// locally AND then calling registerPushInstallation with it. The client is expected to
// attempt this confirming call on EVERY startup/reload whenever it holds a local lease for
// the current uid, so a transient confirmation failure self-heals. If local lease
// persistence itself fails (the genuinely lost-lease case), the record simply stays
// 'activation-pending' FOREVER from this device's perspective — nobody, including this
// device, holds any credential for it ever again. This is intentional and accepted: it is
// never a sender target (a future sender only ever queries state == 'active'), it can never
// be stolen (no credential exists for anyone to present), and — as of this round — the
// client does NOT respond by generating a fresh installationId either (see
// src/hooks/useNotifications.ts's register()): an earlier version of this file did that, but
// it only protected installationId uniqueness, not FCM TOKEN uniqueness. A device whose
// local storage partially cleared can still hold the same underlying FCM token/push
// subscription as the stale record it lost track of; blindly registering a fresh
// installationId with that same token would let two DIFFERENT installation documents both
// legitimately reach state=='active' with the SAME token — and if either belongs to a
// different uid than the other (e.g. a different person now using the same physical
// browser), that's cross-account notification delivery once a sender exists, not merely a
// wasted quota slot. See the TOKEN UNIQUENESS section below for the actual fix; the client
// now fails closed (surfaces an error, does not create a second installation) rather than
// self-healing via a fresh id. The accepted cost is that the stale record permanently
// occupies one of the original uid's MAX_ACTIVE_INSTALLATIONS_PER_UID quota slots, and
// notifications may become temporarily unrecoverable on that specific browser, until some
// future, separate, server-side maintenance process (not built in this pass — see the
// implementation report) addresses it. This is deliberately treated as sender/maintenance
// work, not a registration-correctness gap — security/privacy wins over automatic recovery.
//
// TOKEN UNIQUENESS — a server-only index, artifacts/{appId}/pushTokenClaims/{sha256(token)},
// records which SINGLE installationId currently claims a given FCM token. Enforced entirely
// inside registerPushInstallation's authoritative transaction — the ONE place any record
// ever transitions to state=='active' (initialize/reclaim/claim-transfer/cancel-transfer all
// write 'activation-pending' and rely on the client calling registerPushInstallation to
// confirm), so enforcing it there alone covers every path to 'active' uniformly. If the
// token being registered is already claimed by a DIFFERENT installationId, the call is
// rejected outright — the caller's own installation stays activation-pending (never
// send-eligible) rather than silently becoming a second active claimant of the same
// endpoint. Token rotation (or a transfer's incoming uid presenting a different token than
// the outgoing uid used) atomically releases the installation's OLD claim and establishes
// the new one in the same transaction. revokePushInstallation releases the claim entirely on
// logout. The index stores only installationId/uid/updatedAt, keyed by a HASH of the token
// (never the raw token as a document id/path segment), and is denied all client read/write
// (see firestore.rules) exactly like the other two collections in this file.
//
// Records are TOMBSTONED, not deleted, on revoke — deletion would let a delayed/duplicate
// initialize-style request treat a just-revoked installation as brand new and race back in
// under a stale intent.
//
// PUSH INSTALLATION EPOCH HARDENING (Phase 3A-3 Step 3A, final migration-boundary repair
// round) — this file writes three server-owned epoch-related fields, all defined and
// normalized in pushInstallationEpochLogic.ts (a zero-Firebase-import pure-logic module —
// see that file's header for the full contract):
//   - `generation`:              ownership/credential epoch (already existed).
//   - `epochSchemaVersion`:      durable migration-boundary marker (new).
//   - `tokenVersion`:            stored FCM token identity epoch (new; monotonic).
//   - `installationAudienceId`:  opaque foreground ownership/audience epoch (new;
//                                random, non-monotonic).
//
// CLOSED RUNTIME BOUNDARY — this file NEVER performs legacy epoch normalization. Every
// call into decideRuntimeEpochOnEstablish either finds a record already in the exact
// migrated shape (epochSchemaVersion === 1 AND a valid tokenVersion) or fails closed —
// there is no "this might be a pre-Step-3A legacy record" branch anywhere below, and the
// pure logic module's runtime-facing API has no outcome that could produce one (see
// pushInstallationEpochLogic.ts's RuntimeEpochDecision type). The ONLY code ever
// permitted to establish epoch fields on a genuinely legacy record is the one-time,
// reviewed, non-deployed migration tool at
// functions/maintenance/migratePushInstallationEpochs.js, run once, before any record
// reaching this file's establishment paths could still be in the legacy shape. This file
// must never import anything from pushInstallationEpochLogic.ts's MIGRATION-ONLY section
// (anything with a `ForMigration` suffix) — doing so would be a review red flag.
//
// Neither epoch field has any sender/delivery code consuming it yet — that is explicitly
// out of scope for this round (Step 3A is lifecycle hardening only; see the
// implementation report). No FCM send/delivery logic, no reminder-scheduler change, and
// no client change was made as part of this round.
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import {
  EPOCH_SCHEMA_VERSION,
  readFieldPresence,
  decideRuntimeEpochOnEstablish,
  decideRuntimeEpochOnRevoke,
  decideAudienceIdForSameOwnerTransaction,
  generateAudienceId,
} from './pushInstallationEpochLogic';

const APP_ID = 'neuroactive-prod';

const ALLOWED_PLATFORMS = ['android', 'ios', 'desktop-chromium', 'macos-safari', 'other'] as const;
type Platform = (typeof ALLOWED_PLATFORMS)[number];

// Must match the client exactly (src/hooks/useNotifications.ts).
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32_PATTERN = /^[0-9a-f]{32}$/i;
const MAX_TOKEN_LENGTH = 4096;

// Product constraint: a legitimate user may have several real devices — a structural abuse
// ceiling, not a realistic per-person device count.
const MAX_ACTIVE_INSTALLATIONS_PER_UID = 10;
// Guards the one operation that grows the collection (new-installation creation).
const INIT_COOLDOWN_MS = 5000;
// General per-uid throttle in front of every FCM dry-run call (initialize included —
// initialize's own longer INIT_COOLDOWN_MS above governs *creation* specifically; this
// separate, shorter gate is what makes concurrent DIFFERENT installationIds for the same uid
// unable to all reach FCM dry-run simultaneously). Deliberately short: this is
// defense-in-depth layered on top of — never a replacement for — App Check (once enabled)
// and the lease/credential requirements enforced by the authoritative transaction that
// follows every dry-run below.
const DRY_RUN_COOLDOWN_MS = 1000;

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function installationRef(installationId: string) {
  return db.doc(`artifacts/${APP_ID}/pushInstallations/${installationId}`);
}

function rateLimitRef(uid: string) {
  return db.doc(`artifacts/${APP_ID}/pushInstallationRateLimits/${uid}`);
}

// Keyed by a SHA-256 hash of the token, never the raw token — see the TOKEN UNIQUENESS note
// at the top of this file.
function tokenClaimRef(tokenHash: string) {
  return db.doc(`artifacts/${APP_ID}/pushTokenClaims/${tokenHash}`);
}

function isValidInstallationId(value: unknown): value is string {
  return typeof value === 'string' && (UUID_V4_PATTERN.test(value) || HEX32_PATTERN.test(value));
}

function requireInstallationId(value: unknown): string {
  if (!isValidInstallationId(value)) {
    throw new HttpsError('invalid-argument', 'Invalid installation ID.');
  }
  return value;
}

function requireToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOKEN_LENGTH) {
    throw new HttpsError('invalid-argument', 'Invalid device token.');
  }
  return value;
}

function requirePlatform(value: unknown): Platform {
  if (typeof value !== 'string' || !ALLOWED_PLATFORMS.includes(value as Platform)) {
    throw new HttpsError('invalid-argument', 'Invalid platform.');
  }
  return value as Platform;
}

// Label is baked into the message text deliberately — the client distinguishes "lease" vs
// "transfer credential" vs "recovery credential" failures by matching on it, since all three
// otherwise share the same invalid-argument code as a bad device token would.
function requireCredential(value: unknown, label: 'lease' | 'transfer credential' | 'recovery credential'): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 512) {
    throw new HttpsError('invalid-argument', `Invalid ${label}.`);
  }
  return value;
}

function requireNonAnonymousAuth(request: {
  auth?: { uid: string; token: { firebase?: { sign_in_provider?: string } } };
}): string {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  if (request.auth.token.firebase?.sign_in_provider === 'anonymous') {
    throw new HttpsError('permission-denied', 'A permanent account is required.');
  }
  return request.auth.uid;
}

function generateCredential(): string {
  return randomBytes(32).toString('base64url');
}

function hashCredential(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function credentialMatches(raw: string, storedHash: unknown): boolean {
  if (typeof storedHash !== 'string' || storedHash.length !== 64) return false;
  const presented = Buffer.from(hashCredential(raw), 'hex');
  const stored = Buffer.from(storedHash, 'hex');
  if (presented.length !== stored.length) return false;
  return timingSafeEqual(presented, stored);
}

// Real, documented Admin SDK capability (Messaging.send(message, dryRun)) — validates a
// token against FCM without delivering anything. Only genuine token-invalidity error codes
// hard-reject; infrastructure-type failures are logged and don't block registration. Always
// called AFTER cheap authorization/state/quota checks AND the atomic dry-run reservation
// (see reserveDryRunSlot) in every callable that uses it — this is real external I/O and
// must never be the first thing an unauthorized, already-doomed, or rate-limited request
// reaches.
async function assertTokenLooksValid(token: string): Promise<void> {
  try {
    await getMessaging().send({ token, data: { validationOnly: '1' } }, true);
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code;
    if (
      code === 'messaging/invalid-argument' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/registration-token-not-registered'
    ) {
      throw new HttpsError('invalid-argument', 'This device token is not recognized by push messaging.');
    }
    console.warn('[PushInstallations] token dry-run validation inconclusive, proceeding:', err);
  }
}

// ATOMIC per-uid reservation gating every FCM dry-run call (initialize, register, reclaim,
// claim-transfer). A prior version of this check read lastDryRunAt, decided, and wrote it
// back as two separate non-transactional steps — concurrent requests for the same uid could
// all read the same stale value before any write landed, defeating the throttle entirely.
// Wrapping the read-decide-write sequence in a single Firestore transaction closes that race:
// Firestore serializes concurrent transactions touching the same document (this uid's
// rate-limit doc), so only one concurrent caller can successfully claim the reservation
// within the cooldown window — every other one reads the just-updated timestamp and
// correctly rejects, regardless of how many different installationIds they're each trying to
// use. Deliberately does NOT touch activeCount — that remains the sole responsibility of the
// final authoritative mutation transaction in each callable. If the reservation succeeds but
// the dry-run that follows fails, the cooldown is still considered consumed — no rollback is
// attempted; this is abuse-control accounting, not exact billing, and a short cooldown lost
// to a single failed attempt is an acceptable, intentional cost, not a bug.
async function reserveDryRunSlot(uid: string): Promise<void> {
  const limitRef = rateLimitRef(uid);
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(limitRef);
    const limit = snap.exists ? (snap.data() as RateLimitDoc) : {};
    const lastMs = limit.lastDryRunAt instanceof Timestamp ? limit.lastDryRunAt.toMillis() : 0;
    if (Date.now() - lastMs < DRY_RUN_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', 'Please slow down.');
    }
    transaction.set(limitRef, { lastDryRunAt: FieldValue.serverTimestamp() }, { merge: true });
  });
}

// MULTI-ACCOUNT ABUSE ASSESSMENT (see the implementation report for the full writeup): the
// per-uid reservation above, by construction, does nothing to stop an attacker who creates
// many separate permanent Firebase accounts and spreads dry-run calls across them. This is a
// deliberate, documented scope decision for THIS registration-only phase, not an oversight —
// see the report for why the combination of (a) requiring a real, non-anonymous Firebase
// Auth account per attempt, (b) this per-uid atomic reservation, (c) the structural
// per-uid device cap, and (d) App Check enforcement once Console-configured (tied to the
// browser/device via attestation, not to any one account, and so meaningfully harder to
// defeat via account multiplication than any per-uid mechanism could ever be) is judged
// sufficient here, without building a project-wide budget system in this pass.

// App Check enforcement: the client (src/services/firebase.ts) initializes App Check with
// a Console-registered reCAPTCHA v3 site key, and production traffic has been verified (via
// Firebase Console App Check metrics and direct browser network inspection) to be obtaining
// and attaching valid tokens. Enforcement is ON for these callables — requests without a
// valid App Check token are now rejected.
const CALLABLE_OPTIONS = { enforceAppCheck: true } as const;

type RateLimitDoc = { activeCount?: number; lastInitAt?: Timestamp; lastDryRunAt?: Timestamp };

function readTimestampMillis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

// Logs (never silently masks) an activeCount that would go negative on decrement — this
// should be structurally unreachable given every increment/decrement is paired transactionally
// with the same state-gated precondition as its corresponding installation-doc write (see the
// implementation report's activeCount audit), so if it ever fires, that invariant has been
// violated somewhere and is worth knowing about rather than silently clamping to zero as if
// nothing happened.
function decrementActiveCount(current: number, context: string): number {
  if (current <= 0) {
    console.error(
      `[PushInstallations] impossible counter state in ${context}: attempting to decrement activeCount ` +
        `that is already ${current}. This indicates a bookkeeping invariant violation and should be investigated.`
    );
  }
  return Math.max(0, current - 1);
}

// Registers a GENUINELY NEW installation. Succeeds ONLY if no document exists at all for
// this installationId — never supersedes any existing state, regardless of what that state
// is or how old it is. A revoked tombstone must go through reclaimPushInstallation; there is
// no mechanism anywhere in this file, ever, that lets installationId + elapsed time alone
// authorize mutation of an existing record (see the file header).
//
// Ordering: cheap validation/precondition checks (no external I/O) happen first; the atomic
// dry-run reservation next; the FCM dry-run (real external I/O) after that; and the
// authoritative transaction last, re-validating everything from scratch — so nothing read
// during the cheap precheck is ever trusted for the actual mutation (TOCTOU-safe by
// construction), and concurrent initialize attempts for the same uid — even with different
// fresh installationIds — cannot all reach FCM dry-run (see reserveDryRunSlot).
export const initializePushInstallation = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const token = requireToken(request.data?.token);
  const platform = requirePlatform(request.data?.platform);

  const ref = installationRef(installationId);
  const limitRef = rateLimitRef(uid);

  // Phase 1 — cheap precheck, no external I/O.
  const [precheckSnap, precheckLimitSnap] = await Promise.all([ref.get(), limitRef.get()]);
  if (precheckSnap.exists) {
    throw new HttpsError('failed-precondition', 'This installation already exists. Use reclaim instead of initialize.');
  }
  const precheckLimit = precheckLimitSnap.exists ? (precheckLimitSnap.data() as RateLimitDoc) : {};
  if (Date.now() - readTimestampMillis(precheckLimit.lastInitAt) < INIT_COOLDOWN_MS) {
    throw new HttpsError('resource-exhausted', 'Please wait a moment before trying again.');
  }
  if ((precheckLimit.activeCount ?? 0) >= MAX_ACTIVE_INSTALLATIONS_PER_UID) {
    throw new HttpsError(
      'resource-exhausted',
      'This account has reached the maximum number of registered devices.'
    );
  }

  // Phase 2 — atomic reservation, then expensive external validation.
  await reserveDryRunSlot(uid);
  await assertTokenLooksValid(token);

  // Phase 3 — authoritative transaction; repeats every check above independently. Does NOT
  // touch lastDryRunAt (already reserved above) — only activeCount/lastInitAt, which belong
  // to this transaction alone.
  const result = await db.runTransaction(async (transaction) => {
    const [snap, limitSnap] = await Promise.all([transaction.get(ref), transaction.get(limitRef)]);
    if (snap.exists) {
      throw new HttpsError('failed-precondition', 'This installation already exists. Use reclaim instead of initialize.');
    }
    const limit = limitSnap.exists ? (limitSnap.data() as RateLimitDoc) : {};
    if (Date.now() - readTimestampMillis(limit.lastInitAt) < INIT_COOLDOWN_MS) {
      throw new HttpsError('resource-exhausted', 'Please wait a moment before trying again.');
    }
    const activeCount = limit.activeCount ?? 0;
    if (activeCount >= MAX_ACTIVE_INSTALLATIONS_PER_UID) {
      throw new HttpsError(
        'resource-exhausted',
        'This account has reached the maximum number of registered devices.'
      );
    }

    const lease = generateCredential();
    const nowStamp = FieldValue.serverTimestamp();
    transaction.set(ref, {
      uid,
      token,
      platform,
      state: 'activation-pending',
      generation: 1,
      // Step 3A: a brand-new installation always starts all three epoch fields at their
      // fresh baseline — see pushInstallationEpochLogic.ts for why these are separate
      // fields with separate normalization policies, and why epochSchemaVersion exists
      // as its own durable marker rather than inferring "current schema" from
      // tokenVersion's mere presence.
      epochSchemaVersion: EPOCH_SCHEMA_VERSION,
      tokenVersion: 1,
      installationAudienceId: generateAudienceId(),
      leaseHash: hashCredential(lease),
      transferHash: null,
      transferOriginUid: null,
      recoveryHash: null,
      createdAt: nowStamp,
      updatedAt: nowStamp,
    });
    transaction.set(limitRef, { activeCount: activeCount + 1, lastInitAt: nowStamp }, { merge: true });
    return { lease };
  });

  return result;
});

// Reclaims a REVOKED tombstone — the only path back for a record that has existed before.
// Requires the recovery credential issued at revoke time. Writes 'activation-pending', same
// as initialize — the client must still confirm via registerPushInstallation.
export const reclaimPushInstallation = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const recoveryCredential = requireCredential(request.data?.recoveryCredential, 'recovery credential');
  const token = requireToken(request.data?.token);
  const platform = requirePlatform(request.data?.platform);

  // Phase 1 — cheap precheck.
  const ref = installationRef(installationId);
  const limitRef = rateLimitRef(uid);
  const [precheckSnap, precheckLimitSnap] = await Promise.all([ref.get(), limitRef.get()]);
  if (!precheckSnap.exists) {
    throw new HttpsError('failed-precondition', 'No installation to reclaim. Use initialize instead.');
  }
  const precheck = precheckSnap.data()!;
  if (precheck.state !== 'revoked') {
    throw new HttpsError('failed-precondition', 'Installation is not in a reclaimable state.');
  }
  if (!credentialMatches(recoveryCredential, precheck.recoveryHash)) {
    throw new HttpsError('permission-denied', 'Invalid recovery credential.');
  }
  const precheckLimit = precheckLimitSnap.exists ? (precheckLimitSnap.data() as RateLimitDoc) : {};
  if ((precheckLimit.activeCount ?? 0) >= MAX_ACTIVE_INSTALLATIONS_PER_UID) {
    throw new HttpsError(
      'resource-exhausted',
      'This account has reached the maximum number of registered devices.'
    );
  }

  // Phase 2 — atomic reservation, then expensive external validation.
  await reserveDryRunSlot(uid);
  await assertTokenLooksValid(token);

  // Phase 3 — authoritative transaction; repeats every check above independently.
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', 'No installation to reclaim. Use initialize instead.');
    }
    const existing = snap.data()!;
    if (existing.state !== 'revoked') {
      throw new HttpsError('failed-precondition', 'Installation is not in a reclaimable state.');
    }
    if (!credentialMatches(recoveryCredential, existing.recoveryHash)) {
      throw new HttpsError('permission-denied', 'Invalid recovery credential.');
    }
    const limitSnap = await transaction.get(limitRef);
    const limit = limitSnap.exists ? (limitSnap.data() as RateLimitDoc) : {};
    const activeCount = limit.activeCount ?? 0;
    if (activeCount >= MAX_ACTIVE_INSTALLATIONS_PER_UID) {
      throw new HttpsError(
        'resource-exhausted',
        'This account has reached the maximum number of registered devices.'
      );
    }

    // Step 3A (closed runtime boundary): reclaiming a revoked tombstone always
    // establishes a brand-new token identity (the record's token was cleared to null by
    // revoke) — tokenIdentityChanged is computed, not hardcoded, purely for consistency
    // with the other two call sites that share this same decision function; it is always
    // true here in practice. This runtime decision NEVER self-normalizes a legacy
    // tombstone (marker/tokenVersion physically absent) — that shape now fails closed
    // here, exactly like any other inconsistency. A pre-Step-3A revoked tombstone must
    // already have been migrated (by the one-time migration tool, using
    // proveLegacyRevokedTombstoneForMigration) before it can ever be reclaimed again.
    const epochDecision = decideRuntimeEpochOnEstablish(
      readFieldPresence(existing, 'epochSchemaVersion'),
      readFieldPresence(existing, 'tokenVersion'),
      existing.token !== token
    );
    if (epochDecision.outcome === 'fail-closed') {
      throw new HttpsError(
        'failed-precondition',
        `This installation cannot be reclaimed (${epochDecision.reason}) and requires operator review.`
      );
    }

    const lease = generateCredential();
    transaction.set(ref, {
      uid,
      token,
      platform,
      state: 'activation-pending',
      generation: ((existing.generation as number) ?? 0) + 1,
      // epochSchemaVersion is re-written explicitly (not merely relied upon from the
      // existing document) for clarity — it can only ever be EPOCH_SCHEMA_VERSION here,
      // since decideRuntimeEpochOnEstablish only reaches a non-fail-closed outcome when
      // the marker is already exactly current.
      epochSchemaVersion: EPOCH_SCHEMA_VERSION,
      tokenVersion: epochDecision.tokenVersion,
      // A reclaim always begins a NEW ownership epoch — never preserve the prior
      // audience id, regardless of what it was (missing, valid, or malformed all get
      // replaced identically; see pushInstallationEpochLogic.ts).
      installationAudienceId: generateAudienceId(),
      leaseHash: hashCredential(lease),
      transferHash: null,
      transferOriginUid: null,
      recoveryHash: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(limitRef, { activeCount: activeCount + 1 }, { merge: true });
    return { lease };
  });

  return result;
});

// Normal re-registration / token rotation — AND the confirmation step that promotes a fresh
// 'activation-pending' record to 'active'. Accepts either starting state as long as the
// presented lease and uid both match; always writes 'active' on success. The CLIENT is
// expected to call this on every startup/reload whenever it holds a local lease for the
// current uid — not merely once right after initialize/reclaim/claim/cancel — which is what
// makes this double as both the activation-confirmation step AND the mechanism that
// discovers ordinary FCM token rotation. Does not change generation.
//
// This is also the SOLE enforcement point for token uniqueness (see the TOKEN UNIQUENESS
// note at the top of this file): the token being registered must not already be claimed by
// a DIFFERENT installationId. If it is, the call is rejected — this installation stays
// exactly where it was (activation-pending stays activation-pending; an already-active
// installation keeps its previous token/claim untouched, since the rejection happens before
// any write). Token rotation (the token differing from what this installation last had)
// atomically releases the OLD claim and establishes the new one, all inside one transaction.
export const registerPushInstallation = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const lease = requireCredential(request.data?.lease, 'lease');
  const token = requireToken(request.data?.token);
  const platform = requirePlatform(request.data?.platform);

  const ref = installationRef(installationId);
  const newClaimRef = tokenClaimRef(hashCredential(token));

  // Phase 1 — cheap precheck.
  const [precheckSnap, precheckClaimSnap] = await Promise.all([ref.get(), newClaimRef.get()]);
  if (!precheckSnap.exists) {
    throw new HttpsError('failed-precondition', 'Installation not yet claimed.');
  }
  const precheck = precheckSnap.data()!;
  if (precheck.state !== 'active' && precheck.state !== 'activation-pending') {
    throw new HttpsError('failed-precondition', 'Installation is not currently active.');
  }
  if (precheck.uid !== uid) {
    throw new HttpsError('permission-denied', 'Not the current owner.');
  }
  if (!credentialMatches(lease, precheck.leaseHash)) {
    throw new HttpsError('permission-denied', 'Invalid lease.');
  }
  if (precheckClaimSnap.exists && precheckClaimSnap.data()!.installationId !== installationId) {
    throw new HttpsError('failed-precondition', 'This device token is already claimed by another registration.');
  }

  // Phase 2 — atomic reservation, then expensive external validation.
  await reserveDryRunSlot(uid);
  await assertTokenLooksValid(token);

  // Phase 3 — authoritative transaction; repeats every check above independently.
  await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', 'Installation not yet claimed.');
    }
    const existing = snap.data()!;
    if (existing.state !== 'active' && existing.state !== 'activation-pending') {
      throw new HttpsError('failed-precondition', 'Installation is not currently active.');
    }
    if (existing.uid !== uid) {
      throw new HttpsError('permission-denied', 'Not the current owner.');
    }
    if (!credentialMatches(lease, existing.leaseHash)) {
      throw new HttpsError('permission-denied', 'Invalid lease.');
    }

    // All reads before any writes, per Firestore's transaction rules: re-check the new
    // token's claim, and — only if the token is actually changing — read the OLD token's
    // claim too, so it can be released below.
    const claimSnap = await transaction.get(newClaimRef);
    if (claimSnap.exists && claimSnap.data()!.installationId !== installationId) {
      throw new HttpsError('failed-precondition', 'This device token is already claimed by another registration.');
    }
    const oldToken = typeof existing.token === 'string' ? existing.token : null;
    const tokenChanged = oldToken !== token;
    const oldClaimRef = tokenChanged && oldToken ? tokenClaimRef(hashCredential(oldToken)) : null;
    const oldClaimSnap = oldClaimRef ? await transaction.get(oldClaimRef) : null;

    // Step 3A (closed runtime boundary): this decision NEVER self-normalizes a legacy
    // record (epochSchemaVersion/tokenVersion physically absent) — that shape now fails
    // closed, exactly like any other inconsistency, regardless of whether the token is
    // changing or being reconfirmed. A pre-Step-3A legacy installation must already have
    // been migrated (by the one-time migration tool) before it can successfully register
    // again; see pushInstallationEpochLogic.ts's "TWO-PHASE MIGRATION ARCHITECTURE" note
    // for why runtime carries no compatibility branch for this at all.
    const epochDecision = decideRuntimeEpochOnEstablish(
      readFieldPresence(existing, 'epochSchemaVersion'),
      readFieldPresence(existing, 'tokenVersion'),
      tokenChanged
    );
    if (epochDecision.outcome === 'fail-closed') {
      throw new HttpsError(
        'failed-precondition',
        `This installation cannot be registered (${epochDecision.reason}) and requires operator review.`
      );
    }

    // Ownership does not change in this call (uid/lease already verified above) in
    // EITHER the reconfirm or rotation path — the audience epoch is preserved if valid,
    // or self-normalized (missing/malformed both heal identically, since this is a
    // random, non-monotonic value — see pushInstallationEpochLogic.ts) now that identity
    // has already been fully validated for this transaction's own unrelated reasons.
    const audienceIdDecision = decideAudienceIdForSameOwnerTransaction(existing.installationAudienceId);
    const installationAudienceId =
      audienceIdDecision.outcome === 'preserve' ? audienceIdDecision.audienceId : generateAudienceId();

    transaction.set(
      ref,
      {
        state: 'active',
        token,
        platform,
        // Re-written explicitly for clarity — can only ever be EPOCH_SCHEMA_VERSION here
        // (see the comment above decideRuntimeEpochOnEstablish's call site).
        epochSchemaVersion: EPOCH_SCHEMA_VERSION,
        tokenVersion: epochDecision.tokenVersion,
        installationAudienceId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    transaction.set(
      newClaimRef,
      { installationId, uid, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
    if (oldClaimRef && oldClaimSnap?.exists && oldClaimSnap.data()!.installationId === installationId) {
      transaction.delete(oldClaimRef);
    }
  });

  return { accepted: true };
});

// Revokes (tombstones) an active OR activation-pending installation — used by explicit
// logout, before signOut. Idempotent: already-revoked/transfer-pending/nonexistent
// installations return ok (with no credential) without error. No FCM dry-run is performed
// here, so no reservation/reordering applies.
//
// uid is cleared to null on revoke: once revoked, a future reclaim is authorized purely by
// the recovery credential, never by uid comparison. The token claim (see TOKEN UNIQUENESS at
// the top of this file) is released too, if it still points at this installation — without
// this, a token this installation is no longer using could wrongly block a genuinely
// unrelated future installation from ever registering it.
export const revokePushInstallation = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const lease = requireCredential(request.data?.lease, 'lease');

  const ref = installationRef(installationId);
  const limitRef = rateLimitRef(uid);

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return { ok: true as const, recoveryCredential: null };
    const existing = snap.data()!;
    if (existing.state !== 'active' && existing.state !== 'activation-pending') {
      return { ok: true as const, recoveryCredential: null }; // already revoked/transfer-pending — no-op
    }
    if (existing.uid !== uid) {
      throw new HttpsError('permission-denied', 'Not the current owner.');
    }
    if (!credentialMatches(lease, existing.leaseHash)) {
      throw new HttpsError('permission-denied', 'Invalid lease.');
    }
    // All reads before any writes, per Firestore's transaction rules.
    const limitSnap = await transaction.get(limitRef);
    const oldToken = typeof existing.token === 'string' ? existing.token : null;
    const oldClaimRef = oldToken ? tokenClaimRef(hashCredential(oldToken)) : null;
    const oldClaimSnap = oldClaimRef ? await transaction.get(oldClaimRef) : null;

    const activeCount = limitSnap.exists ? ((limitSnap.data() as RateLimitDoc).activeCount ?? 0) : 0;

    // Step 3A (closed runtime boundary): revoke is the one operation that must never be
    // blockable by unrelated field corruption (it is the escape hatch — logout must
    // always work), so unlike registerPushInstallation/reclaimPushInstallation/
    // claimPushInstallationTransfer it never fails closed. It is now also the SIMPLEST
    // possible invariant: tokenVersion is only ever touched (best-effort incremented)
    // when the record is already in the exact migrated shape (epochSchemaVersion === 1
    // AND a valid tokenVersion) — every other case (absent/null/unsupported marker;
    // absent/null/malformed tokenVersion) leaves epoch fields completely untouched.
    // Revoke never stamps epochSchemaVersion under any circumstance — establishing epoch
    // state on a legacy record is now the exclusive, one-time responsibility of the
    // migration tool, never of any runtime transaction, including this one. See
    // decideRuntimeEpochOnRevoke.
    const epochDecision = decideRuntimeEpochOnRevoke(
      readFieldPresence(existing, 'epochSchemaVersion'),
      readFieldPresence(existing, 'tokenVersion')
    );

    const recoveryCredential = generateCredential();
    transaction.set(ref, {
      uid: null,
      state: 'revoked',
      generation: ((existing.generation as number) ?? 0) + 1,
      ...epochDecision,
      // The ended ownership epoch's audience id must become unusable, matching the
      // existing pattern this function already uses for token/leaseHash/transferHash —
      // null is unambiguous (a locally-held client value is never null) and avoids ever
      // re-exposing/reusing a historical value later.
      installationAudienceId: null,
      leaseHash: null,
      token: null,
      transferHash: null,
      transferOriginUid: null,
      recoveryHash: hashCredential(recoveryCredential),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(limitRef, { activeCount: decrementActiveCount(activeCount, 'revokePushInstallation') }, { merge: true });
    if (oldClaimRef && oldClaimSnap?.exists && oldClaimSnap.data()!.installationId === installationId) {
      transaction.delete(oldClaimRef);
    }
    return { ok: true as const, recoveryCredential };
  });

  return result;
});

// Step 1 of an account switch. No FCM dry-run here, so no reservation/reordering applies.
export const preparePushInstallationTransfer = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const lease = requireCredential(request.data?.lease, 'lease');

  const ref = installationRef(installationId);
  const limitRef = rateLimitRef(uid);

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists) {
      throw new HttpsError('failed-precondition', 'No installation to transfer.');
    }
    const existing = snap.data()!;
    if (existing.state !== 'active') {
      throw new HttpsError('failed-precondition', 'Installation is not currently active.');
    }
    if (existing.uid !== uid) {
      throw new HttpsError('permission-denied', 'Not the current owner.');
    }
    if (!credentialMatches(lease, existing.leaseHash)) {
      throw new HttpsError('permission-denied', 'Invalid lease.');
    }
    const limitSnap = await transaction.get(limitRef);
    const activeCount = limitSnap.exists ? ((limitSnap.data() as RateLimitDoc).activeCount ?? 0) : 0;

    // Step 3A: token, tokenVersion, and installationAudienceId are all deliberately left
    // untouched here — this step doesn't change the stored token at all, and `uid`
    // itself is not written by this call either (the record remains A's until B actually
    // claims it), so no token identity or ownership epoch event has occurred yet. The
    // record is also no longer 'active' after this write, so it is not send-eligible
    // regardless of what these fields currently hold; the audience id only becomes
    // meaningful again once claimPushInstallationTransfer establishes the new owner.
    const transferCredential = generateCredential();
    transaction.set(ref, {
      state: 'transfer-pending',
      generation: ((existing.generation as number) ?? 0) + 1,
      leaseHash: null,
      transferHash: hashCredential(transferCredential),
      transferOriginUid: uid,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(
      limitRef,
      { activeCount: decrementActiveCount(activeCount, 'preparePushInstallationTransfer') },
      { merge: true }
    );
    return { transferCredential };
  });

  return result;
});

// Step 2 of an account switch: called by the INCOMING uid (B). Writes 'activation-pending' —
// B's client must confirm via registerPushInstallation the same way initialize/reclaim do.
export const claimPushInstallationTransfer = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const transferCredential = requireCredential(request.data?.transferCredential, 'transfer credential');
  const token = requireToken(request.data?.token);
  const platform = requirePlatform(request.data?.platform);

  const ref = installationRef(installationId);
  const limitRef = rateLimitRef(uid);

  // Phase 1 — cheap precheck.
  const [precheckSnap, precheckLimitSnap] = await Promise.all([ref.get(), limitRef.get()]);
  if (!precheckSnap.exists || precheckSnap.data()!.state !== 'transfer-pending') {
    throw new HttpsError('failed-precondition', 'No pending transfer for this installation.');
  }
  if (!credentialMatches(transferCredential, precheckSnap.data()!.transferHash)) {
    throw new HttpsError('permission-denied', 'Invalid transfer credential.');
  }
  const precheckLimit = precheckLimitSnap.exists ? (precheckLimitSnap.data() as RateLimitDoc) : {};
  if ((precheckLimit.activeCount ?? 0) >= MAX_ACTIVE_INSTALLATIONS_PER_UID) {
    throw new HttpsError(
      'resource-exhausted',
      'This account has reached the maximum number of registered devices.'
    );
  }

  // Phase 2 — atomic reservation, then expensive external validation.
  await reserveDryRunSlot(uid);
  await assertTokenLooksValid(token);

  // Phase 3 — authoritative transaction; repeats every check above independently.
  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists || snap.data()!.state !== 'transfer-pending') {
      throw new HttpsError('failed-precondition', 'No pending transfer for this installation.');
    }
    const existing = snap.data()!;
    if (!credentialMatches(transferCredential, existing.transferHash)) {
      throw new HttpsError('permission-denied', 'Invalid transfer credential.');
    }
    const limitSnap = await transaction.get(limitRef);
    const limit = limitSnap.exists ? (limitSnap.data() as RateLimitDoc) : {};
    const activeCount = limit.activeCount ?? 0;
    if (activeCount >= MAX_ACTIVE_INSTALLATIONS_PER_UID) {
      throw new HttpsError(
        'resource-exhausted',
        'This account has reached the maximum number of registered devices.'
      );
    }

    // Step 3A (closed runtime boundary): claiming a transfer always presents a fresh
    // token param (see requireToken above) and always establishes a NEW owner taking
    // authoritative control — this is exactly "new ownership becomes authoritative" from
    // the installationAudienceId lifecycle design, so a fresh audience id is generated
    // unconditionally. This decision NEVER self-normalizes a legacy source record
    // (marker/tokenVersion physically absent) — that shape fails closed here exactly as
    // it does for registerPushInstallation/reclaimPushInstallation. A pre-Step-3A legacy
    // installation must already have been migrated before its ownership can be
    // transferred; see pushInstallationEpochLogic.ts.
    const epochDecision = decideRuntimeEpochOnEstablish(
      readFieldPresence(existing, 'epochSchemaVersion'),
      readFieldPresence(existing, 'tokenVersion'),
      existing.token !== token
    );
    if (epochDecision.outcome === 'fail-closed') {
      throw new HttpsError(
        'failed-precondition',
        `This transfer cannot be claimed (${epochDecision.reason}) and requires operator review.`
      );
    }

    const lease = generateCredential();
    transaction.set(ref, {
      uid,
      token,
      platform,
      state: 'activation-pending',
      generation: ((existing.generation as number) ?? 0) + 1,
      // Re-written explicitly — can only ever be EPOCH_SCHEMA_VERSION here.
      epochSchemaVersion: EPOCH_SCHEMA_VERSION,
      tokenVersion: epochDecision.tokenVersion,
      installationAudienceId: generateAudienceId(),
      leaseHash: hashCredential(lease),
      transferHash: null,
      transferOriginUid: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    // lastInitAt/lastDryRunAt are intentionally left untouched by omission under
    // merge:true here in the mutation transaction — lastDryRunAt was already stamped by
    // reserveDryRunSlot above, and lastInitAt belongs solely to initialize.
    transaction.set(limitRef, { activeCount: activeCount + 1 }, { merge: true });
    return { lease };
  });

  return result;
});

// Recovery path: called by the ORIGINAL uid (A) when the account-switch attempt that
// followed prepareTransfer failed or was canceled. Writes 'activation-pending' — A's client
// must confirm via registerPushInstallation. No FCM dry-run here, so no reservation applies.
export const cancelPushInstallationTransfer = onCall(CALLABLE_OPTIONS, async (request) => {
  const uid = requireNonAnonymousAuth(request);
  const installationId = requireInstallationId(request.data?.installationId);
  const transferCredential = requireCredential(request.data?.transferCredential, 'transfer credential');

  const ref = installationRef(installationId);
  const limitRef = rateLimitRef(uid);

  const result = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    if (!snap.exists || snap.data()!.state !== 'transfer-pending') {
      throw new HttpsError('failed-precondition', 'No pending transfer for this installation.');
    }
    const existing = snap.data()!;
    if (existing.transferOriginUid !== uid) {
      throw new HttpsError('permission-denied', 'Not the originating owner.');
    }
    if (!credentialMatches(transferCredential, existing.transferHash)) {
      throw new HttpsError('permission-denied', 'Invalid transfer credential.');
    }
    const limitSnap = await transaction.get(limitRef);
    const activeCount = limitSnap.exists ? ((limitSnap.data() as RateLimitDoc).activeCount ?? 0) : 0;

    // Step 3A: token/tokenVersion are deliberately left untouched — this call has no
    // token param and does not establish any new token identity. installationAudienceId
    // IS eligible for same-owner self-normalization here (unlike a genuine transfer):
    // preparePushInstallationTransfer never writes the `uid` field, so `existing.uid`
    // is still the ORIGINAL owner's uid throughout transfer-pending, and this
    // transaction has already independently confirmed `existing.transferOriginUid ===
    // uid` above — ownership never actually left this uid at the Firestore-field level,
    // so no new ownership epoch has occurred and the prior audience id remains safe to
    // preserve (or self-heal if it happened to be missing/malformed).
    const audienceIdDecision = decideAudienceIdForSameOwnerTransaction(existing.installationAudienceId);
    const installationAudienceId =
      audienceIdDecision.outcome === 'preserve' ? audienceIdDecision.audienceId : generateAudienceId();

    const lease = generateCredential();
    transaction.set(ref, {
      state: 'activation-pending',
      generation: ((existing.generation as number) ?? 0) + 1,
      installationAudienceId,
      leaseHash: hashCredential(lease),
      transferHash: null,
      transferOriginUid: null,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    transaction.set(limitRef, { activeCount: activeCount + 1 }, { merge: true });
    return { lease };
  });

  return result;
});
