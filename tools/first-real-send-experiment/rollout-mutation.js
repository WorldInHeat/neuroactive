// rollout-mutation.js — FOR REVIEW ONLY. NOT EXECUTED. Codex Step 3C-9 repair pass 3.
//
// The SINGLE shared implementation of both rollout CAS mutations (activation and pause),
// used by BOTH activation-controller.js and activation-watchdog.js — previously each file
// had its own copy, which is exactly the kind of duplication that let the two independent
// processes' pause semantics drift apart. Every mutation function here returns an EXPLICIT
// discriminated result:
//   { outcome: 'committed' }
//   { outcome: 'definite-noncommit', reason: <fixed sentinel string> }
//   { outcome: 'ambiguous', errorClass: 'genuinely-uncertain' }
// `ambiguous: false` is never used as a proxy for "committed" — Codex's pass-2 finding was
// that the old shape let a definite noncommit be silently treated as success.
//
// Its ONLY possible Firestore mutation, in either function, is a single `tx.set()` against
// the rollout document — never the gate, never any other document. gate-io.js remains a
// strictly read-only module; this file is the (equally reviewed, equally narrow) write-only
// counterpart for rollout specifically.
'use strict';

const gal = require('./gate-activation-logic');
const gateIo = require('./gate-io');

const ROLLOUT_DOC_PATH = gateIo.ROLLOUT_DOC_PATH;

function classifyCaughtTransactionError(err) {
  const classification = gal.classifyTransactionFailure(err && err.message);
  if (classification === 'definite-noncommit') return { outcome: 'definite-noncommit', reason: err.message };
  return { outcome: 'ambiguous', errorClass: 'genuinely-uncertain' };
}

// Codex Step 3C-9 repair pass 7, item C1 REPAIR: the activation-CAS implementation (formerly
// exported here as attemptActivationCas) has been REMOVED from this file entirely — not
// merely renamed or gated. It previously was exported directly, meaning ANY code in this
// process could import rollout-mutation.js and call it against real production with a
// hand-crafted gate object, bypassing operator authorization, the activation-capability
// token, the final ADC checkpoint, and full production preflight entirely.
//
// The ONE remaining implementation lives as a PRIVATE (non-exported) function inside
// activation-controller.js (performActivationCas), reachable only from within that file's own
// capability-gated runControllerOrchestration — and activation-controller.js ALSO exports a
// single ACTIVATION_TEST_MODE=true-gated test-only wrapper (attemptActivationCasForTest) around
// that SAME private implementation, so there is exactly one copy of this logic anywhere in the
// package, never two implementations that could silently drift apart. This file no longer
// contains, imports, or references any activation-opening transaction logic at all — see
// activation-controller.js for both the real path and the test-only escape hatch.
//
// ---------------------------------------------------------------------------------------
// PAUSE CAS — exact allowlisted(for expectedUid) -> exact paused. UID-bound: refuses (never
// overwrites) any other rollout shape, including an allowlist for a DIFFERENT uid. Remains
// independently exported/callable in production: it can only ever move rollout TOWARD
// paused, never open it, so it carries none of activation's risk.
// ---------------------------------------------------------------------------------------
async function attemptPauseCas(db, expectedUid) {
  const rolloutRef = db.doc(ROLLOUT_DOC_PATH);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(rolloutRef);
      const data = snap.exists ? snap.data() : undefined;
      if (gal.isExactlyPausedRollout(data)) return; // already paused — idempotent no-op.
      if (!gal.isExactlyAllowlistedForUid(data, expectedUid)) {
        throw new Error('pause-precondition-failed');
      }
      tx.set(rolloutRef, { ...gal.PAUSED_ROLLOUT_PAYLOAD });
    });
    return { outcome: 'committed' };
  } catch (err) {
    return classifyCaughtTransactionError(err);
  }
}

async function resolveRolloutState(db, expectedUid) {
  const snap = await db.doc(ROLLOUT_DOC_PATH).get();
  return gal.classifyRolloutContainmentState(snap.exists ? snap.data() : undefined, expectedUid);
}

const DEFAULT_MAX_CONTAINMENT_ATTEMPTS = 5;
const DEFAULT_CONTAINMENT_BACKOFF_MS = 2000;

// ---------------------------------------------------------------------------------------
// BOUNDED CONTAINMENT RETRY — Codex repair pass 3, items 8/9. Retries ONLY the safe pause/
// containment operation, NEVER activation. Terminal outcomes:
//   'paused'                    — containment succeeded (possibly after retries).
//   'unexpected-rollout-state'  — rollout is some other shape; NEVER overwritten; STOP.
//   'hard-containment-failure'  — exhausted the bounded retry horizon while rollout was
//                                 still exactly the expected experiment allowlist; requires
//                                 operator intervention. Never claimed as success.
// ---------------------------------------------------------------------------------------
async function runBoundedContainmentRetry(db, expectedUid, opts) {
  const maxAttempts = (opts && opts.maxAttempts) || DEFAULT_MAX_CONTAINMENT_ATTEMPTS;
  const backoffMs = (opts && opts.backoffMs) || DEFAULT_CONTAINMENT_BACKOFF_MS;

  let attempts = 0;
  let lastErrorClass = null;

  while (attempts < maxAttempts) {
    attempts++;
    const state = await resolveRolloutState(db, expectedUid);
    // Explicitly distinguishes "rollout was ALREADY paused when we looked" from "we just
    // committed the pause CAS ourselves" — callers (e.g. the watchdog's final status
    // artifact) must never have to infer this from `attempts` alone, which cannot
    // distinguish the two (both can legitimately be attempts===1).
    if (state === 'paused') return { outcome: 'paused', attempts, viaCas: false };
    if (state === 'unexpected-rollout-state') return { outcome: 'unexpected-rollout-state', attempts };

    // state === 'still-allowlisted-for-expected-uid'
    const result = await attemptPauseCas(db, expectedUid);
    if (result.outcome === 'committed') {
      const finalState = await resolveRolloutState(db, expectedUid);
      if (finalState === 'paused') return { outcome: 'paused', attempts, viaCas: true };
      // A committed CAS should always read back paused; a disagreement here is treated
      // conservatively (never claimed as success) and simply retried like any other
      // non-terminal outcome.
      lastErrorClass = 'readback-mismatch-after-committed';
    } else if (result.outcome === 'definite-noncommit') {
      lastErrorClass = 'definite-noncommit';
    } else {
      lastErrorClass = result.errorClass;
    }

    if (attempts < maxAttempts) await new Promise((r) => setTimeout(r, backoffMs));
  }

  const finalState = await resolveRolloutState(db, expectedUid);
  if (finalState === 'paused') return { outcome: 'paused', attempts, viaCas: true };
  if (finalState === 'unexpected-rollout-state') return { outcome: 'unexpected-rollout-state', attempts };
  return { outcome: 'hard-containment-failure', attempts, lastErrorClass };
}

module.exports = {
  ROLLOUT_DOC_PATH,
  // Codex Step 3C-9 repair pass 7, item C1: no activation-CAS export of any kind — see the
  // header comment above. See activation-controller.js for both the real (capability-gated)
  // path and its ACTIVATION_TEST_MODE=true-gated test-only wrapper.
  attemptPauseCas,
  resolveRolloutState,
  runBoundedContainmentRetry,
  DEFAULT_MAX_CONTAINMENT_ATTEMPTS,
  DEFAULT_CONTAINMENT_BACKOFF_MS,
};
