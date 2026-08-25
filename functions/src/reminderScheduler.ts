// functions/src/reminderScheduler.ts
// Phase 3A-3 Step 2 (fifth Codex repair round) — scheduler + reminder-record
// architecture, DRY-RUN ONLY.
//
// HARD DRY-RUN POSTURE: this file imports nothing from 'firebase-admin/messaging' and
// contains no `.send()`/`sendEach`/FCM-HTTP call anywhere. It is mechanically incapable
// of delivering a real push notification. No raw FCM token value is ever read into a
// variable — only `pushInstallations` document COUNTS are used.
//
// ***** STEP 3 CAVEAT — READ BEFORE ADDING REAL DELIVERY *****
// The processing lease and Phase-B consent/schedule revalidation in this file are
// sufficient for safe DRY-RUN Firestore state transitions. They are NOT sufficient, by
// themselves, for irreversible FCM delivery. Do not simply insert
// `getMessaging().send()` into processCandidate below. Before real delivery, Step 3 must
// separately solve, at minimum:
//   1. Lease ownership must be re-confirmed IMMEDIATELY before the send attempt, not
//      merely at the start of Phase-B processing.
//   2. The lease must either be renewed just before sending, or be provisioned with a
//      duration longer than the maximum plausible end-to-end send window.
//   3. Consent/schedule must be revalidated AGAIN immediately before the send attempt —
//      the window between claim and actual delivery becomes security/privacy-relevant
//      (an opted-out user's device must never actually receive a push), not merely a
//      dry-run audit-accuracy concern.
//   4. Installation-level delivery-attempt idempotency: nothing in this dry-run-only
//      model currently tracks per-installation delivery attempts at all.
// None of this is implemented here. This file remains dry-run only.
//
// This is a separate file from functions/src/notificationPreferences.ts (Step 1,
// Codex-approved) and functions/src/pushInstallations.ts (Phase 3A-1, Codex-approved) —
// neither is modified by this round. Phase 3A-1 data is only ever read (uid + state
// count), never mutated.
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, FieldPath } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { logger } from 'firebase-functions/v2';
import {
  isValidExistingRevision,
  validateSchedule,
  classifyProgress,
  buildReminderId,
  computeQuarantineDueMs,
  computeLeaseExpiresAtMs,
  revalidateConsent,
  processWithBoundedConcurrency,
  computeNextOccurrenceMs,
  validateReminderSchema,
  decideQueueOutcome,
  buildQuarantineUpdate,
  buildTerminalWorkStateFields,
  buildUnknownStatusNeutralizationUpdate,
  requireAllowedTransition,
  type QuarantineReason,
  type ProgressResult,
  type ConsentRevalidation,
} from './reminderSchedulerLogic';
import { decideShouldFanOut } from './reminderDeliveryLogic';
import { fanOutReminderDelivery } from './reminderDeliveryWorker';

const APP_ID = 'neuroactive-prod';

// ---------------------------------------------------------------------------------------
// Runtime/throughput model (unchanged): timeoutSeconds 300 matching the 5-minute cadence.
// DUE_QUERY_BATCH_SIZE governs Phase A; RECOVERABLE_BATCH_SIZE governs Phase B. The prior
// round's INTEGRITY_SCAN_BATCH_SIZE and its background scan are REMOVED this round — see
// the "no more integrity scan" note above discoverRecoverableWork below.
// ---------------------------------------------------------------------------------------
const DUE_QUERY_BATCH_SIZE = 50;
const RECOVERABLE_BATCH_SIZE = 50;
const CLAIM_CONCURRENCY = 10;
const PROCESS_CONCURRENCY = 10;

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function preferencesRef(uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/notificationPreferences/main`);
}
function userDataRef(uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/userData/main`);
}
function reminderRef(reminderId: string) {
  return db.doc(`artifacts/${APP_ID}/reminders/${reminderId}`);
}
function remindersCollection() {
  return db.collection(`artifacts/${APP_ID}/reminders`);
}

