// functions/src/reminderDeliveryAuth.ts
// Phase 3A-3 Step 3C-3 — OAuth preparation and final delivery authorization. This is the
// central security boundary of the entire reminder-delivery pipeline: the ONLY code, ever,
// permitted to transition a delivery out of 'preparing' toward a durable outcome.
//
// ***** STILL NO TRANSPORT IMPORT — BUT NO LONGER "STRUCTURALLY INCAPABLE OF SENDING" ALONE *****
// This file still contains no reference to fcmTransport.ts, sendFcmOnce, getMessaging,
// 'firebase-admin/messaging', 'node:https', or fetch. It never constructs an FCM HTTP
// request and never POSTs a notification itself — reminderDeliverySender.ts (Step 3C-4) is
// the ONLY file, anywhere in this codebase, permitted to import fcmTransport.ts. What CAN
// happen here now, as of Step 3C-4, is authorizing a `preparing -> sending` commit and
// handing the immediate caller a narrow, one-shot, in-memory `DeliverySendCapability`
// (defined below) containing the OAuth token and the installation's current FCM token —
// but ONLY when ALL of: (a) REAL_DELIVERY_STAGE (below) is not 'disabled', (b) the
// freshly-re-read rollout config's mode/allowlist authorizes this uid via
// decideStagedRealSendAuthorization, and (c) every other check this file already performed
// for the dry-run path (parent/provenance, preference, installation, token claim) also
// passes. `state: 'dry-run-validated'` remains reachable and unchanged; `state: 'sending'`
// is the one new reachable terminal-for-this-file outcome.
//
// SOURCE-LEVEL REAL-SEND LOCK (Codex-required, Step 3C-4 adversarial design review) —
// REAL_DELIVERY_STAGE below replaces the prior single boolean REAL_DELIVERY_ENABLED with a
// three-value staged lock (see reminderDeliveryLogic.ts's RealDeliveryStage/
// decideStagedRealSendAuthorization). It is a compile-time-visible constant, independent of
// and never overridden by the Firestore-stored rollout config. GENERAL-REAL-SEND EXPANSION
// (separately-reviewed round) — advanced from 'allowlisted-only' to 'general': under this
// stage, decideStagedRealSendAuthorization authorizes 'allowlisted-real-send' or
// 'controlled-beta' for an allowlisted uid (unchanged from the prior stage), AND
// 'general-real-send' for any otherwise-eligible signed-in uid (no allowlist to check —
// every other invariant in this file, preference/installation/token-claim/provenance/fence,
// is still independently enforced identically for every mode). 'paused', 'dry-run', and a
// non-allowlisted uid under either allowlist mode still fail closed, exactly as before.
// 'controlled-beta' AND 'general-real-send' are both, deliberately, independent of the
// experiment-wide one-shot gate below (see EXPERIMENT-WIDE ONE-SHOT GATE further down) —
// that gate exists only for the legacy single-shot 'allowlisted-real-send' experiment. This
// is layer A of the three-layer enforcement the design review required; layer
// B is the fresh rollout+uid re-decision inside THIS transaction (immediately below);
// layer C is reminderDeliverySender.ts's own, independently-declared REAL_DELIVERY_STAGE
// constant, asserted immediately adjacent to its sole sendFcmOnce call site — a bug or
// compromise in either file's constant alone cannot flip the other's.
//
// ROLLOUT CONFIG — server-owned, fixed path, Admin-SDK-only (see firestore.rules):
//   artifacts/{appId}/systemConfig/notificationRollout
// Parsed via reminderDeliveryLogic.ts's already-approved, pure `parseRolloutConfig`
// (dry-run path) and `decideStagedRealSendAuthorization` (real-send path), both of which
// fail closed to a non-authorizing outcome for any missing/malformed document — this file
// adds no separate "malformed rollout" case because that shape is indistinguishable, by
// design, from 'paused'.
//
// TOKEN SECRECY — the installation's raw FCM token is read into a local variable, used only
// for hashing/validation/(as of Step 3C-4) capability construction, and never otherwise
// escapes this file: never assigned to a field on any Firestore write, never passed to
// `logger`/`console`, never included in a thrown error, and never returned except as the
// `installationToken` field of a `DeliverySendCapability` returned ONLY on the
// newly-authorized `sending` branch — the immediate caller (reminderDeliveryWorker.ts) must
// hand that capability straight to reminderDeliverySender.ts and never log, persist, or
// otherwise retain it. The OAuth access token has the identical treatment as of Step 3C-4:
// acquireOAuthAccessToken now returns it (previously always discarded) specifically so it
// can be threaded into that same one-shot capability; on every other branch (dry-run,
// cancelled, invalid-delivery, stale-fence) it is still never read, used, or exposed at all.
import { randomBytes, createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { GoogleAuth } from 'google-auth-library';
import {
  isValidReminderId,
  isValidInstallationIdShape,
  isValidIdForPath,
  isValidEpochMs,
  validateFanoutTuple,
  requireAllowedDeliveryTransition,
  buildDeliveryTerminalWorkStateFields,
  buildDeliveryQuarantineUpdate,
  buildDeliverySendingIntentFields,
  parseRolloutConfig,
  decideStagedRealSendAuthorization,
  canAuthorizeNewSendIntent,
  classifyDeliveryWorkTuple,
  validatePersistedDeliveryForProcessing,
  OPAQUE_ID_BYTE_LENGTH,
  isValidOpaqueIdFormat,
  type RealDeliveryStage,
} from './reminderDeliveryLogic';
import { validateReminderSchema, validateSchedule, revalidateConsent, isValidAttemptCount, buildReminderId } from './reminderSchedulerLogic';
import { classifyEpochSchemaMarker, readFieldPresence, isValidTokenVersion, isValidAudienceId } from './pushInstallationEpochLogic';

const APP_ID = 'neuroactive-prod';

// See file header — this is a structural phase lock, not a rollout-config-driven decision.
// GENERAL-REAL-SEND EXPANSION — advanced from 'allowlisted-only' to 'general'. This is the
// stage under which decideStagedRealSendAuthorization can additionally return
// `authorized: true` for rollout mode 'general-real-send' with no allowlist membership
// requirement at all — any uid that clears every other independent check (preference
// enabled/revision/schedule, installation state/generation/tokenVersion/audience, token
// claim, provenance, send fence) is eligible. 'allowlisted-real-send'/'controlled-beta'
// remain authorized exactly as before (unchanged by this advance — see
// reminderDeliveryLogic.ts's decideStagedRealSendAuthorization for the exact mode-vs-stage
// precedence rule). Production remains inert after this source change alone: the
// production rollout document controls which mode (if any) is actually active — this
// constant only widens which modes THIS deployed source is capable of honoring if the
// rollout document is later, separately, set to name one.
export const REAL_DELIVERY_STAGE: RealDeliveryStage = 'general';

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
// PHASE 3A-3 STEP 3C-7 — experiment-wide one-shot real-send authorization gate. A single,
// fixed-path document (never queried, never client-accessible — see firestore.rules, which
// default-denies any path with no matching rule, exactly like notificationRollout) that can
// authorize at most one real-send intent across the ENTIRE first-controlled-send
// experiment, independent of any single delivery's own per-attempt bookkeeping. Exists
// specifically because the rollout allowlist alone only constrains WHICH uid may be
// authorized, not HOW MANY TIMES across retries/later occurrences/other installations — see
// validateExperimentGateSchema below for the schema this document must satisfy.
function experimentGateRef(db: FirebaseFirestore.Firestore) {
  return db.doc(`artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`);
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

// CODEX REPAIR ROUND (Step 3C-4) — the success variant now carries the token itself. Prior
// to Step 3C-4 this function always discarded it (nothing downstream ever needed the real
// value). It is still never logged, never persisted, and never returned from this file's
// own exported functions except as one field of a `DeliverySendCapability` constructed
// inside finalizeDeliveryAuthorization's inner transaction, and only on the ONE branch
// that just authorized a real send. On the dry-run/cancelled/invalid-delivery/stale-fence
// branches, `prepareAndFinalizeDelivery` still receives this token but simply never reads
// it — it is dropped when that local variable goes out of scope.
export type OAuthPreparationOutcome = { outcome: 'succeeded'; accessToken: string } | { outcome: 'failed'; reason: 'oauth-preparation-failed' };

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
    // `.length` alone.
    if (typeof token !== 'string' || token.trim().length === 0) {
      return { outcome: 'failed', reason: 'oauth-preparation-failed' };
    }
    return { outcome: 'succeeded', accessToken: token };
  } catch {
    // Deliberately binds no parameter: matches fcmTransport.ts's established convention of
    // never reading a property off a caught exception, since an OAuth client's thrown error
    // could carry credential-adjacent detail in its own message/properties.
    return { outcome: 'failed', reason: 'oauth-preparation-failed' };
  }
}

