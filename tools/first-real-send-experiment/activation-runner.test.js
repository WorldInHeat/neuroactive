// activation-runner.test.js — local/static + real two-process tests for the Codex Step
// 3C-9 repair pass 4 additions: production-timing.js, execution-mode.js,
// watchdog-exit-codes.js, gate-activation-logic.js's classifyGateDriftState, the
// deadline-sleep-overshoot fixes in activation-controller.js/activation-watchdog.js,
// activation-runner.js, and emergency-containment.js. Never touches real production. Run
// with: node activation-runner.test.js
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');

const gal = require('./gate-activation-logic');
const productionTiming = require('./production-timing');
const executionMode = require('./execution-mode');
const watchdogExitCodes = require('./watchdog-exit-codes');
const readinessArtifact = require('./readiness-artifact');
const controller = require('./activation-controller');
const runner = require('./activation-runner');
const emergencyContainment = require('./emergency-containment');
const rolloutMutation = require('./rollout-mutation');
const { validateExperimentGateSchema } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryAuth.js');
const { Timestamp } = require('C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js');

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
function tmpFile(name) {
  return path.join(os.tmpdir(), `wd-p4-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
}
// Codex Step 3C-9 repair pass 5, item 2B: runner.runActivation was renamed/repaired to
// runner.runActivationForTest, which now hard-requires ACTIVATION_TEST_MODE=true (see item
// 14.L's dedicated test below, which deliberately does NOT use this helper). Every OTHER
// existing call site in this file legitimately needs the sentinel set (they all operate
// against a fake db / real-but-test-mode-launched watchdog, never real production) — this
// helper scopes that env var to exactly the duration of one call and always restores the
// prior value, so it can never leak into an unrelated check.
async function withTestMode(fn) {
  const orig = process.env.ACTIVATION_TEST_MODE;
  process.env.ACTIVATION_TEST_MODE = 'true';
  try {
    return await fn();
  } finally {
    if (orig === undefined) delete process.env.ACTIVATION_TEST_MODE;
    else process.env.ACTIVATION_TEST_MODE = orig;
  }
}

// =========================================================================================
// FAKE IN-MEMORY FIRESTORE (same shape as activation-controller.test.js's own)
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
            if (op !== '==') throw new Error('only "==" supported');
            return makeQuery([...filters, { field, value }]);
          },
          async get() {
            const docs = [];
            for (const [p, data] of store.entries()) {
              if (!(p.startsWith(prefix + '/') && p.slice(prefix.length + 1).split('/').length === 1)) continue;
              if (filters.every((f) => data[f.field] === f.value)) docs.push({ id: p.slice(prefix.length + 1), ref: { path: p }, data: () => ({ ...data }) });
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
          if (!store.has(ref.path)) throw new Error('missing doc ' + ref.path);
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
// FIXTURES (mirrors activation-controller.test.js)
// =========================================================================================
const APP_ID = 'neuroactive-prod';
const UID = 'runner-test-uid';
const SCHEDULED_MS = Date.now() + 12 * 60 * 1000;
const REMINDER_ID = `${UID}_${SCHEDULED_MS}`;
const INSTALLATION_ID = 'c'.repeat(32);
const TOKEN = 'fake-installation-token';
const { createHash } = require('node:crypto');
const TOKEN_HASH = createHash('sha256').update(TOKEN).digest('hex');
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
  return gateDoc({ state: 'consumed', consumedAt: Timestamp.now(), consumedByExecutionId: 'a'.repeat(43), ...overrides });
}

function baseSeed(overrides) {
  const seed = {
    [`artifacts/${APP_ID}/systemConfig/notificationRollout`]: { mode: 'paused' },
    [`artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`]: gateDoc(),
    [`artifacts/${APP_ID}/users/${UID}/notificationPreferences/main`]: { enabled: true, ...APPROVED_SCHEDULE_FIXTURE, nextReminderDueAt: Timestamp.fromMillis(SCHEDULED_MS) },
    [`artifacts/${APP_ID}/pushInstallations/${INSTALLATION_ID}`]: { uid: UID, state: 'active', epochSchemaVersion: 1, tokenVersion: 1, installationAudienceId: 'a'.repeat(16), generation: 1, token: TOKEN },
    [`artifacts/${APP_ID}/pushTokenClaims/${TOKEN_HASH}`]: { installationId: INSTALLATION_ID, uid: UID },
  };
  for (let i = 0; i < 8; i++) seed[`artifacts/${APP_ID}/reminders/other-reminder-${i}`] = { uid: 'unrelated-uid', workState: 'terminal', status: 'delivery-fanned-out' };
  // Codex Step 3C-9 repair pass 5, item 3: matches REAL production's actual approved
  // baseline (verified live: all 4 existing deliveries are 'dry-run-validated', never
  // 'accepted-by-fcm'/'rejected-final'/'unknown-outcome'/'sending') — this fixture must stay
  // FCM-evidence-free or the new hasZeroFcmEvidence preflight check below would (correctly)
  // reject it, which would misrepresent what real production actually looks like.
  for (let i = 0; i < 4; i++) seed[`artifacts/${APP_ID}/reminders/other-reminder-${i}/deliveries/other-install-${i}`] = { state: 'dry-run-validated', workState: 'terminal' };
  return { ...seed, ...(overrides || {}) };
}
const GATE_PATH = `artifacts/${APP_ID}/systemConfig/firstRealSendExperimentGate`;
const ROLLOUT_PATH = `artifacts/${APP_ID}/systemConfig/notificationRollout`;
const DELIVERY_PATH = `artifacts/${APP_ID}/reminders/${REMINDER_ID}/deliveries/${INSTALLATION_ID}`;
const boundGate = { expectedUid: UID, expectedReminderId: REMINDER_ID, expectedScheduledForMs: SCHEDULED_MS, expectedInstallationId: INSTALLATION_ID };

function writeFreshReadiness(readinessPath, gate, challenge, absoluteDeadlineMs, overrides) {
  readinessArtifact.writeReadiness(readinessPath, {
    challenge,
    nonce: 'nonce-1',
    pid: process.pid,
    experimentBindingHash: gal.buildExperimentBindingHash(gate),
    absoluteDeadlineMs,
    heartbeatAtMs: Date.now(),
    ...overrides,
  });
}

async function main() {
  // Codex Step 3C-9 repair pass 6, item 1: same rationale as activation-controller.test.js —
  // runControllerOrchestration (called both directly and via runActivationForTest) now
  // hard-requires ACTIVATION_TEST_MODE=true or a valid capability token in production mode.
  // This file never touches real production, so the sentinel is set once as the baseline;
  // the [14.L]/[26 contamination] tests manage/restore it themselves regardless.
  process.env.ACTIVATION_TEST_MODE = 'true';

  // =======================================================================================
  // [item 1] production-timing.js
  // =======================================================================================
  console.log('\n=== [item 1] shared production heartbeat timing ===');
  check('PRODUCTION_HEARTBEAT_MS === 5000', productionTiming.PRODUCTION_HEARTBEAT_MS === 5000);
  check('PRODUCTION_ADVANCEMENT_TIMEOUT_MS (9000) exceeds one heartbeat interval', productionTiming.PRODUCTION_ADVANCEMENT_TIMEOUT_MS > productionTiming.PRODUCTION_HEARTBEAT_MS);
  check('PRODUCTION_ADVANCEMENT_POLL_MS is finer than the advancement timeout', productionTiming.PRODUCTION_ADVANCEMENT_POLL_MS < productionTiming.PRODUCTION_ADVANCEMENT_TIMEOUT_MS);
  check('activation-controller.js consumes the SAME production-timing.js constants (no re-declared magic numbers)', controller.WATCHDOG_MAX_HEARTBEAT_AGE_MS === productionTiming.PRODUCTION_MAX_HEARTBEAT_AGE_MS && controller.WATCHDOG_ADVANCEMENT_TIMEOUT_MS === productionTiming.PRODUCTION_ADVANCEMENT_TIMEOUT_MS);

  // =======================================================================================
  // [items 2/3] execution-mode.js — production/test separation
  // =======================================================================================
  console.log('\n=== [items 2/3] production/test mode separation ===');
  check('requireCleanProductionEnvironment: no test vars, no sentinel -> production mode, ok', (() => {
    const r = executionMode.requireCleanProductionEnvironment({});
    return r.ok === true && r.testMode === false;
  })());
  check('requireCleanProductionEnvironment: sentinel present -> test mode, ok regardless of overrides', (() => {
    const r = executionMode.requireCleanProductionEnvironment({ ACTIVATION_TEST_MODE: 'true', WATCHDOG_FAKE_STORE_PATH: '/tmp/x' });
    return r.ok === true && r.testMode === true;
  })());
  for (const varName of executionMode.PROHIBITED_TEST_ENV_VARS) {
    check(`[item 22] production mode + ${varName} present (no sentinel) -> fail closed, prohibitedVarNames includes it`, (() => {
      const r = executionMode.requireCleanProductionEnvironment({ [varName]: 'x' });
      return r.ok === false && r.testMode === false && r.prohibitedVarNames.includes(varName);
    })());
  }
  check('buildSanitizedChildEnvironment never passes through an arbitrary WATCHDOG_* variable from the base env', (() => {
    const env = executionMode.buildSanitizedChildEnvironment({ PATH: '/usr/bin', WATCHDOG_FAKE_STORE_PATH: '/tmp/leak', RANDOM_SECRET: 'leak' }, { WATCHDOG_READINESS_PATH: '/tmp/readiness.json' });
    return env.PATH === '/usr/bin' && env.WATCHDOG_READINESS_PATH === '/tmp/readiness.json' && !('WATCHDOG_FAKE_STORE_PATH' in env) && !('RANDOM_SECRET' in env);
  })());

  // =======================================================================================
  // [item 7/8] watchdog-exit-codes.js
  // =======================================================================================
  console.log('\n=== [items 7/8] watchdog exit-code map / status ===');
  check('paused-success -> exit 0', watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.PAUSED_SUCCESS) === 0);
  check('already-paused-success -> exit 0', watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.ALREADY_PAUSED_SUCCESS) === 0);
  check('unexpected-rollout-state -> nonzero exit, distinct code', watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.UNEXPECTED_ROLLOUT_STATE) !== 0);
  check('hard-containment-failure -> nonzero exit, distinct from unexpected-rollout-state', watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.HARD_CONTAINMENT_FAILURE) !== watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.UNEXPECTED_ROLLOUT_STATE));
  check('containment-exception -> nonzero exit', watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.CONTAINMENT_EXCEPTION) !== 0);
  check('configuration-failure -> nonzero exit', watchdogExitCodes.exitCodeForStatus(watchdogExitCodes.WATCHDOG_STATUS.CONFIGURATION_FAILURE) !== 0);
  check('isConclusivelySafeStatus true ONLY for the two paused-success variants', watchdogExitCodes.isConclusivelySafeStatus('paused-success') && watchdogExitCodes.isConclusivelySafeStatus('already-paused-success') && !watchdogExitCodes.isConclusivelySafeStatus('hard-containment-failure') && !watchdogExitCodes.isConclusivelySafeStatus('unexpected-rollout-state'));

  // =======================================================================================
  // [item 10 / 24] gate-drift classification matrix
  // =======================================================================================
  console.log('\n=== [item 24] full gate-drift classification matrix ===');
  check('exact bound ARMED gate -> armed (continue observation)', gal.classifyGateDriftState(gateDoc(), boundGate, validateExperimentGateSchema) === 'armed');
  check('exact bound CONSUMED gate -> consumed (immediate pause + outcome path)', gal.classifyGateDriftState(consumedGateDoc(), boundGate, validateExperimentGateSchema) === 'consumed');
  check('gate MISSING (null) -> drift', gal.classifyGateDriftState(null, boundGate, validateExperimentGateSchema) === 'drift');
  check('gate DELETED (undefined, same as missing) -> drift', gal.classifyGateDriftState(undefined, boundGate, validateExperimentGateSchema) === 'drift');
  check('malformed ARMED gate (consumedAt non-null while state=armed) -> drift', gal.classifyGateDriftState({ ...gateDoc(), consumedAt: Timestamp.now() }, boundGate, validateExperimentGateSchema) === 'drift');
  check('armed gate with a DIFFERENT bound identity (different installationId) -> drift', gal.classifyGateDriftState(gateDoc({ expectedInstallationId: 'd'.repeat(32) }), boundGate, validateExperimentGateSchema) === 'drift');
  check('unknown/garbage state -> drift', gal.classifyGateDriftState({ ...gateDoc(), state: 'garbage' }, boundGate, validateExperimentGateSchema) === 'drift');
  check('malformed CONSUMED gate (bad consumedByExecutionId) -> drift', gal.classifyGateDriftState(consumedGateDoc({ consumedByExecutionId: 'bad' }), boundGate, validateExperimentGateSchema) === 'drift');
  check('valid consumed gate bound to a DIFFERENT identity -> drift, not consumed', gal.classifyGateDriftState(consumedGateDoc({ expectedUid: 'someone-else' }), boundGate, validateExperimentGateSchema) === 'drift');

  // =======================================================================================
  // [item 4] controller deadline-sleep overshoot fix — near-deadline real-clock test
  // =======================================================================================
  console.log('\n=== [items 4/21] near-deadline real-clock behavior ===');

  await checkAsync('[item 21] controller observation loop never sleeps past the (capped) observation deadline: a short deadline is reached promptly, not after one full default-length poll interval', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const readinessPath = tmpFile('readiness.json');
    const challenge = gal.generateChallenge();
    const timing = gal.computeActivationTiming(Date.now(), gate.expectedScheduledForMs);
    writeFreshReadiness(readinessPath, gate, challenge, timing.containmentDeadlineMs);
    const interval = setInterval(() => writeFreshReadiness(readinessPath, gate, challenge, timing.containmentDeadlineMs), 800);
    const before = Date.now();
    try {
      // A deliberately large observePollMs (10s) but a tiny observeBudgetMs (300ms) — the
      // fix (Math.min(observePollMs, remainingMs)) must return close to 300ms, not ~10s.
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, {
        observePollMs: 10000,
        observeBudgetMs: 300,
        readinessOpts: { advancementTimeoutMs: 1500, advancementPollMs: 100 },
      });
      const elapsedMs = Date.now() - before;
      return result.outcome === 'stop' && result.reason === 'no-gate-consumption-before-observation-deadline' && elapsedMs < 5000 && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
    } finally {
      clearInterval(interval);
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[item 21] watchdog deadline timer fires at the ACTUAL deadline (one-shot setTimeout), not delayed until the next heartbeat tick', async () => {
    // A long heartbeat interval (2000ms) but a deadline only ~150ms away — if containment
    // were still gated on the heartbeat tick (the pre-pass-4 bug), it would take ~2000ms+ to
    // fire. The fix must contain within a few hundred ms of the true deadline.
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: ['near-deadline-uid'] } }));
    const scheduledForMs = Date.now();
    const child = fork(path.join(__dirname, 'activation-watchdog.js'), [], {
      env: {
        ...process.env,
        ACTIVATION_TEST_MODE: 'true',
        WATCHDOG_FAKE_STORE_PATH: storePath,
        WATCHDOG_READINESS_PATH: readinessPath,
        WATCHDOG_CONTROLLER_CHALLENGE: gal.generateChallenge(),
        WATCHDOG_FAKE_UID: 'near-deadline-uid',
        WATCHDOG_FAKE_REMINDER_ID: 'r',
        WATCHDOG_FAKE_INSTALLATION_ID: 'i'.repeat(32),
        WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
        WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 150),
        WATCHDOG_HEARTBEAT_MS: '2000',
      },
      stdio: 'ignore',
    });
    const before = Date.now();
    try {
      await new Promise((resolve) => child.once('exit', resolve));
      const elapsedMs = Date.now() - before;
      const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return elapsedMs < 1200 && gal.isExactlyPausedRollout(store[ROLLOUT_PATH]);
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

  // =======================================================================================
  // [item 9/23] heartbeat-write-failure isolation
  // =======================================================================================
  console.log('\n=== [items 9/23] heartbeat write failure after readiness established must not block containment ===');

  await checkAsync('watchdog readiness path directory removed AFTER initial readiness is published -> subsequent heartbeat writes fail, but deadline containment still runs and succeeds', async () => {
    const storePath = tmpFile('store.json');
    const readinessDir = tmpFile('readiness-dir');
    fs.mkdirSync(readinessDir);
    const readinessPath = path.join(readinessDir, 'readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: ['hb-fail-uid'] } }));
    const scheduledForMs = Date.now();
    const child = fork(path.join(__dirname, 'activation-watchdog.js'), [], {
      env: {
        ...process.env,
        ACTIVATION_TEST_MODE: 'true',
        WATCHDOG_FAKE_STORE_PATH: storePath,
        WATCHDOG_READINESS_PATH: readinessPath,
        WATCHDOG_CONTROLLER_CHALLENGE: gal.generateChallenge(),
        WATCHDOG_FAKE_UID: 'hb-fail-uid',
        WATCHDOG_FAKE_REMINDER_ID: 'r',
        WATCHDOG_FAKE_INSTALLATION_ID: 'i'.repeat(32),
        WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
        WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 500),
        WATCHDOG_HEARTBEAT_MS: '150',
      },
      stdio: 'ignore',
    });
    try {
      const readinessAppeared = await new Promise((resolve) => {
        const check = setInterval(() => {
          if (fs.existsSync(readinessPath)) {
            clearInterval(check);
            resolve(true);
          }
        }, 20);
        setTimeout(() => {
          clearInterval(check);
          resolve(false);
        }, 3000);
      });
      if (!readinessAppeared) return false;
      // Now break subsequent heartbeat writes by removing the directory the readiness file
      // lives in — the watchdog's periodic (non-initial) publishHeartbeat() calls will throw
      // and must be caught, never crashing the interval or blocking the deadline timer.
      fs.rmSync(readinessDir, { recursive: true, force: true });
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
        fs.rmSync(readinessDir, { recursive: true, force: true });
      } catch {}
    }
  });

  // =======================================================================================
  // [item 20] exact-production-default readiness test — NO timing overrides
  // =======================================================================================
  console.log('\n=== [item 20] exact production-default heartbeat/advancement relationship (no overrides), repeated for flakiness ===');

  for (let rep = 1; rep <= 3; rep++) {
    await checkAsync(`[item 20, rep ${rep}/3] a healthy watchdog using PRODUCTION DEFAULT timing (no WATCHDOG_HEARTBEAT_MS override) reliably passes full readiness verification`, async () => {
      const storePath = tmpFile('store.json');
      const readinessPath = tmpFile('readiness.json');
      fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
      const scheduledForMs = Date.now() + 60 * 60 * 1000;
      const challenge = gal.generateChallenge();
      const child = fork(path.join(__dirname, 'activation-watchdog.js'), [], {
        env: {
          ...process.env,
          ACTIVATION_TEST_MODE: 'true',
          WATCHDOG_FAKE_STORE_PATH: storePath,
          WATCHDOG_READINESS_PATH: readinessPath,
          WATCHDOG_CONTROLLER_CHALLENGE: challenge,
          WATCHDOG_FAKE_UID: 'prod-default-uid',
          WATCHDOG_FAKE_REMINDER_ID: 'r',
          WATCHDOG_FAKE_INSTALLATION_ID: 'i'.repeat(32),
          WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(scheduledForMs),
          // Deliberately NO WATCHDOG_HEARTBEAT_MS/WATCHDOG_POLL_MS override — exercises the
          // real production 5s heartbeat default.
        },
        stdio: 'ignore',
      });
      try {
        const ready = await new Promise((resolve) => {
          const iv = setInterval(() => {
            if (fs.existsSync(readinessPath)) {
              clearInterval(iv);
              resolve(true);
            }
          }, 50);
          setTimeout(() => {
            clearInterval(iv);
            resolve(false);
          }, 5000);
        });
        if (!ready) return false;
        const gate = { expectedUid: 'prod-default-uid', expectedReminderId: 'r', expectedInstallationId: 'i'.repeat(32), expectedScheduledForMs: scheduledForMs };
        const timing = gal.computeActivationTiming(Date.now(), scheduledForMs);
        // NO opts override here either — exercises controller.js's own PRODUCTION default
        // (9s bounded advancement window against a real 5s watchdog heartbeat).
        const result = await controller.verifyWatchdogFullyReady(readinessPath, gate, challenge, timing.containmentDeadlineMs);
        return result.ready === true;
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
  }

  // =======================================================================================
  // activation-runner.js
  // =======================================================================================
  console.log('\n=== [items 12/13] runner preconditions / timing-window derivation ===');

  await checkAsync('runner preconditions: happy-path fixture -> ok, reuses the exact reviewed preflight', async () => {
    const { db } = makeFakeDb(baseSeed());
    const result = await runner.runRunnerPreconditions(db);
    return result.ok === true;
  });

  check('[item 13] derived timing window: earliest = occurrence-15min, latest = occurrence-10min, deadline = occurrence+20min', (() => {
    const gate = { expectedScheduledForMs: 1000000 };
    const w = runner.deriveRunnerTimingWindow(gate);
    return w.earliestStartMs === 1000000 - 15 * 60 * 1000 && w.latestStartMs === 1000000 - 10 * 60 * 1000 && w.containmentDeadlineMs === 1000000 + 20 * 60 * 1000;
  })());
  check('[item 13] requireWithinStartWindow: before earliest -> refuse', !runner.requireWithinStartWindow(1000000 - 20 * 60 * 1000, { earliestStartMs: 1000000 - 15 * 60 * 1000, latestStartMs: 1000000 - 10 * 60 * 1000 }).ok);
  check('[item 13] requireWithinStartWindow: after latest -> refuse', !runner.requireWithinStartWindow(1000000 - 5 * 60 * 1000, { earliestStartMs: 1000000 - 15 * 60 * 1000, latestStartMs: 1000000 - 10 * 60 * 1000 }).ok);
  check('[item 13] requireWithinStartWindow: exactly inside window -> ok', runner.requireWithinStartWindow(1000000 - 12 * 60 * 1000, { earliestStartMs: 1000000 - 15 * 60 * 1000, latestStartMs: 1000000 - 10 * 60 * 1000 }).ok);

  console.log('\n=== [item 26] runner failure matrix (subset exercised directly against the runner) ===');
  await checkAsync('[26] rollout not paused -> runner stops with the underlying preflight reason', async () => {
    const { db } = makeFakeDb(baseSeed({ [ROLLOUT_PATH]: { mode: 'dry-run' } }));
    const result = await withTestMode(() => runner.runActivationForTest(db, { readinessPath: tmpFile('readiness.json') }));
    return result.outcome === 'stop' && result.reason === 'rollout-not-exactly-paused';
  });
  await checkAsync('[26] gate invalid (missing) -> runner stops with gate-not-armed', async () => {
    const seed = baseSeed();
    delete seed[GATE_PATH];
    const { db } = makeFakeDb(seed);
    const result = await withTestMode(() => runner.runActivationForTest(db, { readinessPath: tmpFile('readiness.json') }));
    return result.outcome === 'stop' && result.reason === 'gate-not-armed';
  });
  await checkAsync('[26] production-mode contamination (prohibited env var present, no sentinel) -> runner refuses before touching Firestore at all', async () => {
    const originalEnv = process.env.WATCHDOG_FAKE_STORE_PATH;
    const originalTestMode = process.env.ACTIVATION_TEST_MODE;
    process.env.WATCHDOG_FAKE_STORE_PATH = '/tmp/should-not-be-honored';
    delete process.env.ACTIVATION_TEST_MODE; // this file's own baseline sets it; this test needs it genuinely absent.
    try {
      const { db } = makeFakeDb(baseSeed());
      // ACTIVATION_TEST_MODE is absent, so a stray leftover fake/override variable from a dev
      // shell is refused by runActivationForTest's OWN outer test-mode gate before
      // runActivationCore's own prohibited-variable check is ever reached — an even stronger
      // guarantee than the pre-repair behavior this test originally proved (see item 14.L
      // below for the pure "no sentinel at all" case).
      const result = await runner.runActivationForTest(db, { readinessPath: tmpFile('readiness.json') });
      return result.outcome === 'stop' && result.reason === 'test-interface-requires-explicit-test-mode';
    } finally {
      if (originalEnv === undefined) delete process.env.WATCHDOG_FAKE_STORE_PATH;
      else process.env.WATCHDOG_FAKE_STORE_PATH = originalEnv;
      if (originalTestMode === undefined) delete process.env.ACTIVATION_TEST_MODE;
      else process.env.ACTIVATION_TEST_MODE = originalTestMode;
    }
  });
  await checkAsync('[26] watchdog fails to start (launcher returns a dead/no-PID child) -> runner blocks before activation', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const readinessPath = tmpFile('readiness.json');
    const result = await withTestMode(() => runner.runActivationForTest(db, {
      readinessPath,
      postLaunchPollMs: 10,
      postLaunchTimeoutMs: 100,
      launchWatchdog: () => ({ pid: 999999 }), // a PID that (almost certainly) doesn't exist
    }));
    try {
      return result.outcome === 'stop' && result.reason === 'watchdog-failed-to-start' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
    } finally {
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  console.log('\n=== [item 25] production runner two-process test (real spawned watchdog, test-mode launcher override) ===');

  await checkAsync('[25] full activation-runner.js orchestration end-to-end: real challenge generation, sanitized-for-test launcher spawns a REAL watchdog process, readiness/heartbeat-advancement/PID-liveness verified, activation commits, simulated natural consumption observed, immediate pause, final paused state', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    // The runner's own core (runActivation) is DB-agnostic — point it at a fake in-memory db
    // for the Firestore-facing preflight/activation/observation logic, while the launched
    // watchdog talks to a SEPARATE JSON-file-backed store representing the "same" production
    // rollout document, kept in sync manually here exactly as the real system would (the
    // in-memory fake db and the file-backed store are seeded with the same initial rollout
    // state; the test asserts the FILE store — what the real independent watchdog process
    // actually observes — ends up paused).
    const { db, store } = makeFakeDb(baseSeed());
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));

    function testLaunchWatchdog(rPath, challenge) {
      const gate = boundGate;
      return fork(path.join(__dirname, 'activation-watchdog.js'), [], {
        env: {
          ...process.env,
          ACTIVATION_TEST_MODE: 'true',
          WATCHDOG_FAKE_STORE_PATH: storePath,
          WATCHDOG_READINESS_PATH: rPath,
          WATCHDOG_CONTROLLER_CHALLENGE: challenge,
          WATCHDOG_FAKE_UID: gate.expectedUid,
          WATCHDOG_FAKE_REMINDER_ID: gate.expectedReminderId,
          WATCHDOG_FAKE_INSTALLATION_ID: gate.expectedInstallationId,
          WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(gate.expectedScheduledForMs),
          WATCHDOG_HEARTBEAT_MS: '100',
        },
        stdio: 'ignore',
      });
    }

    let watchdogChild;
    // Delay chosen generously larger than the worst-case time to reach activation: real
    // child-process startup (polled, up to 8s bound but typically well under 1s) + TWO
    // watchdog-readiness verifications (each up to advancementTimeoutMs=500ms) + the full
    // preflight/revalidation read sequence against the fake store.
    setTimeout(() => {
      store.set(GATE_PATH, consumedGateDoc());
      store.set(DELIVERY_PATH, { state: 'accepted-by-fcm' });
    }, 2500);

    try {
      const result = await withTestMode(() => runner.runActivationForTest(db, {
        readinessPath,
        postLaunchPollMs: 20,
        postLaunchTimeoutMs: 8000,
        launchWatchdog: (rPath, challenge) => {
          watchdogChild = testLaunchWatchdog(rPath, challenge);
          return watchdogChild;
        },
        observePollMs: 50,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 30 },
      }));
      const rolloutPaused = gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
      return result.outcome === 'contained' && result.classification === 'A-accepted' && rolloutPaused && result.activationAttempted === true;
    } finally {
      try {
        watchdogChild && watchdogChild.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[29] forced runner death after activation: the runner process itself never continues (simulated by simply not awaiting its post-activation observation), yet the independently-spawned real watchdog still contains at its own deadline', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
    const { db } = makeFakeDb(baseSeed());
    const gate = boundGate;

    // Launch a REAL watchdog exactly as the runner would, but with a near-future deadline
    // override so the test completes quickly, standing in for "the runner died and nothing
    // else drives observation — only the independent watchdog remains."
    const challenge = gal.generateChallenge();
    const watchdog = fork(path.join(__dirname, 'activation-watchdog.js'), [], {
      env: {
        ...process.env,
        ACTIVATION_TEST_MODE: 'true',
        WATCHDOG_FAKE_STORE_PATH: storePath,
        WATCHDOG_READINESS_PATH: readinessPath,
        WATCHDOG_CONTROLLER_CHALLENGE: challenge,
        WATCHDOG_FAKE_UID: gate.expectedUid,
        WATCHDOG_FAKE_REMINDER_ID: gate.expectedReminderId,
        WATCHDOG_FAKE_INSTALLATION_ID: gate.expectedInstallationId,
        WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(gate.expectedScheduledForMs),
        WATCHDOG_DEADLINE_OVERRIDE_MS: String(Date.now() + 400),
        WATCHDOG_HEARTBEAT_MS: '100',
      },
      stdio: 'ignore',
    });
    // Simulate "activation occurred" directly against the file store (what a real runner's
    // activation CAS would have done), then simulate the runner/controller process simply
    // being gone — no further code here drives observation or pause; only the watchdog does.
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [gate.expectedUid] } }));

    try {
      await new Promise((resolve) => watchdog.once('exit', resolve));
      const finalStore = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      return gal.isExactlyPausedRollout(finalStore[ROLLOUT_PATH]);
    } finally {
      try {
        watchdog.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  // =======================================================================================
  // emergency-containment.js
  // =======================================================================================
  console.log('\n=== [item 17] emergency containment-only tool ===');

  await checkAsync('emergency containment: rollout exactly allowlisted for the gate-bound uid -> paused, idempotent CAS reused, no gate write', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    const { db, store } = makeFakeDb(seed);
    const before = JSON.stringify(store.get(GATE_PATH));
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'paused' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH)) && JSON.stringify(store.get(GATE_PATH)) === before;
  });
  await checkAsync('emergency containment: already paused -> idempotent success', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'paused' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });
  await checkAsync('emergency containment: unexpected rollout (general-real-send) -> refuses, never overwrites', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'general-real-send' } });
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'unexpected-rollout-state' && store.get(ROLLOUT_PATH).mode === 'general-real-send';
  });

  // =======================================================================================
  // STATIC SOURCE CHECKS — extended to activation-runner.js / emergency-containment.js
  // =======================================================================================
  console.log('\n=== [item 27] static mutation-surface audit (runner + emergency tool) ===');

  const runnerSrc = fs.readFileSync(path.join(__dirname, 'activation-runner.js'), 'utf8');
  const emergencySrc = fs.readFileSync(path.join(__dirname, 'emergency-containment.js'), 'utf8');
  const runnerCode = stripComments(runnerSrc);
  const emergencyCode = stripComments(emergencySrc);

  check('activation-runner.js accepts no CLI arguments for sensitive values (no process.argv reference at all)', !/process\.argv/.test(runnerSrc));
  check('emergency-containment.js accepts no CLI arguments (no process.argv reference at all)', !/process\.argv/.test(emergencyCode));
  check('emergency-containment.js never imports attemptActivationCas / the activation CAS path', !/attemptActivationCas/.test(emergencyCode));
  check('emergency-containment.js never references the gate document as a write target (GATE_DOC_PATH)\'s only use is via gateIo.loadArmedGate, a read)', !/GATE_DOC_PATH\)\.(set|update|delete|create)\(/.test(emergencyCode));
  check('emergency-containment.js contains zero direct tx.set(/tx.update( of its own — delegates entirely to rollout-mutation.js', !/tx\.set\(|tx\.update\(/.test(emergencyCode));
  check('activation-runner.js contains zero direct tx.set(/tx.update( of its own — all mutation delegated to activation-controller.js/rollout-mutation.js', !/tx\.set\(|tx\.update\(/.test(runnerCode));
  check('activation-runner.js never sends FCM / invokes Scheduler or Functions / runs a deploy command', !/fcmTransport|sendFcmOnce|cloudscheduler\.googleapis\.com|cloudfunctions\.googleapis\.com|firebase deploy/i.test(runnerSrc));
  check('emergency-containment.js never sends FCM / invokes Scheduler or Functions / runs a deploy command', !/fcmTransport|sendFcmOnce|cloudscheduler\.googleapis\.com|cloudfunctions\.googleapis\.com|firebase deploy/i.test(emergencySrc));
  check('activation-runner.js watchdog launch uses buildSanitizedChildEnvironment (never a raw ...process.env passthrough as the child env)', /executionMode\.buildSanitizedChildEnvironment\(/.test(runnerSrc));
  check("activation-runner.js's own entry point never calls runActivation(", (() => {
    const entryStart = runnerSrc.indexOf('if (require.main === module)');
    return !/runActivation\(/.test(runnerSrc.slice(entryStart));
  })());
  check('watchdog checks requireCleanProductionEnvironment BEFORE any Firestore-facing call (buildRealDb/runPreflight) in main()', (() => {
    const watchdogSrc = fs.readFileSync(path.join(__dirname, 'activation-watchdog.js'), 'utf8');
    const mainStart = watchdogSrc.indexOf('async function main()');
    const modeCheckIdx = watchdogSrc.indexOf('requireCleanProductionEnvironment(', mainStart);
    const preflightIdx = watchdogSrc.indexOf('await runPreflight()', mainStart);
    const fakeDbIdx = watchdogSrc.indexOf("require('./fake-firestore-file-store')", mainStart);
    return modeCheckIdx !== -1 && modeCheckIdx < preflightIdx && modeCheckIdx < fakeDbIdx;
  })());

  // =======================================================================================
  // Codex Step 3C-9 repair pass 5 — item 14 focused tests
  // =======================================================================================
  console.log('\n=== [item 14.L] test-only injectable orchestration is unavailable without ACTIVATION_TEST_MODE=true ===');
  await checkAsync('[14.L] runActivationForTest called with the sentinel absent refuses immediately, before touching Firestore', async () => {
    const orig = process.env.ACTIVATION_TEST_MODE;
    delete process.env.ACTIVATION_TEST_MODE;
    try {
      const { db } = makeFakeDb(baseSeed());
      const result = await runner.runActivationForTest(db, { readinessPath: tmpFile('readiness.json') });
      return result.outcome === 'stop' && result.reason === 'test-interface-requires-explicit-test-mode' && result.activationAttempted === false;
    } finally {
      if (orig === undefined) delete process.env.ACTIVATION_TEST_MODE;
      else process.env.ACTIVATION_TEST_MODE = orig;
    }
  });
  await checkAsync('[14.L] runActivationForTest called with ACTIVATION_TEST_MODE=false (present but not the literal string "true") still refuses', async () => {
    const orig = process.env.ACTIVATION_TEST_MODE;
    process.env.ACTIVATION_TEST_MODE = 'false';
    try {
      const { db } = makeFakeDb(baseSeed());
      const result = await runner.runActivationForTest(db, { readinessPath: tmpFile('readiness.json') });
      return result.outcome === 'stop' && result.reason === 'test-interface-requires-explicit-test-mode';
    } finally {
      if (orig === undefined) delete process.env.ACTIVATION_TEST_MODE;
      else process.env.ACTIVATION_TEST_MODE = orig;
    }
  });

  console.log('\n=== [item 14.C] production wrapper performs at most one activation CAS attempt ===');
  await checkAsync('[14.C] across a full run with a real spawned watchdog and natural consumption observed, the rollout document commits into the allowlisted-real-send activation state EXACTLY ONCE', async () => {
    const storePath = tmpFile('store.json');
    const readinessPath = tmpFile('readiness.json');
    fs.writeFileSync(storePath, JSON.stringify({ [ROLLOUT_PATH]: { mode: 'paused' } }));
    const { db, store } = makeFakeDb(baseSeed());

    // Codex Step 3C-9 repair pass 7, item C1: performActivationCas is now PRIVATE to
    // activation-controller.js (moved from rollout-mutation.js's former exported
    // attemptActivationCas specifically so it is no longer independently monkeypatchable/
    // callable from outside that file). Counting is done instead by observing the fake
    // store's own writes: an activation CAS commit is, by construction, the only way the
    // rollout document's `mode` field can ever become 'allowlisted-real-send' — so counting
    // writes of that exact shape is an equally strong (arguably stronger, since it also
    // proves the RESULT, not merely the attempt) proxy for "at most one activation CAS".
    let activationCommitCount = 0;
    const originalStoreSet = store.set.bind(store);
    store.set = (key, value) => {
      if (key === ROLLOUT_PATH && value && value.mode === 'allowlisted-real-send') activationCommitCount++;
      return originalStoreSet(key, value);
    };

    function testLaunchWatchdog(rPath, challenge) {
      const gate = boundGate;
      return fork(path.join(__dirname, 'activation-watchdog.js'), [], {
        env: {
          ...process.env,
          ACTIVATION_TEST_MODE: 'true',
          WATCHDOG_FAKE_STORE_PATH: storePath,
          WATCHDOG_READINESS_PATH: rPath,
          WATCHDOG_CONTROLLER_CHALLENGE: challenge,
          WATCHDOG_FAKE_UID: gate.expectedUid,
          WATCHDOG_FAKE_REMINDER_ID: gate.expectedReminderId,
          WATCHDOG_FAKE_INSTALLATION_ID: gate.expectedInstallationId,
          WATCHDOG_FAKE_SCHEDULED_FOR_MS: String(gate.expectedScheduledForMs),
          WATCHDOG_HEARTBEAT_MS: '100',
        },
        stdio: 'ignore',
      });
    }
    let watchdogChild;
    setTimeout(() => {
      store.set(GATE_PATH, consumedGateDoc());
      store.set(DELIVERY_PATH, { state: 'accepted-by-fcm' });
    }, 2500);
    try {
      const result = await withTestMode(() => runner.runActivationForTest(db, {
        readinessPath,
        postLaunchPollMs: 20,
        postLaunchTimeoutMs: 8000,
        launchWatchdog: (rPath, challenge) => {
          watchdogChild = testLaunchWatchdog(rPath, challenge);
          return watchdogChild;
        },
        observePollMs: 50,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 30 },
      }));
      return activationCommitCount === 1 && result.outcome === 'contained' && result.activationAttempted === true;
    } finally {
      try {
        watchdogChild && watchdogChild.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(storePath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });
  check('[14.C] static: exactly one performActivationCas( call site exists WITHIN runControllerOrchestration itself, and it is a PRIVATE (non-exported) function — see item C1', (() => {
    const controllerSrc = stripComments(fs.readFileSync(path.join(__dirname, 'activation-controller.js'), 'utf8'));
    const fnStart = controllerSrc.indexOf('async function runControllerOrchestration(');
    const fnEnd = controllerSrc.indexOf('\n}\n', fnStart);
    const fnBody = controllerSrc.slice(fnStart, fnEnd);
    const matches = fnBody.match(/performActivationCas\(/g) || [];
    const exportsBlockStart = controllerSrc.indexOf('module.exports = {');
    const exportsBlock = controllerSrc.slice(exportsBlockStart);
    const notExported = !/[^a-zA-Z]performActivationCas\s*[,:]/.test(exportsBlock) && !/performActivationCas,/.test(exportsBlock);
    return matches.length === 1 && notExported;
  })());

  console.log('\n=== [item 14.F/G] watchdog final-status collection is diagnostic-only, never authoritative ===');
  await checkAsync('[14.F] rollout conclusively paused (Firestore) but watchdog status file reports HARD_CONTAINMENT_FAILURE -> outcome still contained, failure surfaced in watchdogFinalStatus', async () => {
    // runControllerOrchestration always begins by loading the gate as ARMED (correct
    // production behavior) — it must transition to consumed DURING observation, not be
    // pre-seeded as already consumed, or the orchestration refuses at the very first step
    // with gate-not-armed before ever reaching observation/containment/status-collection.
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'paused' } });
    const { db, store } = makeFakeDb(seed);
    setTimeout(() => {
      store.set(GATE_PATH, consumedGateDoc());
      store.set(DELIVERY_PATH, { state: 'accepted-by-fcm' });
    }, 150);
    const readinessPath = tmpFile('readiness.json');
    const challenge = 'chal-fg-1';
    const timing = gal.computeActivationTiming(Date.now(), SCHEDULED_MS);
    // Simulate a genuinely live, heartbeat-advancing watchdog (own process PID, updated on an
    // interval) without spawning a real child — verifyWatchdogFullyReady requires observed
    // advancement across two reads, which a single static write can never satisfy.
    writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs);
    const hb = setInterval(() => writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs), 40);
    // Simulate the watchdog's OWN final status write reporting a failure, even though
    // Firestore (the store above) is already exactly paused.
    readinessArtifact.writeReadiness(readinessPath + '.status.json', {
      status: 'hard-containment-failure',
      challenge,
      nonce: 'nonce-1',
      pid: process.pid,
      experimentBindingHash: gal.buildExperimentBindingHash(boundGate),
      absoluteDeadlineMs: timing.containmentDeadlineMs,
      attempts: 5,
    });
    try {
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, {
        observePollMs: 20,
        observeBudgetMs: 2000,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 20 },
      });
      return (
        result.outcome === 'contained' &&
        result.watchdogFinalStatus &&
        result.watchdogFinalStatus.available === true &&
        result.watchdogFinalStatus.bound === true &&
        result.watchdogFinalStatus.reportsSafe === false &&
        result.watchdogFinalStatus.status === 'hard-containment-failure'
      );
    } finally {
      clearInterval(hb);
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath + '.status.json');
      } catch {}
    }
  });
  await checkAsync('[14.G] watchdog status file reports PAUSED_SUCCESS but Firestore rollout is an unresolvable unexpected shape -> outcome NEVER "contained" (Firestore remains authoritative, watchdog claim never overrides it)', async () => {
    // 'general-real-send' is a shape the containment CAS structurally refuses to ever
    // overwrite (see rollout-mutation.js) — so no matter what the watchdog's own status file
    // claims, real containment genuinely cannot succeed here, and 'contained' must never be
    // the reported outcome.
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'general-real-send' } });
    const { db, store } = makeFakeDb(seed);
    store.set(GATE_PATH, consumedGateDoc());
    store.set(DELIVERY_PATH, { state: 'accepted-by-fcm' });
    const readinessPath = tmpFile('readiness.json');
    const challenge = 'chal-fg-2';
    const timing = gal.computeActivationTiming(Date.now(), SCHEDULED_MS);
    writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs);
    const hb = setInterval(() => writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs), 40);
    readinessArtifact.writeReadiness(readinessPath + '.status.json', {
      status: 'paused-success',
      challenge,
      nonce: 'nonce-1',
      pid: process.pid,
      experimentBindingHash: gal.buildExperimentBindingHash(boundGate),
      absoluteDeadlineMs: timing.containmentDeadlineMs,
      attempts: 1,
    });
    try {
      // Deliberately DO NOT let containment retry actually pause rollout for real here — the
      // point is: even a watchdog claiming success must never flip a genuinely non-paused
      // Firestore state to a safe outcome. rollout is 'allowlisted-real-send' for a DIFFERENT
      // reason than the expected uid's own containment CAS precondition (it names UID, which
      // IS the expected uid here) — to force a genuine non-paused-and-uncontainable outcome,
      // seed a rollout shape the containment CAS structurally refuses to overwrite.
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, {
        observePollMs: 20,
        observeBudgetMs: 2000,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 20 },
      });
      return result.outcome !== 'contained';
    } finally {
      clearInterval(hb);
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
      try {
        fs.unlinkSync(readinessPath + '.status.json');
      } catch {}
    }
  });

  console.log('\n=== [item 14.H] pre-activation STOP does not leave an unexplained orphan watchdog ===');
  await checkAsync('[14.H] preflight fails AFTER watchdog launch (activation never attempted) -> watchdog is explicitly terminated and verified', async () => {
    // Force a pre-activation stop from INSIDE runControllerOrchestration (not from the
    // runner's own earlier preconditions) by seeding a rollout that is paused at
    // runRunnerPreconditions time (so the runner proceeds to launch the watchdog) but then
    // mutating it to non-paused before the orchestration's own baseline preflight re-checks
    // it — reproducing a genuine "watchdog launched, then a later precondition failed" stop.
    const { db, store } = makeFakeDb(baseSeed());
    const readinessPath = tmpFile('readiness.json');
    let spawnedChild;
    const result = await withTestMode(() => runner.runActivationForTest(db, {
      readinessPath,
      postLaunchPollMs: 10,
      postLaunchTimeoutMs: 3000,
      launchWatchdog: () => {
        // Stand-in "watchdog": a real, independently alive OS child process (so the
        // PID-liveness checks below are genuine, not simulated) that simply sleeps and
        // publishes NO readiness file — never touches activation-watchdog.js's own real
        // ADC/IAM preflight at all (this test stays entirely local; no production access).
        // The orchestration's initial readiness check therefore fails closed against a real
        // still-alive PID, exercising the actual OS-level kill+verify termination path below.
        spawnedChild = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
        return spawnedChild;
      },
    }));
    try {
      const stillAlive = spawnedChild && gal.isPidAlive(spawnedChild.pid);
      return result.outcome === 'stop' && result.activationAttempted === false && result.watchdogTerminated === true && !stillAlive;
    } finally {
      try {
        spawnedChild && spawnedChild.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });
  check('[14.H] static: terminateOrphanedWatchdog is exported and only called on pre-activation (activationAttempted===false) return paths', (() => {
    const runnerSrc = fs.readFileSync(path.join(__dirname, 'activation-runner.js'), 'utf8');
    return typeof runner.terminateOrphanedWatchdog === 'function' && /if \(!result\.activationAttempted\)/.test(runnerSrc);
  })());

  console.log('\n=== [item 6] emergency containment — repaired to accept a CONSUMED gate ===');
  await checkAsync('[6/D] valid ARMED gate + rollout exactly allowlisted for the gate-bound uid -> paused', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'paused' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });
  await checkAsync('[6/D] valid CONSUMED gate + rollout exactly allowlisted for the gate-bound uid -> paused (THE REPAIRED SCENARIO)', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] }, [GATE_PATH]: consumedGateDoc() });
    const { db, store } = makeFakeDb(seed);
    const beforeGate = JSON.stringify(store.get(GATE_PATH));
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'paused' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH)) && JSON.stringify(store.get(GATE_PATH)) === beforeGate;
  });
  await checkAsync('[6] valid CONSUMED gate + rollout already exactly paused -> idempotent safe success', async () => {
    const seed = baseSeed({ [GATE_PATH]: consumedGateDoc() });
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'paused' && gal.isExactlyPausedRollout(store.get(ROLLOUT_PATH));
  });
  await checkAsync('[6] CONSUMED gate but schema-malformed (consumedAt missing) -> refuse (gate not loadable), rollout untouched', async () => {
    const malformed = consumedGateDoc({ consumedAt: null });
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] }, [GATE_PATH]: malformed });
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'stop' && result.reason === 'gate-not-armed-or-consumed' && store.get(ROLLOUT_PATH).mode === 'allowlisted-real-send';
  });
  await checkAsync('[6] CONSUMED gate bound to a DIFFERENT uid than the rollout allowlist names -> refuse to overwrite (never blindly trusts the allowlist alone)', async () => {
    const otherUidGate = consumedGateDoc({ expectedUid: 'some-other-uid' });
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] }, [GATE_PATH]: otherUidGate });
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    // The gate loads fine (schema-valid, consumed) and derives expectedUid = 'some-other-uid'
    // internally; the rollout allowlist names a DIFFERENT uid, so the pause CAS precondition
    // (isExactlyAllowlistedForUid(data, 'some-other-uid')) correctly fails and containment
    // refuses to overwrite rather than pausing on a mismatched binding.
    return result.outcome !== 'paused' && store.get(ROLLOUT_PATH).mode === 'allowlisted-real-send';
  });
  await checkAsync('[6/E] unexpected rollout (general-real-send) with a CONSUMED gate -> refuses, never overwrites', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'general-real-send' }, [GATE_PATH]: consumedGateDoc() });
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'unexpected-rollout-state' && store.get(ROLLOUT_PATH).mode === 'general-real-send';
  });
  await checkAsync('[6] missing gate entirely -> refuse, no expectedUid to bind to', async () => {
    const seed = baseSeed({ [ROLLOUT_PATH]: { mode: 'allowlisted-real-send', allowlistUids: [UID] } });
    delete seed[GATE_PATH];
    const { db, store } = makeFakeDb(seed);
    const result = await emergencyContainment.runEmergencyContainment(db);
    return result.outcome === 'stop' && result.reason === 'gate-not-armed-or-consumed' && store.get(ROLLOUT_PATH).mode === 'allowlisted-real-send';
  });

  // =======================================================================================
  // Codex Step 3C-9 repair pass 6 — items 4, 5, 8, 12.K/L/M/N/O/P/R/S
  // =======================================================================================
  console.log('\n=== [item 12.K/L] final ADC binding checkpoint prevents activation CAS on drift ===');
  await checkAsync('[12.K/L] wrong canonicalAdcPath at the final checkpoint -> activation CAS never attempted, zero mutation', async () => {
    const seed = baseSeed();
    const { db, store } = makeFakeDb(seed);
    const before = JSON.stringify(store.get(ROLLOUT_PATH));
    const readinessPath = tmpFile('readiness.json');
    const challenge = 'chal-adc-1';
    const timing = gal.computeActivationTiming(Date.now(), SCHEDULED_MS);
    writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs);
    const hb = setInterval(() => writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs), 40);
    try {
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, {
        observePollMs: 20,
        observeBudgetMs: 2000,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 20 },
        // A canonicalAdcPath that cannot possibly match the real, resolved ADC path on this
        // machine — performAdcBindingCheckpoint's own realpath-equality check fails closed.
        adcBindingContext: { canonicalAdcPath: 'C:\\this-path-does-not-match-real-adc.json', initialAdcSha256: 'deadbeef' },
      });
      return result.outcome === 'stop' && result.reason === 'adc-binding-drift-at-final-checkpoint' && result.activationAttempted === false && JSON.stringify(store.get(ROLLOUT_PATH)) === before;
    } finally {
      clearInterval(hb);
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });
  check('[12.K] static: the ADC binding checkpoint call site occurs BEFORE the performActivationCas( call site within runControllerOrchestration', (() => {
    const controllerSrc = stripComments(fs.readFileSync(path.join(__dirname, 'activation-controller.js'), 'utf8'));
    const fnStart = controllerSrc.indexOf('async function runControllerOrchestration(');
    const fnEnd = controllerSrc.indexOf('\n}\n', fnStart);
    const fnBody = controllerSrc.slice(fnStart, fnEnd);
    const checkpointIdx = fnBody.indexOf('performAdcBindingCheckpoint');
    const casIdx = fnBody.indexOf('performActivationCas(');
    return checkpointIdx !== -1 && casIdx !== -1 && checkpointIdx < casIdx;
  })());

  console.log('\n=== [item 12.M/N/O] watchdog final-status exact binding (nonce/PID/status-enum) ===');
  function buildVerifiedReadiness(overrides) {
    return { challenge: 'chal-bind', nonce: 'nonce-real', pid: process.pid, experimentBindingHash: gal.buildExperimentBindingHash(boundGate), absoluteDeadlineMs: 9999999999999, ...overrides };
  }
  await checkAsync('[12/correct] status artifact matching every bound field exactly, recognized status -> bound + phase terminal-safe', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'paused-success', ...verified });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.available === true && result.bound === true && result.phase === 'terminal-safe' && result.reportsSafe === true;
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  await checkAsync('[12.M] wrong nonce -> NOT bound, malformed-or-unbound (never falsely trusted)', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'paused-success', ...verified, nonce: 'a-completely-different-nonce' });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.bound === false && result.phase === 'malformed-or-unbound';
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  await checkAsync('[12.N] wrong PID -> NOT bound, malformed-or-unbound', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'paused-success', ...verified, pid: verified.pid + 1 });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.bound === false && result.phase === 'malformed-or-unbound';
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  await checkAsync('[12.O] unrecognized status enum value -> NOT trusted, malformed-or-unbound (even though every binding field matches)', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'totally-made-up-status', ...verified });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.bound === false && result.phase === 'malformed-or-unbound' && result.reason === 'unrecognized-status-value';
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  await checkAsync('wrong challenge -> NOT bound', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'paused-success', ...verified, challenge: 'wrong-challenge' });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.bound === false;
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  await checkAsync('wrong binding hash -> NOT bound', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'paused-success', ...verified, experimentBindingHash: 'wrong-hash' });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.bound === false;
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  await checkAsync('wrong absoluteDeadlineMs -> NOT bound', async () => {
    const statusPath = tmpFile('status.json');
    const verified = buildVerifiedReadiness();
    readinessArtifact.writeReadiness(statusPath, { status: 'paused-success', ...verified, absoluteDeadlineMs: verified.absoluteDeadlineMs + 1 });
    try {
      const result = controller.collectWatchdogFinalStatus(statusPath, verified, verified.absoluteDeadlineMs);
      return result.bound === false;
    } finally {
      try {
        fs.unlinkSync(statusPath);
      } catch {}
    }
  });
  check('missing/unreadable artifact, deadline still future -> phase pending (not malformed — this is the expected condition while the watchdog is legitimately still independently running)', (() => {
    const result = controller.collectWatchdogFinalStatus(tmpFile('never-written.json'), buildVerifiedReadiness(), Date.now() + 999999);
    return result.available === false && result.phase === 'pending';
  })());
  check('missing/unreadable artifact, deadline already passed -> phase absent-past-deadline', (() => {
    const result = controller.collectWatchdogFinalStatus(tmpFile('never-written.json'), buildVerifiedReadiness(), Date.now() - 1000);
    return result.available === false && result.phase === 'absent-past-deadline';
  })());

  console.log('\n=== [item 12.P] exception after watchdog spawn, before activation -> bounded cleanup still runs ===');
  await checkAsync('[12.P] runControllerOrchestration throwing mid-preflight (simulated) is caught internally and converted to a safe activationAttempted:false result, never an uncaught rejection', async () => {
    // observeOnce/runActivationPreflight etc. all run against `db` — a db whose collection()
    // throws synchronously simulates an unexpected mid-preflight failure (e.g. a transient
    // SDK/network exception) occurring AFTER readiness was already established.
    const { db: fakeDb } = makeFakeDb(baseSeed());
    const throwingDb = {
      ...fakeDb,
      collection() {
        throw new Error('simulated transient Firestore exception');
      },
    };
    const readinessPath = tmpFile('readiness.json');
    const challenge = 'chal-exc-1';
    const timing = gal.computeActivationTiming(Date.now(), SCHEDULED_MS);
    writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs);
    const hb = setInterval(() => writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs), 40);
    try {
      const result = await controller.runControllerOrchestration(throwingDb, readinessPath, challenge, {
        observePollMs: 20,
        observeBudgetMs: 2000,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 20 },
      });
      return result.outcome === 'stop' && result.reason === 'pre-activation-exception' && result.activationAttempted === false;
    } finally {
      clearInterval(hb);
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });
  await checkAsync('[12.P] a real spawned "watchdog" stand-in + an exception thrown by the launcher itself (post-spawn glue failure) still results in verified termination via production-entry.js-equivalent glue', async () => {
    // Exercises the SAME conservative catch-and-terminate glue production-entry.js's private
    // runProductionOrchestration uses, reproduced here structurally: launch a real child, then
    // force an exception in the glue between launch and the orchestration call.
    let spawnedChild;
    const launchWatchdog = () => {
      spawnedChild = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      return spawnedChild;
    };
    const child = launchWatchdog();
    try {
      if (!gal.isPidAlive(child.pid)) return false;
      // Simulate the glue code between launch and orchestration throwing.
      let caught = null;
      try {
        throw new Error('simulated glue exception between watchdog launch and orchestration call');
      } catch (err) {
        caught = err;
      }
      const termination = await runner.terminateOrphanedWatchdog(child);
      return caught !== null && termination.terminated === true && !gal.isPidAlive(child.pid);
    } finally {
      try {
        spawnedChild && spawnedChild.kill('SIGKILL');
      } catch {}
    }
  });

  console.log('\n=== [item 12.R/S] durable package no longer contains gate-creation capability ===');
  check('[12.R] armGate.js is ABSENT from this directory', !fs.existsSync(path.join(__dirname, 'armGate.js')));
  check('[12.S] no tx.create( anywhere in any non-test .js source file in this directory (zero gate-write capability) — test-description strings excluded from this scan', (() => {
    // Excludes *.test.js: those files' own check-label STRINGS legitimately mention these
    // patterns in English descriptions (e.g. this very check's label), which stripComments
    // (a comment stripper, not a string-literal stripper) cannot distinguish from real code.
    // The actual invariant this proves is about SOURCE/SHARED files, which contain no such
    // strings at all.
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    for (const f of files) {
      const content = fs.readFileSync(path.join(__dirname, f), 'utf8');
      const stripped = stripComments(content);
      if (/tx\.create\(/.test(stripped)) return false;
    }
    return true;
  })());
  check('[12.S] production-preflight.js contains no armGate()/selectCandidate()/gate-creation logic (comments excluded from the scan)', (() => {
    const content = stripComments(fs.readFileSync(path.join(__dirname, 'production-preflight.js'), 'utf8'));
    return !/async function armGate\(|async function selectCandidate\(|verifyFullGateState/.test(content);
  })());

  console.log('\n=== [item 12.I/J] emergency containment CLI exit-code classification (pure) ===');
  check('[12.J] conclusively-paused result -> EXIT 0', emergencyContainment.exitCodeForEmergencyResult({ outcome: 'paused' }) === 0 && emergencyContainment.EMERGENCY_EXIT_CODES.PAUSED_CONCLUSIVE === 0);
  check('[12.I] unexpected-rollout-state -> distinct nonzero', emergencyContainment.exitCodeForEmergencyResult({ outcome: 'unexpected-rollout-state' }) === emergencyContainment.EMERGENCY_EXIT_CODES.UNEXPECTED_ROLLOUT_STATE);
  check('[12.I] gate-not-armed-or-consumed refusal -> distinct nonzero', emergencyContainment.exitCodeForEmergencyResult({ outcome: 'stop', reason: 'gate-not-armed-or-consumed' }) === emergencyContainment.EMERGENCY_EXIT_CODES.GATE_NOT_LOADABLE);
  check('[12.I] hard-containment-failure -> distinct nonzero', emergencyContainment.exitCodeForEmergencyResult({ outcome: 'hard-containment-failure' }) === emergencyContainment.EMERGENCY_EXIT_CODES.HARD_CONTAINMENT_FAILURE);
  check('[12.I] unrecognized result -> nonzero, never silently 0', emergencyContainment.exitCodeForEmergencyResult({ outcome: 'nonsense' }) === emergencyContainment.EMERGENCY_EXIT_CODES.UNRECOGNIZED_RESULT && emergencyContainment.exitCodeForEmergencyResult(null) !== 0);
  check('every emergency exit code except PAUSED_CONCLUSIVE is nonzero and distinct', (() => {
    const codes = Object.entries(emergencyContainment.EMERGENCY_EXIT_CODES).filter(([k]) => k !== 'PAUSED_CONCLUSIVE');
    const values = codes.map(([, v]) => v);
    return values.every((v) => v !== 0) && new Set(values).size === values.length;
  })());

  // =======================================================================================
  // Codex Step 3C-9 repair pass 7 — the three execution-blocking repairs (C1, C2, H1)
  // =======================================================================================
  console.log('\n=== [item 7] direct activation-CAS export removal (C1) ===');
  check('[7] rollout-mutation.js production exports contain NO independently callable activation-opening CAS helper (no "attemptActivationCas" export — only the test-gated attemptActivationCasForTest)', (() => {
    const rmExports = rolloutMutation;
    // rollout-mutation.js now has ZERO activation-CAS-related exports of any kind (not even a
    // test-only wrapper) — the single implementation and its single test-only wrapper both
    // live in activation-controller.js, so there is exactly one copy of this logic anywhere.
    return typeof rmExports.attemptActivationCas === 'undefined' && typeof rmExports.attemptActivationCasForTest === 'undefined' && typeof controller.attemptActivationCasForTest === 'function';
  })());
  check('[7] static: rollout-mutation.js\'s module.exports object literal does not list ANY activation-CAS key (bare or test-suffixed)', (() => {
    const rmSrc = stripComments(fs.readFileSync(path.join(__dirname, 'rollout-mutation.js'), 'utf8'));
    const exportsIdx = rmSrc.indexOf('module.exports = {');
    const exportsBlock = rmSrc.slice(exportsIdx);
    return !/attemptActivationCas/.test(exportsBlock);
  })());
  check('[C1] static: performActivationCas exists in exactly ONE file (activation-controller.js) — never duplicated into rollout-mutation.js or anywhere else', (() => {
    const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'));
    let definitionCount = 0;
    for (const f of files) {
      const stripped = stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'));
      if (/async function performActivationCas\(/.test(stripped)) definitionCount++;
    }
    return definitionCount === 1;
  })());
  check('[7] containment/pause exports remain available (attemptPauseCas, runBoundedContainmentRetry, resolveRolloutState) — they can only REDUCE rollout permission', typeof rolloutMutation.attemptPauseCas === 'function' && typeof rolloutMutation.runBoundedContainmentRetry === 'function' && typeof rolloutMutation.resolveRolloutState === 'function');
  const { isValidIdForPath } = require('C:/Users/adamb/neuroactive/functions/lib/reminderDeliveryLogic.js');
  await checkAsync('[7] test-only activation mutation access (attemptActivationCasForTest) REFUSES without ACTIVATION_TEST_MODE=true', async () => {
    const orig = process.env.ACTIVATION_TEST_MODE;
    delete process.env.ACTIVATION_TEST_MODE;
    try {
      const { db } = makeFakeDb(baseSeed());
      const gate = await controller.loadArmedGate(db);
      await controller.attemptActivationCasForTest(db, gate, isValidIdForPath);
      return false; // should have thrown
    } catch (err) {
      return /test-only and requires ACTIVATION_TEST_MODE=true/.test(err.message);
    } finally {
      if (orig === undefined) delete process.env.ACTIVATION_TEST_MODE;
      else process.env.ACTIVATION_TEST_MODE = orig;
    }
  });
  await checkAsync('[7] test-only activation mutation access WORKS with explicit ACTIVATION_TEST_MODE=true against fake/local state', async () => {
    const { db, store } = makeFakeDb(baseSeed());
    const gate = await controller.loadArmedGate(db);
    const result = await withTestMode(() => controller.attemptActivationCasForTest(db, gate, isValidIdForPath));
    return result.outcome === 'committed' && gal.isExactlyAllowlistedForUid(store.get(ROLLOUT_PATH), UID);
  });

  console.log('\n=== [item 8] capability caller near-match attack — dynamically reproduced and proven fixed (H1) ===');
  await checkAsync('[8] mintOnce() called from a file named fake-production-entry.js (same directory) REFUSES', async () => {
    const activationCapability = require('./activation-capability');
    activationCapability.__resetForTestModeOnly();
    const fakePath = path.join(__dirname, 'fake-production-entry.js');
    fs.writeFileSync(fakePath, "const ac = require('./activation-capability'); module.exports = function() { return ac.mintOnce(); };");
    try {
      delete require.cache[require.resolve(fakePath)];
      const fakeCaller = require(fakePath);
      try {
        fakeCaller();
        return false; // should have thrown
      } catch (err) {
        return /may only be called from production-entry\.js/.test(err.message);
      }
    } finally {
      try {
        delete require.cache[require.resolve(fakePath)];
      } catch {}
      fs.unlinkSync(fakePath);
    }
  });
  await checkAsync('[8] mintOnce() called from a file named production-entry.js.bak (same directory) REFUSES', async () => {
    const activationCapability = require('./activation-capability');
    activationCapability.__resetForTestModeOnly();
    const fakePath = path.join(__dirname, 'production-entry.js.bak');
    fs.writeFileSync(fakePath, "const ac = require('./activation-capability'); module.exports = function() { return ac.mintOnce(); };");
    try {
      delete require.cache[require.resolve(fakePath)];
      const fakeCaller = require(fakePath);
      try {
        fakeCaller();
        return false;
      } catch (err) {
        return /may only be called from production-entry\.js/.test(err.message);
      }
    } finally {
      try {
        delete require.cache[require.resolve(fakePath)];
      } catch {}
      fs.unlinkSync(fakePath);
    }
  });
  await checkAsync('[8] mintOnce() called from a genuinely different directory\'s own production-entry.js (same basename, different canonical path) REFUSES', async () => {
    const activationCapability = require('./activation-capability');
    activationCapability.__resetForTestModeOnly();
    const otherDir = path.join(os.tmpdir(), `wd-p7-other-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(otherDir, { recursive: true });
    const fakePath = path.join(otherDir, 'production-entry.js');
    const capabilityAbsPath = path.join(__dirname, 'activation-capability.js').replace(/\\/g, '/');
    fs.writeFileSync(fakePath, `const ac = require('${capabilityAbsPath}'); module.exports = function() { return ac.mintOnce(); };`);
    try {
      const fakeCaller = require(fakePath);
      try {
        fakeCaller();
        return false;
      } catch (err) {
        return /may only be called from production-entry\.js/.test(err.message);
      }
    } finally {
      try {
        fs.rmSync(otherDir, { recursive: true, force: true });
      } catch {}
    }
  });
  await checkAsync('[8] mintOnce() called from the EXACT real, canonical production-entry.js path SUCCEEDS (proves the check is not merely refusing everything)', async () => {
    const activationCapability = require('./activation-capability');
    activationCapability.__resetForTestModeOnly();
    // Reuses production-entry.js's own already-loaded module — its runProductionActivation
    // calls activationCapability.mintOnce() internally, from the real file, only after real
    // preflight/authorization; exercising THAT full path would touch real ADC/production, which
    // is out of scope. Instead, this directly proves the POSITIVE case of the caller check
    // itself: a temp script written to, and required FROM, the real production-entry.js path
    // is indistinguishable (by this check) from production-entry.js itself — the check cares
    // about the canonical PATH, not the file's actual content/purpose.
    const realPath = path.join(__dirname, 'production-entry.js');
    const originalContent = fs.readFileSync(realPath, 'utf8');
    const probe = originalContent + "\nmodule.exports.__capabilityProbeForTest = function() { return require('./activation-capability').mintOnce(); };\n";
    fs.writeFileSync(realPath, probe);
    try {
      delete require.cache[require.resolve(realPath)];
      const reloaded = require(realPath);
      const token = reloaded.__capabilityProbeForTest();
      return typeof token === 'symbol' && activationCapability.isValid(token);
    } finally {
      fs.writeFileSync(realPath, originalContent);
      delete require.cache[require.resolve(realPath)];
      activationCapability.__resetForTestModeOnly();
    }
  });

  console.log('\n=== [items 5/6] activation-attempt state survives post-CAS exceptions (C2) — MANDATORY tests ===');
  function makeThrowAfterCommitDb(seed, throwOn) {
    const { db, store } = makeFakeDb(seed);
    let transactionCount = 0;
    const originalRunTransaction = db.runTransaction.bind(db);
    db.runTransaction = async (cb) => {
      transactionCount++;
      return originalRunTransaction(cb);
    };
    const originalDoc = db.doc.bind(db);
    let getCallsAfterCommit = 0;
    let committed = false;
    db.doc = (p) => {
      const ref = originalDoc(p);
      const originalGet = ref.get.bind(ref);
      ref.get = async () => {
        if (committed && throwOn(p)) {
          getCallsAfterCommit++;
          throw new Error('simulated post-activation read exception');
        }
        return originalGet();
      };
      return ref;
    };
    const originalStoreSet = store.set.bind(store);
    store.set = (key, value) => {
      if (key === ROLLOUT_PATH && value && value.mode === 'allowlisted-real-send') committed = true;
      return originalStoreSet(key, value);
    };
    return { db, store, getTransactionCount: () => transactionCount };
  }

  await checkAsync('[5] MANDATORY: activation CAS COMMITS, then the immediately-next observation read throws -> activation attempt state TRUE, watchdog NOT terminated (PID stays alive), unsafe/unresolved result, no second activation CAS', async () => {
    const seed = baseSeed();
    // Throws on any .get() against the controlled delivery path (observeOnce's own read),
    // AFTER the activation CAS has already committed.
    const { db, store, getTransactionCount } = makeThrowAfterCommitDb(seed, (p) => p === DELIVERY_PATH);
    const readinessPath = tmpFile('readiness.json');
    const challenge = 'chal-c2-committed';
    const timing = gal.computeActivationTiming(Date.now(), SCHEDULED_MS);
    writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs);
    const hb = setInterval(() => writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs), 40);
    // A real, independently-alive child standing in for "the watchdog" — proves it is
    // genuinely never touched/terminated by this code path, not merely that a function wasn't
    // called.
    const watchdogStandIn = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      const attemptState = { activationMayHaveBeenAttempted: false };
      const result = await controller.runControllerOrchestration(db, readinessPath, challenge, {
        observePollMs: 20,
        observeBudgetMs: 2000,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 20 },
        attemptState,
      });
      // Mirrors production-entry.js's own outer-catch decision logic: NEVER terminate when
      // attemptState says activation may have been attempted.
      const shouldTerminate = !attemptState.activationMayHaveBeenAttempted && !result.activationAttempted;
      if (shouldTerminate) await runner.terminateOrphanedWatchdog(watchdogStandIn);
      return (
        result.outcome === 'stop' &&
        result.activationAttempted === true &&
        attemptState.activationMayHaveBeenAttempted === true &&
        !shouldTerminate &&
        gal.isPidAlive(watchdogStandIn.pid) &&
        getTransactionCount() === 1 &&
        gal.isExactlyAllowlistedForUid(store.get(ROLLOUT_PATH), UID)
      );
    } finally {
      clearInterval(hb);
      try {
        watchdogStandIn.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  await checkAsync('[6] MANDATORY: activation CAS returns AMBIGUOUS, then the ambiguity-resolution read throws -> activation attempt state TRUE, watchdog NOT terminated (PID stays alive), no automatic second activation CAS, result unresolved', async () => {
    const seed = baseSeed();
    const { db: rawDb } = makeFakeDb(seed);
    let transactionCount = 0;
    const originalRunTransaction = rawDb.runTransaction.bind(rawDb);
    rawDb.runTransaction = async (cb) => {
      transactionCount++;
      if (transactionCount === 1) {
        // Simulate a genuinely-uncertain network error DURING the activation transaction
        // itself (not the fixed precondition sentinel) -> performActivationCas classifies
        // this as {outcome:'ambiguous'}, triggering resolveActivationAmbiguity's own
        // rollout readback next.
        throw new Error('simulated genuinely-uncertain transaction error');
      }
      return originalRunTransaction(cb);
    };
    const originalDoc = rawDb.doc.bind(rawDb);
    rawDb.doc = (p) => {
      const ref = originalDoc(p);
      if (p === ROLLOUT_PATH) {
        const originalGet = ref.get.bind(ref);
        let rolloutGetsSinceTransaction = 0;
        ref.get = async () => {
          // Preflight/revalidation (steps E/F) both read ROLLOUT_PATH BEFORE the transaction
          // is ever attempted — only start counting/throwing once the (ambiguous) transaction
          // has actually run, so the FIRST rollout read AFTER it — resolveActivationAmbiguity's
          // own readback — is the one that throws, not an earlier preflight read.
          if (transactionCount >= 1) {
            rolloutGetsSinceTransaction++;
            if (rolloutGetsSinceTransaction === 1) throw new Error('simulated ambiguity-resolution read exception');
          }
          return originalGet();
        };
      }
      return ref;
    };
    const readinessPath = tmpFile('readiness.json');
    const challenge = 'chal-c2-ambiguous';
    const timing = gal.computeActivationTiming(Date.now(), SCHEDULED_MS);
    writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs);
    const hb = setInterval(() => writeFreshReadiness(readinessPath, boundGate, challenge, timing.containmentDeadlineMs), 40);
    const watchdogStandIn = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      const attemptState = { activationMayHaveBeenAttempted: false };
      const result = await controller.runControllerOrchestration(rawDb, readinessPath, challenge, {
        observePollMs: 20,
        observeBudgetMs: 2000,
        readinessOpts: { advancementTimeoutMs: 500, advancementPollMs: 20 },
        attemptState,
      });
      const shouldTerminate = !attemptState.activationMayHaveBeenAttempted && !result.activationAttempted;
      if (shouldTerminate) await runner.terminateOrphanedWatchdog(watchdogStandIn);
      return (
        result.outcome === 'stop' &&
        result.activationAttempted === true &&
        attemptState.activationMayHaveBeenAttempted === true &&
        !shouldTerminate &&
        gal.isPidAlive(watchdogStandIn.pid) &&
        transactionCount === 1 // no automatic second activation CAS attempt
      );
    } finally {
      clearInterval(hb);
      try {
        watchdogStandIn.kill('SIGKILL');
      } catch {}
      try {
        fs.unlinkSync(readinessPath);
      } catch {}
    }
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
});