// =========================================================================================
// PHASE A — discover due preferences; claim/coalesce; quarantine poison records.
// (Unchanged in substance — Codex passed this. Every claim now also writes `workState:
// 'queued'` atomically alongside `workAvailableAt`, so the new reminder is immediately
// both visible to, and structurally eligible for, Phase B's recovery query.)
// =========================================================================================

type ClaimOutcome =
  | { outcome: 'claimed'; reminderId: string }
  | { outcome: 'already-claimed' }
  | { outcome: 'not-due' }
  | { outcome: 'disabled' }
  | { outcome: 'no-preference' }
  | { outcome: 'quarantined'; reason: QuarantineReason };

function quarantinePreferenceWrite(
  transaction: FirebaseFirestore.Transaction,
  prefRef: FirebaseFirestore.DocumentReference,
  reason: QuarantineReason
): void {
  transaction.update(prefRef, {
    nextReminderDueAt: Timestamp.fromMillis(computeQuarantineDueMs()),
    schedulerQuarantinedAt: FieldValue.serverTimestamp(),
    schedulerQuarantineReason: reason,
  });
}

async function claimDueOccurrence(uid: string): Promise<ClaimOutcome> {
  const prefRef = preferencesRef(uid);

  return db.runTransaction(async (transaction): Promise<ClaimOutcome> => {
    const prefSnap = await transaction.get(prefRef);
    if (!prefSnap.exists) return { outcome: 'no-preference' };

    const data = prefSnap.data()!;
    const nowMs = Date.now();

    if (!isValidExistingRevision(data.revision)) {
      quarantinePreferenceWrite(transaction, prefRef, 'invalid-revision');
      return { outcome: 'quarantined', reason: 'invalid-revision' };
    }
    if (!(data.nextReminderDueAt instanceof Timestamp)) {
      quarantinePreferenceWrite(transaction, prefRef, 'invalid-due-timestamp');
      return { outcome: 'quarantined', reason: 'invalid-due-timestamp' };
    }
    const schedule = validateSchedule(data);
    if (!schedule) {
      quarantinePreferenceWrite(transaction, prefRef, 'invalid-schedule');
      return { outcome: 'quarantined', reason: 'invalid-schedule' };
    }

    if (data.enabled !== true) return { outcome: 'disabled' };

    const dueMs = data.nextReminderDueAt.toMillis();
    if (dueMs > nowMs) return { outcome: 'not-due' };

    const reminderId = buildReminderId(uid, dueMs);
    const claimRef = reminderRef(reminderId);
    const claimSnap = await transaction.get(claimRef);
    if (claimSnap.exists) return { outcome: 'already-claimed' };

    const nextDueMs = computeNextOccurrenceMs(new Date(nowMs), schedule.timezone, schedule.localTime, schedule.weekdays);

    transaction.set(claimRef, {
      uid,
      scheduledFor: Timestamp.fromMillis(dueMs),
      createdAt: FieldValue.serverTimestamp(),
      status: 'claimed',
      // BLOCKER 1/2/3 (fourth round): workState is written ATOMICALLY with status on
      // every mutation of this document, never independently. 'queued' is the only
      // workState a 'claimed' record may legally have (see
      // expectedWorkStateForStatus/classifyWorkTuple in reminderSchedulerLogic.ts).
      workState: 'queued',
      dryRun: true,
      preferenceRevisionAtClaim: data.revision,
      scheduleTypeAtClaim: schedule.scheduleType,
      weekdaysAtClaim: schedule.weekdays,
      localTimeAtClaim: schedule.localTime,
      timezoneAtClaim: schedule.timezone,
      attemptCount: 0,
      processingStartedAt: null,
      leaseExpiresAt: null,
      // Immediately eligible for Phase B pickup (workState='queued' AND
      // workAvailableAt <= now, both required for the recovery query to match it).
      workAvailableAt: FieldValue.serverTimestamp(),
    });
    transaction.update(prefRef, { nextReminderDueAt: Timestamp.fromMillis(nextDueMs) });

    return { outcome: 'claimed', reminderId };
  });
}

