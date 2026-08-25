// functions/src/reminderDeliverySender.ts
// Phase 3A-3 Step 3C-4 — the ONLY file, anywhere in this codebase, permitted to import
// fcmTransport.ts / sendFcmOnce. Consumes a one-shot DeliverySendCapability constructed by
// reminderDeliveryAuth.ts's finalizeDeliveryAuthorization ('sending-authorized' outcome),
// performs exactly ONE FCM v1 send, and commits the outcome via a separate, fenced
// transaction. There is exactly one source-level call to sendFcmOnce in this file — see
// executeControlledSend below.
//
// DO NOT CLAIM EXACTLY-ONCE DELIVERY. FCM's v1 `messages:send` API has no idempotency key,
// and a genuinely ambiguous transport outcome (timeout, network error, a >=500/408/421/425
// gateway-class response) can never be proven to have or have not reached FCM. This file
// accepts that limitation rather than working around it: an ambiguous outcome always
// terminalizes (never retries — see reminderDeliveryLogic.ts's decideSendOutcomeAction,
// reused verbatim, not reimplemented here), and a crash between committing 'sending' and
// recording an outcome leaves the delivery permanently stuck in 'sending' (workState
// 'terminal', structurally unreclaimable — see reminderDeliveryLogic.ts's
// expectedWorkStateForDeliveryState) rather than being silently retried and risking a
// duplicate notification. That state means "send deliberately authorized; outcome
// unknown" and requires manual, not automatic, resolution — see the file header of
// reminderDeliveryLogic.ts's DELIVERY STATES section and this codebase's Step 3C-4 design
// review for the full rationale.
//
// SOURCE-LEVEL REAL-SEND LOCK, LAYER C — REAL_DELIVERY_STAGE below is a SEPARATE,
// independently-declared constant from reminderDeliveryAuth.ts's own REAL_DELIVERY_STAGE
// (deliberately never imported from it — see reminderDeliveryLogic.ts's RealDeliveryStage/
// decideStagedRealSendAuthorization for why two independently-declared constants are
// required, not one shared one). Asserted immediately adjacent to the sole sendFcmOnce
// call site, below. For THIS implementation it MUST remain 'disabled'. In practice this
// function is never reached in production today at all: reminderDeliveryAuth.ts's own
// layer A/B enforcement never produces a 'sending-authorized' outcome while ITS
// REAL_DELIVERY_STAGE is 'disabled', so no caller ever has a capability to hand this file
// in the first place. This assertion exists purely as redundant, independent
// defense-in-depth — not the only guard.
//
// NO IMPORT-TIME SIDE EFFECTS — every top-level statement below is an import, a type
// declaration, a plain literal constant, or a function declaration. No module-scope
// Firestore singleton, no module-scope GoogleAuth/credential construction, nothing that
// executes before a function in this file is actually called. Every function below takes
// `db: FirebaseFirestore.Firestore` as an explicit parameter (matching
// reminderDeliveryWorker.ts's own dependency-injection convention), never a captured
// singleton.
'use strict';

import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { sendFcmOnce, FCM_PROJECT_ID, type FcmSendOutcome } from './fcmTransport';
import {
  requireAllowedDeliveryTransition,
  requireAuthorizedRetryTransition,
  decideSendOutcomeAction,
  appendAttemptHistoryEntry,
  computeDeliveryRetryAvailableAtMs,
  isMatchingActiveSendIntent,
  buildDeliveryTerminalWorkStateFields,
  type DeliverySendOutcomeKind,
  type AttemptOutcomeCategory,
  type RealDeliveryStage,
} from './reminderDeliveryLogic';
import type { DeliverySendCapability } from './reminderDeliveryAuth';

// See file header — this is a structural phase lock, not a rollout-config-driven decision.
// MUST remain 'disabled' for this implementation.
export const REAL_DELIVERY_STAGE: RealDeliveryStage = 'disabled';

