// functions/src/reminderDeliveryWorker.test.ts
// Phase 3A-3 Step 3C-2 — repository-local test file for the Firestore orchestration layer
// in reminderDeliveryWorker.ts.
//
// EMULATOR STATUS: no Firestore emulator (and no Java runtime) is available in this
// environment. This file does NOT claim to exercise real Firestore transaction semantics
// (true optimistic-concurrency retry, real composite-index enforcement, real byte-level
// document-size limits). Instead it drives the actual, unmodified orchestration functions
// in reminderDeliveryWorker.ts against a small, deterministic, in-memory FAKE implementing
// just the subset of the `firebase-admin/firestore` surface those functions call
// (Firestore.doc/collection/collectionGroup/runTransaction, Transaction.get/getAll/create/
// update, Query.where/orderBy/limit/get, real `FieldValue`/`Timestamp`/`FieldPath` values
// imported from the real package — never reimplemented). Every scenario below is a
// deterministic, single-execution trace through real production code; no network call, no
// real Firestore project, no production credential is ever touched.
//
// KNOWN FAKE-VS-REAL DIVERGENCES (documented, not hidden):
//   - No true concurrent-transaction contention/retry is modeled: db.runTransaction() here
//     invokes the callback exactly once and commits its writes if it resolves, or discards
//     them if it throws. Real Firestore retries a transaction callback on contention: this
//     fake cannot prove retry-safety on its own — retry-stability of the derived public ID
//     is instead proven by construction (deriveDeliveryPublicId is a pure, deterministic
//     function of (nonce, reminderId, installationId), and this file's nonce is generated
//     exactly once per logical fanout call, outside runTransaction) and is cross-checked
//     directly below.
//   - No composite-index enforcement is modeled — a query this fake can answer is not proof
//     Firestore's real query planner would accept it without a composite index. See the
//     implementation report's "indexes"/"limitations" sections.
//   - Transaction.create()'s existence check is evaluated against the pre-transaction store
//     state, not a fully serialized per-transaction read-set — sufficient for this file's
//     single-execution, non-concurrent scenarios.
//
// Same established pattern as fcmTransport.test.ts / reminderDeliveryLogic.test.ts: no test
// runner is configured in this repo; this is a small, dependency-free, self-contained
// assertion script.
//
// HOW TO RUN:
//   cd functions
//   npm run build:test
//   node lib/reminderDeliveryWorker.test.js
import * as fs from 'fs';
import * as path from 'path';
import nodeCrypto = require('node:crypto');
import { FieldValue, FieldPath, Timestamp } from 'firebase-admin/firestore';
import {
  fanOutReminderDelivery,
  __test__,
  discoverRecoverableDeliveryWork,
  acquireDeliveryProcessingLease,
  DELIVERY_QUEUE_BATCH_SIZE,
  DELIVERY_PUBLIC_ID_LENGTH,
  DELIVERY_PROCESSING_CONCURRENCY,
  type FanoutExecutionResult,
} from './reminderDeliveryWorker';
import type * as WorkerModule from './reminderDeliveryWorker';
import type { AccessTokenProvider } from './reminderDeliveryAuth';
import type { FcmSendOutcome, SendFcmOnceParams } from './fcmTransport';
import { DELIVERY_STATES, FANOUT_NONCE_BYTE_LENGTH, deriveDeliveryPublicId, MAX_SEND_ATTEMPTS } from './reminderDeliveryLogic';

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

// Strips block and `//` comments from TypeScript source text before a substring/regex scan,
// so static checks inspect actual code rather than being tripped up by explanatory prose
// that happens to mention a forbidden identifier (the same established pattern already used
// by fcmTransport.test.ts's static regression checks).
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

// =========================================================================================
// FAKE FIRESTORE — minimal, deterministic, in-memory. See file header for scope/divergences.
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

function toComparable(v: unknown): unknown {
  return v instanceof Timestamp ? v.toMillis() : v;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a instanceof Timestamp && b instanceof Timestamp) return a.toMillis() === b.toMillis();
  return a === b;
}

function isDirectChildOfCollection(docPath: string, collectionPath: string): boolean {
  if (!docPath.startsWith(collectionPath + '/')) return false;
  return !docPath.slice(collectionPath.length + 1).includes('/');
}

function parentCollectionName(docPath: string): string {
  const segs = docPath.split('/');
  return segs[segs.length - 2];
}

type FakeFilter = { field: string; op: '==' | '<='; value: unknown };
type FakeOrder = { field: string | FieldPath; direction: 'asc' | 'desc' };
type FakeQuerySource = { kind: 'collection'; collectionPath: string } | { kind: 'collectionGroup'; collectionId: string };

class FakeDocumentReference {
  readonly id: string;
  constructor(
    public readonly store: Store,
    public readonly path: string
  ) {
    this.id = path.split('/').pop() as string;
  }
  collection(name: string): FakeCollectionReference {
    return new FakeCollectionReference(this.store, `${this.path}/${name}`);
  }
  // Needed for reminderDeliveryAuth.ts's finalizeDeliveryAuthorization, which derives
  // reminderId via `deliveryRef.parent.parent?.id` — mirrors the real Firestore
  // DocumentReference.parent -> CollectionReference.parent -> DocumentReference|null chain.
  get parent(): FakeCollectionReference {
    const segs = this.path.split('/');
    segs.pop();
    return new FakeCollectionReference(this.store, segs.join('/'));
  }
}

class FakeQuery {
  constructor(
    protected readonly store: Store,
    protected readonly source: FakeQuerySource,
    protected readonly filters: FakeFilter[] = [],
    protected readonly orders: FakeOrder[] = [],
    protected readonly limitN: number | null = null
  ) {}

  where(field: string, op: '==' | '<=', value: unknown): FakeQuery {
    return new FakeQuery(this.store, this.source, [...this.filters, { field, op, value }], this.orders, this.limitN);
  }

  orderBy(field: string | FieldPath, direction: 'asc' | 'desc' = 'asc'): FakeQuery {
    return new FakeQuery(this.store, this.source, this.filters, [...this.orders, { field, direction }], this.limitN);
  }

  limit(n: number): FakeQuery {
    return new FakeQuery(this.store, this.source, this.filters, this.orders, n);
  }

  private matchingEntries(): { path: string; id: string; data: StoredDoc }[] {
    const entries: { path: string; id: string; data: StoredDoc }[] = [];
    for (const [docPath, data] of this.store.entries()) {
      if (this.source.kind === 'collection') {
        if (!isDirectChildOfCollection(docPath, this.source.collectionPath)) continue;
      } else {
        if (parentCollectionName(docPath) !== this.source.collectionId) continue;
      }
      entries.push({ path: docPath, id: docPath.split('/').pop() as string, data });
    }
    return entries;
  }

  async get(): Promise<{ docs: FakeQueryDocSnapshot[]; size: number; empty: boolean }> {
    let entries = this.matchingEntries().filter((e) => this.filters.every((f) => this.applyFilter(e.data, f)));
    entries = entries.sort((a, b) => this.compare(a, b));
    if (this.limitN !== null) entries = entries.slice(0, this.limitN);
    const docs = entries.map((e) => new FakeQueryDocSnapshot(this.store, e.path, e.id, e.data));
    return { docs, size: docs.length, empty: docs.length === 0 };
  }

  private applyFilter(data: StoredDoc, filter: FakeFilter): boolean {
    const raw = data[filter.field];
    if (filter.op === '==') return valuesEqual(raw, filter.value);
    // '<='
    if (raw === null || raw === undefined) return false;
    return (toComparable(raw) as number) <= (toComparable(filter.value) as number);
  }

  private compare(a: { id: string; data: StoredDoc }, b: { id: string; data: StoredDoc }): number {
    for (const order of this.orders) {
      let av: unknown;
      let bv: unknown;
      if (order.field instanceof FieldPath) {
        av = a.id;
        bv = b.id;
      } else {
        av = toComparable(a.data[order.field]);
        bv = toComparable(b.data[order.field]);
      }
      if ((av as number) < (bv as number)) return order.direction === 'desc' ? 1 : -1;
      if ((av as number) > (bv as number)) return order.direction === 'desc' ? -1 : 1;
    }
    return 0;
  }
}

class FakeCollectionReference extends FakeQuery {
  constructor(store: Store, public readonly path: string) {
    super(store, { kind: 'collection', collectionPath: path });
  }
  get parent(): FakeDocumentReference | null {
    const segs = this.path.split('/');
    segs.pop();
    if (segs.length === 0) return null;
    return new FakeDocumentReference(this.store, segs.join('/'));
  }
  doc(id: string): FakeDocumentReference {
    return new FakeDocumentReference(this.store, `${this.path}/${id}`);
  }
}

class FakeDocSnapshotBase {
  constructor(
    protected readonly store: Store,
    public readonly path: string,
    public readonly id: string
  ) {}
  get exists(): boolean {
    return this.store.has(this.path);
  }
}

class FakeDocumentSnapshot extends FakeDocSnapshotBase {
  data(): StoredDoc | undefined {
    const raw = this.store.get(this.path);
    return raw ? { ...raw } : undefined;
  }
  get ref(): FakeDocumentReference {
    return new FakeDocumentReference(this.store, this.path);
  }
}

class FakeQueryDocSnapshot {
  constructor(
    private readonly store: Store,
    public readonly path: string,
    public readonly id: string,
    private readonly snapshotData: StoredDoc
  ) {}
  get exists(): boolean {
    return true;
  }
  data(): StoredDoc {
    return { ...this.snapshotData };
  }
  get ref(): FakeDocumentReference {
    return new FakeDocumentReference(this.store, this.path);
  }
}

type PendingWrite = { type: 'create' | 'set' | 'update'; path: string; data: Record<string, unknown> };

class FakeTransaction {
  readonly pendingWrites: PendingWrite[] = [];
  constructor(private readonly store: Store) {}

  async get(refOrQuery: FakeDocumentReference | FakeQuery): Promise<unknown> {
    if (refOrQuery instanceof FakeDocumentReference) {
      return new FakeDocumentSnapshot(this.store, refOrQuery.path, refOrQuery.id);
    }
    return refOrQuery.get();
  }

  async getAll(...refs: FakeDocumentReference[]): Promise<FakeDocumentSnapshot[]> {
    return refs.map((r) => new FakeDocumentSnapshot(this.store, r.path, r.id));
  }

  create(ref: FakeDocumentReference, data: Record<string, unknown>): void {
    if (this.store.has(ref.path)) {
      throw new Error(`FakeTransaction.create: document already exists at ${ref.path}`);
    }
    this.pendingWrites.push({ type: 'create', path: ref.path, data });
  }

  set(ref: FakeDocumentReference, data: Record<string, unknown>): void {
    this.pendingWrites.push({ type: 'set', path: ref.path, data });
  }

