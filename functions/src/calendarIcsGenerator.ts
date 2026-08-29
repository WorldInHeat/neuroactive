// functions/src/calendarIcsGenerator.ts
// Calendar Integration Phase 1, Stage 3 — PURE ICS GENERATION ONLY, implementing the
// Codex-approved Stage 3 design. Deliberately has ZERO imports from 'firebase-admin/*',
// 'firebase-functions/*', './calendarSubscriptions', './calendarPreferences', or any
// network/OAuth module — every function here is a plain, synchronous, dependency-free
// function of its explicit inputs, matching the same convention already established by
// reminderDeliveryLogic.ts, reminderSchedulerLogic.ts, and pushInstallationEpochLogic.ts
// (see reminderDeliveryLogic.ts's own header for the fuller statement of this pattern).
// Exercised by a real repository-local test file (calendarIcsGenerator.test.ts) without
// needing a Firestore emulator, network access, or any Firebase credentials.
//
// LAYERING: a future feed endpoint (NOT built in this stage) is responsible for reading
// Firestore, authenticating the bearer token, and translating the already-canonical Stage 2
// calendarPreferences/main document (plus a caller-supplied opaque stable event identity —
// see STABLE EVENT IDENTITY below) into the CalendarFeedInput shape this file consumes. This
// file never reads Firestore, never sees a Firebase Auth uid, a raw subscription secret, or
// a secretHash, and never imports either Stage 1 or Stage 2's implementation files.
//
// DECOUPLING GUARANTEE: this file has NO dependency on, and takes NO input from,
// notificationPreferences.ts or any course-progress/dnsCourse state — the same guarantee
// calendarPreferences.ts's own header documents, extended here. The locked event content
// (SUMMARY/DESCRIPTION below) is the ONLY calendar content this file ever emits; it never
// exposes lesson identity, course day, exercise name, diagnosis, symptoms, progress,
// completion state, entitlement state, or notification state.
//
// STABLE EVENT IDENTITY: a subscribed feed represents ONE logical recurring event series,
// so its ICS UID must remain unchanged when schedule preferences (weekdays/localTime/
// timezone/sessionDurationMinutes/revision) change — otherwise every edit would appear to a
// calendar client as a brand-new, unrelated event rather than an update to the existing
// series. This file therefore takes `eventUid` as an EXPLICIT, OPAQUE, already-decided input
// — it is never derived from any schedule field, and this file has no opinion on where the
// caller sources it from (a Firestore subscriptionId, or any other stable non-secret
// identity the future feed endpoint chooses is fine). This file's ONLY responsibility for
// `eventUid` is FORMAT validation (see EVENT_UID_PATTERN below) — it cannot itself verify
// that the caller didn't put a Firebase uid, email, raw secret, or secretHash into it, so
// that remains an obligation on whatever future code supplies this value. The final ICS UID
// property value is `${eventUid}@${ICS_UID_DOMAIN}` (see below) — a conventional
// RFC 5545-recommended "unique-part@domain" shape.
//
// TESTING SEAM: unlike every other file in this project's Calendar Integration work, this
// file has no "Core function + thin onCall wrapper" split, because there IS no wrapper —
// per Codex's explicit instruction, Stage 3 exports no Cloud Function at all. The single
// exported entry point, generateCalendarIcs, IS the whole public surface, and is exercised
// directly by calendarIcsGenerator.test.ts.
//
// CODEX REPAIR PASS 1 — four issues fixed, summarized here; each is documented in full
// detail at its own point in this file below:
//   1. VTIMEZONE local transition literals (DTSTART/RDATE inside a STANDARD/DAYLIGHT
//      sub-component) were being computed using the WRONG offset (TZOFFSETTO instead of
//      TZOFFSETFROM) — see buildVTimezoneText's own comment for the concrete before/after
//      values and the RFC 5545 reasoning.
//   2. `anchorDateMs` ("caller-supplied reference now") was fundamentally the wrong
//      contract: two fetches of the SAME persisted preferences on different calendar days
//      could produce different DTSTART values, breaking series identity. Replaced by
//      `seriesAnchorMs` (an immutable, persisted-per-subscription reference instant) plus a
//      separate `recurrenceHorizonMs` (how far forward this representation currently
//      extends) — see STABLE SERIES ANCHOR / RECURRENCE HORIZON below.
//   3. An indefinite (COUNT/UNTIL-less) VEVENT RRULE combined with a finite VTIMEZONE window
//      was internally incoherent. RRULE now carries an explicit UNTIL aligned exactly to the
//      same horizon the VTIMEZONE window is bounded to — see RECURRENCE LIFETIME below.
//   4/5. Date-range and transition-scanning assumptions are now explicit, validated
//      boundaries (a defined supported timezone/date domain) rather than silent, unbounded
//      assumptions — see SUPPORTED DOMAIN below.
//
// CODEX REPAIR PASS 2 — three further executable defects fixed, plus contract/boundary
// clarifications:
//   1. findTransitionsInWindow's daily-step sampling could leave a trailing partial interval
//      (less than 24h) before recurrenceHorizonMs entirely unsampled, silently omitting a
//      transition that falls inside it — see that function's own comment.
//   2. A VTIMEZONE built only from DETECTED transitions could omit any governing observance
//      for the VEVENT's own DTSTART, when seriesAnchorMs (and therefore DTSTART) falls before
//      every transition the scan finds. Fixed by always emitting an explicit BASELINE
//      observance — see BASELINE OBSERVANCE ARCHITECTURE below. This also made the old
//      one-year lookback both unnecessary and undesirable (it could derive dates before the
//      supported domain floor) — removed entirely.
//   3. Nothing previously guaranteed the computed VEVENT DTSTART actually fell at or before
//      recurrenceHorizonMs/UNTIL — a short horizon combined with a schedule whose first
//      occurrence lands further out could emit a self-contradictory RRULE (a recurrence
//      whose very first instance is already past its own UNTIL). Fixed by resolving
//      DTSTART's real absolute instant and failing closed if it exceeds the horizon — see
//      DTSTART <= UNTIL ENFORCEMENT below.
//   4/5. The horizon-renewal versioning contract and seriesAnchorMs's precise calendar-date
//      (not instant-floor) semantics are now stated unambiguously — see their respective
//      field comments on CalendarFeedInput below. No functional/runtime change; Stage 3
//      remains pure and stateless, exactly as before.
//   6. MAX_SUPPORTED_EPOCH_MS corrected to include the true last millisecond of its stated
//      end date; the recurrence-horizon span constant renamed to make clear it is a
//      fixed-day approximation, not calendar-year arithmetic.
'use strict';

// ---------------------------------------------------------------------------------------
// ERROR TYPE — this file's own, Firebase-independent error class. Every fail-closed path in
// this file throws this (never a bare Error, never an HttpsError, which would require a
// firebase-functions import this file deliberately does not have).
// ---------------------------------------------------------------------------------------
export class IcsGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IcsGenerationError';
  }
}

