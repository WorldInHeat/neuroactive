// functions/src/reminderDeliveryWorker.ts
// Phase 3A-3 Step 3C-2 — Firestore orchestration for reminder-delivery fanout and the
// delivery work queue. Wires the pure, Codex-approved decision functions in
// reminderDeliveryLogic.ts to real Firestore reads/writes.
//
// ***** PRODUCTION REACHABILITY (Phase 3A-3 Step 3C-3, extended Step 3C-4/3C-5/3C-6) *****
// This file now exports exactly ONE Cloud Function, `notificationReminderDeliveryWorker`
// (renamed from `notificationReminderDeliveryDryRun` — see the FUNCTION-IDENTITY REPAIR
// comment at the bottom of this file for why, and the accompanying migration analysis for
// why the rename is NOT deployed this turn), wired into functions/src/index.ts. Reachability:
// this Cloud Function calls runDeliveryWorkerBatch -> discoverRecoverableDeliveryWork ->
// acquireDeliveryProcessingLease -> reminderDeliverySender.ts's processControlledSendCandidate.
//
// CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR (Step 3C-5, SIXTH round, SECOND pass) —
// there is no longer a separate "reminderDeliveryWorkerCore.ts" at all. The FIFTH round's
// separate-core-file design (like reminderDeliverySender.ts's own identical FIFTH-round
// design) could not actually keep a PARAMETERIZED, transport-capable orchestration function
// out of the deployed artifact while still having production invoke it: `tsc` re-includes
// and EMITS any file that an included file `import`s, regardless of `exclude` — verified
// empirically this round. See reminderDeliverySender.ts's own header for the full
// explanation; the same reasoning applies here verbatim.
//
// discoverRecoverableDeliveryWork/acquireDeliveryProcessingLease remain exported and
// db-parameterized (unchanged from every prior round) — Codex has never objected to these:
// neither is capable of transitively reaching sendFcmOnce on its own (acquisition only ever
// moves 'queued'/'preparing' Firestore state; it never calls reminderDeliverySender.ts).
// processDeliveryQueueCandidate/runDeliveryWorkerBatch — the part that DOES reach transport,
// via reminderDeliverySender.ts's processControlledSendCandidate — are thin, ZERO/ONE-
// parameter production entry points that privately (module-scope, never exported, captured
// immutably at module-evaluation time — see the IMMUTABLE CAPTURE block below) obtain the
// real Admin Firestore instance. There is no parameter anywhere in either exported function
// through which any caller could substitute a different db or sendCandidate implementation.
//
// HOW TESTS STILL EXERCISE THIS EXACT CODE: see reminderDeliverySender.ts's own header for
// the full explanation of the require-cache-busting + pre-load-mutation technique this
// file's own test suite uses identically (mutating firebase-admin/app's/firebase-admin/
// firestore's exports BEFORE first requiring this file, then clearing
// require.cache[require.resolve('./reminderDeliveryWorker')] to force a fresh, fake-capturing
// re-evaluation) — squarely inside the "test controls its own require order before first
// load" case Codex's own instruction (section 9) explicitly carves out of the threat model.
//
// ***** SENDER REACHABILITY (Step 3C-4, ARCHITECTURE REPAIRED IN 3C-5/3C-6) *****
// This file no longer calls reminderDeliveryAuth.ts's prepareAndFinalizeDelivery or any
// capability-consuming sender function directly. Instead, processDeliveryQueueCandidate below
// calls reminderDeliverySender.ts's single exported orchestration entry point,
// processControlledSendCandidate, which internally performs the ENTIRE authorization-then-
// send flow (OAuth preparation, the fresh final-authorization transaction, and — only if that
// transaction itself decided 'sending-authorized' — the one sendFcmOnce call, using ITS OWN
// immutably-captured authority) and returns an already-sanitized result. This file therefore
// never receives, holds, or could possibly forward a DeliverySendCapability, a raw FCM token,
// or a raw OAuth token — there is no such value anywhere in this file's own code at all,
// structurally, not merely by convention.
//
// Real send authorization is reachable only when ALL of: reminderDeliveryAuth.ts's own
// REAL_DELIVERY_STAGE is not 'disabled' (currently 'allowlisted-only'),
// reminderDeliverySender.ts's OWN, independently-declared REAL_DELIVERY_STAGE also permits it
// (currently 'allowlisted-only' too, but changed independently — see that file's header for
// why two separate constants are required), the production rollout document is actually set
// to 'allowlisted-real-send', and the requesting uid is present in that document's own
// allowlist — every one of those is verified fresh, inside finalizeDeliveryAuthorization's
// own transaction, not trusted from any earlier read. General (unrestricted) real sending
// remains source-disabled regardless of rollout content. Today, the production rollout
// document remains `{mode:"paused"}` — a source change alone (this commit, undeployed or
// deployed) does not touch that document, so no send can occur until a separate, later,
// explicitly authorized rollout mutation.
//
// TARGET SNAPSHOT FIELD SHAPE — the original Step 3C design sketch used flat field names
// (generationAtFanout/tokenVersionAtFanout/installationAudienceIdAtFanout/
// epochSchemaVersionAtFanout). This file instead writes a single nested `targetSnapshot`
// object matching reminderDeliveryLogic.ts's already-approved, FROZEN `TargetSnapshot`
// interface and `validateDeliverySchema` (which reads `data.targetSnapshot.generation` /
// `.tokenVersion` / `.installationAudienceId` as a nested object, not flat fields, and has no
// epochSchemaVersion field on TargetSnapshot at all) — the committed Step 3C-1 pure-logic
// contract is authoritative over the earlier design sketch's suggested naming, per that
// design round's own instruction to "inspect the authoritative design and existing schema
// before finalizing exact names."
//
// PARENT STATUS MODEL — Phase 3A-3 Step 3C-2 Codex repair round (L1): 'delivery-fanned-out'
// is now a formally recognized member of reminderSchedulerLogic.ts's REMINDER_STATUSES
// (terminal, reachable only from 'processing', zero outgoing transitions) — see that
// file's own comment for why. This file uses the real requireAllowedTransition from that
// table (not an ad-hoc local fence) to authorize the processing -> delivery-fanned-out
// write, exactly like every other terminal write elsewhere in this codebase.
//
// FANOUT-NONCE OWNERSHIP — Phase 3A-3 Step 3C-2 Codex repair rounds (H1, then FINAL): the
// production entry point, fanOutReminderDelivery, generates its own 256-bit fanoutNonce via
// randomBytes(FANOUT_NONCE_BYTE_LENGTH) exactly once, BEFORE calling db.runTransaction(...),
// and is not callable with a caller-supplied nonce — public-ID opacity must never depend on
// an unenforced caller promise. The actual transaction logic lives in the module-PRIVATE
// (not exported, no `export` keyword) fanOutReminderDeliveryWithNonce, which
// fanOutReminderDelivery delegates to after generating the nonce. THIS MODULE EXPORTS NO
// FUNCTION THAT ACCEPTS A CALLER-SUPPLIED NONCE — a prior round's test-only exported
// nonce-taking wrapper was removed entirely per Codex's final verdict: an exported
// nonce-taking seam is itself the vulnerability, regardless of its name or how clearly it is
// documented as test-only, because it is a real symbol any future production source file
// could import and call. Tests that need a deterministic public ID now monkeypatch the real
// node:crypto randomBytes (the same technique already used for the invocation-count tests)
// and drive the PUBLIC fanOutReminderDelivery exclusively — see reminderDeliveryWorker.test
// .ts's header for the full rationale.
'use strict';