type PhaseASummary = {
  dueCount: number;
  claimedCount: number;
  alreadyClaimedCount: number;
  quarantinedCount: number;
  disabledRaceCount: number;
  notDueRaceCount: number;
  noPreferenceCount: number;
  claimFailureCount: number;
};

async function runPhaseA(): Promise<PhaseASummary> {
  const nowTs = Timestamp.now();

  const dueSnap = await db
    .collectionGroup('notificationPreferences')
    .where('enabled', '==', true)
    .where('nextReminderDueAt', '<=', nowTs)
    .limit(DUE_QUERY_BATCH_SIZE)
    .get();

  const uids: string[] = [];
  for (const doc of dueSnap.docs) {
    const userDocRef = doc.ref.parent.parent;
    if (userDocRef) uids.push(userDocRef.id);
    else logger.warn('[ReminderScheduler] due document has an unexpected path shape', { path: doc.ref.path });
  }

  const summary: PhaseASummary = {
    dueCount: uids.length,
    claimedCount: 0,
    alreadyClaimedCount: 0,
    quarantinedCount: 0,
    disabledRaceCount: 0,
    notDueRaceCount: 0,
    noPreferenceCount: 0,
    claimFailureCount: 0,
  };

  await processWithBoundedConcurrency(uids, CLAIM_CONCURRENCY, async (uid) => {
    try {
      const result = await claimDueOccurrence(uid);
      switch (result.outcome) {
        case 'claimed':
          summary.claimedCount++;
          break;
        case 'already-claimed':
          summary.alreadyClaimedCount++;
          break;
        case 'quarantined':
          summary.quarantinedCount++;
          logger.warn('[ReminderScheduler] quarantined a structurally corrupt preference document', { uid, reason: result.reason });
          break;
        case 'disabled':
          summary.disabledRaceCount++;
          break;
        case 'not-due':
          summary.notDueRaceCount++;
          break;
        case 'no-preference':
          summary.noPreferenceCount++;
          break;
      }
    } catch (err) {
      summary.claimFailureCount++;
      logger.error('[ReminderScheduler] Phase A claim transaction failed', { uid, error: String(err) });
    }
  });

  return summary;
}

// =========================================================================================
// PHASE B — discover recoverable reminder work via the unified `workState == 'queued' AND
// workAvailableAt <= now` query; transactionally re-validate the complete operational
// tuple on every acquisition; revalidate consent + full claim-time schedule identity;
// classify progress; count installations; commit terminal status.
// =========================================================================================

// BLOCKER 1 & 2 fix (fourth round). The main recovery query now filters on TWO
// server-owned fields together:
//   - workState == 'queued'      -> structurally excludes every terminal record,
//                                    including one with a corrupted/stale
//                                    workAvailableAt left over from external tampering
//                                    (BLOCKER 2: a `dry-run-complete` record can NEVER
//                                    match this query again, because its terminal commit
//                                    atomically set workState='terminal' in the same write
//                                    that set the terminal status — see commitFinalOutcome)
//   - workAvailableAt <= now      -> excludes still-leased 'processing' records, whose
//                                    workAvailableAt is a future timestamp (BLOCKER 1: a
//                                    stable prefix of still-leased 'queued' records cannot
//                                    hide an expired 'queued' record behind it, because the
//                                    range filter matches purely on value, not position)
// There is no longer a separate background "integrity scan" needed or present: a
// structurally corrupt record (missing/invalid workState, or a claimed/processing record
// with a fully invalid schema) simply never satisfies workState=='queued' and therefore
// never appears here at all — this is an intentional fail-closed outcome for genuinely
// out-of-band database corruption, not a gap this scheduler is responsible for repairing
// (see the implementation report's "malformed workState" section). A record that DOES
// legitimately reach this query (a real 'claimed' or 'processing' record) still gets its
// complete tuple re-validated transactionally in acquireProcessingLease below before it is
// ever acted on.
//
// Firestore index note: this is an equality filter (`workState`) combined with a range
// filter + orderBy (`workAvailableAt`) on a different field, plus the implicit document-ID
// tie-break — this specific shape requires an explicit composite index (an equality field
// followed by a range/orderBy field is not auto-indexed the way a single-field range query
// is). See firestore.indexes.json for the added `reminders (workState ASC, workAvailableAt
// ASC)` composite index.
async function discoverRecoverableWork(): Promise<string[]> {
  const nowTs = Timestamp.now();
  const snap = await remindersCollection()
    .where('workState', '==', 'queued')
    .where('workAvailableAt', '<=', nowTs)
    .orderBy('workAvailableAt', 'asc')
    .orderBy(FieldPath.documentId(), 'asc')
    .limit(RECOVERABLE_BATCH_SIZE)
    .get();
  return snap.docs.map((d) => d.id);
}

