'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');

const APP_REQUEST = 'C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/app/index.js';
const FIRESTORE_REQUEST = 'C:/Users/adamb/neuroactive/functions/node_modules/firebase-admin/lib/firestore/index.js';
const CONTROLLER_REQUEST = require.resolve('./activation-controller');

function loadFreshController(appModule, firestoreModule) {
  delete require.cache[CONTROLLER_REQUEST];
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === APP_REQUEST) return appModule;
    if (request === FIRESTORE_REQUEST) return firestoreModule;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require('./activation-controller'); } finally { Module._load = originalLoad; }
}

function makeHarness() {
  const apps = new Map();
  const dbs = new WeakMap();
  const counts = { initialize: 0, applicationDefault: 0, getFirestore: 0 };
  const controls = {
    lookupError: null,
    applicationDefaultError: null,
    initializeError: null,
    initializeRegistersBeforeThrow: false,
    initializeReturn: null,
    firestoreError: null,
  };

  const appModule = {
    applicationDefault() {
      counts.applicationDefault++;
      if (controls.applicationDefaultError) throw controls.applicationDefaultError;
      return { kind: 'isolated-fake-credential' };
    },
    initializeApp(options, name) {
      counts.initialize++;
      if (apps.has(name)) {
        const err = new Error(`Firebase app named ${name} already exists`);
        err.code = 'app/duplicate-app';
        throw err;
      }
      const app = controls.initializeReturn || { name, options };
      if (controls.initializeError) {
        if (controls.initializeRegistersBeforeThrow) apps.set(name, app);
        throw controls.initializeError;
      }
      apps.set(name, app);
      return app;
    },
    getApp(name) {
      if (controls.lookupError) throw controls.lookupError;
      if (!apps.has(name)) {
        const err = new Error(`Firebase app named ${name} does not exist`);
        err.code = 'app/no-app';
        throw err;
      }
      return apps.get(name);
    },
  };

  class FakeTimestamp {}
  const firestoreModule = {
    Timestamp: FakeTimestamp,
    getFirestore(app) {
      counts.getFirestore++;
      if (controls.firestoreError) throw controls.firestoreError;
      if (!dbs.has(app)) dbs.set(app, { app, kind: 'isolated-fake-firestore' });
      return dbs.get(app);
    },
  };
  return { apps, counts, controls, appModule, firestoreModule };
}

let passed = 0;
function check(fn) { fn(); passed++; }
function fresh(harness) { return loadFreshController(harness.appModule, harness.firestoreModule); }