// ---------------------------------------------------------------------------------------
// PUBLIC INPUT CONTRACT — a narrow, generator-specific type, deliberately NOT coupled to any
// callable/Firebase request object (per Codex's explicit instruction). Every field below is
// validated at runtime by validateCalendarFeedInput — TypeScript's compile-time typing is
// never trusted alone, matching this project's established "never trust a type declaration
// at runtime" culture (see calendarPreferences.ts's own strict stored-state contract for the
// same philosophy applied to Stage 2).
// ---------------------------------------------------------------------------------------
export type CalendarFeedInput = {
  // Opaque, pre-decided, stable public event identity — see STABLE EVENT IDENTITY above.
  // Must match EVENT_UID_PATTERN. Never derived from schedule fields by this file.
  eventUid: string;
  // 0=Sunday..6=Saturday, matching Stage 2's own numbering (duplicated, not imported — see
  // the DECOUPLING GUARANTEE above). Must already be canonical: non-empty, integers 0-6,
  // no duplicates, strictly ascending — this file does not sort or repair non-canonical
  // input, matching Stage 2's own "trust stored state MORE, not less" philosophy.
  weekdays: number[];
  // Strict 24-hour 'HH:MM', matching Stage 2's own format.
  localTime: string;
  // Canonical IANA timezone identifier — must be byte-for-byte equal to what
  // Intl.DateTimeFormat itself resolves it to (same strictness as Stage 2's stored-state
  // timezone check), not merely a valid alias.
  timezone: string;
  // Integer minutes, matching Stage 2's own bounds (duplicated below, not imported).
  sessionDurationMinutes: number;
  // CODEX REPAIR PASS 2, ISSUE 4 (broadened beyond "Stage 2's calendar preference revision"):
  // used directly as the VEVENT SEQUENCE basis (see SEQUENCE CONTRACT below) — but its
  // TRUE meaning is "the revision of THIS FEED REPRESENTATION," not narrowly "Stage 2's
  // preference-document revision." A caller MUST increment this value for ANY change that
  // would alter this generator's output for the same eventUid — a genuine Stage 2 preference
  // edit, a timezone change, AND a horizon-only renewal (see RECURRENCE LIFETIME's RENEWAL
  // SEMANTICS below) with no preference change at all. Must be a safe integer >= 1.
  revision: number;
  // CODEX REPAIR PASS 2, ISSUE 4: similarly broadened — this is "the modification time of
  // this feed representation," not narrowly "Stage 2's preference updatedAt." A caller MUST
  // refresh this value alongside `revision` for the same set of changes described above,
  // including a horizon-only renewal. Converted to a plain number OUTSIDE this file by the
  // caller (this file never imports firebase-admin/firestore's Timestamp type). Used for
  // BOTH DTSTAMP and LAST-MODIFIED — see DTSTAMP / LAST-MODIFIED CONTRACT below for why they
  // are deliberately the same value.
  updatedAtMs: number;
  // STABLE SERIES ANCHOR (Codex repair pass 1, issue 2; semantics clarified in repair pass 2,
  // issue 5) — an IMMUTABLE, PERSISTED-PER-SUBSCRIPTION reference instant, e.g. the
  // subscription's own creation time. This is EMPHATICALLY NOT "the current time of this
  // particular fetch/request" — a future feed endpoint must persist this value once (at
  // subscription creation, or another explicitly immutable point) and supply the SAME value
  // on every subsequent generation for that subscription, for its entire lifetime.
  //
  // PRECISE SEMANTICS (repair pass 2, issue 5 — do not read this as "first occurrence on or
  // after the anchor INSTANT"): this file converts seriesAnchorMs to a CALENDAR DATE (year/
  // month/day only) as observed in the target timezone, discarding its own time-of-day
  // entirely, then walks forward from that DATE to the first date whose weekday is in the
  // currently-configured set, and applies the CONFIGURED localTime to that date — not the
  // anchor's own time-of-day. Concretely: an anchor of Monday 10:00 with a Monday-only
  // schedule configured for 09:00 resolves to THAT SAME Monday at 09:00 — a wall-clock
  // instant EARLIER than the anchor itself. This is intentional and acceptable: the anchor's
  // sole job is to pin WHICH CALENDAR DATE the series logically starts counting from, not to
  // establish a "no occurrence before this exact instant" floor.
  //
  // Because seriesAnchorMs never changes, an unchanged schedule (weekdays/localTime/
  // timezone) always resolves to the exact same first occurrence, on any later fetch,
  // forever — refresh stability by construction, not by convention. A GENUINE schedule edit
  // is still free to change the computed first occurrence, exactly as it should: the
  // series' UID stays the same (see STABLE EVENT IDENTITY above) while DTSTART/RRULE update
  // to reflect the new schedule and SEQUENCE increments to signal the change. This file
  // still NEVER calls Date.now() internally; the caller must not smuggle "now" in through
  // this field either.
  seriesAnchorMs: number;
  // RECURRENCE HORIZON (Codex repair pass 1, issue 3) — an explicit instant, strictly after
  // seriesAnchorMs, beyond which THIS representation does not yet define occurrences: both
  // the VEVENT RRULE's UNTIL and the VTIMEZONE's transition-scanning window end here. Unlike
  // seriesAnchorMs, a future feed endpoint MAY legitimately advance this value over time (a
  // deliberate, persisted "renewal" action — see RECURRENCE LIFETIME below) without
  // disturbing the series' identity (UID/DTSTART are untouched by this field); doing so
  // changes the emitted bytes, so Stage 4 must treat a horizon extension as a real update
  // (bump SEQUENCE) like any other content change. This file never derives this value from
  // its own clock — it is always the caller's explicit, deliberate choice.
  recurrenceHorizonMs: number;
};

// ---------------------------------------------------------------------------------------
// VALIDATION CONSTANTS — duplicated from calendarPreferences.ts's own constants by the same
// established per-file convention this project already uses (see that file's own duplication
// of requireNonAnonymousAuth/CALLABLE_OPTIONS for the stated rationale: each file's own copy
// can never become a source of cross-file regression, and this file must not import from
// calendarPreferences.ts at all per the DECOUPLING GUARANTEE above).
// ---------------------------------------------------------------------------------------
const VALID_WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_SESSION_DURATION_MINUTES = 5;
const MAX_SESSION_DURATION_MINUTES = 120;

// Deliberately conservative: RFC 5545's ABNF for SEQUENCE is merely `1*DIGIT` (unbounded),
// but real-world calendar clients (Apple Calendar/iCloud, Google Calendar, Outlook.com,
// desktop Outlook) commonly implement it as a 32-bit signed integer internally. Stage 2's
// revision is a JS safe integer (up to 2^53-1), which is NOT reduced, wrapped, or truncated
// to fit here — if it ever exceeds this bound, generation fails closed (see
// requireIcsSequence below) rather than silently emitting a value some real client might
// misinterpret or reject.
const MAX_ICS_SEQUENCE = 2147483647; // 2^31 - 1

// Opaque event-identity format: conservative alphanumeric-plus-safe-separators, bounded
// length. Chosen specifically because none of these characters ever require RFC 5545 TEXT
// escaping (no backslash/comma/semicolon/CR/LF/colon/quote can ever appear), so the UID
// property's value is always safe to emit verbatim once this pattern is satisfied — this is
// a REJECT-on-violation boundary, not an escape-on-violation one (see INJECTION RESISTANCE
// in the test file for why identity/structural fields are rejected outright rather than
// escaped).
const EVENT_UID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

// UID CONTRACT: the final ICS UID property value is `${eventUid}@${ICS_UID_DOMAIN}` — the
// RFC 5545-recommended "unique-part@domain" shape. This domain is a fixed, stable, non-secret
// label (the product's own domain), never a per-user or per-subscription value.
const ICS_UID_DOMAIN = 'neuroactivehealth.com';

// PRODID: RFC 5545's own recommended `-//vendor//product//language` shape. Chosen once, kept
// stable — this value must never change across regenerations of the same or different feeds,
// since some calendar clients use PRODID as part of their own internal bookkeeping.
const ICS_PRODID = '-//NeuroActive//NeuroActive Calendar//EN';

const CALENDAR_NAME = 'NeuroActive Training';

// LOCKED EVENT CONTENT (product contract — see this file's header). These two constants are
// the ONLY user-facing text this file ever emits inside a VEVENT.
const EVENT_SUMMARY = 'NeuroActive Training';
const EVENT_DESCRIPTION = 'Open NeuroActive to continue with your next session.';

// 0=Sunday..6=Saturday -> RFC 5545 BYDAY two-letter codes.
const BYDAY_MAP: Record<number, string> = { 0: 'SU', 1: 'MO', 2: 'TU', 3: 'WE', 4: 'TH', 5: 'FR', 6: 'SA' };

const DAY_MS = 24 * 60 * 60 * 1000;

// SUPPORTED DOMAIN (Codex repair pass 1, issues 4 & 5) — this generator does not claim
// correctness for arbitrary dates across all of human history or the far future. It is
// explicitly validated and restricted to:
//   - Dates from 2020-01-01 (comfortably before this product's existence — no legitimate
//     persisted timestamp of ours could predate it) through 2100-12-31 (a deliberately
//     conservative outer bound: tzdata rule projections that far out are inherently
//     speculative for any zone, and no NeuroActive calendar subscription's practical
//     lifetime should ever approach it).
//   - Any IANA timezone identifier this runtime's Intl.DateTimeFormat resolves to itself
//     (canonical-form match required — see requireCanonicalTimezone).
// WHY THIS MAKES THE ALGORITHM'S ASSUMPTIONS SOUND (previously undocumented, now explicit):
//   - Daily offset sampling (see findTransitionsInWindow) is sufficient because, within this
//     modern domain, no IANA zone has two distinct offset transitions within a single day —
//     that historical phenomenon (e.g. wartime double-summer-time) is confined to eras well
//     outside this domain.
//   - The "offset increase => DAYLIGHT, decrease => STANDARD" classification (see
//     groupTransitionsIntoComponents) is correct for the overwhelming, dominant case of
//     annual DST cycling within this domain. The one acknowledged residual gap: a zone that
//     performs a PERMANENT one-time base-offset redefinition (a country abolishing DST
//     entirely, for instance) would still get numerically CORRECT TZOFFSETFROM/TZOFFSETTO/
//     transition-instant values from this classification (calendar-client interoperability,
//     which depends on those numbers, is unaffected) — only the cosmetic STANDARD/DAYLIGHT
//     keyword could be imprecise for that one transition. This is an accepted, documented
//     limitation, not a silent assumption.
//   - A zone with ZERO transitions detected inside the bounded
//     [seriesAnchorMs - VTIMEZONE_LOOKBACK_YEARS, recurrenceHorizonMs] window is treated as
//     fixed-offset ONLY for the purposes of THIS bounded representation — which is now
//     honest and sufficient precisely because RRULE/VTIMEZONE lifetime are aligned (see
//     RECURRENCE LIFETIME below): this file makes no claim about anything beyond the
//     horizon it explicitly declares via RRULE's own UNTIL.
const MIN_SUPPORTED_EPOCH_MS = Date.UTC(2020, 0, 1);
// Codex repair pass 2, issue 6: the previous value, Date.UTC(2100, 11, 31, 23, 59, 59),
// excluded the final 999ms of 2100-12-31 despite the comment claiming "through 2100-12-31."
// Date.UTC(2101, 0, 1) - 1 is the TRUE last millisecond of 2100-12-31T23:59:59.999Z.
const MAX_SUPPORTED_EPOCH_MS = Date.UTC(2101, 0, 1) - 1;