// The exhaustive mapping this round's fix guarantees for EVERY return path (see the
// implementation report's invariant-check table): each outcome below is tagged with which
// of the three states the sole required invariant demands.
//   'acquired'                  -> ACQUIRED
//   'still-leased'               -> TEMPORARILY INELIGIBLE (valid live lease; will become
//                                    due again automatically on lease expiry)
//   'not-found'                  -> PERMANENTLY EXCLUDED (nothing to acquire; gone)
//   'already-terminal'           -> PERMANENTLY EXCLUDED (tuple was already canonical
//                                    terminal; should not normally be reachable given a
//                                    correct query, kept as a defensive no-op)
//   'terminal-repaired'          -> PERMANENTLY EXCLUDED (BLOCKER 2: queue metadata
//                                    rewritten to canonical terminal; status/business
//                                    outcome untouched)
//   'unknown-status-neutralized' -> PERMANENTLY EXCLUDED (BLOCKER 1: status forced to
//                                    invalid-reminder via the isolated corruption path)
//   'quarantined'                -> PERMANENTLY EXCLUDED (known claimed/processing
//                                    corruption -> invalid-reminder via the normal
//                                    status-machine transition)
// There is no path that returns while leaving a due+queued tuple unchanged.
type LeaseAcquireResult =
  | {
      outcome: 'acquired';
      uid: string;
      preferenceRevisionAtClaim: number;
      claimSchedule: { scheduleType: 'daily' | 'weekdays'; weekdays: number[]; localTime: string; timezone: string };
      attemptCount: number;
    }
  | { outcome: 'still-leased' }
  | { outcome: 'not-found' }
  | { outcome: 'already-terminal' }
  | { outcome: 'terminal-repaired' }
  | { outcome: 'unknown-status-neutralized' }
  | { outcome: 'quarantined'; reason: string };

