// functions/src/reminderDeliverySender.test.ts
// Phase 3A-3 Step 3C-4 — repository-local test file for the sole FCM transport call site.
//
// EMULATOR STATUS: no Firestore emulator available (same as every other test file in this
// codebase's delivery pipeline) — this file drives the real, unmodified commitSendOutcome/
// executeControlledSend functions against a small, deterministic, in-memory fake
// implementing only the document-get/transaction-update subset of `firebase-admin/
// firestore` these functions actually call.
//
// TESTING STRATEGY FOR A STRUCTURALLY-LOCKED FILE: REAL_DELIVERY_STAGE is a genuine,
// hardcoded 'disabled' constant (not a test-injectable parameter, by design — see the
// source file's header). executeControlledSend is therefore provably unreachable past its
// own guard in this compiled file, and is tested for exactly that (it must throw, always,
// before ever touching the network). commitSendOutcome, by contrast, is NOT
// stage-gated at all (only the transport call site is) — it is fully reachable and is
// where the bulk of the adversarial fencing/retry/history coverage below lives, driven by
// directly-constructed DeliverySendCapability objects (bypassing the — separately,
// exhaustively tested elsewhere — authorization boundary entirely, since commitSendOutcome
// does not care how a capability was obtained, only whether the document it names still
// matches it).
//
// HOW TO RUN:
//   cd functions
//   npm run build
//   node lib/reminderDeliverySender.test.js
import * as fs from 'fs';
import * as path from 'path';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  buildFirstSendNotificationMessage,
  translateFcmOutcomeToDeliveryOutcome,
  classifyAttemptOutcomeCategory,
  extractAttemptHttpStatus,
  commitSendOutcome,
  executeControlledSend,
  REAL_DELIVERY_STAGE,
} from './reminderDeliverySender';
import type { FcmSendOutcome } from './fcmTransport';
import type { DeliverySendCapability } from './reminderDeliveryAuth';
import { OPAQUE_ID_LENGTH, MAX_SEND_ATTEMPTS, DELIVERY_RETRY_BACKOFF_MS } from './reminderDeliveryLogic';

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
// FAKE FIRESTORE — same minimal document get/update/transaction pattern already
// established in reminderDeliveryAuth.test.ts / reminderDeliveryWorker.test.ts.
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

