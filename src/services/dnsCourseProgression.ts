// src/services/dnsCourseProgression.ts
//
// Pure calendar-day pacing logic for the 12-Week DNS Foundations course. Separates two
// concepts a prior version of this feature conflated into a single date comparison:
//
//   - currentDay: which lesson is the next SEQUENTIAL one the user hasn't completed yet.
//     Advances only on an explicit Mark Complete action (unchanged from before this fix).
//   - maxAvailableDay: how many lessons calendar time has made available so far, derived
//     ONLY from startedAt and today — one additional lesson per elapsed local calendar
//     day, entirely independent of whether (or when) the user actually clicked Mark
//     Complete on any particular day.
//
// The lesson the user may currently view/complete is min(currentDay, maxAvailableDay).
// The "come back tomorrow" wait state is currentDay > maxAvailableDay — NOT "did the user
// already click Mark Complete today." That distinction is the fix for the reported
// defect: a user who does a lesson but delays clicking Mark Complete by a day no longer
// loses a full calendar day of pacing merely for clicking late — Day 3 opens immediately
// if the calendar has already made it available, even though Day 2 was marked complete a
// day later than it was performed.
//
// All functions here are pure (explicit inputs, no Date.now()/window/Firestore access),
// so they're fully unit-testable with plain Node — no DOM/jsdom or Firebase emulator
// required. This is deliberately NOT a security or entitlement boundary (see
// DNSCourseView.tsx's separate, server-verified dnsEntitlementState check) — it only ever
// governs pacing/UX, exactly as the rest of this app already treats client-supplied dates.

export type LocalDateString = string; // YYYY-MM-DD, always device-local calendar date