// RECURRENCE LIFETIME (Codex repair pass 1, issue 3) — chosen approach, reasoned explicitly:
//
// OPTION CONSIDERED AND REJECTED: emit a traditional, fully future-complete VTIMEZONE using
// abstract recurring rules per sub-component (e.g. "RRULE:FREQ=YEARLY;BYDAY=1SU;BYMONTH=4"),
// the way IANA-to-VTIMEZONE converters like `vzic` do, so the VEVENT's own RRULE could
// remain genuinely indefinite. REJECTED because correctly INFERRING an abstract recurrence
// rule from empirically-sampled transition instants is a materially harder and more
// error-prone problem than detecting the instants themselves (irregular zones, zones with
// rule changes, and zones with non-simple BYDAY patterns are all real failure modes for a
// general inference algorithm) — not the smallest robust solution available.
//
// OPTION CHOSEN: bound BOTH the VTIMEZONE window and the VEVENT RRULE's own UNTIL to the
// SAME explicit horizon (recurrenceHorizonMs). This is the smallest change that restores
// internal coherence: the RRULE now honestly declares "this representation recurs only
// through this instant," matching exactly what the VTIMEZONE block defines. RFC 5545 requires
// UNTIL to be expressed in UTC whenever DTSTART carries a timezone reference (which ours
// always does) — see buildRruleValue.
//
// RENEWAL SEMANTICS FOR STAGE 4 (Codex repair pass 2, issue 4 — HORIZON RENEWAL VERSIONING
// CONTRACT): recurrenceHorizonMs is NOT computed by this file and is NOT tied to wall-clock
// "now" — it is a deliberate, explicit, caller-supplied choice. A future feed endpoint is
// expected to pick a horizon comfortably in the future (this file bounds the SPAN to at most
// MAX_RECURRENCE_HORIZON_SPAN_DAYS from seriesAnchorMs — see below) and, well before that
// horizon is reached, deliberately regenerate the subscription's persisted state with a
// LATER recurrenceHorizonMs.
//
// THIS IS UNAMBIGUOUSLY A MATERIAL CONTENT CHANGE, NOT A NO-OP: extending
// recurrenceHorizonMs changes the emitted RRULE's UNTIL and the VTIMEZONE's represented
// transitions — genuinely different bytes on the wire. A caller that advances
// recurrenceHorizonMs WITHOUT also incrementing `revision` (this file's SEQUENCE basis —
// see its own field comment below, which this repair pass broadens beyond "Stage 2's
// preference revision") and updating `updatedAtMs` would produce two DIFFERENT ICS
// representations of the SAME nominal SEQUENCE/DTSTAMP/LAST-MODIFIED — an incoherent Stage 4
// contract Codex explicitly rejected. This file CANNOT detect or prevent that misuse itself
// (a pure function has no memory of what it returned last time, and this repair pass
// deliberately does NOT add any persistence, caching, or prior-state comparison to fix
// that — Codex's instruction is explicit that Stage 3 must remain pure). The obligation is
// therefore stated here, unambiguously, as a contract Stage 4 MUST honor: ANY material
// representation change this file's output can differ on — a Stage 2 preference edit, a
// timezone change, OR a horizon-only renewal with no preference change at all — MUST be
// accompanied by an incremented `revision` and a refreshed `updatedAtMs` supplied by the
// caller. eventUid is the one input that must NEVER change for an existing subscription
// (see STABLE EVENT IDENTITY above) — it is what lets a calendar client recognize a horizon
// renewal, a timezone edit, and a schedule edit as all being updates to the SAME series
// rather than three unrelated events.
//
// Because calendar subscriptions are periodically re-polled by design (Apple/Google/Outlook
// clients typically refresh a subscribed .ics URL on the order of hours to about a day), a
// multi-year horizon gives Stage 4 an ample, low-frequency renewal cadence with no risk of
// a client ever observing a genuinely expired series in normal operation.
const MIN_RECURRENCE_HORIZON_GAP_MS = DAY_MS;
// Codex repair pass 2, issue 6: renamed from a "YEARS" constant to be explicit that this is
// a FIXED-DAY approximation (3660 days), not calendar-year-aware arithmetic — the previous
// name implied a precision this constant never actually had.
const MAX_RECURRENCE_HORIZON_SPAN_DAYS = 3660; // ~10 years
const MAX_RECURRENCE_HORIZON_SPAN_MS = MAX_RECURRENCE_HORIZON_SPAN_DAYS * DAY_MS;

// ---------------------------------------------------------------------------------------
// INPUT VALIDATION — strict, fail-closed, mirrors Stage 2's own philosophy: every field is
// independently checked; a violation throws IcsGenerationError; nothing is silently
// defaulted, coerced, sorted, or repaired.
// ---------------------------------------------------------------------------------------
type ValidatedCalendarFeedInput = {
  eventUid: string;
  weekdays: number[];
  localTime: string;
  timezone: string;
  sessionDurationMinutes: number;
  revision: number;
  updatedAtMs: number;
  seriesAnchorMs: number;
  recurrenceHorizonMs: number;
};

function requireEventUid(value: unknown): string {
  if (typeof value !== 'string' || !EVENT_UID_PATTERN.test(value)) {
    throw new IcsGenerationError('eventUid must be a non-empty string of only letters, digits, ".", "_", or "-", at most 100 characters.');
  }
  return value;
}

function requireCanonicalWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new IcsGenerationError('weekdays must be a non-empty array.');
  }
  const validSet = new Set(VALID_WEEKDAYS);
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || !validSet.has(entry)) {
      throw new IcsGenerationError('weekdays must contain only integers 0-6.');
    }
  }
  for (let i = 1; i < value.length; i++) {
    if (value[i] <= value[i - 1]) {
      throw new IcsGenerationError('weekdays must already be canonical: strictly ascending with no duplicates.');
    }
  }
  return value as number[];
}

function requireLocalTime(value: unknown): string {
  if (typeof value !== 'string' || !TIME_PATTERN.test(value)) {
    throw new IcsGenerationError('localTime must be in strict 24-hour HH:MM format.');
  }
  return value;
}

function requireCanonicalTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 100) {
    throw new IcsGenerationError('timezone must be a non-empty IANA timezone string.');
  }
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new IcsGenerationError('timezone is not a recognized IANA timezone.');
  }
  if (value !== canonical) {
    throw new IcsGenerationError('timezone must already be canonical (e.g. "America/Chicago", not an alias like "US/Central").');
  }
  return value;
}

function requireSessionDurationMinutes(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < MIN_SESSION_DURATION_MINUTES ||
    value > MAX_SESSION_DURATION_MINUTES
  ) {
    throw new IcsGenerationError(
      `sessionDurationMinutes must be an integer between ${MIN_SESSION_DURATION_MINUTES} and ${MAX_SESSION_DURATION_MINUTES}.`
    );
  }
  return value;
}

function requireRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new IcsGenerationError('revision must be a safe integer >= 1.');
  }
  return value;
}

// Codex repair pass 1, issue 4: bounded to MIN_SUPPORTED_EPOCH_MS/MAX_SUPPORTED_EPOCH_MS
// (see SUPPORTED DOMAIN above), NOT merely "any safe integer" — the previous version
// accepted values like Number.MAX_SAFE_INTEGER, which is WAY beyond JS Date's own
// representable range and produces an Invalid Date; feeding that into
// Intl.DateTimeFormat.formatToParts throws a raw, unhelpful RangeError deep inside this
// file's internals rather than failing closed at the input boundary with a clear message.
// Empirically confirmed before writing this: `new Date(Number.MAX_SAFE_INTEGER)` is already
// `Invalid Date`, and `Intl.DateTimeFormat(...).formatToParts(new Date(NaN))` throws
// `RangeError: Invalid time value`.
function requireBoundedEpochMs(value: unknown, label: string): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isSafeInteger(value) ||
    value < MIN_SUPPORTED_EPOCH_MS ||
    value > MAX_SUPPORTED_EPOCH_MS
  ) {
    throw new IcsGenerationError(
      `${label} must be an integer number of epoch milliseconds within the supported domain [${MIN_SUPPORTED_EPOCH_MS}, ${MAX_SUPPORTED_EPOCH_MS}] (2020-01-01 through 2100-12-31 UTC).`
    );
  }
  return value;
}

// Codex repair pass 1, issue 2/3: recurrenceHorizonMs must be strictly, meaningfully after
// seriesAnchorMs (at least a day, so the represented window is never degenerate), and bounded
// to a reasonable span so a single generation's transition scan stays fast and the
// "supported domain" claim (see SUPPORTED DOMAIN above) stays honest — an unbounded span
// would let a caller silently request a scan far outside the modern-tzdata assumptions this
// algorithm relies on.
function requireRecurrenceHorizonMs(recurrenceHorizonMs: number, seriesAnchorMs: number): number {
  const gap = recurrenceHorizonMs - seriesAnchorMs;
  if (gap < MIN_RECURRENCE_HORIZON_GAP_MS) {
    throw new IcsGenerationError('recurrenceHorizonMs must be strictly after seriesAnchorMs (at least one day later).');
  }
  if (gap > MAX_RECURRENCE_HORIZON_SPAN_MS) {
    throw new IcsGenerationError(
      `recurrenceHorizonMs must be within ${MAX_RECURRENCE_HORIZON_SPAN_DAYS} days of seriesAnchorMs.`
    );
  }
  return recurrenceHorizonMs;
}

