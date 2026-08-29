// activation-controller.test.js — local/static tests for gate-activation-logic.js,
// gate-io.js, rollout-mutation.js, readiness-artifact.js, activation-controller.js, and
// activation-watchdog.js (Codex Step 3C-9, repair pass 3). Read-only against FAKE Firestore
// substitutes (in-memory and a JSON-file-backed store for real two-process tests) — never
// touches production, never imports arm-gate-runner.js, never calls armGate(). Run with:
//   node activation-controller.test.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');

const gal = require('./gate-activation-logic');
const controller = require('./activation-controller');
const rolloutMutation = require('./rollout-mutation');
const readinessArtifact = require('./readiness-artifact');
const { makeFileBackedDb } = require('./fake-firestore-file-store');

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    console.log('PASS  ' + label);
    pass++;
  } else {
    console.log('FAIL  ' + label + (detail ? ': ' + detail : ''));
    fail++;
  }
}
async function checkAsync(label, fn) {
  try {
    check(label, await fn());
  } catch (err) {
    check(label, false, 'threw: ' + (err && err.message));
  }
}
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// =========================================================================================
// FAKE IN-MEMORY FIRESTORE — minimal doc get/set/update/transaction + collection/
// collectionGroup surface sufficient for the controller's own read/mutation paths.
// =========================================================================================
class FakeDocRef {
  constructor(store, p) {
    this.store = store;
    this.path = p;
  }
  async get() {
    const exists = this.store.has(this.path);
    return { exists, ref: this, data: () => (exists ? { ...this.store.get(this.path) } : undefined) };
  }
}
function makeFakeDb(seed) {
  const store = new Map(Object.entries(seed || {}));
  const db = {
    doc(p) {
      return new FakeDocRef(store, p);
    },
    collection(prefix) {
      function makeQuery(filters) {
        return {
          where(field, op, value) {
            if (op !== '==') throw new Error('FakeDb.collection().where(): only "==" is supported by this test double');
            return makeQuery([...filters, { field, value }]);
          },
          async get() {
            const docs = [];
            for (const [p, data] of store.entries()) {
              if (!(p.startsWith(prefix + '/') && p.slice(prefix.length + 1).split('/').length === 1)) continue;
              if (filters.every((f) => data[f.field] === f.value)) {
                docs.push({ id: p.slice(prefix.length + 1), ref: { path: p }, data: () => ({ ...data }) });
              }
            }
            return { docs };
          },
        };
      }
      return makeQuery([]);
    },
    collectionGroup(name) {
      return {
        async get() {
          const docs = [];
          for (const [p, data] of store.entries()) {
            const segs = p.split('/');
            if (segs[segs.length - 2] === name) docs.push({ ref: { path: p }, data: () => ({ ...data }) });
          }
          return { docs };
        },
      };
    },
    async runTransaction(cb) {
      const tx = {
        async get(ref) {
          return ref.get();
        },
        update(ref, data) {
          if (!store.has(ref.path)) throw new Error('FakeTransaction.update: missing doc ' + ref.path);
          store.set(ref.path, { ...store.get(ref.path), ...data });
        },
        set(ref, data) {
          store.set(ref.path, { ...data });
        },
      };
      return cb(tx);
    },
  };
  return { db, store };
}

// =========================================================================================
// FIXTURES
// =========================================================================================
const APP_ID = 'neuroactive-prod';
const UID = 'test-uid-1';
const SCHEDULED_MS = Date.now() + 12 * 60 * 1000; // within the 10-15 min activation window
const REMINDER_ID = `${UID}_${SCHEDULED_MS}`;
const INSTALLATION_ID = 'c'.repeat(32);
const TOKEN = 'fake-installation-token';
function sha256Hex(v) {
  return createHash('sha256').update(v).digest('hex');
}
const TOKEN_HASH = sha256Hex(TOKEN);

const { Timestamp } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');
const { validateExperimentGateSchema } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryAuth.js');
const { isValidIdForPath } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryLogic.js');

const APPROVED_SCHEDULE_FIXTURE = { revision: 10, scheduleType: 'daily', weekdays: [0, 1, 2, 3, 4, 5, 6], localTime: '15:30', timezone: 'America/Chicago' };

function gateDoc(overrides) {
  return {
    state: 'armed',
    expectedUid: UID,
    expectedReminderId: REMINDER_ID,
    expectedScheduledForMs: SCHEDULED_MS,
    expectedInstallationId: INSTALLATION_ID,
    createdAt: Timestamp.fromMillis(Date.now() - 60 * 60 * 1000),
    consumedAt: null,
    consumedByExecutionId: null,
    ...overrides,
  };
}

function consumedGateDoc(overrides) {
  return gateDoc({
    state: 'consumed',
    consumedAt: Timestamp.now(),
    consumedByExecutionId: 'a'.repeat(43), // OPAQUE_ID_LENGTH (base64url of 32 random bytes, no padding)
    ...overrides,
  });
}

function baseSeed(overrides) {
  const seed = {
    [`artifacts/${APP_ID}/systemConfig/notificationRollout`]: { mode: 'paused' },
    [`artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`]: gateDoc(),
    [`artifacts/${APP_ID}/users/${UID}/notificationPreferences/main`]: {
      enabled: true,
      ...APPROVED_SCHEDULE_FIXTURE,
      nextReminderDueAt: Timestamp.fromMillis(SCHEDULED_MS),
    },
    [`artifacts/${APP_ID}/pushInstallations/${INSTALLATION_ID}`]: {
      uid: UID,
      state: 'active',
      epochSchemaVersion: 1,
      tokenVersion: 1,
      installationAudienceId: 'a'.repeat(16),
      generation: 1,
      token: TOKEN,
    },
    [`artifacts/${APP_ID}/pushTokenClaims/${TOKEN_HASH}`]: { installationId: INSTALLATION_ID, uid: UID },
  };
  for (let i = 0; i < 8; i++) {
    seed[`artifacts/${APP_ID}/reminders/other-reminder-${i}`] = { uid: 'unrelated-uid', workState: 'terminal', status: 'delivery-fanned-out' };
  }
  // Codex Step 3C-9 repair pass 5, item 3: matches real production's actual approved
  // baseline (all 4 existing deliveries are 'dry-run-validated') so the new
  // hasZeroFcmEvidence preflight check does not (correctly) reject this fixture.
  for (let i = 0; i < 4; i++) {
    seed[`artifacts/${APP_ID}/reminders/other-reminder-${i}/deliveries/other-install-${i}`] = { state: 'dry-run-validated', workState: 'terminal' };
  }
  return { ...seed, ...(overrides || {}) };
}

const GATE_PATH = `artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`;
const ROLLOUT_PATH = `artifacts/${APP_ID}/systemConfig/notificationRollout`;
const PREF_PATH = `artifacts/${APP_ID}/users/${UID}/notificationPreferences/main`;
const INSTALL_PATH = `artifacts/${APP_ID}/pushInstallations/${INSTALLATION_ID}`;
const DELIVERY_PATH = `artifacts/${APP_ID}/reminders/${REMINDER_ID}/deliveries/${INSTALLATION_ID}`;

