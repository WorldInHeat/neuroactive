// functions/src/fcmTransport.ts
// Phase 3A-3 Step 3B — FCM HTTP v1 transport boundary. TRANSPORT ONLY: this file knows
// nothing about pushInstallations, reminder/delivery documents, or Firestore. It is a
// narrow, independently-testable wrapper around exactly one external call: a single FCM
// v1 `messages:send` POST.
//
// WHY THIS FILE EXISTS INSTEAD OF `getMessaging().send()`: the installed firebase-admin
// (14.2.0) Messaging client hardcodes an internal retry policy — up to 4 automatic
// retries (with backoff) on HTTP 503, `ECONNRESET`, and even its OWN internal request
// timeout — see functions/node_modules/firebase-admin/lib/utils/api-request.js's
// `defaultRetryConfig()`/`RequestClient.isRetryEligible()`, wired in with no public
// override point. None of those retry conditions proves FCM never received/processed the
// first attempt, so silently resending under any of them risks a duplicate notification.
//
// THIRD CODEX REPAIR ROUND — WHY THIS FILE NO LONGER USES `fetch` EITHER: the prior two
// rounds built this transport on Node's global `fetch`, reasoning that "one `fetch()`
// call" was structurally equivalent to "one physical HTTP POST." Codex correctly rejected
// that: `fetch` follows the WHATWG Fetch algorithm, which can internally replay a
// replayable request (e.g. after certain HTTP/2 connection-coalescing conditions signaled
// by a 421 response) as an implementation detail below the level our source code
// controls — so "one source-level `fetch()` call" does NOT provably mean "one wire POST."
// This file now talks to FCM using Node's built-in `node:https` module directly
// (`https.request`), which has NO such algorithm layered on top of it: it is a thin
// wrapper around a single TCP/TLS connection and a single HTTP request/response exchange,
// with no automatic redirect-following, no automatic replay-after-misdirected-request
// behavior, and no retry logic of any kind. `sendFcmOnce` below calls its injectable
// `requestImpl` (production default: `https.request`) EXACTLY ONCE per invocation, and
// every subsequent step (write, end, timeout, response handling) operates on that SAME
// request/response pair — there is no code path anywhere in this file that constructs a
// second request object.
//
// DELIBERATELY NOT IMPORTED HERE, and must never be: `fetch` (global or otherwise),
// `undici`, `firebase-admin/messaging` (`getMessaging`), `firebase-admin` generally,
// `google-auth-library`'s `.request()`, and `gaxios`. OAuth access-token ACQUISITION is a
// separate, recoverable, pre-send-boundary concern — `sendFcmOnce` below takes an
// already-obtained `accessToken` as a plain string parameter and never fetches or
// refreshes one itself. This keeps a 401 response from this transport structurally
// incapable of triggering an automatic refresh-and-resend inside the same call: there is
// no token-refresh code path in this file at all for a 401 (or any other status) to
// reach.
//
// FIRST REPAIR ROUND (response-provenance hardening) — corrected an earlier assumption
// that ANY complete HTTP response was definitive, trustworthy provenance of
// non-acceptance. A server/gateway-class response (>= 500) can be emitted by intermediate
// infrastructure AFTER the underlying send already reached — or was accepted by —
// another part of the distributed system, so those are unconditionally `unknown-outcome`
// regardless of body shape.
//
// SECOND REPAIR ROUND (contradiction hardening) — a well-formed `google.rpc.Status` body
// on its own still wasn't enough: this round added the requirement that the body's own
// `error.code` agree with the actual HTTP status line, and that the body's `error.status`
// string match the CANONICAL value for each known category, before any definitive
// classification is possible. Also added 408/425 (gateway/intermediary provenance,
// treated like >=500), hardened 3xx handling in the pure classifier (defense in depth —
// production never sees 3xx since redirects are never followed by `https.request`
// either), tightened the accepted-message-name check to an anchored resource-name
// pattern, and switched response-body decoding to a FATAL UTF-8 decoder so malformed
// transport bytes fail closed instead of being replacement-decoded into apparently-valid
// JSON.
//
// THIRD REPAIR ROUND, beyond the fetch->https.request replacement above: added HTTP 421
// to the same "gateway/intermediary provenance, always unknown-outcome" bucket as
// 408/425/>=500; added a check for non-200 2xx statuses (FCM's documented contract only
// ever uses 200 for success — 201/202/204/206 etc. are `unexpected-response`, never
// treated as accepted); and stopped surfacing ANY provider-controlled free-text string in
// the returned `FcmSendOutcome` at all — `category` alone now conveys everything a caller
// needs (`errorStatus`/`fcmErrorCode` string fields have been removed from the outcome
// type entirely, not merely allowlisted).
//
// FINAL (FOURTH) REPAIR ROUND — this file previously also extracted a `detail` string from
// caught/emitted EXCEPTION objects (a request's `error` event, a `write()`/`end()` throw,
// a `requestImpl` construction throw, a JSON.stringify throw) via a "hostile-input-safe"
// helper that guarded every property read individually. Codex correctly pointed out that
// "safe to read" and "safe to RETURN" are different guarantees: a hostile serialization
// getter, a hostile `toJSON`, a wrapped `requestImpl`, or an emitted `error` event could
// legitimately place an FCM token / OAuth access token / any other secret directly in
// `error.name`, `error.code`, or `error.cause.code` as an ordinary, non-throwing string
// value — and the old helper would have faithfully copied that value into the returned
// outcome, exactly the leak this whole file exists to prevent elsewhere. The fix is not
// "guard the read more" — no guarding of a read makes returning the result of that read
// safe, when the read's SOURCE is untrusted. Every exception-derived catch/error-handler
// in this file now reads NOTHING off the caught/emitted value at all (the catch/handler
// parameter is simply never bound — see e.g. `catch { ... }` with no binding — which is a
// stronger, structural guarantee than "reads it but discards it") and returns only a
// FIXED, this-file-authored outcome. `detail` still exists on `unknown-outcome` and
// `request-not-attempted`, but is now populated ONLY from fixed string literals this file
// itself wrote and/or `httpStatus` (a small protocol integer, never free text) — never
// from any thrown/emitted value. The `safeGet`/`safeErrorDetail`/`isAbortError` helpers
// this used to require are gone entirely: with nothing left that needs to read an
// exception's properties, keeping a "safe to read" helper around would just be dead
// security-sensitive code.
//
// LOGGING: this file contains zero `console.*` calls. It only ever returns a structured
// `FcmSendOutcome`; deciding what (if anything) to log is entirely the caller's
// responsibility.
'use strict';