function validateCalendarFeedInput(input: CalendarFeedInput): ValidatedCalendarFeedInput {
  const seriesAnchorMs = requireBoundedEpochMs(input.seriesAnchorMs, 'seriesAnchorMs');
  const recurrenceHorizonMsRaw = requireBoundedEpochMs(input.recurrenceHorizonMs, 'recurrenceHorizonMs');
  return {
    eventUid: requireEventUid(input.eventUid),
    weekdays: requireCanonicalWeekdays(input.weekdays),
    localTime: requireLocalTime(input.localTime),
    timezone: requireCanonicalTimezone(input.timezone),
    sessionDurationMinutes: requireSessionDurationMinutes(input.sessionDurationMinutes),
    revision: requireRevision(input.revision),
    updatedAtMs: requireBoundedEpochMs(input.updatedAtMs, 'updatedAtMs'),
    seriesAnchorMs,
    recurrenceHorizonMs: requireRecurrenceHorizonMs(recurrenceHorizonMsRaw, seriesAnchorMs),
  };
}

// Codex repair pass 1, issue 4: defense-in-depth guard used inside every date-formatting
// function below, immediately before emitting a literal. Given the input bounds enforced by
// requireBoundedEpochMs/requireRecurrenceHorizonMs above, every year this file ever formats
// should already fall well within a 4-digit range — this exists so that a future change to
// those bounds (or a bug in the arithmetic deriving a formatted date from them) fails loudly
// and closed, rather than silently emitting a non-4-digit or negative year that would corrupt
// the RFC 5545 DATE-TIME representation.
function requireRfcRepresentableYear(year: number): number {
  if (!Number.isInteger(year) || year < 1000 || year > 9999) {
    throw new IcsGenerationError(`Computed year ${year} cannot be represented by this generator's 4-digit RFC 5545 DATE-TIME serialization.`);
  }
  return year;
}

// SEQUENCE CONTRACT: Stage 2's revision IS the SEQUENCE, with no second mutable counter —
// see MAX_ICS_SEQUENCE above for the fail-closed upper-bound rationale.
function requireIcsSequence(revision: number): number {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision > MAX_ICS_SEQUENCE) {
    throw new IcsGenerationError(
      `revision ${revision} cannot be represented as an iCalendar SEQUENCE (must be an integer in [0, ${MAX_ICS_SEQUENCE}]).`
    );
  }
  return revision;
}

// ---------------------------------------------------------------------------------------
// TEXT ESCAPING (RFC 5545 section 3.3.11) — order matters: the backslash replacement MUST
// run first, otherwise the backslashes it inserts would themselves be re-escaped by the
// later replacements.
// ---------------------------------------------------------------------------------------
function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

// ---------------------------------------------------------------------------------------
// RFC 5545 CONTENT-LINE FOLDING — strict: CRLF line endings, folding at a maximum of 75
// OCTETS (UTF-8 bytes, not JS UTF-16 characters), continuation lines begin with exactly one
// SPACE, and a multi-byte UTF-8 codepoint is never split across a fold boundary.
// ---------------------------------------------------------------------------------------
function foldContentLine(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) {
    return line + '\r\n';
  }
  const segments: string[] = [];
  let offset = 0;
  let isFirst = true;
  while (offset < bytes.length) {
    // The first physical line gets the full 75-octet budget; every continuation line
    // reserves 1 octet for its own leading space, leaving 74 octets for content.
    const budget = isFirst ? 75 : 74;
    let cut = Math.min(offset + budget, bytes.length);
    // Never split a multi-byte UTF-8 sequence: back off while the byte AT `cut` is a
    // continuation byte (0b10xxxxxx), which would mean the sequence starting before `cut`
    // is being split. A single UTF-8 codepoint is at most 4 bytes wide and every budget
    // here is >= 74, so this loop can never back off past `offset` itself.
    while (cut > offset && (bytes[cut] & 0xc0) === 0x80) {
      cut--;
    }
    if (cut === offset) {
      // Mathematically unreachable given the budgets above (see comment) — fail loudly
      // rather than risk an infinite loop if that invariant is ever violated.
      throw new IcsGenerationError('Content-line folding could not make progress (unreachable).');
    }
    segments.push(bytes.subarray(offset, cut).toString('utf8'));
    offset = cut;
    isFirst = false;
  }
  return segments.map((segment, i) => (i === 0 ? segment : ' ' + segment)).join('\r\n') + '\r\n';
}

function buildProperty(name: string, value: string, params: Record<string, string> = {}): string {
  const paramText = Object.entries(params)
    .map(([k, v]) => `;${k}=${v}`)
    .join('');
  return foldContentLine(`${name}${paramText}:${value}`);
}

// ---------------------------------------------------------------------------------------
// DTSTAMP / LAST-MODIFIED — both formatted as UTC DATE-TIME (RFC 5545 3.3.5), always ending
// in 'Z'. Both are derived from `updatedAtMs` (never Date.now()), and are therefore
// identical for any two generations against the same persisted revision — see this file's
// header for why DTSTAMP and LAST-MODIFIED are deliberately the same value here: this
// generator has no separate "when was THIS representation produced" timestamp distinct from
// "when was the underlying preference data last revised", and RFC 5545 does not forbid the
// two properties from coinciding.
// ---------------------------------------------------------------------------------------
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function formatIcsUtcDateTime(ms: number): string {
  const d = new Date(ms);
  const year = requireRfcRepresentableYear(d.getUTCFullYear());
  return `${year}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}Z`;
}

// ---------------------------------------------------------------------------------------
// STABLE SERIES ANCHOR / RECURRENCE HORIZON — DTSTART for a TZID-relative recurring event is
// a LOCAL WALL-CLOCK literal (no UTC conversion, no 'Z' suffix): calendar clients resolve
// every RRULE-expanded occurrence's actual instant using the VTIMEZONE block, which is
// exactly what makes the series correctly preserve local wall-clock time across DST
// transitions (a fixed-UTC-instant DTSTART would NOT do this). Determining DTSTART therefore
// only requires finding the correct CALENDAR DATE (year/month/day) for the first occurrence —
// never a UTC instant resolution — which is why this file needs none of
// notificationPreferences.ts's DST-transition-resolution math for this step (that math is
// only needed for VTIMEZONE generation, below).
//
// CODEX REPAIR PASS 1, ISSUE 2 — THE BUG THIS SECTION FIXES: the previous design used a
// single `anchorDateMs`, documented as the caller-supplied "reference now", to compute BOTH
// the series' first occurrence AND the VTIMEZONE scan window. This was WRONG: if a future
// feed endpoint naturally passed "the current time of this HTTP request" (the obvious,
// tempting thing to do), then re-fetching the IDENTICAL persisted Stage 2 state on a LATER
// calendar day would silently compute a DIFFERENT first occurrence — meaning the master
// recurring event's own DTSTART would drift forward with every fetch, for no reason related
// to any genuine schedule edit. That breaks the series' identity (a calendar client uses
// UID+DTSTART+RRULE together to represent "the one recurring thing"; a DTSTART that silently
// moves is indistinguishable from data corruption) and breaks this file's own core
// determinism claim ("same semantic inputs produce byte-for-byte identical output") unless
// "semantic inputs" is read to absurdly include incidental fetch timing.
//
// THE FIX: DTSTART now depends ONLY on `seriesAnchorMs` — an IMMUTABLE, PERSISTED-PER-
// SUBSCRIPTION value the caller must choose ONCE (e.g. the subscription's own creation
// time) and supply UNCHANGED for that subscription's entire lifetime. This file converts it
// to a calendar date AS OBSERVED IN THE TARGET TIMEZONE (the same instant can be a different
// calendar date in different zones), then walks forward at most 7 days to find the first
// date whose weekday is in the CURRENTLY selected set. Because `seriesAnchorMs` never
// changes, an unchanged schedule (weekdays/localTime/timezone) always resolves to the exact
// same first occurrence, on any later fetch, forever — refresh stability by construction,
// not by convention. A GENUINE schedule edit (a real Stage 2 weekdays/localTime/timezone
// change) is still free to change the computed first occurrence, exactly as it should: the
// series' UID stays the same (see STABLE EVENT IDENTITY above) while DTSTART/RRULE update to
// reflect the new schedule and SEQUENCE increments to signal the change.
//
// `recurrenceHorizonMs` is a SEPARATE, independent input that plays no role in computing
// DTSTART at all — it only bounds how far forward the VTIMEZONE/RRULE currently extend (see
// RECURRENCE LIFETIME above). Advancing it over time (a deliberate Stage 4 renewal action)
// never disturbs the series' identity or its first occurrence.
//
// CODEX REPAIR PASS 2, ISSUE 5 (semantics clarification, no functional change here — see the
// full statement on CalendarFeedInput's own seriesAnchorMs field comment): only the anchor's
// CALENDAR DATE matters, never its time-of-day. The resolved DTSTART can therefore be
// EARLIER in wall-clock terms than the anchor itself on the same calendar date (e.g. an
// anchor of Monday 10:00 with a Monday schedule configured for 09:00 resolves to that same
// Monday's 09:00) — this is intentional, not a bug. See DTSTART <= UNTIL ENFORCEMENT below
// (Codex repair pass 2, issue 3) for the separate, independent guarantee that the resolved
// DTSTART's ACTUAL instant never lands after recurrenceHorizonMs.
// ---------------------------------------------------------------------------------------
function getZonedYmd(ms: number, timeZone: string): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts: Record<string, number> = {};
  for (const part of dtf.formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
  }
  return { year: parts.year, month: parts.month, day: parts.day };
}

