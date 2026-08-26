// functions/src/reminderDeliverySender.ts
// PHASE 3A-3 STEP 3C-5 — CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR (SIXTH round,
// SECOND pass) — SINGLE-FILE PRODUCTION MODULE. There is no longer a separate
// "reminderDeliverySenderCore.ts" at all.
//
// WHY THE PRIOR (SEPARATE-CORE-FILE) DESIGN WAS ABANDONED: the FIFTH round's
// reminderDeliverySenderCore.ts held the full authorization -> send -> outcome-persistence
// algorithm as an EXPORTED, parameterized function (accepting db/accessTokenProvider/
// transport), on the theory that excluding that file from the PRODUCTION tsconfig would
// keep it out of the deployed artifact while this file's thin wrapper still called it. That
// theory does not survive contact with how `tsc` actually works: a file excluded from
// `include`/`exclude` that is nonetheless *imported* by an included file is pulled back into
// the compiled program and EMITTED anyway — `tsc` has no notion of "type-check and resolve
// this import, but don't emit its target," short of a full bundler/tree-shaking step (a much
// larger, explicitly out-of-scope change). Verified empirically this round: excluding
// `src/testsupport/**` still produced `lib/testsupport/reminderDeliverySenderCore.js` in the
// production build, because reminderDeliverySender.ts's own `import` of it forced inclusion.
// Since the deployed artifact MUST contain a working implementation for the feature to
// function at all, "absent from the deployed artifact" and "invoked by the deployed
// wrapper via a static import" are mutually exclusive for the SAME parameterized function —
// there is no configuration that achieves both simultaneously.
//
// THE ACTUAL FIX: the entire algorithm now lives HERE, as MODULE-PRIVATE functions (no
// `export` keyword) — exactly like `executeControlledSend`/`commitSendOutcome` already were
// in every prior round — so it IS part of the deployed artifact (it has to be) but is NOT a
// separately `require()`-able, parameterized entry point. The only exported production
// entry point, `processControlledSendCandidate`, accepts exclusively
// reminderId/installationId/expectedProcessingAttemptCount and resolves ALL authority
// (Firestore, OAuth, transport) from PRIVATE, IMMUTABLY-CAPTURED module state (see below) —
// there is no db/provider/transport parameter anywhere for a caller to substitute, and
// there is no separate file for a caller to import instead to bypass this wrapper.
//
// HOW TESTS STILL EXERCISE THIS EXACT CODE (not a reimplementation): see
// reminderDeliverySender.test.ts's own header. In short — Node's `require()` cache means a
// module's top-level code (including the IMMUTABLE CAPTURE block below) runs exactly once
// per resolved module id, the FIRST time it is required in a process. Tests exploit this
// deliberately and legitimately: BEFORE first requiring this file, a test mutates
// `firebase-admin/app`'s/`firebase-admin/firestore`'s/`./reminderDeliveryAuth`'s/
// `./fcmTransport`'s own exported properties to fakes, then clears
// `require.cache[require.resolve('./reminderDeliverySender')]` (forcing the NEXT require to
// re-evaluate this module from scratch against whatever the dependencies currently export)
// and requires it fresh — capturing the FAKES instead of the real implementations for that
// one fresh module instance. This is squarely inside the threat model this repair actually
// defends against: Codex's own instruction (section 9, this round) explicitly distinguishes
// "an ordinary future production import/caller" (defended against, by the capture below)
// from "arbitrary code execution/mutation BEFORE the production module is first loaded"
// (explicitly out of scope — "not our intended threat model"). A test file orchestrating its
// OWN process's require order before ever exercising the module is precisely that carved-out
// case, not a future ordinary caller.
//
// IMMUTABLE CAPTURE (H3/H4): getApps/initializeApp/getFirestore/
// createGoogleAuthAccessTokenProvider/sendFcmOnce are captured into plain top-level `const`
// bindings ONCE, the first time this module is evaluated. The standard `tsc`-compiled shape
// for a named import used as a function call (`someModule_1.someFn()`) is a property lookup
// on a SHARED, mutable object at EVERY call site, not a captured value — without this
// capture, any other file that mutated one of those four modules' exported properties AFTER
// this module had already loaded (but before a given call) could redirect what this file's
// private getters return. Once captured into a local `const`, a later mutation of the
// source module's property cannot affect the local binding — this is bedrock JavaScript
// closure/binding semantics, not a heuristic.
'use strict';