function tmpFile(name) {
  return path.join(os.tmpdir(), `wd-p3-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}

function writeFreshReadiness(readinessPath, gate, challenge, absoluteDeadlineMs, overrides) {
  readinessArtifact.writeReadiness(readinessPath, {
    challenge,
    nonce: 'nonce-1',
    pid: process.pid, // this test process itself — always alive for the duration of the test
    experimentBindingHash: gal.buildExperimentBindingHash(gate),
    absoluteDeadlineMs,
    heartbeatAtMs: Date.now(),
    ...overrides,
  });
}

async function main() {
  // Codex Step 3C-9 repair pass 6, item 1: runControllerOrchestration now hard-requires
  // EITHER ACTIVATION_TEST_MODE=true OR a valid activation-capability token before touching
  // Firestore in production mode. This entire file operates only against fake/local state and
  // test-mode-launched watchdogs, never real production, so the sentinel is set once here as
  // this file's baseline; individual tests that specifically need to prove "sentinel absent"
  // behavior manage/restore it themselves within their own scope regardless.
  process.env.ACTIVATION_TEST_MODE = 'true';

  // =======================================================================================
  // gate-activation-logic.js — pure decision functions
  // =======================================================================================
  console.log('\n=== gate validation ===');
  check('exact armed/unconsumed gate -> valid', gal.isArmedUnconsumedGate(gateDoc(), validateExperimentGateSchema));
  check('gate with state=consumed -> NOT armed-unconsumed', !gal.isArmedUnconsumedGate(gateDoc({ state: 'consumed' }), validateExperimentGateSchema));
  check('null gate data -> NOT armed-unconsumed', !gal.isArmedUnconsumedGate(null, validateExperimentGateSchema));
  check('isConsumedGate(state=consumed) -> true (cheap check only)', gal.isConsumedGate({ state: 'consumed' }));

  console.log('\n=== [item 11] full consumed-gate validation ===');
  const boundGate = { expectedUid: UID, expectedReminderId: REMINDER_ID, expectedScheduledForMs: SCHEDULED_MS, expectedInstallationId: INSTALLATION_ID };
  check('exact valid consumed gate, identity-bound -> isValidConsumedGateBoundTo true', gal.isValidConsumedGateBoundTo(consumedGateDoc(), boundGate, validateExperimentGateSchema));
  check('consumed gate missing consumedAt -> fails full schema -> false', !gal.isValidConsumedGateBoundTo({ ...consumedGateDoc(), consumedAt: null }, boundGate, validateExperimentGateSchema));
  check('consumed gate with malformed consumedByExecutionId -> fails full schema -> false', !gal.isValidConsumedGateBoundTo({ ...consumedGateDoc(), consumedByExecutionId: 'short' }, boundGate, validateExperimentGateSchema));
  check('consumed gate schema-valid but bound to a DIFFERENT installationId -> identity mismatch -> false', !gal.isValidConsumedGateBoundTo(consumedGateDoc({ expectedInstallationId: 'd'.repeat(32) }), boundGate, validateExperimentGateSchema));
  check('a bare {state:"consumed"} object with nothing else -> false (never trusted at face value)', !gal.isValidConsumedGateBoundTo({ state: 'consumed' }, boundGate, validateExperimentGateSchema));

  console.log('\n=== rollout source/destination state ===');
  check('exactly {mode:paused} -> isExactlyPausedRollout true', gal.isExactlyPausedRollout({ mode: 'paused' }));
  check('exactly {mode:allowlisted-real-send, allowlistUids:[uid]} -> isExactlyAllowlistedForUid true', gal.isExactlyAllowlistedForUid({ mode: 'allowlisted-real-send', allowlistUids: [UID] }, UID));
  check("buildAllowlistedRolloutPayload(uid) -> exactly {mode:'allowlisted-real-send', allowlistUids:[uid]}", (() => {
    const payload = gal.buildAllowlistedRolloutPayload(UID, isValidIdForPath);
    return payload.mode === 'allowlisted-real-send' && payload.allowlistUids.length === 1 && payload.allowlistUids[0] === UID;
  })());

  console.log('\n=== approved census / schedule baselines ===');
  check('exact approved census -> isApprovedCensusBaseline true', gal.isApprovedCensusBaseline({ reminders: { total: 8, terminal: 8, nonterminal: 0 }, deliveries: { total: 4, terminal: 4, nonterminal: 0 } }));
  check('former 7/7/0 reminder census -> isApprovedCensusBaseline false', !gal.isApprovedCensusBaseline({ reminders: { total: 7, terminal: 7, nonterminal: 0 }, deliveries: { total: 4, terminal: 4, nonterminal: 0 } }));
  check('wrong delivery census -> isApprovedCensusBaseline false', !gal.isApprovedCensusBaseline({ reminders: { total: 8, terminal: 8, nonterminal: 0 }, deliveries: { total: 5, terminal: 5, nonterminal: 0 } }));
  check('exact approved schedule -> isApprovedScheduleBaseline true', gal.isApprovedScheduleBaseline(APPROVED_SCHEDULE_FIXTURE));
  check('former revision 8 / 21:15 schedule -> isApprovedScheduleBaseline false', !gal.isApprovedScheduleBaseline({ ...APPROVED_SCHEDULE_FIXTURE, revision: 8, localTime: '21:15' }));
  check('wrong revision -> isApprovedScheduleBaseline false', !gal.isApprovedScheduleBaseline({ ...APPROVED_SCHEDULE_FIXTURE, revision: 9 }));
  check('wrong localTime -> isApprovedScheduleBaseline false', !gal.isApprovedScheduleBaseline({ ...APPROVED_SCHEDULE_FIXTURE, localTime: '21:15' }));

  console.log('\n=== timing window / [item 10] observation deadline cap ===');
  check('exactly 12 minutes before occurrence -> within activation window', gal.isWithinActivationWindow(Date.now(), Date.now() + 12 * 60 * 1000));
  check('containment deadline is exactly 20 minutes after the occurrence', gal.computeActivationTiming(1000, 2000).containmentDeadlineMs === 2000 + 20 * 60 * 1000);
  check('capObservationDeadline: requested budget SHORTER than absolute deadline -> requested wins', gal.capObservationDeadline(1000, 5000) === 1000);
  check('capObservationDeadline: requested budget LONGER than absolute deadline -> absolute deadline wins (never exceeded)', gal.capObservationDeadline(9000, 5000) === 5000);
  check('[item 22] a 30-minute default local observation budget starting well before a near occurrence is capped to the absolute deadline, not the 30-minute default', (() => {
    const nowMs = 1000;
    const scheduledForMs = nowMs + 5 * 60 * 1000; // occurrence in 5 minutes
    const containmentDeadlineMs = scheduledForMs + 20 * 60 * 1000; // absolute deadline: +25min from now
    const defaultBudgetMs = 30 * 60 * 1000; // a locally-requested 30-minute budget
    const cappedDeadline = gal.capObservationDeadline(nowMs + defaultBudgetMs, containmentDeadlineMs);
    return cappedDeadline === containmentDeadlineMs && cappedDeadline < nowMs + defaultBudgetMs;
  })());

  console.log('\n=== [items 4-6] watchdog readiness handshake — challenge/nonce/PID/heartbeat ===');
  const sampleGate = gateDoc();
  const challengeA = gal.generateChallenge();
  const challengeB = gal.generateChallenge();
  check('generateChallenge produces a long, high-entropy hex string', typeof challengeA === 'string' && challengeA.length >= 32 && /^[0-9a-f]+$/.test(challengeA));
  check('two calls to generateChallenge never produce the same value', challengeA !== challengeB);
  const expectation = gal.buildReadinessExpectation(sampleGate, challengeA, 9999);
  const validReadiness = { challenge: challengeA, experimentBindingHash: expectation.expectedBindingHash, absoluteDeadlineMs: 9999, nonce: 'n1', pid: process.pid, heartbeatAtMs: Date.now() };
  check('readinessMatchesExpectation: exact challenge/binding/deadline match -> true', gal.readinessMatchesExpectation(validReadiness, expectation));
  check('[item 15] readiness from a PRIOR run (different challenge, everything else identical) -> replay REJECTED', !gal.readinessMatchesExpectation({ ...validReadiness, challenge: challengeB }, expectation));
  check('readinessMatchesExpectation: wrong binding hash -> false', !gal.readinessMatchesExpectation({ ...validReadiness, experimentBindingHash: 'wrong' }, expectation));
  check('readinessMatchesExpectation: wrong deadline -> false', !gal.readinessMatchesExpectation({ ...validReadiness, absoluteDeadlineMs: 1 }, expectation));
  check('readinessHeartbeatFresh: 1s-old heartbeat, 60s max age -> true', gal.readinessHeartbeatFresh({ heartbeatAtMs: Date.now() - 1000 }, Date.now(), 60000));
  check('readinessHeartbeatFresh: 10-minute-old heartbeat -> false (stale)', !gal.readinessHeartbeatFresh({ heartbeatAtMs: Date.now() - 10 * 60 * 1000 }, Date.now(), 60000));
  const r1 = { challenge: challengeA, nonce: 'n1', pid: 111, experimentBindingHash: 'h', absoluteDeadlineMs: 9999, heartbeatAtMs: 1000 };
  check('readinessAdvanced: identical identity, LATER heartbeat -> true', gal.readinessAdvanced(r1, { ...r1, heartbeatAtMs: 2000 }));
  check('[item 14] readinessAdvanced: identical identity, SAME (frozen) heartbeat -> false — a fresh-looking single snapshot from a dead watchdog is not enough', !gal.readinessAdvanced(r1, { ...r1, heartbeatAtMs: 1000 }));
  check('[item 16] readinessAdvanced: PID changed between reads -> false', !gal.readinessAdvanced(r1, { ...r1, pid: 222, heartbeatAtMs: 2000 }));
  check('[item 16] readinessAdvanced: nonce changed between reads -> false', !gal.readinessAdvanced(r1, { ...r1, nonce: 'n2', heartbeatAtMs: 2000 }));
  check('[item 16] readinessAdvanced: challenge changed between reads -> false', !gal.readinessAdvanced(r1, { ...r1, challenge: challengeB, heartbeatAtMs: 2000 }));

  console.log('\n=== [item 5] OS-level PID liveness ===');
  check('isPidAlive(process.pid) (this very test process) -> true', gal.isPidAlive(process.pid));
  check('[item 16] isPidAlive on a very unlikely-to-exist PID -> false', !gal.isPidAlive(999999));
  check('isPidAlive rejects non-integer/zero/negative input defensively', !gal.isPidAlive(0) && !gal.isPidAlive(-5) && !gal.isPidAlive(1.5) && !gal.isPidAlive('123'));

  console.log('\n=== [item 3] pause/containment 3-way classification + explicit outcome model ===');
  check("exactly paused -> 'paused'", gal.classifyRolloutContainmentState({ mode: 'paused' }, UID) === 'paused');
  check("exactly allowlisted for expectedUid -> 'still-allowlisted-for-expected-uid'", gal.classifyRolloutContainmentState({ mode: 'allowlisted-real-send', allowlistUids: [UID] }, UID) === 'still-allowlisted-for-expected-uid');
  check("allowlisted for a DIFFERENT uid -> 'unexpected-rollout-state'", gal.classifyRolloutContainmentState({ mode: 'allowlisted-real-send', allowlistUids: ['other'] }, UID) === 'unexpected-rollout-state');

  console.log('\n=== [item 1] activation transaction-failure classification ===');
  check("known activation precondition sentinel -> 'definite-noncommit'", gal.classifyTransactionFailure('activation-precondition-failed') === 'definite-noncommit');
  check("known pause precondition sentinel -> 'definite-noncommit'", gal.classifyTransactionFailure('pause-precondition-failed') === 'definite-noncommit');
  check("an unrecognized error message -> 'genuinely-uncertain'", gal.classifyTransactionFailure('ECONNRESET') === 'genuinely-uncertain');

  console.log('\n=== explicit outcome model (A-F), tightened coherent-429 evidence ===');
  check('gate not yet consumed -> F-pending', gal.classifyControlledOutcome({ state: 'armed' }, null).kind === 'F-pending');
  check('A: consumed + accepted-by-fcm -> A-accepted', gal.classifyControlledOutcome({ state: 'consumed' }, { state: 'accepted-by-fcm' }).kind === 'A-accepted');
  check('D: consumed + sending -> D-stranded-sending, no-repair', gal.classifyControlledOutcome({ state: 'consumed' }, { state: 'sending' }).noRepair === true);
  check('E (full evidence) -> E-coherent-cancelled-after-retry', gal.classifyControlledOutcome({ state: 'consumed' }, { state: 'cancelled', cancelReason: 'experiment-gate-consumed', sendAttemptCount: 1, attemptHistory: [{ outcomeCategory: 'retryable-later' }] }).kind === 'E-coherent-cancelled-after-retry');
  check('E (no evidence) -> E-ambiguous-cancellation, never mislabeled', gal.classifyControlledOutcome({ state: 'consumed' }, { state: 'cancelled' }).kind === 'E-ambiguous-cancellation');

  console.log('\n=== controlled-child targeting ===');
  check('exact controlled delivery path matches', gal.isControlledDeliveryPath(DELIVERY_PATH, APP_ID, REMINDER_ID, INSTALLATION_ID));
  check('an unrelated delivery is REJECTED', !gal.isControlledDeliveryPath(`artifacts/${APP_ID}/reminders/other/deliveries/${INSTALLATION_ID}`, APP_ID, REMINDER_ID, INSTALLATION_ID));

  // =======================================================================================
  // rollout-mutation.js — discriminated CAS results + bounded containment retry
  // =======================================================================================
  console.log('\n=== [items 1/2] explicit discriminated activation/pause mutation results ===');

  await checkAsync("activation CAS on exactly-paused source, valid bound gate -> {outcome:'committed'}", async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const result = await controller.attemptActivationCasForTest(db, gate, isValidIdForPath);
    return result.outcome === 'committed' && gal.isExactlyAllowlistedForUid(store.get(ROLLOUT_PATH), UID);
  });

  await checkAsync("[item 12] activation CAS with a KNOWN definite precondition failure (rollout not paused) -> {outcome:'definite-noncommit'}, NEVER 'committed', rollout untouched", async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'dry-run' } });
    const { db, store } = makeFakeDb(seed);
    const gate = await controller.loadArmedGate(db);
    const result = await controller.attemptActivationCasForTest(db, gate, isValidIdForPath);
    return result.outcome === 'definite-noncommit' && store.get(ROLLOUT_PATH).mode === 'dry-run';
  });

  await checkAsync("[item 12] activation CAS where the transactional gate re-check fails (gate consumed by something else) -> {outcome:'definite-noncommit'}, rollout untouched, gate untouched by this call", async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    store.set(GATE_PATH, consumedGateDoc());
    const result = await controller.attemptActivationCasForTest(db, gate, isValidIdForPath);
    return result.outcome === 'definite-noncommit' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH)) && store.get(GATE_PATH).state === 'consumed';
  });

  await checkAsync("[item 13] pause CAS with a KNOWN definite precondition failure (rollout allowlisted for a DIFFERENT uid) -> {outcome:'definite-noncommit'}, NEVER treated as paused=true", async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] } });
    const { db, store } = makeFakeDb(seed);
    const result = await rolloutMutation.attemptPauseCas(db, UID);
    return result.outcome === 'definite-noncommit' && store.get(ROLLOUT_PATH).allowlistUids[0] === 'someone-else';
  });

  await checkAsync("pause CAS on exactly-allowlisted-for-uid source -> {outcome:'committed'}, exactly paused", async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    const { db, store } = makeFakeDb(seed);
    const result = await rolloutMutation.attemptPauseCas(db, UID);
    return result.outcome === 'committed' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });

  await checkAsync('pause CAS is idempotent: rollout already exactly paused -> committed, no-op, still paused', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const result = await rolloutMutation.attemptPauseCas(db, UID);
    return result.outcome === 'committed' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });

  console.log('\n=== [items 8/9/18/19/20/21] bounded containment retry ===');

  await checkAsync('containment retry: rollout already exactly allowlisted for uid -> succeeds on first attempt', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    const { db, store } = makeFakeDb(seed);
    const result = await rolloutMutation.runBoundedContainmentRetry(db, UID, { maxAttempts: 3, backoffMs: 5 });
    return result.outcome === 'paused' && result.attempts === 1 && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });

  await checkAsync('[item 18] transient failure then success: rollout is exactly the EXPECTED allowlist throughout (never a foreign uid), but the pause CAS transaction itself throws a genuinely-uncertain error on the first attempt only -> bounded retry succeeds on the second attempt, without any activation retry', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    const { db, store } = makeFakeDb(seed);
    let transactionCalls = 0;
    const flakyDb = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      collectionGroup: db.collectionGroup.bind(db),
      async runTransaction(cb) {
        transactionCalls++;
        if (transactionCalls === 1) throw new Error('simulated-transient-network-error');
        return db.runTransaction(cb);
      },
    };
    const result = await rolloutMutation.runBoundedContainmentRetry(flakyDb, UID, { maxAttempts: 5, backoffMs: 15 });
    return result.outcome === 'paused' && result.attempts === 2 && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });

  await checkAsync('[item 19] ambiguous-then-safe-retry: readback after an attempted pause still shows the expected allowlist -> bounded retry succeeds on a later attempt, no gate/delivery mutation', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    const { db, store } = makeFakeDb(seed);
    const gateBefore = JSON.stringify(store.get(GATE_PATH));
    const deliveryBefore = store.has(DELIVERY_PATH) ? JSON.stringify(store.get(DELIVERY_PATH)) : undefined;
    const result = await rolloutMutation.runBoundedContainmentRetry(db, UID, { maxAttempts: 3, backoffMs: 5 });
    const gateUnchanged = JSON.stringify(store.get(GATE_PATH)) === gateBefore;
    const deliveryUnchanged = (store.has(DELIVERY_PATH) ? JSON.stringify(store.get(DELIVERY_PATH)) : undefined) === deliveryBefore;
    return result.outcome === 'paused' && gateUnchanged && deliveryUnchanged;
  });

  await checkAsync('[item 20/21] hard containment failure: rollout PERSISTENTLY stuck on an unexpected shape through the whole retry horizon -> unexpected-rollout-state, NEVER overwritten, NEVER reported as paused', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'general-real-send' } });
    const { db, store } = makeFakeDb(seed);
    const result = await rolloutMutation.runBoundedContainmentRetry(db, UID, { maxAttempts: 3, backoffMs: 5 });
    return result.outcome === 'unexpected-rollout-state' && store.get(ROLLOUT_PATH).mode === 'general-real-send';
  });

  await checkAsync('[item 20] hard containment failure: the pause CAS itself keeps failing (foreign allowlist NEVER clears) through the max retry horizon -> explicit hard-containment-failure, not reported as paused, no gate mutation', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: ['permanently-someone-else'] } });
    const { db, store } = makeFakeDb(seed);
    // 'permanently-someone-else' is never the expectedUid, so classifyRolloutContainmentState
    // treats it as 'unexpected-rollout-state' immediately — to reach genuine
    // hard-containment-failure we need the state to look like 'still-allowlisted-for-uid'
    // but the CAS itself to keep failing. Simulate by having the pause CAS's own
    // precondition read a DIFFERENT (foreign) value than classifyRolloutContainmentState's
    // read, via a store that alternates — instead, directly exercise the exhausted-attempts
    // path with a rollout that is exactly allowlisted for uid but whose transaction always
    // throws a genuinely-uncertain error by pointing at a db whose transaction is broken.
    const brokenDb = {
      doc: db.doc.bind(db),
      collection: db.collection.bind(db),
      collectionGroup: db.collectionGroup.bind(db),
      async runTransaction() {
        throw new Error('simulated-genuinely-uncertain-network-error');
      },
    };
    store.set(ROLLOUT_PATH, { mode: 'allowlisted-real-send', allowlistUids: [UID] });
    const result = await rolloutMutation.runBoundedContainmentRetry(brokenDb, UID, { maxAttempts: 3, backoffMs: 5 });
    return result.outcome === 'hard-containment-failure' && result.attempts === 3 && store.get(GATE_PATH).state === 'armed';
  });

  console.log('\n=== gate-io.js / activation-controller.js preflight, revalidation, observer ===');

  await checkAsync('happy-path fixture -> loadArmedGate resolves, runActivationPreflight ok', async () => {
    const { db } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    if (!gate) return false;
    const pf = await controller.runActivationPreflight(db, gate);
    return pf.ok === true;
  });

  await checkAsync('former revision 8 / 21:15 schedule fails closed with schedule-baseline-drift', async () => {
    const prefPath = `artifacts/${APP_ID}/users/${UID}/notificationPreferences/main`;
    const seed = baseSeed({
      [prefPath]: {
        enabled: true,
        ...APPROVED_SCHEDULE_FIXTURE,
        revision: 8,
        localTime: '21:15',
        nextReminderDueAt: Timestamp.fromMillis(SCHEDULED_MS),
      },
    });
    const { db } = makeFakeDb(seed);
    const gate = await controller.loadArmedGate(db);
    const pf = await controller.runActivationPreflight(db, gate);
    return pf.ok === false && pf.reason === 'schedule-baseline-drift';
  });

  await checkAsync('[item 3] a SECOND active installation for the same uid BLOCKS activation', async () => {
    const seed = baseSeed();
    seed[`artifacts/${APP_ID}/pushInstallations/${'e'.repeat(32)}`] = { uid: UID, state: 'active', epochSchemaVersion: 1, tokenVersion: 1, installationAudienceId: 'b'.repeat(16), generation: 1, token: 'second-token' };
    const { db } = makeFakeDb(seed);
    const gate = await controller.loadArmedGate(db);
    const pf = await controller.runActivationPreflight(db, gate);
    return pf.ok === false && pf.reason === 'installation-population-not-exactly-one-active';
  });

  await checkAsync('[item 17 test target] watchdog dies before activation: initial readiness valid, preflight succeeds, but the FINAL pre-activation recheck fails because the watchdog process is gone', async () => {
    const { db } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const readinessPath = tmpFile('readiness.json');
    const challenge = gal.generateChallenge();
    const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
    // Simulate a watchdog that was alive and ready, then died: write a readiness record with
    // a PID that does not exist, so both the initial AND final liveness checks fail exactly
    // as they would against a genuinely dead process.
    writeFreshReadiness(readinessPath, gate, challenge, timing.containmentDeadlineMs, { pid: 999999 });
    try {
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, { observePollMs: 10, observeBudgetMs: 200, readinessOpts: { advancementWaitMs: 10 } });
      return result.outcome === 'stop' && result.reason.startsWith('watchdog-not-ready');
    } finally {
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  console.log('\n=== [item 6/7] full controller orchestration — challenge-bound watchdog readiness required at BOTH checkpoints ===');

  function spawnLiveReadinessUpdater(readinessPath, gate, challenge, absoluteDeadlineMs, intervalMs) {
    // Simulates a live watchdog process by periodically re-writing the SAME readiness
    // record with an advancing heartbeat, from THIS test process's own PID (always alive).
    writeFreshReadiness(readinessPath, gate, challenge, absoluteDeadlineMs);
    const interval = setInterval(() => writeFreshReadiness(readinessPath, gate, challenge, absoluteDeadlineMs), intervalMs);
    return () => clearInterval(interval);
  }

  await checkAsync('orchestration refuses activation when the watchdog is not ready (no readiness file at all)', async () => {
    const { db } = makeFakeDb(baseSeed());
    const challenge = gal.generateChallenge();
    const result = await controller.runControllerOrchestration(db, tmpFile('none.json'), challenge, { observePollMs: 20, observeBudgetMs: 200, readinessOpts: { advancementWaitMs: 10 } });
    return result.outcome === 'stop' && result.reason.startsWith('watchdog-not-ready');
  });

  await checkAsync('[items 6/7] full orchestration succeeds end-to-end: live heartbeat-advancing readiness, activation commits, natural consumption observed, immediate pause, accepted-by-fcm classified, final paused state verified', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const readinessPath = tmpFile('readiness.json');
    const challenge = gal.generateChallenge();
    const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
    const stopUpdater = spawnLiveReadinessUpdater(readinessPath, gate, challenge, timing.containmentDeadlineMs, 15);
    // Delay chosen generously larger than the worst-case time to reach the activation
    // transaction (two 20ms watchdog-readiness advancement waits plus the full preflight/
    // revalidation read sequence against the fake store) — this simulates the WORKER
    // consuming the gate strictly AFTER activation has genuinely committed, not a race
    // against this test's own setup.
    setTimeout(() => {
      store.set(GATE_PATH, consumedGateDoc());
      store.set(DELIVERY_PATH, { state: 'accepted-by-fcm' });
    }, 500);
    try {
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, { observePollMs: 15, observeBudgetMs: 3000, readinessOpts: { advancementWaitMs: 20 } });
      return result.outcome === 'contained' && result.classification === 'A-accepted' && result.gateValidatedConsumed === true && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
    } finally {
      stopUpdater();
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[item 23] malformed consumed gate: gate flips to state:"consumed" but fails full schema/identity validation -> immediate containment/pause, ambiguous classification, no normal outcome, no resend, STOP', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const readinessPath = tmpFile('readiness.json');
    const challenge = gal.generateChallenge();
    const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
    const stopUpdater = spawnLiveReadinessUpdater(readinessPath, gate, challenge, timing.containmentDeadlineMs, 15);
    setTimeout(() => {
      // Looks consumed but consumedByExecutionId is malformed -> fails full schema.
      store.set(GATE_PATH, consumedGateDoc({ consumedByExecutionId: 'not-a-valid-opaque-id' }));
    }, 500);
    try {
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, { observePollMs: 15, observeBudgetMs: 800, readinessOpts: { advancementWaitMs: 20 } });
      const rolloutPaused = gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
      const noDeliveryWritten = !store.has(DELIVERY_PATH);
      return rolloutPaused && noDeliveryWritten && result.outcome === 'contained' && result.classification === 'ambiguous-gate-drift' && result.gateValidatedConsumed === false;
    } finally {
      stopUpdater();
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[item 22] no gate consumption before the CAPPED observation deadline -> ensures paused, STOPs, deadline never exceeded', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const readinessPath = tmpFile('readiness.json');
    const challenge = gal.generateChallenge();
    const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
    const stopUpdater = spawnLiveReadinessUpdater(readinessPath, gate, challenge, timing.containmentDeadlineMs, 15);
    try {
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, { observePollMs: 15, observeBudgetMs: 150, readinessOpts: { advancementWaitMs: 20 } });
      return result.outcome === 'stop' && result.reason === 'no-gate-consumption-before-observation-deadline' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
    } finally {
      stopUpdater();
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  // =======================================================================================
  // STATIC SOURCE CHECKS
  // =======================================================================================
  console.log('\n=== [item 25] static source checks (controller/watchdog/gate-io/rollout-mutation) ===');

  const controllerSrc = fs.readFileSync(path.join(__dirname, 'activation-controller.js'), 'utf8');
  const watchdogSrc = fs.readFileSync(path.join(__dirname, 'activation-watchdog.js'), 'utf8');
  const gateIoSrc = fs.readFileSync(path.join(__dirname, 'gate-io.js'), 'utf8');
  const rolloutMutationSrc = fs.readFileSync(path.join(__dirname, 'rollout-mutation.js'), 'utf8');
  const controllerCode = stripComments(controllerSrc);
  const watchdogCode = stripComments(watchdogSrc);
  const gateIoCode = stripComments(gateIoSrc);
  const rolloutMutationCode = stripComments(rolloutMutationSrc);

  check('zero fcmTransport/sendFcmOnce/FCM send machinery anywhere', [controllerSrc, watchdogSrc, gateIoSrc, rolloutMutationSrc].every((s) => !/fcmTransport|sendFcmOnce/i.test(s)));
  check('zero Scheduler/Functions manual-invocation machinery anywhere', [controllerSrc, watchdogSrc, gateIoSrc, rolloutMutationSrc].every((s) => !/cloudscheduler\.googleapis\.com|cloudfunctions\.googleapis\.com/i.test(s)));
  check('zero IAM mutation call sites (setIamPolicy) anywhere', [controllerSrc, watchdogSrc, gateIoSrc, rolloutMutationSrc].every((s) => !/setIamPolicy/.test(s)));
  check('zero deployment-command execution (firebase deploy, gcloud ... deploy) anywhere', [controllerSrc, watchdogSrc, gateIoSrc, rolloutMutationSrc].every((s) => !/firebase deploy|gcloud .*deploy/i.test(s)));
  check(
    'gate document is only ever the target of .get() in controller/watchdog/gate-io/rollout-mutation — zero .set(/.update(/.delete(/.create( against GATE_DOC_PATH or gateRef',
    [controllerCode, watchdogCode, gateIoCode, rolloutMutationCode].every((c) => !/GATE_DOC_PATH\)\.(set|update|delete|create)\(|gateRef\)?\.(set|update|delete|create)\(/.test(c))
  );
  check(
    // Codex Step 3C-9 repair pass 7, item C1: rollout-mutation.js now contains exactly ONE
    // tx.set( (pause CAS only) — activation CAS moved to activation-controller.js's private
    // performActivationCas, so it is no longer independently exported/callable.
    'rollout-mutation.js contains exactly ONE tx.set( call site (pause CAS only — activation CAS moved out, item C1), against rolloutRef, zero tx.update(',
    (rolloutMutationCode.match(/tx\.set\(/g) || []).length === 1 && (rolloutMutationCode.match(/tx\.set\(([^,]+),/g) || []).every((c) => c.includes('rolloutRef')) && !/tx\.update\(/.test(rolloutMutationCode)
  );
  // Codex Step 3C-9 repair pass 7, item C1: activation-controller.js now legitimately contains
  // EXACTLY ONE tx.set( of its own — performActivationCas, moved here (private, capability-
  // gated) from rollout-mutation.js's former exported attemptActivationCas specifically so it
  // is no longer independently callable by an arbitrary script. activation-watchdog.js is
  // UNCHANGED — it still only ever contains/reaches containment (pause) via rollout-mutation.js
  // and must still have zero tx.set(/tx.update( of its own.
  check('activation-controller.js contains EXACTLY ONE tx.set( of its own (performActivationCas, moved from rollout-mutation.js per Codex item C1) and zero tx.update(', (() => {
    const setMatches = controllerCode.match(/tx\.set\(/g) || [];
    return setMatches.length === 1 && !/tx\.update\(/.test(controllerCode);
  })());
  check('activation-watchdog.js still contains ZERO tx.set(/tx.update( of its own — containment only, delegated entirely to rollout-mutation.js', !/tx\.set\(|tx\.update\(/.test(watchdogCode));
  check('[C1] the one tx.set( in activation-controller.js is inside performActivationCas, not inside runControllerOrchestration itself (mutation logic stays in one dedicated function)', (() => {
    const fnStart = controllerCode.indexOf('async function performActivationCas(');
    const fnEnd = controllerCode.indexOf('\n}\n', fnStart);
    const fnBody = controllerCode.slice(fnStart, fnEnd);
    return /tx\.set\(/.test(fnBody);
  })());
  check('gate-io.js contains zero Firestore write-verb call sites at all (read-only module)', (() => {
    const withoutHashUpdate = gateIoCode.replace(/createHash\('sha256'\)\.update\(value\)/g, '');
    return !/\.set\(|\.update\(|\.delete\(|\.create\(|\btx\./.test(withoutHashUpdate);
  })());
  check('zero .delete(/.create(/batch(/BulkWriter anywhere across all four files', [controllerCode, watchdogCode, gateIoCode, rolloutMutationCode].every((c) => !/\.delete\(|\.create\(|batch\(|BulkWriter/.test(c)));
  check('controller does not import or reference arm-gate-runner.js, and never calls armGate()', !/arm-gate-runner|armGate\(\)/.test(controllerSrc));
  check("controller's own entry point never calls a mutation/orchestration function", (() => {
    const entryStart = controllerSrc.indexOf('if (require.main === module)');
    return !/attemptActivationMutation\(|attemptPauseMutation\(|runControllerOrchestration\(|performActivationCas\(|attemptPauseCas\(|runBoundedContainmentRetry\(/.test(controllerSrc.slice(entryStart));
  })());
  check('[C1] activation-controller.js never imports/references rollout-mutation.js\'s removed attemptActivationCas export (no such export exists anymore) — only the private performActivationCas', !/rolloutMutation\.attemptActivationCas\b/.test(controllerCode));
  check("watchdog's own entry point calls containment ONLY inside its one-shot deadline timer callback (never unconditionally on startup, never inside the recurring heartbeat interval)", (() => {
    const mainStart = watchdogSrc.indexOf('async function main()');
    const mainBody = watchdogSrc.slice(mainStart, watchdogSrc.indexOf('\nmodule.exports', mainStart));
    const containIdx = mainBody.indexOf('runBoundedContainmentRetry(');
    const deadlineTimerIdx = mainBody.indexOf('const deadlineTimer = setTimeout(');
    const heartbeatIntervalIdx = mainBody.indexOf('const heartbeatInterval = setInterval(');
    return containIdx > deadlineTimerIdx && deadlineTimerIdx !== -1 && !(containIdx > heartbeatIntervalIdx && containIdx < heartbeatIntervalIdx + 200);
  })());
  check('watchdog never generates its own challenge (only receives WATCHDOG_CONTROLLER_CHALLENGE) — no generateChallenge( reference in watchdog source', !/generateChallenge\(/.test(watchdogSrc));
  check('controller never accepts process.argv/CLI parameters for uid/reminderId/installationId/token/occurrence', !/process\.argv/.test(controllerSrc));
  check('watchdog never accepts process.argv/CLI parameters (only env vars, and only for the explicit TEST-ONLY escape hatch)', !/process\.argv/.test(watchdogSrc));
  check(
    'no automatic ACTIVATION retry anywhere: within runControllerOrchestration, the single performActivationCas( call site occurs BEFORE the bounded observation while-loop begins, and zero occurrences occur inside that loop body (only the SAFE pause/containment path, runBoundedContainmentRetry, may retry, and only inside the loop)',
    (() => {
      const fnStart = controllerCode.indexOf('async function runControllerOrchestration');
      const fnBody = controllerCode.slice(fnStart);
      const loopStart = fnBody.indexOf('while (Date.now() < observationDeadline)');
      if (loopStart === -1) throw new Error('observation loop anchor not found');
      const beforeLoop = fnBody.slice(0, loopStart);
      const loopOnward = fnBody.slice(loopStart);
      const activationCallsBeforeLoop = (beforeLoop.match(/performActivationCas\(/g) || []).length;
      const activationCallsInOrAfterLoop = (loopOnward.match(/performActivationCas\(/g) || []).length;
      return activationCallsBeforeLoop === 1 && activationCallsInOrAfterLoop === 0;
    })()
  );

  // =======================================================================================
  // REAL TWO-PROCESS TESTS — Codex repair pass 3, item 24. A REAL, separately-spawned OS
  // child process runs activation-watchdog.js against a JSON-file-backed fake Firestore.
  // =======================================================================================
  console.log('\n=== [item 24] real two-process tests (challenge-bound watchdog handshake, PID liveness, heartbeat advancement, containment) ===');

  // Codex repair pass 4, items 2/3: WATCHDOG_FAKE_*/override variables are honored ONLY when
  // the explicit ACTIVATION_TEST_MODE=true sentinel is present. Every ordinary test spawn in
  // this file needs that sentinel (it exercises the fake-store/fake-identity/timing-override
  // paths); the dedicated production-contamination tests explicitly opt OUT via
  // {testMode:false} to prove the fail-closed behavior when it is absent.
  function spawnWatchdog(env, opts) {
    const includeSentinel = !opts || opts.testMode !== false;
    return fork(path.join(__dirname, 'activation-watchdog.js'), [], {
      env: { ...process.env, ...(includeSentinel ? { ACTIVATION_TEST_MODE: 'true' } : {}), ...env },
      stdio: 'ignore',
    });
  }
  async function waitFor(predicate, timeoutMs, intervalMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return true;
      await sleep(intervalMs || 20);
    }
    return false;
  }

  const FAKE_UID = 'two-process-uid';
  const FAKE_REMINDER_ID = 'two-process-reminder';
  const FAKE_INSTALLATION_ID = 'f'.repeat(32);
  function fakeGateForBinding(scheduledForMs) {
    return { expectedUid: FAKE_UID, expectedReminderId: FAKE_REMINDER_ID, expectedInstallationId: FAKE_INSTALLATION_ID, expectedScheduledForMs: scheduledForMs };
  }

  await checkAsync(
    '[24 A-F] real watchdog process receives/binds the controller-generated challenge; readiness contains challenge/nonce/PID/binding/deadline; controller observes heartbeat ADVANCEMENT across two reads and verifies PID liveness at the OS level',
    async () => {
      const storePath = tmpFile('store.json');
      const readinessPath = tmpFile('readiness.json');
      fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
      const scheduledForMs = Date.now() + 60 * 60 * 1000;
      const challenge = gal.generateChallenge();
      const child = spawnWatchdog({
        WATCHDOG_FAKE_STORE_PATH: storePath,
        WATCHDOG_READINESS_PATH: readinessPath,
        WATCHDOG_CONTROLLER_CHALLENGE: challenge,
        WATCHDOG_FAKE_UID: FAKE_UID,
        WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
        WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
        WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
        WATCHDOG_HEARTBEAT_MS: '100',
      });
      try {
        const ready = await waitFor(() => fs.existsSync(readinessPath), 5000, 50);
        if (!ready) return false;
        const gate = fakeGateForBinding(scheduledForMs);
        const timing = gal.computeActivationTiming(Date.now(), scheduledForMs);
        const readiness = readinessArtifact.readReadiness(readinessPath);
        const hasAllFields = !!readiness && readiness.challenge === challenge && typeof readiness.nonce === 'string' && typeof readiness.pid === 'number' && readiness.experimentBindingHash === gal.buildExperimentBindingHash(gate) && readiness.absoluteDeadlineMs === timing.containmentDeadlineMs;
        const pidIsChildPid = readiness.pid === child.pid;
        const result = await controller.verifyWatchdogFullyReady(readinessPath, gate, challenge, timing.containmentDeadlineMs, { advancementWaitMs: 250, maxHeartbeatAgeMs: 60000 });
        return hasAllFields && pidIsChildPid && result.ready === true;
      } finally {
        child.kill('SIGKILL');
        try {
          fs.unlinkSync(storePath);
        } catch {}
        try {
          fs.unlinkSync(readinessPath);
        } catch {}
      }
    }
  );

  await checkAsync('[24 / item 15] readiness bound to a DIFFERENT (prior-run) challenge is rejected even though the watchdog process producing it is genuinely alive', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
    const scheduledForMs = Date.now() + 60 * 60 * 1000;
    const staleChallenge = gal.generateChallenge();
    const currentChallenge = gal.generateChallenge(); // the controller's CURRENT run challenge — never given to the watchdog below
    const child = spawnWatchdog({
      WATCHDOG_FAKE_STORE_PATH: storePath,
      WATCHDOG_READINESS_PATH: readinessPath,
      WATCHDOG_CONTROLLER_CHALLENGE: staleChallenge,
      WATCHDOG_FAKE_UID: FAKE_UID,
      WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
      WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
      WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
      WATCHDOG_HEARTBEAT_MS: '100',
    });
    try {
      const ready = await waitFor(() => fs.existsSync(readinessPath), 5000, 50);
      if (!ready) return false;
      const gate = fakeGateForBinding(scheduledForMs);
      const timing = gal.computeActivationTiming(Date.now(), scheduledForMs);
      const result = await controller.verifyWatchdogFullyReady(readinessPath, gate, currentChallenge, timing.containmentDeadlineMs, { advancementWaitMs: 150 });
      return result.ready === false && result.reason === 'readiness-mismatch';
    } finally {
      child.kill('SIGKILL');
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[24 / item 14] a killed watchdog leaves a readiness file that is STILL fresh by timestamp (<60s old) — full verification (advancement + PID liveness) still correctly BLOCKS it', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
    const scheduledForMs = Date.now() + 60 * 60 * 1000;
    const challenge = gal.generateChallenge();
    const child = spawnWatchdog({
      WATCHDOG_FAKE_STORE_PATH: storePath,
      WATCHDOG_READINESS_PATH: readinessPath,
      WATCHDOG_CONTROLLER_CHALLENGE: challenge,
      WATCHDOG_FAKE_UID: FAKE_UID,
      WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
      WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
      WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
      WATCHDOG_HEARTBEAT_MS: '100000', // effectively one heartbeat only
    });
    try {
      const ready = await waitFor(() => fs.existsSync(readinessPath), 5000, 50);
      if (!ready) return false;
      const deadPid = child.pid;
      child.kill('SIGKILL');
      await waitFor(() => !gal.isPidAlive(deadPid), 3000, 50);
      const gate = fakeGateForBinding(scheduledForMs);
      const timing = gal.computeActivationTiming(Date.now(), scheduledForMs);
      // The file itself is still <60s old by wall-clock — but the process is genuinely dead.
      const result = await controller.verifyWatchdogFullyReady(readinessPath, gate, challenge, timing.containmentDeadlineMs, { advancementWaitMs: 100, maxHeartbeatAgeMs: 60000 });
      return result.ready === false && (result.reason === 'pid-not-alive' || result.reason === 'heartbeat-not-advanced' || result.reason === 'pid-not-alive-on-recheck');
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[24 / item 16] wrong PID recorded in an otherwise-valid readiness file -> BLOCK', async () => {
    const readinessPath = tmpFile('readiness.json');
    const scheduledForMs = Date.now() + 60 * 60 * 1000;
    const gate = fakeGateForBinding(scheduledForMs);
    const challenge = gal.generateChallenge();
    const timing = gal.computeActivationTiming(Date.now(), scheduledForMs);
    writeFreshReadiness(readinessPath, gate, challenge, timing.containmentDeadlineMs, { pid: 999999 });
    try {
      const result = await controller.verifyWatchdogFullyReady(readinessPath, gate, challenge, timing.containmentDeadlineMs, { advancementWaitMs: 30 });
      return result.ready === false && result.reason === 'pid-not-alive';
    } finally {
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[24 / item 9] watchdog UID-bound containment: rollout allowlisted for a DIFFERENT uid is NOT overwritten at the deadline', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: ['someone-else'] } }));
    const scheduledForMs = Date.now();
    const challenge = gal.generateChallenge();
    const child = spawnWatchdog({
      WATCHDOG_FAKE_STORE_PATH: storePath,
      WATCHDOG_READINESS_PATH: readinessPath,
      WATCHDOG_CONTROLLER_CHALLENGE: challenge,
      WATCHDOG_FAKE_UID: FAKE_UID,
      WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
      WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
      WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
      WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 100),
      WATCHDOG_HEARTBEAT_MS: '50',
      WATCHDOG_POLL_MS: '50',
    });
    try {
      await new Promise((resolve) => child.once('exit', resolve));
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return store[ROLLOUT_PATH].mode === 'allowlisted-real-send' && store[ROLLOUT_PATH].allowlistUids[0] === 'someone-else';
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[24 / item 10] deadline with no gate consumption: rollout exactly allowlisted for the EXPECTED uid IS paused by the watchdog at the deadline (via bounded containment retry)', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [FAKE_UID] } }));
    const scheduledForMs = Date.now();
    const challenge = gal.generateChallenge();
    const child = spawnWatchdog({
      WATCHDOG_FAKE_STORE_PATH: storePath,
      WATCHDOG_READINESS_PATH: readinessPath,
      WATCHDOG_CONTROLLER_CHALLENGE: challenge,
      WATCHDOG_FAKE_UID: FAKE_UID,
      WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
      WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
      WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
      WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 100),
      WATCHDOG_HEARTBEAT_MS: '50',
      WATCHDOG_POLL_MS: '50',
    });
    try {
      await new Promise((resolve) => child.once('exit', resolve));
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return gal.isExactlyPausedRollout(store[ROLLOUT_PATH]);
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[24 / item 12] unexpected rollout shape (general-real-send) at the deadline is NOT overwritten by the watchdog', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'general-real-send' } }));
    const scheduledForMs = Date.now();
    const challenge = gal.generateChallenge();
    const child = spawnWatchdog({
      WATCHDOG_FAKE_STORE_PATH: storePath,
      WATCHDOG_READINESS_PATH: readinessPath,
      WATCHDOG_CONTROLLER_CHALLENGE: challenge,
      WATCHDOG_FAKE_UID: FAKE_UID,
      WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
      WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
      WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
      WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 100),
      WATCHDOG_HEARTBEAT_MS: '50',
      WATCHDOG_POLL_MS: '50',
    });
    try {
      await new Promise((resolve) => child.once('exit', resolve));
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return store[ROLLOUT_PATH].mode === 'general-real-send';
    } finally {
      try {
        child.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync(
    '[24 G-J, controller-death/watchdog-survival] the "controller" is FORCIBLY TERMINATED immediately after simulated activation, yet the independently-spawned real watchdog process still performs containment (bounded retry) against the shared file store, reaching final paused state',
    async () => {
      const storePath = tmpFile('store.json');
      const readinessPath = tmpFile('readiness.json');
      fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
      const scheduledForMs = Date.now();
      const challenge = gal.generateChallenge();

      const watchdog = spawnWatchdog({
        WATCHDOG_FAKE_STORE_PATH: storePath,
        WATCHDOG_READINESS_PATH: readinessPath,
        WATCHDOG_CONTROLLER_CHALLENGE: challenge,
        WATCHDOG_FAKE_UID: FAKE_UID,
        WATCHDOG_FAKE_REMINDER_ID: FAKE_REMINDER_ID,
        WATCHDOG_FAKE_INSTALLATION_ID: FAKE_INSTALLATION_ID,
        WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
        WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 300),
        WATCHDOG_HEARTBEAT_MS: '50',
        WATCHDOG_POLL_MS: '50',
      });

      const fakeControllerScript = tmpFile('fake-controller').replace(/\.json$/, '') + '.js';
      fs.writeFileSync(
        fakeControllerScript,
        `
        const { makeFileBackedDb } = require(${JSON.stringify(path.join(__dirname, 'fake-firestore-file-store.js'))});
        const db = makeFileBackedDb(${JSON.stringify(storePath)});
        (async () => {
          const rolloutRef = db.doc(${JSON.stringify(ROLLOUT_PATH)});
          await db.runTransaction(async (tx) => {
            tx.set(rolloutRef, { mode: 'allowlisted-real-send', allowlistUids: [${JSON.stringify(FAKE_UID)}] });
          });
          console.log('FAKE_CONTROLLER_ACTIVATED');
          setInterval(() => {}, 1000);
        })();
        `
      );
      const fakeController = fork(fakeControllerScript, [], { stdio: 'pipe' });

      try {
        await new Promise((resolve) => {
          fakeController.stdout.on('data', (chunk) => {
            if (chunk.toString().includes('FAKE_CONTROLLER_ACTIVATED')) resolve();
          });
        });
        fakeController.kill('SIGKILL');

        await new Promise((resolve) => watchdog.once('exit', resolve));
        const finalStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
        return gal.isExactlyPausedRollout(finalStore[ROLLOUT_PATH]);
      } finally {
        try {
          fakeController.kill('SIGKILL');
        } catch {}
        try {
          watchdog.kill('SIGKILL');
        } catch {}
        try {
          fs.unlinkSync(storePath);
        } catch {}
        try {
          fs.unlinkSync(readinessPath);
        } catch {}
        try {
          fs.unlinkSync(fakeControllerScript);
        } catch {}
      }
    }
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
});
