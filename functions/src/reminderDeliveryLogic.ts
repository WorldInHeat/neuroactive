// functions/src/reminderDeliveryLogic.ts
// Phase 3A-3 Step 3C-1 — PURE LOGIC ONLY, implementing the Codex-approved Step 3C
// authoritative delivery-state-machine design. Deliberately has zero imports from
// 'firebase-admin/*', 'firebase-functions/*', './fcmTransport', or any network/OAuth
// module — every function here is a plain, synchronous, dependency-free function of its
// inputs, exercised by a real repository-local test file
// (reminderDeliveryLogic.test.ts) without needing a Firestore emulator, network access,
// or any Firebase credentials. This is the same convention already established by
// reminderSchedulerLogic.ts, pushInstallationEpochLogic.ts, and fcmTransport.ts's
// classifier.
//
// LAYERING: a future orchestration layer (reminderDeliveryWorker.ts, not built in this
// round) is responsible for reading/writing Firestore and for translating a real
// transport result (fcmTransport.ts's FcmSendOutcome) into the plain
// DeliverySendOutcomeKind shape this file consumes — this file never sees a real
// FcmSendOutcome value and never imports fcmTransport.ts, by design, matching the
// approved design's requirement that only reminderDeliverySender.ts (Step 3C-4) ever
// imports the transport module.
//
// ONE LOGICAL DELIVERY PER (reminder, installation) PAIR — no retry-child documents.
// Retry is a transition on the SAME document, but — CODEX REPAIR ROUND (runtime
// fail-closed hardening) — that transition is DELIBERATELY NOT exposed through the
// generic ALLOWED_DELIVERY_TRANSITIONS table. Its only authorization surface is
// isAuthorizedRetryTransition/requireAuthorizedRetryTransition below, which recompute
// the retry decision from scratch (never trusting a caller-supplied pre-computed
// decision object) — a generic `requireAllowedDeliveryTransition('sending','queued')`
// call can never succeed.
//
// CODEX REPAIR ROUND — SECOND PRINCIPLE APPLIED THROUGHOUT: nearly every exported
// function in this file now accepts `unknown` for values that could plausibly be
// fabricated/malformed at runtime (a stray `as` cast, a corrupted Firestore read, a
// hand-constructed test double), and validates internally rather than relying on
// TypeScript's compile-time narrowing, which offers zero protection against a value that
// lies about its own type. The unifying invariant this whole round hardens: a malformed
// count, a malformed rollout config, a malformed history, or a malformed identifier can
// NEVER cause this file to authorize a retry, a send, a fanout, or a fourth attempt —
// every validation failure fails closed to the same conservative outcome a genuinely
// ambiguous transport result would produce, never to a permissive default.
'use strict';

import { createHmac } from 'node:crypto';
import { isValidTokenVersion, isValidAudienceId } from './pushInstallationEpochLogic';

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 0;
}

// Reused for both `uid` and `reminderId` — the only real constraint is protecting this
// codebase's `db.doc(\`.../${id}/...\`)` path-interpolation convention (same reasoning as
// reminderSchedulerLogic.ts's isValidUidForPath / pushInstallations.ts), not an invented
// "grammar."
export function isValidIdForPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

// The ACTUAL, already-approved installationId grammar — hand-duplicated (not imported)
// from functions/src/pushInstallations.ts's isValidInstallationId/UUID_V4_PATTERN/
// HEX32_PATTERN, inspected directly rather than invented, matching this codebase's
// established convention of duplicating small pure grammar checks across
// independently-reviewed files instead of introducing a cross-file dependency.
// installationId is always either a client-generated UUID v4 or a 32-character hex
// string — never an arbitrary Firebase-UID-shaped string.
const INSTALLATION_ID_UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_HEX32_PATTERN = /^[0-9a-f]{32}$/i;

export function isValidInstallationIdShape(value: unknown): value is string {
  return typeof value === 'string' && (INSTALLATION_ID_UUID_V4_PATTERN.test(value) || INSTALLATION_ID_HEX32_PATTERN.test(value));
}

// Detects a JS string containing an unpaired UTF-16 surrogate by round-tripping it
// through UTF-8 with a FATAL decoder — the same technique already proven in
// fcmTransport.ts for detecting malformed transport bytes, reused here for the same
// reason: an unpaired surrogate is lossily replaced with U+FFFD during UTF-8 encoding,
// so two DIFFERENT ill-formed strings could otherwise silently encode to the same bytes
// and collide in deriveDeliveryPublicId's HMAC input.
function isWellFormedUnicodeString(value: string): boolean {
  const bytes = Buffer.from(value, 'utf-8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) === value;
  } catch {
    return false;
  }
}

// SECOND CODEX REPAIR ROUND (blocker 1): reminderId must NOT reuse isValidIdForPath's
// 128-character limit. Inspected directly from the actual committed
// reminderSchedulerLogic.ts: `buildReminderId(uid, scheduledForMs) = "${uid}_${scheduledForMs}"`,
// and a valid uid (isValidUidForPath there, isValidIdForPath here — same semantics) may
// itself be up to 128 characters, so a genuine Step 2 reminderId can be well over 128
// characters once the `_` separator and up to a 14-digit millisecond timestamp are
// appended. The actual, correct constraint is Firestore's own document-ID limit: at most
// 1,500 bytes when UTF-8 encoded, nonempty, no `/`, well-formed Unicode (no unpaired
// surrogate — see isWellFormedUnicodeString above), and not the reserved "." / ".." /
// "__*__" shapes. Measured in UTF-8 BYTES, not JS UTF-16 code units, since that is what
// Firestore itself measures and a single non-ASCII character can be multiple bytes.
export const FIRESTORE_DOCUMENT_ID_MAX_BYTES = 1500;
const RESERVED_DOCUMENT_ID_PATTERN = /^__.*__$/;

export function isValidFirestoreDocumentId(value: unknown, maxBytes: number = FIRESTORE_DOCUMENT_ID_MAX_BYTES): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('/')) return false;
  if (value === '.' || value === '..') return false;
  if (RESERVED_DOCUMENT_ID_PATTERN.test(value)) return false;
  if (!isWellFormedUnicodeString(value)) return false;
  const byteLength = Buffer.byteLength(value, 'utf-8');
  return byteLength > 0 && byteLength <= maxBytes;
}

// A separate, distinctly-named validator (not merely an alias) so reminderId-specific
// semantics can diverge from the generic Firestore document-ID rule later without
// disturbing callers that only care about "is this id document-safe" in general — for V1
// they are identical.
export function isValidReminderId(value: unknown): value is string {
  return isValidFirestoreDocumentId(value);
}

// Single shared validator for every normalized epoch-millisecond value used anywhere in
// this file — nowMs, workAvailableAtMs, leaseExpiresAtMs, attempt-history timestamps, and
// computeDeliveryLeaseExpiresAtMs's input. A malformed value here must never accidentally
// produce eligibility/authorization.
export function isValidEpochMs(value: unknown): value is number {
  return isValidNonNegativeInteger(value);
}

// ---------------------------------------------------------------------------------------
// DELIVERY STATES — the exact nine states from the approved design. Do not add, remove,
// or rename without a corresponding design-report revision.
// ---------------------------------------------------------------------------------------

export const DELIVERY_STATES = [
  'queued',
  'preparing',
  'sending',
  'accepted-by-fcm',
  'rejected-final',
  'unknown-outcome',
  'cancelled',
  'dry-run-validated',
  'invalid-delivery',
] as const;
export type DeliveryState = (typeof DELIVERY_STATES)[number];

const TERMINAL_DELIVERY_STATES = new Set<DeliveryState>([
  'accepted-by-fcm',
  'rejected-final',
  'unknown-outcome',
  'cancelled',
  'dry-run-validated',
  'invalid-delivery',
]);