import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { sendFcmOnce, type FcmSendOutcome } from './fcmTransport';
import {
  requireAllowedDeliveryTransition,
  requireAuthorizedRetryTransition,
  decideSendOutcomeAction,
  appendAttemptHistoryEntry,
  computeDeliveryRetryAvailableAtMs,
  isMatchingActiveSendIntent,
  buildDeliveryTerminalWorkStateFields,
  isValidReminderId,
  isValidInstallationIdShape,
  type DeliverySendOutcomeKind,
  type AttemptOutcomeCategory,
  type RealDeliveryStage,
} from './reminderDeliveryLogic';
import {
  prepareAndFinalizeDelivery,
  createGoogleAuthAccessTokenProvider,
  type DeliverySendCapability,
  type AccessTokenProvider,
  type PrepareAndFinalizeResult,
  type FinalAuthorizationReason,
} from './reminderDeliveryAuth';

// ---------------------------------------------------------------------------------------
// IMMUTABLE CAPTURE — see file header (H3/H4). Nothing below this block ever reads
// getApps/initializeApp/getFirestore/createGoogleAuthAccessTokenProvider/sendFcmOnce
// through the imported module namespace again — only through these captured bindings.
// ---------------------------------------------------------------------------------------
const capturedGetApps = getApps;
const capturedInitializeApp = initializeApp;
const capturedGetFirestore = getFirestore;
const capturedCreateGoogleAuthAccessTokenProvider = createGoogleAuthAccessTokenProvider;
const capturedSendFcmOnce = sendFcmOnce;

// See file header — this is a structural phase lock, not a rollout-config-driven decision.
// PHASE 3A-3 STEP 3C-5 — 'allowlisted-only'. Must not advance to 'general' without a
// separately reviewed round.
export const REAL_DELIVERY_STAGE: RealDeliveryStage = 'allowlisted-only';

// The Firestore artifacts path prefix for this single-project deployment.
const DELIVERY_APP_ID = 'neuroactive-prod';

// ---------------------------------------------------------------------------------------
// FIXED FIRST-SEND MESSAGE SCHEMA — pure, directly unit-testable, no Firestore/network
// access. Deliberately fixed, server-authored content: no arbitrary user-controlled keys,
// no health/progress information, and no UID, reminder ID, audience ID, token, provenance
// ID, execution ID, or other internal identifier anywhere in visible text. The only
// variable input is the current, already-validated installation token.
//
// COMPATIBILITY — inspected directly against the actual deployed service worker
// (public/firebase-messaging-sw.js): its onBackgroundMessage handler explicitly skips
// manual display whenever `payload.notification` is present, and its notificationclick
// handler always focuses/opens the app root ('/'), never reading any custom data field
// from the payload. Including a `notification` object (title/body) is therefore both
// necessary and sufficient. Deliberately does NOT include a custom deep-link field.
// ---------------------------------------------------------------------------------------
const FIRST_SEND_NOTIFICATION_TITLE = 'NeuroActive';
const FIRST_SEND_NOTIFICATION_BODY = 'You have a session reminder.';

export function buildFirstSendNotificationMessage(installationToken: unknown): Record<string, unknown> {
  if (typeof installationToken !== 'string' || installationToken.length === 0) {
    throw new Error('reminderDeliverySender: installationToken must be a nonempty string.');
  }
  return {
    token: installationToken,
    notification: {
      title: FIRST_SEND_NOTIFICATION_TITLE,
      body: FIRST_SEND_NOTIFICATION_BODY,
    },
  };
}

// ---------------------------------------------------------------------------------------
// FcmSendOutcome -> DeliverySendOutcomeKind / AttemptOutcomeCategory / httpStatus
// translation. Pure, directly testable, zero network/Firestore access.
// ---------------------------------------------------------------------------------------

export function translateFcmOutcomeToDeliveryOutcome(sendOutcome: FcmSendOutcome): DeliverySendOutcomeKind {
  if (sendOutcome.kind === 'accepted') return { kind: 'accepted' };
  if (sendOutcome.kind === 'rejected') return { kind: 'rejected', category: sendOutcome.category };
  if (sendOutcome.kind === 'unknown-outcome') return { kind: 'unknown-outcome' };
  return { kind: 'request-not-attempted' };
}

export function classifyAttemptOutcomeCategory(sendOutcome: FcmSendOutcome): AttemptOutcomeCategory {
  if (sendOutcome.kind === 'accepted') return 'accepted';
  if (sendOutcome.kind === 'rejected') return sendOutcome.category;
  return 'unknown-outcome';
}

export function extractAttemptHttpStatus(sendOutcome: FcmSendOutcome): number | null {
  if (sendOutcome.kind === 'accepted') return sendOutcome.httpStatus;
  if (sendOutcome.kind === 'rejected') return sendOutcome.httpStatus;
  return null;
}

