// functions/src/reminderDeliveryWorker.ts
// Phase 3A-3 Step 3C-2 — Firestore orchestration for reminder-delivery fanout and the
// delivery work queue. Wires the pure, Codex-approved decision functions in
// reminderDeliveryLogic.ts to real Firestore reads/writes.
//
// ***** NOT WIRED TO PRODUCTION *****
// Nothing in this file is exported from functions/src/index.ts, nothing here is an
// onSchedule/onCall/onDocumentWritten Cloud Function, and functions/src/reminderScheduler.ts
// is UNCHANGED this round — its live dry-run-complete terminalization is untouched. Every
// function below is a plain, exported, testable orchestration primitive, callable only from
// this file's own test suite today and from a future, separately-authorized Step 3C-3
// orchestration layer. This file is structurally incapable of running in production this
// round: there is no trigger anywhere in this codebase that invokes it.
//
// ***** NO SENDER *****
// This file contains no reference to fcmTransport.ts, sendFcmOnce, getMessaging,
// 'firebase-admin/messaging', 'node:https', fetch, google-auth-library, or any OAuth token
// acquisition. It never writes a delivery to 'sending', never authorizes a real send, and
// never writes 'dry-run-validated' (that state means complete final authorization passed —
// Step 3C-3's job, not this file's). This file ends at: fanout, the delivery work queue,
// preparing-lease acquisition/recovery, and malformed/corrupt queue neutralization.
//
// DEPENDENCY INJECTION, NOT MODULE-SCOPE db — every exported function below takes an
// explicit `db: FirebaseFirestore.Firestore` parameter rather than closing over a
// module-level `getFirestore()` singleton (the convention used by reminderScheduler.ts and
// pushInstallations.ts). Those files are exercised only by Codex review and production
// traffic, never by a repository-local unit test. This file's task explicitly requires
// "PURE-adjacent tests with injected/mocked transaction/document behavior" — that is only
// possible if the Firestore handle is a parameter, not a captured singleton — so this file
// deliberately departs from the module-scope-db convention. Because nothing here is wired to
// a Cloud Function this round, there is no production call site that would need a
// module-scope default anyway.
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
import { randomBytes } from 'node:crypto';
import { FieldPath, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { buildTerminalWorkStateFields, isValidAttemptCount, requireAllowedTransition } from './reminderSchedulerLogic';
import {
  isValidIdForPath,
  isValidReminderId,
  isValidInstallationIdShape,
  isTerminalDeliveryState,
  requireAllowedDeliveryTransition,
  computeDeliveryLeaseExpiresAtMs,
  decideDeliveryQueueOutcome,
  buildDeliveryTerminalWorkStateFields,
  buildDeliveryQuarantineUpdate,
  buildUnknownDeliveryStateNeutralizationUpdate,
  validateDeliverySchema,
  validateAttemptHistory,
  decideFanoutOutcome,
  buildPreExistingChildCorruptionOutcome,
  validateFanoutTuple,
  deriveDeliveryPublicId,
  FANOUT_NONCE_BYTE_LENGTH,
  FANOUT_QUERY_LIMIT,
  type TargetSnapshot,
  type FanoutOutcome,
} from './reminderDeliveryLogic';
import {
  classifyEpochSchemaMarker,
  readFieldPresence,
  isValidTokenVersion,
  isValidAudienceId,
} from './pushInstallationEpochLogic';

const APP_ID = 'neuroactive-prod';

// Retained only to document that isTerminalDeliveryState is deliberately NOT what governs
// queue-repair branching in this file (see decideDeliveryQueueOutcome's own comment on why
// 'sending' — not a terminal delivery state — must still be routed through the terminal
// queue-repair path). Referencing it here keeps the import intentional rather than dead.
void isTerminalDeliveryState;

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
  const fanoutNonce = randomBytes(FANOUT_NONCE_BYTE_LENGTH);
  return fanOutReminderDeliveryWithNonce(db, reminderId, expectedAttemptCount, fanoutNonce);
}