// ---------------------------------------------------------------------------------------
// PHASE 3A-3 STEP 3C-4 — NARROW ONE-SHOT SEND CAPABILITY.
//
// Returned ONLY after the `preparing -> sending` transaction below successfully commits.
// Intended to be consumed IMMEDIATELY by reminderDeliverySender.ts and discarded after the
// single transport attempt it authorizes — never logged, never persisted, never serialized
// into any summary, never returned from a Cloud Function, and never exposed through any
// reusable "look up a validated token" API. This type is exported ONLY so
// reminderDeliverySender.ts can annotate its own function signature; no other file should
// import it.
// ---------------------------------------------------------------------------------------
export interface DeliverySendCapability {
  deliveryRef: FirebaseFirestore.DocumentReference;
  sendAttemptCount: number;
  sendExecutionId: string;
  sendIntentAtMs: number;
  installationToken: string;
  accessToken: string;
}

// ---------------------------------------------------------------------------------------
// EXPERIMENT GATE VALIDATOR — Timestamp-aware, so it lives here rather than in
// reminderDeliveryLogic.ts (which deliberately has no firebase-admin/firestore dependency).
// Reuses this file's own already-imported `Timestamp` and reminderDeliveryLogic.ts's/
// reminderSchedulerLogic.ts's existing pure validators — no new grammar is invented.
//
// The validator proves only that a SINGLE SNAPSHOT is internally well-formed. It does NOT
// and cannot prove that a 'consumed' document's identity fields are unchanged from when it
// was armed — a document read has no memory of a prior state. That guarantee is instead an
// UPDATE-CONSTRUCTION invariant: the one authorized consume-write (see
// finalizeDeliveryAuthorizationInner below) touches only `state`/`consumedAt`/
// `consumedByExecutionId`, so the four identity fields and `createdAt` are physically
// incapable of changing across that write — proven by test, not claimed by this function.
// ---------------------------------------------------------------------------------------

