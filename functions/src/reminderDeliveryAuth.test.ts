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
  REAL_DELIVERY_STAGE,
  type AccessTokenProvider,
  type FinalAuthorizationResult,
} from './reminderDeliveryAuth';
import { OPAQUE_ID_LENGTH } from './reminderDeliveryLogic';

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
      return new FakeDocumentRef(store, p);
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
  } = {}
): Fixture {
  const uid = 'user-1';
  const reminderId = `${uid}_1000`;
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

  check('source-level lock: REAL_DELIVERY_STAGE is "disabled"', REAL_DELIVERY_STAGE === 'disabled');

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

  // Step 3C-4: with REAL_DELIVERY_STAGE === 'disabled', BOTH real-send rollout modes now
  // fail closed via the staged gate specifically (reason 'rollout-real-send-stage-disabled'),
  // not the old, now-removed 'rollout-mode-not-supported-in-this-phase' catch-all — even
  // an allowlisted uid under 'allowlisted-real-send' is rejected, proving the stage check
  // runs BEFORE allowlist membership is ever consulted.
  await checkAsync('[3C-4] rollout allowlisted-real-send, uid ON the allowlist -> still cancelled (stage disabled overrides allowlist membership)', async () => {
    const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['user-1'] } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-stage-disabled';
  });

  await checkAsync('[3C-4] rollout allowlisted-real-send, uid NOT on the allowlist -> cancelled (stage disabled, same reason as above — stage check runs first)', async () => {
    const result = await runHappyPath({ rollout: { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-stage-disabled';
  });

  await checkAsync('[3C-4] rollout general-real-send -> cancelled rollout-real-send-stage-disabled', async () => {
    const result = await runHappyPath({ rollout: { mode: 'general-real-send' } });
    return result.outcome === 'cancelled' && result.reason === 'rollout-real-send-stage-disabled';
  });

  await checkAsync('[3C-4] disabled-stage cancellation writes zero send-intent fields (state stays cancelled, not sending)', async () => {
    const { db, store } = makeFakeDb();
    const fixture = seedHappyPath(db, store, { rollout: { mode: 'general-real-send' } });
    await finalizeDeliveryAuthorization(db, fixture.deliveryRef as FirebaseFirestore.DocumentReference, 1, TEST_ACCESS_TOKEN);
    const after = readDoc(store, deliveryPath(fixture.reminderId, fixture.installationId))!;
    return (
      after.state === 'cancelled' &&
      !Object.prototype.hasOwnProperty.call(after, 'sendExecutionId') &&
      !Object.prototype.hasOwnProperty.call(after, 'sendIntentAtMs') &&
      after.sendAttemptCount === 0
    );
  });

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
  // Step 3C-4: with this file's REAL_DELIVERY_STAGE hardcoded to 'disabled', BOTH
  // real-send modes cancel via the staged gate — 'proceed-real-send' is provably
  // unreachable through this exported function as compiled today, regardless of uid or
  // allowlist content. The 'allowlisted-only'/'general' stage behaviors themselves are
  // exhaustively covered directly against decideStagedRealSendAuthorization in
  // reminderDeliveryLogic.test.ts, which is NOT hardcoded to any one stage.
  check(
    'decideFinalAuthorizationRolloutDisposition: allowlisted-real-send, uid on allowlist -> still cancel (stage disabled)',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'allowlisted-real-send', allowlistUids: ['user-1'] }, 'user-1');
      return d.decision === 'cancel' && d.reason === 'rollout-real-send-stage-disabled';
    })()
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: general-real-send -> cancel (stage disabled)',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'general-real-send' }, 'user-1');
      return d.decision === 'cancel' && d.reason === 'rollout-real-send-stage-disabled';
    })()
  );
  check(
    'decideFinalAuthorizationRolloutDisposition: general-real-send with malformed uid -> still cancel (stage-disabled reason wins; stage check runs before uid validation)',
    (() => {
      const d = decideFinalAuthorizationRolloutDisposition({ mode: 'general-real-send' }, { not: 'a string' });
      return d.decision === 'cancel' && d.reason === 'rollout-real-send-stage-disabled';
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

  // =======================================================================================
  // STEP 3C-4 — STAGED REAL-SEND LOCK, SENDING-INTENT COMMIT, AND SECRET HANDOFF.
  // =======================================================================================

  check(
    'reminderDeliveryAuth.ts asserts REAL_DELIVERY_STAGE !== "disabled" throws, BEFORE any Firestore access (layer A structural lock, mirrors the exact pre-3C-4 REAL_DELIVERY_ENABLED pattern)',
    codeOnly.includes("if (REAL_DELIVERY_STAGE !== 'disabled')") && codeOnly.includes('must remain "disabled"')
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

  await checkAsync('[3C-4] canAuthorizeNewSendIntent guard: sendAttemptCount already at MAX_SEND_ATTEMPTS on a would-be real-send branch is defensive/unreachable while stage is disabled, but the guard code path itself must exist statically', async () => {
    // Behaviorally unreachable while REAL_DELIVERY_STAGE === 'disabled' (the rollout check
    // cancels first) — verified here as a static-source check instead, since no rollout
    // config can drive execution past the stage gate in this compiled file.
    return codeOnly.includes('canAuthorizeNewSendIntent(completeValidation.sendAttemptCount)') && codeOnly.includes("'send-attempt-count-exhausted'");
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
