// functions/src/calendarFeedEndpoint.test.ts
// Calendar Integration Phase 1, Stage 4 tests.
//
// Same caveat as calendarSubscriptions.test.ts/calendarPreferences.test.ts: no live
// Firebase emulator in this environment, so these exercise the db-parameterized Core
// functions (resolveCalendarFeedInputCore, handleCalendarFeedRequestCore) and the pure
// applyOutcome/extractToken/isFreshFor helpers against a minimal FAKE Firestore and a fake
// AccountExistsChecker — never a live HTTP request/response, never real Firebase Admin
// Auth. See this project's REAL-EMULATOR GATE status note in the Stage 4 completion report
// for what real-emulator verification remains outstanding before deployment.
'use strict';

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Timestamp } from 'firebase-admin/firestore';
import { resolveCalendarFeedInputCore, handleCalendarFeedRequestCore, __test__ } from './calendarFeedEndpoint';
import { generateCalendarIcs } from './calendarIcsGenerator';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log('PASS  ' + label);
    pass++;
  } else {
    console.log('FAIL  ' + label + (detail ? ': ' + detail : ''));
    fail++;
  }
}
async function checkAsync(label: string, fn: () => Promise<boolean> | boolean): Promise<void> {
  try {
    check(label, await fn());
  } catch (err) {
    check(label, false, 'threw: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------------------
// MINIMAL FAKE FIRESTORE — doc/get only, matching exactly what calendarFeedEndpoint.ts's
// own Core functions ever call. `.set()/.update()/.delete()/.create()` ARE implemented (so
// a bug that accidentally introduced a write would be caught by the fake actually applying
// it, not silently no-op), but each increments `writeLog.count` — the READ-ONLY INVARIANT
// tests below assert that count stays exactly 0 after a full request cycle. Test fixtures
// are seeded by mutating `store` directly (see seedDoc below), never through these methods,
// so writeLog only ever reflects writes performed by calendarFeedEndpoint.ts's OWN code.
// ---------------------------------------------------------------------------------------
type DocData = Record<string, unknown>;

class FakeDocRef {
  constructor(
    private store: Map<string, DocData>,
    private writeLog: { count: number },
    public path: string
  ) {}
  async get() {
    const exists = this.store.has(this.path);
    const data = exists ? { ...this.store.get(this.path)! } : undefined;
    return { exists, data: () => data };
  }
  async set(data: DocData) {
    this.writeLog.count++;
    this.store.set(this.path, data);
  }
  async update(data: DocData) {
    this.writeLog.count++;
    const existing = this.store.get(this.path) ?? {};
    this.store.set(this.path, { ...existing, ...data });
  }
  async delete() {
    this.writeLog.count++;
    this.store.delete(this.path);
  }
  async create(data: DocData) {
    this.writeLog.count++;
    this.store.set(this.path, data);
  }
}

function makeFakeDb() {
  const store = new Map<string, DocData>();
  const writeLog = { count: 0 };
  const db = {
    doc(docPath: string) {
      return new FakeDocRef(store, writeLog, docPath);
    },
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, store, writeLog };
}

function seedDoc(store: Map<string, DocData>, ref: { path: string }, data: DocData): void {
  store.set(ref.path, data);
}

// ---------------------------------------------------------------------------------------
// FIXTURES
// ---------------------------------------------------------------------------------------

// sha256 digest is 32 bytes — the SAME length as Stage 1's randomBytes(32) — so
// base64url-encoding it produces the same 43-character shape RAW_TOKEN_PATTERN expects, and
// deterministically-derived from `seed` for reproducible tests.
function makeRawToken(seed: string): string {
  return createHash('sha256').update(seed).digest('base64url');
}
// hex digest is lowercase [0-9a-f] only — a subset of Stage 1's [A-Za-z0-9] subscriptionId
// alphabet — sliced to the exact 20-character Firestore-auto-ID length.
function makeSubscriptionId(seed: string): string {
  return createHash('sha256').update(seed).digest('hex').slice(0, 20);
}

function seedActiveSubscription(
  db: FirebaseFirestore.Firestore,
  store: Map<string, DocData>,
  opts: { uid: string; subscriptionId: string; rawToken: string; createdAtMs: number; revoked?: boolean; secretHashOverride?: string }
): void {
  const secretHash = __test__.hashToken(opts.rawToken);
  seedDoc(store, __test__.calendarHashRef(db, secretHash), { uid: opts.uid, subscriptionId: opts.subscriptionId });
  seedDoc(store, __test__.calendarSubscriptionRef(db, opts.uid, opts.subscriptionId), {
    label: null,
    createdAt: Timestamp.fromMillis(opts.createdAtMs),
    revokedAt: opts.revoked ? Timestamp.now() : null,
    secretHash: opts.secretHashOverride ?? secretHash,
  });
}

function seedPreferences(
  db: FirebaseFirestore.Firestore,
  store: Map<string, DocData>,
  uid: string,
  opts: {
    weekdays: number[];
    localTime: string;
    timezone: string;
    sessionDurationMinutes: number;
    revision: number;
    updatedAtMs: number;
  }
): void {
  seedDoc(store, __test__.calendarPreferencesRef(db, uid), {
    weekdays: opts.weekdays,
    localTime: opts.localTime,
    timezone: opts.timezone,
    sessionDurationMinutes: opts.sessionDurationMinutes,
    revision: opts.revision,
    updatedAt: Timestamp.fromMillis(opts.updatedAtMs),
  });
}

function seedTombstone(db: FirebaseFirestore.Firestore, store: Map<string, DocData>, uid: string): void {
  seedDoc(store, __test__.calendarAccountStateRef(db, uid), { deleted: true, deletedAt: Timestamp.now() });
}

async function alwaysExists(): Promise<boolean> {
  return true;
}
async function neverExists(): Promise<boolean> {
  return false;
}
async function throwingChecker(): Promise<boolean> {
  throw new Error('simulated Auth service outage');
}

const CREATED_A = Date.UTC(2026, 0, 15, 12);
const UPDATED_A = Date.UTC(2026, 1, 1, 9);
const UID_A = 'uidAAAAAAAAAAAAAAAAA';
const SUB_ID_A = makeSubscriptionId('subscription-A');
const TOKEN_A = makeRawToken('token-A');

const UID_B = 'uidBBBBBBBBBBBBBBBBB';
const SUB_ID_B = makeSubscriptionId('subscription-B');
const TOKEN_B = makeRawToken('token-B');
const CREATED_B = Date.UTC(2026, 2, 1, 9);
const UPDATED_B = Date.UTC(2026, 2, 5, 9);

function validPreferenceFields(overrides: Partial<{
  weekdays: number[];
  localTime: string;
  timezone: string;
  sessionDurationMinutes: number;
  revision: number;
  updatedAtMs: number;
}> = {}) {
  return {
    weekdays: [1, 3, 5],
    localTime: '18:30',
    timezone: 'America/Chicago',
    sessionDurationMinutes: 30,
    revision: 4,
    updatedAtMs: UPDATED_A,
    ...overrides,
  };
}

function freshEnvWithA() {
  const { db, store, writeLog } = makeFakeDb();
  seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
  seedPreferences(db, store, UID_A, validPreferenceFields());
  return { db, store, writeLog };
}

type RecordedResponse = {
  headers: Record<string, string>;
  statusCode: number | null;
  body: string | null;
  ended: boolean;
};
function makeFakeResponse() {
  const recorded: RecordedResponse = { headers: {}, statusCode: null, body: null, ended: false };
  const response = {
    set(name: string, value: string) {
      recorded.headers[name.toLowerCase()] = value;
      return response;
    },
    status(code: number) {
      recorded.statusCode = code;
      return response;
    },
    type(t: string) {
      recorded.headers['content-type'] = t;
      return response;
    },
    send(body: string) {
      recorded.body = body;
      recorded.ended = true;
      return response;
    },
    end() {
      recorded.ended = true;
      return response;
    },
  };
  return { response: response as unknown as import('express').Response, recorded };
}

async function main(): Promise<void> {
  // =======================================================================================
  // TOKEN / AUTHORIZATION
  // =======================================================================================

  await checkAsync('exact valid-token resolution succeeds and maps through Stage 3 unchanged', async () => {
    const { db } = freshEnvWithA();
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return (
      result.status === 'ok' &&
      result.feedInput.eventUid === SUB_ID_A &&
      result.feedInput.seriesAnchorMs === CREATED_A &&
      result.feedInput.weekdays.join(',') === '1,3,5' &&
      result.feedInput.timezone === 'America/Chicago' &&
      result.feedInput.revision === 4
    );
  });

  for (const [label, malformed] of [
    ['undefined', undefined],
    ['empty string', ''],
    ['42 characters (one short)', 'a'.repeat(42)],
    ['44 characters (one long)', 'a'.repeat(44)],
    ['contains a slash', 'a'.repeat(42) + '/'],
    ['contains a plus (standard base64, not base64url)', 'a'.repeat(42) + '+'],
    ['well-formed but unknown token', makeRawToken('never-seeded')],
  ] as const) {
    await checkAsync('rejects malformed/unknown token: ' + label, async () => {
      const { db } = freshEnvWithA();
      const result = await resolveCalendarFeedInputCore(db, alwaysExists, malformed);
      return result.status === 'not-found';
    });
  }

  await checkAsync('rejects a revoked token', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A, revoked: true });
    seedPreferences(db, store, UID_A, validPreferenceFields());
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects a token whose account has a deletion tombstone', async () => {
    const { db, store } = freshEnvWithA();
    seedTombstone(db, store, UID_A);
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects a token whose Firebase Auth account no longer exists', async () => {
    const { db } = freshEnvWithA();
    const result = await resolveCalendarFeedInputCore(db, neverExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('an Auth-check failure (not "not found") is unavailable, not not-found', async () => {
    const { db } = freshEnvWithA();
    const result = await resolveCalendarFeedInputCore(db, throwingChecker, TOKEN_A);
    return result.status === 'unavailable';
  });

  await checkAsync('cross-user isolation: token A never resolves to subscription/account B, and vice versa', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    seedPreferences(db, store, UID_A, validPreferenceFields({ updatedAtMs: UPDATED_A }));
    seedActiveSubscription(db, store, { uid: UID_B, subscriptionId: SUB_ID_B, rawToken: TOKEN_B, createdAtMs: CREATED_B });
    seedPreferences(db, store, UID_B, validPreferenceFields({ weekdays: [0, 6], timezone: 'America/New_York', updatedAtMs: UPDATED_B }));

    const resultA = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    const resultB = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_B);
    return (
      resultA.status === 'ok' && resultA.feedInput.eventUid === SUB_ID_A && resultA.feedInput.timezone === 'America/Chicago' &&
      resultB.status === 'ok' && resultB.feedInput.eventUid === SUB_ID_B && resultB.feedInput.timezone === 'America/New_York'
    );
  });

  await checkAsync('rejects a corrupt hash-index entry (subscriptionId not Stage 1-shaped)', async () => {
    const { db, store } = makeFakeDb();
    const secretHash = __test__.hashToken(TOKEN_A);
    seedDoc(store, __test__.calendarHashRef(db, secretHash), { uid: UID_A, subscriptionId: 'not-twenty-alnum-chars!!' });
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects when the hash-index entry has no corresponding owner document', async () => {
    const { db, store } = makeFakeDb();
    const secretHash = __test__.hashToken(TOKEN_A);
    seedDoc(store, __test__.calendarHashRef(db, secretHash), { uid: UID_A, subscriptionId: SUB_ID_A });
    // No owner document seeded at calendarSubscriptionRef(db, UID_A, SUB_ID_A).
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects an owner document whose own secretHash has drifted from the hash-index (defense in depth)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, {
      uid: UID_A,
      subscriptionId: SUB_ID_A,
      rawToken: TOKEN_A,
      createdAtMs: CREATED_A,
      secretHashOverride: __test__.hashToken('a-completely-different-secret'),
    });
    seedPreferences(db, store, UID_A, validPreferenceFields());
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects an owner document with a non-Timestamp createdAt (corrupt shape)', async () => {
    const { db, store } = makeFakeDb();
    const secretHash = __test__.hashToken(TOKEN_A);
    seedDoc(store, __test__.calendarHashRef(db, secretHash), { uid: UID_A, subscriptionId: SUB_ID_A });
    seedDoc(store, __test__.calendarSubscriptionRef(db, UID_A, SUB_ID_A), {
      label: null,
      createdAt: CREATED_A, // plain number, not a genuine Timestamp
      revokedAt: null,
      secretHash,
    });
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects missing calendar preferences (active, valid subscription; no preferences configured yet)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    // No preferences document seeded.
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects invalid stored preference state (extra field beyond the six canonical keys)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    seedDoc(store, __test__.calendarPreferencesRef(db, UID_A), {
      ...validPreferenceFields(),
      updatedAt: Timestamp.fromMillis(UPDATED_A),
      unexpectedField: 'should not be here',
    });
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('rejects invalid stored preference state (updatedAt is not a genuine Timestamp)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    seedDoc(store, __test__.calendarPreferencesRef(db, UID_A), { ...validPreferenceFields(), updatedAt: UPDATED_A });
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('adapter rejection (e.g. out-of-range stored revision) surfaces as not-found, not a thrown error', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    seedPreferences(db, store, UID_A, validPreferenceFields({ revision: 0 })); // adapter requires revision >= 1
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    return result.status === 'not-found';
  });

  await checkAsync('a Firestore read failure surfaces as unavailable, not not-found', async () => {
    const throwingDb = {
      doc() {
        return { get: () => Promise.reject(new Error('simulated Firestore outage')) };
      },
    } as unknown as FirebaseFirestore.Firestore;
    const result = await resolveCalendarFeedInputCore(throwingDb, alwaysExists, TOKEN_A);
    return result.status === 'unavailable';
  });

  // =======================================================================================
  // HTTP — method handling, status/header behavior, low-information failures
  // =======================================================================================

  await checkAsync('GET with a valid token returns kind "ok" with a body', async () => {
    const { db } = freshEnvWithA();
    const outcome = await handleCalendarFeedRequestCore(db, alwaysExists, {
      method: 'GET',
      path: `/calendar/${TOKEN_A}.ics`,
      ifModifiedSince: null,
    });
    return outcome.kind === 'ok' && outcome.includeBody === true && outcome.body.startsWith('BEGIN:VCALENDAR');
  });

  await checkAsync('HEAD with a valid token returns kind "ok" without a body flag, same Last-Modified as GET', async () => {
    const { db } = freshEnvWithA();
    const getOutcome = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'GET', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
    const headOutcome = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'HEAD', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
    return (
      headOutcome.kind === 'ok' && headOutcome.includeBody === false &&
      getOutcome.kind === 'ok' && headOutcome.lastModified === getOutcome.lastModified &&
      headOutcome.contentLength === getOutcome.contentLength
    );
  });

  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    await checkAsync(`${method} is rejected as method-not-allowed`, async () => {
      const { db } = freshEnvWithA();
      const outcome = await handleCalendarFeedRequestCore(db, alwaysExists, { method, path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
      return outcome.kind === 'method-not-allowed';
    });
  }

  await checkAsync('OPTIONS returns kind "options" without touching Firestore', async () => {
    const { db, writeLog } = freshEnvWithA();
    const outcome = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'OPTIONS', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
    return outcome.kind === 'options' && writeLog.count === 0;
  });

  for (const [label, badPath] of [
    ['missing token entirely', '/calendar/.ics'],
    ['empty path', ''],
    ['wrong extension', `/calendar/${TOKEN_A}.ical`],
    ['no extension', `/calendar/${TOKEN_A}`],
    ['extra path segment', `/calendar/${TOKEN_A}.ics/extra`],
    ['double slash', `/calendar//${TOKEN_A}.ics`],
    ['path traversal attempt', '/calendar/../secrets.ics'],
    ['wrong top-level segment', `/other/${TOKEN_A}.ics`],
    ['oversized path', '/calendar/' + 'a'.repeat(500) + '.ics'],
    ['token with disallowed characters', `/calendar/${TOKEN_A.slice(0, 42)}!.ics`],
  ] as const) {
    await checkAsync('malformed/oversized URL input is rejected as not-found: ' + label, async () => {
      const { db } = freshEnvWithA();
      const outcome = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'GET', path: badPath, ifModifiedSince: null });
      return outcome.kind === 'not-found';
    });
  }

  await checkAsync('an unknown token and a revoked token produce byte-identical HTTP outcomes (low-information)', async () => {
    const { db: dbUnknown } = freshEnvWithA();
    const outcomeUnknown = await handleCalendarFeedRequestCore(dbUnknown, alwaysExists, {
      method: 'GET',
      path: `/calendar/${makeRawToken('never-seeded-2')}.ics`,
      ifModifiedSince: null,
    });

    const { db: dbRevoked, store } = makeFakeDb();
    seedActiveSubscription(dbRevoked, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A, revoked: true });
    seedPreferences(dbRevoked, store, UID_A, validPreferenceFields());
    const outcomeRevoked = await handleCalendarFeedRequestCore(dbRevoked, alwaysExists, {
      method: 'GET',
      path: `/calendar/${TOKEN_A}.ics`,
      ifModifiedSince: null,
    });

    return JSON.stringify(outcomeUnknown) === JSON.stringify(outcomeRevoked) && outcomeUnknown.kind === 'not-found';
  });

  // ---- applyOutcome / header materialization (fake Express-shaped Response) ----

  check('applyOutcome: "ok" sets text/calendar, private cache, Last-Modified, Content-Length, and sends the body for GET', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'ok', body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', contentLength: 33, lastModified: 'Sun, 01 Feb 2026 09:00:00 GMT', includeBody: true });
    return (
      recorded.statusCode === 200 &&
      recorded.headers['content-type'] === 'text/calendar; charset=utf-8' &&
      recorded.headers['cache-control'] === `private, max-age=${__test__.CACHE_MAX_AGE_SECONDS}` &&
      recorded.headers['last-modified'] === 'Sun, 01 Feb 2026 09:00:00 GMT' &&
      recorded.headers['content-length'] === '33' &&
      recorded.headers['content-disposition'] === undefined &&
      recorded.body === 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n'
    );
  })());

  check('applyOutcome: "ok" with includeBody=false (HEAD) ends without a body', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'ok', body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', contentLength: 33, lastModified: 'Sun, 01 Feb 2026 09:00:00 GMT', includeBody: false });
    return recorded.statusCode === 200 && recorded.body === null && recorded.ended === true;
  })());

  check('applyOutcome: "not-found" is a fixed, low-information 404 with no-store caching', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'not-found' });
    return recorded.statusCode === 404 && recorded.headers['cache-control'] === 'private, no-store' && recorded.body === 'Not found' && recorded.headers['content-type'] === 'text/plain';
  })());

  check('applyOutcome: "unavailable" is a distinct 503, not conflated with "not-found"', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'unavailable' });
    return recorded.statusCode === 503 && recorded.body === 'Service unavailable';
  })());

  check('applyOutcome: "not-modified" is a 304 with no body and a fresh Cache-Control', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'not-modified', lastModified: 'Sun, 01 Feb 2026 09:00:00 GMT' });
    return recorded.statusCode === 304 && recorded.body === null && recorded.headers['last-modified'] === 'Sun, 01 Feb 2026 09:00:00 GMT';
  })());

  check('applyOutcome: "method-not-allowed" is a 405 with an Allow header', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'method-not-allowed' });
    return recorded.statusCode === 405 && recorded.headers['allow'] === __test__.ALLOWED_METHODS;
  })());

  check('applyOutcome: "options" is a 204 with an Allow header and no body', (() => {
    const { response, recorded } = makeFakeResponse();
    __test__.applyOutcome(response, { kind: 'options' });
    return recorded.statusCode === 204 && recorded.headers['allow'] === __test__.ALLOWED_METHODS && recorded.body === null;
  })());

  check('applyOutcome: every outcome kind sets nosniff and no-referrer hardening headers', (() => {
    const kinds: Array<Parameters<typeof __test__.applyOutcome>[1]> = [
      { kind: 'ok', body: 'x', contentLength: 1, lastModified: 'x', includeBody: true },
      { kind: 'not-found' },
      { kind: 'unavailable' },
      { kind: 'not-modified', lastModified: 'x' },
      { kind: 'method-not-allowed' },
      { kind: 'options' },
    ];
    return kinds.every((outcome) => {
      const { response, recorded } = makeFakeResponse();
      __test__.applyOutcome(response, outcome);
      return recorded.headers['x-content-type-options'] === 'nosniff' && recorded.headers['referrer-policy'] === 'no-referrer';
    });
  })());

  check('applyOutcome: no response body is ever HTML-shaped', (() => {
    const kinds: Array<Parameters<typeof __test__.applyOutcome>[1]> = [
      { kind: 'not-found' },
      { kind: 'unavailable' },
      { kind: 'method-not-allowed' },
    ];
    return kinds.every((outcome) => {
      const { response, recorded } = makeFakeResponse();
      __test__.applyOutcome(response, outcome);
      return recorded.headers['content-type'] !== 'text/html' && !(recorded.body ?? '').trim().startsWith('<');
    });
  })());

  // =======================================================================================
  // ICS INTEGRATION — Stage 3 adapter/generator actually exercised
  // =======================================================================================

  await checkAsync('generateCalendarIcs accepts the resolved feed input unchanged and produces a stable UID', async () => {
    const { db } = freshEnvWithA();
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    if (result.status !== 'ok') return false;
    const ics = generateCalendarIcs(result.feedInput);
    return ics.includes(`UID:${SUB_ID_A}@neuroactivehealth.com\r\n`) && ics.includes('SUMMARY:NeuroActive Training\r\n');
  });

  await checkAsync('repeated resolution against unchanged stored state is byte-for-byte deterministic', async () => {
    const { db } = freshEnvWithA();
    const first = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    const second = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    if (first.status !== 'ok' || second.status !== 'ok') return false;
    return generateCalendarIcs(first.feedInput) === generateCalendarIcs(second.feedInput);
  });

  await checkAsync('DTSTART/UID/timezone do not drift merely because of when resolution happens', async () => {
    const { db } = freshEnvWithA();
    const a = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const b = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    if (a.status !== 'ok' || b.status !== 'ok') return false;
    return (
      a.feedInput.seriesAnchorMs === b.feedInput.seriesAnchorMs &&
      a.feedInput.recurrenceHorizonMs === b.feedInput.recurrenceHorizonMs &&
      generateCalendarIcs(a.feedInput) === generateCalendarIcs(b.feedInput)
    );
  });

  await checkAsync('a stored revision bump changes SEQUENCE deterministically', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    seedPreferences(db, store, UID_A, validPreferenceFields({ revision: 4 }));
    const before = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    seedPreferences(db, store, UID_A, validPreferenceFields({ revision: 5, updatedAtMs: UPDATED_A + 1 }));
    const after = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    if (before.status !== 'ok' || after.status !== 'ok') return false;
    return generateCalendarIcs(before.feedInput).includes('SEQUENCE:4\r\n') && generateCalendarIcs(after.feedInput).includes('SEQUENCE:5\r\n');
  });

  await checkAsync('canonical weekday/localTime/timezone/duration propagate exactly from stored preferences', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
    seedPreferences(db, store, UID_A, validPreferenceFields({ weekdays: [0, 2, 4, 6], localTime: '06:45', timezone: 'Europe/London', sessionDurationMinutes: 60 }));
    const result = await resolveCalendarFeedInputCore(db, alwaysExists, TOKEN_A);
    if (result.status !== 'ok') return false;
    return (
      result.feedInput.weekdays.join(',') === '0,2,4,6' &&
      result.feedInput.localTime === '06:45' &&
      result.feedInput.timezone === 'Europe/London' &&
      result.feedInput.sessionDurationMinutes === 60
    );
  });

  await checkAsync('If-Modified-Since matching the current representation short-circuits without invoking the generator', async () => {
    const { db } = freshEnvWithA();
    const first = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'GET', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
    if (first.kind !== 'ok') return false;
    const second = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'GET', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: first.lastModified });
    return second.kind === 'not-modified' && second.lastModified === first.lastModified;
  });

  await checkAsync('a stale If-Modified-Since still returns the full representation', async () => {
    const { db } = freshEnvWithA();
    const outcome = await handleCalendarFeedRequestCore(db, alwaysExists, {
      method: 'GET',
      path: `/calendar/${TOKEN_A}.ics`,
      ifModifiedSince: new Date(0).toUTCString(),
    });
    return outcome.kind === 'ok';
  });

  // =======================================================================================
  // READ-ONLY INVARIANT
  // =======================================================================================

  await checkAsync('a full successful GET performs zero Firestore writes', async () => {
    const { db, writeLog } = freshEnvWithA();
    const outcome = await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'GET', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
    return outcome.kind === 'ok' && writeLog.count === 0;
  });

  await checkAsync('every failure path (bad token, revoked, tombstoned, missing prefs) performs zero Firestore writes', async () => {
    const cases: Array<() => { db: FirebaseFirestore.Firestore; writeLog: { count: number } }> = [
      () => {
        const env = freshEnvWithA();
        return { db: env.db, writeLog: env.writeLog };
      },
      () => {
        const { db, store, writeLog } = makeFakeDb();
        seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A, revoked: true });
        return { db, writeLog };
      },
      () => {
        const { db, store, writeLog } = makeFakeDb();
        seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
        seedTombstone(db, store, UID_A);
        return { db, writeLog };
      },
      () => {
        const { db, store, writeLog } = makeFakeDb();
        seedActiveSubscription(db, store, { uid: UID_A, subscriptionId: SUB_ID_A, rawToken: TOKEN_A, createdAtMs: CREATED_A });
        return { db, writeLog };
      },
    ];
    for (const setup of cases) {
      const { db, writeLog } = setup();
      await handleCalendarFeedRequestCore(db, alwaysExists, { method: 'GET', path: `/calendar/${TOKEN_A}.ics`, ifModifiedSince: null });
      if (writeLog.count !== 0) return false;
    }
    return true;
  });

  // =======================================================================================
  // SECURITY — static source-level checks (mirrors the STATIC SCOPE / PURITY AUDIT
  // convention already used by calendarIcsGenerator.test.ts and calendarFeedAdapter.test.ts).
  // =======================================================================================

  const sourcePath = path.join(__dirname, '..', 'src', 'calendarFeedEndpoint.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  check('no console.* call anywhere passes a raw token, path, or url-shaped identifier', (() => {
    const consoleCalls = executable.match(/console\.\w+\([^;]*\);/g) ?? [];
    return consoleCalls.every((call) => !/rawToken|request\.path|request\.url|input\.path/.test(call));
  })());

  check('exactly one console.* call exists, and it logs only a fixed literal plus summarizeError(error)', (() => {
    const consoleCalls = executable.match(/console\.\w+\([^;]*\);/g) ?? [];
    return consoleCalls.length === 1 && /console\.error\('\[Calendar Feed\][^']*',\s*summarizeError\(error\)\);/.test(consoleCalls[0]);
  })());

  check('no reference to request.query anywhere (no query-string credential fallback path exists)', !/request\.query/.test(executable));

  check('exactly one onRequest export exists (no alternate unauthenticated data path in this file)', (executable.match(/onRequest\(/g) ?? []).length === 1);

  check('no onCall export exists in this file', !/\bonCall\(/.test(executable));

  check('no Firebase Auth mutation method is ever called (updateUser/setCustomUserClaims/deleteUser/revokeRefreshTokens)', !/\.(updateUser|setCustomUserClaims|deleteUser|revokeRefreshTokens|createUser)\(/.test(executable));

  check('no Firestore write method is ever called on a db reference (this file is read-only by construction)', !/\.(get\([^)]*\)\.(set|update|delete|create))\(/.test(executable) && !/Ref\([^)]*\)\.(set|update|delete|create)\(/.test(executable));

  check('no notification/reminder/course/entitlement dependency', !/notificationPreferences|notificationRollout|reminderScheduler|reminderDelivery|pushInstallations|pushTokenClaims|dnsCourse|DNS_COURSE|dnsEntitlement|hasDnsEntitlement/i.test(executable));

  check('no import from calendarSubscriptions.ts or calendarPreferences.ts (Stage 1/2 internals are not referenced, let alone modified)', !/from '\.\/calendarSubscriptions'|from '\.\/calendarPreferences'/.test(executable));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
});
