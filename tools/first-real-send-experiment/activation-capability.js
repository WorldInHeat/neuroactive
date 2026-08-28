// activation-capability.js — Codex Step 3C-9 repair pass 6, item 1. A same-process capability
// token closing the "any code that requires activation-controller.js/rollout-mutation.js
// directly could call the real activation orchestration with a hand-crafted db/gate" gap.
//
// HONEST SCOPE NOTE: this is defense-in-depth appropriate for a single-operator, trusted-
// codebase Node script — not a cryptographic security boundary against a malicious co-located
// process (Node's module system provides no true cross-file privacy; any code running in the
// same process can, in principle, read this file's source and reimplement it). What it DOES
// meaningfully prevent: an accidental or careless call to the real orchestration from a test,
// a future added script, or a bug — the kind of mistake Codex's review is concerned with — by
// requiring a token that is (a) never exported, (b) minted at most once per process, and (c)
// only mintable by code whose own call-site file is literally production-entry.js.
'use strict';

const path = require('node:path');

let mintedToken = null;

// Codex Step 3C-9 repair pass 7, item H1 REPAIR: the previous check was a bare regex
// (/production-entry\.js/) against the raw stack line — Codex dynamically proved a file named
// fake-production-entry.js (or production-entry.js.bak, or a same-named file in a different
// directory) matches that substring and could mint a real capability. Replaced with EXACT
// CANONICAL PATH equality: the caller's file path is parsed out of the stack frame, resolved
// to an absolute path, Windows-normalized (case-insensitive, matching this codebase's existing
// windowsPathsEqual convention in production-preflight.js), and compared for full equality
// against THIS file's own directory's production-entry.js — no substring, basename, or suffix
// matching anywhere.
const EXPECTED_CALLER_PATH = path.normalize(path.resolve(__dirname, 'production-entry.js')).toLowerCase();

// Extracts the file path from one V8 stack-trace line, handling both frame shapes Node
// produces: "at functionName (C:\path\to\file.js:12:34)" and the bare "at C:\path\to\file.js:
// 12:34" (used for anonymous top-level calls). Returns null if the line doesn't parse.
function extractCallerFilePath(stackLine) {
  if (!stackLine) return null;
  const parenMatch = stackLine.match(/\(([^()]+):\d+:\d+\)\s*$/);
  if (parenMatch) return parenMatch[1];
  const bareMatch = stackLine.match(/at\s+([^\s(][^:]*(?::[^\\/][^:]*)*):\d+:\d+\s*$/);
  if (bareMatch) return bareMatch[1];
  return null;
}

function callerFileIsProductionEntry() {
  const stack = (new Error().stack || '').split('\n');
  // stack[0] = "Error", stack[1] = this function's own frame, stack[2] = mintOnce()'s frame,
  // stack[3] = mintOnce()'s CALLER — the frame we actually need to check.
  const callerLine = stack[3] || '';
  const callerPath = extractCallerFilePath(callerLine);
  if (!callerPath) return false;
  const normalized = path.normalize(path.resolve(callerPath)).toLowerCase();
  return normalized === EXPECTED_CALLER_PATH;
}

// Mints the one-and-only capability token for this process. May only be called from
// production-entry.js's own source (verified via the immediate caller's stack frame — see the
// honest scope note above); refuses a second mint attempt outright (an activation attempt is a
// once-per-process action for this tooling; there is no legitimate reason to mint twice).
function mintOnce() {
  if (!callerFileIsProductionEntry()) {
    throw new Error('activation-capability: mintOnce() may only be called from production-entry.js.');
  }
  if (mintedToken !== null) {
    throw new Error('activation-capability: a token was already minted this process — refusing to mint a second one.');
  }
  mintedToken = Symbol(`activation-authorized-${Date.now()}`);
  return mintedToken;
}

function isValid(token) {
  return mintedToken !== null && token === mintedToken;
}

// TEST-ONLY: resets minted state between test cases in the SAME process. Hard-gated on the
// same ACTIVATION_TEST_MODE=true sentinel every other test-only escape hatch in this
// procedure requires.
function __resetForTestModeOnly() {
  if (process.env.ACTIVATION_TEST_MODE !== 'true') {
    throw new Error('activation-capability: __resetForTestModeOnly() requires ACTIVATION_TEST_MODE=true.');
  }
  mintedToken = null;
}

module.exports = { mintOnce, isValid, __resetForTestModeOnly };