function computeFirstOccurrenceLocalDate(
  seriesAnchorMs: number,
  timeZone: string,
  weekdays: number[]
): { year: number; month: number; day: number } {
  const anchor = getZonedYmd(seriesAnchorMs, timeZone);
  const weekdaySet = new Set(weekdays);
  for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
    // Calendar-date-only arithmetic in a UTC-as-date-only space — only the correct Y-M-D and
    // its day-of-week are needed here (matching the equivalent, already-reviewed technique in
    // notificationPreferences.ts's computeNextOccurrenceMs, duplicated in spirit but not in
    // code per the DECOUPLING GUARANTEE).
    const candidate = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day + dayOffset));
    if (weekdaySet.has(candidate.getUTCDay())) {
      return { year: candidate.getUTCFullYear(), month: candidate.getUTCMonth() + 1, day: candidate.getUTCDate() };
    }
  }
  // Unreachable: weekdays is validated non-empty with values in 0-6, so some day within the
  // next 7 must match.
  throw new IcsGenerationError('Could not determine a first occurrence within 7 days of the series anchor (unreachable).');
}

function formatIcsLocalDateTime(date: { year: number; month: number; day: number }, localTime: string): string {
  const [hh, mm] = localTime.split(':');
  const year = requireRfcRepresentableYear(date.year);
  return `${year}${pad2(date.month)}${pad2(date.day)}T${hh}${mm}00`;
}

// ---------------------------------------------------------------------------------------
// VTIMEZONE IMPLEMENTATION — the highest-risk part of Stage 3 (per Codex's own framing).
//
// DEPENDENCY DECISION: no new dependency was added. This uses Node's built-in
// Intl.DateTimeFormat, which carries the ICU-bundled IANA tzdata already shipped with the
// Node runtime this project targets — the SAME mechanism this project's already-reviewed
// notificationPreferences.ts DST math relies on (see that file's own header). No network
// access, no new npm package, nothing added to package.json/package-lock.json.
//
// STRATEGY: rather than attempting to encode a zone's abstract POSIX-style DST RULE (which
// risks being subtly wrong for zones with irregular or historically-changing rules, and which
// Intl does not expose in a directly usable rule form anyway), this generates a VTIMEZONE
// using EXPLICIT RDATE-listed transition instants, empirically DETECTED by sampling
// Intl.DateTimeFormat's own offset resolution across the bounded window
// [seriesAnchorMs, recurrenceHorizonMs] (see RECURRENCE LIFETIME above for why this window's
// END is the SAME value the VEVENT RRULE's own UNTIL uses, and SUPPORTED DOMAIN above for the
// validated date/timezone domain this strategy is scoped to). This is fully general within
// that domain (works identically for simple two-offset DST zones, complex zones, and
// fixed-offset zones), deterministic for given seriesAnchorMs/recurrenceHorizonMs values, and
// authoritative for whatever tzdata version is bundled with the actual running Node process —
// but it is NOT a comprehensive-for-all-time VTIMEZONE: transitions outside the bounded
// window are not represented, which is internally coherent because the RRULE itself does not
// claim to recur past that same boundary either (see RECURRENCE LIFETIME above).
//
// BASELINE OBSERVANCE ARCHITECTURE (Codex repair pass 2, issue 2): scanning only from
// seriesAnchorMs forward means the scan can never, by construction, discover the transition
// that established whatever offset happens to already be in effect AT seriesAnchorMs — a
// zone can perfectly well have last transitioned years before seriesAnchorMs (ordinary DST
// zones do this every single year) or never transition again within the whole scanned
// window (Asia/Almaty's 2024 permanent -0100 redefinition, independently reproduced by
// Codex with a 2023 series anchor: the scan correctly finds the 2024 transition, but with
// NO observance covering the 2023 VEVENT DTSTART itself, since nothing in a
// transitions-only VTIMEZONE describes "what was active before the first detected
// transition"). A calendar client has no defined behavior for an instant with no governing
// observance at all.
//
// FIX: buildVTimezoneComponents below ALWAYS emits one BASELINE observance FIRST, generated
// directly from the offset actually observed at a single exact instant (a single, exact
// Intl.DateTimeFormat query — no searching, no guessing), with TZOFFSETFROM equal to
// TZOFFSETTO (it does not itself model a transition — it models "whatever was already true").
// Every DETECTED transition through recurrenceHorizonMs is then emitted as usual, layered on
// top. RFC 5545 VTIMEZONE resolution picks, for any instant, whichever observance's own onset
// is the most recent one at-or-before that instant — so this baseline only ever governs
// instants strictly BEFORE the first real detected transition (if any); every occurrence
// after a genuine transition is correctly governed by that transition's own observance,
// exactly as before. This removed the need for the old fixed one-year lookback (which existed
// only to discover a transition to anchor "current" offset to, which the baseline now
// establishes directly and exactly) — CODEX REPAIR PASS 3 REFINEMENT: that "single exact
// instant" is NOT simply seriesAnchorMs (an underlying assumption this pass's own review
// found incomplete — see VTIMEZONE COVERAGE-START ARCHITECTURE below, near
// buildVTimezoneComponents, for the full corrected story, including why the baseline's DTSTART
// is no longer a far-past sentinel either).
//
// RE-VERIFIED across every case Codex asked for: FIXED zones (America/Phoenix, UTC) — zero
// detected transitions, output is just the baseline, unchanged from before this repair.
// ORDINARY DST zones (America/Chicago) — baseline plus the usual DAYLIGHT/STANDARD pair;
// harmlessly redundant with the detected STANDARD component when they share the same
// numeric offset, but never incorrect (the more-recent onset always wins per RFC
// resolution). PERMANENT BASE-OFFSET CHANGES (Asia/Almaty) — baseline correctly covers the
// pre-2024 VEVENT DTSTART with the OLD (+0600) offset; the detected 2024 transition takes
// over from March 2024 onward. LONG STABLE PERIODS before the first transition in the
// window — exactly the general case the baseline exists to cover, by construction.
//
// TRANSITION DETECTION: samples the zone's UTC offset once per day across the window. Two
// samples 24 hours apart bracket any transition — this is sufficient PRECISELY BECAUSE of the
// SUPPORTED DOMAIN restriction above (2020-2100): no IANA zone has two distinct transitions
// within a single day anywhere in that modern range (the historical phenomenon of multiple
// same-day transitions, e.g. wartime double-summer-time, is confined to eras well outside
// this domain) — this is a validated domain boundary, not an unrestricted claim. When a
// day-to-day offset change is found, the EXACT transition instant is located via binary
// search — CRITICALLY, bisecting over WHOLE SECONDS ONLY, never sub-second milliseconds.
// This was NOT an assumption: an earlier version of this algorithm bisected at millisecond
// granularity and empirically produced WRONG transition instants (e.g. computing
// 2026-03-08T07:52:30Z for a real America/Chicago transition verified by direct sampling to
// be exactly 2026-03-08T08:00:00Z) — the root cause is that Intl.DateTimeFormat's
// formatToParts has no sub-second field, so offsetMsAt's result has spurious millisecond-level
// SAWTOOTH noise from second-truncation at any non-second-aligned instant, which a
// millisecond-precision bisection was confusing for genuine transitions. Restricting the
// bisection to whole-second instants (where offsetMsAt is exact and stable) eliminates this
// entirely, and the result was reverified against five independently-known real transitions
// (America/Chicago spring/fall 2026, Europe/London spring 2026, Australia/Sydney spring 2025,
// Australia/Lord_Howe's unusual 30-minute transition, and Pacific/Chatham's unusual
// quarter-hour base offset) before being relied upon here.
//
// STANDARD vs DAYLIGHT CLASSIFICATION: a transition is classified DAYLIGHT if the new offset
// is algebraically GREATER than the offset it replaces, STANDARD otherwise. This is CORRECT
// FOR THE OVERWHELMING, DOMINANT CASE within the supported domain — annual DST cycling in
// both hemispheres ("daylight saving" always means shifting the local clock FORWARD relative
// to that zone's own standard time, empirically reverified for both a Northern Hemisphere
// zone, America/Chicago, and a Southern Hemisphere zone, Australia/Sydney: +660 min DST vs
// +600 min standard, same direction). ACKNOWLEDGED, DOCUMENTED RESIDUAL LIMITATION (Codex
// repair pass 1, issue 5): this heuristic does not attempt to distinguish ordinary DST
// cycling from a hypothetical PERMANENT one-time base-offset redefinition (e.g. a country
// abolishing DST outright) that happens to fall inside the requested window — such an event
// would still be classified via the same increase/decrease rule, and the resulting
// TZOFFSETFROM/TZOFFSETTO/transition-instant values would still be numerically CORRECT
// (which is what calendar-client interoperability actually depends on), but the cosmetic
// STANDARD/DAYLIGHT keyword for that one transition could be semantically imprecise. This is
// an accepted, explicitly documented tradeoff, not a silent assumption.
//
// COMPONENT GROUPING: transitions are grouped into VTIMEZONE STANDARD/DAYLIGHT
// sub-components by their EXACT (offsetBefore, offsetAfter) signature, not merely by
// STANDARD/DAYLIGHT label — this generalizes correctly even for a hypothetical zone that
// changes its base offset entirely during the window (which would produce more than the
// usual two components, each still correctly typed via the per-transition classification
// above), not just the common two-component DST case.
//
// A ZONE WITH ZERO DETECTED TRANSITIONS inside the window is fixed-offset for the purposes
// of this bounded representation — see BASELINE OBSERVANCE ARCHITECTURE above: in this case
// the baseline observance is the ONLY component, which is exactly the correct output (see
// SUPPORTED DOMAIN above for why this is an honest claim rather than an overreaching one,
// given RRULE/VTIMEZONE lifetime alignment).
// ---------------------------------------------------------------------------------------

