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
//   npm run build
//   node lib/reminderDeliveryWorker.test.js
import * as fs from 'fs';
import * as path from 'path';
import nodeCrypto = require('node:crypto');
import { FieldValue, FieldPath, Timestamp } from 'firebase-admin/firestore';
import {
  fanOutReminderDelivery,
  discoverRecoverableDeliveryWork,
  acquireDeliveryProcessingLease,
  DELIVERY_QUEUE_BATCH_SIZE,
  DELIVERY_PUBLIC_ID_LENGTH,
  __test__,
  type FanoutExecutionResult,
} from './reminderDeliveryWorker';
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
  'processingAttemptCount',
  'sendAttemptCount',
  'attemptHistory',
  'targetSnapshot',
  'createdAt',
  'updatedAt',
]);

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
    '[fanout H1] production fanOutReminderDelivery generates its own randomBytes exactly once and never reuses a caller value',
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
      if (randomBytesCallCount !== 1) return false;
      if (result.outcome !== 'fanned-out' || result.createdDeliveryCount !== 1) return false;
      const child = readDoc(store, deliveryPath(reminderId, installationId));
      return typeof child?.deliveryPublicId === 'string' && (child.deliveryPublicId as string).length === DELIVERY_PUBLIC_ID_LENGTH;
    }
  );

  await checkAsync(
    '[fanout H1] simulated transaction-callback retry: callback invoked twice, randomBytes called once, both attempts derive identical deliveryPublicIds',
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

      if (randomBytesCallCount !== 1) return false; // worker-owned generation: once per INVOCATION, not once per callback attempt.
      if (getTransactionCallbackInvocationCount() !== 2) return false; // callback genuinely re-ran (simulated retry).
      if (result.outcome !== 'fanned-out') return false;

      const history = getAttemptWritesHistory();
      if (history.length !== 2) return false;
      const idFromAttempt = (attemptWrites: PendingWrite[]): string | undefined => {
        const create = attemptWrites.find((w) => w.type === 'create' && w.path === deliveryPath(reminderId, installationId));
        return create ? (create.data.deliveryPublicId as string) : undefined;
      };
      const idAttempt0 = idFromAttempt(history[0]);
      const idAttempt1 = idFromAttempt(history[1]);
      return typeof idAttempt0 === 'string' && idAttempt0.length > 0 && idAttempt0 === idAttempt1;
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
  check('reminderDeliveryWorker.ts never references OAuth token acquisition', !/oauth/i.test(codeOnly));
  check("reminderDeliveryWorker.ts never writes the literal delivery state 'sending'", !codeOnly.includes("'sending'"));
  check(
    "reminderDeliveryWorker.ts never writes the literal delivery states 'accepted-by-fcm'/'rejected-final'",
    !codeOnly.includes("'accepted-by-fcm'") && !codeOnly.includes("'rejected-final'")
  );
  check("reminderDeliveryWorker.ts never writes 'dry-run-validated' (final-authorization-only state)", !codeOnly.includes('dry-run-validated'));
  check('reminderDeliveryWorker.ts is not exported from index.ts', (() => {
    const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    return !indexSource.includes('reminderDeliveryWorker');
  })());
  check('reminderScheduler.ts is unmodified in substance: still contains no fanout/delivery references', (() => {
    const schedulerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'reminderScheduler.ts'), 'utf8');
    return !schedulerSource.includes('reminderDeliveryWorker') && !schedulerSource.includes('fanOutReminderDelivery');
  })());

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
    'no exported runtime function on the compiled module has arity suggesting a 4th (nonce) parameter',
    Object.entries(compiledWorkerModule).every(([name, value]) => {
      if (typeof value !== 'function') return true;
      // fanOutReminderDelivery: (db, reminderId, expectedAttemptCount) -> length 3.
      // acquireDeliveryProcessingLease: (db, ref) -> length 2. discoverRecoverableDeliveryWork:
      // (db) -> length 1. Every real exported function has arity <= 3; nothing takes 4 params.
      return value.length <= 3;
    })
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
    const RANDOMBYTES_ALLOWED_FILES = new Set(['reminderDeliveryWorker.ts', 'pushInstallations.ts', 'pushInstallationEpochLogic.ts']);
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
      'reminderDeliveryWorker.ts calls randomBytes( exactly once in its own CODE (comments stripped) — fanOutReminderDelivery only',
      (codeOnly.match(/randomBytes\(/g) || []).length === 1
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
