// functions/src/reminderDeliveryAuth.test.ts
// Phase 3A-3 Step 3C-3 — repository-local test file for the final-authorization security
// boundary in reminderDeliveryAuth.ts.
//
// EMULATOR STATUS: no Firestore emulator (and no Java runtime — `java -version` fails in
// this environment) is available. As with reminderDeliveryWorker.test.ts, this file drives
// the actual, unmodified orchestration functions against a small, deterministic, in-memory
// fake implementing only the document-get/transaction-update subset of `firebase-admin/
// firestore` this file's functions actually call — no query support is needed here at all
// (every read in reminderDeliveryAuth.ts is a direct document get).
//
// HOW TO RUN:
//   cd functions
//   npm run build
//   node lib/reminderDeliveryAuth.test.js
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import {
  finalizeDeliveryAuthorization,
  prepareAndFinalizeDelivery,
  acquireOAuthAccessToken,
  decideFinalAuthorizationRolloutDisposition,
  validateExperimentGateSchema,
  REAL_DELIVERY_STAGE,
  type AccessTokenProvider,
  type FinalAuthorizationResult,
} from './reminderDeliveryAuth';
import { OPAQUE_ID_LENGTH, MAX_SEND_ATTEMPTS } from './reminderDeliveryLogic';
import { buildReminderId } from './reminderSchedulerLogic';

// A well-formed OAuth token, used as the 4th `accessToken` argument every
// finalizeDeliveryAuthorization call site below now requires (Step 3C-4). Never asserted
// to appear in any persisted document except within the dedicated secrecy tests further
// down, which use their own distinct marker value instead.
const TEST_ACCESS_TOKEN = 'ya29.test-access-token-fixture-value';

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
// FAKE FIRESTORE — minimal: document get/update/set only, no queries. Real `FieldValue`/
// `Timestamp` values imported from the real package, never reimplemented.
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
  constructor(
    private readonly store: Store,
    public readonly path: string
  ) {}
  get parent(): FakeDocumentRef | null {
    const segs = this.path.split('/');
    segs.pop();
    if (segs.length === 0) return null;
    return new FakeDocumentRef(this.store, segs.join('/'));
  }
}