import { randomBytes } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import { buildTerminalWorkStateFields, isValidAttemptCount, requireAllowedTransition, processWithBoundedConcurrency } from './reminderSchedulerLogic';
import { processControlledSendCandidate, type SanitizedSendOrchestrationResult } from './reminderDeliverySender';
import {
  isValidIdForPath,
  isValidReminderId,
  isValidInstallationIdShape,
  requireAllowedDeliveryTransition,
  computeDeliveryLeaseExpiresAtMs,
  decideDeliveryQueueOutcome,
  buildDeliveryTerminalWorkStateFields,
  buildDeliveryQuarantineUpdate,
  buildUnknownDeliveryStateNeutralizationUpdate,
  validateDeliverySchema,
  validatePersistedDeliveryForProcessing,
  decideFanoutOutcome,
  buildPreExistingChildCorruptionOutcome,
  validateFanoutTuple,
  deriveDeliveryPublicId,
  FANOUT_NONCE_BYTE_LENGTH,
  FANOUT_QUERY_LIMIT,
  OPAQUE_ID_BYTE_LENGTH,
  OPAQUE_ID_LENGTH,
  isValidOpaqueIdFormat,
  type TargetSnapshot,
  type FanoutOutcome,
} from './reminderDeliveryLogic';
import {
  classifyEpochSchemaMarker,
  readFieldPresence,
  isValidTokenVersion,
  isValidAudienceId,
} from './pushInstallationEpochLogic';

// ---------------------------------------------------------------------------------------
// IMMUTABLE CAPTURE (CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR, SIXTH round, H4) — the
// SAME technique as reminderDeliverySender.ts's own identical block (see that file's header
// for the full rationale): getApps/initializeApp/getFirestore are captured into plain local
// `const` bindings ONCE, at this module's own evaluation time, and never read through the
// live `firebase-admin/app`/`firebase-admin/firestore` module namespace again.
// ---------------------------------------------------------------------------------------
const capturedGetApps = getApps;
const capturedInitializeApp = initializeApp;
const capturedGetFirestore = getFirestore;
// Captures reminderDeliverySender.ts's own exported entry point too — the same reasoning
// applies at this module boundary as at the raw-dependency boundary above: an un-captured,
// live property read through the imported sender module's namespace object at every call
// site would let a future in-process mutation of reminderDeliverySender.ts's exports
// redirect what this file calls.
const capturedProcessControlledSendCandidate = processControlledSendCandidate;

const APP_ID = 'neuroactive-prod';

// ---------------------------------------------------------------------------------------
// Path helpers — mirrors reminderScheduler.ts's own per-file path-helper convention.
// ---------------------------------------------------------------------------------------

function remindersCollection(db: FirebaseFirestore.Firestore) {
  return db.collection(`artifacts/${APP_ID}/reminders`);
}
function reminderRef(db: FirebaseFirestore.Firestore, reminderId: string) {
  return db.doc(`artifacts/${APP_ID}/reminders/${reminderId}`);
}
function deliveriesCollection(db: FirebaseFirestore.Firestore, reminderId: string) {
  return reminderRef(db, reminderId).collection('deliveries');
}
function deliveryRef(db: FirebaseFirestore.Firestore, reminderId: string, installationId: string) {
  return deliveriesCollection(db, reminderId).doc(installationId);
}
function pushInstallationsCollection(db: FirebaseFirestore.Firestore) {
  return db.collection(`artifacts/${APP_ID}/pushInstallations`);
}

// ---------------------------------------------------------------------------------------
// FANOUT — transactional target discovery, deterministic child creation, parent
// terminalization. See the approved Step 3C design for the full algorithm; this is its
// direct Firestore implementation.
// ---------------------------------------------------------------------------------------