import * as https from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';

const FCM_SEND_HOST = 'fcm.googleapis.com';
// This transport is single-project production infrastructure — the endpoint and the
// accepted-message resource-name prefix are both anchored to this one fixed constant,
// never derived from caller input. A `projectId` parameter is still accepted (see
// `SendFcmOnceParams`) purely so callers/tests can assert-and-fail-safe against a
// configuration mistake, but any value other than this exact constant is refused BEFORE
// any serialization or network attempt — see `sendFcmOnce`'s first check.
export const FCM_PROJECT_ID = 'neuroactive';
// Exact detail-type string FCM v1 uses for its structured error detail, matching what the
// installed Admin SDK's OWN error mapping already uses — see
// functions/node_modules/firebase-admin/lib/messaging/messaging-errors-internal.js's
// `getErrorCode()`.
const FCM_ERROR_DETAIL_TYPE = 'type.googleapis.com/google.firebase.fcm.v1.FcmError';

/** Single-attempt wall-clock timeout, covering connection establishment, the TLS
 * handshake, writing the request, waiting for response headers, AND complete bounded
 * response-body consumption — one absolute deadline for the entire operation. Enforced
 * via an explicit `setTimeout` that destroys the request/socket, deliberately NOT via
 * `ClientRequest#setTimeout`, whose semantics are a SOCKET INACTIVITY timer (resets on
 * any traffic) rather than an absolute wall-clock budget — those are not the same thing,
 * and this transport wants the latter. */
export const DEFAULT_FCM_SEND_TIMEOUT_MS = 10_000;