// Module-private (no `export`): the actual fanout transaction. Its ONLY caller, anywhere,
// is fanOutReminderDelivery immediately above — no other function in this file or any other
// file may reach it, and no exported symbol accepts a fanoutNonce parameter (Codex FINAL
// repair round: the prior test-only exported wrapper was removed for exactly this reason).
function fanOutReminderDeliveryWithNonce(
  db: FirebaseFirestore.Firestore,
  reminderId: string,
  expectedAttemptCount: number,
  fanoutNonce: Buffer
): Promise<FanoutExecutionResult> {
  if (!Buffer.isBuffer(fanoutNonce) || fanoutNonce.byteLength !== FANOUT_NONCE_BYTE_LENGTH) {
    throw new Error(`fanOutReminderDelivery: fanoutNonce must be a Buffer of exactly ${FANOUT_NONCE_BYTE_LENGTH} bytes.`);
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
      const outcome = decideFanoutOutcome(rawActiveCount, 0);
      return commitFanoutOutcome(transaction, parentRef, outcome, uid, []);
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
      return commitFanoutOutcome(transaction, parentRef, outcome, uid, []);
    }

    const outcome = decideFanoutOutcome(rawActiveCount, excludedMalformedCount);
    return commitFanoutOutcome(transaction, parentRef, outcome, uid, childPlans);
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
    transaction.create(plan.ref, {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: nowStamp,
      leaseExpiresAt: null,
      uid,
      installationId: plan.installationId,
      deliveryPublicId: plan.deliveryPublicId,
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
// COMPLETE PERSISTED-DELIVERY VALIDATOR — Codex repair round, M1. validateDeliverySchema
// (reminderDeliveryLogic.ts, frozen) proves only the CORE fields are well-typed; it does
// NOT prove the document is trustworthy enough to actually acquire a lease on. A
// queued/preparing delivery must ALSO pass every check below before this file will commit
// an acquisition or a preparing-lease recovery. A `sending` or other terminal-business-state
// delivery found queue-corrupted is NEVER routed through this validator (see
// acquireDeliveryProcessingLease's 'repair-terminal-queue-state' branch) — its business
// state must be preserved regardless of whatever else is malformed on the document.
// ---------------------------------------------------------------------------------------

// The exact, actual output shape of deriveDeliveryPublicId (reminderDeliveryLogic.ts):
// createHmac('sha256', nonce).update(encoded).digest('base64url') — a 32-byte (256-bit)
// digest, base64url-encoded WITHOUT padding: ceil(256 / 6) = 43 characters, alphabet
// [A-Za-z0-9_-] only (no '=', no '/', no whitespace by construction of that alphabet).
// Verified directly (not guessed): Buffer.from(32 random bytes).toString('base64url') is
// always exactly 43 characters, never 44 (that would require padding, which base64url-
// without-padding never emits for a length not already a multiple of 3 bytes). This file
// never recomputes the HMAC (fanoutNonce is intentionally never persisted) — it only
// validates that a PERSISTED value has the shape deriveDeliveryPublicId could have produced.
export const DELIVERY_PUBLIC_ID_LENGTH = 43;
const DELIVERY_PUBLIC_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidDeliveryPublicIdFormat(value: unknown): value is string {
  return typeof value === 'string' && DELIVERY_PUBLIC_ID_PATTERN.test(value);
}

export type PersistedDeliveryValidation =
  | { valid: true; uid: string; installationId: string; targetSnapshot: TargetSnapshot; processingAttemptCount: number }
  | { valid: false; reason: string };

// `refId` is the delivery document's OWN id (installationId-by-construction per this file's
// deterministic child-path convention) — passed in by the caller from `ref.id`, never
// re-derived. Every failure reason below is a FIXED internal enum string; none of them ever
// embed a raw field value, matching this file's existing quarantine-reason convention.
function validatePersistedDeliveryForProcessing(refId: unknown, data: Record<string, unknown>): PersistedDeliveryValidation {
  const schemaCheck = validateDeliverySchema(data);
  if (!schemaCheck.valid) return { valid: false, reason: schemaCheck.reason };

  // DOCUMENT IDENTITY: both the document's own id and the stored installationId field must
  // independently satisfy the ACTUAL installationId grammar (UUID v4 / 32-hex — the same
  // strict check deriveDeliveryPublicId itself requires), and must be exactly equal. This
  // closes the ref.id-vs-stored-installationId substitution attack: a document whose path
  // says installation A but whose own installationId field claims installation B must never
  // be trusted as either.
  if (!isValidInstallationIdShape(refId)) return { valid: false, reason: 'invalid-ref-installation-id-shape' };
  if (!isValidInstallationIdShape(schemaCheck.installationId)) return { valid: false, reason: 'invalid-stored-installation-id-shape' };
  if (refId !== schemaCheck.installationId) return { valid: false, reason: 'ref-installation-id-mismatch' };

  // DELIVERY PUBLIC ID: structural format only — never recomputed (the nonce that produced
  // it is intentionally never persisted anywhere).
  if (!isValidDeliveryPublicIdFormat(data.deliveryPublicId)) {
    return { valid: false, reason: 'invalid-delivery-public-id-format' };
  }

  // ATTEMPT HISTORY: reuses reminderDeliveryLogic.ts's own validateAttemptHistory —
  // bounded length, strictly sequential attemptNumber, fixed-enum outcomeCategory only, and
  // (per that file's own hardening) rejects any entry carrying an unexpected own property —
  // closing exactly the "secret-bearing history entry" attack this round calls out.
  const historyValidation = validateAttemptHistory(data.attemptHistory);
  if (!historyValidation.valid) return { valid: false, reason: 'invalid-attempt-history' };

  // TARGET SNAPSHOT: validateDeliverySchema's own (frozen, internal) target-snapshot check
  // only requires installationAudienceId to be a nonempty string — NOT the actual
  // production audience-ID grammar. Re-validated here against the real grammar
  // (pushInstallationEpochLogic.ts's AUDIENCE_ID_PATTERN, via its exported isValidAudienceId
  // — reused, not reinvented) and tokenVersion re-confirmed against its real validator too.
  if (!isValidAudienceId(schemaCheck.targetSnapshot.installationAudienceId)) {
    return { valid: false, reason: 'invalid-target-snapshot-audience-id' };
  }
  if (!isValidTokenVersion(schemaCheck.targetSnapshot.tokenVersion)) {
    return { valid: false, reason: 'invalid-target-snapshot-token-version' };
  }

  // UID and COUNTS (processingAttemptCount nonnegative safe integer; sendAttemptCount
  // bounded by MAX_SEND_ATTEMPTS) are already fully covered by validateDeliverySchema above
  // — no separate re-check needed here.

  return {
    valid: true,
    uid: schemaCheck.uid,
    installationId: schemaCheck.installationId,
    targetSnapshot: schemaCheck.targetSnapshot,
    processingAttemptCount: schemaCheck.processingAttemptCount,
  };
}

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

// Exposed for tests only (per the approved design's "3C-2 itself may expose helper
// functions for fenced no-op/test finalization if needed, but do NOT invent send
// semantics yet") — NOT used by any function above. Kept minimal: exported path helpers so
// the test suite can construct real (fake-db-backed) DocumentReferences the exact same way
// production code would, without duplicating the path convention.
export const __test__ = { remindersCollection, reminderRef, deliveriesCollection, deliveryRef, pushInstallationsCollection, APP_ID };
