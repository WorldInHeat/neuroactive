// functions/src/reminderDeliveryAuth.ts
// Phase 3A-3 Step 3C-3 — OAuth preparation and final delivery authorization. This is the
// central security boundary of the entire reminder-delivery pipeline: the ONLY code, ever,
// permitted to transition a delivery out of 'preparing' toward a durable outcome.
//
// ***** STRUCTURALLY INCAPABLE OF SENDING *****
// This file contains no reference to fcmTransport.ts, sendFcmOnce, getMessaging,
// 'firebase-admin/messaging', 'node:https', or fetch. It never constructs an FCM HTTP
// request and never POSTs a notification. The OAuth access token acquired here is used for
// NOTHING beyond proving that acquisition itself succeeded — its actual string value is
// read into a local variable for validation only and is discarded the instant that
// validation completes; it is never returned, logged, persisted, or threaded into any
// Firestore write. The deepest reachable outcome in this file is
// `state: 'dry-run-validated'`. There is no code path — behind a flag or otherwise — that
// writes `state: 'sending'`.
//
// SOURCE-LEVEL REAL-SEND LOCK (Codex-required, section 30) — REAL_DELIVERY_ENABLED below is
// a compile-time-visible `false` constant, independent of and never overridden by the
// Firestore-stored rollout config. Even if that config document is accidentally or
// maliciously set to 'allowlisted-real-send' or 'general-real-send',
// decideFinalAuthorizationRolloutDisposition ALWAYS treats both modes identically to a
// disallowed mode in this phase, and finalizeDeliveryAuthorization additionally asserts the
// constant directly before touching Firestore at all — two independent layers, not one.
// This constant may change only in a future, separately-reviewed Step 3C-4 round that also
// implements the actual send path.
//
// ROLLOUT CONFIG — server-owned, fixed path, Admin-SDK-only (see firestore.rules):
//   artifacts/{appId}/systemConfig/notificationRollout
// Parsed via reminderDeliveryLogic.ts's already-approved, pure `parseRolloutConfig`, which
// fails closed to 'paused' for any missing/malformed document — this file adds no separate
// "malformed rollout" case because that shape is indistinguishable, by design, from 'paused'.
//
// TOKEN SECRECY — the OAuth access token and the installation's raw FCM token are each read
// into a local variable, used only for validation/hashing, and never escape this file: never
// assigned to a field on any Firestore write, never passed to `logger`/`console`, never
// included in a thrown error, and never returned from any exported function.
import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import {
  isValidReminderId,
  isValidInstallationIdShape,
  validateFanoutTuple,
  requireAllowedDeliveryTransition,
  buildDeliveryTerminalWorkStateFields,
  buildDeliveryQuarantineUpdate,
  parseRolloutConfig,
  classifyDeliveryWorkTuple,
  validatePersistedDeliveryForProcessing,
} from './reminderDeliveryLogic';
import { validateReminderSchema, validateSchedule, revalidateConsent, isValidAttemptCount } from './reminderSchedulerLogic';
import { classifyEpochSchemaMarker, readFieldPresence, isValidTokenVersion, isValidAudienceId } from './pushInstallationEpochLogic';

const APP_ID = 'neuroactive-prod';

// See file header — this is a structural phase lock, not a rollout-config-driven decision.
export const REAL_DELIVERY_ENABLED = false as const;

// ---------------------------------------------------------------------------------------
// Path helpers — duplicated locally per this codebase's established per-file convention
// (see reminderDeliveryWorker.ts's own identical set) rather than shared across files.
// ---------------------------------------------------------------------------------------