// ---------------------------------------------------------------------------------------
// PRIVATE PRODUCTION AUTHORITY — module-scope, NOT exported. Uses ONLY the captured
// bindings above. No property on this module's compiled exports object can ever be
// assigned to redirect what these two functions return.
// ---------------------------------------------------------------------------------------

let cachedDb: FirebaseFirestore.Firestore | null = null;

function getProductionSenderDb(): FirebaseFirestore.Firestore {
  if (cachedDb === null) {
    if (capturedGetApps().length === 0) capturedInitializeApp();
    cachedDb = capturedGetFirestore();
  }
  return cachedDb;
}

let cachedAccessTokenProvider: AccessTokenProvider | null = null;

function getProductionSenderAccessTokenProvider(): AccessTokenProvider {
  if (cachedAccessTokenProvider === null) {
    cachedAccessTokenProvider = capturedCreateGoogleAuthAccessTokenProvider();
  }
  return cachedAccessTokenProvider;
}

// ---------------------------------------------------------------------------------------
// POST-SEND FENCED OUTCOME COMMIT — MODULE-PRIVATE. The ONLY value that may ever reach
// this function as `sendOutcome` is the actual return value of the immediately preceding
// `capturedSendFcmOnce` call inside executeControlledSend, below — never a caller-selected
// literal. Reachable ONLY through executeControlledSend, itself reachable ONLY through
// processControlledSendCandidate.
// ---------------------------------------------------------------------------------------

export type SendOutcomeCommitResult =
  | { outcome: 'terminalized'; state: 'accepted-by-fcm' | 'rejected-final' | 'unknown-outcome' }
  | { outcome: 'requeued-for-retry' }
  | { outcome: 'outcome-fence-mismatch' }
  | { outcome: 'persistence-failed'; reason: string };