// ---------------------------------------------------------------------------------------
// FIXED FIRST-SEND MESSAGE SCHEMA — pure, directly unit-testable, no Firestore/network
// access. Deliberately fixed, server-authored content: no arbitrary user-controlled keys,
// no health/progress information, and no UID, reminder ID, audience ID, token, provenance
// ID, execution ID, or other internal identifier anywhere in visible text. The only
// variable input is the current, already-validated installation token.
//
// COMPATIBILITY — inspected directly against the actual deployed service worker
// (public/firebase-messaging-sw.js): its onBackgroundMessage handler explicitly skips
// manual display whenever `payload.notification` is present ("already auto-displayed by
// Firebase's own SW machinery... calling showNotification() again would duplicate that
// auto-display"), and its notificationclick handler always focuses/opens the app root
// ('/'), never reading any custom data field from the payload. Including a `notification`
// object (title/body) is therefore both necessary (for the existing background-display
// path to fire at all) and sufficient (no additional data-only display branch is needed).
// Deliberately does NOT include a custom deep-link field: the existing click handler does
// not consume one yet, so adding one now would be unused, misleading scaffolding rather
// than genuine compatibility — a real deep-link requires its own, separately-reviewed
// service-worker change.
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
// translation. Pure, directly testable, zero network/Firestore access. Kept as small,
// independent helpers (not one monolith) so each mapping can be exercised in isolation.
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
  // 'unknown-outcome' and 'request-not-attempted' both collapse to the SAME history
  // category, exactly mirroring decideSendOutcomeAction's own collapsing of both into the
  // same terminal 'unknown-outcome' delivery state.
  return 'unknown-outcome';
}

export function extractAttemptHttpStatus(sendOutcome: FcmSendOutcome): number | null {
  if (sendOutcome.kind === 'accepted') return sendOutcome.httpStatus;
  if (sendOutcome.kind === 'rejected') return sendOutcome.httpStatus;
  // 'unknown-outcome' and 'request-not-attempted' never carry an httpStatus field at all —
  // AttemptHistoryEntry requires `null` here for exactly this category.
  return null;
}

// ---------------------------------------------------------------------------------------
// POST-SEND FENCED OUTCOME COMMIT.
// ---------------------------------------------------------------------------------------

export type SendOutcomeCommitResult =
  | { outcome: 'terminalized'; state: 'accepted-by-fcm' | 'rejected-final' | 'unknown-outcome' }
  | { outcome: 'requeued-for-retry' }
  // The re-read delivery no longer matches the exact (state==='sending' &&
  // sendAttemptCount && sendExecutionId) tuple this capability was authorized for — never
  // writes anything. Not expected to occur in normal automated operation (see the file
  // header's "DO NOT CLAIM EXACTLY-ONCE DELIVERY" section for why), but the fence must
  // hold even for a scenario this codebase's own automation does not create.
  | { outcome: 'outcome-fence-mismatch' }
  // CODEX REPAIR ROUND (Step 3C-4) — replaces the prior, REJECTED 'invalid-delivery'
  // disposition. By the time this branch is reached, the fence has already proven this is
  // the authorized 'sending' record for an attempt whose FCM request MAY ALREADY HAVE
  // BEEN MADE (executeControlledSend calls sendFcmOnce before commitSendOutcome ever
  // runs). A post-send persistence problem (e.g. the pre-existing attemptHistory this
  // outcome would append to is itself somehow malformed) must NEVER be recorded as
  // 'invalid-delivery' — that would destroy the one durable fact this document still
  // proves: an authorized send may have occurred. This outcome performs ZERO Firestore
  // mutation and leaves the document in 'sending', unchanged, for operator review — see
  // commitSendOutcome below.
  | { outcome: 'persistence-failed'; reason: string };