// BLOCKER 1/2/3 fix (fifth repair round). The fourth round's defect: early `return`
// statements for an unrecognized or recognized-terminal `status` exited the transaction
// BEFORE considering whether the record's queue tuple still matched the recovery query —
// a due+queued record with a corrupt status could return completely untouched and
// reappear on every subsequent tick forever. The fix: `decideQueueOutcome` (the SAME pure
// function the test file calls directly) is now consulted for every status shape, and
// every one of its six actions results in either an acquisition or a transactional write
// that removes the record from `workState == 'queued'` eligibility (or leaves it
// legitimately still-leased, which is not poisoning — it becomes due again automatically).
// Nothing from the discovery query (bare IDs only) is trusted; everything here is
// re-validated on freshly-read, transactional data. No check/use gap.
async function acquireProcessingLease(reminderId: string): Promise<LeaseAcquireResult> {
  const ref = reminderRef(reminderId);
  return db.runTransaction(async (transaction): Promise<LeaseAcquireResult> => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return { outcome: 'not-found' };
    const data = snap.data()!;
    const status = String(data.status);
    const nowMs = Date.now();

    // Computed unconditionally: cheap and pure, and decideQueueOutcome's signature takes
    // it directly so production and tests share one decision function end to end. Only
    // actually consulted on the 'claimed'/'processing' branch inside decideQueueOutcome.
    const schemaCheck = validateReminderSchema(data);
    const workAvailableAtMs = data.workAvailableAt instanceof Timestamp ? data.workAvailableAt.toMillis() : null;
    const leaseExpiresAtMs = data.leaseExpiresAt instanceof Timestamp ? data.leaseExpiresAt.toMillis() : null;

    const decision = decideQueueOutcome(status, data.workState, workAvailableAtMs, leaseExpiresAtMs, schemaCheck, nowMs);

    switch (decision.action) {
      case 'neutralize-unknown-status': {
        // BLOCKER 1. Deliberately NOT a normal status-machine transition — `status` is,
        // by construction, not one of the seven recognized values, so
        // requireAllowedTransition must not be (and is not) consulted here. This is an
        // isolated corruption-neutralization write, fully separate from the normal
        // transition table.
        transaction.update(ref, {
          ...buildUnknownStatusNeutralizationUpdate(status),
          quarantinedAt: FieldValue.serverTimestamp(),
        });
        return { outcome: 'unknown-status-neutralized' };
      }

      case 'already-terminal-correct':
        // BLOCKER 2, non-corrupt case: a legitimately terminal record whose queue
        // metadata is already canonical. This should not normally be reachable given a
        // correctly-filtering discovery query, but is handled harmlessly as a no-op
        // rather than assumed impossible.
        return { outcome: 'already-terminal' };

      case 'repair-terminal-queue-state':
        // BLOCKER 2. `status` is a recognized, legitimate terminal value and is left
        // completely untouched — only the queue-operational fields are corrupt, so only
        // they are repaired. Not a status transition (status does not change), so
        // requireAllowedTransition is correctly not invoked.
        transaction.update(ref, {
          ...buildTerminalWorkStateFields(),
          queueIntegrityRepairedAt: FieldValue.serverTimestamp(),
          queueIntegrityRepairReason: 'terminal-status-with-queued-tuple',
        });
        return { outcome: 'terminal-repaired' };

      case 'quarantine-known-corruption':
        // Known claimed/processing corruption (malformed schema or inconsistent
        // status/workState/workAvailableAt/leaseExpiresAt tuple) — unchanged from the
        // fourth round: a normal, validated status-machine transition to
        // 'invalid-reminder'.
        requireAllowedTransition(status, 'invalid-reminder');
        transaction.update(ref, { ...buildQuarantineUpdate(decision.reason), quarantinedAt: FieldValue.serverTimestamp() });
        return { outcome: 'quarantined', reason: decision.reason };

      case 'still-leased':
        // Consistent 'processing' tuple with a still-live lease: someone else genuinely
        // owns this right now (or the discovery query returned a record whose lease was
        // just renewed by a concurrent worker between discovery and this transaction).
        // Temporarily ineligible, not poisoning — it becomes due again automatically.
        return { outcome: 'still-leased' };

      case 'acquire': {
        if (!schemaCheck.valid) {
          // Unreachable in practice (decideQueueOutcome already checked schemaCheck.valid
          // before returning 'acquire'), kept only so TypeScript can narrow
          // schemaCheck.attemptCount/.uid/etc. below without a non-null assertion.
          throw new Error('acquireProcessingLease: unreachable - acquire decided with invalid schema');
        }
        const nextAttemptCount = schemaCheck.attemptCount + 1;
        const newLeaseExpiresAtMs = computeLeaseExpiresAtMs(nowMs);

        requireAllowedTransition(status, 'processing');
        transaction.update(ref, {
          status: 'processing',
          workState: 'queued',
          processingStartedAt: FieldValue.serverTimestamp(),
          leaseExpiresAt: Timestamp.fromMillis(newLeaseExpiresAtMs),
          // workAvailableAt kept EXACTLY equal to leaseExpiresAt, atomically — this
          // record becomes eligible for recovery again exactly when (and not before)
          // this lease expires, and classifyWorkTuple's
          // 'processing-availability-lease-mismatch' check depends on these two fields
          // always being written together and equal.
          workAvailableAt: Timestamp.fromMillis(newLeaseExpiresAtMs),
          attemptCount: nextAttemptCount,
        });

        return {
          outcome: 'acquired',
          uid: schemaCheck.uid,
          preferenceRevisionAtClaim: schemaCheck.preferenceRevisionAtClaim,
          claimSchedule: schemaCheck.claimSchedule,
          attemptCount: nextAttemptCount,
        };
      }
    }
  });
}

