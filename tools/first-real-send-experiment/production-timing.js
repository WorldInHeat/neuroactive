// production-timing.js — FOR REVIEW ONLY. Codex Step 3C-9 repair pass 4, item 1.
//
// The SINGLE shared source of truth for production watchdog heartbeat/advancement timing.
// Both activation-controller.js and activation-watchdog.js import these same constants for
// PRODUCTION mode — pass 3's bug (watchdog heartbeat 15s vs controller advancement wait 3s,
// so a HEALTHY production watchdog would usually fail readiness because the controller
// almost never saw a second heartbeat inside its own short wait) is fixed by construction:
// there is now exactly one place these numbers can be defined, and the relationship between
// them is asserted below, not merely commented.
//
// REASONING (documented for Codex review, not just asserted):
//   - HEARTBEAT_MS = 5000 (5s): frequent enough that a real deadline (accurate to within a
//     few seconds) is meaningful, infrequent enough that local-file-write overhead is
//     negligible even on a slow disk.
//   - ADVANCEMENT_TIMEOUT_MS = 9000 (9s): comfortably more than ONE full heartbeat interval
//     (5s) — under NORMAL healthy operation, waiting through a single heartbeat interval
//     already proves advancement; the extra ~4s margin absorbs GC pauses, disk-write
//     latency, and OS scheduling jitter without being so long that a genuinely dead watchdog
//     goes undetected for an unreasonable fraction of the 20-minute containment deadline.
//     (9s / 1200s total containment budget ≈ 0.75% — negligible against the deadline, large
//     relative to one heartbeat interval.)
//   - ADVANCEMENT_POLL_MS = 500 (0.5s): the verifier polls the readiness file at this cadence
//     WITHIN the bounded ADVANCEMENT_TIMEOUT_MS window (never sleeps once and checks a single
//     time) — this can only shorten the observed detection latency, never lengthen it; a
//     timeout with no observed advancement still fails closed.
//   - MAX_HEARTBEAT_AGE_MS = 15000 (15s = 3x HEARTBEAT_MS): the maximum age at which a single
//     heartbeat read is still considered "fresh" at all, before advancement is even checked —
//     three missed intervals is a strong signal of a dead/stuck process, not routine jitter.
'use strict';

const PRODUCTION_HEARTBEAT_MS = 5000;
const PRODUCTION_ADVANCEMENT_TIMEOUT_MS = 9000;
const PRODUCTION_ADVANCEMENT_POLL_MS = 500;
const PRODUCTION_MAX_HEARTBEAT_AGE_MS = 15000;

// Asserted, not just documented: the advancement timeout must exceed one heartbeat interval,
// and the poll cadence must be finer than the timeout, or the relationship this file exists
// to guarantee would silently stop holding after some future edit.
if (PRODUCTION_ADVANCEMENT_TIMEOUT_MS <= PRODUCTION_HEARTBEAT_MS) {
  throw new Error('production-timing: ADVANCEMENT_TIMEOUT_MS must exceed one HEARTBEAT_MS interval.');
}
if (PRODUCTION_ADVANCEMENT_POLL_MS >= PRODUCTION_ADVANCEMENT_TIMEOUT_MS) {
  throw new Error('production-timing: ADVANCEMENT_POLL_MS must be smaller than ADVANCEMENT_TIMEOUT_MS.');
}
if (PRODUCTION_MAX_HEARTBEAT_AGE_MS < PRODUCTION_HEARTBEAT_MS) {
  throw new Error('production-timing: MAX_HEARTBEAT_AGE_MS must be at least one HEARTBEAT_MS interval.');
}

module.exports = {
  PRODUCTION_HEARTBEAT_MS,
  PRODUCTION_ADVANCEMENT_TIMEOUT_MS,
  PRODUCTION_ADVANCEMENT_POLL_MS,
  PRODUCTION_MAX_HEARTBEAT_AGE_MS,
};