export function isTerminalDeliveryState(state: string): boolean {
  return TERMINAL_DELIVERY_STATES.has(state as DeliveryState);
}

// CODEX REPAIR ROUND: `sending -> queued` has been REMOVED from this generic table. It is
// the one retry edge that must never be authorizable by a generic transition check — its
// ONLY authorization surface is isAuthorizedRetryTransition/requireAuthorizedRetryTransition
// below, which recompute the actual retry policy decision from scratch every time, rather
// than trusting that some caller already validated it. `unknown-outcome` and
// `dry-run-validated` still have ZERO outgoing transitions, deliberately, matching the
// approved design's explicit requirement that neither may ever be automatically retried or
// reach `sending`.
const ALLOWED_DELIVERY_TRANSITIONS: Record<DeliveryState, DeliveryState[]> = {
  queued: ['preparing', 'invalid-delivery'],
  preparing: ['sending', 'dry-run-validated', 'cancelled', 'invalid-delivery'],
  sending: ['accepted-by-fcm', 'rejected-final', 'unknown-outcome'],
  'accepted-by-fcm': [],
  'rejected-final': [],
  'unknown-outcome': [],
  cancelled: [],
  'dry-run-validated': [],
  'invalid-delivery': [],
};

export function isAllowedDeliveryTransition(from: string, to: string): boolean {
  const fromState = from as DeliveryState;
  const toState = to as DeliveryState;
  if (!DELIVERY_STATES.includes(fromState) || !DELIVERY_STATES.includes(toState)) return false;
  return ALLOWED_DELIVERY_TRANSITIONS[fromState].includes(toState);
}

export function requireAllowedDeliveryTransition(from: string, to: string): void {
  if (!isAllowedDeliveryTransition(from, to)) {
    throw new Error(`Invalid delivery state transition: ${from} -> ${to}`);
  }
}

// ---------------------------------------------------------------------------------------
// WORK-STATE MODEL — structurally identical philosophy to reminderSchedulerLogic.ts's
// WORK_STATES/expectedWorkStateForStatus/classifyWorkTuple/decideQueueOutcome (inspected
// directly from the actual committed file, not from memory). `queued` and `preparing`
// are the only two delivery states that may ever carry workState:'queued'; every other
// state — including `sending`, which is set to workState:'terminal' the INSTANT it is
// committed, before any FCM POST occurs — is immediately and permanently excluded from
// the recovery-query's `workState=='queued'` filter. This is what makes `sending`
// structurally un-reclaimable by any recovery query, independent of leaseExpiresAt.
// ---------------------------------------------------------------------------------------

export const DELIVERY_WORK_STATES = ['queued', 'terminal'] as const;
export type DeliveryWorkState = (typeof DELIVERY_WORK_STATES)[number];

export function expectedWorkStateForDeliveryState(state: string): DeliveryWorkState | null {
  if (state === 'queued' || state === 'preparing') return 'queued';
  // `sending` is deliberately NOT in TERMINAL_DELIVERY_STATES (it has real outgoing
  // transitions — accepted-by-fcm, rejected-final, unknown-outcome, and the one narrowly
  // authorized sending->queued retry, gated entirely outside this table) but its WORK
  // STATE is 'terminal' immediately upon commit, before any FCM POST occurs. Conflating
  // "terminal delivery state" with "terminal work state" here would silently reopen
  // `sending` to reclaim, which must never happen.
  if (state === 'sending') return 'terminal';
  if (isTerminalDeliveryState(state)) return 'terminal';
  return null; // state itself is not a recognized value at all.
}

export const DELIVERY_PROCESSING_LEASE_DURATION_MS = 5 * 60 * 1000; // 5 minutes, matching Step 2's PROCESSING_LEASE_DURATION_MS.

// CODEX REPAIR ROUND: accepts `unknown` and fails closed (throws — this is a pure
// construction helper returning a number, not an authorization decision, so a throw here
// can never be mistaken for permission) rather than silently computing a garbage future
// instant from a malformed `nowMs`.
export function computeDeliveryLeaseExpiresAtMs(nowMs: unknown): number {
  if (!isValidEpochMs(nowMs)) {
    throw new Error('computeDeliveryLeaseExpiresAtMs: nowMs must be a nonnegative safe-integer epoch-millisecond value.');
  }
  const result = nowMs + DELIVERY_PROCESSING_LEASE_DURATION_MS;
  // SECOND CODEX REPAIR ROUND (blocker 2): a valid nowMs near Number.MAX_SAFE_INTEGER can
  // still overflow the safe-integer domain once the lease duration is added — this
  // function must never hand back a value its OWN normalized-time validator would itself
  // reject. Re-validate the RESULT, not just the input.
  if (!isValidEpochMs(result)) {
    throw new Error('computeDeliveryLeaseExpiresAtMs: nowMs + lease duration overflows the safe-integer epoch-millisecond domain.');
  }
  return result;
}

export type DeliveryWorkTupleClassification =
  | { consistent: true; recoverableNow: boolean }
  | { consistent: false; reason: string };

// Byte-for-byte the same shape/logic as reminderSchedulerLogic.ts's classifyWorkTuple,
// applied to delivery states/lease fields. Called only with FRESH, transactionally-read
// data by the future orchestration layer — never with data from a discovery-query
// snapshot. CODEX REPAIR ROUND: workAvailableAtMs/leaseExpiresAtMs/nowMs now accept
// `unknown` and are validated internally (via isValidEpochMs, or null where the design
// permits it) before any comparison — a malformed timestamp fails closed to
// 'inconsistent', never to an accidental 'recoverableNow: true'.
export function classifyDeliveryWorkTuple(
  state: string,
  workState: unknown,
  workAvailableAtMs: unknown,
  leaseExpiresAtMs: unknown,
  nowMs: unknown
): DeliveryWorkTupleClassification {
  if (!isValidEpochMs(nowMs)) return { consistent: false, reason: 'invalid-now' };
  if (workAvailableAtMs !== null && !isValidEpochMs(workAvailableAtMs)) {
    return { consistent: false, reason: 'invalid-work-available-at' };
  }
  if (leaseExpiresAtMs !== null && !isValidEpochMs(leaseExpiresAtMs)) {
    return { consistent: false, reason: 'invalid-lease-expires-at' };
  }

  const expected = expectedWorkStateForDeliveryState(state);
  if (expected === null) return { consistent: false, reason: 'unrecognized-delivery-state' };

  if (typeof workState !== 'string' || !(DELIVERY_WORK_STATES as readonly string[]).includes(workState)) {
    return { consistent: false, reason: 'invalid-work-state' };
  }
  if (workState !== expected) return { consistent: false, reason: 'work-state-status-mismatch' };

  if (expected === 'terminal') {
    if (workAvailableAtMs !== null) return { consistent: false, reason: 'terminal-with-nonnull-availability' };
    if (leaseExpiresAtMs !== null) return { consistent: false, reason: 'terminal-with-nonnull-lease' };
    return { consistent: true, recoverableNow: false };
  }

  // expected === 'queued' -> state is 'queued' or 'preparing'.
  if (workAvailableAtMs === null) return { consistent: false, reason: 'queued-missing-availability' };

  if (state === 'queued') {
    if (leaseExpiresAtMs !== null) return { consistent: false, reason: 'queued-with-lease' };
    return { consistent: true, recoverableNow: workAvailableAtMs <= nowMs };
  }

  // state === 'preparing' -> a live lease must exist and must equal workAvailableAt
  // exactly (same instant by construction).
  if (leaseExpiresAtMs === null) return { consistent: false, reason: 'preparing-missing-lease' };
  if (workAvailableAtMs !== leaseExpiresAtMs) {
    return { consistent: false, reason: 'preparing-availability-lease-mismatch' };
  }
  return { consistent: true, recoverableNow: leaseExpiresAtMs <= nowMs };
}