export interface ExperimentGateArmed {
  state: 'armed';
  expectedUid: string;
  expectedReminderId: string;
  expectedScheduledForMs: number;
  expectedInstallationId: string;
  createdAt: Timestamp;
  consumedAt: null;
  consumedByExecutionId: null;
}

export interface ExperimentGateConsumed {
  state: 'consumed';
  expectedUid: string;
  expectedReminderId: string;
  expectedScheduledForMs: number;
  expectedInstallationId: string;
  createdAt: Timestamp;
  consumedAt: Timestamp;
  consumedByExecutionId: string;
}

export type ExperimentGateValidationResult = { valid: true; gate: ExperimentGateArmed | ExperimentGateConsumed } | { valid: false };

const EXPERIMENT_GATE_KEYS: ReadonlySet<string> = new Set([
  'state',
  'expectedUid',
  'expectedReminderId',
  'expectedScheduledForMs',
  'expectedInstallationId',
  'createdAt',
  'consumedAt',
  'consumedByExecutionId',
]);

export function validateExperimentGateSchema(raw: unknown): ExperimentGateValidationResult {
  if (typeof raw !== 'object' || raw === null) return { valid: false };
  const data = raw as Record<string, unknown>;

  // Exact key set — no extra keys, none missing.
  const keys = Object.keys(data);
  if (keys.length !== EXPERIMENT_GATE_KEYS.size) return { valid: false };
  for (const k of keys) {
    if (!EXPERIMENT_GATE_KEYS.has(k)) return { valid: false };
  }

  if (data.state !== 'armed' && data.state !== 'consumed') return { valid: false };

  const expectedUid = data.expectedUid;
  if (!isValidIdForPath(expectedUid)) return { valid: false };
  const expectedScheduledForMs = data.expectedScheduledForMs;
  if (!isValidEpochMs(expectedScheduledForMs)) return { valid: false };
  const expectedReminderId = data.expectedReminderId;
  if (!isValidReminderId(expectedReminderId)) return { valid: false };
  // Structural binding, not three independently-checked arbitrary strings: the reminderId
  // must be the EXACT reconstruction of uid+scheduledForMs via the real, shared formula —
  // never a hand-duplicated template literal (see buildReminderId in reminderSchedulerLogic.ts).
  if (expectedReminderId !== buildReminderId(expectedUid, expectedScheduledForMs)) return { valid: false };
  const expectedInstallationId = data.expectedInstallationId;
  if (!isValidInstallationIdShape(expectedInstallationId)) return { valid: false };
  const createdAt = data.createdAt;
  if (!(createdAt instanceof Timestamp)) return { valid: false };

  if (data.state === 'armed') {
    if (data.consumedAt !== null) return { valid: false };
    if (data.consumedByExecutionId !== null) return { valid: false };
    return {
      valid: true,
      gate: { state: 'armed', expectedUid, expectedReminderId, expectedScheduledForMs, expectedInstallationId, createdAt, consumedAt: null, consumedByExecutionId: null },
    };
  }

  // state === 'consumed'
  const consumedAt = data.consumedAt;
  if (!(consumedAt instanceof Timestamp)) return { valid: false };
  if (consumedAt.toMillis() < createdAt.toMillis()) return { valid: false };
  const consumedByExecutionId = data.consumedByExecutionId;
  if (!isValidOpaqueIdFormat(consumedByExecutionId)) return { valid: false };
  return {
    valid: true,
    gate: { state: 'consumed', expectedUid, expectedReminderId, expectedScheduledForMs, expectedInstallationId, createdAt, consumedAt, consumedByExecutionId },
  };
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
  | 'token-claim-mismatch'
  // Step 3C-4 additions — every one of these maps 1:1 from
  // reminderDeliveryLogic.ts's StagedRealSendAuthorizationDecision failure reasons (see
  // mapStagedReasonToFinalAuthReason below), reached only when the rollout mode is
  // 'allowlisted-real-send', 'controlled-beta', or 'general-real-send' (a 'paused'/'dry-run'
  // rollout never reaches the staged-authorization check at all).
  | 'rollout-real-send-stage-disabled'
  | 'rollout-real-send-not-allowlisted'
  | 'rollout-real-send-mode-not-permitted-at-stage'
  | 'rollout-real-send-invalid-uid'
  // Step 3C-7 additions — the experiment-wide one-shot gate (see experimentGateRef /
  // validateExperimentGateSchema above). Reached ONLY on the real-send continuation, after
  // every check above (including the rollout/preference/installation/token-claim checks)
  // has already passed — never on the dry-run/paused/non-allowlisted branches, which return
  // before this gate is ever read.
  | 'experiment-gate-missing'
  | 'experiment-gate-malformed'
  | 'experiment-gate-consumed'
  | 'experiment-gate-identity-mismatch';

export type RolloutDisposition =
  | { decision: 'proceed-dry-run' }
  // Step 3C-4 addition: every check this transaction performs for the dry-run path
  // (parent/provenance, preference, installation, token claim) is performed IDENTICALLY
  // for this decision — see finalizeDeliveryAuthorization's write phase below for the one
  // place their handling actually diverges (writing 'sending' + the send capability
  // instead of 'dry-run-validated').
  | { decision: 'proceed-real-send'; experimentGateRequired: boolean }
  | { decision: 'cancel'; reason: FinalAuthorizationReason };

function mapStagedReasonToFinalAuthReason(
  reason: 'paused' | 'dry-run-only' | 'not-allowlisted' | 'invalid-uid' | 'stage-disabled' | 'mode-not-permitted-at-current-stage'
): FinalAuthorizationReason {
  switch (reason) {
    case 'paused':
      return 'rollout-paused';
    case 'dry-run-only':
      // Unreachable in practice — decideFinalAuthorizationRolloutDisposition below only
      // ever calls decideStagedRealSendAuthorization for a rollout mode that is NOT
      // 'dry-run' (that mode is handled by its own branch first) — kept exhaustive so a
      // future reason added to the shared type cannot silently fall through unmapped.
      return 'rollout-mode-not-supported-in-this-phase';
    case 'not-allowlisted':
      return 'rollout-real-send-not-allowlisted';
    case 'invalid-uid':
      return 'rollout-real-send-invalid-uid';
    case 'stage-disabled':
      return 'rollout-real-send-stage-disabled';
    case 'mode-not-permitted-at-current-stage':
      return 'rollout-real-send-mode-not-permitted-at-stage';
  }
}

// `deliveryUid` must be the ALREADY-validated uid the caller obtained from
// validatePersistedDeliveryForProcessing earlier in the same transaction — never a raw,
// unvalidated field read. 'paused' cancels (never requeues — see the approved design's
// non-spinning-paused-disposition requirement). 'dry-run' always proceeds to the existing
// dry-run path, unconditionally. 'allowlisted-real-send'/'controlled-beta'/'general-real-send'
// consult decideStagedRealSendAuthorization against THIS file's own REAL_DELIVERY_STAGE
// constant (layer B of the three-layer enforcement — see the file header). With
// REAL_DELIVERY_STAGE === 'general', 'proceed-real-send' is reachable for rollout mode
// 'allowlisted-real-send' or 'controlled-beta' with deliveryUid present in that document's
// own allowlistUids, AND for 'general-real-send' with no allowlist requirement at all —
// what actually authorizes a real send in production is entirely a function of the current
// rollout document's own content, independent of this source change.
export function decideFinalAuthorizationRolloutDisposition(rawRolloutConfig: unknown, deliveryUid: unknown): RolloutDisposition {
  const parsed = parseRolloutConfig(rawRolloutConfig);
  if (parsed.mode === 'paused') return { decision: 'cancel', reason: 'rollout-paused' };
  if (parsed.mode === 'dry-run') return { decision: 'proceed-dry-run' };
  const staged = decideStagedRealSendAuthorization(REAL_DELIVERY_STAGE, rawRolloutConfig, deliveryUid);
  if (!staged.authorized) return { decision: 'cancel', reason: mapStagedReasonToFinalAuthReason(staged.reason) };
  return { decision: 'proceed-real-send', experimentGateRequired: parsed.mode === 'allowlisted-real-send' };
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
  | { outcome: 'delivery-not-found' }
  // Step 3C-4 addition — every check that would otherwise reach 'dry-run-validated' passed
  // AND the rollout+stage combination authorized a real send. Carries the one-shot
  // capability the immediate caller must hand straight to reminderDeliverySender.ts. With
  // REAL_DELIVERY_STAGE === 'general', this branch is reachable for rollout mode
  // 'allowlisted-real-send' or 'controlled-beta' with an allowlisted uid, or for
  // 'general-real-send' with no allowlist requirement at all — see
  // decideFinalAuthorizationRolloutDisposition for the exact mode-vs-stage precedence.
  | { outcome: 'sending-authorized'; capability: DeliverySendCapability };

// `expectedProcessingAttemptCount` is the fence the caller obtained from its own
// `acquireDeliveryProcessingLease` acquisition — mirrors reminderDeliveryWorker.ts's
// existing fanout fence pattern exactly. Accepts `unknown` and is validated (via
// reminderSchedulerLogic.ts's own isValidAttemptCount — same domain, reused rather than
// reinvented) before any Firestore access. `accessToken` is the already-acquired OAuth
// token (see acquireOAuthAccessToken/prepareAndFinalizeDelivery) — read here ONLY to embed
// in a DeliverySendCapability on the newly-authorized 'sending-authorized' branch; every
// other branch never touches it.
//
// CODEX REPAIR ROUND (Step 3C-4) — sendExecutionId and sendIntentAtMs are generated ONCE,
// HERE, before db.runTransaction(...) is ever called — exactly mirroring the existing
// reminder-delivery fanout module's already-approved public/private split for its own
// per-attempt random identity (generated once outside the transaction, reused verbatim
// across any callback retry, never generated by the private inner function itself). This
// function is a thin public wrapper that generates both values (spending them even on a
// call that turns out not to need them — e.g. a dry-run or cancelled outcome — exactly
// like that same fanout identity is already generated on every attempt regardless of
// eventual outcome) and delegates to a module-private inner function that is not
// exported: no external caller can ever supply/override/predict a sendExecutionId, and a
// transaction-callback retry for the SAME intent reuses this SAME closure-captured value
// rather than generating a new one.
export async function finalizeDeliveryAuthorization(
  db: FirebaseFirestore.Firestore,
  deliveryRef: FirebaseFirestore.DocumentReference,
  expectedProcessingAttemptCount: unknown,
  accessToken: string
): Promise<FinalAuthorizationResult> {
  const sendExecutionId = randomBytes(OPAQUE_ID_BYTE_LENGTH).toString('base64url');
  const sendIntentAtMs = Date.now();
  return finalizeDeliveryAuthorizationInner(db, deliveryRef, expectedProcessingAttemptCount, accessToken, sendExecutionId, sendIntentAtMs);
}

// Module-private (no `export`): the actual transaction. Its ONLY caller, anywhere, is
// finalizeDeliveryAuthorization immediately above.
function finalizeDeliveryAuthorizationInner(
  db: FirebaseFirestore.Firestore,
  deliveryRef: FirebaseFirestore.DocumentReference,
  expectedProcessingAttemptCount: unknown,
  accessToken: string,
  sendExecutionId: string,
  sendIntentAtMs: number
): Promise<FinalAuthorizationResult> {
  if (!isValidAttemptCount(expectedProcessingAttemptCount)) {
    return Promise.resolve({ outcome: 'stale-fence', reason: 'stale-processing-fence' });
  }
  const reminderId = deliveryRef.parent.parent?.id;
  if (!isValidReminderId(reminderId)) {
    return Promise.resolve({ outcome: 'delivery-not-found' });
  }
  const installationId = deliveryRef.id;
  if (!isValidInstallationIdShape(installationId)) {
    return Promise.resolve({ outcome: 'delivery-not-found' });
  }
  if (!isValidOpaqueIdFormat(sendExecutionId)) {
    // Unreachable given this file's own generation above always produces a well-formed
    // value — kept as a genuine runtime guard (not a TypeScript-only narrowing) matching
    // this codebase's "accept unknown, validate internally" convention, since a future
    // caller-side refactor could otherwise silently thread a malformed value through.
    throw new Error('reminderDeliveryAuth: sendExecutionId must be a valid opaque ID.');
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
    const rolloutDisposition = decideFinalAuthorizationRolloutDisposition(rolloutSnap.exists ? rolloutSnap.data() : undefined, deliveryUid);
    if (rolloutDisposition.decision === 'cancel') return cancel(rolloutDisposition.reason);
    const willAuthorizeRealSend = rolloutDisposition.decision === 'proceed-real-send';
    const experimentGateRequired = willAuthorizeRealSend && rolloutDisposition.experimentGateRequired;

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
    if (!willAuthorizeRealSend) {
      // Unchanged dry-run path: sendAttemptCount/sendExecutionId are deliberately never
      // read, referenced, or incremented here — no durable real-send intent is authorized
      // on this branch.
      requireAllowedDeliveryTransition('preparing', 'dry-run-validated');
      transaction.update(deliveryRef, {
        state: 'dry-run-validated',
        ...buildDeliveryTerminalWorkStateFields(),
        validatedAt: FieldValue.serverTimestamp(),
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'dry-run-validated' };
    }

    // --- EXPERIMENT-WIDE ONE-SHOT GATE (Step 3C-7). The legacy
    // allowlisted-real-send experiment still requires this fresh transactional read and
    // consumes the gate atomically with its send intent. Recurring controlled-beta is
    // explicitly gate-independent and therefore neither reads nor writes the singleton. ---
    if (experimentGateRequired) {
      const gateSnap = await transaction.get(experimentGateRef(db));
      if (!gateSnap.exists) return cancel('experiment-gate-missing');
      const gateValidation = validateExperimentGateSchema(gateSnap.data());
      if (!gateValidation.valid) return cancel('experiment-gate-malformed');
      const gate = gateValidation.gate;
      if (gate.state === 'consumed') return cancel('experiment-gate-consumed');
      if (gate.expectedUid !== deliveryUid || gate.expectedReminderId !== reminderId || gate.expectedInstallationId !== installationId) {
        return cancel('experiment-gate-identity-mismatch');
      }
    }

    // Step 3C-4 real-send authorization branch — reachable in production whenever the
    // rollout document names a real-send-authorizing mode (see REAL_DELIVERY_STAGE above).
    if (!canAuthorizeNewSendIntent(completeValidation.sendAttemptCount)) {
      // Defensive only: decideSendOutcomeAction already terminalizes to 'rejected-final'
      // once MAX_SEND_ATTEMPTS is reached rather than ever requeuing to 'queued', so a
      // 'preparing' delivery should never legitimately carry an exhausted sendAttemptCount
      // — reaching here means unexplained corruption on a document this worker owns.
      requireAllowedDeliveryTransition('preparing', 'invalid-delivery');
      transaction.update(deliveryRef, {
        ...buildDeliveryQuarantineUpdate('send-attempt-count-exhausted'),
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'invalid-delivery', reason: 'send-attempt-count-exhausted' };
    }
    const sendAttemptCountAfterThisIntent = completeValidation.sendAttemptCount + 1;

    requireAllowedDeliveryTransition('preparing', 'sending');
    transaction.update(deliveryRef, {
      ...buildDeliverySendingIntentFields(sendExecutionId, sendAttemptCountAfterThisIntent, sendIntentAtMs),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Same transaction, same commit as the delivery write above — Firestore's atomic
    // multi-document commit is what makes "exactly one real-send intent, ever" hold: either
    // BOTH writes land together or NEITHER does. Touches ONLY these three fields — the four
    // expected* identity fields and createdAt are never rewritten (see the update-
    // construction invariant documented on validateExperimentGateSchema above).
    if (experimentGateRequired) {
      transaction.update(experimentGateRef(db), {
        state: 'consumed',
        consumedAt: FieldValue.serverTimestamp(),
        consumedByExecutionId: sendExecutionId,
      });
    }
    return {
      outcome: 'sending-authorized',
      capability: {
        deliveryRef,
        sendAttemptCount: sendAttemptCountAfterThisIntent,
        sendExecutionId,
        sendIntentAtMs,
        installationToken: currentToken,
        accessToken,
      },
    };
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
  //
  // Step 3C-4: oauthOutcome.accessToken is threaded straight through, held only in this
  // local parameter chain — never logged, never persisted here either. On every branch
  // except 'sending-authorized', finalizeDeliveryAuthorization itself never reads it.
  return finalizeDeliveryAuthorization(db, deliveryRef, expectedProcessingAttemptCount, oauthOutcome.accessToken);
}