// Delivery-critical per-installation validation. Excludes (never whole-batch-fails) any
// individual active installation document that fails ANY of these checks. The raw FCM
// token is inspected for PRESENCE ONLY (a nonempty string) and its value is immediately
// discarded — it is never assigned to any variable that outlives this function, never
// stored on the delivery child, and never logged.
function validateFanoutCandidateInstallation(
  installationId: string,
  data: FirebaseFirestore.DocumentData,
  parentUid: string
): { installationId: string; targetSnapshot: TargetSnapshot } | null {
  if (!isValidInstallationIdShape(installationId)) return null;
  if (data.uid !== parentUid) return null;
  if (data.state !== 'active') return null;
  if (classifyEpochSchemaMarker(readFieldPresence(data, 'epochSchemaVersion')) !== 'current') return null;
  if (!isValidTokenVersion(data.tokenVersion)) return null;
  if (!isValidAudienceId(data.installationAudienceId)) return null;
  const generation = data.generation;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return null;
  if (typeof data.token !== 'string' || data.token.length === 0) return null; // presence-only.

  return {
    installationId,
    targetSnapshot: { generation, tokenVersion: data.tokenVersion, installationAudienceId: data.installationAudienceId },
  };
}

export type FanoutExecutionResult =
  | { outcome: 'fanned-out'; fanoutOutcome: FanoutOutcome; createdDeliveryCount: number }
  | {
      outcome: 'not-eligible';
      reason: 'reminder-not-found' | 'fence-mismatch' | 'invalid-parent-uid' | 'invalid-expected-attempt-count';
    };

// `expectedAttemptCount` mirrors reminderScheduler.ts's commitFinalOutcome fence exactly
// (status==='processing' && attemptCount===expectedAttemptCount) — a future Step 3C-3
// caller passes the attemptCount it obtained from its own lease acquisition, the same way
// commitFinalOutcome's callers already do for the dry-run terminalization path. Accepts
// `unknown` and is validated via reminderSchedulerLogic.ts's own isValidAttemptCount BEFORE
// any Firestore access — a malformed caller value fails closed here, never reaching a
// transaction (Codex repair round, L2).
//
// H1 (Codex repair round): this is the ONLY production entry point for fanout. It owns
// fanoutNonce generation completely — callers cannot supply, override, or predict it.
export async function fanOutReminderDelivery(
  db: FirebaseFirestore.Firestore,
  reminderId: string,
  expectedAttemptCount: unknown
): Promise<FanoutExecutionResult> {
  if (!isValidReminderId(reminderId)) {
    return { outcome: 'not-eligible', reason: 'reminder-not-found' };
  }
  if (!isValidAttemptCount(expectedAttemptCount)) {
    return { outcome: 'not-eligible', reason: 'invalid-expected-attempt-count' };
  }
  // Generated exactly once, here, before any transaction attempt. Firestore may retry the
  // callback below on contention; this SAME nonce value is reused on every retry because it
  // is captured in the callback's closure, never regenerated inside it.
  //
  // CODEX REPAIR ROUND (H1) — fanoutExecutionId is a SEPARATE, independently-generated
  // opaque random value (Option A from the repair instructions: two independent
  // randomBytes calls, not a value derived from fanoutNonce — avoiding unnecessary coupling
  // between the HMAC-key role fanoutNonce plays and the pure-identity role
  // fanoutExecutionId plays). It proves "this exact delivery child was created by this
  // exact successful fanout" — see reminderDeliveryLogic.ts's FanoutOutcome/
  // decideFanoutOutcome/validateFanoutTuple for the immutable parent-side field, and
  // reminderDeliveryAuth.ts's finalizeDeliveryAuthorization for the equality check against
  // the child's own fanoutExecutionIdAtCreation.
  const fanoutNonce = randomBytes(FANOUT_NONCE_BYTE_LENGTH);
  const fanoutExecutionId = randomBytes(OPAQUE_ID_BYTE_LENGTH).toString('base64url');
  return fanOutReminderDeliveryWithNonce(db, reminderId, expectedAttemptCount, fanoutNonce, fanoutExecutionId);
}

