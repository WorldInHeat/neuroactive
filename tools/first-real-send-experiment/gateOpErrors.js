// gateOpErrors.js — FOR REVIEW ONLY. NOT EXECUTED.
//
// Fixed, operator-safe error codes. No call site anywhere in this procedure is permitted to
// surface a raw SDK/Firestore/Auth/HTTP error message, stack trace, or response body to
// stdout/stderr. Every throw in the procedure constructs a GateOpError with exactly one of
// these fixed codes. Codex Step 3C-8 round 3, item 8: NO raw `cause` is retained at all —
// fixed-code-only, with no exception, since no call site in this procedure has ever actually
// needed to read one back.
'use strict';

const CODES = Object.freeze({
  // Process-level bootstrap (Codex round 3, item 8)
  PROCESS_UNCAUGHT_EXCEPTION: 'PROCESS_UNCAUGHT_EXCEPTION',
  PROCESS_UNHANDLED_REJECTION: 'PROCESS_UNHANDLED_REJECTION',
  MODULE_LOAD_FAILED: 'MODULE_LOAD_FAILED',

  // ADC / permission / environment preflight
  ADC_IDENTITY_UNRESOLVED: 'ADC_IDENTITY_UNRESOLVED',
  ADC_PROJECT_MISMATCH: 'ADC_PROJECT_MISMATCH',
  ADC_DATABASE_MISMATCH: 'ADC_DATABASE_MISMATCH',
  ADC_PERMISSION_DENIED: 'ADC_PERMISSION_DENIED',
  ADC_EMULATOR_ROUTING_DETECTED: 'ADC_EMULATOR_ROUTING_DETECTED',
  IAM_DRIFT_DETECTED: 'IAM_DRIFT_DETECTED',
  // Codex Step 3C-8 round 7 (Firestore ADC-path repair)
  ADC_BINDING_DRIFT: 'ADC_BINDING_DRIFT',
  FIRESTORE_CLIENT_INITIALIZATION_FAILED: 'FIRESTORE_CLIENT_INITIALIZATION_FAILED',
  FIRESTORE_AUTHENTICATION_PROOF_FAILED: 'FIRESTORE_AUTHENTICATION_PROOF_FAILED',

  // Candidate selection (pre-transaction; no write ever attempted on these paths)
  CANDIDATE_SELECTION_FAILED: 'CANDIDATE_SELECTION_FAILED',
  PRECHECK_SANITY_FAILED: 'PRECHECK_SANITY_FAILED',

  // Transaction outcome classification
  TRANSACTION_REJECTED_GATE_ABSENT: 'TRANSACTION_REJECTED_GATE_ABSENT',
  AMBIGUOUS_COMMIT_GATE_PRESENT: 'AMBIGUOUS_COMMIT_GATE_PRESENT',
  AMBIGUOUS_COMMIT_READBACK_FAILED: 'AMBIGUOUS_COMMIT_READBACK_FAILED',

  // Post-creation verification (both checkpoints share these codes; the printed stage
  // label, not the code, distinguishes "immediate" from "final")
  POSTCHECK_GATE_INVALID: 'POSTCHECK_GATE_INVALID',
  POSTCHECK_ROLLOUT_DRIFT: 'POSTCHECK_ROLLOUT_DRIFT',
  POSTCHECK_REMINDER_DRIFT: 'POSTCHECK_REMINDER_DRIFT',
  POSTCHECK_PREFERENCE_DRIFT: 'POSTCHECK_PREFERENCE_DRIFT',
  POSTCHECK_INSTALLATION_DRIFT: 'POSTCHECK_INSTALLATION_DRIFT',
  POSTCHECK_CENSUS_DRIFT: 'POSTCHECK_CENSUS_DRIFT',
  POSTCHECK_LOG_EVIDENCE_FAILED: 'POSTCHECK_LOG_EVIDENCE_FAILED',
});

class GateOpError extends Error {
  constructor(code) {
    if (!Object.prototype.hasOwnProperty.call(CODES, code)) {
      throw new Error(`gateOpErrors: unknown fixed code "${code}" — add it to CODES first, never throw an ad hoc string.`);
    }
    super(code); // Error.message is deliberately just the fixed code — safe to print/log.
    this.name = 'GateOpError';
    this.code = code;
  }
}

module.exports = { CODES, GateOpError };