class FakeDocumentRef {
  readonly id: string;
  constructor(
    private readonly store: Store,
    public readonly path: string
  ) {
    this.id = path.split('/').pop() as string;
  }
  get parent(): FakeCollectionRef {
    const segs = this.path.split('/');
    segs.pop();
    return new FakeCollectionRef(this.store, segs.join('/'));
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
  constructor(private readonly store: Store, private readonly readPaths: string[]) {}
  async get(ref: FakeDocumentRef): Promise<FakeDocumentSnapshot> {
    this.readPaths.push(ref.path);
    return new FakeDocumentSnapshot(this.store, ref.path);
  }
  update(ref: FakeDocumentRef, data: Record<string, unknown>): void {
    if (!this.store.has(ref.path)) throw new Error(`FakeTransaction.update: document does not exist at ${ref.path}`);
    this.pendingWrites.push({ path: ref.path, data });
  }
}

// Step 3C-7 (Codex commit-semantics repair round) — commit-failure simulation. The callback
// result must NOT escape to the caller until a simulated atomic commit succeeds: on a
// simulated failure, the outer runTransaction promise REJECTS, none of the callback's
// staged writes ever reach the durable store, and the caller never sees the would-be
// result. `failWholeCommit` simulates the entire commit being rejected (e.g. a transient
// backend error) independent of which documents were touched; `failPaths` simulates one
// specific document's write being rejected within an otherwise-fine commit — Firestore's
// commit is all-or-nothing, so EITHER failure mode must still leave every pending write
// unapplied, never a partial subset. Both are checked (fail case) BEFORE any write is
// applied (success case), modeling atomicity rather than mid-loop partial application.
interface CommitControl {
  failWholeCommit: boolean;
  failPaths: Set<string>;
}

function makeFakeDb(): { db: FirebaseFirestore.Firestore; store: Store; commitControl: CommitControl; readPaths: string[] } {
  const store: Store = new Map();
  const commitControl: CommitControl = { failWholeCommit: false, failPaths: new Set() };
  const readPaths: string[] = [];
  const db = {
    doc(p: string) {
      return new FakeDocumentRef(store, p);
    },
    async runTransaction<T>(cb: (t: FakeTransaction) => Promise<T>): Promise<T> {
      const transaction = new FakeTransaction(store, readPaths);
      const result = await cb(transaction);
      if (commitControl.failWholeCommit) {
        throw new Error('SIMULATED_COMMIT_FAILURE: whole transaction commit rejected');
      }
      for (const write of transaction.pendingWrites) {
        if (commitControl.failPaths.has(write.path)) {
          throw new Error(`SIMULATED_COMMIT_FAILURE: write to ${write.path} rejected`);
        }
      }
      // All simulated-failure checks passed above (BEFORE any write below) — models
      // Firestore's atomic all-or-nothing commit: either every pending write applies, or
      // (via the throws above) none does.
      for (const write of transaction.pendingWrites) {
        const existing = store.get(write.path) ?? {};
        store.set(write.path, { ...existing, ...resolveFieldValues(write.data) });
      }
      return result;
    },
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, store, commitControl, readPaths };
}

function seedDoc(store: Store, docPath: string, data: Record<string, unknown>): void {
  store.set(docPath, resolveFieldValues(data));
}
function readDoc(store: Store, docPath: string): StoredDoc | undefined {
  const raw = store.get(docPath);
  return raw ? { ...raw } : undefined;
}
function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// =========================================================================================
// FIXTURES
// =========================================================================================

const APP_ID = 'neuroactive-prod';

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
function experimentGatePath(): string {
  return `artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`;
}

const RAW_TOKEN = 'raw-fcm-token-should-never-persist-or-log';
const VALID_FANOUT_EXECUTION_ID = 'D'.repeat(OPAQUE_ID_LENGTH);
const OTHER_FANOUT_EXECUTION_ID = 'E'.repeat(OPAQUE_ID_LENGTH);

type Fixture = { uid: string; reminderId: string; installationId: string; deliveryRef: unknown };

// Seeds a fully valid, happy-path-authorizable delivery scenario. Every scenario below
// starts from this and mutates exactly the field(s) under test.
function seedHappyPath(
  db: FirebaseFirestore.Firestore,
  store: Store,
  overrides: {
    reminder?: Record<string, unknown>;
    delivery?: Record<string, unknown>;
    preference?: Record<string, unknown> | null;
    rollout?: Record<string, unknown> | null;
    installation?: Record<string, unknown> | null;
    tokenClaim?: Record<string, unknown> | null;
    installationId?: string;
    token?: string;
    // Step 3C-7 — omitted (the default) means NO gate document is seeded at all, which is
    // the correct default for the overwhelming majority of scenarios below that never reach
    // the real-send continuation (dry-run/paused/non-allowlisted all return or cancel before
    // the gate is ever read) and is also exactly the fixture the dedicated
    // 'experiment-gate-missing' test needs. Pass `{}` to seed a valid ARMED gate matching
    // this fixture's own uid/reminderId/installationId exactly; pass a partial object to
    // override specific fields on top of that valid-armed base (e.g. to build a malformed,
    // consumed, or identity-mismatched gate for the dedicated gate tests below).
    experimentGate?: Record<string, unknown>;
  } = {}
): Fixture {
  const uid = 'user-1';
  const reminderId = `${uid}_1000`;
  const scheduledForMs = 1000;
  const installationId = overrides.installationId ?? hex32(1);
  const token = overrides.token ?? RAW_TOKEN;
  const tokenHash = sha256Hex(token);

  seedDoc(store, reminderPath(reminderId), {
    uid,
    status: 'delivery-fanned-out',
    deliveryFanoutState: 'completed',
    targetInstallationCountAtFanout: 1,
    excludedMalformedInstallationCount: 0,
    fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
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

  if (overrides.delivery !== null) {
    // CODEX REPAIR ROUND (test-isolation fix) — a single captured timestamp, not two
    // independent Date.now() calls. Production (classifyDeliveryWorkTuple) requires
    // workAvailableAt === leaseExpiresAt EXACTLY for a 'preparing' record (same instant by
    // construction); two separate Date.now() calls can occasionally straddle a clock tick
    // and produce two off-by-one-millisecond values, making the fixture itself malformed
    // and failing an unrelated assertion before the real test logic is ever reached.
    const leaseTimestampMs = Date.now() + 5 * 60 * 1000;
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'preparing',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(leaseTimestampMs),
      leaseExpiresAt: Timestamp.fromMillis(leaseTimestampMs),
      uid,
      installationId,
      deliveryPublicId: 'A'.repeat(43),
      fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID,
      sendAttemptCount: 0,
      processingAttemptCount: 1,
      attemptHistory: [],
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
      ...overrides.delivery,
    });
  }

  if (overrides.preference !== null) {
    seedDoc(store, prefPath(uid), {
      enabled: true,
      revision: 1,
      scheduleType: 'daily',
      weekdays: [0, 1, 2, 3, 4, 5, 6],
      localTime: '07:00',
      timezone: 'UTC',
      ...overrides.preference,
    });
  }

  if (overrides.rollout !== null) {
    seedDoc(store, rolloutPath(), { mode: 'dry-run', ...overrides.rollout });
  }

  if (overrides.installation !== null) {
    seedDoc(store, installationPath(installationId), {
      uid,
      state: 'active',
      epochSchemaVersion: 1,
      tokenVersion: 1,
      installationAudienceId: 'A'.repeat(16),
      generation: 1,
      token,
      ...overrides.installation,
    });
  }

  if (overrides.tokenClaim !== null) {
    seedDoc(store, tokenClaimPath(tokenHash), { installationId, uid, ...overrides.tokenClaim });
  }

  if (overrides.experimentGate !== undefined) {
    seedDoc(store, experimentGatePath(), {
      state: 'armed',
      expectedUid: uid,
      expectedReminderId: reminderId,
      expectedScheduledForMs: scheduledForMs,
      expectedInstallationId: installationId,
      createdAt: Timestamp.now(),
      consumedAt: null,
      consumedByExecutionId: null,
      ...overrides.experimentGate,
    });
  }

  return { uid, reminderId, installationId, deliveryRef: db.doc(deliveryPath(reminderId, installationId)) };
}

async function runHappyPath(overrides: Parameters<typeof seedHappyPath>[2] = {}): Promise<FinalAuthorizationResult> {
  const { db, store } = makeFakeDb();
  const fixture = seedHappyPath(db, store, overrides);
  return finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
}

async function main(): Promise<void> {
  // =======================================================================================
  // SECTION 33 — FINAL AUTHORIZATION
  // =======================================================================================

  check('source-level lock: REAL_DELIVERY_STAGE is "general" (general-real-send expansion)', REAL_DELIVERY_STAGE === 'general');

  await checkAsync('happy dry-run -> dry-run-validated', async () => {
    const result = await runHappyPath();
    return result.outcome === 'dry-run-validated';
  });

  await checkAsync('stale processing fence (processingAttemptCount mismatch) -> stale-fence, no write', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { delivery: { processingAttemptCount: 2 } });
    const before = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    if (result.outcome !== 'stale-fence' || result.reason !== 'stale-processing-fence') return false;
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    return JSON.stringify(before) === JSON.stringify(after);
  });

  await checkAsync('delivery not in preparing state -> stale-fence', async () => {
    const result = await runHappyPath({ delivery: { state: 'queued' } });
    return result.outcome === 'stale-fence';
  });

  await checkAsync('parent missing -> cancelled parent-invalid', async () => {
    const { db, store } = makeFakeDb();
    const uid = 'user-1';
    const reminderId = `${uid}_missing`;
    const installationId = hex32(2);
    // Same single-captured-timestamp fix as seedHappyPath above (Codex test-isolation repair round).
    const leaseTimestampMs = Date.now() + 5 * 60 * 1000;
    seedDoc(store, deliveryPath(reminderId, installationId), {
      state: 'preparing',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(leaseTimestampMs),
      leaseExpiresAt: Timestamp.fromMillis(leaseTimestampMs),
      uid,
      installationId,
      deliveryPublicId: 'A'.repeat(43),
      fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID,
      sendAttemptCount: 0,
      processingAttemptCount: 1,
      attemptHistory: [],
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const finalResult = await finalizeDeliveryAuthorization(db, db.doc(deliveryPath(reminderId, installationId)), 1, TEST_ACCESS_TOKEN);
    return finalResult.outcome === 'cancelled' && finalResult.reason === 'parent-invalid';
  });

  await checkAsync('parent failed fanout tuple (installation-count-exceeds-cap) -> cancelled parent-fanout-not-completed', async () => {
    const result = await runHappyPath({
      reminder: {
        deliveryFanoutState: 'failed',
        targetingFailureReason: 'installation-count-exceeds-cap',
        targetInstallationCountAtFanout: null,
        observedTargetCountAtLeast: 11,
      },
    });
    return result.outcome === 'cancelled' && result.reason === 'parent-fanout-not-completed';
  });

  await checkAsync('uid mismatch between parent and delivery -> cancelled parent-invalid', async () => {
    const result = await runHappyPath({ reminder: { uid: 'someone-else' } });
    return result.outcome === 'cancelled' && result.reason === 'parent-invalid';
  });

  await checkAsync('preference missing -> cancelled preference-missing', async () => {
    const result = await runHappyPath({ preference: null });
    return result.outcome === 'cancelled' && result.reason === 'preference-missing';
  });

  await checkAsync('preference disabled -> cancelled preference-disabled', async () => {
    const result = await runHappyPath({ preference: { enabled: false } });
    return result.outcome === 'cancelled' && result.reason === 'preference-disabled';
  });

  await checkAsync('preference revision changed -> cancelled preference-changed', async () => {
    const result = await runHappyPath({ preference: { revision: 2 } });
    return result.outcome === 'cancelled' && result.reason === 'preference-changed';
  });

  await checkAsync('rollout missing -> cancelled rollout-paused (fails closed)', async () => {
    const result = await runHappyPath({ rollout: null });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync('rollout malformed -> cancelled rollout-paused (fails closed)', async () => {
    const result = await runHappyPath({ rollout: { mode: 'not-a-real-mode' } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync('rollout explicitly paused -> cancelled rollout-paused', async () => {
    const result = await runHappyPath({ rollout: { mode: 'paused' } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync('rollout dry-run -> proceeds (already covered by happy path, re-asserted explicitly)', async () => {
    const result = await runHappyPath({ rollout: { mode: 'dry-run' } });
    return result.outcome === 'dry-run-validated';
  });

  // =======================================================================================
  // STEP 3C-5 — REAL_DELIVERY_STAGE advanced to 'allowlisted-only'. This is the FIRST round
  // where 'allowlisted-real-send' + an allowlisted uid is genuinely reachable — a real
  // DeliverySendCapability, with the real installation token and OAuth token, is actually
  // constructed and returned. Every other combination must still fail closed.
  // =======================================================================================

  await checkAsync(
    "[3C-5] rollout allowlisted-real-send, uid ON the allowlist -> sending-authorized, with a well-formed one-shot capability",
    async () => {
      const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
      if (result.outcome !== 'sending-authorized') return false;
      const cap = result.capability;
      return (
        cap.sendAttemptCount === 1 &&
        typeof cap.sendExecutionId === 'string' &&
        cap.sendExecutionId.length === OPAQUE_ID_LENGTH &&
        typeof cap.sendIntentAtMs === 'number' &&
        cap.installationToken === RAW_TOKEN &&
        cap.accessToken === TEST_ACCESS_TOKEN
      );
    }
  );

  await checkAsync(
    "[3C-5] rollout allowlisted-real-send, uid NOT on the allowlist -> cancelled (reason 'rollout-real-send-not-allowlisted', not stage-disabled — the stage now permits this mode, only allowlist membership blocks it)",
    async () => {
      const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] } });
      return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-not-allowlisted';
    }
  );

  await checkAsync("[3C-5] rollout allowlisted-real-send, EMPTY allowlist -> cancelled 'rollout-real-send-not-allowlisted'", async () => {
    const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: [] } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-not-allowlisted';
  });

  await checkAsync(
    "[3C-5] rollout allowlisted-real-send, MALFORMED allowlist member -> whole config fails closed to 'paused' semantics (reason 'rollout-paused', per parseRolloutConfig's established contract — a single bad member invalidates the whole allowlist, never silently drops it)",
    async () => {
      const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1', 12345] } });
      return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
    }
  );

  await checkAsync("[3C-5] rollout allowlisted-real-send, DUPLICATE uid entries, one matching -> still authorized (parser does not dedupe, membership check is a plain .includes())", async () => {
    const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1', 'user-1', 'someone-else'] }, experimentGate: {} });
    return result.outcome === 'sending-authorized';
  });

  await checkAsync(
    '[3C-5] rollout allowlisted-real-send with an extra, unrecognized rollout document field -> still authorized (parseRolloutConfig only ever reads mode/allowlistUids; unknown fields are silently ignored, matching its existing, established contract — not a new behavior introduced this round)',
    async () => {
      const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'], unexpectedField: 'ignored-value' }, experimentGate: {} });
      return result.outcome === 'sending-authorized';
    }
  );

  await checkAsync('[controlled-beta] exact allowlisted config authorizes recurring send with NO gate document read or write', async () => {
    const { db, store, readPaths } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'controlled-beta', allowlistUids: ['user-1'] } });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return (
      result.outcome === 'sending-authorized' &&
      !readPaths.includes(experimentGatePath()) &&
      readDoc(store, experimentGatePath()) === undefined &&
      readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!.state === 'sending'
    );
  });

  await checkAsync('[controlled-beta] even a present consumed experiment gate is neither read nor mutated', async () => {
    const { db, store, readPaths } = makeFakeDb();
    const fixture = seedHappyPath(db, store, {
      rollout: { mode: 'controlled-beta', allowlistUids: ['user-1'] },
      experimentGate: { state: 'consumed', consumedAt: Timestamp.now(), consumedByExecutionId: 'Z'.repeat(OPAQUE_ID_LENGTH) },
    });
    const before = readDoc(store, experimentGatePath());
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'sending-authorized' && !readPaths.includes(experimentGatePath()) && JSON.stringify(readDoc(store, experimentGatePath())) === JSON.stringify(before);
  });

  await checkAsync('[controlled-beta] UID removed before final authorization -> cancelled, zero send intent', async () => {
    const result = await runHappyPath({ rollout: { mode: 'controlled-beta', allowlistUids: ['someone-else'] } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-not-allowlisted';
  });

  await checkAsync('[controlled-beta] rollout paused before final authorization -> cancelled, zero send intent', async () => {
    const result = await runHappyPath({ rollout: { mode: 'paused' } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync('[controlled-beta] extra rollout field fails closed to paused', async () => {
    const result = await runHappyPath({ rollout: { mode: 'controlled-beta', allowlistUids: ['user-1'], unexpected: true } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync(
    '[general-real-send expansion] rollout general-real-send -> sending-authorized for a fully eligible installation, at the current "general" stage, with no allowlist requirement',
    async () => {
      const result = await runHappyPath({ rollout: { mode: 'general-real-send' } });
      return result.outcome === 'sending-authorized';
    }
  );

  await checkAsync(
    "[Codex repair] malformed general-real-send (extra field) -> cancelled rollout-paused, never sending-authorized, zero send intent",
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, { rollout: { mode: 'general-real-send', extra: true } });
      const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
      return (
        result.outcome === 'cancelled' &&
        result.reason === 'rollout-paused' &&
        after.state === 'cancelled' &&
        !Object.prototype.hasOwnProperty.call(after, 'sendExecutionId')
      );
    }
  );

  await checkAsync(
    "[Codex repair] malformed general-real-send (allowlistUids attached, exploit shape reported by Codex) -> cancelled rollout-paused, never sending-authorized, zero send intent",
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, { rollout: { mode: 'general-real-send', allowlistUids: ['some-other-uid'] } });
      const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
      return (
        result.outcome === 'cancelled' &&
        result.reason === 'rollout-paused' &&
        after.state === 'cancelled' &&
        !Object.prototype.hasOwnProperty.call(after, 'sendExecutionId')
      );
    }
  );

  await checkAsync('[general-real-send expansion] rollout paused before final authorization -> cancelled, zero send intent (proves the transactional re-read: fanout-time state is never trusted at finalization)', async () => {
    const result = await runHappyPath({ rollout: { mode: 'paused' } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync("[3C-5] rollout paused under allowlisted-only stage -> still cancelled rollout-paused (stage change does not affect the paused/dry-run branches at all)", async () => {
    const result = await runHappyPath({ rollout: { mode: 'paused' } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused';
  });

  await checkAsync("[3C-5] rollout dry-run under allowlisted-only stage -> still proceeds to dry-run-validated, never to sending-authorized", async () => {
    const result = await runHappyPath({ rollout: { mode: 'dry-run' } });
    return result.outcome === 'dry-run-validated';
  });

  await checkAsync('[general-real-send expansion] general-real-send authorized write: exact atomic shape, no experiment gate document seeded or touched', async () => {
    const { db, store, readPaths } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'general-real-send' } });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return (
      result.outcome === 'sending-authorized' &&
      after.state === 'sending' &&
      after.workState === 'terminal' &&
      after.sendAttemptCount === 1 &&
      typeof after.sendExecutionId === 'string' &&
      typeof after.sendIntentAtMs === 'number' &&
      !readPaths.includes(experimentGatePath()) &&
      readDoc(store, experimentGatePath()) === undefined
    );
  });

  await checkAsync(
    "[3C-5] sending-authorized write: exact atomic shape (state='sending', workState='terminal', sendAttemptCount=1, sendExecutionId/sendIntentAtMs present, neither installationToken nor accessToken ever persisted)",
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
      const serialized = JSON.stringify(after);
      return (
        after.state === 'sending' &&
        after.workState === 'terminal' &&
        after.workAvailableAt === null &&
        after.leaseExpiresAt === null &&
        after.sendAttemptCount === 1 &&
        typeof after.sendExecutionId === 'string' &&
        typeof after.sendIntentAtMs === 'number' &&
        !serialized.includes(RAW_TOKEN) &&
        !serialized.includes(TEST_ACCESS_TOKEN)
      );
    }
  );

  await checkAsync(
    '[3C-5] sending-authorized outcome: neither installationToken nor accessToken appear in the returned result when serialized carelessly by a hypothetical logging call (capability fields are only ever consumed by the immediate caller, never logged by this file itself — see the static no-console check below)',
    async () => {
      const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
      if (result.outcome !== 'sending-authorized') return false;
      // This assertion documents that the CAPABILITY OBJECT ITSELF necessarily contains the
      // secrets (by design — that's its whole purpose) — the safety property is that
      // reminderDeliveryAuth.ts itself never logs/persists it, verified separately by the
      // static checks below and by reminderDeliveryWorker.ts's own sanitization tests.
      return result.capability.installationToken === RAW_TOKEN && result.capability.accessToken === TEST_ACCESS_TOKEN;
    }
  );

  await checkAsync('installation missing -> cancelled installation-missing', async () => {
    const result = await runHappyPath({ installation: null });
    return result.outcome === 'cancelled' && result.reason === 'installation-missing';
  });

  await checkAsync('installation revoked (state != active) -> cancelled installation-revoked', async () => {
    const result = await runHappyPath({ installation: { state: 'revoked' } });
    return result.outcome === 'cancelled' && result.reason === 'installation-revoked';
  });

  await checkAsync('installation generation changed -> cancelled installation-generation-changed', async () => {
    const result = await runHappyPath({ installation: { generation: 2 } });
    return result.outcome === 'cancelled' && result.reason === 'installation-generation-changed';
  });

  await checkAsync('installation tokenVersion changed -> cancelled installation-token-version-changed', async () => {
    const result = await runHappyPath({ installation: { tokenVersion: 2 } });
    return result.outcome === 'cancelled' && result.reason === 'installation-token-version-changed';
  });

  await checkAsync('installation audienceId changed -> cancelled installation-audience-changed', async () => {
    const result = await runHappyPath({ installation: { installationAudienceId: 'B'.repeat(16) } });
    return result.outcome === 'cancelled' && result.reason === 'installation-audience-changed';
  });

  await checkAsync('installation epoch invalid (malformed epochSchemaVersion) -> cancelled installation-epoch-invalid', async () => {
    const result = await runHappyPath({ installation: { epochSchemaVersion: 999 } });
    return result.outcome === 'cancelled' && result.reason === 'installation-epoch-invalid';
  });

  await checkAsync('installation raw token missing -> cancelled installation-token-missing', async () => {
    const result = await runHappyPath({ installation: { token: '' } });
    return result.outcome === 'cancelled' && result.reason === 'installation-token-missing';
  });

  await checkAsync('token claim missing -> cancelled token-claim-missing', async () => {
    const result = await runHappyPath({ tokenClaim: null });
    return result.outcome === 'cancelled' && result.reason === 'token-claim-missing';
  });

  await checkAsync('token claim installation mismatch -> cancelled token-claim-mismatch', async () => {
    const result = await runHappyPath({ tokenClaim: { installationId: hex32(999) } });
    return result.outcome === 'cancelled' && result.reason === 'token-claim-mismatch';
  });

  await checkAsync('token claim uid mismatch -> cancelled token-claim-mismatch', async () => {
    const result = await runHappyPath({ tokenClaim: { uid: 'someone-else' } });
    return result.outcome === 'cancelled' && result.reason === 'token-claim-mismatch';
  });

  await checkAsync('OAuth acquisition failure (via prepareAndFinalizeDelivery) -> oauth-preparation-failed, zero Firestore writes', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    const before = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const failingProvider: AccessTokenProvider = async () => {
      throw new Error('synthetic OAuth failure');
    };
    const result = await prepareAndFinalizeDelivery(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, failingProvider);
    if (result.outcome !== 'oauth-preparation-failed') return false;
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    return JSON.stringify(before) === JSON.stringify(after);
  });

  await checkAsync('OAuth acquisition returns empty token -> classified as failure, zero writes', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    const emptyProvider: AccessTokenProvider = async () => '';
    const result = await prepareAndFinalizeDelivery(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, emptyProvider);
    return result.outcome === 'oauth-preparation-failed';
  });

  await checkAsync(
    'OAuth succeeds but fence becomes stale before the transaction runs -> stale-fence, not dry-run-validated',
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store);
      // Simulate another worker reacquiring (bumping processingAttemptCount) DURING the
      // window OAuth acquisition occupies, by mutating the store directly between OAuth
      // "succeeding" and the transaction actually running.
      const succeedingProvider: AccessTokenProvider = async () => {
        const path = deliveryPath(fixture.reminderId, fixture.installationId);
        const existing = readDoc(store, path)!;
        store.set(path, { ...existing, processingAttemptCount: 2 });
        return 'fake-oauth-token-value';
      };
      const result = await prepareAndFinalizeDelivery(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, succeedingProvider);
      return result.outcome === 'stale-fence';
    }
  );

  await checkAsync('successful dry-run writes exact terminal state fields', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return (
      after.state === 'dry-run-validated' &&
      after.workState === 'terminal' &&
      after.workAvailableAt === null &&
      after.leaseExpiresAt === null
    );
  });

  await checkAsync('sendAttemptCount unchanged after successful dry-run', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { delivery: { sendAttemptCount: 0 } });
    await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return after.sendAttemptCount === 0;
  });

  await checkAsync('no raw token persisted anywhere on the delivery document after dry-run success', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return !JSON.stringify(after).includes(RAW_TOKEN);
  });

  await checkAsync('no OAuth token persisted anywhere on the delivery document after dry-run success', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    const oauthValue = 'ya29.fake-oauth-bearer-token-value-should-never-persist';
    const provider: AccessTokenProvider = async () => oauthValue;
    await prepareAndFinalizeDelivery(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, provider);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return !JSON.stringify(after).includes(oauthValue);
  });

  await checkAsync('cancellation writes carry only a fixed reason enum, never a raw field value', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { installation: { generation: 12345 } });
    await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return after.cancelReason === 'installation-generation-changed' && !JSON.stringify(after).includes('12345');
  });

  await checkAsync('delivery not found -> delivery-not-found, no crash', async () => {
    const { db } = makeFakeDb();
    const result = await finalizeDeliveryAuthorization(db, db.doc(deliveryPath('nonexistent_1', hex32(5))), 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'delivery-not-found';
  });

  await checkAsync('malformed expectedProcessingAttemptCount fails closed to stale-fence before any Firestore access', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    const before = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 'not-a-number' as unknown, TEST_ACCESS_TOKEN);
    if (result.outcome !== 'stale-fence') return false;
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    return JSON.stringify(before) === JSON.stringify(after);
  });

  check('decideFinalAuthorizationRolloutDisposition: paused -> cancel rollout-paused', (() => {
    const d = decideFinalAuthorizationRolloutDisposition({ mode: 'paused' }, 'user-1');
    return d.decision === 'cancel' && d.reason === 'rollout-paused';
  })());
  check(
    'decideFinalAuthorizationRolloutDisposition: dry-run -> proceed-dry-run',
    decideFinalAuthorizationRolloutDisposition({ mode: 'dry-run' }, 'user-1').decision === 'proceed-dry-run'
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: malformed input -> cancel rollout-paused (fail closed)',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition('garbage', 'user-1');
      return d.decision === 'cancel' && d.reason === 'rollout-paused';
    })()
  );
  // Step 3C-5: with this file's REAL_DELIVERY_STAGE now 'allowlisted-only',
  // 'allowlisted-real-send' for an allowlisted uid is genuinely reachable through this
  // exported function; 'general-real-send' remains unconditionally not-permitted-at-stage.
  // The 'disabled'/'general' stage behaviors themselves remain exhaustively covered
  // directly against decideStagedRealSendAuthorization in reminderDeliveryLogic.test.ts,
  // which is NOT hardcoded to any one stage.
  check(
    'decideFinalAuthorizationRolloutDisposition: allowlisted-real-send, uid on allowlist -> proceed-real-send',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, 'user-1');
      return d.decision === 'proceed-real-send';
    })()
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: allowlisted-real-send, uid NOT on allowlist -> cancel rollout-real-send-not-allowlisted',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] }, 'user-1');
      return d.decision === 'cancel' && d.reason === 'rollout-real-send-not-allowlisted';
    })()
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: general-real-send -> proceed-real-send, with the experiment gate NOT required (general-real-send is independent of the legacy one-shot gate, exactly like controlled-beta)',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'general-real-send' }, 'user-1');
      return d.decision === 'proceed-real-send' && d.experimentGateRequired === false;
    })()
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: general-real-send with malformed uid -> cancel rollout-real-send-invalid-uid (decideRealSendAuthorization validates uid BEFORE consulting rollout mode at all — confirmed by direct inspection, not assumed)',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'general-real-send' }, { not: 'a string' });
      return d.decision === 'cancel' && d.reason === 'rollout-real-send-invalid-uid';
    })()
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: allowlisted-real-send with malformed uid -> cancel rollout-real-send-invalid-uid',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, { not: 'a string' });
      return d.decision === 'cancel' && d.reason === 'rollout-real-send-invalid-uid';
    })()
  );

  await checkAsync('acquireOAuthAccessToken: throwing provider classifies as failed without reading error properties', async () => {
    const result = await acquireOAuthAccessToken(async () => {
      throw new Error('SHOULD-NEVER-APPEAR-IN-RESULT');
    });
    return result.outcome === 'failed' && result.reason === 'oauth-preparation-failed' && !JSON.stringify(result).includes('SHOULD-NEVER-APPEAR');
  });
  await checkAsync('[3C-4] acquireOAuthAccessToken: succeeding provider classifies as succeeded AND now returns the token itself (Step 3C-4 — previously always discarded)', async () => {
    const result = await acquireOAuthAccessToken(async () => 'ya29.some-fake-token');
    return result.outcome === 'succeeded' && result.accessToken === 'ya29.some-fake-token';
  });

  await checkAsync('acquireOAuthAccessToken: whitespace-only token classifies as failed (Codex repair round, L2)', async () => {
    const result = await acquireOAuthAccessToken(async () => '   \t  ');
    return result.outcome === 'failed' && result.reason === 'oauth-preparation-failed';
  });
  await checkAsync('prepareAndFinalizeDelivery: whitespace-only OAuth token -> oauth-preparation-failed, zero Firestore writes, no transaction begins', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    const before = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const whitespaceProvider: AccessTokenProvider = async () => '\n\t ';
    const result = await prepareAndFinalizeDelivery(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, whitespaceProvider);
    if (result.outcome !== 'oauth-preparation-failed') return false;
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    return JSON.stringify(before) === JSON.stringify(after);
  });

  // =======================================================================================
  // H1 REPAIR ROUND — fanout provenance (immutable parent/child fanoutExecutionId).
  // =======================================================================================

  await checkAsync('[H1] matching provenance (delivery.fanoutExecutionIdAtCreation === parent.fanoutExecutionId) -> normal dry-run success', async () => {
    const result = await runHappyPath();
    return result.outcome === 'dry-run-validated';
  });

  await checkAsync(
    '[H1 admin-injection attack] injected child beneath a valid completed-fanout parent, with fully valid EVERYTHING except mismatched fanoutExecutionIdAtCreation (B instead of A) -> NEVER dry-run-validated, fails closed to cancelled',
    async () => {
      const result = await runHappyPath({
        reminder: { fanoutExecutionId: VALID_FANOUT_EXECUTION_ID },
        delivery: { fanoutExecutionIdAtCreation: OTHER_FANOUT_EXECUTION_ID },
      });
      return result.outcome === 'cancelled' && result.reason === 'fanout-provenance-mismatch';
    }
  );

  await checkAsync(
    '[H1 admin-injection attack] injected child with ABSENT fanoutExecutionIdAtCreation -> never dry-run-validated (fails the complete-delivery-schema check first, as invalid-delivery)',
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store);
      const path = deliveryPath(fixture.reminderId, fixture.installationId);
      const existing = readDoc(store, path)!;
      delete (existing as Record<string, unknown>).fanoutExecutionIdAtCreation;
      store.set(path, existing);
      const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      return result.outcome === 'invalid-delivery' && result.reason === 'invalid-fanout-execution-id-format';
    }
  );

  await checkAsync(
    '[H1] malformed-FORMAT fanoutExecutionIdAtCreation on the child -> invalid-delivery (schema corruption, not a provenance-membership question)',
    async () => {
      const result = await runHappyPath({ delivery: { fanoutExecutionIdAtCreation: 'not-a-valid-opaque-id' } });
      return result.outcome === 'invalid-delivery' && result.reason === 'invalid-fanout-execution-id-format';
    }
  );

  await checkAsync('[H1] parent fanoutExecutionId absent on an otherwise-completed tuple -> parent-fanout-not-completed (validateFanoutTuple itself rejects it)', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store);
    const path = reminderPath(fixture.reminderId);
    const existing = readDoc(store, path)!;
    delete (existing as Record<string, unknown>).fanoutExecutionId;
    store.set(path, existing);
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'cancelled' && result.reason === 'parent-fanout-not-completed';
  });

  // =======================================================================================
  // H2 REPAIR ROUND — complete final-time delivery revalidation (post-acquisition
  // corruption). Every scenario below simulates a delivery that would have passed
  // acquisition-time validation, then got corrupted (or its lease genuinely expired) during
  // the real wall-clock window OAuth acquisition occupies, and proves final authorization
  // independently re-validates from scratch rather than trusting acquisition-time state.
  // =======================================================================================

  await checkAsync('[H2] ref.id / stored installationId mismatch after acquisition -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { installationId: hex32(9999) } });
    return result.outcome === 'invalid-delivery' && result.reason === 'ref-installation-id-mismatch';
  });

  for (const badPublicId of ['', 'A'.repeat(OPAQUE_ID_LENGTH - 1), 'A'.repeat(OPAQUE_ID_LENGTH + 1), '!'.repeat(OPAQUE_ID_LENGTH), 12345 as unknown as string]) {
    await checkAsync(`[H2] malformed deliveryPublicId after acquisition (${JSON.stringify(badPublicId)}) -> invalid-delivery`, async () => {
      const result = await runHappyPath({ delivery: { deliveryPublicId: badPublicId } });
      return result.outcome === 'invalid-delivery' && result.reason === 'invalid-delivery-public-id-format';
    });
  }

  await checkAsync('[H2] poisoned attemptHistory after acquisition (nonsequential) -> invalid-delivery', async () => {
    const result = await runHappyPath({
      delivery: { attemptHistory: [{ attemptNumber: 2, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2 }] },
    });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-attempt-history';
  });
  await checkAsync('[H2] poisoned attemptHistory after acquisition (extra secret-bearing field) -> invalid-delivery', async () => {
    const result = await runHappyPath({
      delivery: {
        attemptHistory: [
          { attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'accepted', httpStatus: 200, outcomeRecordedAt: 2, rawToken: 'SECRET-SHOULD-NEVER-SURVIVE' },
        ],
      },
    });
    if (result.outcome !== 'invalid-delivery' || result.reason !== 'invalid-attempt-history') return false;
    return !JSON.stringify(result).includes('SECRET-SHOULD-NEVER-SURVIVE');
  });
  await checkAsync('[H2] poisoned attemptHistory after acquisition (invalid outcomeCategory) -> invalid-delivery', async () => {
    const result = await runHappyPath({
      delivery: { attemptHistory: [{ attemptNumber: 1, sendIntentAt: 1, outcomeCategory: 'not-a-real-category', httpStatus: 200, outcomeRecordedAt: 2 }] },
    });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-attempt-history';
  });
  await checkAsync('[H2] a 4th attemptHistory entry (exceeds MAX_SEND_ATTEMPTS) after acquisition -> invalid-delivery', async () => {
    const mkEntry = (n: number) => ({ attemptNumber: n, sendIntentAt: n, outcomeCategory: 'retryable-later', httpStatus: 500, outcomeRecordedAt: n });
    const result = await runHappyPath({ delivery: { attemptHistory: [mkEntry(1), mkEntry(2), mkEntry(3), mkEntry(4)] } });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-attempt-history';
  });

  await checkAsync('[H2] malformed targetSnapshot after acquisition (generation malformed) -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { targetSnapshot: { generation: 0, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) } } });
    return result.outcome === 'invalid-delivery';
  });
  await checkAsync('[H2] malformed targetSnapshot after acquisition (tokenVersion malformed) -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { targetSnapshot: { generation: 1, tokenVersion: 0, installationAudienceId: 'A'.repeat(16) } } });
    return result.outcome === 'invalid-delivery';
  });
  await checkAsync('[H2] malformed targetSnapshot after acquisition (audience grammar too short) -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'short' } } });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-target-snapshot-audience-id';
  });

  await checkAsync('[H2] malformed processingAttemptCount after acquisition (negative) -> stale-fence (fence comparison itself never matches a malformed value)', async () => {
    const result = await runHappyPath({ delivery: { processingAttemptCount: -1 } });
    return result.outcome === 'stale-fence';
  });
  await checkAsync('[H2] malformed sendAttemptCount after acquisition (exceeds MAX_SEND_ATTEMPTS) -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { sendAttemptCount: 4 } });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-send-attempt-count';
  });

  await checkAsync('[H2] malformed preparing work tuple (workState inconsistent) -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { workState: 'terminal' } });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-preparing-work-tuple';
  });
  await checkAsync('[H2] malformed preparing work tuple (leaseExpiresAt missing while workAvailableAt present) -> invalid-delivery', async () => {
    const result = await runHappyPath({ delivery: { leaseExpiresAt: null } });
    return result.outcome === 'invalid-delivery' && result.reason === 'invalid-preparing-work-tuple';
  });

  await checkAsync('[H2] lease genuinely expired before final auth (tuple consistent, but recoverableNow) -> stale-fence, NOT invalid-delivery, NOT dry-run-validated', async () => {
    const pastMs = Date.now() - 1000;
    const result = await runHappyPath({
      delivery: { workAvailableAt: Timestamp.fromMillis(pastMs), leaseExpiresAt: Timestamp.fromMillis(pastMs) },
    });
    return result.outcome === 'stale-fence' && result.reason === 'stale-processing-fence';
  });

  await checkAsync(
    '[H2] invalid-delivery write sets invalidDeliveryReason to a fixed enum string, never embedding the raw corrupted value (the pre-existing malformed field itself is left as-is, matching this codebase\'s established quarantine convention — only the REASON must never echo raw data)',
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, { delivery: { deliveryPublicId: 'RAW-CORRUPTED-VALUE-SHOULD-NEVER-SURVIVE-999999' } });
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
      return (
        after.state === 'invalid-delivery' &&
        after.workState === 'terminal' &&
        after.invalidDeliveryReason === 'invalid-delivery-public-id-format' &&
        !String(after.invalidDeliveryReason).includes('RAW-CORRUPTED-VALUE')
      );
    }
  );

  // =======================================================================================
  // SECTION 34 — NO SEND (static + behavioral)
  // =======================================================================================

  const authSourcePath = path.join(__dirname, '..', 'src', 'reminderDeliveryAuth.ts');
  const authSource = fs.readFileSync(authSourcePath, 'utf8');
  const codeOnly = stripComments(authSource);

  check('reminderDeliveryAuth.ts never imports from ./fcmTransport', !codeOnly.includes('fcmTransport'));
  check('reminderDeliveryAuth.ts never calls sendFcmOnce', !codeOnly.includes('sendFcmOnce'));
  check('reminderDeliveryAuth.ts never calls getMessaging(', !codeOnly.includes('getMessaging('));
  check("reminderDeliveryAuth.ts never imports 'firebase-admin/messaging'", !codeOnly.includes('firebase-admin/messaging'));
  check("reminderDeliveryAuth.ts never imports 'node:https'", !codeOnly.includes('node:https'));
  check('reminderDeliveryAuth.ts never calls fetch(', !codeOnly.includes('fetch('));
  check('reminderDeliveryAuth.ts never references globalThis.fetch', !codeOnly.includes('globalThis.fetch'));
  // Step 3C-4: this file now DOES write 'sending' (the intent-commit branch) but must
  // still never reference either send-OUTCOME terminal state — those are
  // reminderDeliverySender.ts's exclusive responsibility, reached only after an actual
  // transport attempt this file never makes.
  check("reminderDeliveryAuth.ts never references 'accepted-by-fcm'/'rejected-final' (send-outcome states)", !codeOnly.includes("'accepted-by-fcm'") && !codeOnly.includes("'rejected-final'"));
  check('reminderDeliveryAuth.ts contains no console.log/console.error/console.warn calls', !/console\.(log|error|warn|info|debug)\(/.test(authSource));
  check(
    "reminderDeliveryAuth.ts contains exactly one production writable transition each to 'dry-run-validated', 'cancelled', and (Step 3C-4) 'sending'",
    (codeOnly.match(/state: 'dry-run-validated'/g) || []).length === 1 &&
      (codeOnly.match(/state: 'cancelled'/g) || []).length === 1 &&
      (codeOnly.match(/requireAllowedDeliveryTransition\('preparing', 'sending'\)/g) || []).length === 1
  );
  check(
    "reminderDeliveryAuth.ts's OAuth scope is the real FCM HTTP v1 scope, not a broader one",
    codeOnly.includes("'https://www.googleapis.com/auth/firebase.messaging'")
  );
  check(
    'reminderDeliveryAuth.ts contains exactly three invalid-delivery quarantine write call sites (schema corruption + preparing-work-tuple corruption + Step 3C-4 send-attempt-count-exhausted), all via buildDeliveryQuarantineUpdate — no other path writes invalid-delivery',
    (codeOnly.match(/\.\.\.buildDeliveryQuarantineUpdate\(/g) || []).length === 3
  );
  check(
    "reminderDeliveryAuth.ts's H1 provenance equality check compares fanoutExecutionIdAtCreation to the parent's own fanoutExecutionId via strict !== (exact equality required, not a weaker comparison)",
    codeOnly.includes('fanoutExecutionIdAtCreation !== fanoutTupleValidation.outcome.fanoutExecutionId')
  );
  check(
    "[Step 3C-7 / A27] reminderDeliveryAuth.ts contains exactly ONE transaction.update call site targeting the experiment gate, and it writes state: 'consumed' — no production code path ever re-arms the gate back to 'armed'",
    (codeOnly.match(/transaction\.update\(experimentGateRef\(db\)/g) || []).length === 1 &&
      /transaction\.update\(experimentGateRef\(db\),\s*\{\s*state:\s*'consumed'/.test(codeOnly)
  );
  check(
    '[Step 3C-7 / A27] reminderDeliveryWorker.ts and reminderDeliverySender.ts never reference the experiment gate at all (neither the literal path segment nor an "experimentGateRef"-shaped helper) — only reminderDeliveryAuth.ts ever touches this document',
    (() => {
      const workerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'reminderDeliveryWorker.ts'), 'utf8');
      const senderSourceForGateCheck = fs.readFileSync(path.join(__dirname, '..', 'src', 'reminderDeliverySender.ts'), 'utf8');
      return (
        !workerSource.includes('firstRealSendExperimentGate') &&
        !workerSource.includes('experimentGateRef') &&
        !senderSourceForGateCheck.includes('firstRealSendExperimentGate') &&
        !senderSourceForGateCheck.includes('experimentGateRef')
      );
    })()
  );

  // =======================================================================================
  // STEP 3C-4/3C-5 — STAGED REAL-SEND LOCK, SENDING-INTENT COMMIT, AND SECRET HANDOFF.
  // =======================================================================================

  check(
    'reminderDeliveryAuth.ts no longer contains the "must not advance to general" tripwire (removed deliberately this round — general-real-send is now the reviewed, armed stage; a stale leftover tripwire here would throw on every real-send-authorizing call)',
    !codeOnly.includes("if (REAL_DELIVERY_STAGE === 'general')") && !codeOnly.includes('must not advance to "general"')
  );
  check(
    'reminderDeliveryAuth.ts exports REAL_DELIVERY_STAGE with the literal value "general" (source-text check, independent of the runtime check above)',
    /export const REAL_DELIVERY_STAGE: RealDeliveryStage = 'general';/.test(codeOnly)
  );
  check(
    "reminderDeliveryAuth.ts no longer contains the old, now-incorrect 'disabled'-only guard condition",
    !codeOnly.includes("if (REAL_DELIVERY_STAGE !== 'disabled')")
  );
  check(
    'reminderDeliveryAuth.ts consults decideStagedRealSendAuthorization (layer B) inside decideFinalAuthorizationRolloutDisposition, never bypassing it for a real-send rollout mode',
    codeOnly.includes('decideStagedRealSendAuthorization(REAL_DELIVERY_STAGE')
  );
  check(
    'reminderDeliveryAuth.ts generates sendExecutionId via randomBytes(OPAQUE_ID_BYTE_LENGTH) exactly once, outside db.runTransaction (mirrors fanoutExecutionId precedent)',
    (codeOnly.match(/randomBytes\(OPAQUE_ID_BYTE_LENGTH\)/g) || []).length === 1 && !/db\.runTransaction\([\s\S]*randomBytes/.test(codeOnly)
  );
  check(
    'reminderDeliveryAuth.ts exports no function accepting a caller-supplied sendExecutionId (finalizeDeliveryAuthorizationInner is not exported)',
    !codeOnly.includes('export function finalizeDeliveryAuthorizationInner') && !codeOnly.includes('export async function finalizeDeliveryAuthorizationInner')
  );
  check(
    'reminderDeliveryAuth.ts commits sendAttemptCount/sendExecutionId/sendIntentAtMs atomically with the sending state (single buildDeliverySendingIntentFields spread, single transaction.update call)',
    codeOnly.includes('...buildDeliverySendingIntentFields(sendExecutionId, sendAttemptCountAfterThisIntent, sendIntentAtMs)')
  );
  check(
    'reminderDeliveryAuth.ts never increments sendAttemptCount by more than 1 in a single write (uses "+ 1" exactly once against completeValidation.sendAttemptCount)',
    (codeOnly.match(/completeValidation\.sendAttemptCount \+ 1/g) || []).length === 1
  );

  await checkAsync(
    '[3C-5] canAuthorizeNewSendIntent guard: sendAttemptCount already at MAX_SEND_ATTEMPTS on an authorized allowlisted-real-send branch -> invalid-delivery (send-attempt-count-exhausted), never sending-authorized. Now genuinely BEHAVIORALLY reachable and tested end-to-end, not merely statically, since the stage advance makes this branch real.',
    async () => {
      const result = await runHappyPath({
        rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] },
        delivery: { sendAttemptCount: MAX_SEND_ATTEMPTS },
        experimentGate: {},
      });
      return result.outcome === 'invalid-delivery' && result.reason === 'send-attempt-count-exhausted';
    }
  );
  await checkAsync(
    '[3C-5] send-attempt-count-exhausted quarantine write carries the fixed reason only, never persists a raw sendAttemptCount-adjacent value beyond the pre-existing field itself',
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, {
        rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] },
        delivery: { sendAttemptCount: MAX_SEND_ATTEMPTS },
        experimentGate: {},
      });
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
      return after.state === 'invalid-delivery' && after.invalidDeliveryReason === 'send-attempt-count-exhausted';
    }
  );

  // =======================================================================================
  // SECTION 35 — EXPERIMENT-WIDE ONE-SHOT GATE (PHASE 3A-3 STEP 3C-7)
  // =======================================================================================
  console.log('\n=== experiment gate: pure validator (validateExperimentGateSchema) ===');

  const GATE_VALID_UID = 'user-1';
  const GATE_VALID_SCHEDULED_MS = 1_700_000_000_000;
  const GATE_VALID_REMINDER_ID = buildReminderId(GATE_VALID_UID, GATE_VALID_SCHEDULED_MS);
  const GATE_VALID_INSTALLATION_ID = hex32(7);
  const GATE_VALID_EXECUTION_ID = 'K'.repeat(OPAQUE_ID_LENGTH);

  function validArmedGateFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      state: 'armed',
      expectedUid: GATE_VALID_UID,
      expectedReminderId: GATE_VALID_REMINDER_ID,
      expectedScheduledForMs: GATE_VALID_SCHEDULED_MS,
      expectedInstallationId: GATE_VALID_INSTALLATION_ID,
      createdAt: Timestamp.now(),
      consumedAt: null,
      consumedByExecutionId: null,
      ...overrides,
    };
  }
  function validConsumedGateFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const createdAt = Timestamp.now();
    return {
      state: 'consumed',
      expectedUid: GATE_VALID_UID,
      expectedReminderId: GATE_VALID_REMINDER_ID,
      expectedScheduledForMs: GATE_VALID_SCHEDULED_MS,
      expectedInstallationId: GATE_VALID_INSTALLATION_ID,
      createdAt,
      consumedAt: Timestamp.fromMillis(createdAt.toMillis() + 1000),
      consumedByExecutionId: GATE_VALID_EXECUTION_ID,
      ...overrides,
    };
  }

  check('[gate validator] exact valid armed gate -> valid', validateExperimentGateSchema(validArmedGateFields()).valid === true);
  check('[gate validator] exact valid consumed gate -> valid', validateExperimentGateSchema(validConsumedGateFields()).valid === true);

  for (const key of [
    'state',
    'expectedUid',
    'expectedReminderId',
    'expectedScheduledForMs',
    'expectedInstallationId',
    'createdAt',
    'consumedAt',
    'consumedByExecutionId',
  ]) {
    const fields = validArmedGateFields();
    delete fields[key];
    check(`[gate validator] armed gate missing required key '${key}' -> invalid`, validateExperimentGateSchema(fields).valid === false);
  }

  check('[gate validator] extra unknown key -> invalid', validateExperimentGateSchema(validArmedGateFields({ extraField: 'x' })).valid === false);
  check('[gate validator] unrecognized state value -> invalid', validateExperimentGateSchema(validArmedGateFields({ state: 'not-a-real-state' })).valid === false);

  check('[gate validator] expectedUid null -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedUid: null })).valid === false);
  check('[gate validator] expectedUid number -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedUid: 12345 })).valid === false);
  check('[gate validator] expectedUid malformed (contains "/") -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedUid: 'user/1' })).valid === false);

  check('[gate validator] expectedReminderId null -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedReminderId: null })).valid === false);
  check('[gate validator] expectedReminderId number -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedReminderId: 12345 })).valid === false);
  check('[gate validator] expectedReminderId malformed (contains "/") -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedReminderId: 'bad/id' })).valid === false);
  check(
    '[gate validator] expectedReminderId valid SHAPE but does not equal buildReminderId(expectedUid, expectedScheduledForMs) -> invalid (structural binding, not three independent strings)',
    validateExperimentGateSchema(validArmedGateFields({ expectedReminderId: `${GATE_VALID_UID}_999999` })).valid === false
  );

  check('[gate validator] expectedScheduledForMs null -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: null })).valid === false);
  check(
    '[gate validator] expectedScheduledForMs string -> invalid',
    validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: String(GATE_VALID_SCHEDULED_MS) })).valid === false
  );
  check('[gate validator] expectedScheduledForMs NaN -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: NaN })).valid === false);
  check('[gate validator] expectedScheduledForMs Infinity -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: Infinity })).valid === false);
  check(
    '[gate validator] expectedScheduledForMs fractional -> invalid',
    validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: GATE_VALID_SCHEDULED_MS + 0.5 })).valid === false
  );
  check('[gate validator] expectedScheduledForMs negative -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: -1 })).valid === false);
  check(
    '[gate validator] expectedScheduledForMs unsafe integer -> invalid',
    validateExperimentGateSchema(validArmedGateFields({ expectedScheduledForMs: Number.MAX_SAFE_INTEGER + 2 })).valid === false
  );

  check('[gate validator] expectedInstallationId null -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedInstallationId: null })).valid === false);
  check('[gate validator] expectedInstallationId number -> invalid', validateExperimentGateSchema(validArmedGateFields({ expectedInstallationId: 12345 })).valid === false);
  check(
    '[gate validator] expectedInstallationId malformed (not UUIDv4/hex32) -> invalid',
    validateExperimentGateSchema(validArmedGateFields({ expectedInstallationId: 'not-a-valid-installation-id' })).valid === false
  );

  check('[gate validator] createdAt null -> invalid', validateExperimentGateSchema(validArmedGateFields({ createdAt: null })).valid === false);
  check('[gate validator] createdAt number -> invalid', validateExperimentGateSchema(validArmedGateFields({ createdAt: Date.now() })).valid === false);
  check('[gate validator] createdAt string -> invalid', validateExperimentGateSchema(validArmedGateFields({ createdAt: new Date().toISOString() })).valid === false);

  check('[gate validator] armed with non-null consumedAt -> invalid', validateExperimentGateSchema(validArmedGateFields({ consumedAt: Timestamp.now() })).valid === false);
  check(
    '[gate validator] armed with non-null consumedByExecutionId -> invalid',
    validateExperimentGateSchema(validArmedGateFields({ consumedByExecutionId: GATE_VALID_EXECUTION_ID })).valid === false
  );

  check('[gate validator] consumed with null consumedAt -> invalid', validateExperimentGateSchema(validConsumedGateFields({ consumedAt: null })).valid === false);
  check(
    '[gate validator] consumed with wrong-type consumedAt (number) -> invalid',
    validateExperimentGateSchema(validConsumedGateFields({ consumedAt: Date.now() })).valid === false
  );
  check(
    '[gate validator] consumed with null consumedByExecutionId -> invalid',
    validateExperimentGateSchema(validConsumedGateFields({ consumedByExecutionId: null })).valid === false
  );
  check(
    '[gate validator] consumed with wrong-type consumedByExecutionId (number) -> invalid',
    validateExperimentGateSchema(validConsumedGateFields({ consumedByExecutionId: 12345 })).valid === false
  );
  check(
    '[gate validator] consumed with malformed consumedByExecutionId (wrong length/charset) -> invalid',
    validateExperimentGateSchema(validConsumedGateFields({ consumedByExecutionId: 'too-short' })).valid === false
  );
  check(
    '[gate validator] consumed with consumedAt earlier than createdAt -> invalid',
    (() => {
      const createdAt = Timestamp.now();
      return validateExperimentGateSchema(validConsumedGateFields({ createdAt, consumedAt: Timestamp.fromMillis(createdAt.toMillis() - 1000) })).valid === false;
    })()
  );

  // =======================================================================================
  // COMMIT-SEMANTICS (Codex commit-failure repair round) — the fake transaction harness now
  // supports simulating a rejected commit; the callback's would-be result must never escape
  // to the caller unless the (simulated) commit actually succeeds.
  // =======================================================================================
  console.log('\n=== experiment gate: fake-transaction commit semantics ===');

  await checkAsync('[commit] normal successful commit -> capability returned, delivery sending, gate consumed', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    if (result.outcome !== 'sending-authorized') return false;
    return readDoc(store, experimentGatePath())!.state === 'consumed';
  });

  await checkAsync('[commit] whole-commit simulated failure -> outer promise rejects, delivery unchanged, gate unchanged, no capability', async () => {
    const { db, store, commitControl } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const beforeDelivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const beforeGate = readDoc(store, experimentGatePath());
    commitControl.failWholeCommit = true;
    try {
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      return false; // must have thrown
    } catch {
      const afterDelivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
      const afterGate = readDoc(store, experimentGatePath());
      return JSON.stringify(beforeDelivery) === JSON.stringify(afterDelivery) && JSON.stringify(beforeGate) === JSON.stringify(afterGate);
    }
  });

  await checkAsync('[commit] gate-update simulated failure -> whole transaction rejects, delivery unchanged, gate unchanged, no capability', async () => {
    const { db, store, commitControl } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const beforeDelivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const beforeGate = readDoc(store, experimentGatePath());
    commitControl.failPaths.add(experimentGatePath());
    try {
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      return false;
    } catch {
      const afterDelivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
      const afterGate = readDoc(store, experimentGatePath());
      return JSON.stringify(beforeDelivery) === JSON.stringify(afterDelivery) && JSON.stringify(beforeGate) === JSON.stringify(afterGate);
    }
  });

  await checkAsync('[commit] delivery-update simulated failure -> whole transaction rejects, delivery unchanged, gate unchanged, no capability', async () => {
    const { db, store, commitControl } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const beforeDelivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
    const beforeGate = readDoc(store, experimentGatePath());
    commitControl.failPaths.add(deliveryPath(fixture.reminderId, fixture.installationId));
    try {
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      return false;
    } catch {
      const afterDelivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId));
      const afterGate = readDoc(store, experimentGatePath());
      return JSON.stringify(beforeDelivery) === JSON.stringify(afterDelivery) && JSON.stringify(beforeGate) === JSON.stringify(afterGate);
    }
  });

  // =======================================================================================
  // AUTHORIZATION INTEGRATION (A1-A29 per the approved Step 3C-7 matrix; A30's faithful
  // concurrent-race proof is emulator-only — see reminderDeliveryAuth.emulatorSuite.ts).
  // =======================================================================================
  console.log('\n=== experiment gate: authorization integration ===');

  await checkAsync('[A1] matching armed gate -> sending-authorized, delivery sending, gate consumed, capability yes', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    if (result.outcome !== 'sending-authorized') return false;
    const delivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    const gate = readDoc(store, experimentGatePath())!;
    return delivery.state === 'sending' && gate.state === 'consumed';
  });

  await checkAsync('[A2] audit binding: gate.consumedByExecutionId === delivery.sendExecutionId', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const delivery = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    const gate = readDoc(store, experimentGatePath())!;
    return typeof delivery.sendExecutionId === 'string' && gate.consumedByExecutionId === delivery.sendExecutionId;
  });

  await checkAsync('[A3] missing gate -> cancelled experiment-gate-missing, no capability', async () => {
    const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] } });
    return result.outcome === 'cancelled' && result.reason === 'experiment-gate-missing';
  });

  await checkAsync('[A4] malformed gate (extra key) -> cancelled experiment-gate-malformed', async () => {
    const result = await runHappyPath({
      rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] },
      experimentGate: { extraField: 'unexpected' },
    });
    return result.outcome === 'cancelled' && result.reason === 'experiment-gate-malformed';
  });

  await checkAsync('[A5] already-consumed gate -> cancelled experiment-gate-consumed', async () => {
    // Codex-reproduced intermittent fixture defect: seedHappyPath's own base `createdAt:
    // Timestamp.now()` (inside the function) and a caller-supplied `consumedAt:
    // Timestamp.now()` (evaluated earlier, when THIS object literal is constructed, before
    // seedHappyPath ever runs) are two independent wall-clock reads. Crossing a millisecond
    // boundary between them could make consumedAt < createdAt — an ordering production code
    // correctly refuses to treat as a valid already-consumed gate, causing this fixture to
    // occasionally seed a MALFORMED gate instead of the CONSUMED one this test intends.
    // Fixed here exactly like the established, already-proven-safe pattern elsewhere in this
    // file: capture createdAt once, derive consumedAt from it with a fixed positive offset —
    // deterministic regardless of real-world timing, no sleep/retry needed.
    const createdAt = Timestamp.now();
    const result = await runHappyPath({
      rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] },
      experimentGate: {
        state: 'consumed',
        createdAt,
        consumedAt: Timestamp.fromMillis(createdAt.toMillis() + 1000),
        consumedByExecutionId: 'Z'.repeat(OPAQUE_ID_LENGTH),
      },
    });
    return result.outcome === 'cancelled' && result.reason === 'experiment-gate-consumed';
  });

  await checkAsync(
    "[A6] TEST-ONLY gate-level wrong-UID fixture: rollout allowlist deliberately contains BOTH the gate's expected uid ('user-2') and the candidate's real uid ('user-1'), so the candidate legitimately clears the rollout stage and genuinely reaches the gate check -> experiment-gate-identity-mismatch, gate remains armed, no capability. This two-uid allowlist shape is a TEST FIXTURE ONLY, never a real production configuration.",
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, {
        rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-2', 'user-1'] },
        experimentGate: { expectedUid: 'user-2', expectedReminderId: buildReminderId('user-2', 1000) },
      });
      const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      if (result.outcome !== 'cancelled' || result.reason !== 'experiment-gate-identity-mismatch') return false;
      return readDoc(store, experimentGatePath())!.state === 'armed';
    }
  );

  await checkAsync('[A7] wrong reminderId on an otherwise self-consistent gate -> experiment-gate-identity-mismatch', async () => {
    const result = await runHappyPath({
      rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] },
      experimentGate: { expectedReminderId: buildReminderId('user-1', 9999), expectedScheduledForMs: 9999 },
    });
    return result.outcome === 'cancelled' && result.reason === 'experiment-gate-identity-mismatch';
  });

  await checkAsync('[A8] wrong installationId on an otherwise self-consistent gate -> experiment-gate-identity-mismatch', async () => {
    const result = await runHappyPath({
      rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] },
      experimentGate: { expectedInstallationId: hex32(999) },
    });
    return result.outcome === 'cancelled' && result.reason === 'experiment-gate-identity-mismatch';
  });

  await checkAsync('[A9] whole commit failure on the real-send path -> gate unchanged, no capability', async () => {
    const { db, store, commitControl } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const beforeGate = readDoc(store, experimentGatePath());
    commitControl.failWholeCommit = true;
    try {
      await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      return false;
    } catch {
      return JSON.stringify(readDoc(store, experimentGatePath())) === JSON.stringify(beforeGate);
    }
  });

  await checkAsync(
    '[A12/A13/A16/A29] first authorization succeeds and consumes the gate; every later, independent re-authorization attempt against the SAME delivery (a re-lease after a retryable outcome, a fresh process, or simply a later call) is denied by the consumed gate -> experiment-gate-consumed, never a second sending-authorized, never a second capability, tried twice more for good measure',
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
      const firstResult = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      if (firstResult.outcome !== 'sending-authorized') return false;

      const path = deliveryPath(fixture.reminderId, fixture.installationId);
      const releaseBackToPreparing = (processingAttemptCount: number) => {
        const existing = readDoc(store, path)!;
        const leaseMs = Date.now() + 5 * 60 * 1000;
        seedDoc(store, path, {
          ...existing,
          state: 'preparing',
          workState: 'queued',
          workAvailableAt: Timestamp.fromMillis(leaseMs),
          leaseExpiresAt: Timestamp.fromMillis(leaseMs),
          processingAttemptCount,
        });
      };

      releaseBackToPreparing(2);
      const secondResult = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 2, TEST_ACCESS_TOKEN);
      if (secondResult.outcome !== 'cancelled' || secondResult.reason !== 'experiment-gate-consumed') return false;

      releaseBackToPreparing(3);
      const thirdResult = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 3, TEST_ACCESS_TOKEN);
      return thirdResult.outcome === 'cancelled' && thirdResult.reason === 'experiment-gate-consumed';
    }
  );

  await checkAsync('[A14] a later reminder occurrence for the same uid/installation, after the gate is already consumed -> experiment-gate-consumed, no sending intent', async () => {
    const { db, store } = makeFakeDb();
    const first = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const firstResult = await finalizeDeliveryAuthorization(db, first.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    if (firstResult.outcome !== 'sending-authorized') return false;

    const laterReminderId = buildReminderId('user-1', 5000);
    const leaseMs = Date.now() + 5 * 60 * 1000;
    seedDoc(store, reminderPath(laterReminderId), {
      uid: 'user-1',
      status: 'delivery-fanned-out',
      deliveryFanoutState: 'completed',
      targetInstallationCountAtFanout: 1,
      excludedMalformedInstallationCount: 0,
      fanoutExecutionId: VALID_FANOUT_EXECUTION_ID,
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
    seedDoc(store, deliveryPath(laterReminderId, first.installationId), {
      state: 'preparing',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(leaseMs),
      leaseExpiresAt: Timestamp.fromMillis(leaseMs),
      uid: 'user-1',
      installationId: first.installationId,
      deliveryPublicId: 'B'.repeat(OPAQUE_ID_LENGTH),
      fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID,
      sendAttemptCount: 0,
      processingAttemptCount: 1,
      attemptHistory: [],
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
    });
    const secondResult = await finalizeDeliveryAuthorization(db, db.doc(deliveryPath(laterReminderId, first.installationId)), 1, TEST_ACCESS_TOKEN);
    return secondResult.outcome === 'cancelled' && secondResult.reason === 'experiment-gate-consumed';
  });

  await checkAsync('[A15] a second installation for the same uid, after the gate is already consumed by the first installation -> denied, no sending intent', async () => {
    const { db, store } = makeFakeDb();
    const first = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
    const firstResult = await finalizeDeliveryAuthorization(db, first.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    if (firstResult.outcome !== 'sending-authorized') return false;

    const secondInstallationId = hex32(2);
    const leaseMs = Date.now() + 5 * 60 * 1000;
    seedDoc(store, deliveryPath(first.reminderId, secondInstallationId), {
      state: 'preparing',
      workState: 'queued',
      workAvailableAt: Timestamp.fromMillis(leaseMs),
      leaseExpiresAt: Timestamp.fromMillis(leaseMs),
      uid: 'user-1',
      installationId: secondInstallationId,
      deliveryPublicId: 'C'.repeat(OPAQUE_ID_LENGTH),
      fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID,
      sendAttemptCount: 0,
      processingAttemptCount: 1,
      attemptHistory: [],
      targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'B'.repeat(16) },
    });
    seedDoc(store, installationPath(secondInstallationId), {
      uid: 'user-1',
      state: 'active',
      epochSchemaVersion: 1,
      tokenVersion: 1,
      installationAudienceId: 'B'.repeat(16),
      generation: 1,
      token: 'second-installation-raw-token',
    });
    seedDoc(store, tokenClaimPath(sha256Hex('second-installation-raw-token')), { installationId: secondInstallationId, uid: 'user-1' });

    const secondResult = await finalizeDeliveryAuthorization(db, db.doc(deliveryPath(first.reminderId, secondInstallationId)), 1, TEST_ACCESS_TOKEN);
    return secondResult.outcome === 'cancelled' && (secondResult.reason === 'experiment-gate-consumed' || secondResult.reason === 'experiment-gate-identity-mismatch');
  });

  await checkAsync('[A17] dry-run rollout -> gate never read (none seeded; outcome is still dry-run-validated, not experiment-gate-missing) -> gate document remains absent throughout', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'dry-run' } });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'dry-run-validated' && readDoc(store, experimentGatePath()) === undefined;
  });

  await checkAsync('[A18] paused rollout -> gate never read (none seeded; outcome is rollout-paused, not experiment-gate-missing)', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'paused' } });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'cancelled' && result.reason === 'rollout-paused' && readDoc(store, experimentGatePath()) === undefined;
  });

  await checkAsync('[general-real-send expansion] general-real-send at the current "general" stage -> authorized, gate never read (none seeded; sending-authorized does not require experiment-gate-missing)', async () => {
    const { db, store, readPaths } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'general-real-send' } });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'sending-authorized' && !readPaths.includes(experimentGatePath()) && readDoc(store, experimentGatePath()) === undefined;
  });

  await checkAsync('[A20] non-allowlisted uid under allowlisted-real-send -> gate never read (none seeded; outcome is rollout-real-send-not-allowlisted, not experiment-gate-missing)', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] } });
    const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-not-allowlisted' && readDoc(store, experimentGatePath()) === undefined;
  });

  await checkAsync(
    '[A28] the consume-write preserves expectedUid/expectedReminderId/expectedScheduledForMs/expectedInstallationId/createdAt EXACTLY (update-construction invariant, proven behaviorally, not merely validator-claimed)',
    async () => {
      const { db, store } = makeFakeDb();
      const fixture = seedHappyPath(db, store, { rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, experimentGate: {} });
      const before = readDoc(store, experimentGatePath())!;
      const result = await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
      if (result.outcome !== 'sending-authorized') return false;
      const after = readDoc(store, experimentGatePath())!;
      return (
        after.expectedUid === before.expectedUid &&
        after.expectedReminderId === before.expectedReminderId &&
        after.expectedScheduledForMs === before.expectedScheduledForMs &&
        after.expectedInstallationId === before.expectedInstallationId &&
        (after.createdAt as Timestamp).toMillis() === (before.createdAt as Timestamp).toMillis()
      );
    }
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