// ---------------------------------------------------------------------------------------
// DELIVERY SCHEMA VALIDATION — mirrors reminderSchedulerLogic.ts's
// validateReminderSchema; the fields a delivery document must carry to be trusted at all.
// ---------------------------------------------------------------------------------------

export interface TargetSnapshot {
  generation: number;
  tokenVersion: number;
  installationAudienceId: string;
}

function validateTargetSnapshot(value: unknown): TargetSnapshot | null {
  if (!isNonNullObject(value)) return null;
  if (!isValidNonNegativeInteger(value.generation) || value.generation < 1) return null; // generation starts at 1 (pushInstallations.ts).
  if (!isValidNonNegativeInteger(value.tokenVersion) || value.tokenVersion < 1) return null; // tokenVersion starts at 1 (pushInstallationEpochLogic.ts).
  if (typeof value.installationAudienceId !== 'string' || value.installationAudienceId.length === 0) return null;
  return { generation: value.generation, tokenVersion: value.tokenVersion, installationAudienceId: value.installationAudienceId };
}

export const MAX_SEND_ATTEMPTS = 3;

export type DeliverySchemaCheck =
  | {
      valid: true;
      uid: string;
      installationId: string;
      sendAttemptCount: number;
      processingAttemptCount: number;
      targetSnapshot: TargetSnapshot;
    }
  | { valid: false; reason: string };

export function validateDeliverySchema(data: Record<string, unknown>): DeliverySchemaCheck {
  if (!isValidIdForPath(data.uid)) return { valid: false, reason: 'invalid-uid' };
  if (!isValidIdForPath(data.installationId)) return { valid: false, reason: 'invalid-installation-id' };
  if (!isValidNonNegativeInteger(data.sendAttemptCount) || data.sendAttemptCount > MAX_SEND_ATTEMPTS) {
    return { valid: false, reason: 'invalid-send-attempt-count' };
  }
  if (!isValidNonNegativeInteger(data.processingAttemptCount)) {
    return { valid: false, reason: 'invalid-processing-attempt-count' };
  }
  const targetSnapshot = validateTargetSnapshot(data.targetSnapshot);
  if (!targetSnapshot) return { valid: false, reason: 'invalid-target-snapshot' };

  return {
    valid: true,
    uid: data.uid,
    installationId: data.installationId,
    sendAttemptCount: data.sendAttemptCount,
    processingAttemptCount: data.processingAttemptCount,
    targetSnapshot,
  };
}

// ---------------------------------------------------------------------------------------
// QUEUE / MALFORMED-WORK DECISION — structural clone of reminderSchedulerLogic.ts's
// decideQueueOutcome (inspected directly, not from memory), adapted to delivery states.
// Exhaustive over every (state, workState, workAvailableAt, leaseExpiresAt) tuple the
// future recovery query could return, so a malformed delivery can never repeatedly
// reappear at the queue head.
// ---------------------------------------------------------------------------------------

export type DeliveryQueueOutcome =
  | { action: 'acquire' }
  | { action: 'still-leased' }
  | { action: 'quarantine-known-corruption'; reason: string }
  | { action: 'repair-terminal-queue-state' }
  | { action: 'neutralize-unknown-state' }
  | { action: 'already-terminal-correct' };

export function decideDeliveryQueueOutcome(
  state: string,
  workState: unknown,
  workAvailableAtMs: unknown,
  leaseExpiresAtMs: unknown,
  schemaCheck: DeliverySchemaCheck,
  nowMs: unknown
): DeliveryQueueOutcome {
  const expected = expectedWorkStateForDeliveryState(state);
  if (expected === null) {
    // state is not one of the nine recognized values at all — pure out-of-band
    // corruption, regardless of the current workState/availability values.
    return { action: 'neutralize-unknown-state' };
  }

  if (expected === 'terminal') {
    // Deliberately branches on the EXPECTED WORK STATE, not on isTerminalDeliveryState —
    // `sending` has real outgoing transitions (so it is NOT a terminal delivery state)
    // but its expected work state is 'terminal' immediately upon commit. A `sending`
    // record discovered with a corrupted, still-queue-visible tuple must be repaired
    // back to workState:'terminal' by this SAME path, with `state` left completely
    // untouched (never reset/reinterpreted) — never treated as ordinary recoverable
    // work, and never allowed to fall through to 'still-leased'/'acquire'. This is what
    // keeps a stranded `sending` record permanently un-reclaimable even if its queue
    // fields were somehow corrupted back to a queue-visible shape. The `=== null`
    // comparisons below are safe even against a malformed `unknown` value — any
    // non-null garbage simply makes `alreadyCanonical` false, routing to repair rather
    // than incorrectly treating garbage as canonical.
    const alreadyCanonical = workState === 'terminal' && workAvailableAtMs === null && leaseExpiresAtMs === null;
    return alreadyCanonical ? { action: 'already-terminal-correct' } : { action: 'repair-terminal-queue-state' };
  }

  // expected === 'queued' -> state is 'queued' or 'preparing', the only two states
  // classifyDeliveryWorkTuple treats as potentially recoverable.
  if (!schemaCheck.valid) return { action: 'quarantine-known-corruption', reason: schemaCheck.reason };

  const tuple = classifyDeliveryWorkTuple(state, workState, workAvailableAtMs, leaseExpiresAtMs, nowMs);
  if (!tuple.consistent) return { action: 'quarantine-known-corruption', reason: tuple.reason };
  if (!tuple.recoverableNow) return { action: 'still-leased' };
  return { action: 'acquire' };
}

// Pure payload builders — the future orchestration layer merges these with a real
// serverTimestamp() sentinel; deliberately excludes any firebase-admin-specific value
// here, matching reminderSchedulerLogic.ts's buildQuarantineUpdate/
// buildTerminalWorkStateFields precedent exactly.
export function buildDeliveryTerminalWorkStateFields(): { workState: 'terminal'; workAvailableAt: null; leaseExpiresAt: null } {
  return { workState: 'terminal', workAvailableAt: null, leaseExpiresAt: null };
}

export function buildDeliveryQuarantineUpdate(reason: string): {
  state: 'invalid-delivery';
  workState: 'terminal';
  workAvailableAt: null;
  leaseExpiresAt: null;
  invalidDeliveryReason: string;
} {
  return { state: 'invalid-delivery', ...buildDeliveryTerminalWorkStateFields(), invalidDeliveryReason: reason };
}

export function buildUnknownDeliveryStateNeutralizationUpdate(originalState: string): {
  state: 'invalid-delivery';
  workState: 'terminal';
  workAvailableAt: null;
  leaseExpiresAt: null;
  invalidDeliveryReason: string;
  originalCorruptState: string;
} {
  return {
    state: 'invalid-delivery',
    ...buildDeliveryTerminalWorkStateFields(),
    invalidDeliveryReason: 'unknown-state',
    originalCorruptState: originalState,
  };
}

// ---------------------------------------------------------------------------------------
// SEND-OUTCOME / RETRY DECISION — the central duplicate-avoidance invariant. `outcome`
// mirrors (but is NOT imported from) fcmTransport.ts's FcmSendOutcome shape — the future
// orchestration/sender layer is responsible for that translation.
//
// sendAttemptCount SEMANTICS: this counts DURABLE AUTHORIZED SEND INTENTS, not confirmed
// HTTP POSTs. It increments only when a (future) final-authorization transaction commits
// preparing -> sending. A crash after that commit but before the POST still counts —
// the intent was authorized regardless of whether the POST occurred.
// ---------------------------------------------------------------------------------------