// Module-private (no `export`): the actual fanout transaction. Its ONLY caller, anywhere,
// is fanOutReminderDelivery immediately above — no other function in this file or any other
// file may reach it, and no exported symbol accepts a fanoutNonce/fanoutExecutionId
// parameter (Codex FINAL repair round: the prior test-only exported wrapper was removed for
// exactly this reason).
function fanOutReminderDeliveryWithNonce(
  db: FirebaseFirestore.Firestore,
  reminderId: string,
  expectedAttemptCount: number,
  fanoutNonce: Buffer,
  fanoutExecutionId: string
): Promise<FanoutExecutionResult> {
  if (!Buffer.isBuffer(fanoutNonce) || fanoutNonce.byteLength !== FANOUT_NONCE_BYTE_LENGTH) {
    throw new Error(`fanOutReminderDelivery: fanoutNonce must be a Buffer of exactly ${FANOUT_NONCE_BYTE_LENGTH} bytes.`);
  }
  if (!isValidOpaqueIdFormat(fanoutExecutionId)) {
    throw new Error(`fanOutReminderDelivery: fanoutExecutionId must be a valid opaque ID (${OPAQUE_ID_LENGTH}-character base64url).`);
  }

  const parentRef = reminderRef(db, reminderId);

  return db.runTransaction(async (transaction): Promise<FanoutExecutionResult> => {
    // ================= READ PHASE — every read below completes before any write. =================
    const parentSnap = await transaction.get(parentRef);
    if (!parentSnap.exists) return { outcome: 'not-eligible', reason: 'reminder-not-found' };
    const parentData = parentSnap.data()!;
    // Codex repair round (L2): the parent's OWN attemptCount is independently runtime
    // validated before the equality comparison — a malformed persisted attemptCount must
    // never coincidentally equal a (now-guaranteed-valid) expectedAttemptCount and slip
    // through the fence. This is the exact same fence discipline
    // reminderScheduler.ts's commitFinalOutcome already uses (status==='processing' &&
    // attemptCount===myAttemptCount); Step 2 does not track a separate workerId, so
    // attemptCount + status is the actual, documented fence, not a stand-in for one.
    if (
      parentData.status !== 'processing' ||
      !isValidAttemptCount(parentData.attemptCount) ||
      parentData.attemptCount !== expectedAttemptCount
    ) {
      return { outcome: 'not-eligible', reason: 'fence-mismatch' };
    }
    const uid = parentData.uid;
    if (!isValidIdForPath(uid)) {
      return { outcome: 'not-eligible', reason: 'invalid-parent-uid' };
    }
    // L1: 'processing' -> 'delivery-fanned-out' is now a real, recognized transition in
    // reminderSchedulerLogic.ts's shared status table — validated here via the real
    // requireAllowedTransition rather than an ad-hoc local check. parentData.status is
    // already proven === 'processing' above, so this can only ever throw on a future,
    // genuine programming error (e.g. this file's own logic changing status unexpectedly).
    requireAllowedTransition(parentData.status, 'delivery-fanned-out');

    // Transactional target discovery: the active-installation query runs INSIDE the
    // fanout transaction itself (Transaction.get(Query)), holding a pessimistic lock on
    // every returned document for the lifetime of this transaction. limit(FANOUT_QUERY_LIMIT)
    // (= MAX_TARGET_INSTALLATIONS + 1) lets a returned size of FANOUT_QUERY_LIMIT prove "at
    // least that many active installations exist" without ever claiming an exact total.
    //
    // Index note: this combines two equality filters (uid, state) with orderBy(documentId())
    // for deterministic ordering. Per Codex's explicit prior guidance
    // ("COMPOSITE NOT REQUIRED / VERIFY AT EXECUTION"), no composite index is added
    // preemptively for this query in firestore.indexes.json this round — see the
    // implementation report's "indexes" and "limitations" sections; this has NOT been
    // verified against a live Firestore query planner or emulator in this round.
    const activeQuery = pushInstallationsCollection(db)
      .where('uid', '==', uid)
      .where('state', '==', 'active')
      .orderBy(FieldPath.documentId())
      .limit(FANOUT_QUERY_LIMIT);
    const activeSnap = await transaction.get(activeQuery);
    const rawActiveCount = activeSnap.size;

    // Cap check on the RAW query result, BEFORE any per-document schema validation —
    // exactly per the approved design. Over-cap short-circuits with zero children and no
    // child-ref reads at all.
    if (rawActiveCount >= FANOUT_QUERY_LIMIT) {
      const outcome = decideFanoutOutcome(rawActiveCount, 0, fanoutExecutionId);
      return commitFanoutOutcome(transaction, parentRef, outcome, uid, fanoutExecutionId, []);
    }

    // Per-document delivery-critical validation. Malformed installations are excluded
    // individually (never a whole-batch failure); the exclusion count is tracked
    // separately from the validated target count, per the approved design.
    const validTargets: { installationId: string; targetSnapshot: TargetSnapshot }[] = [];
    let excludedMalformedCount = 0;
    for (const doc of activeSnap.docs) {
      const candidate = validateFanoutCandidateInstallation(doc.id, doc.data(), uid);
      if (candidate) validTargets.push(candidate);
      else excludedMalformedCount++;
    }

    const childPlans = validTargets.map((target) => ({
      ...target,
      deliveryPublicId: deriveDeliveryPublicId(fanoutNonce, reminderId, target.installationId),
      ref: deliveryRef(db, reminderId, target.installationId),
    }));

    // Read every deterministic child ref BEFORE any write — still inside the read phase.
    let preExistingChild = false;
    if (childPlans.length > 0) {
      const childSnaps = await transaction.getAll(...childPlans.map((plan) => plan.ref));
      preExistingChild = childSnaps.some((snap) => snap.exists);
    }

    // ================= WRITE PHASE =================
    if (preExistingChild) {
      // A genuinely fresh parent (processing + fresh attemptCount fence, just verified
      // above) can never legitimately find a pre-existing deterministic child — reaching
      // this means unexplained, out-of-band corruption. Fail the WHOLE fanout closed:
      // create zero children, never adopt/merge/overwrite the unexpected document.
      const outcome = buildPreExistingChildCorruptionOutcome();
      return commitFanoutOutcome(transaction, parentRef, outcome, uid, fanoutExecutionId, []);
    }

    const outcome = decideFanoutOutcome(rawActiveCount, excludedMalformedCount, fanoutExecutionId);
    return commitFanoutOutcome(transaction, parentRef, outcome, uid, fanoutExecutionId, childPlans);
  });
}