async function commitSendOutcome(
  db: FirebaseFirestore.Firestore,
  capability: DeliverySendCapability,
  sendOutcome: FcmSendOutcome
): Promise<SendOutcomeCommitResult> {
  const deliveryOutcome = translateFcmOutcomeToDeliveryOutcome(sendOutcome);
  const outcomeCategory = classifyAttemptOutcomeCategory(sendOutcome);
  const httpStatus = extractAttemptHttpStatus(sendOutcome);
  const decision = decideSendOutcomeAction(deliveryOutcome, capability.sendAttemptCount);

  return db.runTransaction(async (transaction): Promise<SendOutcomeCommitResult> => {
    const snap = await transaction.get(capability.deliveryRef);
    if (!snap.exists) return { outcome: 'outcome-fence-mismatch' };
    const data = snap.data()!;
    if (!isMatchingActiveSendIntent(data, capability.sendAttemptCount, capability.sendExecutionId, capability.sendIntentAtMs)) {
      return { outcome: 'outcome-fence-mismatch' };
    }
    const persistedSendIntentAtMs = data.sendIntentAtMs as number;

    const appendedHistory = appendAttemptHistoryEntry(data.attemptHistory, {
      sendIntentAt: persistedSendIntentAtMs,
      outcomeCategory,
      httpStatus,
      outcomeRecordedAt: Date.now(),
    });
    if (appendedHistory === null) {
      return { outcome: 'persistence-failed', reason: 'invalid-attempt-history-on-outcome' };
    }

    if (decision.action === 'terminalize') {
      requireAllowedDeliveryTransition('sending', decision.state);
      transaction.update(capability.deliveryRef, {
        state: decision.state,
        ...buildDeliveryTerminalWorkStateFields(),
        attemptHistory: appendedHistory,
        processedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return { outcome: 'terminalized', state: decision.state };
    }

    requireAuthorizedRetryTransition('sending', deliveryOutcome, capability.sendAttemptCount);
    const workAvailableAtMs = computeDeliveryRetryAvailableAtMs(Date.now());
    transaction.update(capability.deliveryRef, {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(workAvailableAtMs),
      leaseExpiresAt: null,
      sendExecutionId: null,
      sendIntentAtMs: null,
      attemptHistory: appendedHistory,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { outcome: 'requeued-for-retry' };
  });
}

// ---------------------------------------------------------------------------------------
// THE SOLE TRANSPORT CALL SITE — MODULE-PRIVATE. Uses ONLY `capturedSendFcmOnce` — never
// the live `./fcmTransport` module namespace. Its only caller, anywhere, is
// processControlledSendCandidate below, which invokes it with a capability THAT SAME CALL
// just received, synchronously, from a fresh finalizeDeliveryAuthorization transaction.
// ---------------------------------------------------------------------------------------
async function executeControlledSend(db: FirebaseFirestore.Firestore, capability: DeliverySendCapability): Promise<SendOutcomeCommitResult> {
  if (REAL_DELIVERY_STAGE === 'disabled') {
    throw new Error('reminderDeliverySender: REAL_DELIVERY_STAGE must not be "disabled" when executeControlledSend is invoked.');
  }
  const message = buildFirstSendNotificationMessage(capability.installationToken);
  const sendOutcome = await capturedSendFcmOnce({
    projectId: 'neuroactive',
    accessToken: capability.accessToken,
    message,
  });
  return commitSendOutcome(db, capability, sendOutcome);
}

// ---------------------------------------------------------------------------------------
// THE SAFE PUBLIC PRODUCTION ENTRY POINT — the ONLY exported way, anywhere in this
// codebase, to reach the module-private executeControlledSend above.
//
// Accepts EXCLUSIVELY inert identity/fence data: `reminderId`, `installationId` (both
// `unknown`, validated internally), and the caller's own already-obtained processing fence
// (`expectedProcessingAttemptCount`). It does NOT accept — and cannot be made to accept, by
// any caller, ever — a Firestore instance, a DocumentReference bound to one, an
// AccessTokenProvider, a transport function, a DeliverySendCapability, a raw
// installation/FCM token, a raw OAuth token, a caller-chosen sendExecutionId, a
// caller-supplied "authorized" boolean, or any rollout/allowlist assertion. `db` and
// `accessTokenProvider` are resolved EXCLUSIVELY via the private getters above.
// ---------------------------------------------------------------------------------------

export type SanitizedSendOrchestrationResult =
  | { outcome: 'oauth-preparation-failed' }
  | { outcome: 'dry-run-validated' }
  | { outcome: 'cancelled'; reason: FinalAuthorizationReason }
  | { outcome: 'invalid-delivery'; reason: string }
  | { outcome: 'stale-fence'; reason: 'stale-processing-fence' }
  | { outcome: 'delivery-not-found' }
  | { outcome: 'terminalized'; state: 'accepted-by-fcm' | 'rejected-final' | 'unknown-outcome' }
  | { outcome: 'requeued-for-retry' }
  | { outcome: 'outcome-fence-mismatch' }
  | { outcome: 'persistence-failed'; reason: string };

// Reconstructs a SanitizedSendOrchestrationResult field-by-field from the real
// PrepareAndFinalizeResult — NEVER via `{ ...finalization }` or any other spread of the
// original object, so a future field added to that type (secret-bearing or not) can never
// ride along unnoticed.
function sanitizeNonSendingFinalizationOutcome(
  finalization: Exclude<PrepareAndFinalizeResult, { outcome: 'sending-authorized' }>
): SanitizedSendOrchestrationResult {
  switch (finalization.outcome) {
    case 'oauth-preparation-failed':
      return { outcome: 'oauth-preparation-failed' };
    case 'dry-run-validated':
      return { outcome: 'dry-run-validated' };
    case 'cancelled':
      return { outcome: 'cancelled', reason: finalization.reason };
    case 'invalid-delivery':
      return { outcome: 'invalid-delivery', reason: finalization.reason };
    case 'stale-fence':
      return { outcome: 'stale-fence', reason: finalization.reason };
    case 'delivery-not-found':
      return { outcome: 'delivery-not-found' };
  }
}

export async function processControlledSendCandidate(
  reminderId: unknown,
  installationId: unknown,
  expectedProcessingAttemptCount: unknown
): Promise<SanitizedSendOrchestrationResult> {
  if (!isValidReminderId(reminderId) || !isValidInstallationIdShape(installationId)) {
    return { outcome: 'delivery-not-found' };
  }
  const db = getProductionSenderDb();
  const accessTokenProvider = getProductionSenderAccessTokenProvider();
  const deliveryRef = db.doc(`artifacts/${DELIVERY_APP_ID}/reminders/${reminderId}/deliveries/${installationId}`);
  const finalization = await prepareAndFinalizeDelivery(db, deliveryRef, expectedProcessingAttemptCount, accessTokenProvider);
  if (finalization.outcome !== 'sending-authorized') {
    return sanitizeNonSendingFinalizationOutcome(finalization);
  }
  // The ONLY place, anywhere in this codebase, where a DeliverySendCapability is ever
  // handed to the module-private transport function — immediately, synchronously, with the
  // exact capability this exact call just received from a genuinely fresh authorization.
  const { capability } = finalization;
  return executeControlledSend(db, capability);
}