// CODEX REPAIR ROUND: accepts `unknown`. Returns true ONLY for a genuine nonnegative
// safe integer strictly less than MAX_SEND_ATTEMPTS — every other runtime shape
// (negative, NaN, Infinity, -Infinity, fractional, unsafe integer, string, null,
// undefined, boolean, object) returns false, with no coercion of any kind.
export function canAuthorizeNewSendIntent(currentSendAttemptCount: unknown): boolean {
  return isValidNonNegativeInteger(currentSendAttemptCount) && currentSendAttemptCount < MAX_SEND_ATTEMPTS;
}

// The valid runtime domain for "count AFTER an attempt whose outcome we are now
// processing" is 1..MAX_SEND_ATTEMPTS inclusive (at least one attempt must have already
// been authorized for there to be an outcome to process at all).
export function isValidSendAttemptCountAfterAttempt(value: unknown): value is number {
  return isValidNonNegativeInteger(value) && value >= 1 && value <= MAX_SEND_ATTEMPTS;
}

export type DeliveryRejectionCategory =
  | 'invalid-argument'
  | 'permission-denied'
  | 'unauthenticated'
  | 'unregistered'
  | 'other-definitive-rejection'
  | 'retryable-later';

// Plain, independently-defined mirror of FcmSendOutcome's four top-level kinds — never
// imported from fcmTransport.ts. `request-not-attempted` is included because the
// approved design explicitly requires treating a structurally-anomalous
// request-not-attempted result (which should never occur after send-intent commits,
// since project/serialization validation already happened during `preparing`) exactly
// like `unknown-outcome`: terminal, no automatic retry.
export type DeliverySendOutcomeKind =
  | { kind: 'accepted' }
  | { kind: 'rejected'; category: DeliveryRejectionCategory }
  | { kind: 'unknown-outcome' }
  | { kind: 'request-not-attempted' };

export type SendOutcomeDecision =
  | { action: 'terminalize'; state: 'accepted-by-fcm' | 'rejected-final' | 'unknown-outcome' }
  | { action: 'requeue-retry' };

// The ONLY function that decides what happens to a `sending` delivery once a transport
// outcome is known. `requeue-retry` is reachable from EXACTLY ONE input shape:
// {kind:'rejected', category:'retryable-later'} while sendAttemptCountAfterThisAttempt is
// BOTH a valid count (isValidSendAttemptCountAfterAttempt) AND still under the cap
// (canAuthorizeNewSendIntent). CODEX REPAIR ROUND: sendAttemptCountAfterThisAttempt now
// accepts `unknown`; a malformed value on the retryable-later path fails closed to the
// same conservative `unknown-outcome` terminalization used for genuinely ambiguous
// transport results — NEVER rejected-final (a malformed count proves nothing about
// whether attempts are exhausted) and NEVER requeue-retry. Every other input — every
// other rejection category, unknown-outcome, request-not-attempted, and a
// retryable-later result that has already exhausted MAX_SEND_ATTEMPTS — terminalizes.
// 401 (unauthenticated) and 403 (permission-denied) are both definitive rejection
// categories here and therefore always terminalize in V1 — there is no
// OAuth-refresh-and-resend branch anywhere in this function or file.
export function decideSendOutcomeAction(outcome: DeliverySendOutcomeKind, sendAttemptCountAfterThisAttempt: unknown): SendOutcomeDecision {
  if (outcome.kind === 'accepted') {
    return { action: 'terminalize', state: 'accepted-by-fcm' };
  }

  if (outcome.kind === 'rejected') {
    if (outcome.category === 'retryable-later') {
      if (!isValidSendAttemptCountAfterAttempt(sendAttemptCountAfterThisAttempt)) {
        return { action: 'terminalize', state: 'unknown-outcome' };
      }
      return canAuthorizeNewSendIntent(sendAttemptCountAfterThisAttempt)
        ? { action: 'requeue-retry' }
        : { action: 'terminalize', state: 'rejected-final' };
    }
    // invalid-argument | permission-denied | unauthenticated | unregistered |
    // other-definitive-rejection — all definitive, all terminal, no retry.
    return { action: 'terminalize', state: 'rejected-final' };
  }

  // outcome.kind is 'unknown-outcome' or 'request-not-attempted' — both collapse to the
  // same conservative terminal outcome. This is the never-automatically-retry invariant;
  // it is intentionally impossible to reach 'requeue-retry' from either of these kinds.
  return { action: 'terminalize', state: 'unknown-outcome' };
}

// CODEX REPAIR ROUND (item 3): the ONLY authorization surface for the sending -> queued
// retry transition. Deliberately NOT part of ALLOWED_DELIVERY_TRANSITIONS/
// isAllowedDeliveryTransition — see that table's own comment. This function recomputes
// the retry decision from scratch via decideSendOutcomeAction rather than trusting a
// caller-supplied, possibly-fabricated `SendOutcomeDecision` object, so there is exactly
// ONE code path, anywhere, that can ever conclude "yes, this sending->queued transition
// is authorized," and it cannot be spoofed by hand-constructing a decision object.
export function isAuthorizedRetryTransition(currentState: string, outcome: DeliverySendOutcomeKind, sendAttemptCountAfterThisAttempt: unknown): boolean {
  if (currentState !== 'sending') return false;
  return decideSendOutcomeAction(outcome, sendAttemptCountAfterThisAttempt).action === 'requeue-retry';
}

export function requireAuthorizedRetryTransition(currentState: string, outcome: DeliverySendOutcomeKind, sendAttemptCountAfterThisAttempt: unknown): void {
  if (!isAuthorizedRetryTransition(currentState, outcome, sendAttemptCountAfterThisAttempt)) {
    throw new Error('Unauthorized sending -> queued retry transition.');
  }
}

// ---------------------------------------------------------------------------------------
// ATTEMPT HISTORY — bounded (<= MAX_SEND_ATTEMPTS), same-document, fixed-enum-only.
// Firestore fencing (verifying this append belongs to the currently-authorized
// sendAttemptCount before committing it) is NOT this file's job — it belongs to the
// future orchestration layer's transaction. This file only enforces that the resulting
// array shape is internally consistent (bounded length, strictly sequential
// attemptNumber starting at 1, fixed-enum outcomeCategory only, and — CODEX REPAIR
// ROUND — that a new entry can only ever be constructed from an explicit field
// allowlist, never by spreading a caller-supplied object).
// ---------------------------------------------------------------------------------------

export type AttemptOutcomeCategory =
  | 'accepted'
  | 'invalid-argument'
  | 'permission-denied'
  | 'unauthenticated'
  | 'unregistered'
  | 'other-definitive-rejection'
  | 'retryable-later'
  | 'unknown-outcome';

const ATTEMPT_OUTCOME_CATEGORIES: readonly AttemptOutcomeCategory[] = [
  'accepted',
  'invalid-argument',
  'permission-denied',
  'unauthenticated',
  'unregistered',
  'other-definitive-rejection',
  'retryable-later',
  'unknown-outcome',
];

export interface AttemptHistoryEntry {
  attemptNumber: number;
  sendIntentAt: number; // epoch milliseconds — a pure numeric representation; the
  // orchestration layer converts to/from a Firestore Timestamp at the boundary.
  outcomeCategory: AttemptOutcomeCategory;
  httpStatus: number | null;
  outcomeRecordedAt: number;
}

// CODEX REPAIR ROUND: httpStatus, when present, must be a finite safe-integer HTTP
// status code in the documented 100..599 range. `null` remains valid ONLY for
// `outcomeCategory === 'unknown-outcome'` (the one category that can legitimately arise
// from a transport-level failure — timeout, network error — where no HTTP response was
// ever observed at all); every other category is reached only after the transport parsed
// a real, coherent HTTP response, so a real status is required for those.
function isValidHttpStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && Number.isSafeInteger(value) && value >= 100 && value <= 599;
}

