// Calendar Integration Phase 1, Stage 3 adapter.
//
// Pure translation only: callers must authorize and load the two records before invoking
// this module. It deliberately has no Firebase, HTTP, entitlement, course, reminder, or
// notification responsibility. The generator remains the sole ICS serializer.
'use strict';

import type { CalendarFeedInput } from './calendarIcsGenerator';

export type CalendarSubscriptionMetadata = {
  subscriptionId: string;
  createdAtMs: number;
};

export type CalendarPreferenceData = {
  weekdays: number[];
  localTime: string;
  timezone: string;
  sessionDurationMinutes: number;
  revision: number;
  updatedAtMs: number;
};

export class CalendarFeedAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CalendarFeedAdapterError';
  }
}

const SUBSCRIPTION_KEYS = ['subscriptionId', 'createdAtMs'] as const;
const PREFERENCE_KEYS = [
  'weekdays',
  'localTime',
  'timezone',
  'sessionDurationMinutes',
  'revision',
  'updatedAtMs',
] as const;
// Duplicated deliberately instead of importing calendarSubscriptions.ts: that module is
// Firebase-dependent, while this adapter must remain pure. Stage 1 allocates Firestore
// auto-IDs with exactly this 20-character alphanumeric shape, so accepting the generator's
// broader eventUid grammar here would admit identities Stage 1 can never create.
const STAGE_1_SUBSCRIPTION_ID_PATTERN = /^[A-Za-z0-9]{20}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MIN_DURATION_MINUTES = 5;
const MAX_DURATION_MINUTES = 120;
const MAX_ICS_SEQUENCE = 2147483647;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_HORIZON_DAYS = 3650;
const FIXED_HORIZON_MS = FIXED_HORIZON_DAYS * DAY_MS;
const MIN_SUPPORTED_EPOCH_MS = Date.UTC(2020, 0, 1);
const MAX_SUPPORTED_EPOCH_MS = Date.UTC(2101, 0, 1) - 1;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactKeys(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) throw new CalendarFeedAdapterError(`${label} must be a plain object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new CalendarFeedAdapterError(`${label} must contain exactly: ${keys.join(', ')}.`);
  }
  return value;
}

function requireEpochMs(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new CalendarFeedAdapterError(`${label} must be an integer epoch-millisecond value.`);
  }
  if (value < MIN_SUPPORTED_EPOCH_MS || value > MAX_SUPPORTED_EPOCH_MS) {
    throw new CalendarFeedAdapterError(`${label} is outside the supported 2020-2100 domain.`);
  }
  return value;
}

function requireCanonicalWeekdays(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new CalendarFeedAdapterError('weekdays must be a non-empty array.');
  }
  if (!value.every((day) => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)) {
    throw new CalendarFeedAdapterError('weekdays must contain only integers 0-6.');
  }
  for (let index = 1; index < value.length; index++) {
    if (value[index] <= value[index - 1]) {
      throw new CalendarFeedAdapterError('weekdays must be strictly ascending with no duplicates.');
    }
  }
  return [...value] as number[];
}

function requireCanonicalTimezone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CalendarFeedAdapterError('timezone must be a non-empty string.');
  }
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new CalendarFeedAdapterError('timezone must be a recognized IANA timezone.');
  }
  if (canonical !== value) throw new CalendarFeedAdapterError('timezone must be canonical.');
  return value;
}

/**
 * Maps already-authorized, already-loaded calendar state into the generator contract.
 *
 * Horizon policy: exactly 3,650 fixed 24-hour days after the immutable subscription
 * creation instant. This is deterministic, remains below the generator's 3,660-day cap,
 * and needs no renewable representation state. Consequently preference revision and
 * updatedAt remain valid representation version fields for this non-renewing milestone.
 */
export function buildCalendarFeedInput(
  subscriptionInput: unknown,
  preferenceInput: unknown
): CalendarFeedInput {
  const subscription = requireExactKeys(subscriptionInput, SUBSCRIPTION_KEYS, 'subscription metadata');
  const preferences = requireExactKeys(preferenceInput, PREFERENCE_KEYS, 'calendar preferences');

  if (
    typeof subscription.subscriptionId !== 'string' ||
    !STAGE_1_SUBSCRIPTION_ID_PATTERN.test(subscription.subscriptionId)
  ) {
    throw new CalendarFeedAdapterError('subscriptionId must be a Stage 1 20-character alphanumeric identifier.');
  }
  const seriesAnchorMs = requireEpochMs(subscription.createdAtMs, 'createdAtMs');
  const recurrenceHorizonMs = seriesAnchorMs + FIXED_HORIZON_MS;
  if (!Number.isSafeInteger(recurrenceHorizonMs) || recurrenceHorizonMs > MAX_SUPPORTED_EPOCH_MS) {
    throw new CalendarFeedAdapterError('The fixed recurrence horizon exceeds the supported date domain.');
  }

  const weekdays = requireCanonicalWeekdays(preferences.weekdays);
  if (typeof preferences.localTime !== 'string' || !TIME_PATTERN.test(preferences.localTime)) {
    throw new CalendarFeedAdapterError('localTime must use strict 24-hour HH:MM format.');
  }
  const timezone = requireCanonicalTimezone(preferences.timezone);
  if (
    typeof preferences.sessionDurationMinutes !== 'number' ||
    !Number.isInteger(preferences.sessionDurationMinutes) ||
    preferences.sessionDurationMinutes < MIN_DURATION_MINUTES ||
    preferences.sessionDurationMinutes > MAX_DURATION_MINUTES
  ) {
    throw new CalendarFeedAdapterError('sessionDurationMinutes must be an integer from 5 through 120.');
  }
  if (
    typeof preferences.revision !== 'number' ||
    !Number.isSafeInteger(preferences.revision) ||
    preferences.revision < 1 ||
    preferences.revision > MAX_ICS_SEQUENCE
  ) {
    throw new CalendarFeedAdapterError('revision must be an ICS-compatible positive integer.');
  }
  const preferenceUpdatedAtMs = requireEpochMs(preferences.updatedAtMs, 'updatedAtMs');
  // This selects the modification time of the per-subscription ICS representation; it does
  // not alter or reinterpret the persisted preference timestamp. A representation carrying
  // this subscription-scoped identity cannot predate the subscription itself.
  const representationUpdatedAtMs = Math.max(seriesAnchorMs, preferenceUpdatedAtMs);

  return {
    eventUid: subscription.subscriptionId,
    weekdays,
    localTime: preferences.localTime,
    timezone,
    sessionDurationMinutes: preferences.sessionDurationMinutes,
    revision: preferences.revision,
    updatedAtMs: representationUpdatedAtMs,
    seriesAnchorMs,
    recurrenceHorizonMs,
  };
}

export const __test__ = {
  FIXED_HORIZON_DAYS,
  FIXED_HORIZON_MS,
  MIN_SUPPORTED_EPOCH_MS,
  MAX_SUPPORTED_EPOCH_MS,
};
