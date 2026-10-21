// tests/dnsTrial.test.ts
// Run: node --test "tests/*.test.ts"
// Client-side free-trial helpers (src/services/dnsTrial.ts) — display/navigation only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTrialCountdown,
  DNS_TRIAL_DISPLAY_MAX_DAY,
  PENDING_TRIAL_INTENT_TTL_MS,
  clearPendingTrialIntent,
  readDnsTrialState,
  readPendingTrialIntent,
  resolveDnsCourseAccessMode,
  resolveSettingsDnsAccessDisplay,
  reviewableDayCount,
  trialConversionCopy,
  trialConversionVariant,
  trialCountdownLabel,
  writePendingTrialIntent,
  TRIAL_CONTINUE_STATEMENT,
  TRIAL_EXPIRED_EARLY_COPY,
  TRIAL_FOUNDATION_COMPLETE_COPY,
  TRIAL_REVIEW_LABEL,
  type IntentStorage,
} from '../src/services/dnsTrial.ts';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 21, 15, 0, 0);
const stamp = (ms: number) => ({ toMillis: () => ms }); // Firestore Timestamp shape
const trialDoc = (start = T0, end = T0 + 14 * DAY) => ({ bases: { dns_trial: { type: 'dns_trial', startedAt: stamp(start), expiresAt: stamp(end) } } });

function memoryStorage(): IntentStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

test('readDnsTrialState: well-formed record', () => {
  assert.deepEqual(readDnsTrialState(trialDoc()), { used: true, trial: { startedAtMs: T0, expiresAtMs: T0 + 14 * DAY } });
});

test('readDnsTrialState: no record / no doc / malformed record', () => {
  assert.deepEqual(readDnsTrialState(undefined), { used: false, trial: null });
  assert.deepEqual(readDnsTrialState({ bases: { beta_grant: { type: 'beta_grant' } } }), { used: false, trial: null });
  assert.deepEqual(readDnsTrialState({ bases: { dns_trial: { type: 'dns_trial', startedAt: 'x' } } }), { used: true, trial: null });
  assert.deepEqual(readDnsTrialState({ bases: { dns_trial: { type: 'dns_trial', startedAt: '2026-10-21', expiresAt: '2099-01-01' } } }), { used: true, trial: null });
});

test('17. permanent access always wins — trial UI never shown to purchasers/beta', () => {
  assert.equal(resolveDnsCourseAccessMode('entitled', readDnsTrialState(trialDoc())), 'permanent');
  assert.equal(resolveDnsCourseAccessMode('entitled', readDnsTrialState(undefined)), 'permanent');
  assert.equal(resolveDnsCourseAccessMode('not-entitled', readDnsTrialState(trialDoc())), 'trial');
  assert.equal(resolveDnsCourseAccessMode('not-entitled', readDnsTrialState(undefined)), 'none');
  assert.equal(resolveDnsCourseAccessMode('loading', readDnsTrialState(trialDoc())), 'loading');
});

test('18. countdown: whole days rounded up, clamped, never negative', () => {
  const trial = { startedAtMs: T0, expiresAtMs: T0 + 14 * DAY };
  assert.deepEqual(computeTrialCountdown(trial, T0), { expired: false, daysRemaining: 14 });
  assert.deepEqual(computeTrialCountdown(trial, T0 + 1), { expired: false, daysRemaining: 14 });
  assert.deepEqual(computeTrialCountdown(trial, T0 + 13 * DAY + 1), { expired: false, daysRemaining: 1 });
  assert.deepEqual(computeTrialCountdown(trial, T0 + 14 * DAY - 1), { expired: false, daysRemaining: 1 });
  assert.deepEqual(computeTrialCountdown(trial, T0 + 14 * DAY), { expired: true, daysRemaining: 0 });
  assert.deepEqual(computeTrialCountdown(trial, T0 + 400 * DAY), { expired: true, daysRemaining: 0 });
});

test('18. countdown: device clock set far back is clamped to the 14-day maximum', () => {
  const trial = { startedAtMs: T0, expiresAtMs: T0 + 14 * DAY };
  assert.equal(computeTrialCountdown(trial, T0 - 365 * DAY).daysRemaining, DNS_TRIAL_DISPLAY_MAX_DAY);
});