// SECOND CODEX REPAIR ROUND (blocker 4): the persisted attempt-history schema is narrow
// and server-owned, so an entry carrying ANY unexpected own property — not merely a
// wrong-typed value in a known field — is itself treated as invalid, not merely
// suspicious. This is stronger than stripping secrets during append (blocker 3): it means
// a malformed/tampered EXISTING history (the one appendAttemptHistoryEntry reads before
// ever constructing a new entry) is rejected outright by validateAttemptHistory itself,
// rather than being laundered forward with its extra fields silently dropped.
const ATTEMPT_HISTORY_ENTRY_ALLOWED_KEYS = new Set<string>(['attemptNumber', 'sendIntentAt', 'outcomeCategory', 'httpStatus', 'outcomeRecordedAt']);

function hasOnlyAllowedOwnKeys(value: Record<string, unknown>, allowedKeys: Set<string>): boolean {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) return false;
  }
  return true;
}

export function isValidAttemptHistoryEntry(value: unknown): value is AttemptHistoryEntry {
  if (!isNonNullObject(value)) return false;
  if (!hasOnlyAllowedOwnKeys(value, ATTEMPT_HISTORY_ENTRY_ALLOWED_KEYS)) return false;
  if (!isValidNonNegativeInteger(value.attemptNumber) || value.attemptNumber < 1 || value.attemptNumber > MAX_SEND_ATTEMPTS) return false;
  if (!isValidEpochMs(value.sendIntentAt)) return false;
  if (typeof value.outcomeCategory !== 'string' || !ATTEMPT_OUTCOME_CATEGORIES.includes(value.outcomeCategory as AttemptOutcomeCategory)) {
    return false;
  }
  if (value.outcomeCategory === 'unknown-outcome') {
    if (value.httpStatus !== null && !isValidHttpStatus(value.httpStatus)) return false;
  } else {
    if (value.httpStatus === null || !isValidHttpStatus(value.httpStatus)) return false;
  }
  if (!isValidEpochMs(value.outcomeRecordedAt)) return false;
  return true;
}

export type AttemptHistoryValidation = { valid: true } | { valid: false; reason: string };

// Validates the FULL array: bounded length, every entry individually valid, AND
// strictly sequential attemptNumber starting at 1 with no gaps/duplicates/reordering —
// shape validity alone is not enough; internal consistency across entries matters too.
// CODEX REPAIR ROUND: accepts `unknown` — a caller passing a non-array, or an array
// containing anything other than well-formed entries, is rejected rather than assumed
// well-typed.
export function validateAttemptHistory(history: unknown): AttemptHistoryValidation {
  if (!Array.isArray(history)) return { valid: false, reason: 'not-an-array' };
  if (history.length > MAX_SEND_ATTEMPTS) return { valid: false, reason: 'too-many-entries' };
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!isValidAttemptHistoryEntry(entry)) return { valid: false, reason: 'invalid-entry-shape' };
    if (entry.attemptNumber !== i + 1) return { valid: false, reason: 'attempt-number-out-of-sequence' };
  }
  return { valid: true };
}

// CODEX REPAIR ROUND: the raw material for a new entry, with every field typed `unknown`
// — the caller may hand this function anything, including a raw provider message, a
// token-like string, or arbitrary extra properties, and none of it can leak through.
export interface RawAttemptEntryInput {
  sendIntentAt: unknown;
  outcomeCategory: unknown;
  httpStatus: unknown;
  outcomeRecordedAt: unknown;
}

// SECOND CODEX REPAIR ROUND (blocker 3): constructs a FRESH plain object from exactly the
// five allowed fields, called ONLY after `entry` has already passed
// isValidAttemptHistoryEntry. This is deliberately a SEPARATE defense from the
// own-key-allowlist check inside isValidAttemptHistoryEntry (blocker 4): the own-key
// check rejects an entry with an extra OWN property outright, but a hostile PROTOTYPE
// (e.g. `Object.create({ token: 'SECRET' }, { attemptNumber: {...}, ... })`) would carry
// no extra OWN keys at all and could still pass that check — `Object.keys`/`JSON.stringify`
// would not surface the inherited `token`, but a later plain property access
// (`entry.token`) would. Reconstructing a fresh object here, whose only prototype is the
// ordinary `Object.prototype`, severs any such inherited-property risk completely.
function sanitizeValidatedAttemptEntry(entry: AttemptHistoryEntry): AttemptHistoryEntry {
  return {
    attemptNumber: entry.attemptNumber,
    sendIntentAt: entry.sendIntentAt,
    outcomeCategory: entry.outcomeCategory,
    httpStatus: entry.httpStatus,
    outcomeRecordedAt: entry.outcomeRecordedAt,
  };
}

// Pure append helper, fully hardened:
//   A/B. validates the EXISTING history first via validateAttemptHistory; a malformed
//        existing history — including one whose entries carry unexpected own properties
//        (a raw token, a provider message, anything at all) — is rejected (returns null)
//        rather than being trusted or laundered forward.
//   C/D. constructs the candidate entry from an EXPLICIT FIELD ALLOWLIST only — never
//        spreads `entryInput`, so no arbitrary extra property can ever ride along into
//        the persisted history, regardless of what `entryInput` actually contains.
//   E.   validates the candidate entry via isValidAttemptHistoryEntry.
//   F.   validates the COMPLETE resulting array via validateAttemptHistory.
//   G.   refuses (returns null) rather than silently truncating a 4th entry.
// Also severs aliasing in both directions (item 14): EVERY entry in the result — both
// the pre-existing ones and the new one — is freshly reconstructed via
// sanitizeValidatedAttemptEntry, never the caller's original object references, so
// mutating the original `existingHistory` array/objects afterward can never alter the
// returned array, and mutating the returned array can never alter the caller's original.
export function appendAttemptHistoryEntry(existingHistory: unknown, entryInput: RawAttemptEntryInput): AttemptHistoryEntry[] | null {
  const existingValidation = validateAttemptHistory(existingHistory);
  if (!existingValidation.valid) return null;
  const existing = existingHistory as AttemptHistoryEntry[]; // safe: validateAttemptHistory just proved this exact shape.

  const nextAttemptNumber = existing.length + 1;
  if (nextAttemptNumber > MAX_SEND_ATTEMPTS) return null;

  const candidateEntry: AttemptHistoryEntry = {
    attemptNumber: nextAttemptNumber,
    sendIntentAt: entryInput.sendIntentAt as number,
    outcomeCategory: entryInput.outcomeCategory as AttemptOutcomeCategory,
    httpStatus: entryInput.httpStatus as number | null,
    outcomeRecordedAt: entryInput.outcomeRecordedAt as number,
  };
  if (!isValidAttemptHistoryEntry(candidateEntry)) return null;

  const result: AttemptHistoryEntry[] = [...existing.map(sanitizeValidatedAttemptEntry), sanitizeValidatedAttemptEntry(candidateEntry)];

  const resultValidation = validateAttemptHistory(result);
  if (!resultValidation.valid) return null;

  return result;
}

// ---------------------------------------------------------------------------------------
// ROLLOUT MODE — pure parsing/decision only. This file performs NO reads; it only ever
// receives an already-read, plain value and decides what it means. Any parse/validation
// failure fails closed to 'paused' semantics — the single strictest of the four modes —
// via this one function's own logic, never a fallback scattered across call sites.
// ---------------------------------------------------------------------------------------

export type RolloutMode = 'paused' | 'dry-run' | 'allowlisted-real-send' | 'general-real-send';

export type ParsedRolloutConfig =
  | { mode: 'paused' }
  | { mode: 'dry-run' }
  | { mode: 'allowlisted-real-send'; allowlistUids: string[] }
  | { mode: 'general-real-send' };