async function commitFinalOutcome(
  reminderId: string,
  myAttemptCount: number,
  toStatus: string,
  updates: Record<string, unknown>
): Promise<'committed' | 'lost-race'> {
  const ref = reminderRef(reminderId);
  return db.runTransaction(async (transaction): Promise<'committed' | 'lost-race'> => {
    const snap = await transaction.get(ref);
    if (!snap.exists) return 'lost-race';
    const data = snap.data()!;
    if (data.status !== 'processing' || data.attemptCount !== myAttemptCount) {
      return 'lost-race';
    }
    requireAllowedTransition(data.status, toStatus);
    // Every terminal write atomically sets workState='terminal' together with
    // workAvailableAt/leaseExpiresAt=null (buildTerminalWorkStateFields) — this is what
    // structurally prevents BLOCKER 2 (a terminal record with a stale/corrupted
    // workAvailableAt can never poison the queue, because the queue's workState=='queued'
    // filter excludes it independent of whatever workAvailableAt contains).
    transaction.update(ref, { ...updates, status: toStatus, ...buildTerminalWorkStateFields(), processedAt: FieldValue.serverTimestamp() });
    return 'committed';
  });
}

type PhaseBCounters = {
  quarantinedCount: number;
  unknownStatusNeutralizedCount: number;
  terminalRepairedCount: number;
  alreadyTerminalCount: number;
  notFoundCount: number;
  stillLeasedCount: number;
  // Distinct from stillLeasedCount: this counts commitFinalOutcome losing its
  // attemptCount fence check (a late worker committing after another worker already
  // re-acquired/re-leased the same reminder), not a lease-acquisition outcome.
  commitLostRaceCount: number;
  leaseFailureCount: number;
  revalidationFailureCount: number;
  cancelledCount: number;
  progressFailureCount: number;
  invalidProgressCount: number;
  courseCompleteCount: number;
  installationFailureCount: number;
  dryRunCompleteCount: number;
  zeroInstallationCount: number;
  multiInstallationCount: number;
  unexpectedFailureCount: number;
  // Phase 3A-3 Step 3C-3 — fanout wiring. rolloutReadFailureCount mirrors every other
  // read-failure counter in this function (lease left untouched; a later invocation
  // retries). fannedOutCount/fanoutNotEligibleCount cover fanOutReminderDelivery's own two
  // outcome kinds when rollout resolves to dry-run for this uid.
  rolloutReadFailureCount: number;
  fannedOutCount: number;
  fanoutNotEligibleCount: number;
};

function emptyPhaseBCounters(): PhaseBCounters {
  return {
    quarantinedCount: 0,
    unknownStatusNeutralizedCount: 0,
    terminalRepairedCount: 0,
    alreadyTerminalCount: 0,
    notFoundCount: 0,
    stillLeasedCount: 0,
    commitLostRaceCount: 0,
    leaseFailureCount: 0,
    revalidationFailureCount: 0,
    cancelledCount: 0,
    progressFailureCount: 0,
    invalidProgressCount: 0,
    courseCompleteCount: 0,
    installationFailureCount: 0,
    dryRunCompleteCount: 0,
    zeroInstallationCount: 0,
    multiInstallationCount: 0,
    unexpectedFailureCount: 0,
    rolloutReadFailureCount: 0,
    fannedOutCount: 0,
    fanoutNotEligibleCount: 0,
  };
}