// Shared write-phase helper: validates the constructed outcome tuple (defense-in-depth —
// decideFanoutOutcome/buildPreExistingChildCorruptionOutcome are already-approved pure
// functions, but validating their output before it is ever persisted costs nothing and
// catches a future construction bug before it reaches Firestore), creates every valid
// child via `.create()` (which itself fails the transaction if a document unexpectedly
// exists — a second, structural layer beyond the explicit getAll+exists check above), and
// atomically terminalizes the parent's queue visibility in the same write.
function commitFanoutOutcome(
  transaction: FirebaseFirestore.Transaction,
  parentRef: FirebaseFirestore.DocumentReference,
  outcome: FanoutOutcome,
  uid: string,
  fanoutExecutionId: string,
  childPlans: { installationId: string; targetSnapshot: TargetSnapshot; deliveryPublicId: string; ref: FirebaseFirestore.DocumentReference }[]
): FanoutExecutionResult {
  const validation = validateFanoutTuple(outcome);
  if (!validation.valid) {
    throw new Error(`fanOutReminderDelivery: constructed an invalid fanout tuple (${validation.reason}).`);
  }

  const nowStamp = FieldValue.serverTimestamp();
  for (const plan of childPlans) {
    // `uid` is required by reminderDeliveryLogic.ts's validateDeliverySchema
    // (isValidIdForPath(data.uid)) — every child is stamped with the SAME already-validated
    // parent uid, never re-derived from the (unvalidated-per-child) installation document.
    // CODEX REPAIR ROUND (H1): every child ALSO gets fanoutExecutionIdAtCreation, atomically
    // in this SAME transaction/write batch as the parent's own fanoutExecutionId (written
    // below via `...outcome` on the 'completed' variant) — no child is ever created without
    // its provenance ID matching the parent's, by construction (both derive from the same
    // local `fanoutExecutionId` variable, never re-read or re-generated).
    transaction.create(plan.ref, {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: nowStamp,
      leaseExpiresAt: null,
      uid,
      installationId: plan.installationId,
      deliveryPublicId: plan.deliveryPublicId,
      fanoutExecutionIdAtCreation: fanoutExecutionId,
      processingAttemptCount: 0,
      sendAttemptCount: 0,
      attemptHistory: [],
      targetSnapshot: plan.targetSnapshot,
      createdAt: nowStamp,
      updatedAt: nowStamp,
    });
  }

  transaction.update(parentRef, {
    ...outcome,
    ...buildTerminalWorkStateFields(),
    fannedOutAt: nowStamp,
  });

  return { outcome: 'fanned-out', fanoutOutcome: outcome, createdDeliveryCount: childPlans.length };
}

// ---------------------------------------------------------------------------------------
// DELIVERY WORK QUEUE — collection-group discovery + transactional lease acquisition,
// structural clone of reminderScheduler.ts's discoverRecoverableWork/acquireProcessingLease
// adapted to delivery states via reminderDeliveryLogic.ts's delivery-specific pure helpers.
// NOT transport-capable (never reaches reminderDeliverySender.ts) — remains exported and
// db-parameterized, unchanged from every prior round.
// ---------------------------------------------------------------------------------------

export const DELIVERY_QUEUE_BATCH_SIZE = 50;

// Index note: an equality filter (workState) combined with a range filter + orderBy
// (workAvailableAt) on a different field, plus the document-ID tie-break, requires an
// explicit COLLECTION_GROUP composite index — the exact same shape reminders'
// (workState ASC, workAvailableAt ASC) index already covers for Step 2, mirrored here as a
// collection-group index over every reminders/{reminderId}/deliveries subcollection. See
// firestore.indexes.json.
export async function discoverRecoverableDeliveryWork(
  db: FirebaseFirestore.Firestore
): Promise<FirebaseFirestore.DocumentReference[]> {
  const nowTs = Timestamp.now();
  const snap = await db
    .collectionGroup('deliveries')
    .where('workState', '==', 'queued')
    .where('workAvailableAt', '<=', nowTs)
    .orderBy('workAvailableAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc')
    .limit(DELIVERY_QUEUE_BATCH_SIZE)
    .get();
  return snap.docs.map((d) => d.ref);
}

// processingAttemptCount has no upper-bound domain check inside
// reminderDeliveryLogic.ts's validateDeliverySchema (unlike sendAttemptCount, which is
// capped at MAX_SEND_ATTEMPTS) — only isValidNonNegativeInteger. A schema-valid
// processingAttemptCount could therefore still be Number.MAX_SAFE_INTEGER, which would
// overflow on increment. This guard is this file's own responsibility per the approved
// design's "before increment: ensure increment remains safe" requirement — deliberately
// not a silent `typeof x === 'number' ? x : 0` fallback.
function isSafeToIncrementProcessingAttemptCount(count: number): boolean {
  return Number.isSafeInteger(count) && count >= 0 && Number.isSafeInteger(count + 1);
}

// ---------------------------------------------------------------------------------------
// COMPLETE PERSISTED-DELIVERY VALIDATOR — Codex repair round (H2/section 11, Step 3C-3):
// PROMOTED to reminderDeliveryLogic.ts (validatePersistedDeliveryForProcessing, imported
// above) so it is a SINGLE shared source of truth for both this file's queue acquisition
// AND reminderDeliveryAuth.ts's final authorization — no longer defined locally here. The
// two exports below are thin, backward-compatible aliases for the shared opaque-ID format
// primitives (also now in reminderDeliveryLogic.ts), kept under their original names since
// this file's own test suite and doc comments already reference them.
// ---------------------------------------------------------------------------------------

export const DELIVERY_PUBLIC_ID_LENGTH = OPAQUE_ID_LENGTH;
export const isValidDeliveryPublicIdFormat = isValidOpaqueIdFormat;

export type DeliveryLeaseAcquireResult =
  | {
      outcome: 'acquired';
      uid: string;
      installationId: string;
      targetSnapshot: TargetSnapshot;
      processingAttemptCount: number;
    }
  | { outcome: 'still-leased' }
  | { outcome: 'not-found' }
  | { outcome: 'already-terminal' }
  | { outcome: 'terminal-repaired' }
  | { outcome: 'unknown-state-neutralized' }
  | { outcome: 'quarantined'; reason: string };