try {
  // Successful ownership and legitimate reuse.
  {
    const h = makeHarness();
    const controller = fresh(h);
    const first = controller.buildControllerDb();
    const second = controller.buildControllerDb();
    check(() => assert.strictEqual(first, second));
    check(() => assert.strictEqual(first.app, h.apps.get('activation-controller')));
    check(() => assert.equal(first.app.options.projectId, 'neuroactive'));
    check(() => assert.equal(h.counts.initialize, 1));
    check(() => assert.equal(h.counts.applicationDefault, 1));
    check(() => assert.equal(h.counts.getFirestore, 2));
  }

  // Post-ownership: registry disappearance never recreates.
  {
    const h = makeHarness(); const controller = fresh(h); controller.buildControllerDb();
    h.apps.delete('activation-controller');
    check(() => assert.throws(() => controller.buildControllerDb(), (err) => err.code === 'app/no-app'));
    check(() => assert.equal(h.counts.initialize, 1));
    check(() => assert.equal(h.counts.applicationDefault, 1));
  }

  // Post-ownership: replacement object is never adopted.
  {
    const h = makeHarness(); const controller = fresh(h); controller.buildControllerDb();
    h.apps.set('activation-controller', { name: 'activation-controller', options: { projectId: 'neuroactive' } });
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-ownership-mismatch/));
  }

  // Post-ownership: exact object with missing/malformed/drifted binding fails closed.
  for (const mutatedOptions of [undefined, {}, { projectId: 42 }, { projectId: {} }, { projectId: 'wrong-project' }]) {
    const h = makeHarness(); const controller = fresh(h); controller.buildControllerDb();
    h.apps.get('activation-controller').options = mutatedOptions;
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-project-binding-mismatch/));
  }

  // Pre-ownership: every foreign named app fails, regardless of claimed configuration.
  for (const foreignApp of [
    { name: 'activation-controller', options: { projectId: 'neuroactive' } },
    { name: 'activation-controller', options: { projectId: 'wrong-project' } },
    { name: 'activation-controller' },
    { name: 'activation-controller', options: {} },
    { name: 'activation-controller', options: { projectId: 42 } },
  ]) {
    const h = makeHarness(); h.apps.set('activation-controller', foreignApp); const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-ownership-not-established/));
    check(() => assert.equal(h.counts.initialize, 0));
    check(() => assert.equal(h.counts.applicationDefault, 0));
  }

  // Unexpected lookup errors propagate exactly and cannot start ADC/initialization.
  {
    const h = makeHarness(); const error = new Error('unexpected-getApp'); error.code = 'app/internal-error';
    h.controls.lookupError = error; const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), (err) => err === error));
    check(() => assert.equal(h.counts.applicationDefault, 0));
    check(() => assert.equal(h.counts.initialize, 0));
  }

  // applicationDefault failure leaves no app/ownership; a later clean first attempt is valid.
  {
    const h = makeHarness(); const error = new Error('adc-failure'); h.controls.applicationDefaultError = error;
    const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), (err) => err === error));
    check(() => assert.equal(h.counts.initialize, 0));
    check(() => assert.equal(h.counts.getFirestore, 0));
    h.controls.applicationDefaultError = null;
    check(() => assert.equal(controller.buildControllerDb().app.options.projectId, 'neuroactive'));
    check(() => assert.equal(h.counts.applicationDefault, 2));
    check(() => assert.equal(h.counts.initialize, 1));
  }

  // initializeApp failure without registry mutation leaves ownership unset and permits a later first attempt.
  {
    const h = makeHarness(); const error = new Error('initialize-failure'); h.controls.initializeError = error;
    const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), (err) => err === error));
    check(() => assert.equal(h.counts.getFirestore, 0));
    h.controls.initializeError = null;
    check(() => assert.equal(controller.buildControllerDb().app.options.projectId, 'neuroactive'));
    check(() => assert.equal(h.counts.initialize, 2));
    check(() => assert.equal(h.counts.applicationDefault, 2));
  }

  // initializeApp failure after partial registration leaves an unowned app that is never adopted.
  {
    const h = makeHarness(); const error = new Error('partial-initialize-failure');
    h.controls.initializeError = error; h.controls.initializeRegistersBeforeThrow = true;
    const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), (err) => err === error));
    check(() => assert.equal(h.counts.getFirestore, 0));
    h.controls.initializeError = null;
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-ownership-not-established/));
    check(() => assert.equal(h.counts.initialize, 1));
    check(() => assert.equal(h.counts.applicationDefault, 1));
  }

  // Malformed/wrong-project initialization results never reach Firestore or establish ownership.
  for (const malformedApp of [
    { name: 'activation-controller' },
    { name: 'activation-controller', options: {} },
    { name: 'activation-controller', options: { projectId: 42 } },
    { name: 'activation-controller', options: { projectId: 'wrong-project' } },
  ]) {
    const h = makeHarness(); h.controls.initializeReturn = malformedApp; const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-project-binding-mismatch/));
    check(() => assert.equal(h.counts.getFirestore, 0));
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-ownership-not-established/));
    check(() => assert.equal(h.counts.initialize, 1));
  }

  // Load-bearing regression: Firestore failure must not establish ownership.
  {
    const h = makeHarness(); const error = new Error('firestore-construction-failure'); h.controls.firestoreError = error;
    const controller = fresh(h);
    check(() => assert.throws(() => controller.buildControllerDb(), (err) => err === error));
    check(() => assert.equal(h.counts.initialize, 1));
    check(() => assert.equal(h.counts.applicationDefault, 1));
    check(() => assert.equal(h.counts.getFirestore, 1));
    h.controls.firestoreError = null;
    check(() => assert.throws(() => controller.buildControllerDb(), /activation-controller-app-ownership-not-established/));
    check(() => assert.equal(h.counts.initialize, 1));
    check(() => assert.equal(h.counts.applicationDefault, 1));
    check(() => assert.equal(h.counts.getFirestore, 1));
  }

  console.log(`${passed} passed, 0 failed`);
} finally {
  delete require.cache[CONTROLLER_REQUEST];
}