async function processCandidate(reminderId: string, counters: PhaseBCounters): Promise<void> {
  let lease: LeaseAcquireResult;
  try {
    lease = await acquireProcessingLease(reminderId);
  } catch (err) {
    counters.leaseFailureCount++;
    logger.error('[ReminderScheduler] lease acquisition failed', { reminderId, error: String(err) });
    return;
  }
  if (lease.outcome === 'not-found') {
    counters.notFoundCount++;
    return;
  }
  if (lease.outcome === 'still-leased') {
    counters.stillLeasedCount++;
    return;
  }
  if (lease.outcome === 'already-terminal') {
    counters.alreadyTerminalCount++;
    return;
  }
  if (lease.outcome === 'terminal-repaired') {
    counters.terminalRepairedCount++;
    logger.warn('[ReminderScheduler] repaired queue metadata on a recognized-terminal reminder found due+queued', { reminderId });
    return;
  }
  if (lease.outcome === 'unknown-status-neutralized') {
    counters.unknownStatusNeutralizedCount++;
    logger.warn('[ReminderScheduler] neutralized an unrecognized-status reminder found due+queued — requires operator investigation', {
      reminderId,
    });
    return;
  }
  if (lease.outcome === 'quarantined') {
    counters.quarantinedCount++;
    logger.warn('[ReminderScheduler] quarantined a malformed reminder record during lease acquisition', {
      reminderId,
      reason: lease.reason,
    });
    return;
  }

  const { uid, preferenceRevisionAtClaim, claimSchedule, attemptCount } = lease;

  let consentCheck: ConsentRevalidation;
  try {
    const prefSnap = await preferencesRef(uid).get();
    const data = prefSnap.exists ? prefSnap.data()! : undefined;
    const currentSchedule = data ? validateSchedule(data) : null;
    consentCheck = revalidateConsent(preferenceRevisionAtClaim, claimSchedule, {
      exists: prefSnap.exists,
      enabled: data?.enabled,
      revision: data?.revision,
      schedule: currentSchedule ?? undefined,
    });
  } catch (err) {
    counters.revalidationFailureCount++;
    logger.error('[ReminderScheduler] consent revalidation read failed', { uid, reminderId, error: String(err) });
    return; // lease will expire; a later invocation retries this same reminderId.
  }

  if (consentCheck.outcome === 'cancelled') {
    const result = await commitFinalOutcome(reminderId, attemptCount, 'cancelled', { cancelReason: consentCheck.reason });
    if (result === 'committed') counters.cancelledCount++;
    else counters.commitLostRaceCount++;
    return;
  }

  let progress: ProgressResult;
  try {
    const dataSnap = await userDataRef(uid).get();
    progress = classifyProgress(dataSnap.exists ? (dataSnap.data() as Record<string, unknown>) : undefined);
  } catch (err) {
    counters.progressFailureCount++;
    logger.error('[ReminderScheduler] progress read failed', { uid, reminderId, error: String(err) });
    return;
  }

  if (progress.kind === 'invalid') {
    const result = await commitFinalOutcome(reminderId, attemptCount, 'invalid-progress', {});
    if (result === 'committed') counters.invalidProgressCount++;
    else counters.commitLostRaceCount++;
    return;
  }

  if (progress.courseComplete) {
    const result = await commitFinalOutcome(reminderId, attemptCount, 'course-complete', { nextUnfinishedDay: null });
    if (result === 'committed') counters.courseCompleteCount++;
    else counters.commitLostRaceCount++;
    return;
  }

  // Phase 3A-3 Step 3C-3 — fanout wiring. Rollout config is read fresh here (never trusted
  // from an earlier read) and decided via reminderDeliveryLogic.ts's already-approved, pure
  // decideShouldFanOut. In current production, artifacts/neuroactive-prod/systemConfig/
  // notificationRollout does not exist yet — decideShouldFanOut(undefined, uid) resolves to
  // {shouldFanOut:false} in that case (parseRolloutConfig fails closed to 'paused' for a
  // missing document), so this entire branch is a structural no-op until that document is
  // deliberately created, and every reminder continues to reach the unchanged
  // dry-run-complete path below exactly as before this round.
  //
  // fanOutReminderDelivery re-reads and re-verifies the SAME (status==='processing' &&
  // attemptCount===attemptCount) fence transactionally inside itself — it is not passed
  // anything from this read that it doesn't already independently re-validate, so no
  // duplicate/redundant fencing is needed here. On a fanned-out reminder, this function
  // returns immediately afterward: fanOutReminderDelivery's own transaction is what commits
  // the parent's terminal write (status/workState), so commitFinalOutcome must NOT also be
  // called for this reminderId — doing so would violate the fence (attemptCount already
  // matches, but status is no longer 'processing') and correctly be a no-op lost-race, but
  // is avoided entirely here for clarity rather than relied upon as a safety net.
  let rolloutRaw: unknown;
  try {
    const rolloutSnap = await db.doc(`artifacts/${APP_ID}/systemConfig/notificationRollout`).get();
    rolloutRaw = rolloutSnap.exists ? rolloutSnap.data() : undefined;
  } catch (err) {
    counters.rolloutReadFailureCount++;
    logger.error('[ReminderScheduler] rollout config read failed', { uid, reminderId, error: String(err) });
    return; // lease will expire; a later invocation retries this same reminderId.
  }
  if (decideShouldFanOut(rolloutRaw, uid).shouldFanOut) {
    const fanoutResult = await fanOutReminderDelivery(db, reminderId, attemptCount);
    if (fanoutResult.outcome === 'fanned-out') counters.fannedOutCount++;
    else counters.fanoutNotEligibleCount++;
    return;
  }

  let installationCount: number;
  try {
    const installSnap = await db.collection(`artifacts/${APP_ID}/pushInstallations`).where('uid', '==', uid).get();
    installationCount = installSnap.docs.filter((d) => d.data().state === 'active').length;
  } catch (err) {
    counters.installationFailureCount++;
    logger.error('[ReminderScheduler] installation query failed', { uid, reminderId, error: String(err) });
    return;
  }

  const result = await commitFinalOutcome(reminderId, attemptCount, 'dry-run-complete', {
    nextUnfinishedDay: progress.currentDay,
    wouldTargetInstallationCount: installationCount,
    deepLink: '/',
    notificationTitle: 'NeuroActive',
    notificationBody: 'Your next session is ready.',
  });
  if (result === 'committed') {
    counters.dryRunCompleteCount++;
    if (installationCount === 0) counters.zeroInstallationCount++;
    else if (installationCount > 1) counters.multiInstallationCount++;
  } else {
    counters.commitLostRaceCount++;
  }
}

