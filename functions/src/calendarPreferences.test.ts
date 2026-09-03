// functions/src/calendarPreferences.test.ts
// Calendar Integration Phase 1, Stage 2 tests.
//
// IMPORTANT CAVEAT, stated explicitly rather than implied: the `firebase` CLI is not
// available in this environment, so these are NOT real Firebase emulator tests. These
// tests exercise the db-parameterized "Core" function (see calendarPreferences.ts's own
// header on this testing seam) against a minimal FAKE Firestore, matching the pattern
// already used in calendarSubscriptions.test.ts / reminderDeliveryWorker.test.ts for the
// same reason (no live emulator dependency for fast unit-level coverage). This fake is
// deliberately SIMPLER than calendarSubscriptions.test.ts's — updateCalendarPreferencesCore
// only ever reads and writes a single fixed document path (no collection queries), so no
// collection/where/batch support is implemented here at all. Real emulator/rules
// verification is still recommended before this stage is considered fully verified — see
// the final report's open questions.
//
// Codex repair pass 1: the fake's resolveWrite now converts a serverTimestamp()-shaped
// sentinel into a GENUINE firebase-admin `Timestamp` instance (via Timestamp.now()) rather
// than a fake marker object — this is what a real Firestore read-back of
// FieldValue.serverTimestamp() actually produces, and it is required for round-trips
// through updateCalendarPreferencesCore to satisfy calendarPreferences.ts's new strict
// `data.updatedAt instanceof Timestamp` check on any subsequent read.
'use strict';

import { Timestamp } from 'firebase-admin/firestore';
import { updateCalendarPreferencesCore, __test__ } from './calendarPreferences';

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
async function checkAsync(label: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(label, await fn());
  } catch (err) {
    check(label, false, 'threw: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------------------
// MINIMAL FAKE FIRESTORE — single-document get/set only (see file header above for why no
// collection/query/batch support is needed for this file's Core function).
// ---------------------------------------------------------------------------------------
type DocData = Record<string, unknown>;

function looksLikeFirestoreSentinel(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as { isEqual?: unknown }).isEqual === 'function';
}
function resolveWrite(data: DocData): DocData {
  const out: DocData = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = looksLikeFirestoreSentinel(v) ? Timestamp.now() : v;
  }
  return out;
}

class FakeDocRef {
  constructor(
    private store: Map<string, DocData>,
    public path: string
  ) {}
  async get() {
    const exists = this.store.has(this.path);
    const data = exists ? { ...this.store.get(this.path)! } : undefined;
    return { exists, ref: this, data: () => data };
  }
}

function makeFakeDb() {
  const store = new Map<string, DocData>();
  const db = {
    doc(path: string) {
      return new FakeDocRef(store, path);
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async get(ref: FakeDocRef) {
          return ref.get();
        },
        set(ref: FakeDocRef, data: DocData) {
          store.set(ref.path, resolveWrite(data));
        },
      };
      return fn(tx);
    },
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, store };
}