  update(ref: FakeDocumentReference, data: Record<string, unknown>): void {
    if (!this.store.has(ref.path)) {
      throw new Error(`FakeTransaction.update: document does not exist at ${ref.path}`);
    }
    this.pendingWrites.push({ type: 'update', path: ref.path, data });
  }
}

type MakeFakeDbOptions = {
  // Simulates Firestore re-invoking the SAME transaction callback on contention: the
  // callback runs (simulateRetries + 1) times total; every attempt EXCEPT the last has its
  // pending writes discarded entirely (as a real aborted attempt would be), and only the
  // final attempt's writes are committed to the store. Used exclusively to prove the
  // worker-owned-nonce invariant (H1): the SAME captured nonce must be reused by every
  // callback invocation, since it lives in the callback's closure and is never regenerated
  // inside it.
  simulateRetries?: number;
};

function makeFakeDb(options: MakeFakeDbOptions = {}): {
  db: FirebaseFirestore.Firestore;
  store: Store;
  getTransactionCallbackInvocationCount: () => number;
  getAttemptWritesHistory: () => PendingWrite[][];
} {
  const store: Store = new Map();
  const totalAttempts = (options.simulateRetries ?? 0) + 1;
  let callbackInvocationCount = 0;
  const attemptWritesHistory: PendingWrite[][] = [];

  const db = {
    doc(p: string) {
      return new FakeDocumentReference(store, p);
    },
    collection(p: string) {
      return new FakeCollectionReference(store, p);
    },
    collectionGroup(id: string) {
      return new FakeQuery(store, { kind: 'collectionGroup', collectionId: id });
    },
    async runTransaction<T>(cb: (t: FakeTransaction) => Promise<T>): Promise<T> {
      let result: T | undefined;
      let finalTransaction: FakeTransaction | undefined;
      for (let attempt = 0; attempt < totalAttempts; attempt++) {
        callbackInvocationCount++;
        const transaction = new FakeTransaction(store);
        const attemptResult = await cb(transaction);
        attemptWritesHistory.push(transaction.pendingWrites.map((w) => ({ ...w, data: { ...w.data } })));
        result = attemptResult;
        finalTransaction = transaction;
      }
      // Commit only the FINAL attempt's writes — every earlier simulated attempt is
      // discarded, exactly like a real aborted Firestore transaction attempt.
      for (const write of finalTransaction!.pendingWrites) {
        if (write.type === 'update') {
          const existing = store.get(write.path) ?? {};
          store.set(write.path, { ...existing, ...resolveFieldValues(write.data) });
        } else {
          store.set(write.path, resolveFieldValues(write.data));
        }
      }
      return result as T;
    },
  };

  return {
    db: db as unknown as FirebaseFirestore.Firestore,
    store,
    getTransactionCallbackInvocationCount: () => callbackInvocationCount,
    getAttemptWritesHistory: () => attemptWritesHistory,
  };
}

function seedDoc(store: Store, path: string, data: Record<string, unknown>): void {
  store.set(path, resolveFieldValues(data));
}

function readDoc(store: Store, path: string): StoredDoc | undefined {
  const raw = store.get(path);
  return raw ? { ...raw } : undefined;
}

// =========================================================================================
// FIXTURES
// =========================================================================================

const APP_ID = __test__.APP_ID;
const UID = 'user-1';

function hex32(n: number): string {
  return n.toString(16).padStart(32, '0');
}

function reminderPath(reminderId: string): string {
  return `artifacts/${APP_ID}/reminders/${reminderId}`;
}
function deliveryPath(reminderId: string, installationId: string): string {
  return `artifacts/${APP_ID}/reminders/${reminderId}/deliveries/${installationId}`;
}
function installationPath(installationId: string): string {
  return `artifacts/${APP_ID}/pushInstallations/${installationId}`;
}
function prefPath(uid: string): string {
  return `artifacts/${APP_ID}/users/${uid}/notificationPreferences/main`;
}
function rolloutPath(): string {
  return `artifacts/${APP_ID}/systemConfig/notificationRollout`;
}
function tokenClaimPath(tokenHash: string): string {
  return `artifacts/${APP_ID}/pushTokenClaims/${tokenHash}`;
}

function seedProcessingReminder(store: Store, reminderId: string, attemptCount = 1, overrides: Record<string, unknown> = {}): void {
  seedDoc(store, reminderPath(reminderId), {
    uid: UID,
    status: 'processing',
    workState: 'queued',
    attemptCount,
    leaseExpiresAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    workAvailableAt: Timestamp.fromMillis(Date.now() + 5 * 60 * 1000),
    ...overrides,
  });
}

function validInstallationFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid: UID,
    state: 'active',
    epochSchemaVersion: 1,
    tokenVersion: 1,
    installationAudienceId: 'A'.repeat(16),
    generation: 1,
    token: 'raw-fcm-token-value-should-never-be-copied',
    ...overrides,
  };
}

function seedActiveInstallation(store: Store, installationId: string, overrides: Record<string, unknown> = {}): void {
  seedDoc(store, installationPath(installationId), validInstallationFields(overrides));
}

// A syntactically valid deliveryPublicId (correct length/alphabet) for fixtures that need
// ANY well-formed public ID but don't care about its actual HMAC provenance — tests that
// specifically verify derivation correctness use deriveDeliveryPublicId directly instead
// (see the fanout retry-stability tests above).
const VALID_PUBLIC_ID = 'A'.repeat(DELIVERY_PUBLIC_ID_LENGTH);
// A syntactically valid fanoutExecutionIdAtCreation for queue fixtures that don't care
// about actual parent-provenance equality (that is reminderDeliveryAuth.ts's concern) —
// only that the field itself is well-formed enough to pass acquisition-time validation.
const VALID_FANOUT_EXECUTION_ID_FOR_QUEUE = 'F'.repeat(DELIVERY_PUBLIC_ID_LENGTH);

// M1 repair round: baseline fields a queued/preparing delivery must ALL satisfy to be
// acquirable — includes the fields validatePersistedDeliveryForProcessing now additionally
// requires (deliveryPublicId format, attemptHistory shape) beyond the core schema check.
function validQueuedDeliveryFields(installationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: 'queued',
    workState: 'queued',
    workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
    leaseExpiresAt: null,
    uid: UID,
    installationId,
    deliveryPublicId: VALID_PUBLIC_ID,
    fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID_FOR_QUEUE,
    sendAttemptCount: 0,
    processingAttemptCount: 0,
    attemptHistory: [],
    targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    ...overrides,
  };
}

// =========================================================================================
// NO PRODUCTION NONCE-TAKING SEAM — Codex FINAL repair round. reminderDeliveryWorker.ts
// exports NO function that accepts a caller-supplied fanoutNonce; the ONLY production entry
// point is fanOutReminderDelivery(db, reminderId, expectedAttemptCount), which owns
// randomBytes(32) generation itself. Every scenario below that needs a KNOWN, repeatable
// nonce achieves this by monkeypatching the real node:crypto randomBytes (the exact same
// live-binding technique already used for the invocation-count tests: reminderDeliveryWorker
// .ts's compiled output reads `node_crypto_1.randomBytes` fresh at each call site rather than
// a destructured local copy, so patching the module object here is observed by the worker's
// own compiled code) to return a fixed Buffer, then calls the PUBLIC fanOutReminderDelivery
// exclusively — never a test-only export. randomBytes is restored in a `finally` after every
// use, regardless of success or failure, so no test can leak a patched implementation into a
// later, unrelated test.
// =========================================================================================
async function fanOutWithFixedNonce(
  db: FirebaseFirestore.Firestore,
  reminderId: string,
  expectedAttemptCount: number,
  fixedNonce: Buffer
): Promise<FanoutExecutionResult> {
  const originalRandomBytes = nodeCrypto.randomBytes;
  (nodeCrypto as unknown as Record<string, unknown>).randomBytes = ((..._args: unknown[]) => fixedNonce) as typeof nodeCrypto.randomBytes;
  try {
    return await fanOutReminderDelivery(db, reminderId, expectedAttemptCount);
  } finally {
    (nodeCrypto as unknown as Record<string, unknown>).randomBytes = originalRandomBytes;
  }
}

const ALLOWED_CHILD_KEYS = new Set([
  'state',
  'workState',
  'workAvailableAt',
  'leaseExpiresAt',
  'uid',
  'installationId',
  'deliveryPublicId',
  'fanoutExecutionIdAtCreation',
  'processingAttemptCount',
  'sendAttemptCount',
  'attemptHistory',
  'targetSnapshot',
  'createdAt',
  'updatedAt',
]);

// =========================================================================================
// REQUIRE-CACHE-BUSTING LOADER (Step 3C-5, SIXTH round, SECOND pass) — see
// reminderDeliverySender.test.ts's own header for the full rationale. processDeliveryQueueCandidate
// / runDeliveryWorkerBatch privately resolve their own db authority AND their own captured
// reference to reminderDeliverySender.ts's processControlledSendCandidate — there is no
// parameter through which to inject fakes. This loader mutates the 4 underlying dependency
// modules' exports to fakes, then freshly (cache-busted) requires reminderDeliverySender.ts
// FIRST (so it captures the fakes) and reminderDeliveryWorker.ts SECOND (so its own capture
// of processControlledSendCandidate picks up that same fresh, fake-wired sender instance),
// then restores the real exports immediately. This drives the REAL production wiring
// end-to-end — acquisition -> OAuth preparation -> fresh final-authorization -> transport —
// through genuinely unmodified code, never a reimplementation.
// =========================================================================================

interface DependencyFakes {
  db: FirebaseFirestore.Firestore;
  accessTokenProvider: AccessTokenProvider;
  transport: (params: SendFcmOnceParams) => Promise<FcmSendOutcome>;
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

function loadFreshWorkerModule(fakes: DependencyFakes): typeof WorkerModule {
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
    const senderResolved = require.resolve('./reminderDeliverySender');
    delete require.cache[senderResolved];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('./reminderDeliverySender'); // fresh sender instance captures the fakes; the worker require below picks up THIS cached instance.
    const workerResolved = require.resolve('./reminderDeliveryWorker');
    delete require.cache[workerResolved];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./reminderDeliveryWorker') as typeof WorkerModule;
  } finally {
    restoreExport(appMod, 'getApps', originals.getApps);
    restoreExport(appMod, 'initializeApp', originals.initializeApp);
    restoreExport(firestoreMod, 'getFirestore', originals.getFirestore);
    restoreExport(authMod, 'createGoogleAuthAccessTokenProvider', originals.createGoogleAuthAccessTokenProvider);
    restoreExport(transportMod, 'sendFcmOnce', originals.sendFcmOnce);
  }
}