// PERFORMANCE NOTE (does not affect determinism/purity): constructing an
// Intl.DateTimeFormat is measurably expensive relative to using one, and the VTIMEZONE
// transition search below calls offsetMsAt on the order of a few thousand times per
// generateCalendarIcs call (roughly a daily sample across a ~6-year window, plus a handful
// of per-transition binary-search refinements). These two small memoization caches, keyed
// purely by the `timeZone` string argument, avoid reconstructing an equivalent formatter on
// every call. This is ordinary memoization, not observable state: for a given `timeZone`
// the cached formatter always behaves identically to a freshly-constructed one, so it has
// no effect on this file's determinism guarantee (same semantic inputs still produce
// byte-for-byte identical output) or on any test that does not itself inspect the cache.
const offsetFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getOffsetFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = offsetFormatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    offsetFormatterCache.set(timeZone, dtf);
  }
  return dtf;
}

const shortNameFormatterCache = new Map<string, Intl.DateTimeFormat>();
function getShortNameFormatter(timeZone: string): Intl.DateTimeFormat {
  let dtf = shortNameFormatterCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short', hour: '2-digit' });
    shortNameFormatterCache.set(timeZone, dtf);
  }
  return dtf;
}

// Codex repair pass 2 (found while adding an exact-boundary test at the corrected
// MAX_SUPPORTED_EPOCH_MS, which now deliberately ends in .999ms): Intl.DateTimeFormat's
// formatToParts has no sub-second field, so it necessarily reports the FLOORED second of
// whatever instant it's given. The previous version computed `impliedMs - ms` using the
// RAW, possibly-sub-second-bearing `ms` directly — for a non-second-aligned input (e.g.
// ...T23:59:59.999Z), this leaked up to 999ms of truncation error into the returned offset,
// producing a non-whole-minute result that then failed formatTzOffset's own validation. This
// is the SAME root cause as the earlier documented bisection bug (see VTIMEZONE
// IMPLEMENTATION's TRANSITION DETECTION comment) — resolved here at the SOURCE, once, by
// flooring to the second before ever querying Intl, so every caller (not just the ones that
// happen to pass whole-second values) gets a truncation-free result. "The offset at ms" is
// only ever well-defined to whole-second precision anyway, given Intl's own limits, so this
// is not a loss of precision, only the removal of spurious sub-second noise.
function offsetMsAt(ms: number, timeZone: string): number {
  const flooredMs = Math.floor(ms / 1000) * 1000;
  const parts: Record<string, number> = {};
  for (const part of getOffsetFormatter(timeZone).formatToParts(new Date(flooredMs))) {
    if (part.type !== 'literal') parts[part.type] = parseInt(part.value, 10);
  }
  if (parts.hour === 24) parts.hour = 0; // some ICU builds render midnight as "24" under hour12:false
  const impliedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return impliedMs - flooredMs;
}

function tzShortNameAt(ms: number, timeZone: string): string {
  const parts = getShortNameFormatter(timeZone).formatToParts(new Date(ms));
  const found = parts.find((p) => p.type === 'timeZoneName');
  return found ? found.value : timeZone;
}

// ---------------------------------------------------------------------------------------
// DTSTART <= UNTIL ENFORCEMENT (Codex repair pass 2, issue 3) — resolving a LOCAL wall-clock
// literal to its genuine absolute UTC instant, needed ONLY to validate that the computed
// VEVENT DTSTART does not fall after recurrenceHorizonMs (the ICS TEXT itself still emits
// DTSTART as a local literal, per STABLE SERIES ANCHOR / RECURRENCE HORIZON above — this
// resolution is purely an internal validation step, never serialized).
//
// This is a DELIBERATE, DOCUMENTED DUPLICATION (not an import) of the already-reviewed
// self-consistency-checked bracketing algorithm in notificationPreferences.ts's
// localWallTimeToUtcMs (see that file's own header for the fuller history of the two
// rejected simpler approaches it replaced) — the DECOUPLING GUARANTEE at the top of this
// file forbids importing that file directly, so the same correctness-critical logic is
// reproduced here rather than referenced. Samples the zone's offset at two points
// bracketing the target local time; if they agree, the instant is unambiguous; if they
// differ (a nearby DST transition), it checks each candidate instant for
// SELF-CONSISTENCY (does the offset actually in effect at that candidate match the offset
// used to derive it) to correctly resolve an ordinary pre/post-transition time, a FOLD
// (ambiguous local time — earlier occurrence chosen), or a GAP (nonexistent local time —
// algebraically equivalent to the before-candidate, per the same derivation
// notificationPreferences.ts documents).
//
// SUPPORTED DOMAIN NOTE (Codex repair pass 2, issue 6): the two bracket probes below query
// offsetMsAt at `target ± DST_BRACKET_WINDOW_MS` (36 hours). When seriesAnchorMs sits at or
// very near MIN_SUPPORTED_EPOCH_MS, the "before" probe can reach up to 36 hours EARLIER than
// the documented domain floor. This is a deliberate, bounded, and harmless exception, not a
// silent one: Intl.DateTimeFormat/Date have no special behavior or reduced correctness at
// the 2020 boundary (that floor exists for the SAMPLING-SUFFICIENCY and DST-rule-stability
// arguments in SUPPORTED DOMAIN above, not because dates before it are computationally
// unreliable) — a 36-hour probe purely for transition disambiguation near an already-valid
// input is not itself a claim of correctness for some arbitrary earlier caller-visible date.
// ---------------------------------------------------------------------------------------
const DST_BRACKET_WINDOW_MS = 36 * 60 * 60 * 1000;

function localWallTimeToUtcMs(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offsetBefore = offsetMsAt(target - DST_BRACKET_WINDOW_MS, timeZone);
  const offsetAfter = offsetMsAt(target + DST_BRACKET_WINDOW_MS, timeZone);

  if (offsetBefore === offsetAfter) {
    return target - offsetBefore;
  }

  const candidateUsingBefore = target - offsetBefore;
  const candidateUsingAfter = target - offsetAfter;
  const beforeConsistent = offsetMsAt(candidateUsingBefore, timeZone) === offsetBefore;
  const afterConsistent = offsetMsAt(candidateUsingAfter, timeZone) === offsetAfter;

  if (beforeConsistent && afterConsistent) {
    // FOLD: both instants are genuinely valid for this local time — choose the earlier.
    return Math.min(candidateUsingBefore, candidateUsingAfter);
  }
  if (beforeConsistent) return candidateUsingBefore; // ordinary, pre-transition
  if (afterConsistent) return candidateUsingAfter; // ordinary, post-transition

  // GAP: neither is self-consistent -> nonexistent local time. Algebraically equivalent to
  // candidateUsingBefore (see notificationPreferences.ts's own derivation of this identity).
  return candidateUsingBefore;
}

// Bisects over WHOLE SECONDS ONLY — see the VTIMEZONE IMPLEMENTATION comment above for why.
function findExactTransitionMs(loMs: number, hiMs: number, timeZone: string, offsetAtLo: number): number {
  let loSec = Math.floor(loMs / 1000);
  let hiSec = Math.floor(hiMs / 1000);
  while (hiSec - loSec > 1) {
    const midSec = loSec + Math.floor((hiSec - loSec) / 2);
    if (offsetMsAt(midSec * 1000, timeZone) === offsetAtLo) {
      loSec = midSec;
    } else {
      hiSec = midSec;
    }
  }
  return hiSec * 1000;
}

type TzTransition = { instantMs: number; offsetBeforeMs: number; offsetAfterMs: number; tznameAfter: string };