async function main() {
  const APP_ID = __test__.APP_ID;
  const prefsPath = (uid: string) => `artifacts/${APP_ID}/users/${uid}/calendarPreferences/main`;
  const validInput = (overrides: Partial<Record<string, unknown>> = {}) => ({
    weekdays: [1, 3, 5],
    localTime: '07:30',
    timezone: 'America/Chicago',
    sessionDurationMinutes: 20,
    expectedRevision: 0,
    ...overrides,
  });

  console.log('\n=== pure helpers: weekdays ===');
  check('requireWeekdays: accepts a valid combination, returns canonical ascending order', (() => {
    const result = __test__.requireWeekdays([5, 1, 3]);
    return JSON.stringify(result) === JSON.stringify([1, 3, 5]);
  })());
  check('requireWeekdays: accepts all seven days', (() => {
    const result = __test__.requireWeekdays([6, 0, 3, 1, 5, 2, 4]);
    return JSON.stringify(result) === JSON.stringify([0, 1, 2, 3, 4, 5, 6]);
  })());
  check('requireWeekdays: accepts a single day', (() => {
    const result = __test__.requireWeekdays([0]);
    return JSON.stringify(result) === JSON.stringify([0]);
  })());
  check('requireWeekdays: rejects an empty array', (() => {
    try {
      __test__.requireWeekdays([]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireWeekdays: rejects a non-array', (() => {
    try {
      __test__.requireWeekdays('monday');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireWeekdays: rejects an out-of-range value (7)', (() => {
    try {
      __test__.requireWeekdays([7]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireWeekdays: rejects a negative value (-1)', (() => {
    try {
      __test__.requireWeekdays([-1]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireWeekdays: rejects a fractional value (1.5)', (() => {
    try {
      __test__.requireWeekdays([1.5]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireWeekdays: rejects a non-numeric entry', (() => {
    try {
      __test__.requireWeekdays(['1']);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireWeekdays: rejects duplicates', (() => {
    try {
      __test__.requireWeekdays([1, 1, 3]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());

  console.log('\n=== pure helpers: localTime ===');
  check('requireLocalTime: accepts 00:00', __test__.requireLocalTime('00:00') === '00:00');
  check('requireLocalTime: accepts 23:59', __test__.requireLocalTime('23:59') === '23:59');
  check('requireLocalTime: accepts 07:30', __test__.requireLocalTime('07:30') === '07:30');
  for (const bad of ['7:30', '24:00', '12:60', '12:5', 'noon', '', '12:30:00', ' 12:30', '12:30 ']) {
    check(`requireLocalTime: rejects malformed value ${JSON.stringify(bad)}`, (() => {
      try {
        __test__.requireLocalTime(bad);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'invalid-argument';
      }
    })());
  }
  check('requireLocalTime: rejects a non-string', (() => {
    try {
      __test__.requireLocalTime(730);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());

  console.log('\n=== pure helpers: timezone ===');
  check('requireTimezone: accepts and canonicalizes America/Chicago', __test__.requireTimezone('America/Chicago') === 'America/Chicago');
  check('requireTimezone: accepts UTC', __test__.requireTimezone('UTC') === 'UTC');
  check('requireTimezone: accepts Asia/Tokyo', __test__.requireTimezone('Asia/Tokyo') === 'Asia/Tokyo');
  check('requireTimezone: rejects a bogus zone string', (() => {
    try {
      __test__.requireTimezone('Not/A_Real_Zone');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireTimezone: rejects an empty string', (() => {
    try {
      __test__.requireTimezone('');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireTimezone: rejects a non-string', (() => {
    try {
      __test__.requireTimezone(5);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireTimezone: never silently substitutes UTC for an invalid zone (throws, does not fall back)', (() => {
    try {
      __test__.requireTimezone('Definitely/Invalid');
      return false; // must have thrown, not returned 'UTC' or anything else
    } catch {
      return true;
    }
  })());

  console.log('\n=== pure helpers: sessionDurationMinutes ===');
  check('requireSessionDurationMinutes: accepts the lower bound', __test__.requireSessionDurationMinutes(__test__.MIN_SESSION_DURATION_MINUTES) === __test__.MIN_SESSION_DURATION_MINUTES);
  check('requireSessionDurationMinutes: accepts the upper bound', __test__.requireSessionDurationMinutes(__test__.MAX_SESSION_DURATION_MINUTES) === __test__.MAX_SESSION_DURATION_MINUTES);
  check('requireSessionDurationMinutes: accepts a mid-range value', __test__.requireSessionDurationMinutes(20) === 20);
  check('requireSessionDurationMinutes: rejects one below the lower bound', (() => {
    try {
      __test__.requireSessionDurationMinutes(__test__.MIN_SESSION_DURATION_MINUTES - 1);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireSessionDurationMinutes: rejects one above the upper bound', (() => {
    try {
      __test__.requireSessionDurationMinutes(__test__.MAX_SESSION_DURATION_MINUTES + 1);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireSessionDurationMinutes: rejects zero', (() => {
    try {
      __test__.requireSessionDurationMinutes(0);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireSessionDurationMinutes: rejects a negative value', (() => {
    try {
      __test__.requireSessionDurationMinutes(-5);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireSessionDurationMinutes: rejects a fractional value', (() => {
    try {
      __test__.requireSessionDurationMinutes(20.5);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireSessionDurationMinutes: rejects a non-number', (() => {
    try {
      __test__.requireSessionDurationMinutes('20');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());

  console.log('\n=== pure helpers: requireNonAnonymousAuth ===');
  check('requireNonAnonymousAuth: no auth -> unauthenticated', (() => {
    try {
      __test__.requireNonAnonymousAuth({});
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'unauthenticated';
    }
  })());
  check('requireNonAnonymousAuth: anonymous sign-in provider -> permission-denied', (() => {
    try {
      __test__.requireNonAnonymousAuth({ auth: { uid: 'u1', token: { firebase: { sign_in_provider: 'anonymous' } } } });
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'permission-denied';
    }
  })());
  check('requireNonAnonymousAuth: real provider -> returns uid', __test__.requireNonAnonymousAuth({ auth: { uid: 'uid-real', token: { firebase: { sign_in_provider: 'password' } } } }) === 'uid-real');

  // Canonical, fully-valid 6-own-key raw stored document, used as the base for every test
  // below in this section — `overrides` replaces/adds keys, `omitKeys` deletes keys, so each
  // corruption case can isolate exactly the one aspect it's testing while keeping every
  // other field valid and the key set otherwise exactly correct.
  const validRawStoredDoc = (overrides: Record<string, unknown> = {}, omitKeys: string[] = []): Record<string, unknown> => {
    const base: Record<string, unknown> = {
      weekdays: [1, 3, 5],
      localTime: '07:30',
      timezone: 'America/Chicago',
      sessionDurationMinutes: 20,
      revision: 1,
      updatedAt: Timestamp.now(),
    };
    const merged = { ...base, ...overrides };
    for (const k of omitKeys) delete merged[k];
    return merged;
  };

  console.log('\n=== pure helpers: parseStoredCalendarPreferences ===');
  check('parseStoredCalendarPreferences: accepts a well-formed, already-canonical document', (() => {
    const parsed = __test__.parseStoredCalendarPreferences(validRawStoredDoc(), 1);
    return parsed !== null && JSON.stringify(parsed.weekdays) === JSON.stringify([1, 3, 5]) && parsed.revision === 1 && parsed.timezone === 'America/Chicago';
  })());
  // Codex repair pass 1, REPAIR 3: this REVERSES the pre-repair test that treated unsorted
  // stored weekdays as valid (it silently sorted them). Stored state must ALREADY be
  // canonical — this is now explicitly proven to be REJECTED, not silently repaired.
  check('parseStoredCalendarPreferences: REJECTS noncanonical (unsorted) stored weekday order — [3,1,5] must NOT be silently sorted into validity', __test__.parseStoredCalendarPreferences(validRawStoredDoc({ weekdays: [3, 1, 5] }), 1) === null);
  for (const [label, doc] of Object.entries({
    'missing weekdays': validRawStoredDoc({}, ['weekdays']),
    'empty weekdays': validRawStoredDoc({ weekdays: [] }),
    'duplicate weekdays': validRawStoredDoc({ weekdays: [1, 1, 3] }),
    'out-of-range weekday': validRawStoredDoc({ weekdays: [9] }),
    'noncanonical (descending) weekday order': validRawStoredDoc({ weekdays: [5, 3, 1] }),
    'malformed localTime': validRawStoredDoc({ localTime: 'not-a-time' }),
    'missing timezone': validRawStoredDoc({}, ['timezone']),
    'invalid stored timezone': validRawStoredDoc({ timezone: 'Not/A_Real_Zone' }),
    'noncanonical stored timezone alias (US/Central, not America/Chicago)': validRawStoredDoc({ timezone: 'US/Central' }),
    'out-of-bounds duration': validRawStoredDoc({ sessionDurationMinutes: 999 }),
    'non-numeric duration': validRawStoredDoc({ sessionDurationMinutes: '20' }),
    'missing updatedAt': validRawStoredDoc({}, ['updatedAt']),
    'null updatedAt': validRawStoredDoc({ updatedAt: null }),
    'numeric updatedAt': validRawStoredDoc({ updatedAt: 1700000000000 }),
    'string updatedAt': validRawStoredDoc({ updatedAt: '2024-01-01T00:00:00Z' }),
    'Date updatedAt': validRawStoredDoc({ updatedAt: new Date() }),
    'plain timestamp-shaped object updatedAt ({seconds,nanoseconds}, not a real Timestamp instance)': validRawStoredDoc({ updatedAt: { seconds: 1700000000, nanoseconds: 0 } }),
    'sentinel-shaped (isEqual-bearing but not a real Timestamp) updatedAt': validRawStoredDoc({ updatedAt: { isEqual: () => true } }),
    'extra stored field': validRawStoredDoc({ unexpectedExtraField: 'nope' }),
  })) {
    check(`parseStoredCalendarPreferences: rejects a corrupted document (${label})`, __test__.parseStoredCalendarPreferences(doc, 1) === null);
  }

  console.log('\n=== pure helpers: isPlainRecord / hasExactOwnKeys ===');
  check('isPlainRecord: accepts an ordinary {}-literal object', __test__.isPlainRecord({ a: 1 }));
  check('isPlainRecord: accepts a null-prototype record', __test__.isPlainRecord(Object.create(null)));
  check('isPlainRecord: rejects an array', __test__.isPlainRecord([1, 2, 3]) === false);
  check('isPlainRecord: rejects null', __test__.isPlainRecord(null) === false);
  check('isPlainRecord: rejects a primitive', __test__.isPlainRecord('x') === false);
  check('isPlainRecord: rejects a Date instance', __test__.isPlainRecord(new Date()) === false);
  check('isPlainRecord: rejects a class instance', __test__.isPlainRecord(new (class {})()) === false);
  check('hasExactOwnKeys: true for an exact match', __test__.hasExactOwnKeys({ a: 1, b: 2 }, ['a', 'b']));
  check('hasExactOwnKeys: false when a key is missing', __test__.hasExactOwnKeys({ a: 1 }, ['a', 'b']) === false);
  check('hasExactOwnKeys: false when an extra key is present', __test__.hasExactOwnKeys({ a: 1, b: 2, c: 3 }, ['a', 'b']) === false);
  check('hasExactOwnKeys: false for a same-count but different key set', __test__.hasExactOwnKeys({ a: 1, c: 2 }, ['a', 'b']) === false);

  console.log('\n=== pure helpers: parseUpdateCalendarPreferencesRequest (REPAIR 5 / REPAIR 9 request-shape matrix) ===');
  const validRequestPayload = () => ({ weekdays: [1, 3], localTime: '08:00', timezone: 'UTC', sessionDurationMinutes: 15, expectedRevision: 0 });
  check('parseUpdateCalendarPreferencesRequest: accepts a well-formed plain object with exactly the five expected keys', (() => {
    const result = __test__.parseUpdateCalendarPreferencesRequest(validRequestPayload());
    return Array.isArray(result.weekdays) && result.expectedRevision === 0;
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects an unknown top-level key', (() => {
    try {
      __test__.parseUpdateCalendarPreferencesRequest({ ...validRequestPayload(), extra: 'nope' });
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects a missing required key', (() => {
    const payload = validRequestPayload() as Record<string, unknown>;
    delete payload.timezone;
    try {
      __test__.parseUpdateCalendarPreferencesRequest(payload);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects an array payload', (() => {
    try {
      __test__.parseUpdateCalendarPreferencesRequest([1, 2, 3]);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects null', (() => {
    try {
      __test__.parseUpdateCalendarPreferencesRequest(null);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects a primitive (string) payload', (() => {
    try {
      __test__.parseUpdateCalendarPreferencesRequest('not an object');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  // The next two tests construct a payload via Object.create(customProto) so that
  // `payload.expectedRevision`/`payload.weekdays` resolve successfully through ordinary
  // PROPERTY ACCESS (i.e. a naive `data.expectedRevision` read would be fooled), while
  // Object.keys(payload) — which only ever returns OWN enumerable keys — correctly does
  // NOT include the inherited property. Rejection may occur at either the prototype-chain
  // check (isPlainRecord, since payload's own prototype is customProto, not
  // Object.prototype) or the own-keys check (hasExactOwnKeys) — both layers exist
  // specifically so an inherited property can never be mistaken for legitimate input, and
  // this test proves the combined effect holds regardless of which layer is responsible.
  check('parseUpdateCalendarPreferencesRequest: rejects a payload where expectedRevision is only INHERITED (not an own property)', (() => {
    const customProto = { expectedRevision: 0 };
    const payload = Object.create(customProto) as Record<string, unknown>;
    payload.weekdays = [1, 3];
    payload.localTime = '08:00';
    payload.timezone = 'UTC';
    payload.sessionDurationMinutes = 15;
    try {
      __test__.parseUpdateCalendarPreferencesRequest(payload);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects a payload where a semantic field (weekdays) is only INHERITED (not an own property)', (() => {
    const customProto = { weekdays: [1, 3] };
    const payload = Object.create(customProto) as Record<string, unknown>;
    payload.localTime = '08:00';
    payload.timezone = 'UTC';
    payload.sessionDurationMinutes = 15;
    payload.expectedRevision = 0;
    try {
      __test__.parseUpdateCalendarPreferencesRequest(payload);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: rejects a custom-prototype (class instance) payload even with all five own keys present', (() => {
    class Payload {
      weekdays = [1, 3];
      localTime = '08:00';
      timezone = 'UTC';
      sessionDurationMinutes = 15;
      expectedRevision = 0;
    }
    try {
      __test__.parseUpdateCalendarPreferencesRequest(new Payload());
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('parseUpdateCalendarPreferencesRequest: ACCEPTS a null-prototype record with exactly the five valid own keys', (() => {
    const payload = Object.create(null) as Record<string, unknown>;
    payload.weekdays = [1, 3];
    payload.localTime = '08:00';
    payload.timezone = 'UTC';
    payload.sessionDurationMinutes = 15;
    payload.expectedRevision = 0;
    const result = __test__.parseUpdateCalendarPreferencesRequest(payload);
    return Array.isArray(result.weekdays) && result.expectedRevision === 0;
  })());

  console.log('\n=== pure helpers: requireExpectedRevision (REPAIR 6 matrix) ===');
  for (const [label, value] of Object.entries({
    missing: undefined,
    null: null,
    string: '0',
    NaN: NaN,
    Infinity: Infinity,
    'negative Infinity': -Infinity,
    fractional: 1.5,
    negative: -1,
    'unsafe integer': Number.MAX_SAFE_INTEGER + 1,
    boolean: true,
    array: [0],
    object: {},
  })) {
    check(`requireExpectedRevision: rejects ${label}`, (() => {
      try {
        __test__.requireExpectedRevision(value);
        return false;
      } catch (err) {
        return (err as { code?: string }).code === 'invalid-argument';
      }
    })());
  }
  check('requireExpectedRevision: accepts valid 0', __test__.requireExpectedRevision(0) === 0);
  check('requireExpectedRevision: accepts a valid positive safe integer', __test__.requireExpectedRevision(42) === 42);
  check('requireExpectedRevision: accepts Number.MAX_SAFE_INTEGER itself', __test__.requireExpectedRevision(Number.MAX_SAFE_INTEGER) === Number.MAX_SAFE_INTEGER);

  console.log('\n=== pure helpers: isSemanticallyUnchanged ===');
  const sample = { weekdays: [1, 3], localTime: '08:00', timezone: 'UTC', sessionDurationMinutes: 15, revision: 1 };
  check('isSemanticallyUnchanged: identical fields -> true', __test__.isSemanticallyUnchanged(sample, { weekdays: [1, 3], localTime: '08:00', timezone: 'UTC', sessionDurationMinutes: 15 }));
  check('isSemanticallyUnchanged: current is null -> false (nothing to compare)', __test__.isSemanticallyUnchanged(null, { weekdays: [1, 3], localTime: '08:00', timezone: 'UTC', sessionDurationMinutes: 15 }) === false);
  check('isSemanticallyUnchanged: different weekdays -> false', __test__.isSemanticallyUnchanged(sample, { weekdays: [1, 4], localTime: '08:00', timezone: 'UTC', sessionDurationMinutes: 15 }) === false);
  check('isSemanticallyUnchanged: different localTime -> false', __test__.isSemanticallyUnchanged(sample, { weekdays: [1, 3], localTime: '09:00', timezone: 'UTC', sessionDurationMinutes: 15 }) === false);
  check('isSemanticallyUnchanged: different timezone -> false', __test__.isSemanticallyUnchanged(sample, { weekdays: [1, 3], localTime: '08:00', timezone: 'America/Chicago', sessionDurationMinutes: 15 }) === false);
  check('isSemanticallyUnchanged: different sessionDurationMinutes -> false', __test__.isSemanticallyUnchanged(sample, { weekdays: [1, 3], localTime: '08:00', timezone: 'UTC', sessionDurationMinutes: 30 }) === false);

  console.log('\n=== updateCalendarPreferencesCore: creation ===');
  await checkAsync('creation: succeeds for expectedRevision 0 on a missing document, returns revision 1', async () => {
    const { db } = makeFakeDb();
    const result = await updateCalendarPreferencesCore(db, 'uid-a', validInput());
    return !result.conflict && result.revision === 1 && result.unchanged === false;
  });
  await checkAsync('creation: persists exactly the validated/canonicalized fields', async () => {
    const { db, store } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-b', validInput({ weekdays: [5, 1] }));
    const doc = store.get(prefsPath('uid-b'));
    return (
      !!doc &&
      JSON.stringify(doc.weekdays) === JSON.stringify([1, 5]) &&
      doc.localTime === '07:30' &&
      doc.timezone === 'America/Chicago' &&
      doc.sessionDurationMinutes === 20 &&
      doc.revision === 1
    );
  });
  await checkAsync('creation: a nonzero expectedRevision against a missing document is a conflict, not a creation', async () => {
    const { db, store } = makeFakeDb();
    const result = await updateCalendarPreferencesCore(db, 'uid-c', validInput({ expectedRevision: 1 }));
    return result.conflict === true && result.currentRevision === 0 && result.current === null && !store.has(prefsPath('uid-c'));
  });
  await checkAsync('creation: does not touch any other uid\'s document', async () => {
    const { db, store } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-other-existing', validInput());
    const before = JSON.stringify(store.get(prefsPath('uid-other-existing')));
    await updateCalendarPreferencesCore(db, 'uid-d', validInput());
    const after = JSON.stringify(store.get(prefsPath('uid-other-existing')));
    return before === after;
  });

  console.log('\n=== updateCalendarPreferencesCore: revision / CAS ===');
  await checkAsync('CAS: a correctly-following update (expectedRevision matches, real semantic change) succeeds and increments revision by exactly 1', async () => {
    const { db } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-e', validInput());
    const second = await updateCalendarPreferencesCore(db, 'uid-e', validInput({ expectedRevision: 1, localTime: '18:00' }));
    return !second.conflict && second.revision === 2;
  });
  await checkAsync('CAS: stale expectedRevision is rejected as a conflict, no write occurs', async () => {
    const { db, store } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-f', validInput());
    const before = JSON.stringify(store.get(prefsPath('uid-f')));
    const stale = await updateCalendarPreferencesCore(db, 'uid-f', validInput({ expectedRevision: 0, localTime: '18:00' })); // stale: doc is now at revision 1
    const after = JSON.stringify(store.get(prefsPath('uid-f')));
    return stale.conflict === true && stale.currentRevision === 1 && before === after;
  });
  await checkAsync('CAS: conflict result reports the CURRENT stored shape for client reconciliation', async () => {
    const { db } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-g', validInput({ localTime: '06:00' }));
    const stale = await updateCalendarPreferencesCore(db, 'uid-g', validInput({ expectedRevision: 0, localTime: '18:00' }));
    return stale.conflict === true && stale.current !== null && stale.current.localTime === '06:00';
  });
  await checkAsync('CAS (concurrent/stale-client logical serialization): two clients both read revision 0; the first to write succeeds, the second (now stale) is rejected', async () => {
    // FAKE FIRESTORE LIMITATION, stated explicitly (matching calendarSubscriptions.test.ts's
    // own disclosure): this fake models neither real Firestore locking, transaction retry,
    // nor genuine concurrency. This test exercises the two writes SEQUENTIALLY (client A's
    // full operation completes before client B's begins) to prove the CAS outcome composes
    // correctly, not to prove production Firestore's transaction-conflict machinery behaves
    // identically under a true race.
    const { db } = makeFakeDb();
    const clientAInput = validInput({ localTime: '06:00' });
    const clientBInput = validInput({ localTime: '09:00' }); // both read expectedRevision: 0
    const clientAResult = await updateCalendarPreferencesCore(db, 'uid-h', clientAInput);
    const clientBResult = await updateCalendarPreferencesCore(db, 'uid-h', clientBInput);
    return !clientAResult.conflict && clientAResult.revision === 1 && clientBResult.conflict === true && clientBResult.currentRevision === 1;
  });

  console.log('\n=== updateCalendarPreferencesCore: idempotent resubmit ===');
  await checkAsync('idempotent resubmit: identical semantic fields at the correct revision is a deterministic no-op (revision unchanged, unchanged: true)', async () => {
    const { db } = makeFakeDb();
    const first = await updateCalendarPreferencesCore(db, 'uid-i', validInput());
    const second = await updateCalendarPreferencesCore(db, 'uid-i', validInput({ expectedRevision: first.conflict ? 0 : first.revision }));
    return !second.conflict && second.revision === 1 && second.unchanged === true;
  });
  await checkAsync('idempotent resubmit: does not touch the stored document at all (byte-for-byte unchanged, no updatedAt churn)', async () => {
    const { db, store } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-j', validInput());
    const before = JSON.stringify(store.get(prefsPath('uid-j')));
    await updateCalendarPreferencesCore(db, 'uid-j', validInput({ expectedRevision: 1 }));
    const after = JSON.stringify(store.get(prefsPath('uid-j')));
    return before === after;
  });
  await checkAsync('idempotent resubmit: a weekdays array submitted in different input order, but semantically identical, is still recognized as unchanged', async () => {
    const { db } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-k', validInput({ weekdays: [1, 3, 5] }));
    const second = await updateCalendarPreferencesCore(db, 'uid-k', validInput({ weekdays: [5, 3, 1], expectedRevision: 1 }));
    return !second.conflict && second.unchanged === true && second.revision === 1;
  });
  await checkAsync('idempotent resubmit: a genuinely different field at the correct revision is NOT treated as unchanged (real write, revision increments)', async () => {
    const { db } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-l', validInput({ sessionDurationMinutes: 20 }));
    const second = await updateCalendarPreferencesCore(db, 'uid-l', validInput({ sessionDurationMinutes: 25, expectedRevision: 1 }));
    return !second.conflict && second.unchanged === false && second.revision === 2;
  });
  // Codex repair pass 1, REPAIR 8: request-side timezone ALIAS no-op. Verified against this
  // runtime directly before writing this test (Node 24.19.0 ICU data): 'US/Central' resolves
  // to 'America/Chicago', the exact alias pair notificationPreferences.ts's own header
  // already documents as resolving in this environment. The stored document holds the
  // CANONICAL form ('America/Chicago'); the request submits the ALIAS ('US/Central'), which
  // requireTimezone canonicalizes server-side before comparison — so this must be recognized
  // as unchanged despite the two strings differing byte-for-byte on the wire.
  await checkAsync('idempotent resubmit (REPAIR 8): a request submitting a TIMEZONE ALIAS that canonicalizes to the currently-stored canonical timezone is recognized as unchanged (unchanged: true, revision unchanged, zero writes)', async () => {
    const { db, store } = makeFakeDb();
    await updateCalendarPreferencesCore(db, 'uid-alias', validInput({ timezone: 'America/Chicago' }));
    const before = JSON.stringify(store.get(prefsPath('uid-alias')));
    const second = await updateCalendarPreferencesCore(db, 'uid-alias', validInput({ timezone: 'US/Central', expectedRevision: 1 }));
    const after = JSON.stringify(store.get(prefsPath('uid-alias')));
    return !second.conflict && second.unchanged === true && second.revision === 1 && second.timezone === 'America/Chicago' && before === after;
  });

  console.log('\n=== updateCalendarPreferencesCore: revision exhaustion (REPAIR 10: overflow refusal preserved) ===');
  await checkAsync('overflow refusal: a genuine semantic change at Number.MAX_SAFE_INTEGER is refused (resource-exhausted), no write occurs', async () => {
    const { db, store } = makeFakeDb();
    store.set(prefsPath('uid-maxrev'), validRawStoredDoc({ revision: Number.MAX_SAFE_INTEGER, sessionDurationMinutes: 20 }));
    const before = JSON.stringify(store.get(prefsPath('uid-maxrev')));
    try {
      await updateCalendarPreferencesCore(db, 'uid-maxrev', validInput({ sessionDurationMinutes: 25, expectedRevision: Number.MAX_SAFE_INTEGER }));
      return false;
    } catch (err) {
      const after = JSON.stringify(store.get(prefsPath('uid-maxrev')));
      return (err as { code?: string }).code === 'resource-exhausted' && before === after;
    }
  });
  await checkAsync('overflow refusal: an IDENTICAL (no-op) resubmit at Number.MAX_SAFE_INTEGER succeeds anyway — the exhaustion limit never blocks a write that would not actually increment', async () => {
    const { db, store } = makeFakeDb();
    store.set(prefsPath('uid-maxrev2'), validRawStoredDoc({ revision: Number.MAX_SAFE_INTEGER }));
    const result = await updateCalendarPreferencesCore(db, 'uid-maxrev2', validInput({ expectedRevision: Number.MAX_SAFE_INTEGER }));
    return !result.conflict && result.unchanged === true && result.revision === Number.MAX_SAFE_INTEGER;
  });

  // Codex repair pass 1, REPAIR 7: full round-trip corruption matrix. Each case seeds a raw
  // document DIRECTLY into the fake store (bypassing updateCalendarPreferencesCore entirely,
  // exactly as a real corrupted/hand-edited Firestore document would look), then attempts a
  // real update through the FULL Core function — proving, for every case, that the result
  // (a) throws 'data-loss' rather than returning ANY result (in particular, never
  // `unchanged: true`), and (b) leaves the stored document COMPLETELY byte-for-byte
  // untouched (zero writes of any kind).
  console.log('\n=== updateCalendarPreferencesCore: stored corruption round-trip matrix (REPAIR 7) ===');
  async function expectDataLossNoWrite(label: string, rawDoc: Record<string, unknown>): Promise<void> {
    await checkAsync(`corruption round-trip: ${label} -> data-loss, zero writes, never unchanged:true`, async () => {
      const { db, store } = makeFakeDb();
      const uid = `uid-corrupt-${Math.random().toString(36).slice(2)}`;
      store.set(prefsPath(uid), rawDoc);
      const before = JSON.stringify(store.get(prefsPath(uid)));
      try {
        // expectedRevision deliberately matches the seeded doc's nominal revision where that
        // value is itself valid (1), so a conflict error can never mask the data-loss check
        // this test is actually targeting.
        await updateCalendarPreferencesCore(db, uid, validInput({ expectedRevision: 1 }));
        return false; // must have thrown -- reaching here is itself a failure.
      } catch (err) {
        const after = JSON.stringify(store.get(prefsPath(uid)));
        return (err as { code?: string }).code === 'data-loss' && before === after;
      }
    });
  }
  await expectDataLossNoWrite('extra stored field', validRawStoredDoc({ unexpectedExtraField: 'nope' }));
  await expectDataLossNoWrite('missing updatedAt', validRawStoredDoc({}, ['updatedAt']));
  await expectDataLossNoWrite('null updatedAt', validRawStoredDoc({ updatedAt: null }));
  await expectDataLossNoWrite('numeric updatedAt', validRawStoredDoc({ updatedAt: 1700000000000 }));
  await expectDataLossNoWrite('string updatedAt', validRawStoredDoc({ updatedAt: '2024-01-01T00:00:00Z' }));
  await expectDataLossNoWrite('Date updatedAt', validRawStoredDoc({ updatedAt: new Date() }));
  await expectDataLossNoWrite('plain timestamp-shaped object updatedAt', validRawStoredDoc({ updatedAt: { seconds: 1700000000, nanoseconds: 0 } }));
  await expectDataLossNoWrite('malformed/sentinel-shaped updatedAt', validRawStoredDoc({ updatedAt: { isEqual: () => true } }));
  await expectDataLossNoWrite('invalid stored timezone', validRawStoredDoc({ timezone: 'Not/A_Real_Zone' }));
  await expectDataLossNoWrite('noncanonical stored timezone alias (US/Central)', validRawStoredDoc({ timezone: 'US/Central' }));
  await expectDataLossNoWrite('noncanonical (unsorted) weekday ordering', validRawStoredDoc({ weekdays: [5, 1, 3] }));
  await expectDataLossNoWrite('duplicate stored weekday', validRawStoredDoc({ weekdays: [1, 1, 3] }));
  await expectDataLossNoWrite('missing stored key (localTime)', validRawStoredDoc({}, ['localTime']));
  await expectDataLossNoWrite('extra stored key (label)', validRawStoredDoc({ label: 'unexpected' }));
  await expectDataLossNoWrite('malformed revision (string)', validRawStoredDoc({ revision: 'one' }));
  await expectDataLossNoWrite('malformed duration (out of bounds)', validRawStoredDoc({ sessionDurationMinutes: 999 }));
  await expectDataLossNoWrite('malformed duration (non-numeric)', validRawStoredDoc({ sessionDurationMinutes: '20' }));
  await expectDataLossNoWrite('malformed localTime', validRawStoredDoc({ localTime: 'not-a-time' }));

  console.log('\n=== STATIC SCOPE AUDIT (source-text checks) ===');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const srcPath = path.join(__dirname, '..', 'src', 'calendarPreferences.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  // Normalize CRLF/CR to LF FIRST, before any of the structural checks below that search
  // for exact line-boundary sequences like '\n}\n' — see the identical fix in
  // calendarSubscriptions.test.ts for the full rationale. Without this, a CRLF checkout
  // leaves a trailing '\r' attached to every retained line, so '\n}\n' never matches,
  // the function-body-boundary search below returns -1, and the slice overruns into the
  // onCall wrapper below (whose legitimate `request.data` read is not part of
  // updateCalendarPreferencesCore's own body).
  const stripped = src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  check('this file contains NO import from, or reference to, notificationPreferences (no notification coupling)', !/notificationPreferences|notificationRollout|reminderDelivery|reminderScheduler/i.test(stripped));
  check('this file contains NO reference to course-progress state (dnsCourse/currentDay/entitlement)', !/dnsCourse|currentDay|dnsEntitlement/i.test(stripped));
  check('this file contains NO import from calendarSubscriptions.ts (Stage 1 tombstone/hash transaction is not referenced, let alone modified)', !/from '\.\/calendarSubscriptions'/.test(stripped));
  check('this file exports NO Auth-deletion trigger (deliberate — see the ACCOUNT DELETION section of the file header)', !/\.auth\.user\(\)\.onDelete\(/.test(stripped));
  check('this file contains no import from any first-real-send-experiment module', !/first-real-send/i.test(stripped));
  check('updateCalendarPreferences enforces App Check', (stripped.match(/onCall\(CALLABLE_OPTIONS,/g) || []).length === 1);
  check('CALLABLE_OPTIONS itself sets enforceAppCheck: true', /const CALLABLE_OPTIONS = \{ enforceAppCheck: true \}/.test(stripped));
  check('no uid is ever read from request.data (client-supplied uid never used as ownership authority)', !/request\.data[^;]*uid/i.test(stripped));
  check('updateCalendarPreferencesCore never takes a raw Firestore path or uid from anywhere but its own explicit `uid` parameter', (() => {
    const fnStart = stripped.indexOf('export async function updateCalendarPreferencesCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    return fnBody.includes('calendarPreferencesRef(db, uid)') && !/request\.data/.test(fnBody);
  })());

  console.log('\n=== firestore.rules cross-check ===');
  check('firestore.rules: owner may read calendarPreferences, all writes denied, no broader override exists', (() => {
    const rulesPath = path.join(__dirname, '..', '..', 'firestore.rules');
    const rules = fs.readFileSync(rulesPath, 'utf8');
    const m = rules.match(/match \/artifacts\/\{appId\}\/users\/\{uid\}\/calendarPreferences\/\{doc\} \{([^}]*)\}/);
    if (!m) return false;
    const block = m[1];
    return /allow read: if request\.auth != null && request\.auth\.uid == uid;/.test(block) && /allow write: if false;/.test(block);
  })());

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
});