/** Bounded response-body read limit. FCM's real responses are tiny (a short JSON object);
 * this exists purely to stop an adversarial or misbehaving intermediary from forcing this
 * process to buffer an unbounded response. */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------------------
// OUTCOME TYPES.
//
// Five distinct kinds a future delivery state machine must be able to tell apart (do not
// collapse any of these into another):
//   A. `accepted`               — FCM confirmed the message was created.
//   B/C. `rejected`             — a DEFINITIVE, well-formed, trustworthy FCM rejection.
//        `category: 'retryable-later'` is a CLASSIFICATION ONLY (well-formed, coherent
//        429 RESOURCE_EXHAUSTED) — this transport never retries anything itself.
//        THIRD REPAIR ROUND: `rejected` no longer carries any provider-controlled free
//        text (`errorStatus`/`fcmErrorCode` string fields were removed entirely) —
//        `category` is redundant-but-safe: by the time a category is assigned, this
//        file has already verified the canonical status string itself, so re-exposing
//        that same string would add no information while adding an arbitrary-text
//        surface to the outcome type. `httpStatus` (a small finite protocol integer, not
//        free text) is kept.
//   D. `unknown-outcome`        — no trustworthy provenance either way: timeouts,
//        network-layer failures, server/gateway-class (>=500, 408, 421, 425) responses
//        and 3xx regardless of body shape, non-200 2xx responses, and anything that
//        failed to parse into a documented FCM shape or agree with its own HTTP status.
//   E. `request-not-attempted`  — a LOCAL failure before any byte was ever sent toward
//        FCM (wrong project, the message failed to serialize, or `requestImpl` itself
//        threw synchronously before returning a request object). Distinct from D on
//        purpose: a future state machine can safely retry this without it ever having
//        consumed a send attempt or touched the network, which is not true of D.
// ---------------------------------------------------------------------------------------

export type FcmDefinitiveRejectionCategory =
  | 'invalid-argument'
  | 'unauthenticated'
  | 'permission-denied'
  | 'unregistered'
  | 'retryable-later'
  | 'other-definitive-rejection';

export type FcmUnknownOutcomeReason =
  | 'timeout'
  | 'network-error'
  | 'malformed-response'
  | 'contradictory-response'
  | 'response-too-large'
  | 'ambiguous-server-response'
  | 'unexpected-response'
  | 'unexpected-exception';

export type FcmLocalFailureReason = 'wrong-project' | 'serialization-failed' | 'request-construction-failed';

export type FcmSendOutcome =
  | { kind: 'accepted'; httpStatus: 200; messageName: string }
  | { kind: 'rejected'; httpStatus: number; category: FcmDefinitiveRejectionCategory }
  // `detail` on both variants below is ONLY ever populated from fixed string literals
  // this file itself wrote and/or `httpStatus` (a small protocol integer) — NEVER from a
  // caught exception's or emitted error's properties. See the "SECRECY INVARIANT" comment
  // above the transport section.
  | { kind: 'unknown-outcome'; reason: FcmUnknownOutcomeReason; detail?: string }
  | { kind: 'request-not-attempted'; reason: FcmLocalFailureReason; detail?: string };

/**
 * Plain description of whatever the transport layer actually observed. Kept separate from
 * `sendFcmOnce`'s network call so the classification rules below are a pure function,
 * testable without any network access or injected request stub at all.
 */
export type RawFcmTransportResult =
  | { kind: 'response'; httpStatus: number; rawBody: string }
  | { kind: 'timeout' }
  // FINAL REPAIR (classifier-secrecy hardening): `network-error` carries NO payload at
  // all — no `detail` field of any kind. An exported classifier accepting a
  // caller-supplied `{ kind: 'network-error', detail: string }` shape would let a
  // fabricated/adversarial call (e.g. `classifyFcmTransportResult({ kind:
  // 'network-error', detail: 'Bearer <secret>' } as any)`) inject arbitrary text straight
  // into a returned `FcmSendOutcome`, regardless of what production `sendFcmOnce` itself
  // ever actually passes. Removing the field is a stronger guarantee than "production
  // never populates it with anything unsafe" — it makes the unsafe shape
  // impossible to express through this type at all.
  | { kind: 'network-error' }
  // The two conditions that previously reused `network-error` with a fixed `detail`
  // string ('aborted' / 'closed-before-end') are now their own zero-payload discriminated
  // kinds instead — the fixed label is authored directly inside
  // `classifyFcmTransportResult`'s switch body (see below), never read off this input
  // object, so there is no field here for a caller to inject into either.
  | { kind: 'response-aborted' }
  | { kind: 'response-closed-before-end' }
  | { kind: 'response-too-large' }
  | { kind: 'malformed-encoding' }
  | { kind: 'unexpected-exception' };

function isNonNullObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A strict `google.rpc.Status`-shaped error, required before ANY non-2xx response is
 * treated as a definitive rejection. Rejects `{"error":null}`, `{"error":true}`,
 * `{"error":{}}`, and `{}` — all of those become `unknown-outcome`/`malformed-response`,
 * never an assumed rejection. `message` is deliberately never extracted or exposed here —
 * it is provider-supplied free text and must never be logged. `fcmErrorCode` is
 * intentionally typed as a fixed literal union (currently just `'UNREGISTERED'`), never a
 * bare `string` — any OTHER provider-supplied detail errorCode is discarded during
 * parsing itself, before it ever exists as a value anywhere else in this file.
 */
type FcmKnownErrorCode = 'UNREGISTERED';

interface GoogleRpcStatus {
  code: number;
  status: string;
  fcmErrorCode?: FcmKnownErrorCode;
}

function parseGoogleRpcStatus(parsed: unknown): GoogleRpcStatus | null {
  if (!isNonNullObject(parsed)) return null;
  const error = parsed.error;
  if (!isNonNullObject(error)) return null;

  const code = error.code;
  if (typeof code !== 'number' || !Number.isFinite(code) || !Number.isInteger(code)) return null;

  const status = error.status;
  if (typeof status !== 'string' || status.length === 0) return null;

  let fcmErrorCode: FcmKnownErrorCode | undefined;
  const details = error.details;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (isNonNullObject(detail) && detail['@type'] === FCM_ERROR_DETAIL_TYPE && detail.errorCode === 'UNREGISTERED') {
        // Only ever recognizes the exact known literal — any other provider-supplied
        // errorCode string is discarded right here rather than carried forward.
        fcmErrorCode = 'UNREGISTERED';
        break;
      }
    }
  }
  return { code, status, fcmErrorCode };
}

/**
 * Canonical HTTP-status <-> google.rpc.Status <-> (optional) typed-detail mapping for the
 * handful of categories this transport gives a specific label to. Only ever called after
 * `classifyResponse` has already confirmed `rpcStatus.code === httpStatus`.
 */
function classifyCoherentRejection(httpStatus: number, rpcStatus: GoogleRpcStatus): FcmSendOutcome {
  const contradictoryCanonicalStatus = (expected: string): FcmSendOutcome => ({
    kind: 'unknown-outcome',
    reason: 'contradictory-response',
    detail: `status ${httpStatus} expected canonical body status ${JSON.stringify(expected)}`,
  });

  if (httpStatus === 400) {
    if (rpcStatus.status !== 'INVALID_ARGUMENT') return contradictoryCanonicalStatus('INVALID_ARGUMENT');
    return { kind: 'rejected', httpStatus, category: 'invalid-argument' };
  }

  if (httpStatus === 401) {
    if (rpcStatus.status !== 'UNAUTHENTICATED') return contradictoryCanonicalStatus('UNAUTHENTICATED');
    return { kind: 'rejected', httpStatus, category: 'unauthenticated' };
  }

  if (httpStatus === 403) {
    if (rpcStatus.status !== 'PERMISSION_DENIED') return contradictoryCanonicalStatus('PERMISSION_DENIED');
    return { kind: 'rejected', httpStatus, category: 'permission-denied' };
  }

  if (httpStatus === 429) {
    if (rpcStatus.status !== 'RESOURCE_EXHAUSTED') return contradictoryCanonicalStatus('RESOURCE_EXHAUSTED');
    return { kind: 'rejected', httpStatus, category: 'retryable-later' };
  }

  if (httpStatus === 404) {
    if (rpcStatus.status !== 'NOT_FOUND') return contradictoryCanonicalStatus('NOT_FOUND');
    // Token invalidation requires ALL of: HTTP 404, body code 404 (already verified by
    // the caller), canonical status NOT_FOUND (just verified above), AND a typed FcmError
    // detail with errorCode === 'UNREGISTERED'. A bare 404/NOT_FOUND without that typed
    // detail is a real, coherent, definitive rejection — just not proof the token itself
    // is dead, so future token-lifecycle (deactivation) code must not act on it.
    if (rpcStatus.fcmErrorCode === 'UNREGISTERED') {
      return { kind: 'rejected', httpStatus, category: 'unregistered' };
    }
    return { kind: 'rejected', httpStatus, category: 'other-definitive-rejection' };
  }

  // Any other coherent 4xx (code === httpStatus already verified, not one of the
  // canonical categories above, and httpStatus is provably not >=500/408/421/425/3xx per
  // the earlier checks in classifyResponse) — still trustworthy, well-formed provenance.
  return { kind: 'rejected', httpStatus, category: 'other-definitive-rejection' };
}