// Exported separately from executeControlledSend (below) so tests can exercise the fence /
// attempt-history / retry-vs-terminalize logic by injecting a synthetic FcmSendOutcome,
// without needing to fake the transport layer at all — mirrors fcmTransport.ts's own split
// between classifyFcmTransportResult (pure) and sendFcmOnce (the network wrapper).
export async function commitSendOutcome(
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
    // CODEX REPAIR ROUND (Step 3C-4) — the fence now requires the COMPLETE persisted
    // active-intent identity (state + sendAttemptCount + sendExecutionId +
    // sendIntentAtMs), not merely the first two fields. See
    // reminderDeliveryLogic.ts's isMatchingActiveSendIntent for the full rationale.
    if (!isMatchingActiveSendIntent(data, capability.sendAttemptCount, capability.sendExecutionId, capability.sendIntentAtMs)) {
      return { outcome: 'outcome-fence-mismatch' };
    }
    // The fence above just proved data.sendIntentAtMs === capability.sendIntentAtMs
    // exactly — but the attempt-history entry below deliberately uses THIS freshly-read,
    // persisted value, never capability.sendIntentAtMs directly, as a matter of
    // provenance discipline: once a transactional read exists, it — not an
    // earlier-obtained caller value — is the trustworthy source for anything durably
    // recorded from this point on.
    const persistedSendIntentAtMs = data.sendIntentAtMs as number;

    const appendedHistory = appendAttemptHistoryEntry(data.attemptHistory, {
      sendIntentAt: persistedSendIntentAtMs,
      outcomeCategory,
      httpStatus,
      outcomeRecordedAt: Date.now(),
    });
    if (appendedHistory === null) {
      // CODEX REPAIR ROUND (Step 3C-4) — the pre-existing history (already validated at
      // authorization time) or the candidate entry this attempt would produce is somehow
      // malformed. Unlike a pre-send corruption discovery, this document's FCM request may
      // already have been made — ZERO Firestore mutation occurs here (not even a
      // quarantine write), and the document is deliberately left in 'sending', exactly as
      // it was, for operator review. See the SendOutcomeCommitResult 'persistence-failed'
      // variant's own comment for the full rationale.
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

    // decision.action === 'requeue-retry' — the ONLY authorization surface for this edge
    // is requireAuthorizedRetryTransition, which recomputes the decision from scratch
    // rather than trusting `decision` itself (matching this codebase's established
    // "never trust a caller-supplied pre-computed decision object" convention).
    requireAuthorizedRetryTransition('sending', deliveryOutcome, capability.sendAttemptCount);
    const workAvailableAtMs = computeDeliveryRetryAvailableAtMs(Date.now());
    transaction.update(capability.deliveryRef, {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(workAvailableAtMs),
      leaseExpiresAt: null,
      // sendAttemptCount is deliberately left UNCHANGED — it remains the durable count of
      // already-authorized intents. sendExecutionId/sendIntentAtMs are cleared: the
      // previous execution ID is no longer the active attempt identity, and the NEXT
      // authorized attempt (a future preparing -> sending commit) will receive a fresh
      // sendExecutionId, never a reused one.
      sendExecutionId: null,
      sendIntentAtMs: null,
      attemptHistory: appendedHistory,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { outcome: 'requeued-for-retry' };
  });
}

// ---------------------------------------------------------------------------------------
// THE SOLE TRANSPORT CALL SITE.
// ---------------------------------------------------------------------------------------

// `capability` must be consumed IMMEDIATELY and exactly once: `capability.accessToken` and
// `capability.installationToken` are read here only to build the request and are never
// retained, logged, or returned by this function. This is the ONLY function in this
// codebase that calls sendFcmOnce — see the file header.
export async function executeControlledSend(db: FirebaseFirestore.Firestore, capability: DeliverySendCapability): Promise<SendOutcomeCommitResult> {
  if (REAL_DELIVERY_STAGE === 'disabled') {
    throw new Error('reminderDeliverySender: REAL_DELIVERY_STAGE must not be "disabled" when executeControlledSend is invoked.');
  }
  const message = buildFirstSendNotificationMessage(capability.installationToken);
  const sendOutcome = await sendFcmOnce({
    projectId: FCM_PROJECT_ID,
    accessToken: capability.accessToken,
    message,
  });
  return commitSendOutcome(db, capability, sendOutcome);
}
