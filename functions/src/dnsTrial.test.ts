// functions/src/dnsTrial.test.ts
//
// No-card 14-day DNS free trial: activation, idempotency, one-trial-per-uid, permanent
// override, and protected-media day authorization — all through the real exported
// production functions in dnsEntitlement.ts (startDnsTrialForUid, resolveDnsAccess,
// canAccessDnsCourseDay, dnsTrialCallerError, applyDnsEntitlementBasis), never a
// reimplementation. getDnsCourseDayMedia itself is a thin onCall wrapper around exactly
// `resolveDnsAccess(doc, Date.now())` + `canAccessDnsCourseDay(access, day)`, which is the
// composition exercised by `mediaAllowed` below.
//
// Progression enforcement (a trial user can't advance dnsCourse.currentDay past 15, or at
// all once expired) lives in firestore.rules and is proven against the real Firestore
// emulator in dnsTrialRules.emulatorSuite.ts — not here.
'use strict';

import { Timestamp } from 'firebase-admin/firestore';
import {
  applyDnsEntitlementBasis,
  canAccessDnsCourseDay,
  dnsTrialCallerError,
  DNS_TRIAL_DURATION_MS,
  DNS_TRIAL_MAX_COURSE_DAY,
  hasDnsEntitlement,
  resolveDnsAccess,
  startDnsTrialForUid,
  __test__ as entitlementTest,
} from './dnsEntitlement';

const { isValidActiveBasis, parseTrialRecord } = entitlementTest;

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

// Fake Firestore with faithful optimistic-concurrency retry semantics (same pattern as
// dnsRefundEntitlement.test.ts), plus Firestore's top-level `merge: true` behavior.
type DocData = Record<string, unknown>;
function makeFakeDb() {
  const store = new Map<string, DocData>();
  const versions = new Map<string, number>();
  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1);
  function docRef(path: string) {
    return {
      path,
      async get() {
        const exists = store.has(path);
        return { exists, data: () => (exists ? { ...store.get(path)! } : undefined) };
      },
    };
  }
  const db = {
    doc: (path: string) => docRef(path),
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>['get']>;
        set: (ref: ReturnType<typeof docRef>, data: DocData, opts?: { merge?: boolean }) => void;
      }) => Promise<T>
    ): Promise<T> {
      for (let attempt = 0; attempt < 50; attempt++) {
        const readVersions = new Map<string, number>();
        const pendingWrites: { path: string; data: DocData; merge: boolean }[] = [];
        const tx = {
          get(ref: ReturnType<typeof docRef>) {
            readVersions.set(ref.path, versions.get(ref.path) ?? 0);
            return ref.get();
          },
          set(ref: ReturnType<typeof docRef>, data: DocData, opts?: { merge?: boolean }) {
            pendingWrites.push({ path: ref.path, data, merge: opts?.merge === true });
          },
        };
        const result = await fn(tx);
        // Yield so concurrently started transactions genuinely interleave.
        await new Promise((r) => setImmediate(r));
        const conflict = [...readVersions.entries()].some(([path, v]) => (versions.get(path) ?? 0) !== v);
        if (conflict) continue;
        for (const w of pendingWrites) {
          store.set(w.path, w.merge ? { ...(store.get(w.path) ?? {}), ...w.data } : { ...w.data });
          bump(w.path);
        }
        return result;
      }
      throw new Error('fake Firestore: too many transaction retries');
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { db: db as any, store };
}

const entPath = (uid: string) => `artifacts/neuroactive-prod/users/${uid}/entitlement/main`;
const userDataPath = (uid: string) => `artifacts/neuroactive-prod/users/${uid}/userData/main`;
const T0 = Date.UTC(2026, 9, 21, 15, 0, 0); // fixed "server now"
const DAY = 24 * 60 * 60 * 1000;
const at = (ms: number) => () => Timestamp.fromMillis(ms);
const trialRecord = (store: Map<string, DocData>, uid: string) =>
  ((store.get(entPath(uid))?.bases ?? {}) as Record<string, Record<string, unknown>>).dns_trial;
const ms = (v: unknown) => (v as Timestamp).toMillis();
const mediaAllowed = (data: DocData | undefined, day: number, nowMs: number) =>
  canAccessDnsCourseDay(resolveDnsAccess(data, nowMs), day);

