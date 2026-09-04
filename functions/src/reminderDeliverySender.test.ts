// functions/src/reminderDeliverySender.test.ts
// Phase 3A-3 Step 3C-5 — repository-local test file for the sole FCM transport call site and
// its safe orchestration entry point, reminderDeliverySender.ts.
//
// CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR (SIXTH round, SECOND pass) — there is no
// longer a separate "reminderDeliverySenderCore.ts" anywhere in this codebase (see
// reminderDeliverySender.ts's own header for why the earlier separate-core-file design was
// abandoned: `tsc` emits any file an included file imports, `exclude` notwithstanding — so a
// separately importable, parameterized orchestration function could never actually be kept
// out of the deployed artifact while still being invoked by production). The full algorithm
// now lives, module-private, inside reminderDeliverySender.ts itself, behind a single
// zero-authority-parameter export, processControlledSendCandidate(reminderId, installationId,
// expectedProcessingAttemptCount), which privately resolves its own db/OAuth/transport
// authority from IMMUTABLY-CAPTURED module state.
//
// HOW THIS FILE STILL DRIVES THE REAL PRODUCTION CODE WITH FAKE DEPENDENCIES (not a
// reimplementation): Node's `require()` cache means a module's top-level code — including
// reminderDeliverySender.ts's own IMMUTABLE CAPTURE block — runs exactly once per resolved
// module id, the first time it is required in a process. `loadFreshSenderModule()` below
// exploits this deliberately: it mutates `firebase-admin/app`'s / `firebase-admin/
// firestore`'s / `./reminderDeliveryAuth`'s / `./fcmTransport`'s own exported properties to
// fakes, clears `require.cache[require.resolve('./reminderDeliverySender')]` (forcing the
// next require to re-evaluate the module from scratch against whatever those dependencies
// currently export), requires it fresh — capturing the fakes into THAT ONE module instance's
// local consts — and immediately restores the real exports afterward (the fresh instance's
// captured consts are unaffected by that restoration; capture already happened). This is
// squarely the case Codex's own instruction (section 9, this round) carves out of the threat
// model: "a test controlling its own require order before first exercising the module" is not
// "an ordinary future production import/caller." No production module's exports are ever left
// mutated for longer than the single synchronous require() call that needs them.
//
// This file also separately verifies, via compiled-output/source inspection, that:
// reminderDeliverySender.js is the ONLY compiled module exporting the transport-capable entry
// point; that entry point's real runtime arity leaves no parameter slot for a fake
// db/provider/transport; the 5 dependency functions are captured into plain top-level consts
// exactly once each and never re-read; and the deleted core files are genuinely absent from
// both the source tree and node's module resolution.
//
// HOW TO RUN:
//   cd functions
//   npm run build:test
//   node lib/reminderDeliverySender.test.js
import * as fs from 'fs';
import * as path from 'path';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  buildFirstSendNotificationMessage,
  translateFcmOutcomeToDeliveryOutcome,
  classifyAttemptOutcomeCategory,
  extractAttemptHttpStatus,
  REAL_DELIVERY_STAGE,
} from './reminderDeliverySender';
import type * as SenderModule from './reminderDeliverySender';
import type { FcmSendOutcome, SendFcmOnceParams } from './fcmTransport';
import type { AccessTokenProvider } from './reminderDeliveryAuth';
import { OPAQUE_ID_LENGTH, MAX_SEND_ATTEMPTS, DELIVERY_RETRY_BACKOFF_MS } from './reminderDeliveryLogic';
import { createHash } from 'node:crypto';

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

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

// =========================================================================================
// FAKE FIRESTORE — same minimal document get/update/transaction pattern already established
// in reminderDeliveryAuth.test.ts / reminderDeliveryWorker.test.ts.
// =========================================================================================

type StoredDoc = Record<string, unknown>;
type Store = Map<string, StoredDoc>;

function resolveFieldValues(data: Record<string, unknown>): StoredDoc {
  const result: StoredDoc = {};
  for (const [k, v] of Object.entries(data)) {
    result[k] = v instanceof FieldValue ? Timestamp.now() : v;
  }
  return result;
}

class FakeCollectionRef {
  constructor(public readonly path: string) {}
  get parent(): FakeDocumentRef | null {
    const segs = this.path.split('/');
    segs.pop();
    if (segs.length === 0) return null;
    return new FakeDocumentRef(segs.join('/'));
  }
}

class FakeDocumentRef {
  readonly id: string;
  constructor(public readonly path: string) {
    this.id = path.split('/').pop() as string;
  }
  get parent(): FakeCollectionRef {
    const segs = this.path.split('/');
    segs.pop();
    return new FakeCollectionRef(segs.join('/'));
  }
}

class FakeDocumentSnapshot {
  constructor(
    private readonly store: Store,
    public readonly path: string
  ) {}
  get exists(): boolean {
    return this.store.has(this.path);
  }
  data(): StoredDoc | undefined {
    const raw = this.store.get(this.path);
    return raw ? { ...raw } : undefined;
  }
}

type PendingWrite = { path: string; data: Record<string, unknown> };

class FakeTransaction {
  readonly pendingWrites: PendingWrite[] = [];
  constructor(private readonly store: Store) {}
  async get(ref: FakeDocumentRef): Promise<FakeDocumentSnapshot> {
    return new FakeDocumentSnapshot(this.store, ref.path);
  }
  update(ref: FakeDocumentRef, data: Record<string, unknown>): void {
    if (!this.store.has(ref.path)) throw new Error(`FakeTransaction.update: document does not exist at ${ref.path}`);
    this.pendingWrites.push({ path: ref.path, data });
  }
}

function makeFakeDb(): { db: FirebaseFirestore.Firestore; store: Store } {
  const store: Store = new Map();
  const db = {
    doc(p: string) {
      return new FakeDocumentRef(p);
    },
    async runTransaction<T>(cb: (t: FakeTransaction) => Promise<T>): Promise<T> {
      const transaction = new FakeTransaction(store);
      const result = await cb(transaction);
      for (const write of transaction.pendingWrites) {
        const existing = store.get(write.path) ?? {};
        store.set(write.path, { ...existing, ...resolveFieldValues(write.data) });
      }
      return result;
    },
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, store };
}

function seedDoc(store: Store, docPath: string, data: Record<string, unknown>): void {
  store.set(docPath, resolveFieldValues(data));
}
function readDoc(store: Store, docPath: string): StoredDoc | undefined {
  const raw = store.get(docPath);
  return raw ? { ...raw } : undefined;
}

// =========================================================================================
// REQUIRE-CACHE-BUSTING LOADER — see file header. Mutates the 4 dependency modules' exports
// to fakes, forces a fresh evaluation of reminderDeliverySender.ts (capturing the fakes),
// then restores the real exports immediately. Every scenario below that needs to reach
// (fake) transport calls this to get its OWN fresh module instance — each with its own
// private `cachedDb`/`cachedAccessTokenProvider`, so scenarios never leak state into
// each other.
// =========================================================================================

type FcmTransportFn = (params: SendFcmOnceParams) => Promise<FcmSendOutcome>;

interface DependencyFakes {
  db: FirebaseFirestore.Firestore;
  accessTokenProvider: AccessTokenProvider;
  transport: FcmTransportFn;
}

// firebase-admin's own named exports (getApps/initializeApp) are getter-only accessor
// properties (ESM/CJS interop), not plain writable values like our own compiled modules'
// exports — a bare `mod.prop = fake` assignment throws against a getter-only property.
// Object.defineProperty works uniformly against both shapes and lets the original descriptor
// (accessor or data) be restored exactly.
function setExport(mod: object, key: string, value: unknown): PropertyDescriptor | undefined {
  const original = Object.getOwnPropertyDescriptor(mod, key);
  Object.defineProperty(mod, key, { value, writable: true, configurable: true, enumerable: true });
  return original;
}
function restoreExport(mod: object, key: string, original: PropertyDescriptor | undefined): void {
  if (original) Object.defineProperty(mod, key, original);
}