// Codex repair pass 2, issue 1: THE TRAILING-PARTIAL-INTERVAL BUG. windowEndMs is an
// arbitrary caller-supplied instant (recurrenceHorizonMs) — it is almost never an exact
// multiple of DAY_MS away from windowStartMs. The daily-step loop below only ever samples AT
// windowStartMs + k*DAY_MS for integer k, so it can terminate (cursor > windowEndMs) leaving
// up to just-under-24-hours of unsampled interval immediately before windowEndMs — exactly
// where a real transition can hide. Independently reproduced by Codex: America/Chicago with
// recurrenceHorizonMs = 2026-03-08T10:00:00Z omitted the 2026-03-08T08:00:00Z transition
// entirely, because the last daily-aligned sample before it fell on 2026-03-07 and the next
// one would have fallen after windowEndMs. FIXED by an explicit trailing check: after the
// loop, if the last sampled instant is still strictly before windowEndMs, sample windowEndMs
// itself and — if its offset differs from the last known offset — bisect within
// [prevSampleMs, windowEndMs] for the exact transition, exactly like every other detected
// transition. If windowEndMs exactly coincides with the loop's last cursor, prevSampleMs
// already equals windowEndMs and this trailing check is a no-op (no duplicate is possible).
function findTransitionsInWindow(windowStartMs: number, windowEndMs: number, timeZone: string): TzTransition[] {
  const transitions: TzTransition[] = [];
  let prevSampleMs = windowStartMs;
  let prevOffset = offsetMsAt(prevSampleMs, timeZone);
  let cursor = windowStartMs + DAY_MS;
  while (cursor <= windowEndMs) {
    const offset = offsetMsAt(cursor, timeZone);
    if (offset !== prevOffset) {
      const transitionMs = findExactTransitionMs(prevSampleMs, cursor, timeZone, prevOffset);
      transitions.push({
        instantMs: transitionMs,
        offsetBeforeMs: prevOffset,
        offsetAfterMs: offset,
        // Sampled 1 second after the transition instant -- safely inside the new period,
        // never at the boundary itself.
        tznameAfter: tzShortNameAt(transitionMs + 1000, timeZone),
      });
      prevOffset = offset;
    }
    prevSampleMs = cursor;
    cursor += DAY_MS;
  }
  if (prevSampleMs < windowEndMs) {
    const offset = offsetMsAt(windowEndMs, timeZone);
    if (offset !== prevOffset) {
      const transitionMs = findExactTransitionMs(prevSampleMs, windowEndMs, timeZone, prevOffset);
      transitions.push({
        instantMs: transitionMs,
        offsetBeforeMs: prevOffset,
        offsetAfterMs: offset,
        tznameAfter: tzShortNameAt(transitionMs + 1000, timeZone),
      });
    }
  }
  return transitions;
}

type VTimezoneComponent = {
  type: 'STANDARD' | 'DAYLIGHT';
  tzOffsetFromMs: number;
  tzOffsetToMs: number;
  tzname: string;
  instantsMs: number[]; // chronological; instantsMs[0] becomes this component's DTSTART, the rest become RDATE entries.
};