const FCM_MESSAGE_NAME_PATTERN = new RegExp(
  // `FCM_PROJECT_ID` is a fixed literal with no regex metacharacters, so string
  // interpolation into the pattern is safe without a separate escaping step.
  `^projects/${FCM_PROJECT_ID}/messages/[^\\s\\x00-\\x1F\\x7F/]+$`
);

function classifyAccepted(parsed: unknown): FcmSendOutcome {
  if (!isNonNullObject(parsed) || Array.isArray(parsed)) {
    return { kind: 'unknown-outcome', reason: 'malformed-response', detail: 'status 200 without a parseable message object' };
  }
  const name = parsed.name;
  if (typeof name !== 'string') {
    return { kind: 'unknown-outcome', reason: 'malformed-response', detail: 'status 200 without a string message name' };
  }
  // Requires an EXACT match of `projects/<FCM_PROJECT_ID>/messages/<message-id>`, where
  // `<message-id>` is a nonempty single path segment with no whitespace and no control
  // characters — rejects an empty/whitespace-only suffix, an extra path segment, a
  // trailing control character, and any other project's resource prefix.
  if (!FCM_MESSAGE_NAME_PATTERN.test(name)) {
    return { kind: 'unknown-outcome', reason: 'malformed-response', detail: 'status 200 with a message name that does not match the expected resource-name shape' };
  }
  return { kind: 'accepted', httpStatus: 200, messageName: name };
}

/**
 * Conservative classification order, deliberately structured so ambiguous provenance can
 * never be accidentally promoted to a definitive outcome:
 *   A. httpStatus >= 500                                -> unknown-outcome
 *   B. httpStatus in {408, 421, 425}                     -> unknown-outcome
 *   C. 300 <= httpStatus < 400                           -> unknown-outcome
 *   D. 200 < httpStatus < 300 (any non-200 2xx)          -> unknown-outcome
 *   E. body parse failure (not valid JSON)               -> unknown-outcome
 *   F. body does not parse into a strict google.rpc.Status, OR `error.code !== httpStatus`
 *                                                         -> unknown-outcome
 *   G/H/I. `classifyCoherentRejection` applies the canonical per-category mapping, only
 *      ever reached once A-F have all passed.
 */