async function main(): Promise<void> {
  // =======================================================================================
  // FANOUT — required scenarios (report section 23).
  // =======================================================================================

  await checkAsync('[fanout 1] zero active installations -> completed fanout, zero children', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1000`;
    seedProcessingReminder(store, reminderId);
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    return (
      outcome.status === 'delivery-fanned-out' &&
      outcome.deliveryFanoutState === 'completed' &&
      outcome.targetInstallationCountAtFanout === 0 &&
      outcome.excludedMalformedInstallationCount === 0 &&
      result.createdDeliveryCount === 0
    );
  });

  await checkAsync('[fanout 2] one valid target -> one delivery child created with correct fields', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1001`;
    seedProcessingReminder(store, reminderId);
    const installationId = hex32(1);
    seedActiveInstallation(store, installationId);
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out' || result.createdDeliveryCount !== 1) return false;
    const child = readDoc(store, deliveryPath(reminderId, installationId));
    if (!child) return false;
    return (
      child.state === 'queued' &&
      child.workState === 'queued' &&
      child.leaseExpiresAt === null &&
      child.uid === UID &&
      child.installationId === installationId &&
      typeof child.deliveryPublicId === 'string' &&
      (child.deliveryPublicId as string).length > 0 &&
      child.processingAttemptCount === 0 &&
      child.sendAttemptCount === 0 &&
      Array.isArray(child.attemptHistory) &&
      (child.attemptHistory as unknown[]).length === 0
    );
  });

  await checkAsync('[fanout 3] ten valid targets -> ten children, target count 10', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1002`;
    seedProcessingReminder(store, reminderId);
    for (let i = 0; i < 10; i++) seedActiveInstallation(store, hex32(100 + i));
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    return (
      outcome.deliveryFanoutState === 'completed' &&
      outcome.targetInstallationCountAtFanout === 10 &&
      result.createdDeliveryCount === 10
    );
  });

  await checkAsync('[fanout 4] eleven raw active targets -> fails over-cap, zero children', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1003`;
    seedProcessingReminder(store, reminderId);
    for (let i = 0; i < 11; i++) seedActiveInstallation(store, hex32(200 + i));
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    if (outcome.deliveryFanoutState !== 'failed') return false;
    if (outcome.targetingFailureReason !== 'installation-count-exceeds-cap') return false;
    if (outcome.observedTargetCountAtLeast !== 11) return false;
    if (result.createdDeliveryCount !== 0) return false;
    for (let i = 0; i < 11; i++) {
      if (store.has(deliveryPath(reminderId, hex32(200 + i)))) return false;
    }
    return true;
  });

  await checkAsync('[fanout 5] malformed target excluded (missing token), valid target still fanned out', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1004`;
    seedProcessingReminder(store, reminderId);
    const validId = hex32(300);
    const malformedId = hex32(301);
    seedActiveInstallation(store, validId);
    seedActiveInstallation(store, malformedId, { token: '' }); // malformed: empty token.
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    return (
      outcome.deliveryFanoutState === 'completed' &&
      outcome.targetInstallationCountAtFanout === 1 &&
      outcome.excludedMalformedInstallationCount === 1 &&
      result.createdDeliveryCount === 1 &&
      store.has(deliveryPath(reminderId, validId)) &&
      !store.has(deliveryPath(reminderId, malformedId))
    );
  });

  await checkAsync('[fanout 6] malformed 11th raw target still triggers cap (cap checked before validation)', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1005`;
    seedProcessingReminder(store, reminderId);
    for (let i = 0; i < 10; i++) seedActiveInstallation(store, hex32(400 + i));
    seedActiveInstallation(store, hex32(410), { token: '' }); // 11th, malformed.
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    return outcome.deliveryFanoutState === 'failed' && outcome.targetingFailureReason === 'installation-count-exceeds-cap';
  });

  await checkAsync('[fanout 7] all targets malformed -> completed with target count 0, excluded count N', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1006`;
    seedProcessingReminder(store, reminderId);
    for (let i = 0; i < 3; i++) seedActiveInstallation(store, hex32(500 + i), { token: '' });
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    return (
      outcome.deliveryFanoutState === 'completed' &&
      outcome.targetInstallationCountAtFanout === 0 &&
      outcome.excludedMalformedInstallationCount === 3 &&
      result.createdDeliveryCount === 0
    );
  });

  await checkAsync('[fanout 8] persisted deliveryPublicId matches independently-computed deriveDeliveryPublicId (retry stability)', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1007`;
    seedProcessingReminder(store, reminderId);
    const installationId = hex32(600);
    seedActiveInstallation(store, installationId);
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 9);
    await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    const child = readDoc(store, deliveryPath(reminderId, installationId));
    const expected = deriveDeliveryPublicId(nonce, reminderId, installationId);
    return child?.deliveryPublicId === expected;
  });

  await checkAsync('[fanout 9] deterministic child document ID equals installationId', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1008`;
    seedProcessingReminder(store, reminderId);
    const installationId = hex32(700);
    seedActiveInstallation(store, installationId);
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    return store.has(`artifacts/${APP_ID}/reminders/${reminderId}/deliveries/${installationId}`);
  });

  await checkAsync('[fanout 10] pre-existing child -> fails closed, zero new children written', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1009`;
    seedProcessingReminder(store, reminderId);
    const preExistingId = hex32(800);
    const otherId = hex32(801);
    seedActiveInstallation(store, preExistingId);
    seedActiveInstallation(store, otherId);
    // Pre-seed a delivery child at the exact deterministic path a fresh fanout would use.
    seedDoc(store, deliveryPath(reminderId, preExistingId), { state: 'queued', sentinel: 'pre-existing' });
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    if (result.outcome !== 'fanned-out') return false;
    const outcome = result.fanoutOutcome;
    if (outcome.deliveryFanoutState !== 'failed' || outcome.targetingFailureReason !== 'unexpected-preexisting-delivery') return false;
    if (result.createdDeliveryCount !== 0) return false;
    if (store.has(deliveryPath(reminderId, otherId))) return false; // no new child for the OTHER valid target either.
    const preExisting = readDoc(store, deliveryPath(reminderId, preExistingId));
    return preExisting?.sentinel === 'pre-existing'; // untouched, not adopted/merged/overwritten.
  });

  await checkAsync('[fanout 11] stale parent fence (attemptCount mismatch) -> not-eligible, zero writes', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1010`;
    seedProcessingReminder(store, reminderId, 5);
    const before = readDoc(store, reminderPath(reminderId));
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    const result = await fanOutWithFixedNonce(db, reminderId, 1 /* stale */, nonce);
    if (result.outcome !== 'not-eligible' || result.reason !== 'fence-mismatch') return false;
    const after = readDoc(store, reminderPath(reminderId));
    return JSON.stringify(before) === JSON.stringify(after);
  });

  await checkAsync('[fanout 12] atomic write shape: parent terminalized together with all children, never partial', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1011`;
    seedProcessingReminder(store, reminderId);
    for (let i = 0; i < 3; i++) seedActiveInstallation(store, hex32(900 + i));
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    const parent = readDoc(store, reminderPath(reminderId));
    let allChildrenPresent = true;
    for (let i = 0; i < 3; i++) {
      if (!store.has(deliveryPath(reminderId, hex32(900 + i)))) allChildrenPresent = false;
    }
    return parent?.status === 'delivery-fanned-out' && parent?.workState === 'terminal' && allChildrenPresent;
  });

  await checkAsync('[fanout 13] no raw token, no unexpected field, present in any written child', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1012`;
    seedProcessingReminder(store, reminderId);
    const installationId = hex32(1000);
    seedActiveInstallation(store, installationId);
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    const child = readDoc(store, deliveryPath(reminderId, installationId))!;
    const keys = Object.keys(child);
    if (keys.some((k) => !ALLOWED_CHILD_KEYS.has(k))) return false;
    const serialized = JSON.stringify(child);
    return !serialized.includes('raw-fcm-token-value-should-never-be-copied');
  });

  await checkAsync('[fanout 14] exact snapshot fields match source installation', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_1013`;
    seedProcessingReminder(store, reminderId);
    const installationId = hex32(1100);
    seedActiveInstallation(store, installationId, { generation: 4, tokenVersion: 7, installationAudienceId: 'B'.repeat(20) });
    const nonce = Buffer.alloc(FANOUT_NONCE_BYTE_LENGTH, 7);
    await fanOutWithFixedNonce(db, reminderId, 1, nonce);
    const child = readDoc(store, deliveryPath(reminderId, installationId))!;
    const snapshot = child.targetSnapshot as Record<string, unknown>;
    return snapshot.generation === 4 && snapshot.tokenVersion === 7 && snapshot.installationAudienceId === 'B'.repeat(20);
  });

  await checkAsync('[fanout 15] invalid reminderId -> not-eligible, no store mutation attempted (public API, no nonce)', async () => {
    const { db } = makeFakeDb();
    const result = await fanOutReminderDelivery(db, 'a/b', 1); // contains '/', invalid.
    return result.outcome === 'not-eligible' && result.reason === 'reminder-not-found';
  });

  await checkAsync(
    '[fanout 16] a corrupted randomBytes returning the wrong byte length (via the PUBLIC API) throws rather than silently truncating/padding',
    async () => {
      const { db } = makeFakeDb();
      try {
        await fanOutWithFixedNonce(db, `${UID}_x`, 1, Buffer.alloc(16)); // simulates a corrupted 16-byte "nonce" reaching the internal Buffer-shape guard.
        return false;
      } catch {
        return true;
      }
    }
  );

  // =======================================================================================
  // H1 REPAIR — production API owns nonce generation; L2 REPAIR — expectedAttemptCount is
  // runtime-validated before any Firestore access.
  // =======================================================================================

  for (const badCount of ['1', null, undefined, NaN, 1.5, -1, Number.MAX_SAFE_INTEGER + 1] as unknown[]) {
    await checkAsync(`[fanout L2] malformed expectedAttemptCount (${JSON.stringify(badCount)}) -> not-eligible, no store mutation`, async () => {
      const { db, store } = makeFakeDb();
      const reminderId = `${UID}_l2_${JSON.stringify(badCount)}`;
      seedProcessingReminder(store, reminderId, 1);
      const before = readDoc(store, reminderPath(reminderId));
      const result = await fanOutReminderDelivery(db, reminderId, badCount);
      if (result.outcome !== 'not-eligible' || result.reason !== 'invalid-expected-attempt-count') return false;
      const after = readDoc(store, reminderPath(reminderId));
      return JSON.stringify(before) === JSON.stringify(after);
    });
  }

  await checkAsync('[fanout L2] malformed persisted parent attemptCount never equals a valid expectedAttemptCount (fence fails closed)', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_l2_parent`;
    // Parent attemptCount is itself malformed (a string) but happens to "look like" 1.
    seedProcessingReminder(store, reminderId, 1, { attemptCount: '1' as unknown as number });
    const result = await fanOutReminderDelivery(db, reminderId, 1);
    return result.outcome === 'not-eligible' && result.reason === 'fence-mismatch';
  });

  await checkAsync(
    '[fanout H1] production fanOutReminderDelivery generates its own randomBytes exactly twice (fanoutNonce + fanoutExecutionId) and never reuses a caller value',
    async () => {
      const { db, store } = makeFakeDb();
      const reminderId = `${UID}_h1_own`;
      seedProcessingReminder(store, reminderId);
      const installationId = hex32(9500);
      seedActiveInstallation(store, installationId);

      let randomBytesCallCount = 0;
      const originalRandomBytes = nodeCrypto.randomBytes;
      (nodeCrypto as unknown as Record<string, unknown>).randomBytes = ((...args: unknown[]) => {
        randomBytesCallCount++;
        return (originalRandomBytes as unknown as (...a: unknown[]) => unknown)(...args);
      }) as typeof nodeCrypto.randomBytes;
      let result: FanoutExecutionResult;
      try {
        result = await fanOutReminderDelivery(db, reminderId, 1);
      } finally {
        (nodeCrypto as unknown as Record<string, unknown>).randomBytes = originalRandomBytes;
      }
      // Codex repair round (H1): two independent randomBytes calls per invocation — one for
      // fanoutNonce (HMAC key), one for fanoutExecutionId (raw provenance identity) — never
      // derived from one another (Option A from the repair instructions).
      if (randomBytesCallCount !== 2) return false;
      if (result.outcome !== 'fanned-out' || result.createdDeliveryCount !== 1) return false;
      const child = readDoc(store, deliveryPath(reminderId, installationId));
      if (typeof child?.deliveryPublicId !== 'string' || (child.deliveryPublicId as string).length !== DELIVERY_PUBLIC_ID_LENGTH) return false;
      const parent = readDoc(store, reminderPath(reminderId));
      return (
        typeof child.fanoutExecutionIdAtCreation === 'string' &&
        child.fanoutExecutionIdAtCreation === parent?.fanoutExecutionId &&
        (child.fanoutExecutionIdAtCreation as string).length === DELIVERY_PUBLIC_ID_LENGTH
      );
    }
  );

  await checkAsync(
    '[fanout H1] simulated transaction-callback retry: callback invoked twice, randomBytes called exactly twice total (once each for nonce/executionId, not once per attempt), both attempts derive identical deliveryPublicIds AND identical fanoutExecutionIds',
    async () => {
      const { db, store, getTransactionCallbackInvocationCount, getAttemptWritesHistory } = makeFakeDb({ simulateRetries: 1 });
      const reminderId = `${UID}_h1_retry`;
      seedProcessingReminder(store, reminderId);
      const installationId = hex32(9600);
      seedActiveInstallation(store, installationId);

      let randomBytesCallCount = 0;
      const originalRandomBytes = nodeCrypto.randomBytes;
      (nodeCrypto as unknown as Record<string, unknown>).randomBytes = ((...args: unknown[]) => {
        randomBytesCallCount++;
        return (originalRandomBytes as unknown as (...a: unknown[]) => unknown)(...args);
      }) as typeof nodeCrypto.randomBytes;
      let result: FanoutExecutionResult;
      try {
        result = await fanOutReminderDelivery(db, reminderId, 1);
      } finally {
        (nodeCrypto as unknown as Record<string, unknown>).randomBytes = originalRandomBytes;
      }

      if (randomBytesCallCount !== 2) return false; // worker-owned generation: exactly twice per INVOCATION (nonce + executionId), never once per callback attempt.
      if (getTransactionCallbackInvocationCount() !== 2) return false; // callback genuinely re-ran (simulated retry).
      if (result.outcome !== 'fanned-out') return false;

      const history = getAttemptWritesHistory();
      if (history.length !== 2) return false;
      const idFromAttempt = (attemptWrites: PendingWrite[]): string | undefined => {
        const create = attemptWrites.find((w) => w.type === 'create' && w.path === deliveryPath(reminderId, installationId));
        return create ? (create.data.deliveryPublicId as string) : undefined;
      };
      const provenanceFromAttempt = (attemptWrites: PendingWrite[]): string | undefined => {
        const create = attemptWrites.find((w) => w.type === 'create' && w.path === deliveryPath(reminderId, installationId));
        return create ? (create.data.fanoutExecutionIdAtCreation as string) : undefined;
      };
      const idAttempt0 = idFromAttempt(history[0]);
      const idAttempt1 = idFromAttempt(history[1]);
      const provenanceAttempt0 = provenanceFromAttempt(history[0]);
      const provenanceAttempt1 = provenanceFromAttempt(history[1]);
      return (
        typeof idAttempt0 === 'string' &&
        idAttempt0.length > 0 &&
        idAttempt0 === idAttempt1 &&
        typeof provenanceAttempt0 === 'string' &&
        provenanceAttempt0.length > 0 &&
        provenanceAttempt0 === provenanceAttempt1
      );
    }
  );

  // =======================================================================================
  // QUEUE — required scenarios (report section 24).
  // =======================================================================================

  await checkAsync('[queue 1] valid queued+due -> acquired, transitions to preparing', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2000`;
    const installationId = hex32(2000);
    const ref = deliveryPath(reminderId, installationId);
    seedDoc(store, ref, validQueuedDeliveryFields(installationId));
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'acquired' || result.processingAttemptCount !== 1) return false;
    const after = readDoc(store, ref)!;
    return after.state === 'preparing' && after.workState === 'queued' && valuesEqual(after.leaseExpiresAt, after.workAvailableAt);
  });

  await checkAsync('[queue 2] queued but not yet due -> still-leased, unacquired', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2001`;
    const installationId = hex32(2001);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() + 60_000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 0,
      processingAttemptCount: 0,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    return result.outcome === 'still-leased';
  });

  await checkAsync('[queue 3] preparing with expired lease -> reacquired, processingAttemptCount incremented', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2002`;
    const installationId = hex32(2002);
    const pastMs = Date.now() - 1000;
    seedDoc(
      store,
      deliveryPath(reminderId, installationId),
      validQueuedDeliveryFields(installationId, {
        state: 'preparing',
        workAvailableAt: Timestamp.fromMillis(pastMs),
        leaseExpiresAt: Timestamp.fromMillis(pastMs),
        processingAttemptCount: 1,
      })
    );
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'acquired' || result.processingAttemptCount !== 2) return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'preparing';
  });

  await checkAsync('[queue 4] preparing with live lease -> still-leased', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2003`;
    const installationId = hex32(2003);
    const futureMs = Date.now() + 60_000;
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'preparing',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(futureMs),
      leaseExpiresAt: Timestamp.fromMillis(futureMs),
      uid: UID,
      installationId,
      sendAttemptCount: 0,
      processingAttemptCount: 1,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    return result.outcome === 'still-leased';
  });

  await checkAsync("[queue 5] 'sending' corrupted queue-visible -> queue fields repaired, state preserved as 'sending'", async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2004`;
    const installationId = hex32(2004);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'sending',
      workState: 'queued', // corrupted: should have been terminal the instant sending was committed.
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 1,
      processingAttemptCount: 1,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'terminal-repaired') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'sending' && after.workState === 'terminal' && after.workAvailableAt === null && after.leaseExpiresAt === null;
  });

  await checkAsync("[queue 6] 'accepted-by-fcm' corrupted queue-visible -> repaired, business state preserved", async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2005`;
    const installationId = hex32(2005);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'accepted-by-fcm',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 1,
      processingAttemptCount: 1,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'terminal-repaired') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'accepted-by-fcm' && after.workState === 'terminal';
  });

  await checkAsync("[queue 7] 'unknown-outcome' corrupted queue-visible -> repaired", async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2006`;
    const installationId = hex32(2006);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'unknown-outcome',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 3,
      processingAttemptCount: 1,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'terminal-repaired') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'unknown-outcome' && after.workState === 'terminal';
  });

  await checkAsync('[queue 8] malformed/unrecognized state queue-visible -> neutralized to invalid-delivery', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2007`;
    const installationId = hex32(2007);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'garbage-unknown-state',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 0,
      processingAttemptCount: 0,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'unknown-state-neutralized') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return (
      after.state === 'invalid-delivery' &&
      after.workState === 'terminal' &&
      after.originalCorruptState === 'garbage-unknown-state'
    );
  });

  await checkAsync('[queue 9] malformed work tuple (invalid workState string) -> quarantined as invalid-delivery', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2008`;
    const installationId = hex32(2008);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'queued',
      workState: 'bogus-work-state',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 0,
      processingAttemptCount: 0,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'quarantined') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'invalid-delivery' && after.workState === 'terminal';
  });

  await checkAsync('[queue 10] malformed processingAttemptCount -> quarantined via schema check', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2009`;
    const installationId = hex32(2009);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: 0,
      processingAttemptCount: -1, // malformed.
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    return result.outcome === 'quarantined' && result.reason === 'invalid-processing-attempt-count';
  });

  await checkAsync('[queue 11] processingAttemptCount at MAX_SAFE_INTEGER -> quarantined, never incremented past safe range', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2010`;
    const installationId = hex32(2010);
    seedDoc(
      store,
      deliveryPath(reminderId, installationId),
      validQueuedDeliveryFields(installationId, { processingAttemptCount: Number.MAX_SAFE_INTEGER })
    );
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'quarantined' || result.reason !== 'processing-attempt-count-exhausted') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'invalid-delivery' && after.processingAttemptCount === Number.MAX_SAFE_INTEGER; // untouched, never incremented.
  });

  await checkAsync('[queue 12] malformed sendAttemptCount (exceeds MAX_SEND_ATTEMPTS) -> quarantined via schema check', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2011`;
    const installationId = hex32(2011);
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
      leaseExpiresAt: null,
      uid: UID,
      installationId,
      sendAttemptCount: MAX_SEND_ATTEMPTS + 1,
      processingAttemptCount: 0,
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    return result.outcome === 'quarantined' && result.reason === 'invalid-send-attempt-count';
  });

  await checkAsync('[queue 13] deletion race: acquiring a nonexistent delivery -> not-found', async () => {
    const { db } = makeFakeDb();
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, `${UID}_2012`, hex32(2012)));
    return result.outcome === 'not-found';
  });

  await checkAsync('[queue 14] concurrent/stale re-acquisition is fenced by the live lease', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_2013`;
    const installationId = hex32(2013);
    seedDoc(store, deliveryPath(reminderId, installationId), validQueuedDeliveryFields(installationId));
    const ref = __test__.deliveryRef(db, reminderId, installationId);
    const first = await acquireDeliveryProcessingLease(db, ref);
    const second = await acquireDeliveryProcessingLease(db, ref);
    return first.outcome === 'acquired' && second.outcome === 'still-leased';
  });

  await checkAsync(
    '[queue 15] every recognized delivery state, found corrupted+queue-visible, exits queue eligibility (never returned unchanged)',
    async () => {
      for (const state of DELIVERY_STATES) {
        if (state === 'queued' || state === 'preparing') continue; // legitimately queue-eligible; covered above.
        const { db, store } = makeFakeDb();
        const reminderId = `${UID}_2100`;
        const installationId = hex32(2100 + DELIVERY_STATES.indexOf(state));
        seedDoc(store, deliveryPath(reminderId, installationId), {
          state,
          workState: 'queued', // corrupted for every terminal state.
          workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
          leaseExpiresAt: null,
          uid: UID,
          installationId,
          sendAttemptCount: 0,
          processingAttemptCount: 0,
          targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
        });
        const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
        if (result.outcome !== 'terminal-repaired') return false;
        const after = readDoc(store, deliveryPath(reminderId, installationId))!;
        if (after.workState !== 'terminal' || after.state !== state) return false; // repaired, business state preserved.
      }
      return true;
    }
  );

  await checkAsync('[queue 16] discoverRecoverableDeliveryWork finds due+queued work across reminders (collection group)', async () => {
    const { db, store } = makeFakeDb();
    const dueId = hex32(2200);
    const futureId = hex32(2201);
    seedDoc(store, deliveryPath(`${UID}_a`, dueId), {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    seedDoc(store, deliveryPath(`${UID}_b`, futureId), {
      state: 'queued',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(Date.now() + 60_000),
    });
    const refs = await discoverRecoverableDeliveryWork(db);
    return refs.length === 1 && refs[0].id === dueId;
  });

  check(
    '[queue 17] DELIVERY_QUEUE_BATCH_SIZE matches the documented conservative batch size',
    DELIVERY_QUEUE_BATCH_SIZE === 50
  );

  // =======================================================================================
  // PHASE 3A-3 STEP 3C-3 — integration: acquireDeliveryProcessingLease ->
  // prepareAndFinalizeDelivery, and the bounded batch runner. Exhaustive final-authorization
  // scenario coverage lives in reminderDeliveryAuth.test.ts / reminderDeliverySender.test.ts;
  // these tests only prove the WIRING between acquisition and finalization behaves correctly
  // end to end.
  //
  // CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR (SIXTH round) — processDeliveryQueueCandidate
  // and runDeliveryWorkerBatch (now merged directly into reminderDeliveryWorker.ts) accept NO
  // db/sendCandidate parameters at all; both privately resolve real production authority.
  // These tests drive them through loadFreshWorkerModule (see its own header above), which
  // wires a fake db/OAuth-provider/transport through the SAME require-cache-busting technique
  // reminderDeliverySender.test.ts uses — proving genuine end-to-end wiring through real,
  // unmodified production authorization code, never a reimplementation.
  // =======================================================================================

  function sha256Hex(value: string): string {
    return nodeCrypto.createHash('sha256').update(value).digest('hex');
  }

  const RAW_TOKEN_3C3 = 'raw-fcm-token-should-never-persist-3c3';

  function seedFullDryRunPipeline(
    store: Store,
    overrides: { installationId?: string; token?: string; rollout?: Record<string, unknown> } = {}
  ): { uid: string; reminderId: string; installationId: string } {
    const uid = 'user-1';
    const reminderId = `${uid}_3c3_pipeline`;
    const installationId = overrides.installationId ?? hex32(4000);
    const token = overrides.token ?? RAW_TOKEN_3C3;
    const tokenHash = sha256Hex(token);

    seedDoc(store, reminderPath(reminderId), {
      uid,
      status: 'delivery-fanned-out',
      deliveryFanoutState: 'completed',
      targetInstallationCountAtFanout: 1,
      excludedMalformedInstallationCount: 0,
      fanoutExecutionId: VALID_FANOUT_EXECUTION_ID_FOR_QUEUE,
      workState: 'terminal',
      workAvailableAt: null,
      leaseExpiresAt: null,
      attemptCount: 1,
      preferenceRevisionAtClaim: 1,
      scheduleTypeAtClaim: 'daily',
      weekdaysAtClaim: [0, 1, 2, 3, 4, 5, 6],
      localTimeAtClaim: '07:00',
      timezoneAtClaim: 'UTC',
    });
    seedDoc(store, deliveryPath(reminderId, installationId), validQueuedDeliveryFields(installationId));
    seedDoc(store, prefPath(uid), {
      enabled: true,
      revision: 1,
      scheduleType: 'daily',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      localTime: '07:00',
      timezone: 'UTC',
    });
    seedDoc(store, rolloutPath(), { mode: 'dry-run', ...overrides.rollout });
    seedDoc(store, installationPath(installationId), {
      uid,
      state: 'active',
      epochSchemaVersion: 1,
      tokenVersion: 1,
      installationAudienceId: 'A'.repeat(16),
      generation: 1,
      token,
    });
    seedDoc(store, tokenClaimPath(tokenHash), { installationId, uid });

    return { uid, reminderId, installationId };
  }

  const neverCalledTransport = async (): Promise<FcmSendOutcome> => {
    throw new Error('test bug: transport must never be called in a dry-run-rollout scenario');
  };

  await checkAsync('[3C-3] processDeliveryQueueCandidate: full happy path acquires and dry-run-validates', async () => {
    const { db, store } = makeFakeDb();
    const { reminderId, installationId } = seedFullDryRunPipeline(store);
    const worker = loadFreshWorkerModule({ db, accessTokenProvider: async () => 'fake-oauth-token', transport: neverCalledTransport });
    const result = await worker.processDeliveryQueueCandidate(worker.__test__.deliveryRef(db, reminderId, installationId));
    if (result.acquisition.outcome !== 'acquired') return false;
    if (result.outcome?.outcome !== 'dry-run-validated') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'dry-run-validated' && after.workState === 'terminal';
  });

  await checkAsync('[3C-3] processDeliveryQueueCandidate: OAuth failure leaves delivery in preparing, no finalization write', async () => {
    const { db, store } = makeFakeDb();
    const { reminderId, installationId } = seedFullDryRunPipeline(store);
    const failingProvider: AccessTokenProvider = async () => {
      throw new Error('synthetic OAuth failure');
    };
    const worker = loadFreshWorkerModule({ db, accessTokenProvider: failingProvider, transport: neverCalledTransport });
    const result = await worker.processDeliveryQueueCandidate(worker.__test__.deliveryRef(db, reminderId, installationId));
    if (result.acquisition.outcome !== 'acquired') return false;
    if (result.outcome?.outcome !== 'oauth-preparation-failed') return false;
    const after = readDoc(store, deliveryPath(reminderId, installationId))!;
    return after.state === 'preparing'; // untouched by the failed finalization attempt.
  });

  await checkAsync('[3C-3] processDeliveryQueueCandidate: non-acquired outcomes never invoke finalization at all', async () => {
    const { db, store } = makeFakeDb();
    let providerCalled = false;
    const provider: AccessTokenProvider = async () => {
      providerCalled = true;
      return 'unused';
    };
    const reminderId = `${UID}_3c3_notleased`;
    const installationId = hex32(4001);
    seedDoc(
      store,
      deliveryPath(reminderId, installationId),
      validQueuedDeliveryFields(installationId, { workAvailableAt: Timestamp.fromMillis(Date.now() + 60_000) })
    );
    const worker = loadFreshWorkerModule({ db, accessTokenProvider: provider, transport: neverCalledTransport });
    const result = await worker.processDeliveryQueueCandidate(worker.__test__.deliveryRef(db, reminderId, installationId));
    return result.acquisition.outcome === 'still-leased' && result.outcome === undefined && !providerCalled;
  });

  await checkAsync('[3C-3] runDeliveryWorkerBatch: end-to-end batch discovers, acquires, and dry-run-validates', async () => {
    const { db, store } = makeFakeDb();
    seedFullDryRunPipeline(store);
    const worker = loadFreshWorkerModule({ db, accessTokenProvider: async () => 'fake-oauth-token', transport: neverCalledTransport });
    const summary = await worker.runDeliveryWorkerBatch();
    return summary.candidateCount === 1 && summary.dryRunValidatedCount === 1 && summary.unexpectedFailureCount === 0;
  });

  await checkAsync(
    "[3C-4] runDeliveryWorkerBatch: even on a real dry-run-validated pass, every new send-related counter stays exactly 0 (proves 'sending-authorized' genuinely never occurs for this fixture's rollout mode 'dry-run' — regardless of either file's own REAL_DELIVERY_STAGE, which is now 'allowlisted-only' in both, dry-run mode itself never authorizes a real send — see decideFinalAuthorizationRolloutDisposition)",
    async () => {
      const { db, store } = makeFakeDb();
      seedFullDryRunPipeline(store);
      const worker = loadFreshWorkerModule({ db, accessTokenProvider: async () => 'fake-oauth-token', transport: neverCalledTransport });
      const summary = await worker.runDeliveryWorkerBatch();
      return (
        summary.sendAcceptedCount === 0 &&
        summary.sendRejectedFinalCount === 0 &&
        summary.sendUnknownOutcomeCount === 0 &&
        summary.sendRequeuedForRetryCount === 0 &&
        summary.sendOutcomeFenceMismatchCount === 0 &&
        summary.sendPersistenceFailedCount === 0
      );
    }
  );

  await checkAsync('[3C-3] runDeliveryWorkerBatch: bounded batch size and concurrency constants are sane', async () => {
    return DELIVERY_PROCESSING_CONCURRENCY > 0 && DELIVERY_PROCESSING_CONCURRENCY <= DELIVERY_QUEUE_BATCH_SIZE;
  });

  await checkAsync('[3C-3] runDeliveryWorkerBatch: rollout paused (default/missing) -> zero dry-run-validated even with due work present', async () => {
    const { db, store } = makeFakeDb();
    // A queued, due delivery exists, but its parent was never fanned out under dry-run
    // rollout (simulating the CURRENT production default where no rollout document exists
    // at all and Step 2 never calls fanOutReminderDelivery in the first place) — acquisition
    // still succeeds structurally, but final authorization must refuse without a rollout
    // config document present.
    const reminderId = `${UID}_3c3_paused`;
    const installationId = hex32(4002);
    seedDoc(store, deliveryPath(reminderId, installationId), validQueuedDeliveryFields(installationId));
    // Deliberately no rollout document, no parent, no preference, no installation, no claim
    // — proving the batch runner surfaces a 'cancelled'/failure outcome rather than crashing
    // or silently validating.
    const worker = loadFreshWorkerModule({ db, accessTokenProvider: async () => 'fake-oauth-token', transport: neverCalledTransport });
    const summary = await worker.runDeliveryWorkerBatch();
    return summary.candidateCount === 1 && summary.dryRunValidatedCount === 0 && summary.cancelledCount === 1;
  });

  // =======================================================================================
  // M1 REPAIR — complete persisted-delivery validator. Every case below must NEVER acquire;
  // must always quarantine to invalid-delivery with a fixed internal reason (never a raw
  // malformed value embedded in the reason); must always clear the queue tuple.
  // =======================================================================================

  const malformedQueuedDeliveryCases: { label: string; refId: string; overrides: Record<string, unknown> }[] = [
    { label: 'missing/undefined deliveryPublicId', refId: hex32(3000), overrides: { deliveryPublicId: undefined } },
    { label: 'malformed deliveryPublicId (too short)', refId: hex32(3001), overrides: { deliveryPublicId: 'A'.repeat(DELIVERY_PUBLIC_ID_LENGTH - 1) } },
    { label: 'malformed deliveryPublicId (too long)', refId: hex32(3002), overrides: { deliveryPublicId: 'A'.repeat(DELIVERY_PUBLIC_ID_LENGTH + 1) } },
    { label: 'malformed deliveryPublicId (invalid character)', refId: hex32(3003), overrides: { deliveryPublicId: '!'.repeat(DELIVERY_PUBLIC_ID_LENGTH) } },
    { label: 'malformed deliveryPublicId (padding =)', refId: hex32(3004), overrides: { deliveryPublicId: 'A'.repeat(DELIVERY_PUBLIC_ID_LENGTH - 1) + '=' } },
    { label: 'malformed deliveryPublicId (whitespace)', refId: hex32(3005), overrides: { deliveryPublicId: 'A'.repeat(DELIVERY_PUBLIC_ID_LENGTH - 1) + ' ' } },
    { label: 'malformed deliveryPublicId (slash)', refId: hex32(3006), overrides: { deliveryPublicId: 'A'.repeat(DELIVERY_PUBLIC_ID_LENGTH - 1) + '/' } },
    { label: 'malformed deliveryPublicId (wrong type: number)', refId: hex32(3007), overrides: { deliveryPublicId: 12345 } },
    { label: 'malformed attemptHistory (not an array)', refId: hex32(3008), overrides: { attemptHistory: 'not-an-array' } },
    {
      label: 'nonsequential attemptHistory',
      refId: hex32(3009),
      overrides: { attemptHistory: [{ attemptNumber: 2, sendIntentAt: Date.now(), outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: Date.now() }] },
    },
    {
      label: 'attemptHistory entry with forbidden/secret own field',
      refId: hex32(3010),
      overrides: {
        attemptHistory: [
          { attemptNumber: 1, sendIntentAt: Date.now(), outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: Date.now(), rawToken: 'SECRET' },
        ],
      },
    },
    { label: 'malformed installationAudienceId (too short)', refId: hex32(3011), overrides: { targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'short' } } },
    { label: 'malformed installationAudienceId (bad alphabet)', refId: hex32(3012), overrides: { targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: '!'.repeat(16) } } },
    { label: 'invalid generation (0)', refId: hex32(3013), overrides: { targetSnapshot: { generation: 0, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) } } },
    { label: 'invalid generation (negative)', refId: hex32(3014), overrides: { targetSnapshot: { generation: -1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) } } },
    { label: 'invalid tokenVersion (0)', refId: hex32(3015), overrides: { targetSnapshot: { generation: 1, tokenVersion: 0, installationAudienceId: 'A'.repeat(16) } } },
    { label: 'stored installationId malformed shape (not UUID/hex32)', refId: hex32(3016), overrides: { installationId: 'not-a-valid-installation-id-shape' } },
  ];

  for (const testCase of malformedQueuedDeliveryCases) {
    await checkAsync(`[queue M1] ${testCase.label} -> never acquired, quarantined to invalid-delivery`, async () => {
      const { db, store } = makeFakeDb();
      const reminderId = `${UID}_m1_${testCase.refId}`;
      const docPath = deliveryPath(reminderId, testCase.refId);
      seedDoc(store, docPath, validQueuedDeliveryFields(testCase.refId, testCase.overrides));
      const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, testCase.refId));
      if (result.outcome !== 'quarantined') return false;
      const after = readDoc(store, docPath)!;
      return (
        after.state === 'invalid-delivery' &&
        after.workState === 'terminal' &&
        after.workAvailableAt === null &&
        after.leaseExpiresAt === null &&
        typeof after.invalidDeliveryReason === 'string' &&
        after.invalidDeliveryReason.length > 0
      );
    });
  }

  await checkAsync('[queue M1] ref.id and stored installationId are both valid shapes but differ -> quarantined, never acquired', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_m1_idmismatch`;
    const refInstallationId = hex32(3100);
    const storedInstallationId = hex32(3101);
    const docPath = deliveryPath(reminderId, refInstallationId);
    seedDoc(store, docPath, validQueuedDeliveryFields(storedInstallationId)); // deliberately mismatched vs. the doc's own path id.
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, refInstallationId));
    if (result.outcome !== 'quarantined') return false;
    const after = readDoc(store, docPath)!;
    return after.state === 'invalid-delivery' && after.workState === 'terminal';
  });

  await checkAsync('[queue M1] ref.id itself is not a valid installation-ID shape -> quarantined, never acquired', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_m1_refmalformed`;
    const malformedRefId = 'not-a-valid-installation-id-shape';
    const docPath = deliveryPath(reminderId, malformedRefId);
    seedDoc(store, docPath, validQueuedDeliveryFields(malformedRefId)); // ref.id and stored installationId match, but neither is UUID/hex32-shaped.
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, malformedRefId));
    if (result.outcome !== 'quarantined') return false;
    const after = readDoc(store, docPath)!;
    return after.state === 'invalid-delivery' && after.workState === 'terminal';
  });

  await checkAsync('[queue M1 item 10] preparing recovery with malformed deliveryPublicId -> quarantined, NOT recovered', async () => {
    const { db, store } = makeFakeDb();
    const reminderId = `${UID}_m1_recovery`;
    const installationId = hex32(3200);
    const pastMs = Date.now() - 1000;
    const docPath = deliveryPath(reminderId, installationId);
    seedDoc(
      store,
      docPath,
      validQueuedDeliveryFields(installationId, {
        state: 'preparing',
        workAvailableAt: Timestamp.fromMillis(pastMs),
        leaseExpiresAt: Timestamp.fromMillis(pastMs),
        processingAttemptCount: 1,
        deliveryPublicId: 'not-a-valid-public-id',
      })
    );
    const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
    if (result.outcome !== 'quarantined') return false;
    const after = readDoc(store, docPath)!;
    return after.state === 'invalid-delivery' && after.workState === 'terminal' && after.processingAttemptCount === 1; // never incremented.
  });

  await checkAsync(
    "[queue M1 item 11] 'sending' + queue corruption + malformed deliveryPublicId/history -> still repaired, state preserved, never quarantined/retried",
    async () => {
      const { db, store } = makeFakeDb();
      const reminderId = `${UID}_m1_sending`;
      const installationId = hex32(3300);
      const docPath = deliveryPath(reminderId, installationId);
      seedDoc(store, docPath, {
        state: 'sending',
        workState: 'queued', // corrupted.
        workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
        leaseExpiresAt: null,
        uid: UID,
        installationId,
        deliveryPublicId: 'totally-malformed',
        sendAttemptCount: 1,
        processingAttemptCount: 1,
        attemptHistory: [{ attemptNumber: 5, sendIntentAt: 'garbage' }], // nonsensical/poisoned.
        targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
      });
      const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
      if (result.outcome !== 'terminal-repaired') return false;
      const after = readDoc(store, docPath)!;
      return (
        after.state === 'sending' &&
        after.workState === 'terminal' &&
        after.workAvailableAt === null &&
        after.leaseExpiresAt === null &&
        after.sendAttemptCount === 1 && // untouched, never incremented — no retry manufactured.
        after.deliveryPublicId === 'totally-malformed' // untouched — repair never rewrites business/identity fields.
      );
    }
  );

  await checkAsync(
    "[queue M1 item 12] 'accepted-by-fcm' + queue corruption + malformed identity fields -> still repaired, business state preserved, no complete-schema requirement",
    async () => {
      const { db, store } = makeFakeDb();
      const reminderId = `${UID}_m1_terminal`;
      const installationId = hex32(3400);
      const docPath = deliveryPath(reminderId, installationId);
      seedDoc(store, docPath, {
        state: 'accepted-by-fcm',
        workState: 'queued', // corrupted.
        workAvailableAt: Timestamp.fromMillis(Date.now() - 1000),
        leaseExpiresAt: null,
        uid: UID,
        installationId: 'mismatched-and-malformed',
        deliveryPublicId: 12345, // wrong type.
        sendAttemptCount: 1,
        processingAttemptCount: 1,
        attemptHistory: 'not-an-array',
        targetSnapshot: { generation: -1, tokenVersion: 0, installationAudienceId: '' },
      });
      const result = await acquireDeliveryProcessingLease(db, __test__.deliveryRef(db, reminderId, installationId));
      if (result.outcome !== 'terminal-repaired') return false;
      const after = readDoc(store, docPath)!;
      return after.state === 'accepted-by-fcm' && after.workState === 'terminal';
    }
  );

  // =======================================================================================
  // STATIC NO-SENDER GUARD (report section 25) + PRIVACY AUDIT (section 26).
  //
  // CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR (SIXTH round, SECOND pass) — the
  // acquisition-vs-transport tally logic that FIFTH round's reminderDeliveryWorkerCore.ts
  // held now lives directly in THIS file (module-private, behind zero-authority-parameter
  // exports — see this file's own header for why a separate importable core file could
  // never actually stay out of the deployed artifact). As a direct consequence, this file's
  // own source DOES now reference the literal delivery states 'sending'/'accepted-by-fcm'/
  // 'rejected-final'/'dry-run-validated' (in the tally switch inside runDeliveryWorkerBatch)
  // — the checks below are updated accordingly: this file still never imports fcmTransport.ts
  // or google-auth-library directly, and never touches a raw token/capability, but it is no
  // longer literally state-blind the way the FIFTH round's thin wrapper was.
  // =======================================================================================

  const workerSourcePath = path.join(__dirname, '..', 'src', 'reminderDeliveryWorker.ts');
  const workerSource = fs.readFileSync(workerSourcePath, 'utf8');
  const codeOnly = stripComments(workerSource);

  check('reminderDeliveryWorker.ts never imports from ./fcmTransport', !codeOnly.includes('fcmTransport'));
  check('reminderDeliveryWorker.ts never calls sendFcmOnce', !codeOnly.includes('sendFcmOnce'));
  check('reminderDeliveryWorker.ts never calls getMessaging(', !codeOnly.includes('getMessaging('));
  check("reminderDeliveryWorker.ts never imports 'firebase-admin/messaging'", !codeOnly.includes('firebase-admin/messaging'));
  check("reminderDeliveryWorker.ts never imports 'node:https'", !codeOnly.includes('node:https'));
  check('reminderDeliveryWorker.ts never calls fetch(', !codeOnly.includes('fetch('));
  check('reminderDeliveryWorker.ts never references globalThis.fetch', !codeOnly.includes('globalThis.fetch'));
  check("reminderDeliveryWorker.ts never imports 'google-auth-library'", !codeOnly.includes('google-auth-library'));
  check(
    "reminderDeliveryWorker.ts never imports 'google-auth-library' directly and never constructs a GoogleAuth instance or calls .getAccessToken( itself — OAuth logic remains exclusively owned by reminderDeliveryAuth.ts, reached only transitively through reminderDeliverySender.ts",
    !codeOnly.includes("from 'google-auth-library'") && !codeOnly.includes('new GoogleAuth(') && !codeOnly.includes('.getAccessToken(')
  );
  check(
    "reminderDeliveryWorker.ts never imports or references a DeliverySendCapability-shaped type, and never imports the module-private executeControlledSend/commitSendOutcome from reminderDeliverySender.ts — its only touchpoint with the sender is the single safe orchestration entry point, processControlledSendCandidate",
    !codeOnly.includes('DeliverySendCapability') && !codeOnly.includes('executeControlledSend') && !codeOnly.includes('commitSendOutcome')
  );
  check(
    'no raw installation/FCM token or raw OAuth access token literal identifier (installationToken/accessToken) appears anywhere in this file',
    !codeOnly.includes('installationToken') && !/\baccessToken\b/.test(codeOnly)
  );

  // =======================================================================================
  // STEP 3C-4/3C-5/3C-6 — SENDER WIRING. Both reminderDeliveryAuth.ts's and
  // reminderDeliverySender.ts's own independent REAL_DELIVERY_STAGE constants are
  // 'allowlisted-only', but a real send additionally requires the production rollout
  // document itself to be 'allowlisted-real-send' with the calling uid allowlisted — the
  // production rollout document remains `{mode:"paused"}` today, so this wiring is still
  // behaviorally unreachable in production regardless of source stage, verified statically
  // here. This worker imports processControlledSendCandidate from ./reminderDeliverySender
  // and immediately, immutably captures it (H3/H4-style) — see the immutable capture section
  // below.
  // =======================================================================================
  check(
    "reminderDeliveryWorker.ts imports processControlledSendCandidate (plus the SanitizedSendOrchestrationResult type) from ./reminderDeliverySender, and immediately captures it into a top-level const (capturedProcessControlledSendCandidate)",
    /import \{ processControlledSendCandidate, type SanitizedSendOrchestrationResult \} from '\.\/reminderDeliverySender';/.test(codeOnly) &&
      codeOnly.includes('const capturedProcessControlledSendCandidate = processControlledSendCandidate;')
  );
  check(
    'reminderDeliveryWorker.ts references the bare identifier processControlledSendCandidate exactly twice in its own code (the import + the one capture line) — every actual call site below the capture block uses ONLY the captured local (capturedProcessControlledSendCandidate), never the live import binding again',
    (codeOnly.match(/(?<!captured)processControlledSendCandidate/g) || []).length === 2
  );
  check(
    'reminderDeliveryWorker.ts never itself imports fcmTransport.ts directly — the only path to it is transitively through reminderDeliverySender.ts',
    !codeOnly.includes("from './fcmTransport'") && !codeOnly.includes('sendFcmOnce')
  );

  // =======================================================================================
  // Phase 3A-3 Step 3C-3 — production reachability changed intentionally this round: this
  // file now exports exactly one Cloud Function, and reminderScheduler.ts now calls
  // fanOutReminderDelivery under an explicit rollout gate. These checks replace the prior
  // round's "not reachable at all" assertions with "reachable only through the one intended
  // path" assertions. CODEX SENDER-BOUNDARY REPAIR — "structurally-no-sender" is no longer
  // an accurate description of this path: this file now transitively reaches
  // processControlledSendCandidate (and, through it, fcmTransport/sendFcmOnce) for every
  // candidate it processes. Whether a real send is ever actually authorized depends on
  // rollout configuration and both files' independent REAL_DELIVERY_STAGE constants, not on
  // this file's own structure.
  //
  // CODEX FUNCTION-IDENTITY REPAIR (M1) — the exported Cloud Function was renamed this round
  // from notificationReminderDeliveryDryRun to notificationReminderDeliveryWorker: once
  // deployed and later armed, it can perform real allowlisted sends, so a name containing
  // "DryRun" would be operationally false. This source rename is NOT deployed this turn.
  // =======================================================================================

  check(
    'reminderDeliveryWorker.ts IS now exported from index.ts, exactly as notificationReminderDeliveryWorker (renamed from notificationReminderDeliveryDryRun this round — see M1)',
    (() => {
      const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
      return (
        indexSource.includes("export { notificationReminderDeliveryWorker } from './reminderDeliveryWorker';") &&
        !indexSource.includes('notificationReminderDeliveryDryRun')
      );
    })()
  );
  check(
    'reminderDeliveryWorker.ts exports exactly one onSchedule-registered Cloud Function',
    (codeOnly.match(/export const \w+ = onSchedule\(/g) || []).length === 1
  );
  check(
    "the scheduled export's name is notificationReminderDeliveryWorker — no longer contains 'DryRun', which would now be operationally false once this source is deployed and armed (M1); the old name is gone from this file entirely",
    codeOnly.includes('export const notificationReminderDeliveryWorker = onSchedule(') && !codeOnly.includes('notificationReminderDeliveryDryRun')
  );
  check(
    'reminderScheduler.ts now calls fanOutReminderDelivery, gated behind decideShouldFanOut (never unconditionally)',
    (() => {
      const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'reminderScheduler.ts'), 'utf8');
      const schedulerCodeOnly = stripComments(schedulerSource);
      return (
        schedulerCodeOnly.includes('fanOutReminderDelivery(') &&
        schedulerCodeOnly.includes('decideShouldFanOut(') &&
        schedulerCodeOnly.includes('.shouldFanOut')
      );
    })()
  );
  check(
    'reminderScheduler.ts still contains no direct reference to fcmTransport/sendFcmOnce/getMessaging(/node:https/fetch( (fanout wiring introduced no sender)',
    (() => {
      const schedulerCodeOnly = stripComments(fs.readFileSync(path.join(__dirname, '..', 'src', 'reminderScheduler.ts'), 'utf8'));
      return (
        !schedulerCodeOnly.includes('fcmTransport') &&
        !schedulerCodeOnly.includes('sendFcmOnce') &&
        !schedulerCodeOnly.includes('getMessaging(') &&
        !schedulerCodeOnly.includes('node:https') &&
        !schedulerCodeOnly.includes('fetch(')
      );
    })()
  );

  // =======================================================================================
  // FINAL Codex repair round — static proof that NO exported production symbol accepts
  // caller-supplied fanout entropy. The prior round's exported test-only wrapper
  // (__fanOutReminderDeliveryForTestOnly) has been removed entirely, not merely documented.
  // =======================================================================================

  check(
    'exported fanOutReminderDelivery declares exactly 3 parameters (db, reminderId, expectedAttemptCount) — no nonce parameter exists on the production API',
    (() => {
      const match = codeOnly.match(/export async function fanOutReminderDelivery\(([\s\S]*?)\): Promise<FanoutExecutionResult>/);
      if (!match) return false;
      const paramCount = match[1]
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0).length;
      return paramCount === 3;
    })()
  );
  check(
    'fanOutReminderDeliveryWithNonce (the real transaction logic) is module-private — never exported',
    !codeOnly.includes('export function fanOutReminderDeliveryWithNonce') && !codeOnly.includes('export async function fanOutReminderDeliveryWithNonce')
  );
  check(
    '__fanOutReminderDeliveryForTestOnly no longer exists as CODE anywhere in reminderDeliveryWorker.ts (checked with comments stripped — fully removed, not merely unexported)',
    !codeOnly.includes('__fanOutReminderDeliveryForTestOnly')
  );
  check(
    '__fanOutReminderDeliveryForTestOnly is referenced by NO other source file in this repository (as code, comments stripped)',
    (() => {
      const srcDir = path.join(__dirname, '..', 'src');
      const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== 'reminderDeliveryWorker.test.ts' && f !== 'reminderDeliveryWorker.ts');
      return files.every((f) => !stripComments(fs.readFileSync(path.join(srcDir, f), 'utf8')).includes('__fanOutReminderDeliveryForTestOnly'));
    })()
  );

  // Compiled/runtime export-surface inspection (report item 6): require the ACTUAL compiled
  // module (the same lib/reminderDeliveryWorker.js this test file itself imports from) and
  // enumerate its real runtime export keys — proving the nonce-taking seam is gone not just
  // from the TypeScript source, but from the emitted JavaScript module.exports object Codex
  // specifically flagged.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const compiledWorkerModule = require('./reminderDeliveryWorker') as Record<string, unknown>;
  const compiledExportNames = Object.keys(compiledWorkerModule);
  check(
    'compiled lib/reminderDeliveryWorker.js runtime export surface does not include __fanOutReminderDeliveryForTestOnly',
    !compiledExportNames.includes('__fanOutReminderDeliveryForTestOnly')
  );
  check(
    'compiled lib/reminderDeliveryWorker.js runtime export surface does not include fanOutReminderDeliveryWithNonce',
    !compiledExportNames.includes('fanOutReminderDeliveryWithNonce')
  );
  check(
    'compiled lib/reminderDeliveryWorker.js still exports the real fanOutReminderDelivery as a function',
    typeof compiledWorkerModule.fanOutReminderDelivery === 'function'
  );
  check(
    'no exported runtime function on the compiled reminderDeliveryWorker.js module has arity suggesting a 4th (nonce) parameter',
    Object.entries(compiledWorkerModule).every(([name, value]) => {
      if (typeof value !== 'function') return true;
      // fanOutReminderDelivery: (db, reminderId, expectedAttemptCount) -> length 3.
      // processDeliveryQueueCandidate: (ref) -> length 1. runDeliveryWorkerBatch: () ->
      // length 0. Every real exported function has arity <= 3; nothing takes 4 params.
      return value.length <= 3;
    })
  );

  // =======================================================================================
  // TRUSTED-AUTHORITY ATTACK TESTS A/D, K/L (carried forward from the FIFTH round, updated
  // for the SIXTH round's single-file architecture — there is no longer a separate
  // reminderDeliveryWorkerCore.js to check; both the acquisition-only helpers and the
  // transport-capable batch orchestration now live in the same compiled module).
  // =======================================================================================
  check(
    '[trusted-authority A/D] compiled reminderDeliveryWorker.js processDeliveryQueueCandidate has EXACTLY 1 runtime parameter (ref only) — no db, no sendCandidate; it privately obtains its own Firestore authority and the real, immutably-captured sendCandidate',
    (compiledWorkerModule.processDeliveryQueueCandidate as (...args: unknown[]) => unknown).length === 1
  );
  check(
    '[trusted-authority A/D] compiled reminderDeliveryWorker.js runDeliveryWorkerBatch has EXACTLY 0 runtime parameters — there is nothing left for any caller to inject at all',
    (compiledWorkerModule.runDeliveryWorkerBatch as (...args: unknown[]) => unknown).length === 0
  );
  check(
    "[trusted-authority] reminderDeliveryWorker.ts privately obtains its own Firestore authority via a non-exported module-scope function (getProductionWorkerDb) — that name does not appear anywhere in this file's own compiled export names, and reminderDeliveryTrustedRuntime.ts (the FOURTH round's writable shared getter module, itself the vulnerability) no longer exists at all in this codebase",
    codeOnly.includes('function getProductionWorkerDb()') &&
      !compiledExportNames.includes('getProductionWorkerDb') &&
      !fs.existsSync(path.join(__dirname, '..', 'src', 'reminderDeliveryTrustedRuntime.ts'))
  );
  check(
    'compiled lib/reminderDeliveryWorker.js exports EXACTLY the expected runtime surface (fanout API + acquisition helpers + zero-authority-parameter batch orchestration + test path helpers — no db/sendCandidate-accepting core export anywhere)',
    (() => {
      const expected = [
        'DELIVERY_PROCESSING_CONCURRENCY',
        'DELIVERY_PUBLIC_ID_LENGTH',
        'DELIVERY_QUEUE_BATCH_SIZE',
        '__test__',
        'acquireDeliveryProcessingLease',
        'discoverRecoverableDeliveryWork',
        'fanOutReminderDelivery',
        'isValidDeliveryPublicIdFormat',
        'notificationReminderDeliveryWorker',
        'processDeliveryQueueCandidate',
        'runDeliveryWorkerBatch',
      ].sort();
      return JSON.stringify(compiledExportNames.slice().sort()) === JSON.stringify(expected);
    })()
  );

  // =======================================================================================
  // CODEX BUILD-TIME AUTHORITY SEPARATION REPAIR (SIXTH round) — H1 regression protection
  // (see reminderDeliverySender.test.ts's own identical section for why this is a static
  // config check rather than a real rebuild-from-inside-a-running-test-file) and H4
  // immutable-capture static proof for THIS file's own private db resolver.
  // =======================================================================================
  console.log('\n=== build-time authority separation (H1) + immutable authority capture (H4) ===');

  check(
    "functions/tsconfig.json excludes 'src/**/*.test.ts' from the PRODUCTION build (there is no longer a testsupport/ directory to exclude — the deleted core files never existed as separately compiled artifacts at all)",
    (() => {
      const tsconfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tsconfig.json'), 'utf8')) as { exclude?: string[] };
      return (tsconfig.exclude ?? []).includes('src/**/*.test.ts');
    })()
  );

  const compiledWorkerJsPath = path.join(__dirname, 'reminderDeliveryWorker.js');
  const compiledWorkerJs = fs.readFileSync(compiledWorkerJsPath, 'utf8');
  // capturedProcessControlledSendCandidate is included here too (H3/H4-style, applied at the
  // worker/sender module boundary — see reminderDeliveryWorker.ts's own header comment on
  // that capture line): an un-captured `sender_1.processControlledSendCandidate(...)` read
  // would let a future in-process mutation of reminderDeliverySender.ts's own exports
  // redirect what this file calls, exactly like the 5 raw-dependency captures below.
  const WORKER_CAPTURED_NAMES = ['capturedGetApps', 'capturedInitializeApp', 'capturedGetFirestore', 'capturedProcessControlledSendCandidate'];
  const WORKER_DEPENDENCY_FN_NAMES = ['getApps', 'initializeApp', 'getFirestore', 'processControlledSendCandidate'];

  check(
    'compiled lib/reminderDeliveryWorker.js captures getApps/initializeApp/getFirestore/processControlledSendCandidate into plain top-level `const captured<Name> = <module>_1.<name>;` bindings — exactly one capture line per dependency',
    WORKER_CAPTURED_NAMES.every((name) => (compiledWorkerJs.match(new RegExp(`const ${name} = \\w+_\\d+\\.\\w+;`, 'g')) || []).length === 1)
  );
  check(
    'after removing the 4 capture lines, none of getApps/initializeApp/getFirestore/processControlledSendCandidate is read a second time through any `<module>_<n>.<name>` property access anywhere else in the compiled file',
    (() => {
      let withoutCaptureLines = compiledWorkerJs;
      for (const name of WORKER_CAPTURED_NAMES) {
        withoutCaptureLines = withoutCaptureLines.replace(new RegExp(`const ${name} = \\w+_\\d+\\.\\w+;\\n`), '');
      }
      const dynamicReadPattern = new RegExp(`\\w+_\\d+\\.(${WORKER_DEPENDENCY_FN_NAMES.join('|')})\\b`);
      return !dynamicReadPattern.test(withoutCaptureLines);
    })()
  );

  await checkAsync(
    '[module-load-order] requiring the production worker module FIRST, then mutating firebase-admin/app+firestore exports AFTERWARD genuinely changes what those dependency modules expose (attack vector is real) — combined with the static capture proof above, the mutation cannot reach reminderDeliveryWorker.ts\'s own already-captured binding. Never invokes runDeliveryWorkerBatch/processDeliveryQueueCandidate itself (would require real network).',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('./reminderDeliveryWorker'); // production wrapper loaded and captured FIRST.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const firestoreMod = require('firebase-admin/firestore') as { getFirestore: unknown };
      const original = firestoreMod.getFirestore;
      const fake = () => {
        throw new Error('fake getFirestore should never be reached by the production wrapper');
      };
      try {
        (firestoreMod as { getFirestore: unknown }).getFirestore = fake;
        return firestoreMod.getFirestore === fake && firestoreMod.getFirestore !== original;
      } finally {
        (firestoreMod as { getFirestore: unknown }).getFirestore = original;
      }
    }
  );

  await checkAsync(
    '[module-load-order, worker/sender boundary] requiring the production worker module FIRST (capturing processControlledSendCandidate), then mutating reminderDeliverySender.js\'s own exported processControlledSendCandidate AFTERWARD genuinely changes what that module exposes — but cannot reach reminderDeliveryWorker.ts\'s own already-captured binding',
    async () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('./reminderDeliveryWorker'); // captured FIRST.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const senderMod = require('./reminderDeliverySender') as { processControlledSendCandidate: unknown };
      const original = senderMod.processControlledSendCandidate;
      const fake = async () => {
        throw new Error('fake processControlledSendCandidate should never be reached by the production worker');
      };
      try {
        (senderMod as { processControlledSendCandidate: unknown }).processControlledSendCandidate = fake;
        return senderMod.processControlledSendCandidate === fake && senderMod.processControlledSendCandidate !== original;
      } finally {
        (senderMod as { processControlledSendCandidate: unknown }).processControlledSendCandidate = original;
      }
    }
  );

  // Repository-wide nonce-bypass search (report item 7): scan every NON-TEST source file for
  // fanOutReminderDeliveryWithNonce / fanoutNonce / randomBytes(. Per Codex's explicit
  // instruction, reminderDeliveryLogic.ts's pure deriveDeliveryPublicId parameter (named
  // `fanoutNonce`) is legitimate and not flagged; pushInstallations.ts /
  // pushInstallationEpochLogic.ts's pre-existing, unrelated randomBytes()-based credential
  // generation (established well before this round, reviewed separately) is likewise not
  // flagged. The security boundary under test is: no OTHER file may generate or accept
  // fanout entropy, and fanOutReminderDeliveryWithNonce must appear nowhere but its own
  // module-private definition and single call site inside reminderDeliveryWorker.ts.
  {
    const srcDir = path.join(__dirname, '..', 'src');
    const allSourceFiles = fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    // Step 3C-4: reminderDeliveryAuth.ts now also legitimately calls randomBytes( — its
    // OWN, independent generation of sendExecutionId (mirroring, not reusing, the fanout
    // module's per-attempt-identity pattern). Added to the allowlist deliberately, not
    // silently — this is a reviewed, expected new call site, not scope creep.
    const RANDOMBYTES_ALLOWED_FILES = new Set(['reminderDeliveryWorker.ts', 'reminderDeliveryAuth.ts', 'pushInstallations.ts', 'pushInstallationEpochLogic.ts']);
    const FANOUT_NONCE_IDENTIFIER_ALLOWED_FILES = new Set(['reminderDeliveryWorker.ts', 'reminderDeliveryLogic.ts']);

    check(
      'fanOutReminderDeliveryWithNonce appears in NO source file other than reminderDeliveryWorker.ts',
      allSourceFiles.every((f) => {
        const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
        if (f === 'reminderDeliveryWorker.ts') return true; // expected: private definition + its one call site.
        return !src.includes('fanOutReminderDeliveryWithNonce');
      })
    );
    check(
      "the identifier 'fanoutNonce' appears only in reminderDeliveryWorker.ts (implementation) and reminderDeliveryLogic.ts (pure deriveDeliveryPublicId parameter)",
      allSourceFiles.every((f) => {
        if (FANOUT_NONCE_IDENTIFIER_ALLOWED_FILES.has(f)) return true;
        const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
        return !src.includes('fanoutNonce');
      })
    );
    check(
      'randomBytes( is called only from reminderDeliveryWorker.ts and the two pre-existing, unrelated credential-generation files',
      allSourceFiles.every((f) => {
        if (RANDOMBYTES_ALLOWED_FILES.has(f)) return true;
        const src = fs.readFileSync(path.join(srcDir, f), 'utf8');
        return !src.includes('randomBytes(');
      })
    );
    check(
      'reminderDeliveryWorker.ts calls randomBytes( exactly twice in its own CODE (comments stripped) — fanoutNonce + fanoutExecutionId, both inside fanOutReminderDelivery only, per Codex H1 repair round',
      (codeOnly.match(/randomBytes\(/g) || []).length === 2
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