test('18. countdown: unusable clock degrades to a plain label', () => {
  const c = computeTrialCountdown({ startedAtMs: T0, expiresAtMs: T0 + 14 * DAY }, Number.NaN);
  assert.deepEqual(c, { expired: false, daysRemaining: null });
  assert.equal(trialCountdownLabel(c), 'Free trial');
});

test('18. countdown labels', () => {
  assert.equal(trialCountdownLabel({ expired: false, daysRemaining: 14 }), 'Free trial · 14 days remaining');
  assert.equal(trialCountdownLabel({ expired: false, daysRemaining: 1 }), 'Free trial · 1 day remaining');
  assert.equal(trialCountdownLabel({ expired: true, daysRemaining: 0 }), 'Free trial ended');
});

test('18/11. the device clock never changes the access mode (no authority from the countdown)', () => {
  const state = readDnsTrialState(trialDoc());
  // Access mode takes no clock input at all; expiry only changes what is displayed.
  assert.equal(resolveDnsCourseAccessMode('not-entitled', state), 'trial');
  assert.equal(resolveDnsCourseAccessMode.length, 2);
});

test('16. pending trial intent survives the sign-in round trip (page reload / new tab)', () => {
  const storage = memoryStorage();
  writePendingTrialIntent(storage, T0);
  // Simulated reload after Google redirect / magic link, some minutes later:
  assert.equal(readPendingTrialIntent(storage, T0 + 5 * 60 * 1000), true);
  // Still there until explicitly cleared (activation success or Back).
  assert.equal(readPendingTrialIntent(storage, T0 + 10 * 60 * 1000), true);
  clearPendingTrialIntent(storage);
  assert.equal(readPendingTrialIntent(storage, T0 + 11 * 60 * 1000), false);
});

test('16. stale / malformed / future-dated intent is ignored and cleaned up', () => {
  const storage = memoryStorage();
  writePendingTrialIntent(storage, T0);
  assert.equal(readPendingTrialIntent(storage, T0 + PENDING_TRIAL_INTENT_TTL_MS), false);
  assert.equal(storage.data.size, 0);
  storage.setItem('na_pending_dns_trial', 'garbage');
  assert.equal(readPendingTrialIntent(storage, T0), false);
  storage.setItem('na_pending_dns_trial', String(T0 + DAY));
  assert.equal(readPendingTrialIntent(storage, T0), false);
});

test('16. throwing or missing storage never breaks the app', () => {
  const throwing: IntentStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => writePendingTrialIntent(throwing, T0));
  assert.equal(readPendingTrialIntent(throwing, T0), false);
  assert.doesNotThrow(() => clearPendingTrialIntent(throwing));
  assert.equal(readPendingTrialIntent(null, T0), false);
});

// --- Settings "Program Access" card ------------------------------------------------------
const withTrial = readDnsTrialState(trialDoc());
const noTrial = readDnsTrialState(undefined);
const malformedTrial = readDnsTrialState({ bases: { dns_trial: { type: 'dns_trial', startedAt: 'x' } } });

test('Settings: active trial shows "14-Day Trial" + remaining days, never "Free Tier"', () => {
  const d = resolveSettingsDnsAccessDisplay('not-entitled', null, withTrial, T0 + 5 * DAY);
  assert.equal(d.primary, '14-Day Trial');
  assert.equal(d.secondary, '9 days remaining');
  assert.notEqual(d.primary, 'Free Tier');
  assert.equal(resolveSettingsDnsAccessDisplay('not-entitled', null, withTrial, T0 + 14 * DAY - 1).secondary, '1 day remaining');
});

test('Settings: active trial remaining days never negative (clock skew either way)', () => {
  for (const now of [T0 - 365 * DAY, T0, T0 + 13.99 * DAY, T0 + 14 * DAY - 1]) {
    const d = resolveSettingsDnsAccessDisplay('not-entitled', null, withTrial, now);
    const n = Number(d.secondary?.split(' ')[0]);
    assert.ok(d.primary === '14-Day Trial' && n >= 0 && n <= 14, `${now}: ${d.secondary}`);
  }
  assert.deepEqual(resolveSettingsDnsAccessDisplay('not-entitled', null, withTrial, Number.NaN), { kind: 'trial_active', primary: '14-Day Trial', secondary: null });
});