async function runPhaseB(): Promise<{ recoverableCount: number } & PhaseBCounters> {
  const candidateIds = await discoverRecoverableWork();
  const counters = emptyPhaseBCounters();

  await processWithBoundedConcurrency(candidateIds, PROCESS_CONCURRENCY, async (reminderId) => {
    try {
      await processCandidate(reminderId, counters);
    } catch (err) {
      counters.unexpectedFailureCount++;
      logger.error('[ReminderScheduler] Phase B unexpected error', { reminderId, error: String(err) });
    }
  });

  return { recoverableCount: candidateIds.length, ...counters };
}

// =========================================================================================
// Scheduled entry point. No separate "integrity scan" phase this round — see the note
// above discoverRecoverableWork for why the workState/workAvailableAt model makes one
// structurally unnecessary for correctness. If future opportunistic diagnostics/auditing
// of the reminders collection is ever wanted, it must be built as a clearly-labeled
// best-effort tool that scheduler correctness does NOT depend on, not reintroduced here.
// =========================================================================================
export const notificationReminderSchedulerDryRun = onSchedule(
  { schedule: 'every 5 minutes', timeoutSeconds: 300, memory: '256MiB' },
  async () => {
    const phaseASummary = await runPhaseA();
    logger.info('[ReminderScheduler] Phase A summary', phaseASummary);

    const phaseBSummary = await runPhaseB();
    logger.info('[ReminderScheduler] Phase B summary', phaseBSummary);
  }
);