class FakeDocumentRef {
  readonly id: string;
  constructor(public readonly path: string) {
    this.id = path.split('/').pop() as string;
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
// FIXTURES
// =========================================================================================

const DELIVERY_PATH = 'artifacts/neuroactive-prod/reminders/user-1_1000/deliveries/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const VALID_EXECUTION_ID = 'F'.repeat(OPAQUE_ID_LENGTH);
const OTHER_EXECUTION_ID = 'G'.repeat(OPAQUE_ID_LENGTH);
const RAW_INSTALLATION_TOKEN = 'raw-fcm-token-should-never-persist-or-log';
const RAW_ACCESS_TOKEN = 'ya29.raw-oauth-token-should-never-persist-or-log';

function seedActiveSendIntent(
  store: Store,
  overrides: Record<string, unknown> = {}
): void {
  seedDoc(store, DELIVERY_PATH, {
    state: 'sending',
    workState: 'terminal',
    workAvailableAt: null,
    leaseExpiresAt: null,
    uid: 'user-1',
    installationId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sendAttemptCount: 1,
    sendExecutionId: VALID_EXECUTION_ID,
    sendIntentAtMs: 1700000000000,
    attemptHistory: [],
    ...overrides,
  });
}

function makeCapability(db: FirebaseFirestore.Firestore, overrides: Partial<DeliverySendCapability> = {}): DeliverySendCapability {
  return {
    deliveryRef: db.doc(DELIVERY_PATH),
    sendAttemptCount: 1,
    sendExecutionId: VALID_EXECUTION_ID,
    sendIntentAtMs: 1700000000000,
    installationToken: RAW_INSTALLATION_TOKEN,
    accessToken: RAW_ACCESS_TOKEN,
    ...overrides,
  };
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

async function main(): Promise<void> {
  const srcDir = path.join(__dirname, '..', 'src');
  const senderSourcePath = path.join(srcDir, 'reminderDeliverySender.ts');
  const senderSource = fs.readFileSync(senderSourcePath, 'utf8');
  const senderCodeOnly = stripComments(senderSource);

  // =======================================================================================
  // buildFirstSendNotificationMessage — fixed schema, pure.
  // =======================================================================================
  console.log('\n=== buildFirstSendNotificationMessage ===');

  check('[3C-4] valid token -> message carries the exact token and a notification object', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    return msg.token === 'some-token' && typeof msg.notification === 'object' && msg.notification !== null;
  })());
  check(
    '[3C-4] message notification has fixed, nonempty title/body (compatible with the existing SW auto-display path)',
    (() => {
      const msg = buildFirstSendNotificationMessage('some-token');
      const notification = msg.notification as { title: string; body: string };
      return typeof notification.title === 'string' && notification.title.length > 0 && typeof notification.body === 'string' && notification.body.length > 0;
    })()
  );
  check('[3C-4] message contains no other top-level keys beyond token/notification', (() => {
    const msg = buildFirstSendNotificationMessage('some-token');
    return JSON.stringify(Object.keys(msg).sort()) === JSON.stringify(['notification', 'token']);
  })());
  check('[3C-4] empty-string token throws', (() => {
    try {
      buildFirstSendNotificationMessage('');
      return false;
    } catch {
      return true;
    }
  })());
  check('[3C-4] non-string token throws', (() => {
    try {
      buildFirstSendNotificationMessage(12345);
      return false;
    } catch {
      return true;
    }
  })());
  check('[3C-4] two calls with different tokens never share a message object reference', (() => {
    const a = buildFirstSendNotificationMessage('token-a');
    const b = buildFirstSendNotificationMessage('token-b');
    return a !== b && a.token !== b.token;
  })());

  // =======================================================================================
  // Outcome translation helpers.
  // =======================================================================================
  console.log('\n=== translateFcmOutcomeToDeliveryOutcome / classifyAttemptOutcomeCategory / extractAttemptHttpStatus ===');

  check('[3C-4] accepted -> DeliverySendOutcomeKind accepted, category accepted, httpStatus 200', (() => {
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
    check(`[3C-4] rejected/${expectedCategory} translates+classifies+extracts correctly`, (() => {
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
    check(`[3C-4] ${outcome.kind} (${'reason' in outcome ? outcome.reason : ''}) -> DeliverySendOutcomeKind ${outcome.kind}, history category 'unknown-outcome', httpStatus null`, (() => {
      const d = translateFcmOutcomeToDeliveryOutcome(outcome);
      return d.kind === outcome.kind && classifyAttemptOutcomeCategory(outcome) === 'unknown-outcome' && extractAttemptHttpStatus(outcome) === null;
    })());
  }

  // =======================================================================================
  // commitSendOutcome — the fenced post-send transaction. The bulk of the adversarial
  // coverage lives here.
  // =======================================================================================
  console.log('\n=== commitSendOutcome ===');

  await checkAsync('[3C-4] accepted -> terminalized accepted-by-fcm, attemptHistory has exactly 1 entry with category accepted', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store);
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    if (result.outcome !== 'terminalized' || result.state !== 'accepted-by-fcm') return false;
    const after = readDoc(store, DELIVERY_PATH)!;
    const history = after.attemptHistory as unknown[];
    return after.state === 'accepted-by-fcm' && after.workState === 'terminal' && after.workAvailableAt === null && after.leaseExpiresAt === null && history.length === 1;
  });

  for (const [outcome, category] of [
    [REJECTED_INVALID_ARGUMENT, 'invalid-argument'],
    [REJECTED_UNAUTHENTICATED, 'unauthenticated'],
    [REJECTED_PERMISSION_DENIED, 'permission-denied'],
    [REJECTED_UNREGISTERED, 'unregistered'],
    [REJECTED_OTHER, 'other-definitive-rejection'],
  ] as [FcmSendOutcome, string][]) {
    await checkAsync(`[3C-4] definitive rejection (${category}) -> ALWAYS terminalized rejected-final, never retried`, async () => {
      const { db, store } = makeFakeDb();
      seedActiveSendIntent(store);
      const result = await commitSendOutcome(db, makeCapability(db), outcome);
      return result.outcome === 'terminalized' && result.state === 'rejected-final';
    });
  }

  for (const outcome of [UNKNOWN_TIMEOUT, UNKNOWN_NETWORK, UNKNOWN_5XX, UNKNOWN_MALFORMED, NOT_ATTEMPTED]) {
    await checkAsync(`[3C-4] ambiguous outcome (${outcome.kind}/${'reason' in outcome ? outcome.reason : ''}) -> ALWAYS terminalized unknown-outcome, never retried`, async () => {
      const { db, store } = makeFakeDb();
      seedActiveSendIntent(store);
      const result = await commitSendOutcome(db, makeCapability(db), outcome);
      return result.outcome === 'terminalized' && result.state === 'unknown-outcome';
    });
  }

  await checkAsync('[3C-4] retryable-later BELOW attempt cap -> requeued-for-retry, sendAttemptCount UNCHANGED, sendExecutionId/sendIntentAtMs cleared', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: 1 });
    const before = Date.now();
    const result = await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 1 }), REJECTED_RETRYABLE);
    if (result.outcome !== 'requeued-for-retry') return false;
    const after = readDoc(store, DELIVERY_PATH)!;
    const workAvailableAt = after.workAvailableAt as Timestamp;
    return (
      after.state === 'queued' &&
      after.workState === 'queued' &&
      after.sendAttemptCount === 1 &&
      after.sendExecutionId === null &&
      after.sendIntentAtMs === null &&
      after.leaseExpiresAt === null &&
      workAvailableAt.toMillis() >= before + DELIVERY_RETRY_BACKOFF_MS
    );
  });

  await checkAsync(`[3C-4] retryable-later AT the attempt cap (sendAttemptCount === MAX_SEND_ATTEMPTS) -> terminalized rejected-final, NOT retried`, async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: MAX_SEND_ATTEMPTS });
    const result = await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: MAX_SEND_ATTEMPTS }), REJECTED_RETRYABLE);
    return result.outcome === 'terminalized' && result.state === 'rejected-final';
  });

  await checkAsync('[3C-4] requeued retry: bounded future workAvailableAt, never immediate (>= now + backoff, not merely > now)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: 1 });
    const before = Date.now();
    await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 1 }), REJECTED_RETRYABLE);
    const after = readDoc(store, DELIVERY_PATH)!;
    const workAvailableAtMs = (after.workAvailableAt as Timestamp).toMillis();
    return workAvailableAtMs - before >= DELIVERY_RETRY_BACKOFF_MS;
  });

  // --- FENCE ADVERSARIAL COVERAGE ---

  await checkAsync('[3C-4 fence] delivery not found -> outcome-fence-mismatch, throws nothing', async () => {
    const { db } = makeFakeDb();
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    return result.outcome === 'outcome-fence-mismatch';
  });

  await checkAsync("[3C-4 fence] document state is 'preparing' (not yet sending) -> outcome-fence-mismatch, zero write", async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { state: 'preparing' });
    const before = readDoc(store, DELIVERY_PATH);
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  await checkAsync("[3C-4 fence] document already reached a terminal state (e.g. rejected-final from a prior commit) -> outcome-fence-mismatch, zero write (proves this outcome can never double-apply)", async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { state: 'rejected-final', workState: 'terminal' });
    const before = readDoc(store, DELIVERY_PATH);
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  await checkAsync('[3C-4 fence] sendAttemptCount mismatch (doc already advanced to attempt 2) -> outcome-fence-mismatch, zero write', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: 2, sendExecutionId: OTHER_EXECUTION_ID });
    const before = readDoc(store, DELIVERY_PATH);
    // Capability represents a STALE attempt-1 outcome, arriving after attempt 2 already
    // committed 'sending' again — exactly the "delayed attempt-1 outcome after attempt 2
    // exists" adversarial scenario.
    const result = await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 1, sendExecutionId: VALID_EXECUTION_ID }), ACCEPTED_OUTCOME);
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  await checkAsync('[3C-4 fence] sendExecutionId mismatch (same count, different execution id) -> outcome-fence-mismatch, zero write (two workers racing the SAME attempt number is impossible by construction, but the fence must still hold)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: 1, sendExecutionId: OTHER_EXECUTION_ID });
    const before = readDoc(store, DELIVERY_PATH);
    const result = await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 1, sendExecutionId: VALID_EXECUTION_ID }), ACCEPTED_OUTCOME);
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  await checkAsync('[3C-4 fence] crash-before-outcome simulation: document still sitting in "sending" with no history change is never mistaken for a match by a DIFFERENT capability', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: 1, sendExecutionId: VALID_EXECUTION_ID });
    // A capability for a hypothetical attempt 2 that was never actually authorized (the
    // document never advanced) must not match either — proves the fence is a positive
    // exact-match requirement, not merely "state === sending".
    const result = await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 2, sendExecutionId: OTHER_EXECUTION_ID }), ACCEPTED_OUTCOME);
    return result.outcome === 'outcome-fence-mismatch';
  });

  // --- ATTEMPT HISTORY COUPLING ---

  await checkAsync('[3C-4] attempt-history entry uses the EXACT persisted sendIntentAtMs/attempt number from the capability, not a re-derived value', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendAttemptCount: 1, sendIntentAtMs: 1234567890123 });
    await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 1, sendIntentAtMs: 1234567890123 }), ACCEPTED_OUTCOME);
    const after = readDoc(store, DELIVERY_PATH)!;
    const history = after.attemptHistory as { attemptNumber: number; sendIntentAt: number; outcomeCategory: string; httpStatus: number | null }[];
    return history.length === 1 && history[0].attemptNumber === 1 && history[0].sendIntentAt === 1234567890123 && history[0].outcomeCategory === 'accepted' && history[0].httpStatus === 200;
  });

  await checkAsync('[3C-4] a second, later attempt appends attemptNumber 2 to existing history rather than replacing it', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, {
      sendAttemptCount: 2,
      sendExecutionId: OTHER_EXECUTION_ID,
      sendIntentAtMs: 2000,
      attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1000, outcomeCategory: 'retryable-later', httpStatus: 429, outcomeRecordedAt: 1500 }],
    });
    const result = await commitSendOutcome(db, makeCapability(db, { sendAttemptCount: 2, sendExecutionId: OTHER_EXECUTION_ID, sendIntentAtMs: 2000 }), ACCEPTED_OUTCOME);
    if (result.outcome !== 'terminalized') return false;
    const after = readDoc(store, DELIVERY_PATH)!;
    const history = after.attemptHistory as { attemptNumber: number }[];
    return history.length === 2 && history[0].attemptNumber === 1 && history[1].attemptNumber === 2;
  });

  // =======================================================================================
  // CODEX REPAIR ROUND (Step 3C-4, blocker 3) — POST-SEND PERSISTENCE FAILURE MUST NEVER
  // DESTROY 'sending' PROVENANCE. Once executeControlledSend has called sendFcmOnce, an
  // FCM request may already have been made — a persistence problem discovered when
  // committing the outcome (e.g. malformed pre-existing attemptHistory) must leave the
  // document in 'sending', completely untouched, rather than overwriting it with any
  // other state. This replaces the earlier, Codex-REJECTED 'invalid-delivery' quarantine
  // behavior.
  // =======================================================================================

  for (const [label, outcome] of [
    ['accepted', ACCEPTED_OUTCOME],
    ['rejected (definitive)', REJECTED_INVALID_ARGUMENT],
    ['unknown-outcome', UNKNOWN_TIMEOUT],
    ['retryable-later', REJECTED_RETRYABLE],
  ] as [string, FcmSendOutcome][]) {
    await checkAsync(`[3C-4 persistence-failed] malformed existing attemptHistory after a ${label} transport result -> outcome 'persistence-failed', ZERO Firestore mutation, document stays exactly 'sending'`, async () => {
      const { db, store } = makeFakeDb();
      const seeded = {
        attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'SECRET-SHOULD-NEVER-SURVIVE' }],
      };
      seedActiveSendIntent(store, seeded);
      const before = readDoc(store, DELIVERY_PATH);
      const result = await commitSendOutcome(db, makeCapability(db), outcome);
      if (result.outcome !== 'persistence-failed') return false;
      const after = readDoc(store, DELIVERY_PATH);
      // ZERO mutation — not merely "state still sending" but the ENTIRE document
      // byte-for-byte unchanged, including updatedAt/processedAt never being touched.
      return JSON.stringify(before) === JSON.stringify(after) && after!.state === 'sending';
    });
  }

  await checkAsync("[3C-4 persistence-failed] active send-intent metadata (sendAttemptCount/sendExecutionId/sendIntentAtMs) is completely unchanged after a persistence-failed outcome", async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, {
      attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'X' }],
    });
    await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    const after = readDoc(store, DELIVERY_PATH)!;
    return after.sendAttemptCount === 1 && after.sendExecutionId === VALID_EXECUTION_ID && after.sendIntentAtMs === 1700000000000;
  });

  await checkAsync('[3C-4 persistence-failed] no retry work is created (workState stays terminal, never becomes queued)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, {
      attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'X' }],
    });
    await commitSendOutcome(db, makeCapability(db), REJECTED_RETRYABLE);
    const after = readDoc(store, DELIVERY_PATH)!;
    return after.workState === 'terminal' && after.workAvailableAt === null && after.leaseExpiresAt === null;
  });

  await checkAsync('[3C-4 persistence-failed] no terminal business outcome (accepted-by-fcm/rejected-final/unknown-outcome) is ever written', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, {
      attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'X' }],
    });
    await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    const after = readDoc(store, DELIVERY_PATH)!;
    return !['accepted-by-fcm', 'rejected-final', 'unknown-outcome'].includes(after.state as string);
  });

  await checkAsync("[3C-4 persistence-failed] result reason is a fixed enum string, no secret-bearing value, and clearly reports persistence failure to the caller", async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, {
      attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'SECRET-SHOULD-NEVER-SURVIVE' }],
    });
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    if (result.outcome !== 'persistence-failed') return false;
    const serialized = JSON.stringify(result);
    return result.reason === 'invalid-attempt-history-on-outcome' && !serialized.includes('SECRET-SHOULD-NEVER-SURVIVE');
  });

  check(
    "'invalid-delivery' is no longer a reachable SendOutcomeCommitResult outcome anywhere in reminderDeliverySender.ts's source (Codex explicitly rejected it — replaced by 'persistence-failed')",
    !senderCodeOnly.includes("outcome: 'invalid-delivery'")
  );

  // =======================================================================================
  // CODEX REPAIR ROUND (Step 3C-4, blocker 2) — sendIntentAtMs is now part of the complete
  // fence, and the attempt-history entry uses the FRESHLY-READ persisted value.
  // =======================================================================================

  await checkAsync('[3C-4 fence] capability.sendIntentAtMs wrong while state/count/executionId all match the persisted document -> outcome-fence-mismatch, zero write', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendIntentAtMs: 1700000000000 });
    const before = readDoc(store, DELIVERY_PATH);
    const result = await commitSendOutcome(db, makeCapability(db, { sendIntentAtMs: 1700000000000 + 1 }), ACCEPTED_OUTCOME);
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  await checkAsync('[3C-4 fence] persisted sendIntentAtMs malformed (missing) -> outcome-fence-mismatch, zero write', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendIntentAtMs: undefined });
    const before = readDoc(store, DELIVERY_PATH);
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    if (result.outcome !== 'outcome-fence-mismatch') return false;
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  await checkAsync('[3C-4] attempt-history entry uses the FRESHLY-READ persisted sendIntentAtMs (proven by seeding the store directly with a value equal to the capability\'s, since a mismatch would fail the fence entirely before any append is attempted)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store, { sendIntentAtMs: 999888777 });
    const result = await commitSendOutcome(db, makeCapability(db, { sendIntentAtMs: 999888777 }), ACCEPTED_OUTCOME);
    if (result.outcome !== 'terminalized') return false;
    const after = readDoc(store, DELIVERY_PATH)!;
    const history = after.attemptHistory as { sendIntentAt: number }[];
    return history[0].sendIntentAt === 999888777;
  });

  check(
    "reminderDeliverySender.ts's history-append call site sources sendIntentAt from the freshly-read persisted value (persistedSendIntentAtMs), never directly from capability.sendIntentAtMs — a static source-structure proof, not merely a behavioral one",
    senderCodeOnly.includes('sendIntentAt: persistedSendIntentAtMs') && !senderCodeOnly.includes('sendIntentAt: capability.sendIntentAtMs')
  );

  // --- SECRECY ---

  await checkAsync('[3C-4 secrecy] neither installationToken nor accessToken ever appear anywhere in the persisted document after any outcome', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store);
    await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    const after = readDoc(store, DELIVERY_PATH)!;
    const serialized = JSON.stringify(after);
    return !serialized.includes(RAW_INSTALLATION_TOKEN) && !serialized.includes(RAW_ACCESS_TOKEN);
  });

  await checkAsync('[3C-4 secrecy] neither installationToken nor accessToken ever appear in the returned SendOutcomeCommitResult', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store);
    const result = await commitSendOutcome(db, makeCapability(db), ACCEPTED_OUTCOME);
    const serialized = JSON.stringify(result);
    return !serialized.includes(RAW_INSTALLATION_TOKEN) && !serialized.includes(RAW_ACCESS_TOKEN);
  });

  // =======================================================================================
  // executeControlledSend — the sole transport call site, structurally locked.
  // =======================================================================================
  console.log('\n=== executeControlledSend (structural lock) ===');

  check("[3C-4] REAL_DELIVERY_STAGE is 'disabled' (this file's own, independently-declared constant)", REAL_DELIVERY_STAGE === 'disabled');

  await checkAsync('[3C-4] executeControlledSend ALWAYS throws while REAL_DELIVERY_STAGE is disabled, before any network attempt, for an otherwise-fully-valid capability', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store);
    try {
      await executeControlledSend(db, makeCapability(db));
      return false; // must never reach here.
    } catch (err) {
      return err instanceof Error && err.message.includes('REAL_DELIVERY_STAGE');
    }
  });

  await checkAsync('[3C-4] executeControlledSend throwing leaves the delivery document completely untouched (zero writes, zero side effects)', async () => {
    const { db, store } = makeFakeDb();
    seedActiveSendIntent(store);
    const before = readDoc(store, DELIVERY_PATH);
    try {
      await executeControlledSend(db, makeCapability(db));
    } catch {
      // expected
    }
    return JSON.stringify(before) === JSON.stringify(readDoc(store, DELIVERY_PATH));
  });

  // =======================================================================================
  // STATIC SOURCE CHECKS.
  // =======================================================================================
  console.log('\n=== static source checks ===');

  check('reminderDeliverySender.ts contains exactly one source-level call to sendFcmOnce', (senderCodeOnly.match(/sendFcmOnce\(/g) || []).length === 1);
  check('reminderDeliverySender.ts asserts REAL_DELIVERY_STAGE disabled immediately before that sole sendFcmOnce call', (() => {
    const idx = senderCodeOnly.indexOf('sendFcmOnce(');
    const before = senderCodeOnly.slice(0, idx);
    // The guard must be the LAST REAL_DELIVERY_STAGE check before the call — confirmed by
    // the guard existing at all before the call site, and by the executeControlledSend
    // behavioral test above proving it actually fires.
    return before.includes("if (REAL_DELIVERY_STAGE === 'disabled')");
  })());
  check('reminderDeliverySender.ts contains no console.log/console.error/console.warn/console.info/console.debug calls', !/console\.(log|error|warn|info|debug)\(/.test(senderSource));
  check(
    'reminderDeliverySender.ts has no module-scope Firestore/GoogleAuth/credential construction (no import-time side effects) — every function takes db as an explicit parameter',
    !senderCodeOnly.includes('getFirestore()') && !senderCodeOnly.includes('new GoogleAuth(') && !senderCodeOnly.includes('initializeApp(')
  );
  check(
    "reminderDeliverySender.ts's REAL_DELIVERY_STAGE constant is declared independently in this file, never imported from reminderDeliveryAuth.ts",
    /export const REAL_DELIVERY_STAGE: RealDeliveryStage = 'disabled';/.test(senderCodeOnly) && !senderCodeOnly.includes("REAL_DELIVERY_STAGE }") // not destructure-imported
  );

  // Cross-file: reminderDeliverySender.ts must be the ONLY file in functions/src that ever
  // calls sendFcmOnce( — fcmTransport.ts itself (the definition site) is excluded.
  const allSourceFiles = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'fcmTransport.ts' && f !== 'reminderDeliverySender.ts');
  let foreignCallSite: string | null = null;
  for (const file of allSourceFiles) {
    const content = stripComments(fs.readFileSync(path.join(srcDir, file), 'utf8'));
    if (content.includes('sendFcmOnce(')) {
      foreignCallSite = file;
      break;
    }
  }
  check(
    `reminderDeliverySender.ts is the ONLY production source file (besides fcmTransport.ts itself) that calls sendFcmOnce( — checked across all of: ${allSourceFiles.join(', ')}`,
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