test('Settings: expired trial shows "Trial ended" with review note', () => {
  for (const now of [T0 + 14 * DAY, T0 + 400 * DAY]) {
    assert.deepEqual(resolveSettingsDnsAccessDisplay('not-entitled', null, withTrial, now), {
      kind: 'trial_expired',
      primary: 'Trial ended',
      secondary: 'Completed lessons remain available for review.',
    });
  }
});

test('Settings: permanent Stripe ($ or $0) and beta users never get trial labels — even with an old trial record', () => {
  for (const trial of [withTrial, noTrial]) {
    for (const now of [T0, T0 + 400 * DAY]) {
      assert.deepEqual(resolveSettingsDnsAccessDisplay('entitled', 'stripe:program', trial, now), { kind: 'active', primary: 'DNS Foundations — Active', secondary: null });
      assert.deepEqual(resolveSettingsDnsAccessDisplay('entitled', 'stripe:program:zero-total-checkout', trial, now), { kind: 'active', primary: 'DNS Foundations — Active', secondary: null });
      assert.deepEqual(resolveSettingsDnsAccessDisplay('entitled', 'beta_grant', trial, now), { kind: 'beta', primary: 'DNS Foundations — Beta Access', secondary: null });
    }
  }
});

test('Settings: ordinary unentitled account (no trial, or unusable record) keeps "Free Tier", never "Trial ended"', () => {
  assert.deepEqual(resolveSettingsDnsAccessDisplay('not-entitled', null, noTrial, T0 + 400 * DAY), { kind: 'none', primary: 'Free Tier', secondary: null });
  assert.deepEqual(resolveSettingsDnsAccessDisplay('not-entitled', null, malformedTrial, T0 + 400 * DAY), { kind: 'none', primary: 'Free Tier', secondary: null });
  assert.deepEqual(resolveSettingsDnsAccessDisplay('loading', null, withTrial, T0), { kind: 'loading', primary: 'Checking…', secondary: null });
});

// --- End-of-trial copy --------------------------------------------------------------------
test('Conversion: completed Day 14 (currentDay 15) → foundation-completion copy, expired or not', () => {
  for (const expired of [false, true]) {
    const v = trialConversionVariant(15, expired);
    assert.equal(v, 'foundation_complete');
    assert.deepEqual(trialConversionCopy(v), { body: TRIAL_FOUNDATION_COMPLETE_COPY, statement: TRIAL_CONTINUE_STATEMENT });
  }
  assert.ok(TRIAL_FOUNDATION_COMPLETE_COPY.startsWith('You’ve learned to create support from both sides of your foundation.'));
});

test('Conversion: trial expired before completing Day 14 → early-expiration copy only', () => {
  for (const currentDay of [1, 6, 14]) {
    const v = trialConversionVariant(currentDay, true);
    assert.equal(v, 'expired_early');
    assert.deepEqual(trialConversionCopy(v), { body: TRIAL_EXPIRED_EARLY_COPY, statement: null });
  }
  assert.equal(TRIAL_EXPIRED_EARLY_COPY, 'Your 14-day free trial has ended. Purchase the complete program to continue from where you left off. Your progress will be preserved.');
});

test('Conversion: voluntary mid-trial upgrade makes neither boundary claim', () => {
  const v = trialConversionVariant(6, false);
  assert.equal(v, 'voluntary');
  assert.deepEqual(trialConversionCopy(v), { body: null, statement: TRIAL_CONTINUE_STATEMENT });
});

test('Review action label', () => {
  assert.equal(TRIAL_REVIEW_LABEL, 'Review completed days');
});

test('Completed-day review unchanged: Past Days = days 1..currentDay-1 (trial capped at 14)', () => {
  // Non-trial: identical to the previous DNS_COURSE.slice(0, currentDay - 1).
  for (const d of [1, 2, 15, 40, 85]) assert.equal(reviewableDayCount(d, false), d - 1);
  // Trial: completed lessons only — never uncompleted ones, never past Day 14.
  assert.equal(reviewableDayCount(1, true), 0);
  assert.equal(reviewableDayCount(6, true), 5);
  assert.equal(reviewableDayCount(15, true), 14);
  assert.equal(reviewableDayCount(30, true), 14);
});
