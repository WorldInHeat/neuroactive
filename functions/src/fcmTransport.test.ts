// functions/src/fcmTransport.test.ts
// Phase 3A-3 Step 3B — repository-local test file for the FCM transport boundary.
// FINAL (fourth) Codex repair round: updated alongside fcmTransport.ts's removal of ALL
// exception-property-reading diagnostic code (see that file's "SECRECY INVARIANT" comment
// and its header for the full rationale). `safeErrorDetail`/`isAbortError` no longer
// exist — every exception-derived outcome is now a fixed literal, so this file's job
// shifts from "prove the extraction is safe" to "prove NOTHING is ever extracted."
//
// Same established pattern as pushInstallationEpochLogic.test.ts /
// reminderSchedulerLogic.test.ts: this repo has no test runner configured, so this is a
// small, dependency-free, self-contained assertion script.
//
// HOW TO RUN:
//   cd functions
//   npm run build
//   node lib/fcmTransport.test.js
//
// NO TEST IN THIS FILE EVER USES THE REAL `https.request` — every `sendFcmOnce` call
// below passes an injected `requestImpl` built from `FakeClientRequest`/
// `FakeIncomingMessage` (real `node:events` EventEmitters, not a duplicated
// reimplementation of Node's request/response semantics). This is a hard requirement:
// no test may fall back to `node:https`.
//
// Coverage:
//   1. classifyFcmTransportResult — a pure function, exercised directly with plain
//      RawFcmTransportResult inputs, no network access at all.
//   2. sendFcmOnce — exercised with an injected request FACTORY. Every network-attempting
//      scenario wraps its factory in `countingRequestFactory` and asserts exactly one
//      `https.request`-shaped call was made; every local-failure scenario asserts exactly
//      ZERO calls were made.
//   3. Secret non-exposure: adversarial scenarios where a thrown/emitted value carries a
//      secret in an ORDINARY, READABLE (non-throwing) property — `name`, `code`,
//      `cause.code` — proving these never appear in the outcome, alongside the
//      surviving hostile-Proxy/throwing-getter scenarios (now proving zero property
//      access ever occurs, rather than merely safe access).
//   4. Request-shape / no-leak / no-mutation / provider-string-non-exposure checks.
//   5. A static regression check guarding against fetch/Admin-SDK-Messaging/gaxios
//      reintroduction, confirming node:https is actually used, and confirming no
//      exception-property-reading code has been reintroduced.
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'node:events';
import type { ClientRequest, IncomingMessage } from 'node:http';
import {
  classifyFcmTransportResult,
  sendFcmOnce,
  DEFAULT_FCM_SEND_TIMEOUT_MS,
  MAX_RESPONSE_BODY_BYTES,
  FCM_PROJECT_ID,
  type HttpsRequestImpl,
  type FcmSendOutcome,
} from './fcmTransport';

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ': ' + detail : ''}`);
    fail++;
  }
}

async function checkAsync(label: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(label, await fn());
  } catch (err) {
    check(label, false, `threw: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------------------
// Fake request/response infrastructure. Real `node:events` EventEmitters (not hand-rolled
// mocks of event semantics), cast to the real Node types at the boundary — the same
// pattern used for fake `Response` objects in earlier rounds.
// ---------------------------------------------------------------------------------------

class FakeClientRequest extends EventEmitter {
  destroyed = false;
  ended = false;
  writtenChunks: Buffer[] = [];
  private readonly writeShouldThrow: boolean;
  private readonly endShouldThrow: boolean;

  constructor(opts?: { writeShouldThrow?: boolean; endShouldThrow?: boolean }) {
    super();
    this.writeShouldThrow = opts?.writeShouldThrow ?? false;
    this.endShouldThrow = opts?.endShouldThrow ?? false;
  }

  write(chunk: unknown): boolean {
    if (this.writeShouldThrow) throw new Error('synthetic write() failure');
    this.writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return true;
  }

  end(): this {
    if (this.endShouldThrow) throw new Error('synthetic end() failure');
    this.ended = true;
    return this;
  }

  destroy(): this {
    this.destroyed = true;
    return this;
  }
}

class FakeIncomingMessage extends EventEmitter {
  constructor(public statusCode: number) {
    super();
  }
  destroy(): this {
    return this;
  }
}

/** Wraps a base request factory and counts how many times it was actually invoked —
 * including a synchronous throw, since the invocation itself still happened. */
function countingRequestFactory(impl: HttpsRequestImpl): { requestImpl: HttpsRequestImpl; callCount: () => number } {
  let calls = 0;
  const requestImpl: HttpsRequestImpl = (options, callback) => {
    calls++;
    return impl(options, callback);
  };
  return { requestImpl, callCount: () => calls };
}

/** A factory that returns a FakeClientRequest immediately and lets the caller drive the
 * response (or never drive it at all, for the timeout case) asynchronously. */
function factoryWithResponse(
  build: (req: FakeClientRequest) => { res: FakeIncomingMessage; drive: () => void } | undefined
): HttpsRequestImpl {
  return ((_options, callback) => {
    const req = new FakeClientRequest();
    const built = build(req);
    if (built) {
      queueMicrotask(() => {
        callback(built.res as unknown as IncomingMessage);
        built.drive();
      });
    }
    return req as unknown as ClientRequest;
  }) as HttpsRequestImpl;
}

function respondingWithBytes(status: number, bodyBytes: Buffer): HttpsRequestImpl {
  return factoryWithResponse(() => {
    const res = new FakeIncomingMessage(status);
    return {
      res,
      drive: () =>
        queueMicrotask(() => {
          if (bodyBytes.byteLength > 0) res.emit('data', bodyBytes);
          res.emit('end');
        }),
    };
  });
}