// Every candidate returned by discoverRecoverableDeliveryWork is re-read and
// re-validated transactionally here — nothing from the discovery query snapshot is ever
// trusted directly, matching reminderScheduler.ts's acquireProcessingLease precedent.
export async function acquireDeliveryProcessingLease(
  db: FirebaseFirestore.Firestore,
  ref: FirebaseFirestore.DocumentReference
): Promise<DeliveryLeaseAcquireResult> {
  return db.runTransaction(async (transaction): Promise<DeliveryLeaseAcquireResult> => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return { outcome: 'not-found' };
    const data = snap.data()!;
    const state = String(data.state);
    const nowMs = Date.now();

    const schemaCheck = validateDeliverySchema(data);
    const workAvailableAtMs = data.workAvailableAt instanceof Timestamp ? data.workAvailableAt.toMillis() : null;
    const leaseExpiresAtMs = data.leaseExpiresAt instanceof Timestamp ? data.leaseExpiresAt.toMillis() : null;

    const decision = decideDeliveryQueueOutcome(state, data.workState, workAvailableAtMs, leaseExpiresAtMs, schemaCheck, nowMs);

    switch (decision.action) {
      case 'neutralize-unknown-state': {
        // Covers, in one pass, the exact "state = garbage, workState = queued,
        // workAvailableAt = past" queue-poisoning case: the discovery query would have
        // returned this candidate, and this branch removes it from queue eligibility
        // immediately rather than returning it unchanged.
        transaction.update(ref, { ...buildUnknownDeliveryStateNeutralizationUpdate(state), quarantinedAt: FieldValue.serverTimestamp() });
        return { outcome: 'unknown-state-neutralized' };
      }

      case 'already-terminal-correct':
        return { outcome: 'already-terminal' };

      case 'repair-terminal-queue-state': {
        // decideDeliveryQueueOutcome routes BOTH a corrupted `sending` tuple (queue
        // visibility repair only — `state` left untouched, never terminalized to
        // unknown-outcome, never retried here) AND any other terminal business state
        // found incorrectly queue-visible through this SAME path — only the queue
        // fields are rewritten in either case.
        transaction.update(ref, {
          ...buildDeliveryTerminalWorkStateFields(),
          queueIntegrityRepairedAt: FieldValue.serverTimestamp(),
          queueIntegrityRepairReason: 'terminal-status-with-queued-tuple',
        });
        return { outcome: 'terminal-repaired' };
      }

      case 'quarantine-known-corruption':
        transaction.update(ref, { ...buildDeliveryQuarantineUpdate(decision.reason), quarantinedAt: FieldValue.serverTimestamp() });
        return { outcome: 'quarantined', reason: decision.reason };

      case 'still-leased':
        return { outcome: 'still-leased' };

      case 'acquire': {
        if (!schemaCheck.valid) {
          // Unreachable in practice (decideDeliveryQueueOutcome already checked
          // schemaCheck.valid before returning 'acquire'); kept only so TypeScript can
          // narrow schemaCheck's fields below without a non-null assertion.
          throw new Error('acquireDeliveryProcessingLease: unreachable - acquire decided with invalid schema');
        }

        // Codex repair round (M1): the generic queue decision above proves only the CORE
        // schema and work tuple are consistent — it does NOT prove this delivery is
        // trustworthy enough to actually acquire (or recover a preparing lease on). A
        // queued/preparing delivery must ALSO pass the complete persisted-delivery
        // validator (document identity, public-ID format, attempt-history integrity,
        // target-snapshot grammar) first. This applies identically to a FRESH acquisition
        // (state === 'queued') and a preparing-lease RECOVERY (state === 'preparing') —
        // both reach this same branch, so recovery gets the same protection without
        // separate code (Codex item 10). A delivery that fails this check is quarantined
        // here, even though the generic queue decision alone would have permitted
        // acquisition.
        const completeValidation = validatePersistedDeliveryForProcessing(ref.id, data);
        if (!completeValidation.valid) {
          transaction.update(ref, {
            ...buildDeliveryQuarantineUpdate(completeValidation.reason),
            quarantinedAt: FieldValue.serverTimestamp(),
          });
          return { outcome: 'quarantined', reason: completeValidation.reason };
        }

        if (!isSafeToIncrementProcessingAttemptCount(completeValidation.processingAttemptCount)) {
          transaction.update(ref, {
            ...buildDeliveryQuarantineUpdate('processing-attempt-count-exhausted'),
            quarantinedAt: FieldValue.serverTimestamp(),
          });
          return { outcome: 'quarantined', reason: 'processing-attempt-count-exhausted' };
        }

        const nextProcessingAttemptCount = completeValidation.processingAttemptCount + 1;
        const newLeaseExpiresAtMs = computeDeliveryLeaseExpiresAtMs(nowMs);
        const isFreshAcquisition = state === 'queued';

        if (isFreshAcquisition) {
          // Genuine delivery-state transition: queued -> preparing, validated against
          // reminderDeliveryLogic.ts's ALLOWED_DELIVERY_TRANSITIONS table.
          requireAllowedDeliveryTransition('queued', 'preparing');
        }
        // 'preparing' -> 'preparing' lease RECOVERY is deliberately NOT passed through
        // requireAllowedDeliveryTransition: reminderDeliveryLogic.ts's frozen,
        // Step-3C-1-approved ALLOWED_DELIVERY_TRANSITIONS table has no 'preparing'
        // self-loop (unlike reminderSchedulerLogic.ts's 'processing' entry, which does).
        // Since `state` does not change value on recovery, this is correctly a
        // work-tuple-only mutation (workAvailableAt/leaseExpiresAt/processingAttemptCount),
        // not a delivery-state transition — the generic transition guard is not
        // applicable here and would incorrectly throw if consulted.
        transaction.update(ref, {
          state: 'preparing',
          workState: 'queued',
          processingAttemptCount: nextProcessingAttemptCount,
          leaseExpiresAt: Timestamp.fromMillis(newLeaseExpiresAtMs),
          workAvailableAt: Timestamp.fromMillis(newLeaseExpiresAtMs),
          ...(isFreshAcquisition ? { processingStartedAt: FieldValue.serverTimestamp() } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });

        return {
          outcome: 'acquired',
          uid: completeValidation.uid,
          installationId: completeValidation.installationId,
          targetSnapshot: completeValidation.targetSnapshot,
          processingAttemptCount: nextProcessingAttemptCount,
        };
      }
    }
  });
}

