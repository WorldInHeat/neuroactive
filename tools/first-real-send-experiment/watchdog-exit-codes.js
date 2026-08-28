// watchdog-exit-codes.js — FOR REVIEW ONLY. Codex Step 3C-9 repair pass 4, items 7/8.
//
// The single shared exit-code map for activation-watchdog.js, so both the watchdog itself
// and any future caller (activation-runner.js) agree on what each code means without
// duplicating the mapping. Exit 0 is reserved for the two genuinely safe terminal states;
// every other outcome is a distinct nonzero code so a caller can distinguish "rollout is
// safe" from "rollout state could not be conclusively established" without parsing text.
'use strict';

const WATCHDOG_EXIT_CODES = Object.freeze({
  PAUSED_SUCCESS: 0,
  ALREADY_PAUSED_SUCCESS: 0,
  UNEXPECTED_ROLLOUT_STATE: 2,
  HARD_CONTAINMENT_FAILURE: 3,
  CONTAINMENT_EXCEPTION: 4,
  CONFIGURATION_FAILURE: 5,
  INVALID_EXPERIMENT_BINDING: 6,
  GENERIC_FAILURE: 1,
});

// Status strings written to the final local, non-secret status artifact (see
// activation-watchdog.js's writeFinalStatus) — kept distinct from, but consistent with, the
// exit-code map above.
const WATCHDOG_STATUS = Object.freeze({
  PAUSED_SUCCESS: 'paused-success',
  ALREADY_PAUSED_SUCCESS: 'already-paused-success',
  UNEXPECTED_ROLLOUT_STATE: 'unexpected-rollout-state',
  HARD_CONTAINMENT_FAILURE: 'hard-containment-failure',
  CONTAINMENT_EXCEPTION: 'containment-exception',
  CONFIGURATION_FAILURE: 'configuration-failure',
});

function exitCodeForStatus(status) {
  switch (status) {
    case WATCHDOG_STATUS.PAUSED_SUCCESS:
      return WATCHDOG_EXIT_CODES.PAUSED_SUCCESS;
    case WATCHDOG_STATUS.ALREADY_PAUSED_SUCCESS:
      return WATCHDOG_EXIT_CODES.ALREADY_PAUSED_SUCCESS;
    case WATCHDOG_STATUS.UNEXPECTED_ROLLOUT_STATE:
      return WATCHDOG_EXIT_CODES.UNEXPECTED_ROLLOUT_STATE;
    case WATCHDOG_STATUS.HARD_CONTAINMENT_FAILURE:
      return WATCHDOG_EXIT_CODES.HARD_CONTAINMENT_FAILURE;
    case WATCHDOG_STATUS.CONTAINMENT_EXCEPTION:
      return WATCHDOG_EXIT_CODES.CONTAINMENT_EXCEPTION;
    case WATCHDOG_STATUS.CONFIGURATION_FAILURE:
      return WATCHDOG_EXIT_CODES.CONFIGURATION_FAILURE;
    default:
      return WATCHDOG_EXIT_CODES.GENERIC_FAILURE;
  }
}

// A caller (the runner) must NEVER infer containment success merely from exit code 0 alone
// without also having read the final status artifact — this helper documents which STATUS
// values are the only ones that legitimately mean "rollout is conclusively safe."
function isConclusivelySafeStatus(status) {
  return status === WATCHDOG_STATUS.PAUSED_SUCCESS || status === WATCHDOG_STATUS.ALREADY_PAUSED_SUCCESS;
}

module.exports = {
  WATCHDOG_EXIT_CODES,
  WATCHDOG_STATUS,
  exitCodeForStatus,
  isConclusivelySafeStatus,
};