function classifyResponse(httpStatus: number, rawBody: string): FcmSendOutcome {
  // A. Server/gateway-class status: NEVER definitive provenance of non-acceptance, no
  // matter how well-formed (or malformed) its body looks — an intermediary can emit one
  // after the send already reached, or was accepted by, another part of the distributed
  // system. Checked before any body parsing so every 5xx response reports this same
  // reason uniformly. Do not let FCM body shape override this ambiguity.
  if (httpStatus >= 500) {
    return { kind: 'unknown-outcome', reason: 'ambiguous-server-response', detail: `status ${httpStatus}` };
  }

  // B. 408 (Request Timeout), 421 (Misdirected Request), and 425 (Too Early) are all
  // intermediary/gateway-level signals that cannot prove whether the POST ever reached
  // (or was accepted by) FCM's backend — treated exactly like >=500, regardless of body
  // content. 421 in particular is the exact status the underlying WHATWG Fetch algorithm
  // can use as a trigger for connection-coalescing-related request replay; this transport
  // no longer uses fetch at all, but 421 is still classified this conservatively as
  // defense in depth.
  if (httpStatus === 408 || httpStatus === 421 || httpStatus === 425) {
    return { kind: 'unknown-outcome', reason: 'ambiguous-server-response', detail: `status ${httpStatus}` };
  }

  // C. Node's `https.request` never follows redirects on its own (there is no algorithm
  // layered on top of it that would, unlike `fetch`), so `sendFcmOnce` itself never hands
  // a 3xx status to this function in production — but the pure classifier must stay
  // conservative even when exercised directly/independently of the transport (defense in
  // depth).
  if (httpStatus >= 300 && httpStatus < 400) {
    return { kind: 'unknown-outcome', reason: 'ambiguous-server-response', detail: `status ${httpStatus}` };
  }

  // D. FCM's documented `messages:send` contract only ever uses HTTP 200 for success.
  // Any other 2xx (201/202/204/206/...) is unexpected — never treated as accepted, and
  // not routed through the rejection-classification machinery either, since it isn't a
  // rejection.
  if (httpStatus >= 200 && httpStatus < 300 && httpStatus !== 200) {
    return { kind: 'unknown-outcome', reason: 'unexpected-response', detail: `status ${httpStatus}` };
  }

  // E. Body must parse as JSON at all.
  let parsed: unknown;
  try {
    parsed = rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
  } catch {
    return { kind: 'unknown-outcome', reason: 'malformed-response', detail: `status ${httpStatus}: non-JSON body` };
  }

  if (httpStatus === 200) {
    return classifyAccepted(parsed);
  }

  const rpcStatus = parseGoogleRpcStatus(parsed);
  if (!rpcStatus) {
    // A non-2xx response we cannot parse into FCM's documented, strict
    // `google.rpc.Status` shape is not trustworthy provenance either way — conservative
    // unknown-outcome, not an assumed rejection.
    return { kind: 'unknown-outcome', reason: 'malformed-response', detail: `status ${httpStatus} without a recognizable google.rpc.Status error body` };
  }

  // F. HTTP/code CONSISTENCY. A well-formed body whose own `error.code` disagrees with
  // the actual HTTP status line is a contradictory, untrustworthy provider/gateway
  // response — e.g. an HTTP 429 wrapper around a body claiming `code: 401`. Refuse to
  // classify this as ANY definitive outcome — conservative unknown-outcome only.
  if (rpcStatus.code !== httpStatus) {
    return {
      kind: 'unknown-outcome',
      reason: 'contradictory-response',
      detail: `HTTP status ${httpStatus} does not match body error.code`,
    };
  }

  // G/H/I. Canonical per-category mapping, only reached once httpStatus and the body's
  // own `error.code` agree.
  return classifyCoherentRejection(httpStatus, rpcStatus);
}

/**
 * Pure classifier: maps whatever the transport layer observed to a definitive
 * `FcmSendOutcome`. Zero network access, zero Firebase imports — a plain function of its
 * input, exercised directly (without any request stub) in fcmTransport.test.ts.
 */
export function classifyFcmTransportResult(result: RawFcmTransportResult): FcmSendOutcome {
  switch (result.kind) {
    case 'timeout':
      return { kind: 'unknown-outcome', reason: 'timeout' };
    case 'network-error':
      // No `detail` — `result` carries no field to copy one from (see the type above),
      // and none is fabricated here either.
      return { kind: 'unknown-outcome', reason: 'network-error' };
    case 'response-aborted':
      // Fixed literal authored right here — never read off `result`, which carries no
      // payload for this kind.
      return { kind: 'unknown-outcome', reason: 'network-error', detail: 'aborted' };
    case 'response-closed-before-end':
      return { kind: 'unknown-outcome', reason: 'network-error', detail: 'closed-before-end' };
    case 'response-too-large':
      return { kind: 'unknown-outcome', reason: 'response-too-large' };
    case 'malformed-encoding':
      return { kind: 'unknown-outcome', reason: 'malformed-response', detail: 'response body was not valid UTF-8' };
    case 'unexpected-exception':
      return { kind: 'unknown-outcome', reason: 'unexpected-exception' };
    case 'response':
      return classifyResponse(result.httpStatus, result.rawBody);
  }
}