// ---------------------------------------------------------------------------------------
// PRIVATE PRODUCTION AUTHORITY — module-scope, NOT exported. No property on this module's
// compiled exports object can ever be assigned to redirect what this returns; the only way
// to change its behavior is to edit this file's own source. Matches
// reminderDeliverySender.ts's own identical private resolver. Uses ONLY the captured
// bindings above.
// ---------------------------------------------------------------------------------------

let cachedWorkerDb: FirebaseFirestore.Firestore | null = null;

function getProductionWorkerDb(): FirebaseFirestore.Firestore {
  if (cachedWorkerDb === null) {
    if (capturedGetApps().length === 0) capturedInitializeApp();
    cachedWorkerDb = capturedGetFirestore();
  }
  return cachedWorkerDb;
}

// ---------------------------------------------------------------------------------------
// TRANSPORT-CAPABLE BATCH ORCHESTRATION — the wrappers below accept ONLY inert values (a
// DocumentReference sourced from this file's own trusted discovery / no parameters at all,
// respectively) and privately compose the real db (from getProductionWorkerDb() above) with
// the real reminderDeliverySender.ts processControlledSendCandidate. Neither accepts a
// Firestore instance, an AccessTokenProvider, or a sendCandidate implementation from its
// own caller.
// ---------------------------------------------------------------------------------------

export type ProcessDeliveryCandidateResult = {
  acquisition: DeliveryLeaseAcquireResult;
  outcome?: SanitizedSendOrchestrationResult;
};

export async function processDeliveryQueueCandidate(ref: FirebaseFirestore.DocumentReference): Promise<ProcessDeliveryCandidateResult> {
  const db = getProductionWorkerDb();
  const acquisition = await acquireDeliveryProcessingLease(db, ref);
  if (acquisition.outcome !== 'acquired') {
    // still-leased / not-found / already-terminal / terminal-repaired /
    // unknown-state-neutralized / quarantined all end here — nothing further to do for
    // this candidate this pass.
    return { acquisition };
  }
  // The ONLY call site, anywhere in this file, that reaches reminderDeliverySender.ts —
  // this single call performs OAuth preparation, the fresh final-authorization
  // transaction, and (only if that transaction itself authorized it) the one transport
  // attempt, entirely internally, using ITS OWN immutably-captured authority. This file
  // never sees a capability, a raw token, or any authorization-relevant secret at any
  // point. Only the ref's own path-derived identity (never the ref object, never a db)
  // crosses this call.
  const outcome = await capturedProcessControlledSendCandidate(ref.parent.parent?.id, ref.id, acquisition.processingAttemptCount);
  return { acquisition, outcome };
}

export const DELIVERY_PROCESSING_CONCURRENCY = 10;

export type DeliveryWorkerBatchSummary = {
  candidateCount: number;
  stillLeasedCount: number;
  notFoundCount: number;
  alreadyTerminalCount: number;
  terminalRepairedCount: number;
  unknownStateNeutralizedCount: number;
  quarantinedCount: number;
  oauthPreparationFailedCount: number;
  dryRunValidatedCount: number;
  cancelledCount: number;
  staleFenceCount: number;
  deliveryNotFoundCount: number;
  sendAcceptedCount: number;
  sendRejectedFinalCount: number;
  sendUnknownOutcomeCount: number;
  sendRequeuedForRetryCount: number;
  sendOutcomeFenceMismatchCount: number;
  sendPersistenceFailedCount: number;
  unexpectedFailureCount: number;
};

function emptyDeliveryWorkerBatchSummary(): Omit<DeliveryWorkerBatchSummary, 'candidateCount'> {
  return {
    stillLeasedCount: 0,
    notFoundCount: 0,
    alreadyTerminalCount: 0,
    terminalRepairedCount: 0,
    unknownStateNeutralizedCount: 0,
    quarantinedCount: 0,
    oauthPreparationFailedCount: 0,
    dryRunValidatedCount: 0,
    cancelledCount: 0,
    staleFenceCount: 0,
    deliveryNotFoundCount: 0,
    sendAcceptedCount: 0,
    sendRejectedFinalCount: 0,
    sendUnknownOutcomeCount: 0,
    sendRequeuedForRetryCount: 0,
    sendOutcomeFenceMismatchCount: 0,
    sendPersistenceFailedCount: 0,
    unexpectedFailureCount: 0,
  };
}