function loadFreshSenderModule(fakes: DependencyFakes): typeof SenderModule {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const appMod = require('firebase-admin/app') as object;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const firestoreMod = require('firebase-admin/firestore') as object;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const authMod = require('./reminderDeliveryAuth') as object;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const transportMod = require('./fcmTransport') as object;

  const originals = {
    getApps: setExport(appMod, 'getApps', () => []),
    initializeApp: setExport(appMod, 'initializeApp', () => undefined),
    getFirestore: setExport(firestoreMod, 'getFirestore', () => fakes.db),
    createGoogleAuthAccessTokenProvider: setExport(authMod, 'createGoogleAuthAccessTokenProvider', () => fakes.accessTokenProvider),
    sendFcmOnce: setExport(transportMod, 'sendFcmOnce', fakes.transport),
  };

  try {
    const resolved = require.resolve('./reminderDeliverySender');
    delete require.cache[resolved];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./reminderDeliverySender') as typeof SenderModule;
  } finally {
    restoreExport(appMod, 'getApps', originals.getApps);
    restoreExport(appMod, 'initializeApp', originals.initializeApp);
    restoreExport(firestoreMod, 'getFirestore', originals.getFirestore);
    restoreExport(authMod, 'createGoogleAuthAccessTokenProvider', originals.createGoogleAuthAccessTokenProvider);
    restoreExport(transportMod, 'sendFcmOnce', originals.sendFcmOnce);
  }
}

// =========================================================================================
// FIXTURES
// =========================================================================================

const OTHER_EXECUTION_ID = 'G'.repeat(OPAQUE_ID_LENGTH);
const RAW_ACCESS_TOKEN = 'ya29.raw-oauth-token-should-never-persist-or-log';
const okAccessTokenProvider: AccessTokenProvider = async () => RAW_ACCESS_TOKEN;

const ORCH_UID = 'user-1';
const ORCH_REMINDER_ID = `${ORCH_UID}_2000`;
const ORCH_INSTALLATION_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const ORCH_FANOUT_EXECUTION_ID = 'H'.repeat(OPAQUE_ID_LENGTH);
const ORCH_DELIVERY_PATH = `artifacts/neuroactive-prod/reminders/${ORCH_REMINDER_ID}/deliveries/${ORCH_INSTALLATION_ID}`;
const ORCH_RAW_TOKEN = 'raw-fcm-token-orchestration-should-never-persist-or-log';

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

interface OrchestrationFixtureOverrides {
  reminder?: Record<string, unknown> | null;
  delivery?: Record<string, unknown>;
  preference?: Record<string, unknown> | null;
  rollout?: Record<string, unknown>;
  installation?: Record<string, unknown> | null;
  tokenClaim?: Record<string, unknown> | null;
  experimentGate?: Record<string, unknown> | null;
}

function seedOrchestrationPreparingFixture(store: Store, overrides: OrchestrationFixtureOverrides): void {
  if (overrides.reminder !== null) {
    seedDoc(store, `artifacts/neuroactive-prod/reminders/${ORCH_REMINDER_ID}`, {
      uid: ORCH_UID,
      status: 'delivery-fanned-out',
      deliveryFanoutState: 'completed',
      targetInstallationCountAtFanout: 1,
      excludedMalformedInstallationCount: 0,
      fanoutExecutionId: ORCH_FANOUT_EXECUTION_ID,
      workState: 'terminal',
      workAvailableAt: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      preferenceRevisionAtClaim: 1,
      scheduleTypeAtClaim: 'daily',
      weekdaysAtClaim: [0, 1, 2, 3, 4, 5, 6],
      localTimeAtClaim: '07:00',
      timezoneAtClaim: 'UTC',
      ...overrides.reminder,
    });
  }
  const preparingLeaseMs = Date.now() + 5 * 60 * 1000;
  seedDoc(store, ORCH_DELIVERY_PATH, {
    state: 'preparing',
    workState: 'queued',
    workAvailableAt: Timestamp.fromMillis(preparingLeaseMs),
    leaseExpiresAt: Timestamp.fromMillis(preparingLeaseMs),
    uid: ORCH_UID,
    installationId: ORCH_INSTALLATION_ID,
    deliveryPublicId: 'A'.repeat(OPAQUE_ID_LENGTH),
    fanoutExecutionIdAtCreation: ORCH_FANOUT_EXECUTION_ID,
    sendAttemptCount: 0,
    processingAttemptCount: 1,
    attemptHistory: [],
    targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    ...overrides.delivery,
  });
  if (overrides.preference !== null) {
    seedDoc(store, `artifacts/neuroactive-prod/users/${ORCH_UID}/notificationPreferences/main`, {
      enabled: true,
      revision: 1,
      scheduleType: 'daily',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      localTime: '07:00',
      timezone: 'UTC',
      ...overrides.preference,
    });
  }
  seedDoc(store, 'artifacts/neuroactive-prod/systemConfig/notificationRollout', overrides.rollout ?? { mode: 'paused' });
  // Step 3C-7 — the experiment-wide one-shot gate is now an unconditional precondition for
  // EVERY real-send authorization (see reminderDeliveryAuth.ts). Every scenario in this file
  // that reaches 'sending-authorized' needs a matching armed gate; none of them are testing
  // gate behavior itself (that is reminderDeliveryAuth.test.ts's job), so it is seeded here,
  // unconditionally, matching this fixture's own fixed ORCH identity.
  if (overrides.experimentGate !== null) {
    seedDoc(store, 'artifacts/neuroactive-prod/systemConfig/firstRealSendExperimentGate', {
      state: 'armed',
      expectedUid: ORCH_UID,
      expectedReminderId: ORCH_REMINDER_ID,
      expectedScheduledForMs: 2000,
      expectedInstallationId: ORCH_INSTALLATION_ID,
      createdAt: Timestamp.now(),
      consumedAt: null,
      consumedByExecutionId: null,
      ...overrides.experimentGate,
    });
  }
  if (overrides.installation !== null) {
    seedDoc(store, `artifacts/neuroactive-prod/pushInstallations/${ORCH_INSTALLATION_ID}`, {
      uid: ORCH_UID,
      state: 'active',
      epochSchemaVersion: 1,
      tokenVersion: 1,
      installationAudienceId: 'A'.repeat(16),
      generation: 1,
      token: ORCH_RAW_TOKEN,
      ...overrides.installation,
    });
  }
  if (overrides.tokenClaim !== null) {
    seedDoc(store, `artifacts/neuroactive-prod/pushTokenClaims/${sha256Hex(ORCH_RAW_TOKEN)}`, {
      installationId: ORCH_INSTALLATION_ID,
      uid: ORCH_UID,
      ...overrides.tokenClaim,
    });
  }
}

const ACCEPTED_OUTCOME: FcmSendOutcome = { kind: 'accepted', httpStatus: 200, messageName: 'projects/neuroactive/messages/abc123' };
const REJECTED_UNREGISTERED: FcmSendOutcome = { kind: 'rejected', httpStatus: 404, category: 'unregistered' };
const REJECTED_INVALID_ARGUMENT: FcmSendOutcome = { kind: 'rejected', httpStatus: 400, category: 'invalid-argument' };
const REJECTED_UNAUTHENTICATED: FcmSendOutcome = { kind: 'rejected', httpStatus: 401, category: 'unauthenticated' };
const REJECTED_PERMISSION_DENIED: FcmSendOutcome = { kind: 'rejected', httpStatus: 403, category: 'permission-denied' };
const REJECTED_OTHER: FcmSendOutcome = { kind: 'rejected', httpStatus: 409, category: 'other-definitive-rejection' };
const REJECTED_RETRYABLE: FcmSendOutcome = { kind: 'rejected', httpStatus: 429, category: 'retryable-later' };
const UNKNOWN_TIMEOUT: FcmSendOutcome = { kind: 'unknown-outcome', reason: 'timeout' };
const UNKNOWN_NETWORK: FcmSendOutcome = { kind: 'unknown-outcome', reason: 'network-error' };
const UNKNOWN_5XX: FcmSendOutcome = { kind: 'unknown-outcome', reason: 'ambiguous-server-response', detail: 'status 503' };
const UNKNOWN_MALFORMED: FcmSendOutcome = { kind: 'unknown-outcome', reason: 'malformed-response' };
const NOT_ATTEMPTED: FcmSendOutcome = { kind: 'request-not-attempted', reason: 'wrong-project' };

function fakeTransport(impl: (params: SendFcmOnceParams) => Promise<FcmSendOutcome>): { transport: FcmTransportFn; callCount: () => number } {
  let calls = 0;
  const transport: FcmTransportFn = async (params) => {
    calls++;
    return impl(params);
  };
  return { transport, callCount: () => calls };
}

// Convenience: builds a fresh module instance wired to a fake db/transport for one call.
function freshSenderFor(db: FirebaseFirestore.Firestore, transport: FcmTransportFn): typeof SenderModule {
  return loadFreshSenderModule({ db, accessTokenProvider: okAccessTokenProvider, transport });
}

