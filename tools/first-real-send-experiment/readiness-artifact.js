// readiness-artifact.js — FOR REVIEW ONLY. Codex Step 3C-9 repair pass 3.
//
// The SINGLE shared implementation of the local watchdog-readiness artifact's file I/O,
// used by BOTH activation-controller.js and activation-watchdog.js, so the on-disk format
// and atomic-write discipline can never drift between the two independent processes. Pure
// local-filesystem operations only — no Firestore/network access anywhere in this file, and
// no interpretation of the artifact's CONTENTS (that decision logic lives in
// gate-activation-logic.js's readinessMatchesExpectation/readinessHeartbeatFresh/
// readinessAdvanced, which are pure and directly testable without touching a real file).
'use strict';

const fs = require('node:fs');

// Atomic write: write to a unique temp path, then rename over the target — a reader can
// never observe a partially-written file.
function writeReadiness(readinessPath, payload) {
  const tmp = `${readinessPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, readinessPath);
}

function readReadiness(readinessPath) {
  try {
    return JSON.parse(fs.readFileSync(readinessPath, 'utf8'));
  } catch {
    return null;
  }
}

// Codex repair pass 3, item 3: safe, LOCAL-only cleanup — never touches Firestore/the gate.
// Idempotent: absence is success, not an error.
function clearStaleReadinessArtifact(readinessPath) {
  try {
    fs.unlinkSync(readinessPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return !fs.existsSync(readinessPath);
}

module.exports = { writeReadiness, readReadiness, clearStaleReadinessArtifact };