export function parseRolloutConfig(raw: unknown): ParsedRolloutConfig {
  if (!isNonNullObject(raw)) return { mode: 'paused' };

  const mode = raw.mode;
  if (mode === 'paused') return { mode: 'paused' };
  if (mode === 'dry-run') return { mode: 'dry-run' };
  if (mode === 'general-real-send') return { mode: 'general-real-send' };

  if (mode === 'allowlisted-real-send') {
    const allowlistUids = raw.allowlistUids;
    if (!Array.isArray(allowlistUids)) return { mode: 'paused' };
    // A fresh array is always constructed here — never the same reference as
    // `raw.allowlistUids` — so mutating the caller's original array after parsing can
    // never retroactively alter an already-parsed config (item 14).
    const uids: string[] = [];
    for (const entry of allowlistUids) {
      // SECOND CODEX REPAIR ROUND (blocker 5): validated with the EXACT SAME validator
      // (isValidIdForPath) that decideShouldFanOut/decideRealSendAuthorization use for
      // uid membership checks — not a looser ad-hoc "nonempty string" check. A path-shaped
      // (containing "/"), overlong (>128 chars), or non-string entry anywhere in the
      // array now invalidates the WHOLE allowlist, exactly like any other malformed
      // entry — a single bad member can never leave the remaining valid members active.
      // A single malformed entry invalidates the WHOLE allowlist rather than being
      // silently dropped — an allowlist that can silently shrink due to a stray
      // malformed entry is a safety property (fewer real sends), but one that can
      // silently mean something different than the operator intended is not something
      // this parser should paper over; fail closed to 'paused' entirely instead.
      if (!isValidIdForPath(entry)) return { mode: 'paused' };
      uids.push(entry);
    }
    return { mode: 'allowlisted-real-send', allowlistUids: uids };
  }

  return { mode: 'paused' }; // unrecognized mode string entirely.
}

export type FanoutDecision = { shouldFanOut: boolean };

// CODEX REPAIR ROUND (item 4): accepts `unknown` for BOTH the rollout config and the
// uid, and re-parses/re-validates internally via parseRolloutConfig/isValidIdForPath
// rather than trusting that a caller-declared `ParsedRolloutConfig`/`string` type
// actually holds a genuinely well-formed value at runtime. A malformed uid can never
// authorize fanout, regardless of rollout mode. Whether Step 3C's fanout machinery
// should run at all for this uid, given a freshly parsed rollout config. 'paused' never
// fans out. 'dry-run' ALWAYS fans out (the entire pipeline is meant to be exercised
// safely in this mode). 'general-real-send' always fans out. 'allowlisted-real-send'
// fans out only for allowlisted uids — a non-allowlisted uid under this mode behaves
// exactly like 'paused' (Step 2's legacy dry-run-complete path, Step 3C never engages).
export function decideShouldFanOut(rawConfig: unknown, uid: unknown): FanoutDecision {
  if (!isValidIdForPath(uid)) return { shouldFanOut: false };
  const config = parseRolloutConfig(rawConfig);
  if (config.mode === 'paused') return { shouldFanOut: false };
  if (config.mode === 'dry-run') return { shouldFanOut: true };
  if (config.mode === 'general-real-send') return { shouldFanOut: true };
  return { shouldFanOut: config.allowlistUids.includes(uid) };
}

export type RealSendAuthorizationDecision =
  | { authorized: true }
  | { authorized: false; reason: 'paused' | 'dry-run-only' | 'not-allowlisted' | 'invalid-uid' };

// CODEX REPAIR ROUND (item 4): same `unknown`-accepting, internally-reparsing hardening
// as decideShouldFanOut. Whether a REAL send-intent (as opposed to a dry-run terminal
// write) may be authorized for this uid, given a freshly re-read rollout config — this
// is the exact gate the approved design's final-authorization transaction consults.
// 'dry-run' mode never authorizes a real send, even though it DOES fan out and run the
// full pipeline otherwise — that asymmetry is deliberate and is the whole point of
// dry-run mode.
export function decideRealSendAuthorization(rawConfig: unknown, uid: unknown): RealSendAuthorizationDecision {
  if (!isValidIdForPath(uid)) return { authorized: false, reason: 'invalid-uid' };
  const config = parseRolloutConfig(rawConfig);
  if (config.mode === 'paused') return { authorized: false, reason: 'paused' };
  if (config.mode === 'dry-run') return { authorized: false, reason: 'dry-run-only' };
  if (config.mode === 'general-real-send') return { authorized: true };
  return config.allowlistUids.includes(uid) ? { authorized: true } : { authorized: false, reason: 'not-allowlisted' };
}

// ---------------------------------------------------------------------------------------
// PUBLIC-ID DERIVATION — retry-stable across Firestore transaction callback retries.
// The nonce is generated ONCE by the (future) orchestration layer, OUTSIDE
// db.runTransaction(...), and passed in here on every call, including on every retry of
// the same transaction attempt — this function never generates randomness itself.
// ---------------------------------------------------------------------------------------

// CODEX REPAIR ROUND (H1 provenance) — the generic "opaque, fixed-format, 43-character
// base64url identifier" shape shared by deliveryPublicId (an HMAC digest) AND the new
// fanoutExecutionId (raw randomness, no HMAC) — both are 32-byte values encoded the same
// way, so the FORMAT validator is a single shared primitive rather than two independently
// maintained near-duplicates. 32 bytes * 8 bits = 256 bits; base64url (6 bits/char, no
// padding) = ceil(256/6) = 43 characters, alphabet [A-Za-z0-9_-] only — verified directly
// (Buffer.from(32 bytes).toString('base64url') is always exactly 43 characters, never 44,
// since 32 is not a multiple of 3 and base64url-without-padding never pads).
export const OPAQUE_ID_BYTE_LENGTH = 32;
export const OPAQUE_ID_LENGTH = 43;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function isValidOpaqueIdFormat(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

export const FANOUT_NONCE_BYTE_LENGTH = OPAQUE_ID_BYTE_LENGTH; // 256-bit. Kept as a distinct exported name (semantic role: HMAC key) even though the value is identical to OPAQUE_ID_BYTE_LENGTH.
const PUBLIC_ID_ENCODING_VERSION = 1;

// Unambiguous encoding: a version byte followed by, for each component, a 4-byte
// big-endian length prefix and its raw UTF-8 bytes. This is immune to the classic
// concatenation-collision attack (e.g. "AB"+"CD" producing the same bytes as "A"+"BCD")
// because each component's exact byte length is recorded before its content, not
// inferred from a delimiter that could itself appear inside a component.
function encodeVersionedComponents(version: number, ...parts: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from([version])];
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf-8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(bytes.length, 0);
    chunks.push(len, bytes);
  }
  return Buffer.concat(chunks);
}

// CODEX REPAIR ROUND (item 8): every parameter now accepts `unknown` and is validated at
// runtime — `fanoutNonce` must be a genuine `Buffer` (not a plain Uint8Array masquerading
// as one — `Buffer.isBuffer()` correctly distinguishes these) of exactly
// FANOUT_NONCE_BYTE_LENGTH bytes; `reminderId` must be a well-formed (no unpaired UTF-16
// surrogates), path-safe primitive string; `installationId` must match the ACTUAL,
// already-approved installationId grammar (UUID v4 or 32-character hex — inspected
// directly from pushInstallations.ts, not invented). Because both identifiers are
// validated as genuine primitive strings before ever reaching `encodeVersionedComponents`,
// a number/object/null/array/String-object input can never reach `Buffer.from` and
// trigger one of Node's surprising alternate `Buffer.from` encodings for non-string
// inputs. Node's `node:crypto` is used here for local, deterministic, pure computation
// only — this is not a network call, not Firestore, not FCM.
export function deriveDeliveryPublicId(fanoutNonce: unknown, reminderId: unknown, installationId: unknown): string {
  if (!Buffer.isBuffer(fanoutNonce) || fanoutNonce.byteLength !== FANOUT_NONCE_BYTE_LENGTH) {
    throw new Error(`deriveDeliveryPublicId: fanoutNonce must be a Buffer of exactly ${FANOUT_NONCE_BYTE_LENGTH} bytes.`);
  }
  if (!isValidReminderId(reminderId)) {
    throw new Error(`deriveDeliveryPublicId: reminderId must be a well-formed, nonempty Firestore document ID (<= ${FIRESTORE_DOCUMENT_ID_MAX_BYTES} UTF-8 bytes, no "/").`);
  }
  if (!isValidInstallationIdShape(installationId)) {
    throw new Error('deriveDeliveryPublicId: installationId must be a valid UUID v4 or 32-character hex string.');
  }
  const encoded = encodeVersionedComponents(PUBLIC_ID_ENCODING_VERSION, reminderId, installationId);
  return createHmac('sha256', fanoutNonce).update(encoded).digest('base64url');
}