async function main(): Promise<void> {
  const srcDir = path.join(__dirname, '..', 'src');
  const senderSourcePath = path.join(srcDir, 'reminderDeliverySender.ts');
  const senderSource = fs.readFileSync(senderSourcePath, 'utf8');
  const senderCodeOnly = stripComments(senderSource);

  // =======================================================================================
  // buildFirstSendNotificationMessage — fixed schema, pure. Driven through the vanilla,
  // ONE-TIME top-level import: these helpers never touch Firestore/OAuth/transport, so the
  // real (never-invoked-for-orchestration) module instance is safe to use directly.
  // =======================================================================================
  console.log('\n=== buildFirstSendNotificationMessage ===');

  check('valid token -> message carries the exact token and a notification object', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    return msg.token === 'some-token' && typeof msg.notification === 'object' && msg.notification !== null;
  })());
  check(
    'message notification has fixed, nonempty title/body (compatible with the existing SW auto-display path)',
    (() => {
      const msg = buildFirstSendNotificationMessage('some-token');
      const notification = msg.notification as { title: string; body: string };
      return typeof notification.title === 'string' && notification.title.length > 0 && typeof notification.body === 'string' && notification.body.length > 0;
    })()
  );
  // Step 3C-9 — exact first-real-send contract, pinned precisely (not just "nonempty").
  check("notification.title === 'NeuroActive'", (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    return (msg.notification as { title: string }).title === 'NeuroActive';
  })());
  check("notification.body === 'Your next session is ready.'", (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    return (msg.notification as { body: string }).body === 'Your next session is ready.';
  })());
  check("webpush.fcmOptions.link === 'https://neuroactivehealth.com/' (exact approved absolute URL, not a relative path)", (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const webpush = msg.webpush as { fcmOptions?: { link?: unknown } } | undefined;
    return webpush?.fcmOptions?.link === 'https://neuroactivehealth.com/';
  })());
  check("webpush.fcmOptions.link parses as a URL whose protocol === 'https:'", (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const webpush = msg.webpush as { fcmOptions: { link: string } };
    return new URL(webpush.fcmOptions.link).protocol === 'https:';
  })());
  check("webpush.fcmOptions.link's origin === 'https://neuroactivehealth.com' exactly", (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const webpush = msg.webpush as { fcmOptions: { link: string } };
    return new URL(webpush.fcmOptions.link).origin === 'https://neuroactivehealth.com';
  })());
  check("webpush.fcmOptions.link's pathname === '/' exactly (the PWA root landing/open target, no sub-path)", (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const webpush = msg.webpush as { fcmOptions: { link: string } };
    return new URL(webpush.fcmOptions.link).pathname === '/';
  })());
  check('message contains no other top-level keys beyond token/notification/webpush', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    return JSON.stringify(Object.keys(msg).sort()) === JSON.stringify(['notification', 'token', 'webpush']);
  })());
  check('webpush object contains no other top-level keys beyond fcmOptions, and fcmOptions contains no other keys beyond link', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const webpush = msg.webpush as Record<string, unknown>;
    const fcmOptions = webpush.fcmOptions as Record<string, unknown>;
    return JSON.stringify(Object.keys(webpush).sort()) === JSON.stringify(['fcmOptions']) && JSON.stringify(Object.keys(fcmOptions).sort()) === JSON.stringify(['link']);
  })());
  check('notification content is not user-specific: no lesson number, day number, health/pain wording, UID, or reminder ID appears anywhere in the visible notification.title/body (the token field is deliberately excluded — it is an opaque installation token, not visible text; the webpush.fcmOptions.link is checked separately below since it legitimately contains the company domain, which itself contains the substring "health")', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const serialized = JSON.stringify(msg.notification).toLowerCase();
    const forbidden = ['lesson', 'day ', 'pain', 'health', 'uid', 'reminderid', 'user-1', 'session-1'];
    return forbidden.every((needle) => !serialized.includes(needle));
  })());
  check('webpush.fcmOptions.link is exactly the one approved production URL and nothing else (never a caller-influenced or dynamically-built value)', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    const webpush = msg.webpush as { fcmOptions: { link: string } };
    return webpush.fcmOptions.link === 'https://neuroactivehealth.com/';
  })());
  check('empty-string token throws', (() => {
    try {
      buildFirstSendNotificationMessage('');
      return false;
    } catch {
      return true;
    }
  })());
  check('non-string token throws', (() => {
    try {
      buildFirstSendNotificationMessage(12345);
      return false;
    } catch {
      return true;
    }
  })());
  check('two calls with different tokens never share a message object reference', (() => {
    const a = buildFirstSendNotificationMessage('token-a');
    const b = buildFirstSendNotificationMessage('token-b');
    return a !== b && a.token !== b.token;
  })());

  // =======================================================================================
  // Outcome translation helpers.
  // =======================================================================================
  console.log('\n=== translateFcmOutcomeToDeliveryOutcome / classifyAttemptOutcomeCategory / extractAttemptHttpStatus ===');

  check('accepted -> DeliverySendOutcomeKind accepted, category accepted, httpStatus 200', (() => {
    const d = translateFcmOutcomeToDeliveryOutcome(ACCEPTED_OUTCOME);
    return d.kind === 'accepted' && classifyAttemptOutcomeCategory(ACCEPTED_OUTCOME) === 'accepted' && extractAttemptHttpStatus(ACCEPTED_OUTCOME) === 200;
  })());

  const rejectionCases: [FcmSendOutcome, string, number][] = [
    [REJECTED_UNREGISTERED, 'unregistered', 404],
    [REJECTED_INVALID_ARGUMENT, 'invalid-argument', 400],
    [REJECTED_UNAUTHENTICATED, 'unauthenticated', 401],
    [REJECTED_PERMISSION_DENIED, 'permission-denied', 403],
    [REJECTED_OTHER, 'other-definitive-rejection', 409],
    [REJECTED_RETRYABLE, 'retryable-later', 429],
  ];
  for (const [outcome, expectedCategory, expectedStatus] of rejectionCases) {
    check(`rejected/${expectedCategory} translates+classifies+extracts correctly`, (() => {
      const d = translateFcmOutcomeToDeliveryOutcome(outcome);
      return (
        d.kind === 'rejected' &&
        d.category === expectedCategory &&
        classifyAttemptOutcomeCategory(outcome) === expectedCategory &&
        extractAttemptHttpStatus(outcome) === expectedStatus
      );
    })());
  }

  for (const outcome of [UNKNOWN_TIMEOUT, UNKNOWN_NETWORK, UNKNOWN_5XX, UNKNOWN_MALFORMED, NOT_ATTEMPTED]) {
    check(`${outcome.kind} (${'reason' in outcome ? outcome.reason : ''}) -> DeliverySendOutcomeKind ${outcome.kind}, history category 'unknown-outcome', httpStatus null`, (() => {
      const d = translateFcmOutcomeToDeliveryOutcome(outcome);
      return d.kind === outcome.kind && classifyAttemptOutcomeCategory(outcome) === 'unknown-outcome' && extractAttemptHttpStatus(outcome) === null;
    })());
  }

  // =======================================================================================
  // COMPILED EXPORT-SURFACE AUDIT — single-file production module. No separate core file
  // exists anywhere; this checks the ONE compiled module's real export surface.
  // =======================================================================================
  console.log('\n=== compiled export-surface audit ===');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const compiledWrapperExports = require('./reminderDeliverySender') as Record<string, unknown>;
  const compiledWrapperExportNames = Object.keys(compiledWrapperExports).sort();

  check(
    "compiled lib/reminderDeliverySender.js exports 'processControlledSendCandidate' as a function with EXACTLY 3 runtime parameters (reminderId, installationId, expectedProcessingAttemptCount) — no db, no provider, no transport parameter slot",
    typeof compiledWrapperExports.processControlledSendCandidate === 'function' &&
      (compiledWrapperExports.processControlledSendCandidate as (...args: unknown[]) => unknown).length === 3
  );
  const expectedWrapperExportNames = [
    'REAL_DELIVERY_STAGE',
    'buildFirstSendNotificationMessage',
    'classifyAttemptOutcomeCategory',
    'extractAttemptHttpStatus',
    'processControlledSendCandidate',
    'translateFcmOutcomeToDeliveryOutcome',
  ].sort();
  check(
    `compiled lib/reminderDeliverySender.js exports EXACTLY the expected runtime surface — actual [${compiledWrapperExportNames.join(', ')}]`,
    JSON.stringify(compiledWrapperExportNames) === JSON.stringify(expectedWrapperExportNames)
  );
  check(
    "compiled lib/reminderDeliverySender.js does NOT export 'commitSendOutcome', 'executeControlledSend', 'getProductionSenderDb', or 'getProductionSenderAccessTokenProvider' — all four remain module-private post-compilation",
    ['commitSendOutcome', 'executeControlledSend', 'getProductionSenderDb', 'getProductionSenderAccessTokenProvider'].every(
      (n) => !Object.prototype.hasOwnProperty.call(compiledWrapperExports, n)
    )
  );
  check("REAL_DELIVERY_STAGE is 'allowlisted-only'", REAL_DELIVERY_STAGE === 'allowlisted-only');
  check("REAL_DELIVERY_STAGE !== 'general' — this round's review covers only 'allowlisted-only'", (REAL_DELIVERY_STAGE as string) !== 'general');

  // =======================================================================================
  // DIRECT-REQUIRE ATTACK TEST — the FIFTH round's core files no longer exist anywhere in
  // the source tree at all (not merely excluded from the production tsconfig). Confirms this
  // structurally: node's own module resolution must fail with MODULE_NOT_FOUND, and the
  // directory/files themselves are absent from both src/ and the compiled test build.
  // =======================================================================================
  console.log('\n=== direct-require attack test (deleted core files) ===');

  check('src/testsupport/ directory does not exist', !fs.existsSync(path.join(srcDir, 'testsupport')));
  for (const modName of ['./testsupport/reminderDeliverySenderCore', './testsupport/reminderDeliveryWorkerCore']) {
    check(`require('${modName}') throws MODULE_NOT_FOUND`, (() => {
      try {
        require(modName);
        return false;
      } catch (err) {
        return err instanceof Error && (err as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND';
      }
    })());
  }

  // =======================================================================================
  // CODEX H1 EXPLOIT RETEST — a fabricated, fully-fake Firestore-shaped authorization
  // universe cannot reach transport through the compiled production wrapper: there is no
  // parameter through which to inject a fake db/provider/transport at all.
  // =======================================================================================
  console.log('\n=== Codex H1 exploit retest (fake authorization universe via production exports) ===');

  check(
    '[H1 retest] the compiled production wrapper exposes no authority-hook export (getTrustedDeliveryDb/getTrustedDeliveryAccessTokenProvider/getProductionSenderDb/getProductionSenderAccessTokenProvider) and processControlledSendCandidate\'s real runtime arity (3) leaves no slot for a fake db/provider/transport; JS silently ignores any 4th positional argument since this file\'s own source never reads `arguments[...]` or a rest parameter',
    (() => {
      const forbiddenNames = ['getTrustedDeliveryDb', 'getTrustedDeliveryAccessTokenProvider', 'getProductionSenderDb', 'getProductionSenderAccessTokenProvider'];
      if (forbiddenNames.some((n) => compiledWrapperExportNames.includes(n))) return false;
      if ((compiledWrapperExports.processControlledSendCandidate as (...args: unknown[]) => unknown).length !== 3) return false;
      if (senderCodeOnly.includes('arguments[') || senderCodeOnly.includes('...args')) return false;
      return true;
    })()
  );

  // =======================================================================================
  // BUILD-TIME CONFIG REGRESSION GUARD — cheap, safe, repeatable checks that the config
  // shape a real `npm run build` (production) depends on has not silently drifted. The
  // DEFINITIVE proof (a real production build genuinely never emits a core file, because no
  // such file exists) is a manual, one-time-per-round verification (see this round's report)
  // — rebuilding from inside a currently-executing compiled test file is unsafe (the
  // production build's `clean` step deletes the whole lib/ directory, including this file's
  // own already-loaded .js, mid-execution).
  // =======================================================================================
  console.log('\n=== build-time config regression guard ===');

  check(
    "functions/tsconfig.json (the PRODUCTION config — the only one firebase.json's predeploy hook ever runs) excludes '**/*.test.ts' from src/, so 'npm run build' never emits test files into lib/",
    (() => {
      const tsconfigPath = path.join(__dirname, '..', 'tsconfig.json');
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as { exclude?: string[] };
      return (tsconfig.exclude ?? []).includes('src/**/*.test.ts');
    })()
  );
  check(
    "functions/tsconfig.json excludes 'src/**/*.emulatorSuite.ts' from the PRODUCTION build (Step 3C-7), so the Firestore-emulator-only gate concurrency harness can never be compiled into lib/ and shipped as part of the deployed Function",
    (() => {
      const tsconfigPath = path.join(__dirname, '..', 'tsconfig.json');
      const tsconfig = JSON.parse(fs.readFileSync(tsconfigPath, 'utf8')) as { exclude?: string[] };
      return (tsconfig.exclude ?? []).includes('src/**/*.emulatorSuite.ts');
    })()
  );
  check(
    "functions/tsconfig.test.json's exclude array does NOT exclude '*.emulatorSuite.ts' (it is empty, so nothing under src/ is excluded from the TEST build) — the emulator suite still compiles into lib-test/",
    (() => {
      const testTsconfigPath = path.join(__dirname, '..', 'tsconfig.test.json');
      const testTsconfig = JSON.parse(fs.readFileSync(testTsconfigPath, 'utf8')) as { exclude?: unknown[] };
      return Array.isArray(testTsconfig.exclude) && !testTsconfig.exclude.includes('src/**/*.emulatorSuite.ts');
    })()
  );
  check(
    "functions/tsconfig.test.json exists, extends the production config, overrides 'exclude' to compile everything (including *.test.ts), and emits into 'lib-test' — a directory distinct from the production config's 'lib' outDir, so a test build can never overlap production output",
    (() => {
      const testTsconfigPath = path.join(__dirname, '..', 'tsconfig.test.json');
      const testTsconfig = JSON.parse(fs.readFileSync(testTsconfigPath, 'utf8')) as {
        extends?: string;
        exclude?: unknown[];
        compilerOptions?: { outDir?: string };
      };
      return (
        testTsconfig.extends === './tsconfig.json' &&
        Array.isArray(testTsconfig.exclude) &&
        testTsconfig.exclude.length === 0 &&
        testTsconfig.compilerOptions?.outDir === 'lib-test'
      );
    })()
  );
  check(
    "functions/package.json's 'build'/'clean' scripts clean and (re)compile ONLY lib/ (never referencing 'lib-test'), and 'build:test'/'clean:test' clean and (re)compile ONLY lib-test/ (never referencing production 'lib') — the two script pairs never touch the other's output directory in EITHER direction, so 'npm run build:test' can never delete or overwrite a prior 'npm run build's production output, and a future 'npm run build' can never delete or overwrite 'lib-test'",
    (() => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> };
      return (
        pkg.scripts.build === 'npm run clean && tsc' &&
        pkg.scripts['build:test'] === 'npm run clean:test && tsc -p tsconfig.test.json' &&
        pkg.scripts.clean.includes('rmSync') &&
        pkg.scripts.clean.includes("'lib'") &&
        !pkg.scripts.clean.includes("'lib-test'") &&
        pkg.scripts['clean:test'].includes('rmSync') &&
        pkg.scripts['clean:test'].includes("'lib-test'") &&
        !pkg.scripts['clean:test'].includes("'lib'")
      );
    })()
  );
  check(
    "the repository root firebase.json wires functions.predeploy to run functions' own 'npm run build' (the production-only, clean config) — every firebase deploy is guaranteed to rebuild lib/ cleanly immediately before packaging",
    (() => {
      const firebaseJsonPath = path.join(__dirname, '..', '..', 'firebase.json');
      const firebaseJson = JSON.parse(fs.readFileSync(firebaseJsonPath, 'utf8')) as { functions?: { predeploy?: string[] } };
      const predeploy = firebaseJson.functions?.predeploy ?? [];
      return predeploy.some((cmd) => cmd.includes('run build') && cmd.includes('RESOURCE_DIR'));
    })()
  );

  // =======================================================================================
  // IMMUTABLE AUTHORITY CAPTURE (H3/H4) — static proof against the ACTUAL compiled JS. Each
  // of the 5 dependency functions is captured into a plain top-level `const` exactly once,
  // and never read a second time through the live imported-module property anywhere else in
  // the file — the only way a later mutation of e.g. `require('./fcmTransport').sendFcmOnce`
  // could affect this file's behavior is if the file re-read that property somewhere else,
  // which this proves it structurally does not.
  // =======================================================================================
  console.log('\n=== immutable authority capture (H3/H4) ===');

  const compiledSenderJsPath = path.join(__dirname, 'reminderDeliverySender.js');
  const compiledSenderJs = fs.readFileSync(compiledSenderJsPath, 'utf8');
  const CAPTURED_NAMES = ['capturedGetApps', 'capturedInitializeApp', 'capturedGetFirestore', 'capturedCreateGoogleAuthAccessTokenProvider', 'capturedSendFcmOnce'];
  const DEPENDENCY_FN_NAMES = ['getApps', 'initializeApp', 'getFirestore', 'createGoogleAuthAccessTokenProvider', 'sendFcmOnce'];

  check(
    'compiled lib/reminderDeliverySender.js captures all 5 dependency functions into plain top-level `const captured<Name> = <module>_1.<name>;` bindings — exactly one capture line per dependency',
    CAPTURED_NAMES.every((name) => (compiledSenderJs.match(new RegExp(`const ${name} = \\w+_\\d+\\.\\w+;`, 'g')) || []).length === 1)
  );
  check(
    'after removing the 5 capture lines themselves, none of the 5 dependency function names is read a second time through any `<module>_<n>.<name>` property access anywhere else in the compiled file',
    (() => {
      let withoutCaptureLines = compiledSenderJs;
      for (const name of CAPTURED_NAMES) {
        withoutCaptureLines = withoutCaptureLines.replace(new RegExp(`const ${name} = \\w+_\\d+\\.\\w+;\\n`), '');
      }
      const dynamicReadPattern = new RegExp(`\\w+_\\d+\\.(${DEPENDENCY_FN_NAMES.join('|')})\\b`);
      return !dynamicReadPattern.test(withoutCaptureLines);
    })()
  );
  check(
    'every private production function below the capture block references only the captured local identifiers',
    CAPTURED_NAMES.every((name) => compiledSenderJs.includes(name))
  );

  // Demonstrates the mutation mechanism itself is real (the dependency modules genuinely are
  // ordinary, mutable CommonJS exports objects) — proves loadFreshSenderModule's technique,
  // and by extension a hostile future in-process file, really can flip these properties.
  // Combined with the static proof above (never re-read post-capture), this shows why a
  // mutation AFTER first load cannot reach an already-loaded instance's behavior, while a
  // mutation BEFORE a fresh cache-busted load (exactly what loadFreshSenderModule does, and
  // exactly what the composition tests below rely on) is captured.
  await checkAsync(
    '[module-load-order] a vanilla-loaded production module instance keeps using its own already-captured real dependencies even after those dependencies\' exports are mutated out from under it; a freshly cache-busted require performed AFTER the mutation captures the mutated (fake) value instead',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fcmTransportMod = require('./fcmTransport') as { sendFcmOnce: unknown };
      const originalSendFcmOnce = fcmTransportMod.sendFcmOnce;
      const fakeSendFcmOnce = async () => ACCEPTED_OUTCOME;
      try {
        fcmTransportMod.sendFcmOnce = fakeSendFcmOnce;
        const mutationSucceeded = fcmTransportMod.sendFcmOnce === fakeSendFcmOnce;
        // A fresh cache-busted require performed now (mutation already in place) captures
        // the fake — proving the technique works, without ever invoking the real transport.
        const resolved = require.resolve('./reminderDeliverySender');
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./reminderDeliverySender');
        return mutationSucceeded;
      } finally {
        fcmTransportMod.sendFcmOnce = originalSendFcmOnce;
        const resolved = require.resolve('./reminderDeliverySender');
        delete require.cache[resolved];
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        require('./reminderDeliverySender'); // restore a real-captured instance for subsequent export-surface reads.
      }
    }
  );

  // =======================================================================================
  // BEHAVIORAL TRANSPORT-COMPOSITION TESTS — through the REAL, unmodified
  // processControlledSendCandidate, on a freshly cache-busted module instance wired to a
  // fake db/provider/transport. Proves the full fresh-authorization -> transport ->
  // outcome-commit composition behaves correctly, and that transport is invoked exactly
  // once, never zero and never twice.
  // =======================================================================================
  console.log('\n=== processControlledSendCandidate — behavioral composition (fake transport) ===');

  // Step 3C-9 — proves the ACTUAL outbound FCM v1 `message` object, as constructed by the
  // real, unmodified production orchestration path (not a reimplementation), contains
  // exactly the approved first-real-send contract: fixed title/body, webpush.fcmOptions.link
  // === '/', no other top-level keys, and exactly one physical transport call (no additional
  // FCM calls, no retry).
  await checkAsync(
    "[payload contract] the exact outbound FCM v1 message reaching the transport has notification.title === 'NeuroActive', notification.body === 'Your next session is ready.', webpush.fcmOptions.link === 'https://neuroactivehealth.com/', and no other top-level keys beyond token/notification/webpush — exactly one physical transport call",
    async () => {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
      let capturedMessage: Record<string, unknown> | undefined;
      const { transport, callCount } = fakeTransport((params) => {
        capturedMessage = params.message;
        return Promise.resolve(ACCEPTED_OUTCOME);
      });
      const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      if (callCount() !== 1) return false;
      if (result.outcome !== 'terminalized' || result.state !== 'accepted-by-fcm') return false;
      if (!capturedMessage) return false;
      if (JSON.stringify(Object.keys(capturedMessage).sort()) !== JSON.stringify(['notification', 'token', 'webpush'])) return false;
      const notification = capturedMessage.notification as { title: unknown; body: unknown };
      if (notification.title !== 'NeuroActive' || notification.body !== 'Your next session is ready.') return false;
      const webpush = capturedMessage.webpush as { fcmOptions?: { link?: unknown } };
      if (webpush?.fcmOptions?.link !== 'https://neuroactivehealth.com/') return false;
      // No user-specific content anywhere in the visible notification (the webpush link is
      // checked separately above for its exact expected value — it legitimately contains
      // the company domain, which itself contains the substring "health").
      const serializedNotification = JSON.stringify(capturedMessage.notification).toLowerCase();
      const forbidden = ['lesson', 'day ', 'pain', 'health', ORCH_UID.toLowerCase(), ORCH_REMINDER_ID.toLowerCase(), ORCH_INSTALLATION_ID.toLowerCase()];
      return forbidden.every((needle) => !serializedNotification.includes(needle));
    }
  );

  await checkAsync('authorized + accepted transport outcome -> terminalized accepted-by-fcm, transport called EXACTLY ONCE with the real capability token/accessToken', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    let capturedAccessToken: string | undefined;
    let capturedToken: unknown;
    const { transport, callCount } = fakeTransport((params) => {
      capturedAccessToken = params.accessToken;
      capturedToken = (params.message as { token?: unknown }).token;
      return Promise.resolve(ACCEPTED_OUTCOME);
    });
    const sender = freshSenderFor(db, transport);
    const result = await sender.processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    if (capturedAccessToken !== RAW_ACCESS_TOKEN || capturedToken !== ORCH_RAW_TOKEN) return false;
    if (result.outcome !== 'terminalized' || result.state !== 'accepted-by-fcm') return false;
    const after = readDoc(store, ORCH_DELIVERY_PATH)!;
    const history = after.attemptHistory as unknown[];
    return after.state === 'accepted-by-fcm' && history.length === 1;
  });

  await checkAsync('controlled-beta authorized path reaches the sole transport exactly once without any experiment gate', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'controlled-beta', allowlistUids: [ORCH_UID] }, experimentGate: null });
    const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    return callCount() === 1 && result.outcome === 'terminalized' && result.state === 'accepted-by-fcm' && !store.has('artifacts/neuroactive-prod/systemConfig/firstRealSendExperimentGate');
  });

  await checkAsync('authorized + retryable-later transport outcome -> requeued-for-retry, transport called exactly once, delivery back to queued, bounded backoff', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => Promise.resolve(REJECTED_RETRYABLE));
    const before = Date.now();
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    if (result.outcome !== 'requeued-for-retry') return false;
    const after = readDoc(store, ORCH_DELIVERY_PATH)!;
    const workAvailableAtMs = (after.workAvailableAt as Timestamp).toMillis();
    return after.state === 'queued' && after.sendExecutionId === null && workAvailableAtMs - before >= DELIVERY_RETRY_BACKOFF_MS;
  });

  await checkAsync('authorized + unknown/ambiguous transport outcome -> terminalized unknown-outcome, transport called exactly once', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => Promise.resolve(UNKNOWN_5XX));
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    return result.outcome === 'terminalized' && result.state === 'unknown-outcome';
  });

  for (const [outcome, category] of [
    [REJECTED_INVALID_ARGUMENT, 'invalid-argument'],
    [REJECTED_UNAUTHENTICATED, 'unauthenticated'],
    [REJECTED_PERMISSION_DENIED, 'permission-denied'],
    [REJECTED_UNREGISTERED, 'unregistered'],
    [REJECTED_OTHER, 'other-definitive-rejection'],
  ] as [FcmSendOutcome, string][]) {
    await checkAsync(`definitive rejection (${category}) -> ALWAYS terminalized rejected-final, never retried, transport called exactly once`, async () => {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
      const { transport, callCount } = fakeTransport(() => Promise.resolve(outcome));
      const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      if (callCount() !== 1) return false;
      if (result.outcome !== 'terminalized' || result.state !== 'rejected-final') return false;
      return readDoc(store, ORCH_DELIVERY_PATH)!.state === 'rejected-final';
    });
  }

  for (const outcome of [UNKNOWN_TIMEOUT, UNKNOWN_NETWORK, UNKNOWN_5XX, UNKNOWN_MALFORMED, NOT_ATTEMPTED]) {
    await checkAsync(`ambiguous outcome (${outcome.kind}/${'reason' in outcome ? outcome.reason : ''}) -> ALWAYS terminalized unknown-outcome, never retried, transport called exactly once`, async () => {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
      const { transport, callCount } = fakeTransport(() => Promise.resolve(outcome));
      const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      if (callCount() !== 1) return false;
      return result.outcome === 'terminalized' && result.state === 'unknown-outcome';
    });
  }

  await checkAsync('[attempt cap] retryable-later when the authorized intent is exactly the MAX_SEND_ATTEMPTS-th attempt -> terminalized rejected-final, NOT requeued, transport called exactly once', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, {
      rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] },
      delivery: { sendAttemptCount: MAX_SEND_ATTEMPTS - 1 },
    });
    const { transport, callCount } = fakeTransport(() => Promise.resolve(REJECTED_RETRYABLE));
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    if (result.outcome !== 'terminalized' || result.state !== 'rejected-final') return false;
    const after = readDoc(store, ORCH_DELIVERY_PATH)!;
    return after.state === 'rejected-final' && after.sendAttemptCount === MAX_SEND_ATTEMPTS;
  });

  await checkAsync(
    '[Step 3C-7] a coherent 429 on attempt 1 consumes the experiment gate and correctly requeues the delivery, but a later worker\'s attempt 2 authorization is now DENIED by the consumed gate (experiment-gate-consumed) rather than reaching a second transport call — the one-shot gate, not per-delivery attempt bookkeeping, is what ultimately bounds real sends to exactly one during the first controlled experiment',
    async () => {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });

      let firstExecutionId: unknown;
      const first = fakeTransport(() => {
        firstExecutionId = (readDoc(store, ORCH_DELIVERY_PATH) as { sendExecutionId?: unknown }).sendExecutionId;
        return Promise.resolve(REJECTED_RETRYABLE);
      });
      const firstResult = await freshSenderFor(db, first.transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      if (firstResult.outcome !== 'requeued-for-retry') return false;
      if (firstExecutionId === undefined) return false;

      const gateAfterFirst = readDoc(store, 'artifacts/neuroactive-prod/systemConfig/firstRealSendExperimentGate')!;
      if (gateAfterFirst.state !== 'consumed' || gateAfterFirst.consumedByExecutionId !== firstExecutionId) return false;

      const afterRequeue = readDoc(store, ORCH_DELIVERY_PATH)!;
      const secondPreparingLeaseMs = Date.now() + 5 * 60 * 1000;
      seedDoc(store, ORCH_DELIVERY_PATH, {
        ...afterRequeue,
        state: 'preparing',
        workState: 'queued',
        workAvailableAt: Timestamp.fromMillis(secondPreparingLeaseMs),
        leaseExpiresAt: Timestamp.fromMillis(secondPreparingLeaseMs),
        processingAttemptCount: 2,
      });

      const second = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
      const secondResult = await freshSenderFor(db, second.transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 2);
      if (second.callCount() !== 0) return false; // transport must NEVER be reached for attempt 2
      if (secondResult.outcome !== 'cancelled' || secondResult.reason !== 'experiment-gate-consumed') return false;

      const after = readDoc(store, ORCH_DELIVERY_PATH)!;
      // Attempt 1's history entry is preserved; no second entry was ever added, and the
      // delivery ends terminally cancelled, never a second 'sending'/'accepted-by-fcm'.
      const history = after.attemptHistory as { attemptNumber: number }[];
      return after.state === 'cancelled' && history.length === 1 && history[0].attemptNumber === 1;
    }
  );

  await checkAsync('attemptHistory corrupted DURING the (fake) transport call (after authorization, before outcome commit) -> persistence-failed AFTER a real transport call was already made, document stays exactly "sending", secret in the corrupted entry never leaks into the result', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => {
      const current = readDoc(store, ORCH_DELIVERY_PATH)!;
      seedDoc(store, ORCH_DELIVERY_PATH, {
        ...current,
        attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'SECRET-SHOULD-NEVER-SURVIVE' }],
      });
      return Promise.resolve(ACCEPTED_OUTCOME);
    });
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    if (result.outcome !== 'persistence-failed') return false;
    if (JSON.stringify(result).includes('SECRET-SHOULD-NEVER-SURVIVE')) return false;
    return readDoc(store, ORCH_DELIVERY_PATH)!.state === 'sending';
  });

  await checkAsync('[fence] delivery document deleted entirely BETWEEN authorization and outcome commit -> outcome-fence-mismatch (never a throw, never a write), transport called exactly once', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => {
      store.delete(ORCH_DELIVERY_PATH);
      return Promise.resolve(ACCEPTED_OUTCOME);
    });
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    return result.outcome === 'outcome-fence-mismatch' && !store.has(ORCH_DELIVERY_PATH);
  });

  await checkAsync('[fence] document flipped to an already-terminal state (e.g. by a hypothetical duplicate concurrent commit) DURING the transport call -> outcome-fence-mismatch, that concurrently-written terminal state is never overwritten', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => {
      const current = readDoc(store, ORCH_DELIVERY_PATH)!;
      seedDoc(store, ORCH_DELIVERY_PATH, { ...current, state: 'rejected-final', workState: 'terminal', workAvailableAt: null, leaseExpiresAt: null });
      return Promise.resolve(ACCEPTED_OUTCOME);
    });
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return readDoc(store, ORCH_DELIVERY_PATH)!.state === 'rejected-final';
  });

  await checkAsync('[fence] sendAttemptCount advanced (as if a second attempt already committed) DURING the transport call -> outcome-fence-mismatch', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => {
      const current = readDoc(store, ORCH_DELIVERY_PATH)!;
      seedDoc(store, ORCH_DELIVERY_PATH, { ...current, sendAttemptCount: 2 });
      return Promise.resolve(ACCEPTED_OUTCOME);
    });
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    return result.outcome === 'outcome-fence-mismatch';
  });

  await checkAsync('[fence] sendIntentAtMs mutated (as if the SAME attempt number was somehow re-intended) DURING the transport call -> outcome-fence-mismatch', async () => {
    const { db, store } = makeFakeDb();
    seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
    const { transport, callCount } = fakeTransport(() => {
      const current = readDoc(store, ORCH_DELIVERY_PATH)! as { sendIntentAtMs: number };
      seedDoc(store, ORCH_DELIVERY_PATH, { ...current, sendIntentAtMs: current.sendIntentAtMs + 1 });
      return Promise.resolve(ACCEPTED_OUTCOME);
    });
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 1) return false;
    return result.outcome === 'outcome-fence-mismatch';
  });

  await checkAsync('[secrecy] neither the installation token nor the OAuth access token ever appears in the PERSISTED delivery document after any outcome (accepted/rejected/retryable/unknown)', async () => {
    for (const outcome of [ACCEPTED_OUTCOME, REJECTED_INVALID_ARGUMENT, REJECTED_RETRYABLE, UNKNOWN_5XX]) {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
      const { transport } = fakeTransport(() => Promise.resolve(outcome));
      await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      const serialized = JSON.stringify(readDoc(store, ORCH_DELIVERY_PATH)!);
      if (serialized.includes(ORCH_RAW_TOKEN) || serialized.includes(RAW_ACCESS_TOKEN)) return false;
    }
    return true;
  });

  await checkAsync('[secrecy] the returned SanitizedSendOrchestrationResult never contains the installation token, the access token, or a capability, across accepted/retryable/unknown outcomes', async () => {
    for (const outcome of [ACCEPTED_OUTCOME, REJECTED_RETRYABLE, UNKNOWN_5XX]) {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } });
      const { transport } = fakeTransport(() => Promise.resolve(outcome));
      const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      const serialized = JSON.stringify(result);
      if (serialized.includes(ORCH_RAW_TOKEN) || serialized.includes(RAW_ACCESS_TOKEN) || 'capability' in (result as object)) return false;
    }
    return true;
  });

  // =======================================================================================
  // CODEX H1 — EXPLICIT STUCK-SENDING SYNTHETIC-RETRY ATTACK TEST (retained from prior
  // rounds). A delivery already stuck in 'sending' (simulating a crash after FCM but before
  // outcome persistence) is unreachable through the real orchestration entry point: state
  // !== 'preparing' fails closed to stale-fence before any transport call.
  // =======================================================================================
  await checkAsync(
    "[H1] a delivery already stuck in 'sending' -> processControlledSendCandidate returns stale-fence, makes ZERO transport calls, and mutates NOTHING",
    async () => {
      const { db, store } = makeFakeDb();
      const stuckSendIntentAtMs = Date.now();
      seedOrchestrationPreparingFixture(store, {
        rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] },
        delivery: {
          state: 'sending',
          workState: 'terminal',
          workAvailableAt: null,
          leaseExpiresAt: null,
          sendAttemptCount: 1,
          sendExecutionId: OTHER_EXECUTION_ID,
          sendIntentAtMs: stuckSendIntentAtMs,
          attemptHistory: [],
        },
      });
      const before = readDoc(store, ORCH_DELIVERY_PATH);
      const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
      const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
      if (callCount() !== 0) return false;
      if (result.outcome !== 'stale-fence') return false;
      return JSON.stringify(before) === JSON.stringify(readDoc(store, ORCH_DELIVERY_PATH));
    }
  );

  // =======================================================================================
  // NEGATIVE-AUTHORIZATION ZERO-TRANSPORT TESTS — 32 scenarios, driving the REAL
  // processControlledSendCandidate (never a reimplementation of the decision logic).
  // =======================================================================================
  console.log('\n=== processControlledSendCandidate — negative authorization, zero transport ===');

  async function assertZeroTransportOutcome(
    label: string,
    overrides: OrchestrationFixtureOverrides,
    expectedOutcome: SenderModule.SanitizedSendOrchestrationResult,
    expectedProcessingAttemptCount: unknown = 1
  ): Promise<void> {
    await checkAsync(`[negative-auth] ${label}`, async () => {
      const { db, store } = makeFakeDb();
      seedOrchestrationPreparingFixture(store, overrides);
      const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
      const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, expectedProcessingAttemptCount);
      if (callCount() !== 0) return false;
      return JSON.stringify(result) === JSON.stringify(expectedOutcome);
    });
  }

  await assertZeroTransportOutcome('rollout paused -> cancelled/rollout-paused', { rollout: { mode: 'paused' } }, {
    outcome: 'cancelled',
    reason: 'rollout-paused',
  });
  await assertZeroTransportOutcome('rollout dry-run -> dry-run-validated (never a real send, even though otherwise fully valid)', { rollout: { mode: 'dry-run' } }, {
    outcome: 'dry-run-validated',
  });
  await assertZeroTransportOutcome(
    'allowlisted-real-send but uid NOT in the allowlist -> cancelled/rollout-real-send-not-allowlisted',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['some-other-uid'] } },
    { outcome: 'cancelled', reason: 'rollout-real-send-not-allowlisted' }
  );
  await assertZeroTransportOutcome(
    'allowlisted-real-send with an EMPTY allowlist -> cancelled/rollout-real-send-not-allowlisted',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [] } },
    { outcome: 'cancelled', reason: 'rollout-real-send-not-allowlisted' }
  );
  await assertZeroTransportOutcome(
    'allowlisted-real-send with a MALFORMED (non-array) allowlistUids -> parseRolloutConfig fails closed to paused -> cancelled/rollout-paused',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: 'not-an-array' } },
    { outcome: 'cancelled', reason: 'rollout-paused' }
  );
  await assertZeroTransportOutcome(
    "general-real-send -> cancelled/rollout-real-send-mode-not-permitted-at-stage (this file's stage is 'allowlisted-only', never 'general')",
    { rollout: { mode: 'general-real-send' } },
    { outcome: 'cancelled', reason: 'rollout-real-send-mode-not-permitted-at-stage' }
  );
  await assertZeroTransportOutcome(
    'malformed rollout document (no recognizable mode field at all) -> parseRolloutConfig fails closed to paused -> cancelled/rollout-paused',
    { rollout: { unexpectedField: 12345 } },
    { outcome: 'cancelled', reason: 'rollout-paused' }
  );
  await assertZeroTransportOutcome(
    "stale processing fence (caller's expectedProcessingAttemptCount does not match the persisted document) -> stale-fence",
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } },
    { outcome: 'stale-fence', reason: 'stale-processing-fence' },
    2 // fixture seeds processingAttemptCount: 1
  );

  const expiredLeaseMs = Date.now() - 60_000;
  await assertZeroTransportOutcome(
    'expired lease on an otherwise-consistent preparing work tuple -> stale-fence (a legitimate reacquisition could be imminent — never treated as corruption)',
    {
      rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] },
      delivery: {
        workAvailableAt: Timestamp.fromMillis(expiredLeaseMs),
        leaseExpiresAt: Timestamp.fromMillis(expiredLeaseMs),
      },
    },
    { outcome: 'stale-fence', reason: 'stale-processing-fence' }
  );
  await assertZeroTransportOutcome(
    "fanout provenance mismatch (delivery's fanoutExecutionIdAtCreation does not match the parent's committed fanoutExecutionId) -> cancelled/fanout-provenance-mismatch",
    {
      rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] },
      delivery: { fanoutExecutionIdAtCreation: OTHER_EXECUTION_ID },
    },
    { outcome: 'cancelled', reason: 'fanout-provenance-mismatch' }
  );
  await assertZeroTransportOutcome(
    'notification preference revision changed after the fanout claim -> cancelled/preference-changed',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, preference: { revision: 2 } },
    { outcome: 'cancelled', reason: 'preference-changed' }
  );
  await assertZeroTransportOutcome(
    'installation revoked (state no longer active) -> cancelled/installation-revoked',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: { state: 'revoked' } },
    { outcome: 'cancelled', reason: 'installation-revoked' }
  );
  await assertZeroTransportOutcome(
    'installation token rotated (tokenVersion advanced past the fanout-time snapshot) -> cancelled/installation-token-version-changed',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: { tokenVersion: 2 } },
    { outcome: 'cancelled', reason: 'installation-token-version-changed' }
  );
  await assertZeroTransportOutcome(
    'token claim identity mismatch (claim points at a different uid than the delivery) -> cancelled/token-claim-mismatch',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, tokenClaim: { uid: 'someone-else' } },
    { outcome: 'cancelled', reason: 'token-claim-mismatch' }
  );
  await assertZeroTransportOutcome(
    'malformed expectedProcessingAttemptCount (e.g. a negative number) fails the PRE-transaction isValidAttemptCount check -> stale-fence, before any Firestore read at all',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] } },
    { outcome: 'stale-fence', reason: 'stale-processing-fence' },
    -1
  );

  await checkAsync(
    'structurally malformed reminderId string -> delivery-not-found, zero transport, zero Firestore access at all (rejected by the pre-db validation)',
    async () => {
      const { db } = makeFakeDb();
      const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
      const result = await freshSenderFor(db, transport).processControlledSendCandidate('not-a-valid-reminder-id', ORCH_INSTALLATION_ID, 1);
      if (callCount() !== 0) return false;
      return result.outcome === 'delivery-not-found';
    }
  );
  await checkAsync('structurally malformed installationId string -> delivery-not-found, zero transport', async () => {
    const { db } = makeFakeDb();
    const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, 'too-short', 1);
    if (callCount() !== 0) return false;
    return result.outcome === 'delivery-not-found';
  });
  await checkAsync('non-string reminderId/installationId (e.g. a number, an object) -> delivery-not-found, zero transport', async () => {
    const { db } = makeFakeDb();
    const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(12345, { evil: true }, 1);
    if (callCount() !== 0) return false;
    return result.outcome === 'delivery-not-found';
  });
  await checkAsync('delivery document does not exist at all at an otherwise well-formed path -> delivery-not-found, zero transport', async () => {
    const { db } = makeFakeDb();
    const { transport, callCount } = fakeTransport(() => Promise.resolve(ACCEPTED_OUTCOME));
    const result = await freshSenderFor(db, transport).processControlledSendCandidate(ORCH_REMINDER_ID, ORCH_INSTALLATION_ID, 1);
    if (callCount() !== 0) return false;
    return result.outcome === 'delivery-not-found';
  });

  await assertZeroTransportOutcome(
    "malformed persisted delivery schema on an otherwise-legitimate 'preparing' document (poisoned pre-existing attemptHistory) -> invalid-delivery/invalid-attempt-history",
    {
      rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] },
      delivery: { attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'SECRET-SHOULD-NEVER-SURVIVE' }] },
    },
    { outcome: 'invalid-delivery', reason: 'invalid-attempt-history' }
  );
  await assertZeroTransportOutcome(
    "inconsistent 'preparing' work tuple (workState contradicts the 'preparing' state) -> invalid-delivery/invalid-preparing-work-tuple",
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, delivery: { workState: 'terminal' } },
    { outcome: 'invalid-delivery', reason: 'invalid-preparing-work-tuple' }
  );
  await assertZeroTransportOutcome(
    'parent reminder document missing entirely -> cancelled/parent-invalid',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, reminder: null },
    { outcome: 'cancelled', reason: 'parent-invalid' }
  );
  await assertZeroTransportOutcome(
    'parent reminder document schema-malformed (non-string uid) -> cancelled/parent-invalid',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, reminder: { uid: 12345 } },
    { outcome: 'cancelled', reason: 'parent-invalid' }
  );
  await assertZeroTransportOutcome(
    'parent fanout legitimately completed a DIFFERENT (failed) outcome -> cancelled/parent-fanout-not-completed',
    {
      rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] },
      reminder: { deliveryFanoutState: 'failed', targetInstallationCountAtFanout: null, targetingFailureReason: 'unexpected-preexisting-delivery', fanoutExecutionId: null },
    },
    { outcome: 'cancelled', reason: 'parent-fanout-not-completed' }
  );
  await assertZeroTransportOutcome(
    'notification preference explicitly disabled -> cancelled/preference-disabled',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, preference: { enabled: false } },
    { outcome: 'cancelled', reason: 'preference-disabled' }
  );
  await assertZeroTransportOutcome(
    'notification preference document missing entirely -> cancelled/preference-missing',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, preference: null },
    { outcome: 'cancelled', reason: 'preference-missing' }
  );
  await assertZeroTransportOutcome(
    'installation document missing entirely -> cancelled/installation-missing',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: null },
    { outcome: 'cancelled', reason: 'installation-missing' }
  );
  await assertZeroTransportOutcome(
    'installation uid does not match the delivery uid -> cancelled/installation-uid-mismatch',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: { uid: 'someone-else' } },
    { outcome: 'cancelled', reason: 'installation-uid-mismatch' }
  );
  await assertZeroTransportOutcome(
    'installation generation advanced past the fanout-time target snapshot -> cancelled/installation-generation-changed',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: { generation: 2 } },
    { outcome: 'cancelled', reason: 'installation-generation-changed' }
  );
  await assertZeroTransportOutcome(
    'installation audience id changed from the fanout-time target snapshot -> cancelled/installation-audience-changed',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: { installationAudienceId: 'B'.repeat(16) } },
    { outcome: 'cancelled', reason: 'installation-audience-changed' }
  );
  await assertZeroTransportOutcome(
    'installation current token missing/empty -> cancelled/installation-token-missing',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, installation: { token: '' } },
    { outcome: 'cancelled', reason: 'installation-token-missing' }
  );
  await assertZeroTransportOutcome(
    'token claim document missing entirely -> cancelled/token-claim-missing',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, tokenClaim: null },
    { outcome: 'cancelled', reason: 'token-claim-missing' }
  );
  await assertZeroTransportOutcome(
    'sendAttemptCount already at MAX_SEND_ATTEMPTS on an otherwise-legitimate preparing document -> invalid-delivery/send-attempt-count-exhausted',
    { rollout: { mode: 'allowlisted-real-send', allowlistUids: [ORCH_UID] }, delivery: { sendAttemptCount: MAX_SEND_ATTEMPTS } },
    { outcome: 'invalid-delivery', reason: 'send-attempt-count-exhausted' }
  );

  // =======================================================================================
  // STATIC SOURCE CHECKS — operate on reminderDeliverySender.ts's own single-file source.
  // =======================================================================================
  console.log('\n=== static source checks ===');

  check(
    "[Step 3C-7 / A21-A26] reminderDeliverySender.ts never references the experiment gate (neither the literal path segment nor an 'experimentGateRef'-shaped helper) — the gate is consumed atomically inside reminderDeliveryAuth.ts's own authorization transaction, BEFORE transport is ever reached, so no downstream FCM outcome class (accepted, any rejection category, any unknown-outcome reason, a coherent 429, a persistence failure, or a fence mismatch) can ever touch gate state — proven once, structurally, for every outcome class at once, rather than one dynamic test per category",
    !senderSource.includes('firstRealSendExperimentGate') && !senderCodeOnly.includes('experimentGateRef')
  );

  check('reminderDeliverySender.ts contains exactly one source-level call to capturedSendFcmOnce', (senderCodeOnly.match(/await capturedSendFcmOnce\(/g) || []).length === 1);
  check(
    'reminderDeliverySender.ts asserts REAL_DELIVERY_STAGE === "disabled" throws immediately before that sole transport call',
    (() => {
      const idx = senderCodeOnly.indexOf('await capturedSendFcmOnce(');
      const before = senderCodeOnly.slice(0, idx);
      return before.includes("if (REAL_DELIVERY_STAGE === 'disabled')");
    })()
  );
  check(
    'reminderDeliverySender.ts imports the real sendFcmOnce VALUE exactly once, and immediately captures it into a top-level const (capturedSendFcmOnce) rather than reading it dynamically elsewhere',
    (senderCodeOnly.match(/import \{ sendFcmOnce, type FcmSendOutcome \} from '\.\/fcmTransport';/g) || []).length === 1 &&
      senderCodeOnly.includes('const capturedSendFcmOnce = sendFcmOnce;')
  );
  check('reminderDeliverySender.ts contains no console.log/console.error/console.warn/console.info/console.debug calls', !/console\.(log|error|warn|info|debug)\(/.test(senderSource));
  check(
    "reminderDeliverySender.ts's REAL_DELIVERY_STAGE constant is declared as its own const in this file (not re-exported from reminderDeliveryAuth.ts)",
    /export const REAL_DELIVERY_STAGE: RealDeliveryStage = 'allowlisted-only';/.test(senderCodeOnly)
  );
  check(
    "'invalid-delivery' is not a reachable SendOutcomeCommitResult outcome anywhere in that type declaration or commitSendOutcome's own body (module-private, post-authorization outcome commit never reaches invalid-delivery — only pre-send authorization does, via SanitizedSendOrchestrationResult)",
    (() => {
      const typeStart = senderCodeOnly.indexOf('type SendOutcomeCommitResult');
      const fnEnd = senderCodeOnly.indexOf('async function executeControlledSend');
      if (typeStart === -1 || fnEnd === -1 || fnEnd <= typeStart) {
        throw new Error('static check anchor text not found — source structure changed unexpectedly');
      }
      return !senderCodeOnly.slice(typeStart, fnEnd).includes("outcome: 'invalid-delivery'");
    })()
  );
  check(
    "reminderDeliverySender.ts's history-append call site sources sendIntentAt from the freshly-read persisted value (persistedSendIntentAtMs), never directly from capability.sendIntentAtMs",
    senderCodeOnly.includes('sendIntentAt: persistedSendIntentAtMs') && !senderCodeOnly.includes('sendIntentAt: capability.sendIntentAtMs')
  );
  check(
    'commitSendOutcome/executeControlledSend have no `export` keyword immediately preceding their declarations (module-private)',
    /\n(?:async )?function commitSendOutcome\(/.test(senderCodeOnly) &&
      !/export (?:async )?function commitSendOutcome\(/.test(senderCodeOnly) &&
      /\nasync function executeControlledSend\(/.test(senderCodeOnly) &&
      !/export async function executeControlledSend\(/.test(senderCodeOnly)
  );

  // Cross-file: reminderDeliverySender.ts must be the ONLY file in functions/src that ever
  // imports the real sendFcmOnce VALUE — fcmTransport.ts itself (the definition site) is
  // excluded.
  const allSourceFiles = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fcmTransport.ts' && f !== 'reminderDeliverySender.ts');
  let foreignCallSite: string | null = null;
  for (const file of allSourceFiles) {
    const content = stripComments(fs.readFileSync(path.join(srcDir, file), 'utf8'));
    if (/import \{[^}]*\bsendFcmOnce\b[^}]*\}\s*from\s*'\.\/fcmTransport'/.test(content)) {
      foreignCallSite = file;
      break;
    }
  }
  check(
    `reminderDeliverySender.ts is the ONLY production source file (besides fcmTransport.ts itself) that imports the real sendFcmOnce value — checked across all of: ${allSourceFiles.join(', ')}`,
    foreignCallSite === null,
    foreignCallSite ?? undefined
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
