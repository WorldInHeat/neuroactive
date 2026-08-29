// Calendar Integration Phase 1, Stage 3 adapter tests.
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import {
  buildCalendarFeedInput,
  CalendarFeedAdapterError,
  __test__,
} from './calendarFeedAdapter';
import type { CalendarPreferenceData, CalendarSubscriptionMetadata } from './calendarFeedAdapter';
import { generateCalendarIcs } from './calendarIcsGenerator';

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean): void {
  if (condition) {
    console.log('PASS  ' + label);
    pass++;
  } else {
    console.log('FAIL  ' + label);
    fail++;
  }
}

function rejects(subscription: unknown, preferences: unknown): boolean {
  try {
    buildCalendarFeedInput(subscription, preferences);
    return false;
  } catch (error) {
    return error instanceof CalendarFeedAdapterError;
  }
}

const anchor = Date.UTC(2026, 0, 15, 12);
const validSubscriptionId = 'A1b2C3d4E5f6G7h8I9j0';
const subscription = (overrides: Partial<CalendarSubscriptionMetadata> = {}): CalendarSubscriptionMetadata => ({
  subscriptionId: validSubscriptionId,
  createdAtMs: anchor,
  ...overrides,
});
const preferences = (overrides: Partial<CalendarPreferenceData> = {}): CalendarPreferenceData => ({
  weekdays: [1, 3, 5],
  localTime: '18:30',
  timezone: 'America/Chicago',
  sessionDurationMinutes: 30,
  revision: 4,
  updatedAtMs: Date.UTC(2026, 1, 1, 12),
  ...overrides,
});

const happy = buildCalendarFeedInput(subscription(), preferences());
check('happy path maps the complete generator input',
  happy.eventUid === validSubscriptionId &&
  happy.seriesAnchorMs === anchor &&
  happy.weekdays.join(',') === '1,3,5' &&
  happy.localTime === '18:30' &&
  happy.timezone === 'America/Chicago' &&
  happy.sessionDurationMinutes === 30 &&
  happy.revision === 4 &&
  happy.updatedAtMs === Date.UTC(2026, 1, 1, 12));
check('event UID is stable across preference edits',
  buildCalendarFeedInput(subscription(), preferences({ revision: 5, localTime: '07:15' })).eventUid === happy.eventUid);
check('series anchor is immutable across preference edits',
  buildCalendarFeedInput(subscription(), preferences({ revision: 5, weekdays: [2, 4] })).seriesAnchorMs === anchor);
check('horizon is exactly 3,650 fixed days after the anchor',
  happy.recurrenceHorizonMs === anchor + 3650 * 24 * 60 * 60 * 1000);
check('horizon is deterministic for identical subscription metadata',
  buildCalendarFeedInput(subscription(), preferences({ revision: 9 })).recurrenceHorizonMs === happy.recurrenceHorizonMs);
check('schedule edits propagate without changing identity or anchor', (() => {
  const changed = buildCalendarFeedInput(subscription(), preferences({ weekdays: [0, 6], localTime: '09:00', timezone: 'America/New_York', sessionDurationMinutes: 45, revision: 5 }));
  return changed.weekdays.join(',') === '0,6' && changed.localTime === '09:00' && changed.timezone === 'America/New_York' && changed.sessionDurationMinutes === 45 && changed.eventUid === happy.eventUid && changed.seriesAnchorMs === happy.seriesAnchorMs;
})());
check('revision propagates exactly', buildCalendarFeedInput(subscription(), preferences({ revision: 17 })).revision === 17);
check('preference updated before subscription -> representation updatedAt uses subscription creation', (() => {
  const mapped = buildCalendarFeedInput(subscription(), preferences({ updatedAtMs: anchor - 1 }));
  return mapped.updatedAtMs === anchor && generateCalendarIcs(mapped).includes('DTSTAMP:20260115T120000Z\r\n');
})());
check('preference updated after subscription -> representation updatedAt uses preference update', (() => {
  const later = anchor + 123456;
  const mapped = buildCalendarFeedInput(subscription(), preferences({ updatedAtMs: later }));
  return mapped.updatedAtMs === later && generateCalendarIcs(mapped).includes('DTSTAMP:20260115T120203Z\r\n');
})());
check('equal subscription/preference timestamps -> representation updatedAt remains equal', (() => {
  const mapped = buildCalendarFeedInput(subscription(), preferences({ updatedAtMs: anchor }));
  return mapped.updatedAtMs === anchor && generateCalendarIcs(mapped).includes('DTSTAMP:20260115T120000Z\r\n');
})());
check('returned weekdays are detached from caller input', (() => {
  const source = preferences();
  const mapped = buildCalendarFeedInput(subscription(), source);
  source.weekdays[0] = 6;
  return mapped.weekdays.join(',') === '1,3,5';
})());
check('happy-path adapter output is accepted unchanged by the existing generator',
  generateCalendarIcs(happy).includes(`UID:${validSubscriptionId}@neuroactivehealth.com\r\n`));

