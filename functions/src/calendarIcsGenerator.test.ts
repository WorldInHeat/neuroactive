// functions/src/calendarIcsGenerator.test.ts
// Calendar Integration Phase 1, Stage 3 tests — Codex repair pass 1.
//
// These tests exercise a PURE, dependency-free module directly — no fake Firestore, no
// Firebase Auth, no App Check, no network, and (deliberately) no mocking of the system
// clock, because the module under test never reads it in the first place. Every test
// supplies explicit seriesAnchorMs/recurrenceHorizonMs/updatedAtMs inputs, matching the
// module's own contract.
//
// Per Codex's explicit instruction, several tests assert on the actual SERIALIZED ICS
// TEXT output, not merely on helper return values, since RFC 5545 correctness is a
// property of the final byte stream.
'use strict';

import { generateCalendarIcs, __test__ } from './calendarIcsGenerator';
import type { CalendarFeedInput } from './calendarIcsGenerator';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log('PASS  ' + label);
    pass++;
  } else {
    console.log('FAIL  ' + label + (detail ? ': ' + detail : ''));
    fail++;
  }
}

// seriesAnchorMs: 2026-01-15 (a Thursday), well clear of any nearby DST transition.
// recurrenceHorizonMs: 5 years later, comfortably inside the supported domain and covering
// several transition cycles for DST-observing zones.
const DEFAULT_SERIES_ANCHOR_MS = Date.UTC(2026, 0, 15, 12, 0, 0);
const DEFAULT_RECURRENCE_HORIZON_MS = Date.UTC(2031, 0, 15, 12, 0, 0);
const DAY_MS_FOR_TEST = 24 * 60 * 60 * 1000;

const baseInput = (overrides: Partial<CalendarFeedInput> = {}): CalendarFeedInput => ({
  eventUid: 'sub_test0001',
  weekdays: [1, 3, 5],
  localTime: '18:30',
  timezone: 'America/Chicago',
  sessionDurationMinutes: 30,
  revision: 4,
  updatedAtMs: Date.UTC(2026, 7, 20, 12, 0, 0),
  seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS,
  recurrenceHorizonMs: DEFAULT_RECURRENCE_HORIZON_MS,
  ...overrides,
});

// Reverses foldContentLine's transformation, for round-trip verification: removes each
// CRLF+single-space continuation marker, splits on the remaining CRLF-terminated physical
// lines, and returns the reconstructed logical content lines (without their own trailing
// CRLF).
function unfoldContentLines(icsText: string): string[] {
  const unfolded = icsText.replace(/\r\n /g, '');
  const lines = unfolded.split('\r\n');
  if (lines[lines.length - 1] === '') lines.pop(); // trailing split artifact from the final CRLF
  return lines;
}

// Codex repair pass 2: with the BASELINE OBSERVANCE architecture, a VTIMEZONE can now
// contain MORE THAN ONE block of the same type (e.g. a baseline STANDARD block plus a
// detected-transition STANDARD block) — extracting only "the first" block of a given type is
// no longer sufficient for locating a SPECIFIC transition's serialization. This returns ALL
// matching blocks; tests search across all of them for the specific content they expect.
function extractAllBlocks(ics: string, tag: string): string[] {
  const matches = ics.match(new RegExp(`BEGIN:${tag}\\r\\n[\\s\\S]*?END:${tag}\\r\\n`, 'g'));
  if (!matches) throw new Error(`no block ${tag} found`);
  return matches;
}

function expectThrowsIcsGenerationError(fn: () => void): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof __test__.IcsGenerationError;
  }
}

// ---------------------------------------------------------------------------------------
// GENERATED-VTIMEZONE vs RESOLVER CROSS-CHECK (Codex repair pass 3, item 6). This is a
// SECOND, INDEPENDENT implementation of VTIMEZONE resolution — it re-parses the raw
// SERIALIZED ICS TEXT from scratch (never calling any of calendarIcsGenerator.ts's own
// functions) and simulates what a standards-compliant calendar client would do to resolve a
// given local wall-clock reading against the emitted STANDARD/DAYLIGHT observances. Its
// purpose is specifically to catch the class of bug repair pass 3 fixes: the internal
// resolver (localWallTimeToUtcMs) being correct while the SERIALIZED timezone definition
// disagrees with it. Validated standalone (see the session's own verification trail) against
// five known scenarios (Chicago spring/fall, Lord Howe before/fold, Asia/Almaty) before being
// relied upon here.
//
// ALGORITHM: for each observance, its onset instants (DTSTART + RDATE) are recovered by
// reversing this generator's own serialization convention (an onset literal was produced as
// `instant + tzOffsetFromMs`, per the repair pass 1 TZOFFSETFROM fix — so
// `parsedLiteral - tzOffsetFromMs` recovers the original instant exactly). For a target local
// reading, each observance is tried as "the governing one" by tentatively converting the
// target to UTC using ITS TZOFFSETTO (the offset active once that observance's onset has
// passed); the conversion is accepted only if it is SELF-CONSISTENT — at or after that
// observance's own most recent onset, and strictly before the next onset from ANY observance.
// A genuinely ambiguous local time (a FOLD) legitimately yields two accepted candidates; a
// gap yields none for that specific literal (not exercised here, since this generator never
// emits a DTSTART inside a gap without a defined interpretation to begin with).
function parseIcsOffset(value: string): number {
  const sign = value[0] === '-' ? -1 : 1;
  const hh = parseInt(value.slice(1, 3), 10);
  const mm = parseInt(value.slice(3, 5), 10);
  return sign * (hh * 60 + mm) * 60000;
}

function parseLocalLiteralAsUtcMs(literal: string): number {
  const y = +literal.slice(0, 4);
  const mo = +literal.slice(4, 6);
  const d = +literal.slice(6, 8);
  const h = +literal.slice(9, 11);
  const mi = +literal.slice(11, 13);
  const s = +literal.slice(13, 15);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

type ParsedObservance = { type: string; tzOffsetFromMs: number; tzOffsetToMs: number; onsetInstantsMs: number[] };

function parseVTimezoneObservances(ics: string): ParsedObservance[] {
  const unfolded = unfoldContentLines(ics).join('\r\n') + '\r\n';
  const blocks = [...unfolded.matchAll(/BEGIN:(STANDARD|DAYLIGHT)\r\n([\s\S]*?)END:\1\r\n/g)];
  return blocks.map(([, type, body]) => {
    const dtstart = body.match(/DTSTART:([^\r]*)\r\n/)![1];
    const tzOffsetFromMs = parseIcsOffset(body.match(/TZOFFSETFROM:([^\r]*)\r\n/)![1]);
    const tzOffsetToMs = parseIcsOffset(body.match(/TZOFFSETTO:([^\r]*)\r\n/)![1]);
    const rdateMatch = body.match(/RDATE:([^\r]*)\r\n/);
    const rdateLiterals = rdateMatch ? rdateMatch[1].split(',') : [];
    const onsetLiterals = [dtstart, ...rdateLiterals];
    const onsetInstantsMs = onsetLiterals.map((lit) => parseLocalLiteralAsUtcMs(lit) - tzOffsetFromMs).sort((a, b) => a - b);
    return { type, tzOffsetFromMs, tzOffsetToMs, onsetInstantsMs };
  });
}

// Returns EVERY self-consistent candidate instant for the given target local reading (0 for
// a gap, 1 for an ordinary time, 2 for a fold).
function interpretViaVTimezone(ics: string, year: number, month: number, day: number, hour: number, minute: number): number[] {
  const observances = parseVTimezoneObservances(ics);
  const allOnsets = observances.flatMap((o) => o.onsetInstantsMs).sort((a, b) => a - b);
  const targetLocalAsUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0);

  const candidates: number[] = [];
  for (const o of observances) {
    const candidateUtcMs = targetLocalAsUtcMs - o.tzOffsetToMs;
    const ownOnsetsBefore = o.onsetInstantsMs.filter((ms) => ms <= candidateUtcMs);
    if (ownOnsetsBefore.length === 0) continue;
    const mostRecentOwnOnset = Math.max(...ownOnsetsBefore);
    const laterOnsets = allOnsets.filter((ms) => ms > mostRecentOwnOnset);
    const nextOnsetMs = laterOnsets.length > 0 ? Math.min(...laterOnsets) : Infinity;
    if (candidateUtcMs >= mostRecentOwnOnset && candidateUtcMs < nextOnsetMs) {
      candidates.push(candidateUtcMs);
    }
  }
  return candidates;
}