// Parses a local calendar-date string into a UTC-noon-anchored instant, purely for
// subtraction. Anchoring at noon (rather than midnight) rather than doing local-timezone
// arithmetic directly sidesteps DST entirely: a DST transition can shift a
// midnight-anchored local Date by up to an hour, which can occasionally miscount a day
// boundary; noon has margin on both sides that no real-world DST shift (never more than a
// couple of hours) can cross. Both the "start" and "end" dates are LOCAL calendar dates by
// construction (see App.tsx's todayLocalISO) — this function only ever compares two
// values from that same convention, never mixes local and UTC dates.
function parseLocalDateAsUtcNoon(dateStr: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const ms = Date.UTC(year, month - 1, day, 12, 0, 0, 0);
  // Reject a date that doesn't round-trip (e.g. 2026-02-30, silently normalized by Date
  // to March 2nd) rather than accepting a calendar date that never actually existed.
  const check = new Date(ms);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return ms;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Whole elapsed calendar days between two LOCAL date strings (end - start), correctly
// spanning month/year boundaries and leap days (Date.UTC does real calendar arithmetic,
// not a naive string comparison). Returns null if either date is malformed — callers
// decide the safe fallback for their own use case (see computeMaxAvailableDay below).
export function daysBetweenLocalDates(startDateStr: string, endDateStr: string): number | null {
  const start = parseLocalDateAsUtcNoon(startDateStr);
  const end = parseLocalDateAsUtcNoon(endDateStr);
  if (start === null || end === null) return null;
  return Math.round((end - start) / MS_PER_DAY);
}

// One additional lesson becomes available per elapsed local calendar day since
// startedAt — Day 1 is available the moment startedAt IS today (0 elapsed days), Day 2
// the day after, and so on — capped at courseLength. A missing startedAt (not yet
// started), a malformed one (data anomaly), or one that's somehow after `today` (a
// clock/data anomaly) all conservatively yield 1: this can never block a legitimate user
// from at least their first lesson, and never grants anything beyond what a genuinely
// trustworthy elapsed-time calculation would.
export function computeMaxAvailableDay(startedAt: string, today: string, courseLength: number): number {
  if (!startedAt) return 1;
  const elapsed = daysBetweenLocalDates(startedAt, today);
  if (elapsed === null || elapsed < 0) return 1;
  return Math.min(elapsed + 1, courseLength);
}

export type DnsCourseProgressLike = {
  currentDay: number;
  lastCompletedDate: string;
  startedAt: string;
  completionDates?: Record<number, string>;
};

export type DnsDayAvailability = {
  // How many lessons elapsed calendar time has made available as of `today`.
  maxAvailableDay: number;
  // The lesson currently open for viewing/completion — null whenever there's nothing to
  // show (waiting for tomorrow, or the course is already finished).
  openDay: number | null;
  // The "come back tomorrow" wait state: every lesson calendar time allows has already
  // been completed, but the course itself isn't finished yet.
  waitingForNextDay: boolean;
  // Every lesson (1..courseLength) has been completed.
  courseComplete: boolean;
  // True when the user's most recent completion happened on today's local calendar date
  // — drives the "Day N complete" confirmation banner's content specifically, orthogonal
  // to whether a NEW lesson is open right now (a catch-up completion earlier today, for
  // example, can be true here while openDay is also non-null for a later lesson that
  // catch-up made available the same day).
  completedSomethingToday: boolean;
  // Whenever the wait state applies (now or once the current lesson is completed), this
  // is the specific lesson index to reference in that messaging — always the most
  // recently completed lesson (currentDay - 1), which is well-defined (>= 1) any time
  // this is needed, since maxAvailableDay is never less than 1.
  mostRecentlyCompletedDay: number;
  // Whether completing openDay right now would immediately reveal the NEXT lesson (still
  // within today's calendar ceiling) versus hitting the wait state — used to give the
  // locked-next-day teaser accurate copy ("unlocks after you complete this one" vs.
  // "unlocks tomorrow").
  nextLessonAvailableImmediately: boolean;
};

export function computeDnsDayAvailability(
  dnsCourse: DnsCourseProgressLike,
  today: string,
  courseLength: number
): DnsDayAvailability {
  // Uses the conservative DERIVED anchor, not dnsCourse.startedAt directly — a
  // missing/malformed startedAt (a defensive case; the "Before You Start" gate normally
  // prevents ever reaching Day 1 without one) must never permanently freeze someone in
  // the wait state just because no completion action has happened yet to trigger
  // reduceDnsCourseCompletion's own self-healing repair. Read-time and write-time always
  // agree on what startedAt "effectively" is, via this same function.
  const effectiveStartedAt = deriveConservativeStartedAt(dnsCourse, today);
  const maxAvailableDay = computeMaxAvailableDay(effectiveStartedAt, today, courseLength);
  const courseComplete = dnsCourse.currentDay > courseLength;
  const waitingForNextDay = !courseComplete && dnsCourse.currentDay > maxAvailableDay;
  const openDay = !courseComplete && !waitingForNextDay ? dnsCourse.currentDay : null;
  return {
    maxAvailableDay,
    openDay,
    waitingForNextDay,
    courseComplete,
    completedSomethingToday: dnsCourse.lastCompletedDate === today,
    mostRecentlyCompletedDay: dnsCourse.currentDay - 1,
    nextLessonAvailableImmediately: openDay !== null && openDay < maxAvailableDay,
  };
}

// Pure reducer for a single Mark Complete action. Given the AUTHORITATIVE current
// progress (read fresh — e.g. inside a Firestore transaction, see App.tsx's
// completeDnsCourseDay) and today's date, returns the next state — or the UNCHANGED
// input (by reference) if there's genuinely nothing left to complete today (the calendar
// ceiling was already reached, or the course is already finished). Returning the same
// reference for a no-op lets a caller cheaply detect "nothing changed, don't write."
//
// `expectedCompletedDay` is the day the CALLER actually displayed/watched and clicked
// Mark Complete for (see DNSCourseView's handleMarkComplete, which passes its own
// availability.openDay — never derived from whatever currentDay happens to be when this
// runs). This must equal the freshly-read openDay for the completion to proceed: without
// this check, a stale tab still showing an EARLIER day (already completed by another tab
// in the meantime) would silently complete whatever LATER day is now actually open —
// crediting the user for a lesson they never saw, using a click that was actually meant
// for a different (already-done) one. A mismatch is treated exactly like a reached
// ceiling: a safe no-op, never a substitute completion.
//
// Read fresh + always deterministic from (existing, today, courseLength) is what makes
// this safe against a double-click, two racing tabs, or a stale local render: whichever
// call actually reads first always wins; a second/stale/racing call recomputes from
// whatever the first one just committed and is naturally a no-op once the ceiling (or the
// sequential lesson after it) is reached, never regressing currentDay or completionDates.
export function reduceDnsCourseCompletion(
  existing: DnsCourseProgressLike,
  today: string,
  courseLength: number,
  expectedCompletedDay: number
): DnsCourseProgressLike {
  const availability = computeDnsDayAvailability(existing, today, courseLength);
  if (availability.openDay === null || availability.openDay !== expectedCompletedDay) return existing;
  const completedDay = existing.currentDay;
  return {
    ...existing,
    // Self-healing: persists the same conservative anchor computeDnsDayAvailability
    // already used to decide THIS completion was allowed, so a missing/malformed
    // startedAt (a data anomaly — the "Before You Start" gate normally requires it to be
    // set first) gets durably repaired the next time it's actually written, rather than
    // silently relying on the read-time fallback forever. A no-op whenever startedAt is
    // already valid (deriveConservativeStartedAt returns it unchanged).
    startedAt: deriveConservativeStartedAt(existing, today),
    lastCompletedDate: today,
    currentDay: Math.min(completedDay + 1, courseLength + 1),
    completionDates: { ...existing.completionDates, [completedDay]: today },
  };
}

// Deterministic, conservative start-date derivation for existing records that predate
// this fix — see the data-compatibility notes in the accompanying report for the full
// reasoning. Never invoked automatically; call sites decide when a repair is appropriate
// (see App.tsx's one-time hydration-time backfill).
//
// Rule: if startedAt is already a valid, non-future date, it is trusted as-is (it already
// anchors the calendar ceiling correctly and must never be moved). Otherwise, derive the
// most conservative anchor that (a) never moves a user backward relative to their
// existing currentDay/completionDates, and (b) never grants more calendar-earned days
// than they already have real completion evidence for: the EARLIEST completionDates entry
// if one exists (the day they demonstrably first engaged with the course), else
// lastCompletedDate, else — for a genuinely brand-new record with no evidence at all —
// today, which conservatively starts them at Day 1 pacing rather than assuming any
// elapsed time at all.
export function deriveConservativeStartedAt(
  dnsCourse: DnsCourseProgressLike,
  today: string
): LocalDateString {
  const elapsedSinceStored = dnsCourse.startedAt ? daysBetweenLocalDates(dnsCourse.startedAt, today) : null;
  // Valid AND not in the future — a future-dated startedAt (a clock/data anomaly, same
  // category as a malformed one) is repaired the same way rather than trusted, so a
  // record with real completion evidence can self-heal instead of being frozen at
  // maxAvailableDay=1 for as long as the bogus future date remains in the future.
  if (elapsedSinceStored !== null && elapsedSinceStored >= 0) {
    return dnsCourse.startedAt;
  }
  // Same "valid AND not in the future" bar as startedAt above — a future-dated
  // completionDates/lastCompletedDate entry is exactly as untrustworthy as a future-dated
  // startedAt and must never be used as an anchor.
  const isUsableAnchor = (d: unknown): d is string => {
    if (typeof d !== 'string') return false;
    const elapsed = daysBetweenLocalDates(d, today);
    return elapsed !== null && elapsed >= 0;
  };
  const completionEntries = Object.values(dnsCourse.completionDates ?? {}).filter(isUsableAnchor);
  if (completionEntries.length > 0) {
    return completionEntries.reduce((earliest, d) => (d < earliest ? d : earliest));
  }
  if (isUsableAnchor(dnsCourse.lastCompletedDate)) {
    return dnsCourse.lastCompletedDate;
  }
  return today;
}
