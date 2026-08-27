// functions/src/reminderDeliveryAuth.emulatorSuite.ts
// PHASE 3A-3 STEP 3C-7 — Firestore-emulator-only concurrency/serializability integration
// test for the experiment-wide one-shot gate (see reminderDeliveryAuth.ts's
// experimentGateRef / validateExperimentGateSchema / finalizeDeliveryAuthorizationInner).
//
// EXCLUDED FROM THE PRODUCTION BUILD (tsconfig.json's exclude now includes
// 'src/**/*.emulatorSuite.ts', so this file — and the real Firestore Emulator client code
// it contains — can never be compiled into lib/ or shipped as part of the deployed
// Function). ALSO excluded from the ORDINARY `npm test` run: that script is
// `node --test lib-test/*.test.js`, a glob matching only filenames literally ending in
// '.test.js' — this file compiles to 'reminderDeliveryAuth.emulatorSuite.js', which that
// glob does not match — so routine `npm test` remains emulator-independent and this suite
// is only ever run by the explicit command below.
//
// SAFETY: hard-fails immediately, before touching any Firestore client, if
// FIRESTORE_EMULATOR_HOST is absent or does not resolve to localhost/127.0.0.1, and if
// either GCLOUD_PROJECT or GOOGLE_CLOUD_PROJECT names the real 'neuroactive' project. Uses
// ONLY a synthetic demo project ID ('demo-neuroactive-gate-emulator-test') — never
// 'neuroactive'. Never calls applicationDefault()/reads any real service-account
// credential: initializeApp() below is given a bare projectId and no `credential` field,
// which is all firebase-admin needs once FIRESTORE_EMULATOR_HOST is set — the SDK detects
// that env var and routes every Firestore call to the local emulator over an unauthenticated
// local channel, never attempting a real network credential exchange.
//
// This file drives the REAL, unmodified finalizeDeliveryAuthorization against a REAL
// (local, ephemeral) Firestore transaction engine — the one piece of the design the
// repository's existing hand-built fakes cannot faithfully prove: genuine multi-transaction
// contention resolved by Firestore's own serializable-isolation guarantee, independent of
// whether the underlying concurrency-control implementation is pessimistic (as
// `gcloud firestore databases describe` reports for the real 'neuroactive' database) or
// optimistic (unconfirmed for the emulator, and irrelevant to this proof either way).
//
// HOW TO RUN (never via `npm test`):
//   1. Start a local Firestore Emulator bound to 127.0.0.1, e.g.:
//        firebase emulators:start --only firestore \
//          --project demo-neuroactive-gate-emulator-test --config <temp-emulator-config.json>
//   2. npm run build:test
//   3. FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 node --test lib-test/reminderDeliveryAuth.emulatorSuite.js
import { createHash } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { finalizeDeliveryAuthorization } from './reminderDeliveryAuth';
import type { FinalAuthorizationResult } from './reminderDeliveryAuth';
import { OPAQUE_ID_LENGTH } from './reminderDeliveryLogic';
import { buildReminderId } from './reminderSchedulerLogic';

// ---------------------------------------------------------------------------------------
// SAFETY GATES — checked before any Firestore client is constructed.
// ---------------------------------------------------------------------------------------
const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulatorHost) {
  throw new Error(
    'reminderDeliveryAuth.emulatorSuite: FIRESTORE_EMULATOR_HOST is not set. Refusing to run against any other Firestore backend — this suite must never touch a real project.'
  );
}
const emulatorHostname = emulatorHost.split(':')[0];
if (emulatorHostname !== 'localhost' && emulatorHostname !== '127.0.0.1') {
  throw new Error(
    `reminderDeliveryAuth.emulatorSuite: FIRESTORE_EMULATOR_HOST must resolve to localhost/127.0.0.1, got "${emulatorHost}". Refusing to run.`
  );
}
if (process.env.GCLOUD_PROJECT === 'neuroactive' || process.env.GOOGLE_CLOUD_PROJECT === 'neuroactive') {
  throw new Error('reminderDeliveryAuth.emulatorSuite: ambient project environment variables reference the real "neuroactive" project. Refusing to run.');
}