// ---------------------------------------------------------------------------------------
// FANOUT COUNT / OUTCOME MODEL — pure arithmetic and decision only; no Firestore query
// logic lives here. The (future) orchestration layer executes the actual transactional,
// limit(11) active-installation query and passes only plain counts into this function.
// ---------------------------------------------------------------------------------------

export const MAX_TARGET_INSTALLATIONS = 10;
// The transactional discovery query uses this exact limit — one more than the cap — so
// a returned size of FANOUT_QUERY_LIMIT proves "at least 11 active installations exist"
// without ever claiming to know the true total.
export const FANOUT_QUERY_LIMIT = MAX_TARGET_INSTALLATIONS + 1;

export type FanoutOutcome =
  | {
      status: 'delivery-fanned-out';
      deliveryFanoutState: 'completed';
      targetInstallationCountAtFanout: number; // exact count of VALIDATED targets actually fanned out to (0..10) — NOT the raw query-returned count.
      excludedMalformedInstallationCount: number;
      // CODEX REPAIR ROUND (H1) — immutable, opaque, worker-generated identity proving this
      // specific successful fanout committed. ONLY the 'completed' variant ever carries
      // this field — a 'failed' fanout must never masquerade as having successful
      // provenance (see validateFanoutTuple below, which explicitly rejects a 'failed'
      // tuple that carries one).
      fanoutExecutionId: string;
    }
  | {
      status: 'delivery-fanned-out';
      deliveryFanoutState: 'failed';
      targetingFailureReason: 'installation-count-exceeds-cap';
      targetInstallationCountAtFanout: null;
      observedTargetCountAtLeast: number;
    }
  | {
      status: 'delivery-fanned-out';
      deliveryFanoutState: 'failed';
      targetingFailureReason: 'unexpected-preexisting-delivery';
      targetInstallationCountAtFanout: null;
    };

// `rawActiveCount`: the raw number of documents the transactional
// (uid==X && state=='active', limit 11) query returned. `excludedMalformedCount`: how
// many of those were excluded during per-document validation for failing
// delivery-critical schema (epoch/shape) checks. CODEX REPAIR ROUND (item 12): this
// safety helper now fails closed for ANY valid nonnegative integer rawActiveCount >=
// FANOUT_QUERY_LIMIT (11, 12, 100, ...) — not merely exactly 11 — so a future caller is
// never required to remember that the production query happens to be bounded by
// limit(11) in order to stay safe; only a genuinely malformed count (non-integer,
// negative, non-finite) throws. The documented invariant for the successful branch is:
// rawActiveCount === targetInstallationCountAtFanout + excludedMalformedInstallationCount
// — enforced by construction (subtraction), not merely asserted in a comment.
// CODEX REPAIR ROUND (H1) — `fanoutExecutionId` is generated ONCE by the (future)
// orchestration layer, OUTSIDE db.runTransaction(...), exactly like fanoutNonce (same
// section's own convention) — this function never generates randomness itself, only
// validates and (for the 'completed' branch only) embeds the caller-supplied value.
// Deliberately still required as an input even on the 'installation-count-exceeds-cap'
// (failed) path — the caller always generates it before knowing the eventual outcome,
// mirroring fanoutNonce's own lifecycle — but it is NEVER embedded in a 'failed' outcome:
// a failed fanout must not carry evidence that could be mistaken for successful provenance.
export function decideFanoutOutcome(rawActiveCount: unknown, excludedMalformedCount: unknown, fanoutExecutionId: unknown): FanoutOutcome {
  if (!isValidNonNegativeInteger(rawActiveCount)) {
    throw new Error('decideFanoutOutcome: rawActiveCount must be a nonnegative safe integer.');
  }
  if (!isValidNonNegativeInteger(excludedMalformedCount) || excludedMalformedCount > rawActiveCount) {
    throw new Error('decideFanoutOutcome: excludedMalformedCount must be a nonnegative safe integer not exceeding rawActiveCount.');
  }
  if (!isValidOpaqueIdFormat(fanoutExecutionId)) {
    throw new Error(`decideFanoutOutcome: fanoutExecutionId must be a valid opaque ID (${OPAQUE_ID_LENGTH}-character base64url).`);
  }

  if (rawActiveCount >= FANOUT_QUERY_LIMIT) {
    // The true population size beyond FANOUT_QUERY_LIMIT is genuinely unknown and is
    // never claimed to be exact — 11, 12, and 100 are all treated identically.
    return {
      status: 'delivery-fanned-out',
      deliveryFanoutState: 'failed',
      targetingFailureReason: 'installation-count-exceeds-cap',
      targetInstallationCountAtFanout: null,
      observedTargetCountAtLeast: FANOUT_QUERY_LIMIT,
    };
  }

  return {
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: rawActiveCount - excludedMalformedCount,
    excludedMalformedInstallationCount: excludedMalformedCount,
    fanoutExecutionId,
  };
}

// A genuinely fresh parent (status==='processing' with a freshly-verified attemptCount
// fence, per the approved design) can never legitimately find a pre-existing
// deterministic child — see the design report's Blocker 4 reasoning: a successful prior
// fanout would have already advanced the parent past 'processing', and a failed one
// commits nothing. Reaching this outcome means unexplained, out-of-band corruption; the
// orchestration layer must fail the WHOLE fanout closed, creating zero children, rather
// than adopting/skipping/merging/overwriting the unexpected document.
export function buildPreExistingChildCorruptionOutcome(): FanoutOutcome {
  return {
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'failed',
    targetingFailureReason: 'unexpected-preexisting-delivery',
    targetInstallationCountAtFanout: null,
  };
}

// CODEX REPAIR ROUND (item 10): a complete, standalone validator for a persisted/read-side
// fanout tuple, so a future consumer can call ONE helper instead of inspecting `status`
// alone (which by itself proves nothing — every variant, success or failure, shares the
// same `status: 'delivery-fanned-out'`, per Codex's explicit instruction not to rename it
// this round). Accepts `unknown` and rejects every internally-contradictory combination:
// `completed` with a failure reason present, `failed` without a recognized reason,
// `completed` with a null/out-of-range count, and count arithmetic that could not have
// arisen from the FANOUT_QUERY_LIMIT-bounded query (target + excluded must not exceed
// MAX_TARGET_INSTALLATIONS for any 'completed' tuple).
export type FanoutTupleValidation = { valid: true; outcome: FanoutOutcome } | { valid: false; reason: string };