// ---------------------------------------------------------------------------------------
// TRANSPORT.
//
// SECRECY INVARIANT (final repair round): nothing below this point ever reads a property
// off a caught exception or an emitted `error` value. Every `catch`/error-handler either
// binds no parameter at all, or (where a parameter must be bound because a listener
// signature requires one) never references it. Every outcome returned from an
// exception-driven path is a fixed literal this file authored — never anything derived
// from the thrown/emitted value itself. This is intentional and must not be "improved" by
// adding diagnostic extraction back in.
// ---------------------------------------------------------------------------------------

/** Injectable factory matching the exact two-argument form this file actually calls
 * `https.request` with; production default is the real `https.request`. Kept narrow
 * (rather than the full overloaded `typeof https.request`) so test fakes stay simple
 * structural objects rather than needing to satisfy every overload. */
export type HttpsRequestImpl = (options: https.RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;

export interface SendFcmOnceParams {
  /** Must equal `FCM_PROJECT_ID` exactly. Kept as an explicit parameter (rather than
   * silently hardcoded with no caller-visible check) so a configuration mistake fails
   * loudly, locally, and before any network attempt — see the first check in
   * `sendFcmOnce`. */
  projectId: string;
  /** Already-obtained OAuth bearer token. This function never fetches or refreshes one. */
  accessToken: string;
  /** The FCM v1 `message` object verbatim (must include `token`); this transport does not
   * inspect, validate, or impose any reminder/delivery schema on its contents, and never
   * mutates the object the caller passed in. */
  message: Record<string, unknown>;
  timeoutMs?: number;
  /** Injectable for tests; defaults to the real `https.request`. */
  requestImpl?: HttpsRequestImpl;
}

/**
 * Performs exactly ONE FCM v1 `messages:send` POST — one `https.request(...)` call — and
 * returns a classified outcome. Never retries, never follows a redirect (`https.request`
 * has no redirect-following behavior at all, unlike `fetch`), never re-sends after a 401
 * or any other status. A single explicit wall-clock timer enforces `timeoutMs` (default
 * `DEFAULT_FCM_SEND_TIMEOUT_MS`) across the ENTIRE operation and destroys the SAME
 * request/socket on expiry — it never constructs a second request.
 *
 * This outer function is a last-resort safety net: no matter what happens inside
 * (including a hostile Proxy/throwing getter surfacing somewhere unexpected), the
 * returned promise always RESOLVES to an `FcmSendOutcome`, never rejects.
 */
export async function sendFcmOnce(params: SendFcmOnceParams): Promise<FcmSendOutcome> {
  try {
    return await sendFcmOnceInner(params);
  } catch {
    // Deliberately does not bind or inspect the caught value at all — see the SECRECY
    // INVARIANT comment above. A fixed outcome regardless of what was thrown.
    return { kind: 'unknown-outcome', reason: 'unexpected-exception' };
  }
}

async function sendFcmOnceInner(params: SendFcmOnceParams): Promise<FcmSendOutcome> {
  const { projectId, accessToken, message, timeoutMs = DEFAULT_FCM_SEND_TIMEOUT_MS, requestImpl = https.request } = params;

  if (projectId !== FCM_PROJECT_ID) {
    return { kind: 'request-not-attempted', reason: 'wrong-project', detail: `expected ${JSON.stringify(FCM_PROJECT_ID)}` };
  }

  // Ordering, deliberately: fixed-project validation, then message serialization, BOTH
  // before any network attempt. Either failing returns `request-not-attempted` with zero
  // `requestImpl` calls.
  let serializedBody: Buffer;
  try {
    const candidate = JSON.stringify({ message });
    if (typeof candidate !== 'string') {
      throw new TypeError('JSON.stringify produced a non-string result');
    }
    serializedBody = Buffer.from(candidate, 'utf-8');
  } catch {
    // Deliberately does not bind or inspect the caught value — a hostile getter/toJSON
    // could place a secret directly in an ordinary, non-throwing property (e.g.
    // `error.name`), so no amount of "safe" property reading makes returning it safe.
    return { kind: 'request-not-attempted', reason: 'serialization-failed' };
  }

  return new Promise<FcmSendOutcome>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let req: ClientRequest | undefined;

    const settle = (outcome: FcmSendOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try {
        req?.destroy();
      } catch {
        // Best-effort teardown only; never let this affect the outcome we're resolving.
      }
      resolve(outcome);
    };

    const options: https.RequestOptions = {
      hostname: FCM_SEND_HOST,
      port: 443,
      path: `/v1/projects/${FCM_PROJECT_ID}/messages:send`,
      method: 'POST',
      // No shared/keep-alive Agent — each attempt gets its own one-shot connection, so
      // there is no connection-reuse-related replay ambiguity to reason about.
      agent: false,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': serializedBody.byteLength,
      },
    };

    let createdReq: ClientRequest;
    try {
      createdReq = requestImpl(options, handleResponse);
    } catch {
      // requestImpl threw synchronously before returning a request object at all — no
      // socket/request was ever established, so this is a genuine local failure, exactly
      // like a project/serialization failure above. Does not bind/inspect the caught
      // value — see the SECRECY INVARIANT comment above.
      settle({ kind: 'request-not-attempted', reason: 'request-construction-failed' });
      return;
    }
    req = createdReq;

    timer = setTimeout(() => {
      settle({ kind: 'unknown-outcome', reason: 'timeout' });
    }, timeoutMs);

    req.on('error', () => {
      // Never reads the emitted error's properties — see the SECRECY INVARIANT comment.
      settle(classifyFcmTransportResult({ kind: 'network-error' }));
    });

    function handleResponse(res: IncomingMessage): void {
      if (settled) return; // e.g. the timeout already fired before headers arrived.

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let overflowed = false;

      res.on('data', (chunk: Buffer) => {
        if (settled || overflowed) return;
        totalBytes += chunk.byteLength;
        if (totalBytes > MAX_RESPONSE_BODY_BYTES) {
          overflowed = true;
          chunks.length = 0; // discard whatever was accumulated — never retained/returned/logged.
          try {
            res.destroy();
          } catch {
            // Best-effort only.
          }
          settle(classifyFcmTransportResult({ kind: 'response-too-large' }));
          return;
        }
        chunks.push(chunk);
      });

      res.on('error', () => {
        // Never reads the emitted error's properties — see the SECRECY INVARIANT comment.
        if (settled || overflowed) return;
        settle(classifyFcmTransportResult({ kind: 'network-error' }));
      });

      res.on('aborted', () => {
        if (settled || overflowed) return;
        settle(classifyFcmTransportResult({ kind: 'response-aborted' }));
      });

      res.on('close', () => {
        // A response that closes without ever reaching 'end' (and wasn't already settled
        // by 'error'/'aborted'/size-overflow) is incomplete provenance — conservative
        // unknown-outcome, never an assumed classification of whatever partial bytes
        // arrived.
        if (settled || overflowed) return;
        settle(classifyFcmTransportResult({ kind: 'response-closed-before-end' }));
      });

      res.on('end', () => {
        if (settled || overflowed) return;

        let rawBody: string;
        try {
          rawBody = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        } catch {
          settle(classifyFcmTransportResult({ kind: 'malformed-encoding' }));
          return;
        }

        const statusCode = typeof res.statusCode === 'number' ? res.statusCode : 0;
        settle(classifyFcmTransportResult({ kind: 'response', httpStatus: statusCode, rawBody }));
      });
    }

    try {
      req.write(serializedBody);
      req.end();
    } catch {
      // Once the request object exists, we cannot prove zero bytes were sent even if
      // write()/end() itself threw synchronously — do not overclaim request-not-attempted
      // here. Conservative unknown-outcome; duplicate avoidance wins. Does not bind/inspect
      // the caught value — see the SECRECY INVARIANT comment above.
      settle(classifyFcmTransportResult({ kind: 'network-error' }));
    }
  });
}