// Discovers due delivery work and drives each candidate through acquisition + OAuth
// preparation + final authorization, with the SAME bounded-concurrency worker pool Step 2
// already uses (reminderSchedulerLogic.ts's processWithBoundedConcurrency, reused rather
// than reinvented). Takes ZERO parameters — nothing for a caller to inject.
export async function runDeliveryWorkerBatch(): Promise<DeliveryWorkerBatchSummary> {
  const db = getProductionWorkerDb();
  const candidateRefs = await discoverRecoverableDeliveryWork(db);
  const counters = emptyDeliveryWorkerBatchSummary();

  await processWithBoundedConcurrency(candidateRefs, DELIVERY_PROCESSING_CONCURRENCY, async (ref) => {
    try {
      const result = await processDeliveryQueueCandidate(ref);
      switch (result.acquisition.outcome) {
        case 'still-leased':
          counters.stillLeasedCount++;
          return;
        case 'not-found':
          counters.notFoundCount++;
          return;
        case 'already-terminal':
          counters.alreadyTerminalCount++;
          return;
        case 'terminal-repaired':
          counters.terminalRepairedCount++;
          return;
        case 'unknown-state-neutralized':
          counters.unknownStateNeutralizedCount++;
          return;
        case 'quarantined':
          counters.quarantinedCount++;
          return;
        case 'acquired':
          break; // fall through to finalization tally below.
      }
      // A single switch, since processControlledSendCandidate already returns ONE
      // unified SanitizedSendOrchestrationResult covering both the dry-run/cancellation
      // outcomes and the real-send outcomes.
      switch (result.outcome?.outcome) {
        case 'oauth-preparation-failed':
          counters.oauthPreparationFailedCount++;
          return;
        case 'dry-run-validated':
          counters.dryRunValidatedCount++;
          return;
        case 'cancelled':
          counters.cancelledCount++;
          return;
        case 'stale-fence':
          counters.staleFenceCount++;
          return;
        case 'delivery-not-found':
          counters.deliveryNotFoundCount++;
          return;
        case 'invalid-delivery':
          // finalizeDeliveryAuthorization's own invalid-delivery outcome (schema
          // corruption discovered at final-authorization time, including the
          // 'send-attempt-count-exhausted' defensive branch).
          counters.unexpectedFailureCount++;
          return;
        case 'terminalized':
          if (result.outcome.state === 'accepted-by-fcm') counters.sendAcceptedCount++;
          else if (result.outcome.state === 'rejected-final') counters.sendRejectedFinalCount++;
          else counters.sendUnknownOutcomeCount++;
          return;
        case 'requeued-for-retry':
          counters.sendRequeuedForRetryCount++;
          return;
        case 'outcome-fence-mismatch':
          counters.sendOutcomeFenceMismatchCount++;
          return;
        case 'persistence-failed':
          counters.sendPersistenceFailedCount++;
          return;
        default:
          counters.unexpectedFailureCount++;
      }
    } catch {
      // Deliberately binds no parameter — matches this codebase's established convention
      // of never reading a property off a caught exception where the underlying operation
      // could plausibly involve credential-adjacent state (OAuth acquisition, in this
      // batch loop's case).
      counters.unexpectedFailureCount++;
    }
  });

  return { candidateCount: candidateRefs.length, ...counters };
}

// ---------------------------------------------------------------------------------------
// SCHEDULED ENTRY POINT — the first (and, this round, only) way anything in this file can
// run in production. Takes ZERO parameters — there is nothing here for any caller to
// inject, since this exported value is a registered Cloud Function (invoked only by the
// Cloud Functions runtime via its own event plumbing, never by a normal same-process
// function call with attacker-chosen arguments) whose handler body calls the now fully
// trusted-internal runDeliveryWorkerBatch().
//
// Whether a real send is EVER actually authorized for a given candidate depends entirely on
// processControlledSendCandidate's own fresh authorization (both independent
// REAL_DELIVERY_STAGE constants, and the production rollout document's actual
// mode/allowlist) — not on anything this scheduled entry point decides. Today the deployed
// production rollout document remains `{mode:"paused"}`, so 'dry-run-validated' is still the
// only outcome any real invocation reaches — but that is a rollout-configuration fact, not a
// structural one enforced by this file.
//
// CODEX FUNCTION-IDENTITY REPAIR (M1) — this export was previously named
// notificationReminderDeliveryDryRun. Once this source is deployed and later armed via a
// separate rollout mutation, this SAME function can perform real allowlisted sends — a name
// containing "DryRun" would then be operationally false. Renamed to
// notificationReminderDeliveryWorker, an accurate, durable name that does not claim a
// behavior this function no longer structurally guarantees. runDeliveryDryRunBatch/
// DeliveryDryRunBatchSummary were likewise renamed to runDeliveryWorkerBatch/
// DeliveryWorkerBatchSummary — genuinely dry-run-SPECIFIC names (dryRunValidatedCount, the
// 'dry-run-validated' outcome itself, etc.) are UNCHANGED, since those name a real, still-
// existing state distinct from an actual send, not the batch-level operation as a whole. See
// the accompanying migration analysis (Codex report, this round) for why the Cloud Function
// rename is NOT deployed this turn.
// ---------------------------------------------------------------------------------------
export const notificationReminderDeliveryWorker = onSchedule({ schedule: 'every 5 minutes', timeoutSeconds: 300, memory: '256MiB', serviceAccount: 'notification-delivery-worker@neuroactive.iam.gserviceaccount.com' }, async () => {
  const summary = await runDeliveryWorkerBatch();
  logger.info('[ReminderDeliveryWorker] delivery worker batch summary', summary);
});

// Exposed for tests only (per the approved design's "3C-2 itself may expose helper
// functions for fenced no-op/test finalization if needed, but do NOT invent send
// semantics yet") — NOT used by any function above. Kept minimal: exported path helpers so
// the test suite can construct real (fake-db-backed) DocumentReferences the exact same way
// production code would, without duplicating the path convention.
export const __test__ = { remindersCollection, reminderRef, deliveriesCollection, deliveryRef, pushInstallationsCollection, APP_ID };