function groupTransitionsIntoComponents(transitions: TzTransition[]): VTimezoneComponent[] {
  const groups = new Map<string, VTimezoneComponent>();
  for (const t of transitions) {
    const key = `${t.offsetBeforeMs}:${t.offsetAfterMs}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        type: t.offsetAfterMs > t.offsetBeforeMs ? 'DAYLIGHT' : 'STANDARD',
        tzOffsetFromMs: t.offsetBeforeMs,
        tzOffsetToMs: t.offsetAfterMs,
        tzname: t.tznameAfter,
        instantsMs: [],
      };
      groups.set(key, group);
    }
    group.instantsMs.push(t.instantMs);
  }
  // Deterministic order: chronological by each component's own first transition.
  return [...groups.values()].sort((a, b) => a.instantsMs[0] - b.instantsMs[0]);
}

function requireWholeMinuteOffset(offsetMs: number): number {
  if (offsetMs % 60000 !== 0) {
    throw new IcsGenerationError('Timezone offset is not aligned to a whole minute; not supported.');
  }
  return offsetMs;
}

function formatTzOffset(offsetMs: number): string {
  requireWholeMinuteOffset(offsetMs);
  const totalMinutes = offsetMs / 60000;
  const sign = totalMinutes < 0 ? '-' : '+';
  const abs = Math.abs(totalMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}${pad2(abs % 60)}`;
}

// Local wall-clock literal as observed AT the given fixed offset (used for a VTIMEZONE
// sub-component's own DTSTART/RDATE values, which are local-to-that-offset by definition,
// unlike the VEVENT's own DTSTART which is local-to-the-zone-as-a-whole).
function formatLocalLiteralAtOffset(instantMs: number, offsetMs: number): string {
  const d = new Date(instantMs + offsetMs);
  const year = requireRfcRepresentableYear(d.getUTCFullYear());
  return `${year}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}${pad2(d.getUTCSeconds())}`;
}

// Codex repair pass 3 — VTIMEZONE COVERAGE-START ARCHITECTURE. Root cause this fixes:
// seriesAnchorMs is intentionally a CALENDAR-DATE anchor, not an instant floor (see the
// seriesAnchorMs field comment above) — so the resolved VEVENT DTSTART can legitimately be
// EARLIER, in absolute-instant terms, than seriesAnchorMs itself (same calendar date,
// earlier configured wall-clock time). Repair pass 2's baseline sampled its offset AT
// seriesAnchorMs and began transition scanning AT seriesAnchorMs — both WRONG whenever a
// transition falls between the true DTSTART instant and seriesAnchorMs: the baseline would
// carry the offset from AFTER that transition, and the scan would never discover the
// transition itself (it already happened before scanning starts). Independently reproduced
// by Codex: America/Chicago, seriesAnchorMs 2026-03-08T18:00:00Z (after that day's 08:00Z
// spring-forward), weekday Sunday, localTime 01:30 (before the transition, same local date)
// — DTSTART correctly resolves via localWallTimeToUtcMs to 2026-03-08T07:30:00Z using CST
// (-0600), but the emitted VTIMEZONE's only observance showed -0500 with no transition at
// all, an hour wrong.
//
// FIX: coverage now begins at coverageStartMs = min(seriesAnchorMs, dtstartInstantMs -
// DST_BRACKET_WINDOW_MS) — the EARLIER of seriesAnchorMs itself and a point safely (36h,
// reusing the same bracket the already-reviewed localWallTimeToUtcMs resolver uses) before
// the ACTUAL resolved first-occurrence instant. This guarantees coverageStartMs is always
// <= seriesAnchorMs (no regression versus repair pass 2's window for the common case where
// DTSTART falls at/after seriesAnchorMs), while correctly extending earlier whenever DTSTART
// resolves to something earlier than seriesAnchorMs (the bug scenario) — 36 hours is
// comfortably wider than any single real-world transition's local displacement (at most a
// few hours), so the baseline sampled at coverageStartMs is guaranteed to reflect the offset
// genuinely in effect immediately before DTSTART, and the scan (which now starts at
// coverageStartMs, not seriesAnchorMs) is guaranteed to discover any transition between
// coverageStartMs and DTSTART as a normal, correctly-serialized observance.
//
// BASELINE OBSERVANCE DTSTART RECONSIDERED: the previous PERPETUAL_OBSERVANCE_DTSTART
// ('19700101T000000') sentinel has been REMOVED. The baseline's own DTSTART is now
// coverageStartMs itself (formatted via the same formatLocalLiteralAtOffset every other
// component uses) — RFC-coherent (a STANDARD component's DTSTART may be any valid local
// literal; it need not correspond to a "real" transition, exactly as the 1970 sentinel
// itself never did) and strictly more honest: it no longer implies the offset held
// continuously since 1970 (a claim this generator has no basis for and does not need — see
// SUPPORTED DOMAIN above), stating only what is actually known: "this offset is in effect
// from coverageStartMs onward, until superseded by the next real observance." This cannot
// cause incorrect interpretation of anything in the represented VEVENT interval: by
// construction, no occurrence this file ever emits (DTSTART itself, or any RRULE-expanded
// occurrence through recurrenceHorizonMs) resolves to an instant before coverageStartMs, so
// no calendar client ever needs to resolve an instant the baseline's earlier, removed
// far-past claim would have covered but this one does not.
function computeVTimezoneCoverageStartMs(seriesAnchorMs: number, dtstartInstantMs: number): number {
  return Math.min(seriesAnchorMs, dtstartInstantMs - DST_BRACKET_WINDOW_MS);
}

function buildVTimezoneComponents(coverageStartMs: number, recurrenceHorizonMs: number, timeZone: string): VTimezoneComponent[] {
  const baselineOffset = offsetMsAt(coverageStartMs, timeZone);
  const baseline: VTimezoneComponent = {
    type: 'STANDARD',
    tzOffsetFromMs: baselineOffset,
    tzOffsetToMs: baselineOffset,
    tzname: tzShortNameAt(coverageStartMs, timeZone),
    instantsMs: [coverageStartMs],
  };

  const transitions = findTransitionsInWindow(coverageStartMs, recurrenceHorizonMs, timeZone);

  if (transitions.length === 0) {
    // Fixed-offset (non-DST) zone within the window: the baseline is the only component.
    return [baseline];
  }

  return [baseline, ...groupTransitionsIntoComponents(transitions)];
}

// Codex repair pass 1, issue 1 (THE PRIMARY SERIALIZATION BUG): a VTIMEZONE sub-component's
// own DTSTART/RDATE local literal must be interpreted relative to TZOFFSETFROM — the offset
// IN EFFECT immediately BEFORE the transition — never TZOFFSETTO. This is the same
// convention RFC 5545's own worked example uses (a DAYLIGHT component transitioning at
// "020000" local standard time, the moment daylight saving begins, not "030000" the moment
// after). The previous version of this function used tzOffsetToMs, which is WRONG. Concrete,
// verified correction for America/Chicago: the real 2026 spring-forward transition instant
// is 2026-03-08T08:00:00Z (02:00 CST -> 03:00 CDT) — using TZOFFSETFROM (-0600) yields the
// correct literal 20260308T020000; the previous, incorrect code (using TZOFFSETTO, -0500)
// produced 20260308T030000. Symmetrically, the real fall-back transition instant is
// 2026-11-01T07:00:00Z (02:00 CDT -> 01:00 CST) — using TZOFFSETFROM (-0500) yields the
// correct 20261101T020000; the previous code produced the incorrect 20261101T010000.
function buildVTimezoneText(timeZone: string, components: VTimezoneComponent[]): string {
  let out = buildProperty('BEGIN', 'VTIMEZONE');
  out += buildProperty('TZID', timeZone);
  for (const component of components) {
    out += buildProperty('BEGIN', component.type);
    // Every component (including the baseline — see VTIMEZONE COVERAGE-START ARCHITECTURE
    // above) now always has at least one instant; instantsMs[0] is its own DTSTART.
    out += buildProperty('DTSTART', formatLocalLiteralAtOffset(component.instantsMs[0], component.tzOffsetFromMs));
    out += buildProperty('TZOFFSETFROM', formatTzOffset(component.tzOffsetFromMs));
    out += buildProperty('TZOFFSETTO', formatTzOffset(component.tzOffsetToMs));
    out += buildProperty('TZNAME', escapeIcsText(component.tzname));
    if (component.instantsMs.length > 1) {
      const rdateValues = component.instantsMs
        .slice(1)
        .map((ms) => formatLocalLiteralAtOffset(ms, component.tzOffsetFromMs))
        .join(',');
      out += buildProperty('RDATE', rdateValues);
    }
    out += buildProperty('END', component.type);
  }
  out += buildProperty('END', 'VTIMEZONE');
  return out;
}

// ---------------------------------------------------------------------------------------
// RRULE / DURATION
//
// Codex repair pass 1, issue 3: RRULE now always carries an explicit UNTIL, aligned exactly
// to recurrenceHorizonMs — the SAME instant the VTIMEZONE window is bounded to (see
// RECURRENCE LIFETIME above for the full architectural reasoning). Per RFC 5545 section
// 3.3.10: "if the 'DTSTART' property is specified as a date with local time and time zone
// reference [ours always is, via TZID], then the UNTIL rule part MUST be specified as a date
// with UTC time" — hence formatIcsUtcDateTime (with its trailing 'Z'), not a local literal.
// ---------------------------------------------------------------------------------------
function buildRruleValue(weekdays: number[], untilMs: number): string {
  const until = formatIcsUtcDateTime(untilMs);
  return `FREQ=WEEKLY;BYDAY=${weekdays.map((d) => BYDAY_MAP[d]).join(',')};UNTIL=${until}`;
}

// Plain PT<minutes>M — deliberately not normalized into hours/days: RFC 5545's DURATION
// syntax does not require that, and pure-minutes is simpler and equally standards-compliant
// for this bounded [5,120]-minute range.
function buildDurationValue(minutes: number): string {
  return `PT${minutes}M`;
}

// Codex repair pass 2, issue 3: DTSTART <= UNTIL ENFORCEMENT. Resolves the computed first
// occurrence's LOCAL literal to its genuine absolute UTC instant (via localWallTimeToUtcMs
// above) and fails closed if that instant falls after recurrenceHorizonMs — i.e. if the
// RRULE's very first occurrence would already be past its own UNTIL, a self-contradictory
// recurrence no real calendar client can sensibly expand. Independently reproduced by
// Codex: a Saturday seriesAnchorMs with a Monday-only schedule and the (structurally
// permitted) minimum one-day recurrenceHorizonMs gap produced DTSTART Monday 09:00 with
// UNTIL the preceding Sunday 12:00Z — DTSTART strictly AFTER UNTIL. This check catches
// exactly that, while still accepting any horizon that genuinely covers the first
// occurrence, however short (see MIN_RECURRENCE_HORIZON_GAP_MS above — deliberately left as
// a coarse, cheap sanity floor; THIS check is the real, semantic guarantee).
function requireFirstOccurrenceWithinHorizon(dtstartInstantMs: number, recurrenceHorizonMs: number, dtstartLocalLiteral: string, timeZone: string): void {
  if (dtstartInstantMs > recurrenceHorizonMs) {
    throw new IcsGenerationError(
      `The first scheduled occurrence (${dtstartLocalLiteral} ${timeZone}) falls after recurrenceHorizonMs; the horizon must cover at least the first occurrence.`
    );
  }
}

// ---------------------------------------------------------------------------------------
// PUBLIC ENTRY POINT
// ---------------------------------------------------------------------------------------
export function generateCalendarIcs(rawInput: CalendarFeedInput): string {
  const input = validateCalendarFeedInput(rawInput);
  const sequence = requireIcsSequence(input.revision);
  const dtstampAndLastModified = formatIcsUtcDateTime(input.updatedAtMs);
  const firstOccurrence = computeFirstOccurrenceLocalDate(input.seriesAnchorMs, input.timezone, input.weekdays);
  const dtstartLocalLiteral = formatIcsLocalDateTime(firstOccurrence, input.localTime);
  const [dtstartHour, dtstartMinute] = input.localTime.split(':').map(Number);
  const dtstartInstantMs = localWallTimeToUtcMs(firstOccurrence.year, firstOccurrence.month, firstOccurrence.day, dtstartHour, dtstartMinute, input.timezone);
  requireFirstOccurrenceWithinHorizon(dtstartInstantMs, input.recurrenceHorizonMs, dtstartLocalLiteral, input.timezone);
  const coverageStartMs = computeVTimezoneCoverageStartMs(input.seriesAnchorMs, dtstartInstantMs);
  const vtimezoneComponents = buildVTimezoneComponents(coverageStartMs, input.recurrenceHorizonMs, input.timezone);
  const uidValue = `${input.eventUid}@${ICS_UID_DOMAIN}`;

  let out = '';
  out += buildProperty('BEGIN', 'VCALENDAR');
  out += buildProperty('VERSION', '2.0');
  out += buildProperty('PRODID', escapeIcsText(ICS_PRODID));
  out += buildProperty('CALSCALE', 'GREGORIAN');
  out += buildProperty('X-WR-CALNAME', escapeIcsText(CALENDAR_NAME));
  out += buildProperty('X-WR-TIMEZONE', input.timezone);
  out += buildVTimezoneText(input.timezone, vtimezoneComponents);
  out += buildProperty('BEGIN', 'VEVENT');
  out += buildProperty('UID', escapeIcsText(uidValue));
  out += buildProperty('DTSTAMP', dtstampAndLastModified);
  out += buildProperty('LAST-MODIFIED', dtstampAndLastModified);
  out += buildProperty('SEQUENCE', String(sequence));
  out += buildProperty('DTSTART', dtstartLocalLiteral, { TZID: input.timezone });
  out += buildProperty('RRULE', buildRruleValue(input.weekdays, input.recurrenceHorizonMs));
  out += buildProperty('DURATION', buildDurationValue(input.sessionDurationMinutes));
  out += buildProperty('SUMMARY', escapeIcsText(EVENT_SUMMARY));
  out += buildProperty('DESCRIPTION', escapeIcsText(EVENT_DESCRIPTION));
  out += buildProperty('END', 'VEVENT');
  out += buildProperty('END', 'VCALENDAR');
  return out;
}

// Exported for tests only — not part of the intended public surface (generateCalendarIcs is
// the one function a future feed endpoint should ever call).
export const __test__ = {
  IcsGenerationError,
  MIN_SESSION_DURATION_MINUTES,
  MAX_SESSION_DURATION_MINUTES,
  MAX_ICS_SEQUENCE,
  EVENT_UID_PATTERN,
  ICS_UID_DOMAIN,
  ICS_PRODID,
  CALENDAR_NAME,
  EVENT_SUMMARY,
  EVENT_DESCRIPTION,
  BYDAY_MAP,
  MIN_SUPPORTED_EPOCH_MS,
  MAX_SUPPORTED_EPOCH_MS,
  MIN_RECURRENCE_HORIZON_GAP_MS,
  MAX_RECURRENCE_HORIZON_SPAN_DAYS,
  MAX_RECURRENCE_HORIZON_SPAN_MS,
  DST_BRACKET_WINDOW_MS,
  validateCalendarFeedInput,
  requireIcsSequence,
  requireRfcRepresentableYear,
  requireFirstOccurrenceWithinHorizon,
  escapeIcsText,
  foldContentLine,
  buildProperty,
  formatIcsUtcDateTime,
  getZonedYmd,
  computeFirstOccurrenceLocalDate,
  formatIcsLocalDateTime,
  localWallTimeToUtcMs,
  computeVTimezoneCoverageStartMs,
  offsetMsAt,
  tzShortNameAt,
  findExactTransitionMs,
  findTransitionsInWindow,
  groupTransitionsIntoComponents,
  formatTzOffset,
  formatLocalLiteralAtOffset,
  buildVTimezoneComponents,
  buildVTimezoneText,
  buildRruleValue,
  buildDurationValue,
};
