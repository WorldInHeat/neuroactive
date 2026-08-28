// execution-mode.js — FOR REVIEW ONLY. Codex Step 3C-9 repair pass 4, item 2/3.
//
// Structural production/test-mode separation. PRODUCTION MODE IS THE DEFAULT and does NOT
// accept test overrides — a test-only environment variable must never silently affect
// production behavior (Codex's pass-3 finding). Test-only settings are honored ONLY when the
// explicit sentinel ACTIVATION_TEST_MODE=true is present; without it, ANY presence of a
// listed test-only variable is a hard, fail-closed configuration error — never silently
// ignored, never silently overridden.
'use strict';

const TEST_MODE_SENTINEL_ENV = 'ACTIVATION_TEST_MODE';

// Every environment variable that can alter identity, timing, or storage target away from
// the hard-bound production values. Kept as one explicit list so "did we forget one" is a
// single place to audit, not scattered across every file that might read process.env.
const PROHIBITED_TEST_ENV_VARS = Object.freeze([
  'WATCHDOG_FAKE_STORE_PATH',
  'WATCHDOG_FAKE_UID',
  'WATCHDOG_FAKE_REMINDER_ID',
  'WATCHDOG_FAKE_INSTALLATION_ID',
  'WATCHDOG_FAKE_SCHEDULED_FOR_MS',
  'WATCHDOG_DEADLINE_OVERRIDE_MS',
  'WATCHDOG_HEARTBEAT_MS',
  'WATCHDOG_POLL_MS',
  'WATCHDOG_ADVANCEMENT_TIMEOUT_MS',
  'WATCHDOG_ADVANCEMENT_POLL_MS',
  'WATCHDOG_CONTAINMENT_MAX_ATTEMPTS',
  'WATCHDOG_CONTAINMENT_BACKOFF_MS',
]);

function isTestMode(env) {
  return (env || process.env)[TEST_MODE_SENTINEL_ENV] === 'true';
}

function findProhibitedTestVars(env) {
  const e = env || process.env;
  return PROHIBITED_TEST_ENV_VARS.filter((k) => Object.prototype.hasOwnProperty.call(e, k) && e[k] !== undefined && e[k] !== '');
}

// The single gate every entry point (watchdog, runner) must call FIRST, before establishing
// readiness or attempting any production mutation. In production mode (the default), ANY
// prohibited test variable present is a hard configuration failure — never silently ignored.
function requireCleanProductionEnvironment(env) {
  const e = env || process.env;
  if (isTestMode(e)) return { ok: true, testMode: true };
  const prohibited = findProhibitedTestVars(e);
  if (prohibited.length > 0) return { ok: false, testMode: false, prohibitedVarNames: prohibited };
  return { ok: true, testMode: false };
}

// Codex item 3: the production runner must launch its watchdog/controller children with an
// explicit ALLOWLISTED environment — never a raw inherited copy of the parent's env, which
// could carry stray test/fake/override variables from the invoking shell. Only ordinary
// Windows/Node runtime variables a child process needs to function at all are passed
// through; every activation-specific value is set explicitly by the caller via `extra`.
const RUNTIME_PASSTHROUGH_ALLOWLIST = Object.freeze(['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'APPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'ComSpec', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE']);

function buildSanitizedChildEnvironment(baseEnv, extra) {
  const source = baseEnv || process.env;
  const clean = {};
  for (const key of RUNTIME_PASSTHROUGH_ALLOWLIST) {
    if (source[key] !== undefined) clean[key] = source[key];
  }
  return { ...clean, ...(extra || {}) };
}

module.exports = {
  TEST_MODE_SENTINEL_ENV,
  PROHIBITED_TEST_ENV_VARS,
  RUNTIME_PASSTHROUGH_ALLOWLIST,
  isTestMode,
  findProhibitedTestVars,
  requireCleanProductionEnvironment,
  buildSanitizedChildEnvironment,
};