// SECOND CODEX REPAIR ROUND (blocker 6/7): every mandatory field is required to be an OWN
// property of `input`, never merely inherited via the prototype chain (e.g.
// `Object.create({status:'delivery-fanned-out', ...})`) — a plain `input.field` read
// traverses the prototype chain regardless of own-vs-inherited, so own-property checks
// must happen explicitly and BEFORE any such read is trusted. A hostile getter/Proxy is
// permitted to make this function throw (acceptable — see item 7's explicit
// "do not over-engineer" guidance) but must never cause it to return `valid: true` based
// on unsafe inherited/accessor data.
function hasOwn(obj: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

// A field that is both a genuine OWN property AND meaningfully present (neither absent
// nor explicitly null/undefined) — used for the optional `targetingFailureReason`/
// `targetInstallationCountAtFanout` fields, where "inherited-but-present" must be
// indistinguishable from "genuinely absent," never accidentally treated as "present."
function hasOwnMeaningfulValue(obj: Record<string, unknown>, key: string): boolean {
  return hasOwn(obj, key) && obj[key] !== null && obj[key] !== undefined;
}

export function validateFanoutTuple(input: unknown): FanoutTupleValidation {
  if (!isNonNullObject(input)) return { valid: false, reason: 'not-an-object' };
  if (!hasOwn(input, 'status') || input.status !== 'delivery-fanned-out') {
    return { valid: false, reason: 'unexpected-status' };
  }
  if (!hasOwn(input, 'deliveryFanoutState')) {
    return { valid: false, reason: 'missing-delivery-fanout-state' };
  }

  if (input.deliveryFanoutState === 'completed') {
    if (hasOwnMeaningfulValue(input, 'targetingFailureReason')) {
      return { valid: false, reason: 'completed-with-failure-reason' };
    }
    if (
      !hasOwn(input, 'targetInstallationCountAtFanout') ||
      !isValidNonNegativeInteger(input.targetInstallationCountAtFanout) ||
      input.targetInstallationCountAtFanout > MAX_TARGET_INSTALLATIONS
    ) {
      return { valid: false, reason: 'invalid-target-count' };
    }
    if (!hasOwn(input, 'excludedMalformedInstallationCount') || !isValidNonNegativeInteger(input.excludedMalformedInstallationCount)) {
      return { valid: false, reason: 'invalid-excluded-count' };
    }
    if (input.targetInstallationCountAtFanout + input.excludedMalformedInstallationCount > MAX_TARGET_INSTALLATIONS) {
      return { valid: false, reason: 'invalid-count-arithmetic' };
    }
    // CODEX REPAIR ROUND (H1) — a 'completed' fanout MUST carry a well-formed
    // fanoutExecutionId as an own, meaningful property; anything else (absent, null,
    // malformed format, inherited-only) fails closed. This is the field final
    // authorization compares against the delivery child's own fanoutExecutionIdAtCreation.
    if (!hasOwnMeaningfulValue(input, 'fanoutExecutionId') || !isValidOpaqueIdFormat(input.fanoutExecutionId)) {
      return { valid: false, reason: 'invalid-fanout-execution-id' };
    }
    return {
      valid: true,
      outcome: {
        status: 'delivery-fanned-out',
        deliveryFanoutState: 'completed',
        targetInstallationCountAtFanout: input.targetInstallationCountAtFanout,
        excludedMalformedInstallationCount: input.excludedMalformedInstallationCount,
        fanoutExecutionId: input.fanoutExecutionId,
      },
    };
  }

  if (input.deliveryFanoutState === 'failed') {
    if (hasOwnMeaningfulValue(input, 'targetInstallationCountAtFanout')) {
      return { valid: false, reason: 'failed-with-nonnull-target-count' };
    }
    // CODEX REPAIR ROUND (H1) — a 'failed' fanout must never masquerade as having
    // successful provenance: any MEANINGFUL fanoutExecutionId present on a failed tuple
    // (even a well-formed one) is itself a contradiction and fails closed.
    if (hasOwnMeaningfulValue(input, 'fanoutExecutionId')) {
      return { valid: false, reason: 'failed-with-fanout-execution-id' };
    }
    if (!hasOwn(input, 'targetingFailureReason')) {
      return { valid: false, reason: 'unrecognized-or-missing-failure-reason' };
    }

    if (input.targetingFailureReason === 'installation-count-exceeds-cap') {
      if (!hasOwn(input, 'observedTargetCountAtLeast') || input.observedTargetCountAtLeast !== FANOUT_QUERY_LIMIT) {
        return { valid: false, reason: 'invalid-observed-count' };
      }
      return {
        valid: true,
        outcome: {
          status: 'delivery-fanned-out',
          deliveryFanoutState: 'failed',
          targetingFailureReason: 'installation-count-exceeds-cap',
          targetInstallationCountAtFanout: null,
          observedTargetCountAtLeast: FANOUT_QUERY_LIMIT,
        },
      };
    }

    if (input.targetingFailureReason === 'unexpected-preexisting-delivery') {
      return {
        valid: true,
        outcome: {
          status: 'delivery-fanned-out',
          deliveryFanoutState: 'failed',
          targetingFailureReason: 'unexpected-preexisting-delivery',
          targetInstallationCountAtFanout: null,
        },
      };
    }

    return { valid: false, reason: 'unrecognized-or-missing-failure-reason' };
  }

  return { valid: false, reason: 'invalid-delivery-fanout-state' };
}

// ---------------------------------------------------------------------------------------
// COMPLETE PERSISTED-DELIVERY VALIDATOR — Codex repair round (originally M1, Step 3C-2;
// PROMOTED here from reminderDeliveryWorker.ts in the Step 3C-3 H2/section-11 repair round
// so it can be a SINGLE shared source of truth for BOTH queue acquisition
// (reminderDeliveryWorker.ts's acquireDeliveryProcessingLease) AND final authorization
// (reminderDeliveryAuth.ts's finalizeDeliveryAuthorization) — validateDeliverySchema alone
// proves only the CORE fields are well-typed; it does NOT prove the document is
// trustworthy enough to actually acquire a lease on OR to finalize. Every queued/preparing
// delivery must pass this BEFORE either operation may proceed.
// ---------------------------------------------------------------------------------------

export type PersistedDeliveryValidation =
  | {
      valid: true;
      uid: string;
      installationId: string;
      targetSnapshot: TargetSnapshot;
      processingAttemptCount: number;
      fanoutExecutionIdAtCreation: string;
    }
  | { valid: false; reason: string };

// `refId` is the delivery document's OWN id (installationId-by-construction, per this
// codebase's deterministic child-path convention) — passed in by the caller from `ref.id`,
// never re-derived. Every failure reason below is a FIXED internal enum string; none of
// them ever embed a raw field value.
export function validatePersistedDeliveryForProcessing(refId: unknown, data: Record<string, unknown>): PersistedDeliveryValidation {
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
  if (!isValidOpaqueIdFormat(data.deliveryPublicId)) {
    return { valid: false, reason: 'invalid-delivery-public-id-format' };
  }

  // FANOUT EXECUTION ID (Codex repair round, H1/H2): structural format only here — this
  // function has no access to the parent document, so it cannot prove EQUALITY against
  // parent.fanoutExecutionId (that is final authorization's own, additional responsibility
  // — see reminderDeliveryAuth.ts). This only proves the delivery's own claimed value is
  // well-formed, exactly like the deliveryPublicId check immediately above.
  if (!isValidOpaqueIdFormat(data.fanoutExecutionIdAtCreation)) {
    return { valid: false, reason: 'invalid-fanout-execution-id-format' };
  }

  // ATTEMPT HISTORY: bounded length, strictly sequential attemptNumber, fixed-enum
  // outcomeCategory only, and rejects any entry carrying an unexpected own property —
  // closing the "secret-bearing history entry" attack.
  const historyValidation = validateAttemptHistory(data.attemptHistory);
  if (!historyValidation.valid) return { valid: false, reason: 'invalid-attempt-history' };

  // TARGET SNAPSHOT: validateDeliverySchema's own internal target-snapshot check only
  // requires installationAudienceId to be a nonempty string — NOT the actual production
  // audience-ID grammar. Re-validated here against the real grammar
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
    fanoutExecutionIdAtCreation: data.fanoutExecutionIdAtCreation as string,
  };
}