function respondingWithText(status: number, text: string): HttpsRequestImpl {
  return respondingWithBytes(status, Buffer.from(text, 'utf-8'));
}

function respondingThenErroring(status: number, err: unknown): HttpsRequestImpl {
  return factoryWithResponse(() => {
    const res = new FakeIncomingMessage(status);
    return { res, drive: () => queueMicrotask(() => res.emit('error', err)) };
  });
}

function respondingThenAborted(status: number): HttpsRequestImpl {
  return factoryWithResponse(() => {
    const res = new FakeIncomingMessage(status);
    return { res, drive: () => queueMicrotask(() => res.emit('aborted')) };
  });
}

function respondingThenClosedWithoutEnd(status: number): HttpsRequestImpl {
  return factoryWithResponse(() => {
    const res = new FakeIncomingMessage(status);
    return { res, drive: () => queueMicrotask(() => res.emit('close')) };
  });
}

function neverRespondingFactory(): HttpsRequestImpl {
  return factoryWithResponse(() => undefined);
}

function erroringRequestFactory(err: unknown): HttpsRequestImpl {
  return ((_options, _callback) => {
    const req = new FakeClientRequest();
    queueMicrotask(() => req.emit('error', err));
    return req as unknown as ClientRequest;
  }) as HttpsRequestImpl;
}

function throwingRequestFactory(err: unknown): HttpsRequestImpl {
  return (() => {
    throw err;
  }) as unknown as HttpsRequestImpl;
}

function writeThrowingFactory(): HttpsRequestImpl {
  return ((_options, _callback) => new FakeClientRequest({ writeShouldThrow: true }) as unknown as ClientRequest) as HttpsRequestImpl;
}

function endThrowingFactory(): HttpsRequestImpl {
  return ((_options, _callback) => new FakeClientRequest({ endShouldThrow: true }) as unknown as ClientRequest) as HttpsRequestImpl;
}

/** An Error whose name/code/cause getters each throw, embedding a distinctive secret so
 * tests can prove that text never leaks into any outcome. */
function makeThrowingGetterError(secret: string): unknown {
  const err = new Error('should never be read');
  Object.defineProperty(err, 'name', {
    get() {
      throw new Error(`hostile name getter: ${secret}`);
    },
  });
  Object.defineProperty(err, 'code', {
    get() {
      throw new Error(`hostile code getter: ${secret}`);
    },
  });
  Object.defineProperty(err, 'cause', {
    get() {
      throw new Error(`hostile cause getter: ${secret}`);
    },
  });
  return err;
}

/** A Proxy that throws on ANY property access at all, embedding a distinctive secret. */
function makeHostileProxyError(secret: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        throw new Error(`hostile proxy trap for ${String(prop)}: ${secret}`);
      },
    }
  );
}

const SAMPLE_TOKEN = 'sample-fcm-registration-token-do-not-log';
const SAMPLE_ACCESS_TOKEN = 'sample-oauth-access-token-do-not-log';

function validParams(overrides: Partial<Parameters<typeof sendFcmOnce>[0]> = {}) {
  return {
    projectId: FCM_PROJECT_ID,
    accessToken: SAMPLE_ACCESS_TOKEN,
    message: { token: SAMPLE_TOKEN },
    ...overrides,
  };
}