for (const [label, value] of [
  ['missing metadata', undefined],
  ['missing subscription ID', { createdAtMs: anchor }],
  ['empty subscription ID', subscription({ subscriptionId: '' })],
  ['unsafe subscription ID', subscription({ subscriptionId: 'bad\r\nUID:evil' })],
  ['19-character subscription ID', subscription({ subscriptionId: 'a'.repeat(19) })],
  ['21-character subscription ID', subscription({ subscriptionId: 'a'.repeat(21) })],
  ['subscription ID containing underscore', subscription({ subscriptionId: 'A1b2C3d4E5f6G7h8I9_0' })],
  ['subscription ID containing hyphen', subscription({ subscriptionId: 'A1b2C3d4E5f6G7h8I9-0' })],
  ['subscription ID containing dot', subscription({ subscriptionId: 'A1b2C3d4E5f6G7h8I9.0' })],
  ['raw bearer-secret-shaped base64url ID', subscription({ subscriptionId: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-ABCDE' })],
  ['missing creation timestamp', { subscriptionId: validSubscriptionId }],
  ['non-integer creation timestamp', subscription({ createdAtMs: anchor + 0.5 })],
  ['Firestore-shaped creation timestamp', { subscriptionId: validSubscriptionId, createdAtMs: { seconds: 1, nanoseconds: 0 } }],
  ['extra subscription field', { ...subscription(), uid: 'forbidden' }],
] as const) check('rejects malformed subscription metadata: ' + label, rejects(value, preferences()));

for (const [label, value] of [
  ['missing preferences', undefined],
  ['empty weekdays', preferences({ weekdays: [] })],
  ['out-of-range weekday', preferences({ weekdays: [1, 7] })],
  ['duplicate weekdays', preferences({ weekdays: [1, 1] })],
  ['unsorted weekdays', preferences({ weekdays: [5, 1] })],
  ['malformed local time', preferences({ localTime: '9:00' })],
  ['invalid timezone', preferences({ timezone: 'Mars/Olympus' })],
  ['noncanonical timezone alias', preferences({ timezone: 'US/Central' })],
  ['duration below range', preferences({ sessionDurationMinutes: 4 })],
  ['fractional duration', preferences({ sessionDurationMinutes: 30.5 })],
  ['revision zero', preferences({ revision: 0 })],
  ['revision above ICS maximum', preferences({ revision: 2147483648 })],
  ['malformed update timestamp', preferences({ updatedAtMs: Number.NaN })],
  ['extra preference field', { ...preferences(), enabled: true }],
] as const) check('rejects malformed preference data: ' + label, rejects(subscription(), value));

check('accepts the minimum supported anchor when its fixed horizon fits',
  buildCalendarFeedInput(subscription({ createdAtMs: __test__.MIN_SUPPORTED_EPOCH_MS }), preferences({ updatedAtMs: __test__.MIN_SUPPORTED_EPOCH_MS })).seriesAnchorMs === __test__.MIN_SUPPORTED_EPOCH_MS);
check('generator accepts adapter output at the minimum supported anchor', (() => {
  const mapped = buildCalendarFeedInput(subscription({ createdAtMs: __test__.MIN_SUPPORTED_EPOCH_MS }), preferences({ updatedAtMs: __test__.MIN_SUPPORTED_EPOCH_MS }));
  return generateCalendarIcs(mapped).includes(`UID:${validSubscriptionId}@neuroactivehealth.com\r\n`);
})());
check('rejects an anchor below the supported domain', rejects(subscription({ createdAtMs: __test__.MIN_SUPPORTED_EPOCH_MS - 1 }), preferences()));
check('rejects an anchor whose fixed horizon overflows the supported domain', rejects(subscription({ createdAtMs: __test__.MAX_SUPPORTED_EPOCH_MS }), preferences({ updatedAtMs: __test__.MAX_SUPPORTED_EPOCH_MS })));
check('rejects an update timestamp beyond the supported domain', rejects(subscription(), preferences({ updatedAtMs: __test__.MAX_SUPPORTED_EPOCH_MS + 1 })));
check('accepts preference update time after recurrence horizon and propagates it', (() => {
  const afterHorizon = anchor + __test__.FIXED_HORIZON_MS + 1;
  return buildCalendarFeedInput(subscription(), preferences({ updatedAtMs: afterHorizon })).updatedAtMs === afterHorizon;
})());
check('accepts the exact latest anchor whose fixed horizon stays in the supported domain', (() => {
  const latestAnchor = __test__.MAX_SUPPORTED_EPOCH_MS - __test__.FIXED_HORIZON_MS;
  const mapped = buildCalendarFeedInput(subscription({ createdAtMs: latestAnchor }), preferences({ updatedAtMs: latestAnchor }));
  return mapped.seriesAnchorMs === latestAnchor && mapped.recurrenceHorizonMs === __test__.MAX_SUPPORTED_EPOCH_MS;
})());
check('rejects the first anchor beyond the latest supported fixed-horizon boundary', (() => {
  const firstInvalidAnchor = __test__.MAX_SUPPORTED_EPOCH_MS - __test__.FIXED_HORIZON_MS + 1;
  return rejects(subscription({ createdAtMs: firstInvalidAnchor }), preferences({ updatedAtMs: firstInvalidAnchor }));
})());
check('accepts minimum duration', buildCalendarFeedInput(subscription(), preferences({ sessionDurationMinutes: 5 })).sessionDurationMinutes === 5);
check('accepts maximum duration', buildCalendarFeedInput(subscription(), preferences({ sessionDurationMinutes: 120 })).sessionDurationMinutes === 120);
check('accepts maximum ICS revision', buildCalendarFeedInput(subscription(), preferences({ revision: 2147483647 })).revision === 2147483647);
check('fixed policy stays below the generator maximum of 3,660 days', __test__.FIXED_HORIZON_DAYS === 3650 && __test__.FIXED_HORIZON_DAYS < 3660);

check('output contains only the CalendarFeedInput fields',
  Object.keys(happy).sort().join(',') === ['eventUid', 'localTime', 'recurrenceHorizonMs', 'revision', 'seriesAnchorMs', 'sessionDurationMinutes', 'timezone', 'updatedAtMs', 'weekdays'].sort().join(','));
check('forbidden extra fields fail closed instead of leaking into output',
  rejects({ ...subscription(), secret: 'raw' }, preferences()) && rejects(subscription(), { ...preferences(), secretHash: 'hash' }));

const sourcePath = path.join(__dirname, '..', 'src', 'calendarFeedAdapter.ts');
const source = fs.readFileSync(sourcePath, 'utf8');
const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
check('adapter has no Firebase Admin, Firestore, or Auth dependency', !/firebase-admin|firebase-functions|Firestore|getAuth|onCall|onRequest/.test(executable));
check('adapter has no notification or reminder dependency', !/notificationPreferences|notificationRollout|reminderScheduler|reminderDelivery|pushInstallations|pushTokenClaims|firstRealSend/i.test(executable));
check('adapter has no DNS course or entitlement dependency', !/dnsCourse|DNS_COURSE|dnsEntitlement|hasDnsEntitlement/i.test(executable));
check('adapter has no HTTP request/response dependency', !/Request|Response|express|https?:\/\//.test(executable));
check('adapter imports only the generator type', (() => {
  const imports = executable.match(/^import[^;]+;/gm) ?? [];
  return imports.length === 1 && /import type \{ CalendarFeedInput \} from '\.\/calendarIcsGenerator';/.test(imports[0]);
})());
check('public input types accept no raw credential, hash, uid, email, auth, course, or notification fields', (() => {
  const typeRegion = source.slice(source.indexOf('export type CalendarSubscriptionMetadata'), source.indexOf('export class CalendarFeedAdapterError'));
  return !/secret|hash|uid|email|auth|course|notification|reminder|video/i.test(typeRegion);
})());

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