const SYNTHETIC_PROJECT_ID = 'demo-neuroactive-gate-emulator-test';

// No `credential` field: with FIRESTORE_EMULATOR_HOST set, the Admin SDK routes every call
// to the local emulator and never attempts a real credential exchange — there is no
// possible fallback to a real project from this call shape.
initializeApp({ projectId: SYNTHETIC_PROJECT_ID });
const db = getFirestore();

// Matches reminderDeliveryAuth.ts's own fixed path prefix. Irrelevant to safety here: this
// entire database IS the local emulator (verified above), never real GCP Firestore, so the
// path string itself carries no special privilege.
const APP_ID = 'neuroactive-prod';
const TEST_ACCESS_TOKEN = 'ya29.emulator-suite-fixture-access-token';
const VALID_FANOUT_EXECUTION_ID = 'D'.repeat(OPAQUE_ID_LENGTH);

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
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
function gatePath(): string {
  return `artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`;
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean): void {
  if (cond) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}`);
    fail++;
  }
}

type CallOutcome = FinalAuthorizationResult | { outcome: 'threw'; error: unknown };

function isSendingAuthorized(r: CallOutcome): r is Extract<FinalAuthorizationResult, { outcome: 'sending-authorized' }> {
  return r.outcome === 'sending-authorized';
}

interface IterationFixture {
  uid: string;
  reminderId: string;
  installationId: string;
  deliveryDocRef: FirebaseFirestore.DocumentReference;
}

// Seeds ONE fully valid, real-send-eligible fixture (reminder/delivery/preference/rollout/
// installation/tokenClaim/armed-matching-gate) per iteration, using a UNIQUE uid so
// iterations never collide with each other's documents. The rollout/gate documents live at
// fixed paths and are idempotently overwritten each iteration.
async function seedIteration(iteration: number): Promise<IterationFixture> {
  const uid = `race-user-${iteration}`;
  const scheduledForMs = 1_700_000_000_000 + iteration;
  const reminderId = buildReminderId(uid, scheduledForMs);
  const installationId = hex32(iteration + 1);
  const token = `raw-token-${iteration}`;
  const tokenHash = sha256Hex(token);
  const leaseMs = Date.now() + 5 * 60 * 1000;

  await db.doc(rolloutPath()).set({ mode: 'allowlisted-real-send', allowlistUids: [uid] });
  await db.doc(reminderPath(reminderId)).set({
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
  });
  const deliveryDocRef = db.doc(deliveryPath(reminderId, installationId));
  await deliveryDocRef.set({
    state: 'preparing',
    workState: 'queued',
    workAvailableAt: Timestamp.fromMillis(leaseMs),
    leaseExpiresAt: Timestamp.fromMillis(leaseMs),
    uid,
    installationId,
    deliveryPublicId: 'A'.repeat(OPAQUE_ID_LENGTH),
    fanoutExecutionIdAtCreation: VALID_FANOUT_EXECUTION_ID,
    sendAttemptCount: 0,
    processingAttemptCount: 1,
    attemptHistory: [],
    targetSnapshot: { generation: 1, tokenVersion: 1, installationAudienceId: 'A'.repeat(16) },
  });
  await db.doc(prefPath(uid)).set({
    enabled: true,
    revision: 1,
    scheduleType: 'daily',
    weekdays: [0, 1, 2, 3, 4, 5, 6],
    localTime: '07:00',
    timezone: 'UTC',
  });
  await db.doc(installationPath(installationId)).set({
    uid,
    state: 'active',
    epochSchemaVersion: 1,
    tokenVersion: 1,
    installationAudienceId: 'A'.repeat(16),
    generation: 1,
    token,
  });
  await db.doc(tokenClaimPath(tokenHash)).set({ installationId, uid });
  await db.doc(gatePath()).set({
    state: 'armed',
    expectedUid: uid,
    expectedReminderId: reminderId,
    expectedScheduledForMs: scheduledForMs,
    expectedInstallationId: installationId,
    createdAt: Timestamp.now(),
    consumedAt: null,
    consumedByExecutionId: null,
  });

  return { uid, reminderId, installationId, deliveryDocRef };
}

const RACE_ITERATIONS = 30;

async function runIteration(iteration: number): Promise<void> {
  const fixture = await seedIteration(iteration);

  // Synchronize BEFORE either transaction begins — both calls await the SAME "release"
  // promise, so they genuinely start racing together rather than one trailing the other.
  // No barrier occurs after any Firestore read or inside either transaction — from here,
  // Firestore's own scheduler alone resolves the race.
  let release: () => void = () => {};
  const releaseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const call = (): Promise<CallOutcome> =>
    releaseGate.then(() =>
      finalizeDeliveryAuthorization(db, fixture.deliveryDocRef, 1, TEST_ACCESS_TOKEN).catch((error: unknown): CallOutcome => ({ outcome: 'threw', error }))
    );
  const callA = call();
  const callB = call();
  release();
  const [resultA, resultB] = await Promise.all([callA, callB]);

  const capabilities = [resultA, resultB].filter(isSendingAuthorized);
  check(`[iteration ${iteration}] exactly one capability returned`, capabilities.length === 1);

  const deliverySnap = await fixture.deliveryDocRef.get();
  const deliveryData = deliverySnap.data() ?? {};
  check(`[iteration ${iteration}] delivery ends in state='sending' with sendAttemptCount=1`, deliveryData.state === 'sending' && deliveryData.sendAttemptCount === 1);

  const gateSnap = await db.doc(gatePath()).get();
  const gateData = gateSnap.data() ?? {};
  check(`[iteration ${iteration}] gate ends consumed`, gateData.state === 'consumed');

  const winner = capabilities[0];
  check(
    `[iteration ${iteration}] gate.consumedByExecutionId === delivery.sendExecutionId === the winning capability's sendExecutionId`,
    winner !== undefined && gateData.consumedByExecutionId === deliveryData.sendExecutionId && gateData.consumedByExecutionId === winner.capability.sendExecutionId
  );

  // Both calls above are already `.catch()`-wrapped, so neither can surface as an unhandled
  // rejection regardless of outcome — this assertion only confirms the LOSER never also
  // carries a capability (its exact denial shape — cancelled/stale-fence/threw — is
  // deliberately not constrained further; see the file header).
  const loser = isSendingAuthorized(resultA) ? resultB : resultA;
  check(`[iteration ${iteration}] losing call carries no capability`, !isSendingAuthorized(loser));

  // A fresh THIRD authorization call, made only after both original calls have resolved,
  // must also return no capability (the delivery is now 'sending', so this is denied at the
  // pre-existing state/fence check before the gate is even reached — a stale-fence denial is
  // just as valid a "no capability" proof as a gate denial would be).
  const thirdResult: CallOutcome = await finalizeDeliveryAuthorization(db, fixture.deliveryDocRef, 2, TEST_ACCESS_TOKEN).catch(
    (error: unknown): CallOutcome => ({ outcome: 'threw', error })
  );
  check(`[iteration ${iteration}] fresh third authorization after the race returns no capability`, !isSendingAuthorized(thirdResult));
}

async function main(): Promise<void> {
  console.log(`reminderDeliveryAuth.emulatorSuite: connected to FIRESTORE_EMULATOR_HOST=${emulatorHost}, project=${SYNTHETIC_PROJECT_ID}`);
  console.log(`reminderDeliveryAuth.emulatorSuite: running ${RACE_ITERATIONS} isolated concurrent-authorization iterations`);

  for (let i = 0; i < RACE_ITERATIONS; i++) {
    await runIteration(i);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exit(1);
});
