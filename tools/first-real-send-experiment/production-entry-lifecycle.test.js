'use strict';

// Executes production-entry.js's real same-process ordering and the REAL durable
// activation-controller.buildControllerDb(). Firebase Admin is replaced underneath the
// controller, and only mutation-capable orchestration is made inert. No real ADC, network,
// Firestore, watchdog, Scheduler, worker, FCM, stdin, or production mutation is reachable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const APP_REQUEST = 'C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/app/index.js';
const FIRESTORE_REQUEST = 'C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js';
const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activation-entry-lifecycle-'));
const calls = [];
const apps = new Map();
const dbs = new WeakMap();
let initializeCalls = 0;
let applicationDefaultCalls = 0;
let launchCalls = 0;
let orchestrationCalls = 0;

const fakeAppModule = {
  applicationDefault() {
    applicationDefaultCalls++;
    return { kind: 'isolated-fake-credential' };
  },
  initializeApp(options, name) {
    initializeCalls++;
    if (apps.has(name)) {
      const err = new Error(`Firebase app named ${name} already exists`);
      err.code = 'app/duplicate-app';
      throw err;
    }
    const app = { name, options };
    apps.set(name, app);
    return app;
  },
  getApp(name) {
    if (!apps.has(name)) {
      const err = new Error(`Firebase app named ${name} does not exist`);
      err.code = 'app/no-app';
      throw err;
    }
    return apps.get(name);
  },
};

class FakeTimestamp {}
const fakeFirestoreModule = {
  Timestamp: FakeTimestamp,
  getFirestore(app) {
    if (!dbs.has(app)) dbs.set(app, { app, kind: 'isolated-fake-db' });
    calls.push('real-controller-db-build');
    return dbs.get(app);
  },
};

const mocks = {
  './execution-mode': {
    requireCleanProductionEnvironment() { calls.push('environment'); return { ok: true, testMode: false }; },
  },
  './production-preflight': {
    async runPreflight() { calls.push('adc-preflight'); return { canonicalAdcPath: 'isolated', initialAdcSha256: 'isolated' }; },
  },
  './activation-capability': {
    mintOnce() { calls.push('capability-mint'); return Symbol('isolated-capability'); },
    isValid() { return true; },
  },
  './activation-runner': {
    async runRunnerPreconditions(db) {
      calls.push('runner-preflight');
      assert.strictEqual(db.app, apps.get('activation-controller'));
      return { ok: true, gate: { expectedScheduledForMs: Date.now() + 12 * 60 * 1000 } };
    },
    deriveRunnerTimingWindow() { calls.push('derive-window'); return {}; },
    requireWithinStartWindow() { calls.push('window-check'); return { ok: true }; },
    launchWatchdog(readinessPath) {
      calls.push('watchdog-launch');
      launchCalls++;
      fs.writeFileSync(readinessPath, '{}');
      return { pid: process.pid };
    },
    async terminateOrphanedWatchdog() { calls.push('watchdog-terminate'); return { attempted: true, terminated: true }; },
  },
  './readiness-artifact': {
    clearStaleReadinessArtifact(p) { calls.push('readiness-cleanup'); try { fs.unlinkSync(p); } catch (e) { if (e.code !== 'ENOENT') throw e; } return true; },
  },
  './gate-activation-logic': {
    generateChallenge() { calls.push('challenge'); return 'isolated-challenge'; },
    isPidAlive() { return true; },
  },
  'node:readline': {
    createInterface() {
      return {
        question(prompt, cb) { calls.push('human-authorization'); assert.equal(prompt, '> '); cb('I AUTHORIZE ACTIVATION'); },
        close() {},
      };
    },
  },
  'node:os': { ...os, tmpdir() { return isolatedDir; } },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === APP_REQUEST) return fakeAppModule;
  if (request === FIRESTORE_REQUEST) return fakeFirestoreModule;
  if (Object.prototype.hasOwnProperty.call(mocks, request)) return mocks[request];
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    const controller = require('./activation-controller');
    // Preserve the real DB builder while making only the mutation-capable controller seam inert.
    controller.runControllerOrchestration = async function inertControllerOrchestration(db) {
      calls.push('controller-orchestration');
      orchestrationCalls++;
      assert.strictEqual(db.app, apps.get('activation-controller'));
      return { outcome: 'stop', reason: 'isolated-lifecycle-complete', activationAttempted: false };
    };
    const entry = require('./production-entry');
    const result = await entry.runProductionActivation();

    const namedApp = apps.get('activation-controller');
    assert.equal(result.reason, 'isolated-lifecycle-complete');
    assert.equal(calls.filter((v) => v === 'real-controller-db-build').length, 2);
    assert.equal(initializeCalls, 1);
    assert.equal(applicationDefaultCalls, 1);
    assert.strictEqual(dbs.get(namedApp).app, namedApp);
    assert.equal(launchCalls, 1);
    assert.equal(orchestrationCalls, 1);
    assert.ok(calls.indexOf('real-controller-db-build') < calls.indexOf('human-authorization'));
    assert.ok(calls.indexOf('human-authorization') < calls.lastIndexOf('real-controller-db-build'));
    assert.ok(calls.indexOf('capability-mint') < calls.lastIndexOf('real-controller-db-build'));
    assert.ok(calls.lastIndexOf('real-controller-db-build') < calls.indexOf('watchdog-launch'));
    assert.ok(calls.indexOf('watchdog-launch') < calls.indexOf('controller-orchestration'));

    // Counterfactual using the same duplicate-rejecting registry semantics: the original
    // unconditional builder would throw on its second named initialization.
    const counterfactualApps = new Map();
    function originalBrokenBuild() {
      if (counterfactualApps.has('activation-controller')) throw new Error('duplicate named Firebase app');
      counterfactualApps.set('activation-controller', {});
    }
    originalBrokenBuild();
    assert.throws(() => originalBrokenBuild(), /duplicate named Firebase app/);

    console.log('13 passed, 0 failed');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(isolatedDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error('FAIL', err && err.message);
  process.exitCode = 1;
});