function main(): void {
  console.log('\n=== pure helpers: escapeIcsText (RFC text escaping) ===');
  check('escapeIcsText: escapes backslash', __test__.escapeIcsText('a\\b') === 'a\\\\b');
  check('escapeIcsText: escapes semicolon', __test__.escapeIcsText('a;b') === 'a\\;b');
  check('escapeIcsText: escapes comma', __test__.escapeIcsText('a,b') === 'a\\,b');
  check('escapeIcsText: escapes LF as literal \\n', __test__.escapeIcsText('a\nb') === 'a\\nb');
  check('escapeIcsText: escapes CRLF as a single literal \\n', __test__.escapeIcsText('a\r\nb') === 'a\\nb');
  check('escapeIcsText: escapes bare CR as literal \\n', __test__.escapeIcsText('a\rb') === 'a\\nb');
  check('escapeIcsText: backslash escaping runs first (does not double-escape the inserted backslashes)', __test__.escapeIcsText(';') === '\\;' && __test__.escapeIcsText('\\;') === '\\\\\\;');
  check('escapeIcsText: leaves ordinary ASCII text untouched', __test__.escapeIcsText('NeuroActive Training') === 'NeuroActive Training');
  check('escapeIcsText: leaves non-ASCII (multibyte) text untouched (no special meaning to escape)', __test__.escapeIcsText('café 🎉 日本語') === 'café 🎉 日本語');
  check('escapeIcsText: combined adversarial input', __test__.escapeIcsText('a\\b;c,d\ne') === 'a\\\\b\\;c\\,d\\ne');

  console.log('\n=== pure helpers: foldContentLine (75-octet UTF-8-aware folding) ===');
  check('foldContentLine: a short line is not folded, and gets exactly one trailing CRLF', __test__.foldContentLine('SUMMARY:short') === 'SUMMARY:short\r\n');
  check('foldContentLine: a line of exactly 75 octets is not folded', (() => {
    const line = 'X'.repeat(75);
    return __test__.foldContentLine(line) === line + '\r\n';
  })());
  check('foldContentLine: a line of 76 octets IS folded into two physical lines', (() => {
    const line = 'X'.repeat(76);
    const result = __test__.foldContentLine(line);
    const physicalLines = result.split('\r\n');
    return physicalLines.length === 3 && physicalLines[2] === '';
  })());
  check('foldContentLine: every physical line is <= 75 octets for a long ASCII line', (() => {
    const line = 'DESCRIPTION:' + 'x'.repeat(300);
    const physicalLines = __test__.foldContentLine(line).split('\r\n').slice(0, -1);
    return physicalLines.every((l) => Buffer.byteLength(l, 'utf8') <= 75);
  })());
  check('foldContentLine: continuation lines begin with exactly one space', (() => {
    const line = 'DESCRIPTION:' + 'x'.repeat(300);
    const physicalLines = __test__.foldContentLine(line).split('\r\n').slice(0, -1);
    return physicalLines.slice(1).every((l) => l.startsWith(' ') && !l.startsWith('  '));
  })());
  check('foldContentLine: unfolding a long ASCII line reconstructs the exact original', (() => {
    const line = 'DESCRIPTION:' + 'the quick brown fox jumps over the lazy dog '.repeat(5);
    const [reconstructed] = unfoldContentLines(__test__.foldContentLine(line));
    return reconstructed === line;
  })());
  check('foldContentLine: only CRLF sequences appear, never a bare LF or bare CR', (() => {
    const folded = __test__.foldContentLine('DESCRIPTION:' + 'x'.repeat(300));
    return !/(?<!\r)\n/.test(folded) && !/\r(?!\n)/.test(folded);
  })());
  for (const [label, char, byteWidth] of [
    ['2-byte (é, U+00E9)', 'é', 2],
    ['3-byte (日, U+65E5)', '日', 3],
    ['4-byte (🎉, U+1F389)', '🎉', 4],
  ] as const) {
    check(`foldContentLine: multibyte boundary stress test, ${label} repeated across a 75-octet fold point -> no split codepoint, exact round-trip`, (() => {
      const line = 'SUMMARY:' + char.repeat(40);
      const folded = __test__.foldContentLine(line);
      const physicalLines = folded.split('\r\n').slice(0, -1);
      const allValid = physicalLines.every((l) => Buffer.byteLength(l, 'utf8') === Buffer.byteLength(Buffer.from(l, 'utf8').toString('utf8'), 'utf8'));
      const allWithinBudget = physicalLines.every((l) => Buffer.byteLength(l, 'utf8') <= 75);
      const [reconstructed] = unfoldContentLines(folded);
      const charByteWidthConfirmed = Buffer.byteLength(char, 'utf8') === byteWidth;
      return allValid && allWithinBudget && reconstructed === line && Buffer.byteLength(line, 'utf8') > 75 && charByteWidthConfirmed;
    })());
  }
  check('foldContentLine: an EXACTLY-at-boundary multibyte case does not corrupt the character', (() => {
    const line = 'SUMMARY:' + 'x'.repeat(65) + '🎉' + 'y'.repeat(10);
    const [reconstructed] = unfoldContentLines(__test__.foldContentLine(line));
    return reconstructed === line;
  })());

  console.log('\n=== generateCalendarIcs: eventUid ACCEPTANCE behavior (not just export presence) ===');
  check('generateCalendarIcs: a well-formed eventUid is genuinely ACCEPTED and appears verbatim in the UID property', (() => {
    const ics = generateCalendarIcs(baseInput({ eventUid: 'sub_accept_ok' }));
    return ics.includes(`UID:sub_accept_ok@${__test__.ICS_UID_DOMAIN}\r\n`);
  })());
  check('generateCalendarIcs: an eventUid using every allowed character class (letters, digits, dot, underscore, hyphen) is accepted', (() => {
    const ics = generateCalendarIcs(baseInput({ eventUid: 'Ab9.c_d-E' }));
    return ics.includes(`UID:Ab9.c_d-E@${__test__.ICS_UID_DOMAIN}\r\n`);
  })());
  check('generateCalendarIcs: accepts a valid eventUid at the 100-char boundary (verified via unfolded reconstruction, since this UID line is long enough to fold)', (() => {
    const ics = generateCalendarIcs(baseInput({ eventUid: 'a'.repeat(100) }));
    return unfoldContentLines(ics).includes(`UID:${'a'.repeat(100)}@${__test__.ICS_UID_DOMAIN}`);
  })());
  for (const bad of ['', 'has space', 'has@sign', 'has:colon', 'has;semi', 'has,comma', 'has\\backslash', 'has\nnewline', 'has\rcr', 'a'.repeat(101), 'quote"here']) {
    check(`generateCalendarIcs: rejects a malformed/injection-shaped eventUid ${JSON.stringify(bad)}`, expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ eventUid: bad }))));
  }

  console.log('\n=== generateCalendarIcs: basic VCALENDAR structure ===');
  const basic = generateCalendarIcs(baseInput());
  check('structure: begins with BEGIN:VCALENDAR', basic.startsWith('BEGIN:VCALENDAR\r\n'));
  check('structure: ends with END:VCALENDAR + final CRLF', basic.endsWith('END:VCALENDAR\r\n'));
  check('structure: contains VERSION:2.0', basic.includes('VERSION:2.0\r\n'));
  check('structure: contains CALSCALE:GREGORIAN', basic.includes('CALSCALE:GREGORIAN\r\n'));
  check('structure: contains X-WR-CALNAME:NeuroActive Training', basic.includes('X-WR-CALNAME:NeuroActive Training\r\n'));
  check('structure: contains a PRODID line', basic.includes(`PRODID:${__test__.ICS_PRODID}\r\n`));
  check('locked content: SUMMARY is exactly the locked constant', basic.includes(`SUMMARY:${__test__.EVENT_SUMMARY}\r\n`));
  check('locked content: DESCRIPTION is exactly the locked constant', basic.includes(`DESCRIPTION:${__test__.EVENT_DESCRIPTION}\r\n`));
  check('locked content: no other free-text content appears in the VEVENT (no course/lesson/progress words)', !/lesson|exercise|diagnosis|symptom|progress|entitlement|day\s*\d/i.test(basic));
  check('stable PRODID: identical across two structurally different inputs', (() => {
    const other = generateCalendarIcs(baseInput({ eventUid: 'sub_completely_different', weekdays: [0], revision: 99 }));
    const extract = (s: string) => s.match(/PRODID:[^\r]*\r\n/)![0];
    return extract(basic) === extract(other);
  })());

  console.log('\n=== generateCalendarIcs: UID contract ===');
  check('UID: is exactly eventUid@domain', basic.includes(`UID:sub_test0001@${__test__.ICS_UID_DOMAIN}\r\n`));
  check('UID: unchanged across a schedule edit (weekdays/localTime/timezone/duration/revision all change, eventUid does not)', (() => {
    const before = generateCalendarIcs(baseInput({ eventUid: 'sub_stable_uid' }));
    const after = generateCalendarIcs(
      baseInput({ eventUid: 'sub_stable_uid', weekdays: [0, 6], localTime: '06:00', timezone: 'UTC', sessionDurationMinutes: 90, revision: 55 })
    );
    const extractUid = (s: string) => s.match(/UID:[^\r]*\r\n/)![0];
    return extractUid(before) === extractUid(after) && extractUid(before) === `UID:sub_stable_uid@${__test__.ICS_UID_DOMAIN}\r\n`;
  })());
  check('UID contains no plausible Firebase uid/email/token/hash shape: only the validated eventUid plus the fixed domain suffix', (() => {
    const ics = generateCalendarIcs(baseInput({ eventUid: 'sub_abc123XYZ' }));
    const uidLine = ics.match(/UID:([^\r]*)\r\n/)![1];
    return uidLine === `sub_abc123XYZ@${__test__.ICS_UID_DOMAIN}` && !uidLine.includes('@gmail');
  })());
  check('a schedule edit preserving UID DOES change DTSTART, RRULE, and SEQUENCE', (() => {
    const before = generateCalendarIcs(baseInput({ eventUid: 'sub_edit_test', weekdays: [1], revision: 1 }));
    const after = generateCalendarIcs(baseInput({ eventUid: 'sub_edit_test', weekdays: [2, 4], revision: 2 }));
    const extract = (s: string, prop: string) => s.match(new RegExp(prop + ':[^\\r]*\\r\\n'))![0];
    const extractUid = (s: string) => s.match(/UID:[^\r]*\r\n/)![0];
    return (
      extractUid(before) === extractUid(after) &&
      extract(before, 'RRULE') !== extract(after, 'RRULE') &&
      extract(before, 'SEQUENCE') !== extract(after, 'SEQUENCE')
    );
  })());

  console.log('\n=== STABLE SERIES ANCHOR contract (Codex repair pass 1, issue 2) ===');
  check('refresh stability: identical persisted inputs (including seriesAnchorMs/recurrenceHorizonMs) produce byte-identical ICS regardless of how many times generated', (() => {
    const input = baseInput();
    const first = generateCalendarIcs(input);
    const second = generateCalendarIcs(input);
    const third = generateCalendarIcs({ ...input });
    return first === second && second === third;
  })());
  check('anchor coupling: DTSTART depends ONLY on seriesAnchorMs, never on recurrenceHorizonMs', (() => {
    const a = generateCalendarIcs(baseInput({ recurrenceHorizonMs: Date.UTC(2028, 0, 15, 12, 0, 0) }));
    const b = generateCalendarIcs(baseInput({ recurrenceHorizonMs: Date.UTC(2033, 0, 15, 12, 0, 0) }));
    const extractDtstart = (s: string) => s.match(/DTSTART;[^\r]*\r\n/)![0];
    return extractDtstart(a) === extractDtstart(b);
  })());
  check('later request/generation time cannot advance the recurring master: a LATER recurrenceHorizonMs (simulating a renewal fetch at a later real-world date) leaves DTSTART, UID, and RRULE\'s BYDAY completely unchanged -- only UNTIL and the VTIMEZONE window extend', (() => {
    const earlierFetch = generateCalendarIcs(baseInput({ recurrenceHorizonMs: Date.UTC(2028, 0, 15, 12, 0, 0) }));
    const laterFetch = generateCalendarIcs(baseInput({ recurrenceHorizonMs: Date.UTC(2033, 0, 15, 12, 0, 0) }));
    const extractDtstart = (s: string) => s.match(/DTSTART;[^\r]*\r\n/)![0];
    const extractUid = (s: string) => s.match(/UID:[^\r]*\r\n/)![0];
    const extractByday = (s: string) => s.match(/BYDAY=[A-Z,]+/)![0];
    const extractUntil = (s: string) => s.match(/UNTIL=[^;\r]*/)![0];
    return (
      extractDtstart(earlierFetch) === extractDtstart(laterFetch) &&
      extractUid(earlierFetch) === extractUid(laterFetch) &&
      extractByday(earlierFetch) === extractByday(laterFetch) &&
      extractUntil(earlierFetch) !== extractUntil(laterFetch)
    );
  })());
  check('a genuine preference/schedule edit changes DTSTART while UID stays stable and SEQUENCE increments (identity/update behavior coherent)', (() => {
    const before = generateCalendarIcs(baseInput({ eventUid: 'sub_sched_edit', weekdays: [1], revision: 1 })); // Monday only
    const after = generateCalendarIcs(baseInput({ eventUid: 'sub_sched_edit', weekdays: [2], revision: 2 })); // Tuesday only -- DTSTART must shift
    const extractDtstart = (s: string) => s.match(/DTSTART;[^\r]*\r\n/)![0];
    const extractUid = (s: string) => s.match(/UID:[^\r]*\r\n/)![0];
    const extractSeq = (s: string) => s.match(/SEQUENCE:[^\r]*\r\n/)![0];
    return extractDtstart(before) !== extractDtstart(after) && extractUid(before) === extractUid(after) && extractSeq(before) !== extractSeq(after);
  })());
  check('a timezone edit remains coherent under the same identity/update rules: UID stable, VTIMEZONE TZID/X-WR-TIMEZONE/DTSTART;TZID all update together consistently', (() => {
    const before = generateCalendarIcs(baseInput({ eventUid: 'sub_tz_edit', timezone: 'America/Chicago', revision: 1 }));
    const after = generateCalendarIcs(baseInput({ eventUid: 'sub_tz_edit', timezone: 'America/New_York', revision: 2 }));
    const extractUid = (s: string) => s.match(/UID:[^\r]*\r\n/)![0];
    const xwr = (s: string) => s.match(/X-WR-TIMEZONE:([^\r]*)\r\n/)![1];
    const vtzid = (s: string) => s.match(/BEGIN:VTIMEZONE\r\nTZID:([^\r]*)\r\n/)![1];
    const dtstartTzid = (s: string) => s.match(/DTSTART;TZID=([^:]*):/)![1];
    return (
      extractUid(before) === extractUid(after) &&
      xwr(after) === 'America/New_York' &&
      vtzid(after) === 'America/New_York' &&
      dtstartTzid(after) === 'America/New_York' &&
      xwr(before) === 'America/Chicago'
    );
  })());
  check('seriesAnchorMs falling exactly on a selected weekday resolves to that SAME calendar date (dayOffset 0)', (() => {
    // 2026-01-16 is a Friday; weekdays includes 5 (Friday).
    const ics = generateCalendarIcs(baseInput({ seriesAnchorMs: Date.UTC(2026, 0, 16, 12, 0, 0), weekdays: [1, 3, 5] }));
    return ics.includes('DTSTART;TZID=America/Chicago:20260116T183000\r\n');
  })());
  check('seriesAnchorMs NOT on a selected weekday resolves forward to the next matching day', (() => {
    // 2026-01-17 is a Saturday; weekdays = [1] (Monday only) -> next Monday is 2026-01-19.
    const ics = generateCalendarIcs(baseInput({ seriesAnchorMs: Date.UTC(2026, 0, 17, 12, 0, 0), weekdays: [1] }));
    return ics.includes('DTSTART;TZID=America/Chicago:20260119T183000\r\n');
  })());

  console.log('\n=== SEQUENCE contract ===');
  check('SEQUENCE: equals the input revision', generateCalendarIcs(baseInput({ revision: 7 })).includes('SEQUENCE:7\r\n'));
  check('SEQUENCE: a different revision produces a different SEQUENCE line', (() => {
    const a = generateCalendarIcs(baseInput({ revision: 1 }));
    const b = generateCalendarIcs(baseInput({ revision: 2 }));
    return a.includes('SEQUENCE:1\r\n') && b.includes('SEQUENCE:2\r\n');
  })());
  check('SEQUENCE: MAX_ICS_SEQUENCE itself is accepted', generateCalendarIcs(baseInput({ revision: __test__.MAX_ICS_SEQUENCE })).includes(`SEQUENCE:${__test__.MAX_ICS_SEQUENCE}\r\n`));
  check('SEQUENCE: MAX_ICS_SEQUENCE + 1 is refused (fails closed, does not silently wrap/truncate)', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ revision: __test__.MAX_ICS_SEQUENCE + 1 }))));
  check('SEQUENCE: revision 0 is refused (Stage 2 documents start at revision 1)', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ revision: 0 }))));

  console.log('\n=== DTSTAMP / LAST-MODIFIED contract ===');
  check('DTSTAMP: derived from updatedAtMs, formatted as UTC date-time ending in Z', generateCalendarIcs(baseInput({ updatedAtMs: Date.UTC(2026, 0, 2, 3, 4, 5) })).includes('DTSTAMP:20260102T030405Z\r\n'));
  check('DTSTAMP and LAST-MODIFIED are identical (both derived from updatedAtMs, no separate wall-clock source)', (() => {
    const ics = generateCalendarIcs(baseInput());
    return ics.match(/DTSTAMP:([^\r]*)\r\n/)![1] === ics.match(/LAST-MODIFIED:([^\r]*)\r\n/)![1];
  })());
  check('DTSTAMP: identical for two generations with the same updatedAtMs, even with everything else different', (() => {
    const a = generateCalendarIcs(baseInput({ updatedAtMs: 1700000000000, weekdays: [1] }));
    const b = generateCalendarIcs(baseInput({ updatedAtMs: 1700000000000, weekdays: [2, 4], eventUid: 'sub_other' }));
    return a.match(/DTSTAMP:[^\r]*\r\n/)![0] === b.match(/DTSTAMP:[^\r]*\r\n/)![0];
  })());
  check('DTSTAMP: a different updatedAtMs produces a different DTSTAMP', (() => {
    const a = generateCalendarIcs(baseInput({ updatedAtMs: 1700000000000 }));
    const b = generateCalendarIcs(baseInput({ updatedAtMs: 1700000100000 }));
    return a.match(/DTSTAMP:[^\r]*\r\n/)![0] !== b.match(/DTSTAMP:[^\r]*\r\n/)![0];
  })());

  console.log('\n=== DTSTART local wall-clock contract ===');
  check('DTSTART: uses TZID param equal to the configured timezone, local literal ends with the configured localTime + seconds', /DTSTART;TZID=America\/Chicago:\d{8}T183000\r\n/.test(generateCalendarIcs(baseInput({ timezone: 'America/Chicago', localTime: '18:30' }))));
  check('DTSTART: the local literal (the part after the colon) has NO trailing Z (never converted to a fixed UTC instant)', (() => {
    const line = generateCalendarIcs(baseInput()).match(/DTSTART;TZID=[^\r]*\r\n/)![0];
    const value = line.split(':')[1]; // "TZID" itself contains a 'Z' -- check only the value after the colon.
    return !value.includes('Z');
  })());

  console.log('\n=== RRULE contract (now includes UNTIL, Codex repair pass 1 issue 3) ===');
  const untilSuffix = `UNTIL=${__test__.formatIcsUtcDateTime(DEFAULT_RECURRENCE_HORIZON_MS)}`;
  check('RRULE: Monday-only, includes UNTIL matching recurrenceHorizonMs', generateCalendarIcs(baseInput({ weekdays: [1] })).includes(`RRULE:FREQ=WEEKLY;BYDAY=MO;${untilSuffix}\r\n`));
  check('RRULE: Mon/Wed/Fri, includes UNTIL', generateCalendarIcs(baseInput({ weekdays: [1, 3, 5] })).includes(`RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;${untilSuffix}\r\n`));
  check('RRULE: Sunday/Saturday, includes UNTIL', generateCalendarIcs(baseInput({ weekdays: [0, 6] })).includes(`RRULE:FREQ=WEEKLY;BYDAY=SU,SA;${untilSuffix}\r\n`));
  check('RRULE: all seven days, canonical ascending BYDAY order matching input order (SU..SA)', generateCalendarIcs(baseInput({ weekdays: [0, 1, 2, 3, 4, 5, 6] })).includes(`RRULE:FREQ=WEEKLY;BYDAY=SU,MO,TU,WE,TH,FR,SA;${untilSuffix}\r\n`));
  check('RRULE: UNTIL is expressed in UTC (trailing Z), per RFC 5545 3.3.10 for a TZID-relative DTSTART', /RRULE:[^\r]*UNTIL=\d{8}T\d{6}Z\r\n/.test(generateCalendarIcs(baseInput())));
  check('RRULE: UNTIL exactly equals recurrenceHorizonMs formatted as UTC date-time', (() => {
    const horizon = Date.UTC(2029, 5, 1, 8, 30, 0);
    const ics = generateCalendarIcs(baseInput({ recurrenceHorizonMs: horizon }));
    return ics.includes('UNTIL=20290601T083000Z');
  })());
  check('RRULE: no COUNT is ever emitted', !generateCalendarIcs(baseInput()).includes('COUNT'));
  check('weekdays: a non-canonical (unsorted) stored input is REJECTED, not silently sorted', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ weekdays: [5, 1, 3] }))));
  check('weekdays: an empty array is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ weekdays: [] }))));

  console.log('\n=== DURATION contract ===');
  check('DURATION: 5-minute lower bound', generateCalendarIcs(baseInput({ sessionDurationMinutes: 5 })).includes('DURATION:PT5M\r\n'));
  check('DURATION: 120-minute upper bound', generateCalendarIcs(baseInput({ sessionDurationMinutes: 120 })).includes('DURATION:PT120M\r\n'));
  check('DURATION: no DTEND is ever emitted alongside DURATION', !generateCalendarIcs(baseInput()).includes('DTEND'));
  check('duration: out-of-bounds value is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ sessionDurationMinutes: 121 }))));

  console.log('\n=== VTIMEZONE structure and TZID coherence ===');
  check('VTIMEZONE: present, well-formed BEGIN/END pair', (() => {
    const ics = generateCalendarIcs(baseInput());
    return ics.includes('BEGIN:VTIMEZONE\r\n') && ics.includes('END:VTIMEZONE\r\n') && ics.indexOf('BEGIN:VTIMEZONE') < ics.indexOf('END:VTIMEZONE');
  })());
  check('VTIMEZONE: TZID matches X-WR-TIMEZONE and DTSTART;TZID exactly (single source of truth, no possible divergence)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago' }));
    const xwr = ics.match(/X-WR-TIMEZONE:([^\r]*)\r\n/)![1];
    const vtzid = ics.match(/BEGIN:VTIMEZONE\r\nTZID:([^\r]*)\r\n/)![1];
    const dtstartTzid = ics.match(/DTSTART;TZID=([^:]*):/)![1];
    return xwr === 'America/Chicago' && vtzid === 'America/Chicago' && dtstartTzid === 'America/Chicago';
  })());
  check('VTIMEZONE: a DST-observing zone (America/Chicago) produces BOTH a STANDARD and a DAYLIGHT component', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago' }));
    return ics.includes('BEGIN:STANDARD\r\n') && ics.includes('BEGIN:DAYLIGHT\r\n');
  })());
  check('VTIMEZONE: a fixed-offset zone (America/Phoenix) produces exactly ONE component, no RDATE', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Phoenix' }));
    const standardCount = (ics.match(/BEGIN:STANDARD\r\n/g) || []).length;
    const daylightCount = (ics.match(/BEGIN:DAYLIGHT\r\n/g) || []).length;
    return standardCount === 1 && daylightCount === 0 && !ics.includes('RDATE');
  })());
  check('VTIMEZONE: a fixed-offset zone (UTC) also produces exactly one STANDARD component with a zero offset', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'UTC' }));
    return ics.includes('TZOFFSETFROM:+0000\r\n') && ics.includes('TZOFFSETTO:+0000\r\n');
  })());
  check('item 41: an INVALID typed timezone input is rejected outright, not silently repaired', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ timezone: 'Not/A_Real_Zone' }))));
  check('item 41: a NONCANONICAL but valid timezone ALIAS (US/Central) is rejected, not silently canonicalized', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ timezone: 'US/Central' }))));

  console.log('\n=== EXACT TRANSITION ONSET LITERALS (Codex repair pass 1, issue 1 -- THE PRIMARY BUG) ===');
  // Ground truth verified independently against direct Intl.DateTimeFormat sampling (see the
  // final report's ROOT CAUSE section) before being hardcoded here. RFC 5545 requires a
  // VTIMEZONE sub-component's own DTSTART/RDATE local literal to be interpreted relative to
  // TZOFFSETFROM (the offset in effect immediately BEFORE the transition), matching RFC
  // 5545's own worked VTIMEZONE example (a DAYLIGHT component's DTSTART at "020000" local
  // STANDARD time, the moment daylight saving begins -- not "030000", the moment after).
  check('America/Chicago: 2026 spring-forward onset literal is 20260308T020000 (TZOFFSETFROM -0600), NOT 20260308T030000', (() => {
    // seriesAnchorMs deliberately mid-2025 (well before either transition) so the DAYLIGHT
    // block present is the DETECTED transition, distinguishable from the (also-present,
    // always-STANDARD-typed) baseline.
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', seriesAnchorMs: Date.UTC(2025, 6, 1), recurrenceHorizonMs: Date.UTC(2027, 0, 1) }));
    const daylightBlocks = extractAllBlocks(ics, 'DAYLIGHT');
    return daylightBlocks.some((b) => b.includes('20260308T020000') && b.includes('TZOFFSETFROM:-0600\r\n') && b.includes('TZOFFSETTO:-0500\r\n')) && !ics.includes('20260308T030000');
  })());
  check('America/Chicago: 2026 fall-back onset literal is 20261101T020000 (TZOFFSETFROM -0500), NOT 20261101T010000', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', seriesAnchorMs: Date.UTC(2025, 6, 1), recurrenceHorizonMs: Date.UTC(2027, 0, 1) }));
    const standardBlocks = extractAllBlocks(ics, 'STANDARD');
    return standardBlocks.some((b) => b.includes('20261101T020000') && b.includes('TZOFFSETFROM:-0500\r\n') && b.includes('TZOFFSETTO:-0600\r\n')) && !ics.includes('20261101T010000');
  })());
  check('Australia/Lord_Howe: exact 30-minute-offset transition serialization (spring 2025-10-05 onset 020000, TZOFFSETFROM +1030 -> TZOFFSETTO +1100)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'Australia/Lord_Howe', seriesAnchorMs: Date.UTC(2025, 0, 1), recurrenceHorizonMs: Date.UTC(2026, 6, 1) }));
    const daylightBlocks = extractAllBlocks(ics, 'DAYLIGHT');
    return daylightBlocks.some((b) => b.includes('20251005T020000') && b.includes('TZOFFSETFROM:+1030\r\n') && b.includes('TZOFFSETTO:+1100\r\n'));
  })());
  check('Australia/Lord_Howe: fall transition (2026-04-05 onset 020000, TZOFFSETFROM +1100 -> TZOFFSETTO +1030)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'Australia/Lord_Howe', seriesAnchorMs: Date.UTC(2025, 0, 1), recurrenceHorizonMs: Date.UTC(2026, 6, 1) }));
    const standardBlocks = extractAllBlocks(ics, 'STANDARD');
    return standardBlocks.some((b) => b.includes('20260405T020000') && b.includes('TZOFFSETFROM:+1100\r\n') && b.includes('TZOFFSETTO:+1030\r\n'));
  })());
  check('Pacific/Chatham: exact quarter-hour base offset transition serialization (spring 2025-09-28 onset 024500, TZOFFSETFROM +1245 -> TZOFFSETTO +1345)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'Pacific/Chatham', seriesAnchorMs: Date.UTC(2025, 0, 1), recurrenceHorizonMs: Date.UTC(2026, 6, 1) }));
    const daylightBlocks = extractAllBlocks(ics, 'DAYLIGHT');
    return daylightBlocks.some((b) => b.includes('20250928T024500') && b.includes('TZOFFSETFROM:+1245\r\n') && b.includes('TZOFFSETTO:+1345\r\n'));
  })());
  check('Pacific/Chatham: fall transition (2026-04-05 onset 034500, TZOFFSETFROM +1345 -> TZOFFSETTO +1245)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'Pacific/Chatham', seriesAnchorMs: Date.UTC(2025, 0, 1), recurrenceHorizonMs: Date.UTC(2026, 6, 1) }));
    const standardBlocks = extractAllBlocks(ics, 'STANDARD');
    return standardBlocks.some((b) => b.includes('20260405T034500') && b.includes('TZOFFSETFROM:+1345\r\n') && b.includes('TZOFFSETTO:+1245\r\n'));
  })());
  check('DST correctness holds in the Southern Hemisphere too (Australia/Sydney: DAYLIGHT offset +1100 > STANDARD offset +1000)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'Australia/Sydney', seriesAnchorMs: Date.UTC(2025, 6, 1), recurrenceHorizonMs: Date.UTC(2027, 0, 1) }));
    const daylightBlocks = extractAllBlocks(ics, 'DAYLIGHT');
    const standardBlocks = extractAllBlocks(ics, 'STANDARD');
    return daylightBlocks.some((b) => b.includes('TZOFFSETTO:+1100\r\n')) && standardBlocks.some((b) => b.includes('TZOFFSETTO:+1000\r\n'));
  })());

  console.log('\n=== BASELINE OBSERVANCE ARCHITECTURE (Codex repair pass 2, issue 2) ===');
  check('trailing-partial-interval regression (Codex repair pass 2, issue 1): America/Chicago with recurrenceHorizonMs 2h after the 2026-03-08T08:00:00Z spring transition still discovers it', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', weekdays: [0], localTime: '00:00', seriesAnchorMs: Date.UTC(2026, 0, 1), recurrenceHorizonMs: Date.UTC(2026, 2, 8, 10, 0, 0) }));
    return ics.includes('20260308T020000');
  })());
  check('Asia/Almaty: a permanent base-offset change (2024, +0600 -> +0500) is correctly detected within the window', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'Asia/Almaty', weekdays: [0], localTime: '09:00', seriesAnchorMs: Date.UTC(2023, 0, 1), recurrenceHorizonMs: Date.UTC(2025, 0, 1) }));
    return ics.includes('TZOFFSETFROM:+0600\r\n') && ics.includes('TZOFFSETTO:+0500\r\n');
  })());
  check('Asia/Almaty: the generated VTIMEZONE has a valid BASELINE observance (+0600, onset at/before coverageStartMs) effective at the 2023 VEVENT DTSTART, BEFORE the March 2024 permanent transition', (() => {
    // Codex repair pass 3: the baseline's DTSTART is no longer the 1970 sentinel -- it is
    // coverageStartMs itself (see VTIMEZONE COVERAGE-START ARCHITECTURE above). This test now
    // verifies the same underlying invariant (a +0600 observance genuinely covers the 2023
    // DTSTART) via the independent cross-check rather than asserting a specific literal.
    const ics = generateCalendarIcs(baseInput({ timezone: 'Asia/Almaty', weekdays: [0], localTime: '09:00', seriesAnchorMs: Date.UTC(2023, 0, 1), recurrenceHorizonMs: Date.UTC(2025, 0, 1) }));
    const standardBlocks = extractAllBlocks(ics, 'STANDARD');
    const hasBaseline = standardBlocks.some((b) => b.includes('TZOFFSETFROM:+0600\r\n') && b.includes('TZOFFSETTO:+0600\r\n'));
    const dtstartLine = ics.match(/DTSTART;TZID=[^\r]*\r\n/)![0];
    const resolved = interpretViaVTimezone(ics, 2023, 1, 1, 9, 0);
    // The VEVENT DTSTART itself must be in 2023, i.e. genuinely BEFORE the 2024 transition,
    // proving this test exercises the exact scenario the baseline exists to cover, and the
    // cross-check must confirm it resolves unambiguously via the +0600 baseline.
    return hasBaseline && dtstartLine.includes('20230101T090000') && resolved.length === 1 && resolved[0] === Date.UTC(2023, 0, 1, 3, 0, 0);
  })());
  check('a fixed-offset zone (America/Phoenix) still produces exactly ONE component (the baseline alone), no RDATE -- unchanged behavior under the new architecture', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Phoenix' }));
    const standardCount = (ics.match(/BEGIN:STANDARD\r\n/g) || []).length;
    const daylightCount = (ics.match(/BEGIN:DAYLIGHT\r\n/g) || []).length;
    return standardCount === 1 && daylightCount === 0 && !ics.includes('RDATE');
  })());

  console.log('\n=== VTIMEZONE COVERAGE-START ARCHITECTURE (Codex repair pass 3): DTSTART earlier than seriesAnchorMs on the same local date ===');
  // Ground truth for every scenario below was verified independently (direct Intl.DateTimeFormat
  // sampling and a standalone prototype of the cross-check algorithm) before being hardcoded
  // here -- see the session's own verification trail in the final report.
  check('Codex\'s exact repro: America/Chicago, seriesAnchorMs AFTER the spring transition, DTSTART BEFORE it on the same local date -- VTIMEZONE now correctly uses -0600 and serializes the transition', (() => {
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'America/Chicago', weekdays: [0], localTime: '01:30', seriesAnchorMs: Date.UTC(2026, 2, 8, 18, 0, 0), recurrenceHorizonMs: Date.UTC(2026, 2, 15) })
    );
    const resolved = interpretViaVTimezone(ics, 2026, 3, 8, 1, 30);
    const expected = __test__.localWallTimeToUtcMs(2026, 3, 8, 1, 30, 'America/Chicago');
    return (
      ics.includes('DTSTART;TZID=America/Chicago:20260308T013000\r\n') &&
      ics.includes('20260308T020000') && // the spring transition itself must still be serialized
      resolved.length === 1 &&
      resolved[0] === expected &&
      expected === Date.UTC(2026, 2, 8, 7, 30, 0) // 01:30 CST (-0600) = 07:30Z, the CORRECT interpretation
    );
  })());
  check('America/Chicago fall fold: seriesAnchorMs AFTER the fall transition, DTSTART IN the ambiguous fold -- VTIMEZONE resolution agrees with localWallTimeToUtcMs\'s earlier-occurrence choice', (() => {
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'America/Chicago', weekdays: [0], localTime: '01:30', seriesAnchorMs: Date.UTC(2026, 10, 1, 20, 0, 0), recurrenceHorizonMs: Date.UTC(2026, 10, 8) })
    );
    const resolved = interpretViaVTimezone(ics, 2026, 11, 1, 1, 30);
    const resolverChoice = __test__.localWallTimeToUtcMs(2026, 11, 1, 1, 30, 'America/Chicago');
    return (
      ics.includes('DTSTART;TZID=America/Chicago:20261101T013000\r\n') &&
      resolved.length === 2 && // a genuine fold: BOTH interpretations are self-consistent per the VTIMEZONE
      resolved.includes(Date.UTC(2026, 10, 1, 6, 30, 0)) && // CDT (-0500) candidate
      resolved.includes(Date.UTC(2026, 10, 1, 7, 30, 0)) && // CST (-0600) candidate
      resolverChoice === Date.UTC(2026, 10, 1, 6, 30, 0) && // resolver picks the EARLIER
      resolved.includes(resolverChoice) // and the VTIMEZONE agrees that choice is valid
    );
  })());
  check('Australia/Lord_Howe: seriesAnchorMs AFTER its 30-minute fall transition, DTSTART BEFORE it (unambiguous) on the same local date -- correct +1100 side represented', (() => {
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'Australia/Lord_Howe', weekdays: [0], localTime: '01:00', seriesAnchorMs: Date.UTC(2026, 3, 4, 20, 0, 0), recurrenceHorizonMs: Date.UTC(2026, 3, 11) })
    );
    const resolved = interpretViaVTimezone(ics, 2026, 4, 5, 1, 0);
    const expected = __test__.localWallTimeToUtcMs(2026, 4, 5, 1, 0, 'Australia/Lord_Howe');
    return ics.includes('DTSTART;TZID=Australia/Lord_Howe:20260405T010000\r\n') && resolved.length === 1 && resolved[0] === expected && expected === Date.UTC(2026, 3, 4, 14, 0, 0);
  })());
  check('Australia/Lord_Howe fold: seriesAnchorMs AFTER the transition, DTSTART IN the 30-minute fold -- both +1100/+1030 sides represented, resolver agrees with the earlier one', (() => {
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'Australia/Lord_Howe', weekdays: [0], localTime: '01:45', seriesAnchorMs: Date.UTC(2026, 3, 4, 20, 0, 0), recurrenceHorizonMs: Date.UTC(2026, 3, 11) })
    );
    const resolved = interpretViaVTimezone(ics, 2026, 4, 5, 1, 45);
    const resolverChoice = __test__.localWallTimeToUtcMs(2026, 4, 5, 1, 45, 'Australia/Lord_Howe');
    return (
      ics.includes('DTSTART;TZID=Australia/Lord_Howe:20260405T014500\r\n') &&
      resolved.length === 2 &&
      resolved.includes(Date.UTC(2026, 3, 4, 14, 45, 0)) && // +1100 (DST) candidate
      resolved.includes(Date.UTC(2026, 3, 4, 15, 15, 0)) && // +1030 (STD) candidate
      resolverChoice === Date.UTC(2026, 3, 4, 14, 45, 0) &&
      resolved.includes(resolverChoice)
    );
  })());
  check('ordinary non-transition date: coverage-start architecture leaves normal (no nearby transition) behavior completely unchanged', (() => {
    // seriesAnchorMs and the resolved DTSTART both fall in mid-summer, nowhere near any
    // transition -- coverageStartMs collapses to seriesAnchorMs itself (the min() picks it),
    // and resolution must be trivially unambiguous.
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', weekdays: [3], localTime: '12:00', seriesAnchorMs: Date.UTC(2026, 6, 1, 12, 0, 0), recurrenceHorizonMs: Date.UTC(2026, 6, 15) }));
    const resolved = interpretViaVTimezone(ics, 2026, 7, 1, 12, 0);
    const expected = __test__.localWallTimeToUtcMs(2026, 7, 1, 12, 0, 'America/Chicago');
    return resolved.length === 1 && resolved[0] === expected;
  })());
  check('Asia/Almaty regression (Codex repair pass 2) remains fixed under the coverage-start architecture: cross-check independently confirms the 2023 DTSTART resolves correctly via the +0600 baseline', (() => {
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'Asia/Almaty', weekdays: [0], localTime: '09:00', seriesAnchorMs: Date.UTC(2023, 0, 1), recurrenceHorizonMs: Date.UTC(2025, 0, 1) })
    );
    const resolved = interpretViaVTimezone(ics, 2023, 1, 1, 9, 0);
    const expected = __test__.localWallTimeToUtcMs(2023, 1, 1, 9, 0, 'Asia/Almaty');
    return ics.includes('DTSTART;TZID=Asia/Almaty:20230101T090000\r\n') && resolved.length === 1 && resolved[0] === expected && expected === Date.UTC(2023, 0, 1, 3, 0, 0);
  })());
  check('ordinary anchor-after-configured-wall-time semantics (Codex repair pass 2, issue 5) remain fixed: cross-check confirms the resolved instant is correct even though DTSTART precedes the anchor\'s own time', (() => {
    const anchorMs = __test__.localWallTimeToUtcMs(2026, 1, 19, 10, 0, 'America/Chicago'); // Monday 10:00
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', weekdays: [1], localTime: '09:00', seriesAnchorMs: anchorMs, recurrenceHorizonMs: Date.UTC(2026, 1, 1) }));
    const resolved = interpretViaVTimezone(ics, 2026, 1, 19, 9, 0);
    const expected = __test__.localWallTimeToUtcMs(2026, 1, 19, 9, 0, 'America/Chicago');
    return ics.includes('DTSTART;TZID=America/Chicago:20260119T090000\r\n') && resolved.length === 1 && resolved[0] === expected;
  })());
  check('VTIMEZONE COVERAGE-START ARCHITECTURE: coverageStartMs (the baseline\'s own DTSTART) is never LATER than seriesAnchorMs, for both the ordinary case and the DTSTART-before-anchor repro case', (() => {
    const check1 = (() => {
      // Ordinary case: DTSTART resolves at/after seriesAnchorMs, so min(seriesAnchorMs,
      // dtstartInstantMs - 36h) collapses to seriesAnchorMs itself.
      const seriesAnchorMs = Date.UTC(2026, 6, 1, 12, 0, 0);
      const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', weekdays: [3], localTime: '12:00', seriesAnchorMs, recurrenceHorizonMs: Date.UTC(2026, 6, 15) }));
      const baselineBlock = extractAllBlocks(ics, 'STANDARD')[0];
      const baselineOffsetMs = parseIcsOffset(baselineBlock.match(/TZOFFSETFROM:([^\r]*)\r\n/)![1]);
      const baselineInstantMs = parseLocalLiteralAsUtcMs(baselineBlock.match(/DTSTART:([^\r]*)\r\n/)![1]) - baselineOffsetMs;
      return baselineInstantMs <= seriesAnchorMs;
    })();
    const check2 = (() => {
      // Repro case: DTSTART resolves BEFORE seriesAnchorMs -- coverageStartMs must extend
      // earlier than seriesAnchorMs to correctly cover it.
      const seriesAnchorMs = Date.UTC(2026, 2, 8, 18, 0, 0);
      const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', weekdays: [0], localTime: '01:30', seriesAnchorMs, recurrenceHorizonMs: Date.UTC(2026, 2, 15) }));
      const baselineBlock = extractAllBlocks(ics, 'STANDARD')[0]; // the spring transition is a DAYLIGHT block, so the sole STANDARD block here is the baseline.
      const baselineOffsetMs = parseIcsOffset(baselineBlock.match(/TZOFFSETFROM:([^\r]*)\r\n/)![1]);
      const baselineInstantMs = parseLocalLiteralAsUtcMs(baselineBlock.match(/DTSTART:([^\r]*)\r\n/)![1]) - baselineOffsetMs;
      return baselineInstantMs < seriesAnchorMs; // strictly earlier in this specific repro.
    })();
    return check1 && check2;
  })());

  console.log('\n=== RECURRENCE LIFETIME / horizon alignment (Codex repair pass 1, issue 3) ===');
  check('the VTIMEZONE window never represents a transition BEYOND recurrenceHorizonMs', (() => {
    const horizon = Date.UTC(2026, 5, 1); // mid-2026: after spring transition, before fall transition
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', seriesAnchorMs: Date.UTC(2026, 0, 1), recurrenceHorizonMs: horizon }));
    // The fall-back transition (Nov 2026) must NOT appear anywhere, since it's after the horizon.
    return !ics.includes('20261101');
  })());
  check('RRULE UNTIL and the VTIMEZONE window are governed by the same recurrenceHorizonMs (advancing it changes both consistently)', (() => {
    const a = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', seriesAnchorMs: Date.UTC(2026, 0, 1), recurrenceHorizonMs: Date.UTC(2026, 5, 1) }));
    const b = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', seriesAnchorMs: Date.UTC(2026, 0, 1), recurrenceHorizonMs: Date.UTC(2027, 5, 1) }));
    // b's later horizon should reveal the fall 2026 AND spring 2027 transitions that a's does not.
    return !a.includes('20261101') && b.includes('20261101') && a.match(/UNTIL=[^;\r]*/)![0] !== b.match(/UNTIL=[^;\r]*/)![0];
  })());

  console.log('\n=== DTSTART <= UNTIL enforcement (Codex repair pass 2, issue 3) ===');
  check('Saturday-anchor / Monday-only-schedule / minimum one-day horizon is REJECTED (independently reproduced repro: DTSTART would land strictly after UNTIL)', (() => {
    // 2026-01-17 is a Saturday. weekdays=[1] (Monday only) -> first occurrence is Monday
    // 2026-01-19 09:00 local. A horizon of exactly one day past the Saturday anchor
    // (2026-01-18T12:00Z) is strictly BEFORE that Monday occurrence.
    return expectThrowsIcsGenerationError(() =>
      generateCalendarIcs(
        baseInput({
          timezone: 'America/Chicago',
          weekdays: [1],
          localTime: '09:00',
          seriesAnchorMs: Date.UTC(2026, 0, 17, 12, 0, 0),
          recurrenceHorizonMs: Date.UTC(2026, 0, 18, 12, 0, 0),
        })
      )
    );
  })());
  check('an exactly-valid SHORT horizon that genuinely includes the first occurrence is accepted (shorter horizons remain supported when they cover DTSTART)', (() => {
    // Same Saturday anchor and Monday-only schedule, but the horizon is extended to cover
    // Monday 2026-01-19 (well past 09:00 local, i.e. past the first occurrence).
    const ics = generateCalendarIcs(
      baseInput({
        timezone: 'America/Chicago',
        weekdays: [1],
        localTime: '09:00',
        seriesAnchorMs: Date.UTC(2026, 0, 17, 12, 0, 0),
        recurrenceHorizonMs: Date.UTC(2026, 0, 19, 20, 0, 0),
      })
    );
    return ics.includes('DTSTART;TZID=America/Chicago:20260119T090000');
  })());
  check('a horizon EXACTLY equal to the first occurrence\'s resolved absolute instant is accepted (boundary: DTSTART <= UNTIL, not strictly <)', (() => {
    // Monday 2026-01-19 09:00 America/Chicago (CST, -0600) = 2026-01-19T15:00:00Z exactly.
    const horizonMs = Date.UTC(2026, 0, 19, 15, 0, 0);
    const ics = generateCalendarIcs(
      baseInput({
        timezone: 'America/Chicago',
        weekdays: [1],
        localTime: '09:00',
        seriesAnchorMs: Date.UTC(2026, 0, 17, 12, 0, 0),
        recurrenceHorizonMs: horizonMs,
      })
    );
    return ics.includes('DTSTART;TZID=America/Chicago:20260119T090000') && ics.includes(`UNTIL=${__test__.formatIcsUtcDateTime(horizonMs)}`);
  })());
  check('a horizon just ONE SECOND before the first occurrence\'s resolved absolute instant is rejected (boundary: strictly after is refused)', (() => {
    const horizonMs = Date.UTC(2026, 0, 19, 14, 59, 59); // 1 second before 2026-01-19T15:00:00Z
    return expectThrowsIcsGenerationError(() =>
      generateCalendarIcs(
        baseInput({
          timezone: 'America/Chicago',
          weekdays: [1],
          localTime: '09:00',
          seriesAnchorMs: Date.UTC(2026, 0, 17, 12, 0, 0),
          recurrenceHorizonMs: horizonMs,
        })
      )
    );
  })());
  check('a DST-adjacent first occurrence (anchor and schedule straddling the spring-forward transition) still resolves and validates correctly against the horizon', (() => {
    // Anchor Friday 2026-03-06 (before the March 8 transition); weekdays=[0] (Sunday only)
    // -> first occurrence Sunday 2026-03-08, AFTER that day's 2am transition (CDT, -0500).
    // 09:00 local Sunday = 2026-03-08T14:00:00Z (using the POST-transition offset).
    const horizonMs = Date.UTC(2026, 2, 8, 14, 0, 0);
    const ics = generateCalendarIcs(
      baseInput({
        timezone: 'America/Chicago',
        weekdays: [0],
        localTime: '09:00',
        seriesAnchorMs: Date.UTC(2026, 2, 6, 12, 0, 0),
        recurrenceHorizonMs: horizonMs,
      })
    );
    return ics.includes('DTSTART;TZID=America/Chicago:20260308T090000');
  })());
  check('Australia/Lord_Howe (30-minute transition): a horizon EXACTLY equal to a post-transition first occurrence is accepted', (() => {
    // Oct 5 2025 is a Sunday; 04:00 local is after that day's 02:00->03:00 (+1030->+1100)
    // transition. 2025-10-05T04:00 Lord_Howe (+11:00) = 2025-10-04T17:00:00Z exactly.
    const horizonMs = Date.UTC(2025, 9, 4, 17, 0, 0);
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'Australia/Lord_Howe', weekdays: [0], localTime: '04:00', seriesAnchorMs: Date.UTC(2025, 9, 1), recurrenceHorizonMs: horizonMs })
    );
    return ics.includes('DTSTART;TZID=Australia/Lord_Howe:20251005T040000') && ics.includes(`UNTIL=${__test__.formatIcsUtcDateTime(horizonMs)}`);
  })());
  check('Australia/Lord_Howe: a horizon one second before that same occurrence is rejected', expectThrowsIcsGenerationError(() =>
    generateCalendarIcs(baseInput({ timezone: 'Australia/Lord_Howe', weekdays: [0], localTime: '04:00', seriesAnchorMs: Date.UTC(2025, 9, 1), recurrenceHorizonMs: Date.UTC(2025, 9, 4, 16, 59, 59) }))
  ));
  check('Pacific/Chatham (positive, quarter-hour offset): a horizon EXACTLY equal to a post-transition first occurrence is accepted', (() => {
    // Anchor Monday 2025-09-22 -> first Sunday is 2025-09-28, after that day's
    // 02:45->03:45 (+1245->+1345) transition. 2025-09-28T05:00 Chatham (+13:45) =
    // 2025-09-27T15:15:00Z exactly.
    const horizonMs = Date.UTC(2025, 8, 27, 15, 15, 0);
    const ics = generateCalendarIcs(
      baseInput({ timezone: 'Pacific/Chatham', weekdays: [0], localTime: '05:00', seriesAnchorMs: Date.UTC(2025, 8, 22), recurrenceHorizonMs: horizonMs })
    );
    return ics.includes('DTSTART;TZID=Pacific/Chatham:20250928T050000') && ics.includes(`UNTIL=${__test__.formatIcsUtcDateTime(horizonMs)}`);
  })());
  check('Pacific/Chatham: a horizon one second before that same occurrence is rejected', expectThrowsIcsGenerationError(() =>
    generateCalendarIcs(baseInput({ timezone: 'Pacific/Chatham', weekdays: [0], localTime: '05:00', seriesAnchorMs: Date.UTC(2025, 8, 22), recurrenceHorizonMs: Date.UTC(2025, 8, 27, 15, 14, 59) }))
  ));
  check('duration crossing UNTIL is NOT incorrectly rejected -- UNTIL bounds occurrence STARTS only, never start+duration', (() => {
    // DTSTART exactly at the horizon (boundary-accepted, per the exact-equality test above),
    // with a 120-minute duration that would extend well PAST the horizon if (incorrectly)
    // factored into the check.
    const horizonMs = Date.UTC(2026, 0, 19, 15, 0, 0);
    const ics = generateCalendarIcs(
      baseInput({
        timezone: 'America/Chicago',
        weekdays: [1],
        localTime: '09:00',
        sessionDurationMinutes: 120,
        seriesAnchorMs: Date.UTC(2026, 0, 17, 12, 0, 0),
        recurrenceHorizonMs: horizonMs,
      })
    );
    return ics.includes('DURATION:PT120M\r\n');
  })());

  console.log('\n=== seriesAnchorMs semantics: target-zone CALENDAR-DATE anchor, not instant floor (Codex repair pass 2, issue 5) ===');
  check('an anchor on a selected weekday AFTER the configured wall time still resolves to that SAME day at the EARLIER configured time (DTSTART can precede the anchor\'s own instant)', (() => {
    // 2026-01-19 is a Monday. Anchor at 10:00 local; schedule configured for Monday 09:00 --
    // strictly EARLIER in wall-clock terms than the anchor itself, on the same calendar date.
    const ics = generateCalendarIcs(
      baseInput({
        timezone: 'America/Chicago',
        weekdays: [1],
        localTime: '09:00',
        seriesAnchorMs: (() => {
          // Construct "2026-01-19 10:00 America/Chicago" precisely via the reviewed
          // resolver, to avoid hand-computing the UTC offset.
          return __test__.localWallTimeToUtcMs(2026, 1, 19, 10, 0, 'America/Chicago');
        })(),
        recurrenceHorizonMs: Date.UTC(2026, 1, 1),
      })
    );
    return ics.includes('DTSTART;TZID=America/Chicago:20260119T090000');
  })());

  console.log('\n=== HORIZON RENEWAL VERSIONING CONTRACT (Codex repair pass 2, issue 4) ===');
  check('a horizon-only renewal (recurrenceHorizonMs advances, revision and updatedAtMs also advance) produces a coherent update: same UID, DTSTART, and BYDAY, but a strictly greater SEQUENCE, a changed DTSTAMP/LAST-MODIFIED, and an extended UNTIL', (() => {
    const before = generateCalendarIcs(baseInput({ eventUid: 'sub_renewal', revision: 5, updatedAtMs: Date.UTC(2026, 0, 1), recurrenceHorizonMs: Date.UTC(2028, 0, 1) }));
    const after = generateCalendarIcs(baseInput({ eventUid: 'sub_renewal', revision: 6, updatedAtMs: Date.UTC(2026, 6, 1), recurrenceHorizonMs: Date.UTC(2032, 0, 1) }));
    const extractUid = (s: string) => s.match(/UID:[^\r]*\r\n/)![0];
    const extractDtstart = (s: string) => s.match(/DTSTART;[^\r]*\r\n/)![0];
    const extractByday = (s: string) => s.match(/BYDAY=[A-Z,]+/)![0];
    const extractSeq = (s: string) => s.match(/SEQUENCE:[^\r]*\r\n/)![0];
    const extractDtstamp = (s: string) => s.match(/DTSTAMP:[^\r]*\r\n/)![0];
    const extractUntil = (s: string) => s.match(/UNTIL=[^;\r]*/)![0];
    return (
      extractUid(before) === extractUid(after) &&
      extractDtstart(before) === extractDtstart(after) &&
      extractByday(before) === extractByday(after) &&
      extractSeq(before) !== extractSeq(after) &&
      extractSeq(after) === 'SEQUENCE:6\r\n' &&
      extractDtstamp(before) !== extractDtstamp(after) &&
      extractUntil(before) !== extractUntil(after)
    );
  })());
  check('unchanged horizon/state (identical inputs including revision/updatedAtMs/recurrenceHorizonMs) remains byte-identical -- no drift from calling the pure function again', (() => {
    const input = baseInput({ eventUid: 'sub_unchanged', revision: 3, updatedAtMs: Date.UTC(2026, 0, 1), recurrenceHorizonMs: Date.UTC(2029, 0, 1) });
    return generateCalendarIcs(input) === generateCalendarIcs({ ...input });
  })());
  // Deliberately NOT tested: "runtime enforcement that rejects a horizon-only change with an
  // UNCHANGED revision/updatedAtMs." Per Codex's explicit instruction, this pure function has
  // no memory of any prior invocation and must not be given one -- the contract that a caller
  // MUST bump revision/updatedAtMs for any material change (including a horizon-only one) is
  // documented on CalendarFeedInput's own field comments (see RECURRENCE LIFETIME's RENEWAL
  // SEMANTICS and the revision/updatedAtMs field comments), not runtime-enforced here.

  console.log('\n=== date-range / boundary validation (Codex repair pass 1, issue 4; refined in repair pass 2, issue 6) ===');
  check('generateCalendarIcs: Number.MAX_SAFE_INTEGER as seriesAnchorMs is REJECTED with IcsGenerationError, not a raw RangeError leak', (() => {
    try {
      generateCalendarIcs(baseInput({ seriesAnchorMs: Number.MAX_SAFE_INTEGER }));
      return false;
    } catch (err) {
      // Must be OUR error type specifically -- a raw RangeError escaping would fail this.
      return err instanceof __test__.IcsGenerationError && !(err instanceof RangeError);
    }
  })());
  check('generateCalendarIcs: Number.MAX_SAFE_INTEGER as recurrenceHorizonMs is rejected the same way', (() => {
    try {
      generateCalendarIcs(baseInput({ recurrenceHorizonMs: Number.MAX_SAFE_INTEGER }));
      return false;
    } catch (err) {
      return err instanceof __test__.IcsGenerationError && !(err instanceof RangeError);
    }
  })());
  check('generateCalendarIcs: NaN as updatedAtMs is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ updatedAtMs: NaN }))));
  check('generateCalendarIcs: Infinity as seriesAnchorMs is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ seriesAnchorMs: Infinity }))));
  check('generateCalendarIcs: one ms BEFORE MIN_SUPPORTED_EPOCH_MS is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ seriesAnchorMs: __test__.MIN_SUPPORTED_EPOCH_MS - 1 }))));
  check('generateCalendarIcs: seriesAnchorMs AT exactly MIN_SUPPORTED_EPOCH_MS is accepted (with a horizon far enough after it)', (() => {
    const ics = generateCalendarIcs(baseInput({ seriesAnchorMs: __test__.MIN_SUPPORTED_EPOCH_MS, recurrenceHorizonMs: __test__.MIN_SUPPORTED_EPOCH_MS + __test__.MIN_RECURRENCE_HORIZON_GAP_MS * 2 }));
    return ics.startsWith('BEGIN:VCALENDAR');
  })());
  check('generateCalendarIcs: one ms AFTER MAX_SUPPORTED_EPOCH_MS is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ recurrenceHorizonMs: __test__.MAX_SUPPORTED_EPOCH_MS + 1 }))));
  check('generateCalendarIcs: recurrenceHorizonMs AT exactly MAX_SUPPORTED_EPOCH_MS is accepted (with an anchor far enough before it)', (() => {
    const ics = generateCalendarIcs(baseInput({ recurrenceHorizonMs: __test__.MAX_SUPPORTED_EPOCH_MS, seriesAnchorMs: __test__.MAX_SUPPORTED_EPOCH_MS - __test__.MIN_RECURRENCE_HORIZON_GAP_MS * 2 }));
    return ics.startsWith('BEGIN:VCALENDAR');
  })());
  check('MAX_SUPPORTED_EPOCH_MS is exactly the LAST millisecond of 2100-12-31 (Codex repair pass 2, issue 6 -- the previous value excluded the final 999ms)', __test__.MAX_SUPPORTED_EPOCH_MS === Date.UTC(2101, 0, 1) - 1);
  check('generateCalendarIcs: recurrenceHorizonMs equal to seriesAnchorMs (zero gap) is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_SERIES_ANCHOR_MS }))));
  check('generateCalendarIcs: recurrenceHorizonMs BEFORE seriesAnchorMs is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_SERIES_ANCHOR_MS - 1000 }))));
  check('generateCalendarIcs: one ms BELOW MIN_RECURRENCE_HORIZON_GAP_MS is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_SERIES_ANCHOR_MS + __test__.MIN_RECURRENCE_HORIZON_GAP_MS - 1 }))));
  check('generateCalendarIcs: EXACTLY MIN_RECURRENCE_HORIZON_GAP_MS is accepted (the minimum valid gap)', (() => {
    // DEFAULT_SERIES_ANCHOR_MS is a Thursday (weekday 4); using weekdays=[4] (matching the
    // anchor's own weekday) means the first occurrence falls on the anchor's own calendar
    // date (dayOffset 0), comfortably inside a minimum one-day horizon.
    const ics = generateCalendarIcs(baseInput({ weekdays: [4], localTime: '00:00', seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_SERIES_ANCHOR_MS + __test__.MIN_RECURRENCE_HORIZON_GAP_MS }));
    return ics.startsWith('BEGIN:VCALENDAR');
  })());
  check('generateCalendarIcs: EXACTLY MAX_RECURRENCE_HORIZON_SPAN_MS is accepted (the maximum valid span)', (() => {
    const ics = generateCalendarIcs(baseInput({ seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_SERIES_ANCHOR_MS + __test__.MAX_RECURRENCE_HORIZON_SPAN_MS }));
    return ics.startsWith('BEGIN:VCALENDAR');
  })());
  check('generateCalendarIcs: one ms ABOVE MAX_RECURRENCE_HORIZON_SPAN_MS is rejected', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_SERIES_ANCHOR_MS + __test__.MAX_RECURRENCE_HORIZON_SPAN_MS + 1 }))));
  check('MAX_RECURRENCE_HORIZON_SPAN_MS is documented as a fixed-day (not calendar-year) approximation: exactly 3660 * DAY_MS', __test__.MAX_RECURRENCE_HORIZON_SPAN_MS === 3660 * DAY_MS_FOR_TEST);
  check('leap-year boundary: a seriesAnchorMs of Feb 29 on a leap year resolves a first occurrence correctly and does not throw', (() => {
    // 2028-02-29 is a Tuesday.
    const ics = generateCalendarIcs(baseInput({ weekdays: [2], localTime: '08:00', seriesAnchorMs: Date.UTC(2028, 1, 29, 12, 0, 0), recurrenceHorizonMs: Date.UTC(2028, 2, 3) }));
    return ics.includes('DTSTART;TZID=America/Chicago:20280229T080000');
  })());
  check('leap-year boundary: a horizon spanning across Feb 29 of a leap year does not corrupt transition scanning (America/Chicago spring transition still found)', (() => {
    const ics = generateCalendarIcs(baseInput({ timezone: 'America/Chicago', seriesAnchorMs: Date.UTC(2028, 0, 1), recurrenceHorizonMs: Date.UTC(2028, 3, 1) }));
    return ics.includes('20280312'); // 2028 spring-forward is the second Sunday of March = March 12.
  })());
  check('requireRfcRepresentableYear: rejects year 0 and year 10000 directly', expectThrowsIcsGenerationError(() => __test__.requireRfcRepresentableYear(0)) && expectThrowsIcsGenerationError(() => __test__.requireRfcRepresentableYear(10000)));
  check('requireRfcRepresentableYear: accepts a normal 4-digit year', __test__.requireRfcRepresentableYear(2026) === 2026);

  console.log('\n=== transition scanning/classification domain assumptions (Codex repair pass 1, issue 5) ===');
  check('findTransitionsInWindow: daily sampling correctly finds exactly the 2 annual transitions for a standard DST zone across a 1-year window', __test__.findTransitionsInWindow(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), 'America/Chicago').length === 2);
  check('findTransitionsInWindow: a fixed-offset zone (America/Phoenix) finds zero transitions across the same window', __test__.findTransitionsInWindow(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), 'America/Phoenix').length === 0);
  check('groupTransitionsIntoComponents: classification is symmetric -- the DAYLIGHT component\'s TZOFFSETTO equals the STANDARD component\'s TZOFFSETFROM, and vice versa, for a simple two-offset zone', (() => {
    const transitions = __test__.findTransitionsInWindow(Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1), 'America/Chicago');
    const components = __test__.groupTransitionsIntoComponents(transitions);
    const daylight = components.find((c) => c.type === 'DAYLIGHT')!;
    const standard = components.find((c) => c.type === 'STANDARD')!;
    return daylight.tzOffsetToMs === standard.tzOffsetFromMs && standard.tzOffsetToMs === daylight.tzOffsetFromMs;
  })());
  check('SUPPORTED DOMAIN: MIN_SUPPORTED_EPOCH_MS corresponds to exactly 2020-01-01T00:00:00.000Z (documented, not silently arbitrary)', __test__.MIN_SUPPORTED_EPOCH_MS === Date.UTC(2020, 0, 1));
  check('SUPPORTED DOMAIN: MAX_SUPPORTED_EPOCH_MS corresponds to exactly 2100-12-31T23:59:59.999Z, the TRUE last millisecond of that day (not the previous, off-by-999ms value)', __test__.MAX_SUPPORTED_EPOCH_MS === Date.UTC(2101, 0, 1) - 1);
  check('no internal calculation derives a date more than DST_BRACKET_WINDOW_MS (36h) before the documented MIN_SUPPORTED_EPOCH_MS floor: seriesAnchorMs at exactly the floor, with a first occurrence on the anchor\'s own day, generates without error (the DTSTART<=horizon resolver\'s 36h bracket probe is the one documented, bounded exception to the domain floor -- see DTSTART <= UNTIL ENFORCEMENT\'s header comment)', (() => {
    const anchor = __test__.MIN_SUPPORTED_EPOCH_MS; // 2020-01-01T00:00:00.000Z is a Wednesday.
    const ics = generateCalendarIcs(baseInput({ weekdays: [3], localTime: '00:00', seriesAnchorMs: anchor, recurrenceHorizonMs: anchor + __test__.MIN_RECURRENCE_HORIZON_GAP_MS * 2 }));
    return ics.startsWith('BEGIN:VCALENDAR');
  })());

  console.log('\n=== injection resistance ===');
  for (const bad of ['America/Chicago\r\nX-INJECTED:evil', 'America/Chicago:evil', 'America/Chicago;evil', 'not a zone at all']) {
    check(`generateCalendarIcs: rejects an injection-shaped timezone value ${JSON.stringify(bad)}`, expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ timezone: bad }))));
  }
  check('injection resistance: no CR or LF character appears anywhere in the output OTHER than as part of a CRLF line terminator', (() => {
    const ics = generateCalendarIcs(baseInput());
    const stripped = ics.split('\r\n').join('');
    return !stripped.includes('\r') && !stripped.includes('\n');
  })());
  check('injection resistance: an eventUid cannot inject a colon-delimited fake property (rejected outright by EVENT_UID_PATTERN)', expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput({ eventUid: 'evil:X-INJECTED' }))));

  console.log('\n=== determinism ===');
  check('determinism: identical input twice produces byte-for-byte identical output', (() => {
    const input = baseInput();
    return generateCalendarIcs(input) === generateCalendarIcs(input);
  })());
  check('determinism: two independently-constructed but semantically-identical inputs produce byte-for-byte identical output', (() => {
    const build = () => ({ eventUid: 'sub_x', weekdays: [2], localTime: '10:00', timezone: 'UTC', sessionDurationMinutes: 45, revision: 3, updatedAtMs: 1700000000000, seriesAnchorMs: DEFAULT_SERIES_ANCHOR_MS, recurrenceHorizonMs: DEFAULT_RECURRENCE_HORIZON_MS });
    return generateCalendarIcs(build()) === generateCalendarIcs(build());
  })());

  console.log('\n=== input validation matrix ===');
  for (const [label, overrides] of Object.entries({
    'localTime malformed': { localTime: '25:99' },
    'weekdays out of range': { weekdays: [7] },
    'weekdays duplicate': { weekdays: [1, 1] },
    'revision fractional': { revision: 1.5 },
    'revision negative': { revision: -1 },
  })) {
    check(`generateCalendarIcs: rejects ${label}`, expectThrowsIcsGenerationError(() => generateCalendarIcs(baseInput(overrides as Partial<CalendarFeedInput>))));
  }

  console.log('\n=== STATIC SCOPE / PURITY AUDIT ===');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const srcPath = path.join(__dirname, '..', 'src', 'calendarIcsGenerator.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  check('no Date.now() call anywhere in this file', !/Date\.now\s*\(/.test(stripped));
  check('no Math.random() call anywhere in this file', !/Math\.random\s*\(/.test(stripped));
  check('no import from firebase-admin or firebase-functions anywhere in this file', !/from\s+'firebase-admin|from\s+'firebase-functions/.test(stripped));
  check('no reference to notificationPreferences/reminder/notification-rollout state', !/notificationPreferences|notificationRollout|reminderDelivery|reminderScheduler/i.test(stripped));
  check('no reference to course-progress state (dnsCourse/currentDay/entitlement)', !/dnsCourse|currentDay|dnsEntitlement/i.test(stripped));
  check('no import from calendarSubscriptions.ts or calendarPreferences.ts (Stage 1/2 are not referenced, let alone modified)', !/from '\.\/calendarSubscriptions'|from '\.\/calendarPreferences'/.test(stripped));
  check('no import from any first-real-send-experiment module', !/first-real-send/i.test(stripped));
  check('no onCall/onSchedule/Auth-trigger Cloud Function export (pure library only)', !/\bonCall\s*\(|\bonSchedule\s*\(|\.auth\.user\(\)\.onDelete\(/.test(stripped));
  check('no reference to Firebase Auth, App Check, or a bearer/network endpoint concept', !/getAuth\(|enforceAppCheck|fetch\(|http\.|https\.request/i.test(stripped));
  check('the output for a realistic input contains no obviously secret-shaped substring (long hex run) beyond the validated eventUid itself', (() => {
    const ics = generateCalendarIcs(baseInput({ eventUid: 'sub_test0001' }));
    return !/[a-f0-9]{32,}/i.test(ics.replace(/UID:[^\r]*\r\n/, ''));
  })());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
}