function reminderRef(db: FirebaseFirestore.Firestore, reminderId: string) {
  return db.doc(`artifacts/${APP_ID}/reminders/${reminderId}`);
}
function preferencesRef(db: FirebaseFirestore.Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/notificationPreferences/main`);
}
function installationRef(db: FirebaseFirestore.Firestore, installationId: string) {
  return db.doc(`artifacts/${APP_ID}/pushInstallations/${installationId}`);
}
function tokenClaimRef(db: FirebaseFirestore.Firestore, tokenHash: string) {
  return db.doc(`artifacts/${APP_ID}/pushTokenClaims/${tokenHash}`);
}
// Fixed, server-owned, single-document rollout configuration. Client read/write denied
// entirely (see firestore.rules) — Admin SDK only, exactly like every other collection this
// codebase treats as server-authoritative.
function rolloutConfigRef(db: FirebaseFirestore.Firestore) {
  return db.doc(`artifacts/${APP_ID}/systemConfig/notificationRollout`);
}

// ---------------------------------------------------------------------------------------
// OAUTH PREPARATION — occurs BEFORE the final-authorization transaction, per the approved
// design. Uses the already-declared `google-auth-library` direct dependency and ambient
// Cloud Functions service-account credentials (Application Default Credentials) — no
// service-account key file is ever introduced, and no caller may supply or override the
// target project.
// ---------------------------------------------------------------------------------------

// The exact scope Firebase Cloud Messaging's HTTP v1 API requires for send calls. This file
// never calls that API — the scope is requested here only because Step 3C-4's sender will
// need a token acquired under it, and this phase's whole purpose is to prove preparation
// succeeds without granting itself permission to do anything with the result.
const FCM_OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

export type AccessTokenProvider = () => Promise<string>;

// Real production provider. A fresh `GoogleAuth` instance is created per call to this
// factory (intended to be called ONCE per scheduled-invocation batch, not once per
// delivery) — `google-auth-library` itself caches the resolved client/token internally for
// the lifetime of that instance, so a single factory call amortizes across every delivery
// processed in one batch. No key file, no caller-supplied project: `GoogleAuth` resolves
// Application Default Credentials from the Cloud Functions runtime environment.
export function createGoogleAuthAccessTokenProvider(): AccessTokenProvider {
  const auth = new GoogleAuth({ scopes: [FCM_OAUTH_SCOPE] });
  return async () => {
    const token = await auth.getAccessToken();
    // CODEX REPAIR ROUND (L2): a whitespace-only string must not be treated as a real
    // token — `.trim().length` rather than `.length` alone.
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('empty-or-missing-access-token');
    }
    return token;
  };
}

export type OAuthPreparationOutcome = { outcome: 'succeeded' } | { outcome: 'failed'; reason: 'oauth-preparation-failed' };

// Deliberately the ONLY fixed failure category (see the approved design's "use fixed/
// internal failure categories only" requirement) — this file cannot safely distinguish a
// transient network blip from a permanent credential misconfiguration without reading
// exception details that could carry credential-adjacent text, so it does not try. Every
// OAuth failure is treated identically: NO Firestore write occurs here at all (see
// prepareAndFinalizeDelivery below) — the delivery simply remains 'preparing' with its
// existing lease, and is naturally retried only once that lease expires (the same
// lease-expiry recovery mechanism acquireDeliveryProcessingLease already implements),
// which is what prevents a tight retry loop without inventing a new backoff mechanism.
export async function acquireOAuthAccessToken(provider: AccessTokenProvider): Promise<OAuthPreparationOutcome> {
  try {
    const token = await provider();
    // CODEX REPAIR ROUND (L2): whitespace-only strings (e.g. a single space, a tab) must
    // classify as failure exactly like an empty string — `.trim().length` rather than
    // `.length` alone. The raw (untrimmed) value is still what would have been used had
    // this check passed, but it never is used at all: this function discards `token`
    // either way, succeeding or failing.
    if (typeof token !== 'string' || token.trim().length === 0) {
      return { outcome: 'failed', reason: 'oauth-preparation-failed' };
    }
    return { outcome: 'succeeded' };
    // `token` is discarded here — this function never returns it, logs it, or stores it.
  } catch {
    // Deliberately binds no parameter: matches fcmTransport.ts's established convention of
    // never reading a property off a caught exception, since an OAuth client's thrown error
    // could carry credential-adjacent detail in its own message/properties.
    return { outcome: 'failed', reason: 'oauth-preparation-failed' };
  }
}

// ---------------------------------------------------------------------------------------
// ROLLOUT DISPOSITION — pure decision, reusing reminderDeliveryLogic.ts's approved
// parseRolloutConfig rather than re-parsing the raw document.
// ---------------------------------------------------------------------------------------

export type FinalAuthorizationReason =
  | 'preference-missing'
  | 'preference-disabled'
  | 'preference-changed'
  | 'rollout-paused'
  | 'rollout-mode-not-supported-in-this-phase'
  | 'parent-invalid'
  | 'parent-fanout-not-completed'
  // CODEX REPAIR ROUND (H1) — the delivery child's fanoutExecutionIdAtCreation does not
  // equal the parent's own fanoutExecutionId. Modeled as 'cancelled' (authorization
  // invalidation), not 'invalid-delivery' (schema corruption): both fields are
  // individually well-formed — this is a claim about MEMBERSHIP in a specific successful
  // fanout that cannot be proven, not a malformed document.
  | 'fanout-provenance-mismatch'
  | 'installation-missing'
  | 'installation-revoked'
  | 'installation-uid-mismatch'
  | 'installation-generation-changed'
  | 'installation-token-version-changed'
  | 'installation-audience-changed'
  | 'installation-epoch-invalid'
  | 'installation-token-missing'
  | 'token-claim-missing'
  | 'token-claim-mismatch';

export type RolloutDisposition =
  | { decision: 'proceed-dry-run' }
  | { decision: 'cancel'; reason: 'rollout-paused' | 'rollout-mode-not-supported-in-this-phase' };

// `dry-run` is the ONLY mode this phase may proceed under. 'paused' cancels (never
// requeues — see the approved design's non-spinning-paused-disposition requirement).
// 'allowlisted-real-send'/'general-real-send' are UNCONDITIONALLY treated as
// not-supported-in-this-phase, regardless of allowlist membership — REAL_DELIVERY_ENABLED
// being false means there is no "authorized" branch for either mode to fall into.
export function decideFinalAuthorizationRolloutDisposition(rawRolloutConfig: unknown): RolloutDisposition {
  const parsed = parseRolloutConfig(rawRolloutConfig);
  if (parsed.mode === 'paused') return { decision: 'cancel', reason: 'rollout-paused' };
  if (parsed.mode === 'dry-run') return { decision: 'proceed-dry-run' };
  return { decision: 'cancel', reason: 'rollout-mode-not-supported-in-this-phase' };
}

function mapPreferenceCancellationReason(
  reason: 'disabled-after-claim' | 'schedule-changed-after-claim' | 'timezone-changed-after-claim' | 'preference-missing-after-claim'
): 'preference-missing' | 'preference-disabled' | 'preference-changed' {
  if (reason === 'preference-missing-after-claim') return 'preference-missing';
  if (reason === 'disabled-after-claim') return 'preference-disabled';
  return 'preference-changed'; // schedule-changed-after-claim | timezone-changed-after-claim
}

// ---------------------------------------------------------------------------------------
// FINAL AUTHORIZATION TRANSACTION — the central security boundary.
// ---------------------------------------------------------------------------------------

export type FinalAuthorizationResult =
  | { outcome: 'dry-run-validated' }
  | { outcome: 'cancelled'; reason: FinalAuthorizationReason }
  // CODEX REPAIR ROUND (H2/section 19) — the persisted delivery document itself is
  // schema-corrupt (malformed public ID, poisoned attempt history, malformed target
  // snapshot/provenance-ID FORMAT, identity mismatch, etc.) as proven by the shared
  // validatePersistedDeliveryForProcessing. Distinct from 'cancelled': this worker
  // legitimately owns the fence (processingAttemptCount matched), so it IS authorized to
  // quarantine corrupt data it owns — matching the exact disposition
  // acquireDeliveryProcessingLease already uses for the identical validator failing at
  // acquisition time.
  | { outcome: 'invalid-delivery'; reason: string }
  // A stale worker's fence/tuple check failed — another worker may already own (or be
  // about to reclaim) this delivery. Deliberately a DISTINCT top-level outcome, never
  // folded into 'cancelled' or 'invalid-delivery': writing anything here would itself be
  // an unauthorized mutation by a worker that cannot prove exclusive ownership,
  // potentially stomping a legitimately newer worker's in-flight work. No Firestore write
  // of any kind occurs on this path.
  | { outcome: 'stale-fence'; reason: 'stale-processing-fence' }
  | { outcome: 'delivery-not-found' };

// `expectedProcessingAttemptCount` is the fence the caller obtained from its own
// `acquireDeliveryProcessingLease` acquisition — mirrors reminderDeliveryWorker.ts's
// existing fanout fence pattern exactly. Accepts `unknown` and is validated (via
// reminderSchedulerLogic.ts's own isValidAttemptCount — same domain, reused rather than
// reinvented) before any Firestore access.
export async function finalizeDeliveryAuthorization(
  db: FirebaseFirestore.Firestore,
  deliveryRef: FirebaseFirestore.DocumentReference,
  expectedProcessingAttemptCount: unknown
): Promise<FinalAuthorizationResult> {
  // Structural lock (see file header) — asserted unconditionally, before any Firestore
  // access, independent of whatever decideFinalAuthorizationRolloutDisposition below would
  // otherwise decide. A future accidental flip of this constant without also implementing
  // Step 3C-4's actual send path fails loudly here rather than silently authorizing sends.
  if (REAL_DELIVERY_ENABLED) {
    throw new Error('reminderDeliveryAuth: REAL_DELIVERY_ENABLED must remain false until Step 3C-4 ships with a reviewed sender integration.');
  }

  if (!isValidAttemptCount(expectedProcessingAttemptCount)) {
    return { outcome: 'stale-fence', reason: 'stale-processing-fence' };
  }
  const reminderId = deliveryRef.parent.parent?.id;
  if (!isValidReminderId(reminderId)) {
    return { outcome: 'delivery-not-found' };
  }
  const installationId = deliveryRef.id;
  if (!isValidInstallationIdShape(installationId)) {
    return { outcome: 'delivery-not-found' };
  }

  return db.runTransaction(async (transaction): Promise<FinalAuthorizationResult> => {
    // ================= READ PHASE — every read below completes before any write. =================
    // Delivery is read FIRST and alone: a stale/missing/corrupt delivery must short-circuit
    // before four more reads are ever issued (Codex repair round, section 18).
    const deliverySnap = await transaction.get(deliveryRef);
    if (!deliverySnap.exists) return { outcome: 'delivery-not-found' };
    const deliveryData = deliverySnap.data()!;
    if (deliveryData.state !== 'preparing' || deliveryData.processingAttemptCount !== expectedProcessingAttemptCount) {
      // Example: worker A acquires with fence N; A's lease expires; worker B reacquires
      // with fence N+1; A finally reaches this transaction with its now-stale fence N. B's
      // processingAttemptCount (N+1) no longer matches A's expectation — A loses, no write.
      // Also covers "DO NOT DESTROY SENDING PROVENANCE" (section 20): a delivery reread as
      // 'sending' or any terminal state can never equal 'preparing', so it always lands
      // here — no write, no rewrite of a state 3C-3 must never touch.
      return { outcome: 'stale-fence', reason: 'stale-processing-fence' };
    }

    // CODEX REPAIR ROUND (H2) — final authorization must NOT rely on acquisition-time
    // validation (real wall-clock OAuth latency separates acquisition from this
    // transaction). The COMPLETE shared persisted-delivery validator — the same one
    // acquireDeliveryProcessingLease uses — is re-run here from scratch against this
    // fresh transactional read. This worker already proved fence ownership above, so a
    // failure here is genuine data corruption on a document it legitimately owns:
    // quarantine it (invalid-delivery), never merely walk away (stale-fence).
    const completeValidation = validatePersistedDeliveryForProcessing(installationId, deliveryData);
    if (!completeValidation.valid) {
      requireAllowedDeliveryTransition('preparing', 'invalid-delivery');
      transaction.update(deliveryRef, {
        ...buildDeliveryQuarantineUpdate(completeValidation.reason),
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'invalid-delivery', reason: completeValidation.reason };
    }
    const deliveryUid = completeValidation.uid;
    const targetSnapshot = completeValidation.targetSnapshot;
    const fanoutExecutionIdAtCreation = completeValidation.fanoutExecutionIdAtCreation;

    // CODEX REPAIR ROUND (H2/section 12) — require a COHERENT 'preparing' work tuple, not
    // merely state==='preparing'. A tuple classifyDeliveryWorkTuple finds INCONSISTENT
    // (malformed workState/leaseExpiresAt/workAvailableAt combination) is data corruption
    // on a document this worker owns -> invalid-delivery (same rationale as the schema
    // check above). A tuple that IS consistent but already `recoverableNow` (its lease has
    // expired) is an ownership-ambiguity case, NOT corruption — Codex's explicit
    // instruction: "if lease is expired at final auth, stale worker should fail closed
    // even if processingAttemptCount has not yet been incremented by another worker" ->
    // stale-fence, no write, since a legitimate reacquisition could be imminent.
    const workAvailableAtMs = deliveryData.workAvailableAt instanceof Timestamp ? deliveryData.workAvailableAt.toMillis() : null;
    const leaseExpiresAtMs = deliveryData.leaseExpiresAt instanceof Timestamp ? deliveryData.leaseExpiresAt.toMillis() : null;
    const tupleClassification = classifyDeliveryWorkTuple('preparing', deliveryData.workState, workAvailableAtMs, leaseExpiresAtMs, Date.now());
    if (!tupleClassification.consistent) {
      requireAllowedDeliveryTransition('preparing', 'invalid-delivery');
      transaction.update(deliveryRef, {
        ...buildDeliveryQuarantineUpdate('invalid-preparing-work-tuple'),
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'invalid-delivery', reason: 'invalid-preparing-work-tuple' };
    }
    if (tupleClassification.recoverableNow) {
      return { outcome: 'stale-fence', reason: 'stale-processing-fence' };
    }

    // Parent / preference / rollout / installation are independent of each other (only the
    // token claim, below, depends on a value read from the installation) — read together.
    const [parentSnap, prefSnap, rolloutSnap, installSnap] = await Promise.all([
      transaction.get(reminderRef(db, reminderId)),
      transaction.get(preferencesRef(db, deliveryUid)),
      transaction.get(rolloutConfigRef(db)),
      transaction.get(installationRef(db, installationId)),
    ]);

    const cancel = (reason: FinalAuthorizationReason): FinalAuthorizationResult => {
      requireAllowedDeliveryTransition('preparing', 'cancelled');
      transaction.update(deliveryRef, {
        state: 'cancelled',
        ...buildDeliveryTerminalWorkStateFields(),
        cancelReason: reason,
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'cancelled', reason };
    };

    // --- PARENT (identity, fanout-tuple validity, AND H1 provenance equality) ---
    if (!parentSnap.exists) return cancel('parent-invalid');
    const parentData = parentSnap.data()!;
    const parentSchemaCheck = validateReminderSchema(parentData);
    if (!parentSchemaCheck.valid || parentSchemaCheck.uid !== deliveryUid) return cancel('parent-invalid');
    // Do not trust status === 'delivery-fanned-out' alone — the complete tuple validator
    // proves internal consistency (completed vs. failed, with the right accompanying
    // fields, INCLUDING a well-formed fanoutExecutionId on the completed branch — see
    // reminderDeliveryLogic.ts's validateFanoutTuple) rather than a bare status-string
    // comparison.
    const fanoutTupleValidation = validateFanoutTuple(parentData);
    if (!fanoutTupleValidation.valid || fanoutTupleValidation.outcome.deliveryFanoutState !== 'completed') {
      return cancel('parent-fanout-not-completed');
    }
    // CODEX REPAIR ROUND (H1) — the central provenance fence: this exact delivery child
    // must carry the exact fanoutExecutionId the parent's committed, successful fanout
    // generated. Both sides were independently format-validated above/by
    // validateFanoutTuple; only an EXACT match proves membership in that specific
    // successful fanout. See the file header / H1 comments for the full attack model this
    // closes (accidental privileged injection, stale maintenance tooling, a schema-shaped
    // orphan child) and the one it explicitly does NOT claim to close (an omnipotent Admin
    // compromise that can read the parent and fabricate a byte-identical child).
    if (fanoutExecutionIdAtCreation !== fanoutTupleValidation.outcome.fanoutExecutionId) {
      return cancel('fanout-provenance-mismatch');
    }

    // --- ROLLOUT (re-read inside THIS transaction, never trusted from an earlier read) ---
    const rolloutDisposition = decideFinalAuthorizationRolloutDisposition(rolloutSnap.exists ? rolloutSnap.data() : undefined);
    if (rolloutDisposition.decision === 'cancel') return cancel(rolloutDisposition.reason);

    // --- NOTIFICATION PREFERENCE (reuses reminderSchedulerLogic.ts's own revalidateConsent
    // — the exact same consent-revalidation Step 2 already performs immediately before its
    // own dry-run terminalization, applied here immediately before delivery authorization) ---
    const prefData = prefSnap.exists ? prefSnap.data() : undefined;
    const currentSchedule = prefData ? validateSchedule(prefData) : null;
    const consentCheck = revalidateConsent(parentSchemaCheck.preferenceRevisionAtClaim, parentSchemaCheck.claimSchedule, {
      exists: prefSnap.exists,
      enabled: prefData?.enabled,
      revision: prefData?.revision,
      schedule: currentSchedule ?? undefined,
    });
    if (consentCheck.outcome === 'cancelled') return cancel(mapPreferenceCancellationReason(consentCheck.reason));

    // --- INSTALLATION (full current schema, compared against the fanout-time snapshot) ---
    if (!installSnap.exists) return cancel('installation-missing');
    const installData = installSnap.data()!;
    if (installData.uid !== deliveryUid) return cancel('installation-uid-mismatch');
    if (installData.state !== 'active') return cancel('installation-revoked'); // covers any non-active state, not literally 'revoked' only.
    if (classifyEpochSchemaMarker(readFieldPresence(installData, 'epochSchemaVersion')) !== 'current') {
      return cancel('installation-epoch-invalid');
    }
    if (!isValidTokenVersion(installData.tokenVersion)) return cancel('installation-epoch-invalid');
    if (!isValidAudienceId(installData.installationAudienceId)) return cancel('installation-epoch-invalid');
    const currentGeneration = installData.generation;
    if (typeof currentGeneration !== 'number' || !Number.isSafeInteger(currentGeneration) || currentGeneration < 1) {
      return cancel('installation-epoch-invalid');
    }
    if (currentGeneration !== targetSnapshot.generation) return cancel('installation-generation-changed');
    if (installData.tokenVersion !== targetSnapshot.tokenVersion) return cancel('installation-token-version-changed');
    if (installData.installationAudienceId !== targetSnapshot.installationAudienceId) return cancel('installation-audience-changed');
    if (typeof installData.token !== 'string' || installData.token.length === 0) return cancel('installation-token-missing');
    // Held locally for the remainder of this transaction ONLY — never logged, never
    // persisted, never returned. Discarded when this callback returns.
    const currentToken = installData.token;

    // --- TOKEN CLAIM (the exact CURRENT token, hashed in memory — never the stale
    // fanout-time token, which was never even read into this delivery document) ---
    const tokenHash = createHash('sha256').update(currentToken).digest('hex');
    const claimSnap = await transaction.get(tokenClaimRef(db, tokenHash));
    if (!claimSnap.exists) return cancel('token-claim-missing');
    const claimData = claimSnap.data()!;
    if (claimData.installationId !== installationId || claimData.uid !== deliveryUid) {
      return cancel('token-claim-mismatch');
    }

    // ================= WRITE PHASE — every check above passed. =================
    // sendAttemptCount is deliberately never read, referenced, or incremented anywhere in
    // this function — no durable real-send intent is authorized in this phase.
    requireAllowedDeliveryTransition('preparing', 'dry-run-validated');
    transaction.update(deliveryRef, {
      state: 'dry-run-validated',
      ...buildDeliveryTerminalWorkStateFields(),
      validatedAt: FieldValue.serverTimestamp(),
      processedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { outcome: 'dry-run-validated' };
  });
}

// ---------------------------------------------------------------------------------------
// ORCHESTRATION WRAPPER — OAuth preparation, then (only on success) final authorization.
// Kept as a thin composition, not a monolith: OAuth acquisition/classification and the
// final-authorization transaction each remain independently callable/testable above.
// ---------------------------------------------------------------------------------------

export type PrepareAndFinalizeResult = { outcome: 'oauth-preparation-failed' } | FinalAuthorizationResult;

export async function prepareAndFinalizeDelivery(
  db: FirebaseFirestore.Firestore,
  deliveryRef: FirebaseFirestore.DocumentReference,
  expectedProcessingAttemptCount: unknown,
  accessTokenProvider: AccessTokenProvider
): Promise<PrepareAndFinalizeResult> {
  const oauthOutcome = await acquireOAuthAccessToken(accessTokenProvider);
  if (oauthOutcome.outcome === 'failed') {
    // NO Firestore write here — see acquireOAuthAccessToken's own comment for why: the
    // delivery remains 'preparing' with its existing live lease and is retried only once
    // that lease naturally expires.
    return { outcome: 'oauth-preparation-failed' };
  }
  // The OAuth lease-timing hazard is real (see the approved design): OAuth acquisition
  // takes real wall-clock time, during which this worker's lease could expire and a
  // different worker could reacquire. This is NOT handled here with any special logic —
  // finalizeDeliveryAuthorization's own fence re-read (the FIRST thing it does, inside the
  // transaction) is what catches this uniformly, whether the staleness happened during
  // OAuth acquisition or at any other point before the transaction commits.
  return finalizeDeliveryAuthorization(db, deliveryRef, expectedProcessingAttemptCount);
}
