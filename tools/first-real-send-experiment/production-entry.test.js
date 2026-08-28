// production-entry.test.js — Codex Step 3C-9 repair pass 6. Tests ONLY the parts of
// production-entry.js that are safe to exercise without touching real production:
// requireOperatorAuthorizationForTest() (test-gated, pure local — no Firestore/ADC/network),
// exit-code classification (pure), activation-capability.js's own guarantees (pure/local), and
// STATIC source-text checks of file structure/ordering/call-graph.
//
// THIS FILE DELIBERATELY NEVER CALLS runProductionActivation() OR node production-entry.js's
// own require.main===module entry point — doing so would call the REAL runPreflight() against
// REAL ADC/IAM, and (if ever authorized) the REAL production activation path. That is
// explicitly out of scope for this repair pass ("Production access during this pass is READ
// ONLY... No activation occurs in this repair pass.").
'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

async function main() {
  process.env.ACTIVATION_TEST_MODE = 'true';
  const productionEntry = require('./production-entry');
  const activationCapability = require('./activation-capability');

  console.log('\n=== requireOperatorAuthorizationForTest (test-gated, pure, no Firestore/ADC/network) ===');
  await checkAsync('exact required phrase -> authorized', async () => {
    const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => cb(productionEntry.REQUIRED_AUTHORIZATION_PHRASE));
    return result === true;
  });
  await checkAsync('exact phrase with surrounding whitespace -> still authorized (trimmed)', async () => {
    const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => cb('  ' + productionEntry.REQUIRED_AUTHORIZATION_PHRASE + '  \n'));
    return result === true;
  });
  await checkAsync('wrong phrase -> NOT authorized', async () => {
    const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => cb('yes'));
    return result === false;
  });
  await checkAsync('empty answer -> NOT authorized', async () => {
    const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => cb(''));
    return result === false;
  });
  await checkAsync('case-mismatched phrase -> NOT authorized (exact match required)', async () => {
    const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => cb(productionEntry.REQUIRED_AUTHORIZATION_PHRASE.toLowerCase()));
    return result === false;
  });
  await checkAsync('an attempted UID/identity value typed as the answer is NOT authorized (the phrase-only gate cannot be used to smuggle an override)', async () => {
    const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => cb('runner-test-uid'));
    return result === false;
  });
  await checkAsync('[item 12.E] requireOperatorAuthorizationForTest refuses outright (never calls promptFn) when ACTIVATION_TEST_MODE is absent', async () => {
    const orig = process.env.ACTIVATION_TEST_MODE;
    delete process.env.ACTIVATION_TEST_MODE;
    let promptFnCalled = false;
    try {
      const result = await productionEntry.requireOperatorAuthorizationForTest((q, cb) => {
        promptFnCalled = true;
        cb(productionEntry.REQUIRED_AUTHORIZATION_PHRASE);
      });
      return result === false && promptFnCalled === false;
    } finally {
      if (orig === undefined) delete process.env.ACTIVATION_TEST_MODE;
      else process.env.ACTIVATION_TEST_MODE = orig;
    }
  });

  console.log('\n=== [item 3] activation CLI exit-code classification (pure) ===');
  check('[F] STOP result -> nonzero (STOP code)', productionEntry.exitCodeForActivationResult({ outcome: 'stop', reason: 'gate-not-armed' }) === productionEntry.ACTIVATION_EXIT_CODES.STOP);
  check('[F] operator-authorization-declined -> its own distinct nonzero code', productionEntry.exitCodeForActivationResult({ outcome: 'stop', reason: 'operator-authorization-declined' }) === productionEntry.ACTIVATION_EXIT_CODES.OPERATOR_AUTHORIZATION_DECLINED);
  check('[F] definite noncommit -> its own distinct nonzero code', productionEntry.exitCodeForActivationResult({ outcome: 'stop', reason: 'activation-definite-noncommit' }) === productionEntry.ACTIVATION_EXIT_CODES.DEFINITE_NONCOMMIT);
  check('[G] unresolved ambiguity -> its own distinct nonzero code', productionEntry.exitCodeForActivationResult({ outcome: 'stop', reason: 'ambiguous-unexpected-rollout-state' }) === productionEntry.ACTIVATION_EXIT_CODES.UNRESOLVED_AMBIGUITY);
  check('[G] unexpected-rollout-state outcome -> its own distinct nonzero code', productionEntry.exitCodeForActivationResult({ outcome: 'unexpected-rollout-state' }) === productionEntry.ACTIVATION_EXIT_CODES.UNEXPECTED_ROLLOUT_STATE);
  check('hard-containment-failure outcome -> its own distinct nonzero code', productionEntry.exitCodeForActivationResult({ outcome: 'hard-containment-failure' }) === productionEntry.ACTIVATION_EXIT_CODES.HARD_CONTAINMENT_FAILURE);
  check('configuration/preflight failure reasons -> their own distinct nonzero code', productionEntry.exitCodeForActivationResult({ outcome: 'stop', reason: 'production-preflight-failed' }) === productionEntry.ACTIVATION_EXIT_CODES.CONFIGURATION_OR_PREFLIGHT_FAILURE);
  check('unrecognized/malformed result -> nonzero, never silently 0', productionEntry.exitCodeForActivationResult({ outcome: 'something-unrecognized' }) === productionEntry.ACTIVATION_EXIT_CODES.UNRECOGNIZED_RESULT && productionEntry.exitCodeForActivationResult(null) === productionEntry.ACTIVATION_EXIT_CODES.UNRECOGNIZED_RESULT);
  check('[Q] watchdogTerminated===false on any result -> forces the distinct unsafe-termination nonzero code, even alongside outcome contained', productionEntry.exitCodeForActivationResult({ outcome: 'contained', watchdogTerminated: false }) === productionEntry.ACTIVATION_EXIT_CODES.WATCHDOG_TERMINATION_UNVERIFIED);
  check('[H] conclusively-contained result with no termination concern -> EXIT 0', productionEntry.exitCodeForActivationResult({ outcome: 'contained', classification: 'A-accepted' }) === 0 && productionEntry.ACTIVATION_EXIT_CODES.CONTAINED_SUCCESS === 0);
  check('every non-CONTAINED_SUCCESS exit code is distinct and nonzero (no accidental collision, no accidental 0)', (() => {
    const codes = Object.entries(productionEntry.ACTIVATION_EXIT_CODES).filter(([k]) => k !== 'CONTAINED_SUCCESS');
    const values = codes.map(([, v]) => v);
    return values.every((v) => v !== 0) && new Set(values).size === values.length;
  })());

  console.log('\n=== activation-capability.js — same-process capability token ===');
  activationCapability.__resetForTestModeOnly();
  check('mintOnce() called from a non-production-entry.js call site refuses', (() => {
    try {
      activationCapability.mintOnce();
      return false; // should have thrown
    } catch (err) {
      return /may only be called from production-entry\.js/.test(err.message);
    }
  })());
  check('isValid(anything) is false before any mint has occurred', !activationCapability.isValid(Symbol('forged')) && !activationCapability.isValid(undefined));

  console.log('\n=== [item 14.A/B/J/K, item 12.A/B/C/D] static source structure of production-entry.js ===');
  const src = fs.readFileSync(path.join(__dirname, 'production-entry.js'), 'utf8');
  const code = stripComments(src);

  check('[12.B] no exported runActivationProduction-equivalent exists anywhere in this file', !/module\.exports[\s\S]*runActivationProduction/.test(code) && !/exports\.runActivationProduction/.test(code));
  check('[12.C] no exported attemptActivationCas-equivalent exists anywhere in this file', !/attemptActivationCas/.test(code));
  check('[12.D] the real production orchestration function (runProductionActivation) accepts zero arguments', /async function runProductionActivation\(\)/.test(code));
  check('[1] production-entry.js never imports/references a fake/file-backed Firestore store', !/fake-firestore-file-store/.test(code));
  check('[1] production-entry.js never reads any WATCHDOG_FAKE_*/override env var directly', !/WATCHDOG_FAKE_|WATCHDOG_DEADLINE_OVERRIDE_MS|WATCHDOG_HEARTBEAT_MS/.test(code));
  check('[14.A] production preflight (runPreflight) is called, and appears BEFORE requireOperatorAuthorization is CALLED', (() => {
    const fnStart = code.indexOf('async function runProductionActivation()');
    const preflightIdx = code.indexOf('await runPreflight()', fnStart);
    const authCallIdx = code.indexOf('await requireOperatorAuthorization()', fnStart);
    return fnStart !== -1 && preflightIdx !== -1 && authCallIdx !== -1 && preflightIdx < authCallIdx;
  })());
  check('[14.A] environment cleanliness check occurs before runPreflight()', (() => {
    const modeIdx = code.indexOf('requireCleanProductionEnvironment(process.env)');
    const preflightIdx = code.indexOf('await runPreflight()');
    return modeIdx !== -1 && preflightIdx !== -1 && modeIdx < preflightIdx;
  })());
  check('[14.K] operator authorization occurs AFTER preflight/preconditions and BEFORE minting the capability token / handoff', (() => {
    const fnStart = code.indexOf('async function runProductionActivation()');
    const authCallIdx = code.indexOf('await requireOperatorAuthorization()', fnStart);
    const mintIdx = code.indexOf('activationCapability.mintOnce()', fnStart);
    const handoffIdx = code.indexOf('runProductionOrchestration(capabilityToken', fnStart);
    return authCallIdx !== -1 && mintIdx !== -1 && handoffIdx !== -1 && authCallIdx < mintIdx && mintIdx < handoffIdx;
  })());
  check('[1] production-entry.js accepts no CLI arguments anywhere (no process.argv reference)', !/process\.argv/.test(src));
  check('[1] the ONLY call in this file to a mutation-capable function is via controller.runControllerOrchestration (inside the private runProductionOrchestration) — no direct rolloutMutation reference', !/rolloutMutation/.test(code));
  check('[T] production-entry.js import/load alone cannot activate: the only CALL (not declaration) of runProductionActivation exists inside the require.main===module guard, never at module scope', (() => {
    const guardIdx = src.indexOf('if (require.main === module)');
    const declEnd = code.indexOf('async function runProductionActivation()') + 'async function runProductionActivation()'.length;
    const betweenDeclAndGuard = code.slice(declEnd, code.indexOf('if (require.main === module)'));
    return guardIdx !== -1 && declEnd > 0 && !/runProductionActivation\(\)/.test(betweenDeclAndGuard);
  })());
  check('[T] requiring production-entry.js as a module (not run directly) executes nothing beyond function/const definitions', typeof productionEntry.runProductionActivation === 'function' && typeof productionEntry.requireOperatorAuthorizationForTest === 'function');
  check('production-entry.js never imports armGate.js (gate-creation capability removed from the package, item 8)', !/require\(.\.\/armGate.\)/.test(code));

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
});