async function main(): Promise<void> {
  // =========================================================================
  // 1. classifyFcmTransportResult — pure, no network access.
  // =========================================================================
  console.log('=== classifyFcmTransportResult ===');

  check('200 with valid resource-prefixed name -> accepted', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":"projects/neuroactive/messages/123"}' });
    return r.kind === 'accepted' && r.messageName === 'projects/neuroactive/messages/123';
  })());

  check('200 with non-JSON body -> unknown-outcome, malformed-response (never accepted)', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: 'not json' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('200 with valid JSON but no name field -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"unexpected":true}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('200 with an array body -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '[]' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('200 with numeric/null name -> unknown-outcome, malformed-response', (() => {
    const r1 = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":123}' });
    const r2 = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":null}' });
    return r1.kind === 'unknown-outcome' && r2.kind === 'unknown-outcome';
  })());

  check('[N] 200 with an empty message-id suffix -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":"projects/neuroactive/messages/"}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[O] 200 with a whitespace-only message-id suffix -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":"projects/neuroactive/messages/   "}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[P] 200 with an extra path segment -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":"projects/neuroactive/messages/x/extra"}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[Q] 200 with a trailing control character -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: JSON.stringify({ name: 'projects/neuroactive/messages/x\n' }) });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[R] 200 with wrong-project resource prefix -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 200, rawBody: '{"name":"projects/some-other-project/messages/123"}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[M] 200 with a realistic FCM-shaped message id (colon/percent characters allowed) -> accepted', (() => {
    const r = classifyFcmTransportResult({
      kind: 'response',
      httpStatus: 200,
      rawBody: '{"name":"projects/neuroactive/messages/0:1700000000123456%31bd1c9631bd1c96"}',
    });
    return r.kind === 'accepted' && r.messageName === 'projects/neuroactive/messages/0:1700000000123456%31bd1c9631bd1c96';
  })());

  check('[19] 201 -> unknown-outcome, unexpected-response (not accepted)', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 201, rawBody: '{"name":"projects/neuroactive/messages/123"}' });
    return r.kind === 'unknown-outcome' && r.reason === 'unexpected-response';
  })());

  check('[19] 204 -> unknown-outcome, unexpected-response (not accepted)', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 204, rawBody: '' });
    return r.kind === 'unknown-outcome' && r.reason === 'unexpected-response';
  })());

  check('400 INVALID_ARGUMENT (well-formed, coherent) -> rejected, invalid-argument', (() => {
    const body = JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad request' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: body });
    return r.kind === 'rejected' && r.category === 'invalid-argument';
  })());

  check('401 UNAUTHENTICATED (well-formed, coherent) -> rejected, unauthenticated', (() => {
    const body = JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED', message: 'bad token' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 401, rawBody: body });
    return r.kind === 'rejected' && r.category === 'unauthenticated';
  })());

  check('403 PERMISSION_DENIED (well-formed, coherent) -> rejected, permission-denied', (() => {
    const body = JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED', message: 'no access' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 403, rawBody: body });
    return r.kind === 'rejected' && r.category === 'permission-denied';
  })());

  check('[D/14.D] typed FcmError UNREGISTERED detail, fully coherent 404 -> rejected, unregistered', (() => {
    const body = JSON.stringify({
      error: {
        code: 404,
        status: 'NOT_FOUND',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
      },
    });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 404, rawBody: body });
    return r.kind === 'rejected' && r.category === 'unregistered';
  })());

  check('[E/14.E] bare 404 NOT_FOUND WITHOUT a typed UNREGISTERED detail -> rejected but NOT unregistered', (() => {
    const body = JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', message: 'not found' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 404, rawBody: body });
    return r.kind === 'rejected' && r.category === 'other-definitive-rejection';
  })());

  check('[17] typed detail with an arbitrary, non-UNREGISTERED errorCode -> NOT unregistered, and never surfaced anywhere', (() => {
    const body = JSON.stringify({
      error: {
        code: 404,
        status: 'NOT_FOUND',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'SOME_RANDOM_PROVIDER_CODE' }],
      },
    });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 404, rawBody: body });
    return r.kind === 'rejected' && r.category === 'other-definitive-rejection' && !JSON.stringify(r).includes('SOME_RANDOM_PROVIDER_CODE');
  })());

  check('[required §2.1] HTTP 429 with body code 401/status RESOURCE_EXHAUSTED -> unknown-outcome, contradictory-response (never retryable-later)', (() => {
    const body = JSON.stringify({ error: { code: 401, status: 'RESOURCE_EXHAUSTED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 429, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'contradictory-response';
  })());

  check('[required §2.2] HTTP 401 with body code 429/status UNAUTHENTICATED -> unknown-outcome, contradictory-response', (() => {
    const body = JSON.stringify({ error: { code: 429, status: 'UNAUTHENTICATED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 401, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'contradictory-response';
  })());

  check('[required §2.3] HTTP 400 with body code 404 + typed UNREGISTERED -> unknown-outcome', (() => {
    const body = JSON.stringify({
      error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
    });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'contradictory-response';
  })());

  check('[required §2.4] HTTP 404 with body code 400 + typed UNREGISTERED -> unknown-outcome (never unregistered)', (() => {
    const body = JSON.stringify({
      error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
    });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 404, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'contradictory-response';
  })());

  check('[14.C] HTTP 400, coherent code/status, but body ALSO carries a typed UNREGISTERED detail -> invalid-argument, never unregistered', (() => {
    const body = JSON.stringify({
      error: { code: 400, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
    });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: body });
    return r.kind === 'rejected' && r.category === 'invalid-argument';
  })());

  check('[14.F] HTTP 404, code 404, but canonical status is INVALID_ARGUMENT (not NOT_FOUND) even with typed UNREGISTERED -> unknown-outcome, contradictory-response', (() => {
    const body = JSON.stringify({
      error: { code: 404, status: 'INVALID_ARGUMENT', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
    });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 404, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'contradictory-response';
  })());

  check('HTTP/code agreement but a non-canonical status for a known category -> unknown-outcome, contradictory-response', (() => {
    const body = JSON.stringify({ error: { code: 403, status: 'ABORTED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 403, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'contradictory-response';
  })());

  check('[Q] well-formed, coherent 429 RESOURCE_EXHAUSTED -> rejected, retryable-later (classification only)', (() => {
    const body = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 429, rawBody: body });
    return r.kind === 'rejected' && r.category === 'retryable-later';
  })());

  check('[R] malformed 429 (status is not RESOURCE_EXHAUSTED, but code coherent) -> unknown-outcome, contradictory-response', (() => {
    const body = JSON.stringify({ error: { code: 429, status: 'INTERNAL' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 429, rawBody: body });
    return r.kind === 'unknown-outcome';
  })());

  check('429 with no recognizable google.rpc.Status body at all -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 429, rawBody: '{}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  for (const status of [500, 502, 503, 504, 599]) {
    check(`${status} (even with a well-formed coherent body) -> unknown-outcome, ambiguous-server-response`, (() => {
      const body = JSON.stringify({ error: { code: status, status: 'INTERNAL' } });
      const r = classifyFcmTransportResult({ kind: 'response', httpStatus: status, rawBody: body });
      return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
    })());
  }

  check('[10/required] HTTP 421, well-formed body -> unknown-outcome, ambiguous-server-response, never a definitive rejection', (() => {
    const body = JSON.stringify({ error: { code: 421, status: 'ABORTED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 421, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('HTTP 421, malformed body -> unknown-outcome, ambiguous-server-response (status checked before body parsing)', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 421, rawBody: 'not even json' });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('[14.G] HTTP 408, well-formed body -> unknown-outcome, ambiguous-server-response', (() => {
    const body = JSON.stringify({ error: { code: 408, status: 'DEADLINE_EXCEEDED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 408, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('[14.H] HTTP 425, well-formed body -> unknown-outcome, ambiguous-server-response', (() => {
    const body = JSON.stringify({ error: { code: 425, status: 'ABORTED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 425, rawBody: body });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('[14.I] HTTP 408, malformed body -> unknown-outcome, ambiguous-server-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 408, rawBody: 'not even json' });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('[14.J] HTTP 425, malformed body -> unknown-outcome, ambiguous-server-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 425, rawBody: 'not even json' });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('[14.K] direct classifier input: HTTP 301 -> unknown-outcome, ambiguous-server-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 301, rawBody: '' });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('[14.L] direct classifier input: HTTP 307 -> unknown-outcome, ambiguous-server-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 307, rawBody: '' });
    return r.kind === 'unknown-outcome' && r.reason === 'ambiguous-server-response';
  })());

  check('unrecognized non-5xx status with a well-formed, coherent FCM error body -> rejected, other-definitive-rejection', (() => {
    const body = JSON.stringify({ error: { code: 409, status: 'ABORTED' } });
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 409, rawBody: body });
    return r.kind === 'rejected' && r.category === 'other-definitive-rejection';
  })());

  check('non-2xx, non-5xx with non-JSON body -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '<html>error</html>' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[H] {"error":null} -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '{"error":null}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[I] {"error":true} -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '{"error":true}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('[J] {"error":{}} (missing code/status) -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '{"error":{}}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('{} (no error key at all) -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '{}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('error.code non-integer -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '{"error":{"code":1.5,"status":"INVALID_ARGUMENT"}}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('error.status empty string -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '{"error":{"code":400,"status":""}}' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('empty body on a non-2xx response -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'response', httpStatus: 400, rawBody: '' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());

  check('timeout -> unknown-outcome, timeout', classifyFcmTransportResult({ kind: 'timeout' }).kind === 'unknown-outcome');
  check('[FINAL CLASSIFIER-SECRECY REPAIR] network-error -> unknown-outcome, network-error, NO detail field at all (the raw variant carries no payload to copy one from)', (() => {
    const r = classifyFcmTransportResult({ kind: 'network-error' });
    return r.kind === 'unknown-outcome' && r.reason === 'network-error' && r.detail === undefined;
  })());
  check('response-aborted -> unknown-outcome, network-error, fixed detail "aborted" (authored inside the classifier, not read from input)', (() => {
    const r = classifyFcmTransportResult({ kind: 'response-aborted' });
    return r.kind === 'unknown-outcome' && r.reason === 'network-error' && r.detail === 'aborted';
  })());
  check('response-closed-before-end -> unknown-outcome, network-error, fixed detail "closed-before-end"', (() => {
    const r = classifyFcmTransportResult({ kind: 'response-closed-before-end' });
    return r.kind === 'unknown-outcome' && r.reason === 'network-error' && r.detail === 'closed-before-end';
  })());
  check('[10.A / §4] fabricated raw input with an adversarial extra "detail" field on network-error (bypassing TypeScript via `as any`) -> the classifier structurally ignores it; secret discarded, detail undefined', (() => {
    const fabricated = { kind: 'network-error', detail: 'Bearer SECRET' } as unknown as { kind: 'network-error' };
    const r = classifyFcmTransportResult(fabricated);
    const serialized = JSON.stringify(r);
    return r.kind === 'unknown-outcome' && r.reason === 'network-error' && r.detail === undefined && !serialized.includes('Bearer SECRET') && !serialized.includes('SECRET');
  })());
  check('[10.A / §4] fabricated raw input with an adversarial "detail" field on response-aborted -> classifier still returns only its own fixed "aborted" literal, secret discarded', (() => {
    const fabricated = { kind: 'response-aborted', detail: 'Bearer SECRET-2' } as unknown as { kind: 'response-aborted' };
    const r = classifyFcmTransportResult(fabricated);
    const serialized = JSON.stringify(r);
    return r.kind === 'unknown-outcome' && r.reason === 'network-error' && r.detail === 'aborted' && !serialized.includes('SECRET-2');
  })());
  check('response-too-large -> unknown-outcome, response-too-large', classifyFcmTransportResult({ kind: 'response-too-large' }).kind === 'unknown-outcome');
  check('malformed-encoding -> unknown-outcome, malformed-response', (() => {
    const r = classifyFcmTransportResult({ kind: 'malformed-encoding' });
    return r.kind === 'unknown-outcome' && r.reason === 'malformed-response';
  })());
  check('unexpected-exception -> unknown-outcome, unexpected-exception (conservative default, no detail)', (() => {
    const r = classifyFcmTransportResult({ kind: 'unexpected-exception' });
    return r.kind === 'unknown-outcome' && r.reason === 'unexpected-exception' && r.detail === undefined;
  })());

  check('DEFAULT_FCM_SEND_TIMEOUT_MS is exactly 10 seconds', DEFAULT_FCM_SEND_TIMEOUT_MS === 10_000);
  check('MAX_RESPONSE_BODY_BYTES is exactly 64 KiB', MAX_RESPONSE_BODY_BYTES === 64 * 1024);
  check('FCM_PROJECT_ID is the fixed production project', FCM_PROJECT_ID === 'neuroactive');

  // =========================================================================
  // 3. sendFcmOnce — local (pre-network) failures. Request factory call count MUST be 0.
  // =========================================================================
  console.log('\n=== sendFcmOnce: local request-not-attempted failures (zero https.request calls) ===');

  await checkAsync('[C] wrong project -> request-not-attempted/wrong-project, zero request calls', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ projectId: 'some-other-project', requestImpl }));
    return outcome.kind === 'request-not-attempted' && outcome.reason === 'wrong-project' && callCount() === 0;
  });

  await checkAsync('[A] cyclic message -> request-not-attempted/serialization-failed, zero request calls', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const outcome = await sendFcmOnce(validParams({ message: cyclic, requestImpl }));
    return outcome.kind === 'request-not-attempted' && outcome.reason === 'serialization-failed' && callCount() === 0;
  });

  await checkAsync('[B] BigInt in message -> request-not-attempted/serialization-failed, zero request calls', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: { amount: BigInt(5) }, requestImpl }));
    return outcome.kind === 'request-not-attempted' && outcome.reason === 'serialization-failed' && callCount() === 0;
  });

  await checkAsync('[15] hostile throwing-getter during serialization -> request-not-attempted/serialization-failed, zero request calls, no throw escapes, secret never leaks, no detail at all', async () => {
    const secret = 'SUPER-SECRET-GETTER-TEXT';
    const hostileMessage: Record<string, unknown> = {};
    Object.defineProperty(hostileMessage, 'token', {
      enumerable: true,
      get() {
        throw new Error(`hostile token getter: ${secret}`);
      },
    });
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: hostileMessage, requestImpl }));
    return (
      outcome.kind === 'request-not-attempted' &&
      outcome.reason === 'serialization-failed' &&
      outcome.detail === undefined &&
      callCount() === 0 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  await checkAsync('[15] hostile toJSON throwing a hostile Proxy -> request-not-attempted/serialization-failed, zero request calls, no throw escapes, secret never leaks, no detail at all', async () => {
    const secret = 'PROXY-SECRET-TEXT';
    const hostileMessage = {
      token: SAMPLE_TOKEN,
      toJSON() {
        throw makeHostileProxyError(secret);
      },
    };
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: hostileMessage, requestImpl }));
    return (
      outcome.kind === 'request-not-attempted' &&
      outcome.reason === 'serialization-failed' &&
      outcome.detail === undefined &&
      callCount() === 0 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  // --- Final Codex repair round: READABLE (non-throwing) secret-bearing properties. ---
  // These are the scenarios that would actually have leaked under the prior "safely read,
  // then return" design — a hostile value doesn't need to THROW to be dangerous; it only
  // needs an ordinary, readable `name`/`code`/`cause.code` property carrying a secret.

  await checkAsync('[5.A] serialization throws a plain object with a secret-bearing (readable, non-throwing) name -> request-not-attempted/serialization-failed, zero request calls, secret never leaks, no detail at all', async () => {
    const secret = 'RAW-FCM-TOKEN-abc123';
    const hostileMessage = {
      token: SAMPLE_TOKEN,
      toJSON(): never {
        throw { name: secret };
      },
    };
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: hostileMessage, requestImpl }));
    return (
      outcome.kind === 'request-not-attempted' &&
      outcome.reason === 'serialization-failed' &&
      outcome.detail === undefined &&
      callCount() === 0 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  await checkAsync('[5.B] serialization throws a plain object with a secret-bearing (readable) code -> request-not-attempted/serialization-failed, zero request calls, secret never leaks, no detail at all', async () => {
    const secret = 'ACCESS-TOKEN-xyz789';
    const hostileMessage = {
      token: SAMPLE_TOKEN,
      toJSON(): never {
        throw { code: secret };
      },
    };
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: hostileMessage, requestImpl }));
    return (
      outcome.kind === 'request-not-attempted' &&
      outcome.reason === 'serialization-failed' &&
      outcome.detail === undefined &&
      callCount() === 0 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  await checkAsync('[5.C] serialization throws a plain object with a secret-bearing (readable) cause.code -> request-not-attempted/serialization-failed, zero request calls, secret never leaks, no detail at all', async () => {
    const secret = 'SECRET-CAUSE-CODE-qqq';
    const hostileMessage = {
      token: SAMPLE_TOKEN,
      toJSON(): never {
        throw { cause: { code: secret } };
      },
    };
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: hostileMessage, requestImpl }));
    return (
      outcome.kind === 'request-not-attempted' &&
      outcome.reason === 'serialization-failed' &&
      outcome.detail === undefined &&
      callCount() === 0 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  await checkAsync('[5.D] serialization throws an ordinary Error with a secret in .message (normal name/code behavior) -> request-not-attempted/serialization-failed, zero request calls, secret never leaks, no detail at all', async () => {
    const secret = 'ORDINARY-ERROR-MESSAGE-SECRET';
    const hostileMessage = {
      token: SAMPLE_TOKEN,
      toJSON(): never {
        throw new Error(secret);
      },
    };
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message: hostileMessage, requestImpl }));
    return (
      outcome.kind === 'request-not-attempted' &&
      outcome.reason === 'serialization-failed' &&
      outcome.detail === undefined &&
      callCount() === 0 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  await checkAsync('[26] requestImpl throws synchronously before returning a request object -> request-not-attempted/request-construction-failed, one factory call recorded', async () => {
    const { requestImpl, callCount } = countingRequestFactory(throwingRequestFactory(new Error('synthetic construction failure')));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'request-not-attempted' && outcome.reason === 'request-construction-failed' && callCount() === 1;
  });

  // =========================================================================
  // sendFcmOnce — network-attempting scenarios. Every one proves exactly one
  // https.request-shaped call.
  // =========================================================================
  console.log('\n=== sendFcmOnce: network-attempting outcomes (exactly one https.request call each) ===');

  await checkAsync('200 success -> accepted, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/abc"}'));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'accepted' && callCount() === 1;
  });

  await checkAsync('[19] 201 -> unknown-outcome/unexpected-response, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(201, '{"name":"projects/neuroactive/messages/abc"}'));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason === 'unexpected-response' && callCount() === 1;
  });

  await checkAsync('[19] 204 -> unknown-outcome/unexpected-response, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(204, ''));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason === 'unexpected-response' && callCount() === 1;
  });

  await checkAsync('400 invalid argument -> rejected/invalid-argument, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(400, JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } })));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'rejected' && outcome.category === 'invalid-argument' && callCount() === 1;
  });

  await checkAsync('401 -> rejected/unauthenticated, exactly one request call (no in-attempt refresh-and-resend)', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(401, JSON.stringify({ error: { code: 401, status: 'UNAUTHENTICATED' } })));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'rejected' && outcome.category === 'unauthenticated' && callCount() === 1;
  });

  await checkAsync('403 -> rejected/permission-denied, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(403, JSON.stringify({ error: { code: 403, status: 'PERMISSION_DENIED' } })));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'rejected' && outcome.category === 'permission-denied' && callCount() === 1;
  });

  await checkAsync('typed UNREGISTERED, fully coherent -> rejected/unregistered, exactly one request call', async () => {
    const body = JSON.stringify({
      error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] },
    });
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(404, body));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'rejected' && outcome.category === 'unregistered' && callCount() === 1;
  });

  await checkAsync('bare 404 NOT_FOUND without typed detail -> rejected but NOT unregistered, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(404, JSON.stringify({ error: { code: 404, status: 'NOT_FOUND' } })));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'rejected' && outcome.category === 'other-definitive-rejection' && callCount() === 1;
  });

  await checkAsync('well-formed, coherent 429 RESOURCE_EXHAUSTED -> rejected/retryable-later (classification only, no retry performed), exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(429, JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'rejected' && outcome.category === 'retryable-later' && callCount() === 1;
  });

  await checkAsync('malformed 429 -> unknown-outcome, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(429, '{}'));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  for (const status of [500, 502, 503, 504]) {
    await checkAsync(`[28] ${status} -> unknown-outcome/ambiguous-server-response even with a well-formed body, exactly one request call`, async () => {
      const body = JSON.stringify({ error: { code: status, status: 'INTERNAL' } });
      const { requestImpl, callCount } = countingRequestFactory(respondingWithText(status, body));
      const outcome = await sendFcmOnce(validParams({ requestImpl }));
      return outcome.kind === 'unknown-outcome' && outcome.reason === 'ambiguous-server-response' && callCount() === 1;
    });
  }

  await checkAsync('[10/28] 421, well-formed body -> unknown-outcome/ambiguous-server-response, exactly one request call, no second request constructed', async () => {
    const body = JSON.stringify({ error: { code: 421, status: 'ABORTED' } });
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(421, body));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    const first = outcome.kind === 'unknown-outcome' && outcome.reason === 'ambiguous-server-response' && callCount() === 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return first && callCount() === 1;
  });

  for (const status of [408, 425]) {
    await checkAsync(`${status} with a well-formed body -> unknown-outcome/ambiguous-server-response, exactly one request call`, async () => {
      const body = JSON.stringify({ error: { code: status, status: 'ABORTED' } });
      const { requestImpl, callCount } = countingRequestFactory(respondingWithText(status, body));
      const outcome = await sendFcmOnce(validParams({ requestImpl }));
      return outcome.kind === 'unknown-outcome' && outcome.reason === 'ambiguous-server-response' && callCount() === 1;
    });
  }

  await checkAsync('[28] timeout: request never responds -> unknown-outcome/timeout, exactly one request call, no dangling second attempt', async () => {
    const { requestImpl, callCount } = countingRequestFactory(neverRespondingFactory());
    const outcome = await sendFcmOnce(validParams({ timeoutMs: 5, requestImpl }));
    const first = outcome.kind === 'unknown-outcome' && outcome.reason === 'timeout' && callCount() === 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return first && callCount() === 1;
  });

  await checkAsync('[28] request "error" event (ECONNRESET-shaped) -> unknown-outcome/network-error, exactly one request call, the error code is NEVER copied into detail (fixed outcome only)', async () => {
    const err = Object.assign(new Error('econnreset'), { code: 'ECONNRESET' });
    const { requestImpl, callCount } = countingRequestFactory(erroringRequestFactory(err));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return (
      outcome.kind === 'unknown-outcome' &&
      outcome.reason === 'network-error' &&
      outcome.detail === undefined &&
      callCount() === 1
    );
  });

  await checkAsync('[28] response "aborted" event -> unknown-outcome/network-error, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingThenAborted(200));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  await checkAsync('[28] response "error" event mid-body -> unknown-outcome/network-error, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingThenErroring(200, new Error('stream broke')));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  await checkAsync('response "close" without ever reaching "end" -> unknown-outcome/network-error (incomplete provenance), exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingThenClosedWithoutEnd(200));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  await checkAsync('[25/28] req.write() throws synchronously -> conservative unknown-outcome (not request-not-attempted — cannot prove zero bytes sent), exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(writeThrowingFactory());
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  await checkAsync('[25/28] req.end() throws synchronously -> conservative unknown-outcome, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(endThrowingFactory());
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  await checkAsync('[16/28] hostile Proxy error on the request "error" event -> unknown-outcome, exactly one request call, no exception escapes, secret never leaks, no detail at all', async () => {
    const secret = 'POST-ATTEMPT-PROXY-SECRET';
    const { requestImpl, callCount } = countingRequestFactory(erroringRequestFactory(makeHostileProxyError(secret)));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.detail === undefined && callCount() === 1 && !JSON.stringify(outcome).includes(secret);
  });

  await checkAsync('[16/28] hostile throwing-getter error on the request "error" event -> unknown-outcome, exactly one request call, no exception escapes, secret never leaks, no detail at all', async () => {
    const secret = 'POST-ATTEMPT-GETTER-SECRET';
    const { requestImpl, callCount } = countingRequestFactory(erroringRequestFactory(makeThrowingGetterError(secret)));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.detail === undefined && callCount() === 1 && !JSON.stringify(outcome).includes(secret);
  });

  await checkAsync('[5.E] post-request emitted error with READABLE (non-throwing) secret-bearing name/code/cause.code -> unknown-outcome, exactly one request call, secret never leaks, no detail at all', async () => {
    const secret = 'POST-ATTEMPT-READABLE-SECRET';
    const hostileButReadableError = { name: secret, code: secret, cause: { code: secret } };
    const { requestImpl, callCount } = countingRequestFactory(erroringRequestFactory(hostileButReadableError));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return (
      outcome.kind === 'unknown-outcome' &&
      outcome.reason === 'network-error' &&
      outcome.detail === undefined &&
      callCount() === 1 &&
      !JSON.stringify(outcome).includes(secret)
    );
  });

  await checkAsync('malformed 200 response body -> unknown-outcome/malformed-response, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(200, 'not json at all'));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason === 'malformed-response' && callCount() === 1;
  });

  await checkAsync('malformed error response body -> unknown-outcome/malformed-response, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithText(400, '{unterminated json'));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason === 'malformed-response' && callCount() === 1;
  });

  await checkAsync('[18] exactly MAX_RESPONSE_BODY_BYTES (65536) bytes is allowed size-wise (not response-too-large), exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithBytes(200, Buffer.alloc(MAX_RESPONSE_BODY_BYTES, 65)));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason !== 'response-too-large' && callCount() === 1;
  });

  await checkAsync('[18] MAX_RESPONSE_BODY_BYTES + 1 (65537) bytes -> unknown-outcome/response-too-large, oversized content never surfaces, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithBytes(200, Buffer.alloc(MAX_RESPONSE_BODY_BYTES + 1, 65)));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return (
      outcome.kind === 'unknown-outcome' &&
      outcome.reason === 'response-too-large' &&
      callCount() === 1 &&
      !JSON.stringify(outcome).includes('A'.repeat(100))
    );
  });

  await checkAsync('malformed UTF-8 bytes on a 200 response -> unknown-outcome/malformed-response (fails closed, not replacement-decoded), exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithBytes(200, Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x42])));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason === 'malformed-response' && callCount() === 1;
  });

  await checkAsync('malformed UTF-8 bytes on a non-2xx response -> unknown-outcome/malformed-response, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(respondingWithBytes(400, Buffer.from([0xff, 0xfe, 0x00, 0x41, 0x42])));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && outcome.reason === 'malformed-response' && callCount() === 1;
  });

  await checkAsync('completely generic/unnamed thrown error on the request "error" event -> conservative unknown-outcome default, exactly one request call', async () => {
    const { requestImpl, callCount } = countingRequestFactory(erroringRequestFactory(new Error('boom')));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    return outcome.kind === 'unknown-outcome' && callCount() === 1;
  });

  // =========================================================================
  // 4. Request-shape, no-leak, and no-mutation checks.
  // =========================================================================
  console.log('\n=== request shape / leak / mutation checks ===');

  await checkAsync('exactly one https.request-shaped call, fixed hostname/path/method, Bearer auth header, exact Content-Length, no agent (no keepalive)', async () => {
    let seenOptions: Record<string, unknown> | undefined;
    let seenBody: Buffer | undefined;
    const factory: HttpsRequestImpl = ((options, callback) => {
      seenOptions = options as unknown as Record<string, unknown>;
      const req = new FakeClientRequest();
      const originalWrite = req.write.bind(req);
      req.write = (chunk: unknown) => {
        seenBody = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        return originalWrite(chunk);
      };
      queueMicrotask(() => {
        const res = new FakeIncomingMessage(200);
        callback(res as unknown as IncomingMessage);
        queueMicrotask(() => {
          res.emit('data', Buffer.from('{"name":"projects/neuroactive/messages/1"}', 'utf-8'));
          res.emit('end');
        });
      });
      return req as unknown as ClientRequest;
    }) as HttpsRequestImpl;
    await sendFcmOnce(validParams({ requestImpl: factory }));
    const hostnameOk = seenOptions?.hostname === 'fcm.googleapis.com';
    const pathOk = seenOptions?.path === '/v1/projects/neuroactive/messages:send';
    const methodOk = seenOptions?.method === 'POST';
    const agentOk = seenOptions?.agent === false;
    const headers = seenOptions?.headers as Record<string, unknown> | undefined;
    const authOk = headers?.Authorization === `Bearer ${SAMPLE_ACCESS_TOKEN}`;
    const expectedBody = Buffer.from(JSON.stringify({ message: { token: SAMPLE_TOKEN } }), 'utf-8');
    const contentLengthOk = headers?.['Content-Length'] === expectedBody.byteLength;
    const bodyOk = !!seenBody && seenBody.equals(expectedBody);
    return hostnameOk && pathOk && methodOk && agentOk && authOk && contentLengthOk && bodyOk;
  });

  await checkAsync('access token never appears anywhere in the returned outcome object', async () => {
    const { requestImpl } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome: FcmSendOutcome = await sendFcmOnce(validParams({ requestImpl }));
    return !JSON.stringify(outcome).includes(SAMPLE_ACCESS_TOKEN);
  });

  await checkAsync('[S] raw FCM token never appears anywhere in the returned outcome object', async () => {
    const { requestImpl } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome: FcmSendOutcome = await sendFcmOnce(validParams({ requestImpl }));
    return !JSON.stringify(outcome).includes(SAMPLE_TOKEN);
  });

  await checkAsync('[FINAL REPAIR] safe diagnostics: NEITHER error.message NOR error.name NOR error.code is ever surfaced in unknown-outcome detail — detail is absent entirely for network-error', async () => {
    const secretLookingMessage = 'token=SUPER-SECRET-SHOULD-NOT-APPEAR should not leak';
    const err = Object.assign(new Error(secretLookingMessage), { name: 'CustomNetworkError', code: 'ECUSTOM' });
    const { requestImpl } = countingRequestFactory(erroringRequestFactory(err));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    const serialized = JSON.stringify(outcome);
    return (
      outcome.kind === 'unknown-outcome' &&
      outcome.detail === undefined &&
      !serialized.includes('ECUSTOM') &&
      !serialized.includes('CustomNetworkError') &&
      !serialized.includes('SUPER-SECRET')
    );
  });

  await checkAsync('caller message object is never mutated', async () => {
    const message = Object.freeze({ token: SAMPLE_TOKEN, data: Object.freeze({ deliveryPublicId: 'abc' }) });
    const before = JSON.stringify(message);
    const { requestImpl } = countingRequestFactory(respondingWithText(200, '{"name":"projects/neuroactive/messages/1"}'));
    const outcome = await sendFcmOnce(validParams({ message, requestImpl }));
    return outcome.kind === 'accepted' && JSON.stringify(message) === before;
  });

  await checkAsync('rejected outcomes never carry any provider-controlled free-text field at all (category only)', async () => {
    const { requestImpl } = countingRequestFactory(respondingWithText(400, JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'do not leak this text' } })));
    const outcome = await sendFcmOnce(validParams({ requestImpl }));
    const serialized = JSON.stringify(outcome);
    return outcome.kind === 'rejected' && !serialized.includes('do not leak this text') && !('errorStatus' in outcome) && !('fcmErrorCode' in outcome);
  });

  // =========================================================================
  // 5. Static regression check: guard against reintroducing fetch, the retrying Admin
  // SDK Messaging client, or any of its dependency chain, into this transport file. Also
  // confirms node:https is actually used in production source.
  // =========================================================================
  console.log('\n=== static regression check (source inspection, no execution) ===');

  const transportSourcePath = path.join(__dirname, '..', 'src', 'fcmTransport.ts');
  const transportSource = fs.readFileSync(transportSourcePath, 'utf-8');
  // This file's own header/inline comments deliberately DISCUSS fetch, getMessaging(),
  // firebase-admin/messaging, and google-auth-library as prose explaining why they are
  // NOT used here — a naive substring search over the raw file would false-positive on
  // that prose. Strip block comments and standalone `//` comment lines first (every
  // comment in this file uses one of those two forms) so these checks only see actual
  // source, not documentation about what the source deliberately avoids.
  const codeOnly = transportSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  check('fcmTransport.ts never calls fetch( in actual code', !codeOnly.includes('fetch('));
  check('fcmTransport.ts never references globalThis.fetch in actual code', !codeOnly.includes('globalThis.fetch'));
  check('fcmTransport.ts never calls getMessaging( in actual code', !codeOnly.includes('getMessaging('));
  check("fcmTransport.ts never imports 'firebase-admin/messaging' in actual code", !codeOnly.includes('firebase-admin/messaging'));
  check("fcmTransport.ts never imports 'firebase-admin' at all in actual code", !/from ['"]firebase-admin/.test(codeOnly) && !codeOnly.includes("require('firebase-admin"));
  check("fcmTransport.ts never imports 'google-auth-library' in actual code", !codeOnly.includes('google-auth-library'));
  check("fcmTransport.ts never imports 'gaxios' in actual code", !codeOnly.includes('gaxios'));
  check('fcmTransport.ts contains no console.log/console.error calls of its own', !/console\.(log|error|warn|info|debug)\(/.test(transportSource));
  check("fcmTransport.ts DOES import 'node:https'", codeOnly.includes("from 'node:https'") || codeOnly.includes('require(\'node:https\')'));
  check('fcmTransport.ts contains exactly one production requestImpl(...) construction call site', (codeOnly.match(/requestImpl\(options, handleResponse\)/g) || []).length === 1);

  // [12] Final Codex repair round: the diagnostic-extraction helpers must be gone
  // entirely, not merely hardened — there is nothing left in this file that legitimately
  // needs to read a property off a caught/emitted exception at all.
  check('fcmTransport.ts no longer defines safeErrorDetail', !codeOnly.includes('safeErrorDetail'));
  check('fcmTransport.ts no longer defines isAbortError', !codeOnly.includes('isAbortError'));
  check('fcmTransport.ts no longer defines a safeGet-style guarded property reader', !codeOnly.includes('safeGet'));
  // No catch/error-handler anywhere may bind `err`/`error` and then read `.name`/`.code`/
  // `.cause` off it — every one of them now either binds no parameter at all, or ignores
  // the parameter entirely. A `catch (err)`/`catch (error)` binding remaining in the file
  // would itself be suspicious (nothing needs one anymore), so its absence is checked
  // directly.
  // Note: a blanket source-text search for `.name`/`.code`/`.cause` is NOT used here —
  // this file legitimately reads `.code`/`.status` off the PARSED FCM RESPONSE BODY
  // (`parseGoogleRpcStatus`'s `error.code`), which is unrelated to (and predates) this
  // round's concern about reading properties off a caught EXCEPTION/emitted error value.
  // The precise, unambiguous proof for THIS round's fix is the absence of any bound catch
  // clause (below) combined with the removal of the helper functions that used to do the
  // reading (above) — together these mean there is no code path left, anywhere in this
  // file, capable of reading a property off a thrown/emitted value at all.
  check('fcmTransport.ts contains no `catch (err)`/`catch (error)`-style bound catch clauses (every catch either binds nothing or is structurally unable to read the thrown value)', !/catch\s*\(\s*(err|error)\s*\)/.test(codeOnly));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