async function run(): Promise<void> {
  // 1. First activation
  await checkAsync('1. first activation creates a server-timed 14-day trial', async () => {
    const { db, store } = makeFakeDb();
    const r = await startDnsTrialForUid(db, 'u1', at(T0));
    const rec = trialRecord(store, 'u1');
    check('1a. outcome started', r.outcome === 'started');
    check('1b. startedAt = server now', ms(rec.startedAt) === T0);
    check('1c. expiresAt = start + exactly 14 days', ms(rec.expiresAt) === T0 + 14 * DAY && DNS_TRIAL_DURATION_MS === 14 * DAY);
    check('1d. maximumCourseDay 14', rec.maximumCourseDay === 14 && DNS_TRIAL_MAX_COURSE_DAY === 14);
    check('1e. response is trial_active, max day 14, purchase required', r.access.accessType === 'trial_active' && r.access.maxAccessibleDay === 14 && r.access.purchaseRequired === true);
    check('1f. response carries no credentials/basis internals', !('bases' in r.access) && !JSON.stringify(r).includes('videoId'));
    return !(await hasDnsEntitlement(db, 'u1')); // trial is never permanent entitlement
  });

  // 2. Duplicate activation / retry returns the same trial, never extends it
  await checkAsync('2. duplicate activation returns the same trial without extending', async () => {
    const { db, store } = makeFakeDb();
    await startDnsTrialForUid(db, 'u2', at(T0));
    const again = await startDnsTrialForUid(db, 'u2', at(T0 + 3 * DAY));
    const rec = trialRecord(store, 'u2');
    check('2a. outcome already_active', again.outcome === 'already_active');
    check('2b. expiry unchanged', ms(rec.expiresAt) === T0 + 14 * DAY && again.access.trialExpiresAt === new Date(T0 + 14 * DAY).toISOString());
    return ms(rec.startedAt) === T0;
  });

  await checkAsync('2c. concurrent double-click creates exactly one trial', async () => {
    const { db, store } = makeFakeDb();
    const [a, b] = await Promise.all([
      startDnsTrialForUid(db, 'u2c', at(T0)),
      startDnsTrialForUid(db, 'u2c', at(T0 + 5000)),
    ]);
    const outcomes = [a.outcome, b.outcome].sort().join(',');
    const rec = trialRecord(store, 'u2c');
    return outcomes === 'already_active,started' && [T0, T0 + 5000].includes(ms(rec.startedAt)) && ms(rec.expiresAt) - ms(rec.startedAt) === 14 * DAY;
  });

  // 3. Expired trial cannot restart
  await checkAsync('3. expired trial cannot be restarted', async () => {
    const { db, store } = makeFakeDb();
    await startDnsTrialForUid(db, 'u3', at(T0));
    const later = await startDnsTrialForUid(db, 'u3', at(T0 + 30 * DAY));
    const rec = trialRecord(store, 'u3');
    return later.outcome === 'already_used' && later.access.accessType === 'trial_expired' && ms(rec.startedAt) === T0 && ms(rec.expiresAt) === T0 + 14 * DAY;
  });

  // 4–6. Permanent bases bypass trial restrictions and are never modified by a start request
  for (const [label, key, basis] of [
    ['4. paid Stripe purchaser', 'stripe_program:pi_4', { type: 'stripe_program', active: true, stripePaymentId: 'pi_4' }],
    ['5. zero-total Stripe purchaser', 'stripe_program_zero_total:cs_5', { type: 'stripe_program_zero_total', active: true, stripeCheckoutSessionId: 'cs_5' }],
    ['6. beta grant', 'beta_grant', { type: 'beta_grant', active: true, cohort: 'beta-1' }],
  ] as const) {
    await checkAsync(`${label} bypasses trial limits and is untouched by startDnsTrial`, async () => {
      const { db, store } = makeFakeDb();
      const uid = 'perm-' + key;
      await applyDnsEntitlementBasis(db, uid, key, basis);
      const before = JSON.stringify(store.get(entPath(uid)));
      const r = await startDnsTrialForUid(db, uid, at(T0));
      const doc = store.get(entPath(uid));
      check(`${label}: outcome permanent, no write`, r.outcome === 'permanent' && JSON.stringify(doc) === before);
      check(`${label}: no trial record`, trialRecord(store, uid) === undefined);
      return r.access.accessType === 'permanent' && r.access.maxAccessibleDay === null && [1, 14, 15, 84].every((d) => mediaAllowed(doc, d, T0));
    });
  }

  await checkAsync('4b. legacy pre-bases permanent document is permanent and never rewritten', async () => {
    const { db, store } = makeFakeDb();
    store.set(entPath('u4b'), { dnsFoundationsEntitled: true, source: 'stripe:program', stripePaymentId: 'pi_legacy' });
    const r = await startDnsTrialForUid(db, 'u4b', at(T0));
    return r.outcome === 'permanent' && store.get(entPath('u4b'))!.bases === undefined;
  });

  // 7–10. Media day authorization
  await checkAsync('7–10. trial media limits: Days 1–14 active and expired, never Day 15+', async () => {
    const { db, store } = makeFakeDb();
    await startDnsTrialForUid(db, 'u7', at(T0));
    const doc = store.get(entPath('u7'));
    const activeNow = T0 + 2 * DAY;
    const expiredNow = T0 + 14 * DAY; // exactly at expiry = expired
    check('7. active trial: Day 1 and Day 14 allowed', mediaAllowed(doc, 1, activeNow) && mediaAllowed(doc, 14, activeNow));
    check('8. active trial: Day 15 denied', !mediaAllowed(doc, 15, activeNow));
    check('9. expired trial: Day 1 and Day 14 review allowed', mediaAllowed(doc, 1, expiredNow) && mediaAllowed(doc, 14, expiredNow));
    check('10. expired trial: Day 15 denied', !mediaAllowed(doc, 15, expiredNow));
    check('7–10. expiry boundary: 1 ms before = active, at = expired',
      resolveDnsAccess(doc, T0 + 14 * DAY - 1).accessType === 'trial_active' && resolveDnsAccess(doc, T0 + 14 * DAY).accessType === 'trial_expired');
    return [16, 30, 84].every((d) => !mediaAllowed(doc, d, activeNow) && !mediaAllowed(doc, d, expiredNow));
  });

  check('none: no entitlement doc → no media', !mediaAllowed(undefined, 1, T0));
  check('none: empty doc → no media', !mediaAllowed({}, 1, T0));

  // 11. Manipulated client dates — access is a pure function of the SERVER-written record
  // and SERVER now; a forged/corrupt longer window or wrong type grants nothing.
  check('11a. forged 30-day window rejected', parseTrialRecord({ type: 'dns_trial', startedAt: Timestamp.fromMillis(T0), expiresAt: Timestamp.fromMillis(T0 + 30 * DAY) }) === null);
  check('11b. string (client-style) dates rejected', parseTrialRecord({ type: 'dns_trial', startedAt: '2026-10-21', expiresAt: '2099-01-01' }) === null);
  check('11c. wrong type rejected', parseTrialRecord({ type: 'stripe_program', startedAt: Timestamp.fromMillis(T0), expiresAt: Timestamp.fromMillis(T0 + DAY) }) === null);
  check('11d. malformed record grants no media but counts as used', (() => {
    const doc = { bases: { dns_trial: { type: 'dns_trial', startedAt: 'x', expiresAt: 'y' } } };
    const a = resolveDnsAccess(doc, T0);
    return a.accessType === 'none' && a.trialUsed === true && !mediaAllowed(doc, 1, T0);
  })());
  await checkAsync('11e. malformed existing record is never recreated (needs_review)', async () => {
    const { db, store } = makeFakeDb();
    store.set(entPath('u11e'), { bases: { dns_trial: { type: 'dns_trial', startedAt: 'x' } } });
    const r = await startDnsTrialForUid(db, 'u11e', at(T0));
    return r.outcome === 'needs_review' && (trialRecord(store, 'u11e').startedAt === 'x');
  });

  // 12. Manipulated requested day
  await checkAsync('12. manipulated requested day never exposes later media to a trial user', async () => {
    const { db, store } = makeFakeDb();
    await startDnsTrialForUid(db, 'u12', at(T0));
    const doc = store.get(entPath('u12'));
    return [0, -1, 14.5, 15, 85, Number.NaN, Number.POSITIVE_INFINITY].every((d) => !mediaAllowed(doc, d, T0 + DAY));
  });

  // Trial basis is structurally non-authorizing even if someone forced active:true.
  check('trial key never passes isValidActiveBasis', !isValidActiveBasis('dns_trial', { type: 'dns_trial', active: true }));

  // 14. Purchase after trial preserves progress and the trial record; permanent overrides.
  await checkAsync('14. purchase after trial → permanent, progress and trial record preserved', async () => {
    const { db, store } = makeFakeDb();
    const progress = { dnsCourse: { currentDay: 15, startedAt: '2026-10-07', lastCompletedDate: '2026-10-20', completionDates: { 1: '2026-10-07', 14: '2026-10-20' } } };
    store.set(userDataPath('u14'), progress);
    await startDnsTrialForUid(db, 'u14', at(T0));
    await applyDnsEntitlementBasis(db, 'u14', 'stripe_program:pi_14', { type: 'stripe_program', active: true, stripePaymentId: 'pi_14' });
    const doc = store.get(entPath('u14'));
    check('14a. permanent after purchase', doc?.dnsFoundationsEntitled === true && resolveDnsAccess(doc, T0 + 30 * DAY).accessType === 'permanent');
    check('14b. trial record preserved through the purchase write', ms(trialRecord(store, 'u14').startedAt) === T0);
    check('14c. Day 15+ media now allowed', mediaAllowed(doc, 15, T0 + 30 * DAY) && mediaAllowed(doc, 84, T0 + 30 * DAY));
    return JSON.stringify(store.get(userDataPath('u14'))) === JSON.stringify(progress);
  });

  await checkAsync('14d. beta grant written after a trial preserves the trial record', async () => {
    const { db, store } = makeFakeDb();
    await startDnsTrialForUid(db, 'u14d', at(T0));
    await applyDnsEntitlementBasis(db, 'u14d', 'beta_grant', { type: 'beta_grant', active: true });
    return trialRecord(store, 'u14d') !== undefined && store.get(entPath('u14d'))?.dnsFoundationsEntitled === true;
  });

  await checkAsync('14e. refunded purchaser (sealed basis) may start a trial; the sealed basis is preserved', async () => {
    const { db, store } = makeFakeDb();
    await applyDnsEntitlementBasis(db, 'u14e', 'stripe_program:pi_r', { type: 'stripe_program', active: false, terminal: true, stripePaymentId: 'pi_r' });
    const r = await startDnsTrialForUid(db, 'u14e', at(T0));
    const bases = store.get(entPath('u14e'))!.bases as Record<string, Record<string, unknown>>;
    return r.outcome === 'started' && bases['stripe_program:pi_r'].terminal === true && store.get(entPath('u14e'))!.dnsFoundationsEntitled === false;
  });

  // Flagged/revoked accounts are not silently given new access.
  await checkAsync('needs_review: legacy explicit-false document', async () => {
    const { db, store } = makeFakeDb();
    store.set(entPath('nr1'), { dnsFoundationsEntitled: false, source: 'beta_grant' });
    const r = await startDnsTrialForUid(db, 'nr1', at(T0));
    return r.outcome === 'needs_review' && trialRecord(store, 'nr1') === undefined;
  });
  await checkAsync('needs_review: legacy_unknown flagged basis', async () => {
    const { db, store } = makeFakeDb();
    store.set(entPath('nr2'), { dnsFoundationsEntitled: false, bases: { 'legacy_unknown:x': { type: 'legacy_unknown', active: false, needsManualReview: true } } });
    const r = await startDnsTrialForUid(db, 'nr2', at(T0));
    return r.outcome === 'needs_review' && trialRecord(store, 'nr2') === undefined;
  });

  // 15. Anonymous / unauthenticated callers cannot activate
  check('15a. unauthenticated caller rejected', dnsTrialCallerError(undefined)?.code === 'unauthenticated');
  check('15b. anonymous caller rejected', dnsTrialCallerError({ uid: 'a', token: { firebase: { sign_in_provider: 'anonymous' } } })?.code === 'failed-precondition');
  check('15c. provider-less token rejected', dnsTrialCallerError({ uid: 'a', token: {} })?.code === 'failed-precondition');
  check('15d. google / password / email-link callers accepted', ['google.com', 'password', 'emailLink'].every((p) => dnsTrialCallerError({ uid: 'a', token: { firebase: { sign_in_provider: p } } }) === null));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

run();
