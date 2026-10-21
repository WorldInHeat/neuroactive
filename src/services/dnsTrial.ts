// src/services/dnsTrial.ts
// Client-side helpers for the no-card 14-day DNS free trial. DISPLAY / NAVIGATION ONLY.
//
// WARNING: nothing in this file grants access. The server is authoritative:
// functions/src/dnsEntitlement.ts (resolveDnsAccess / canAccessDnsCourseDay) decides which
// lesson media getDnsCourseDayMedia returns, and firestore.rules decides whether course
// progress may advance. The values below only decide what the UI shows; if they are wrong
// or tampered with, the worst outcome is a screen the server then refuses to back.
//
// Pure (no Firebase, no window access) so it can be unit-tested in plain Node.

// Display mirror of the server's DNS_TRIAL_MAX_COURSE_DAY — never an authorization input.
export const DNS_TRIAL_DISPLAY_MAX_DAY = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type DnsTrialInfo = { startedAtMs: number; expiresAtMs: number };

// What the entitlement document (server-written, owner-readable) says about the trial.
// `used` is true for ANY dns_trial record, malformed included, matching the server's
// one-trial-per-uid rule; `trial` is set only for a well-formed record.
export type DnsTrialState = { used: boolean; trial: DnsTrialInfo | null };

function millisOf(value: unknown): number | null {
  if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function readDnsTrialState(entitlementData: unknown): DnsTrialState {
  const bases =
    entitlementData && typeof entitlementData === 'object'
      ? (entitlementData as { bases?: unknown }).bases
      : undefined;
  const record = bases && typeof bases === 'object' ? (bases as Record<string, unknown>).dns_trial : undefined;
  if (record === undefined) return { used: false, trial: null };
  if (!record || typeof record !== 'object' || (record as { type?: unknown }).type !== 'dns_trial') {
    return { used: true, trial: null };
  }
  const startedAtMs = millisOf((record as { startedAt?: unknown }).startedAt);
  const expiresAtMs = millisOf((record as { expiresAt?: unknown }).expiresAt);
  if (startedAtMs === null || expiresAtMs === null || expiresAtMs <= startedAtMs) return { used: true, trial: null };
  return { used: true, trial: { startedAtMs, expiresAtMs } };
}

export type DnsCourseAccessMode = 'loading' | 'permanent' | 'trial' | 'none';

// Permanent entitlement always wins — a purchaser or beta user with an old trial record
// never sees trial UI.
export function resolveDnsCourseAccessMode(
  entitlementState: 'loading' | 'entitled' | 'not-entitled',
  trialState: DnsTrialState
): DnsCourseAccessMode {
  if (entitlementState === 'entitled') return 'permanent';
  if (entitlementState === 'loading') return 'loading';
  return trialState.trial ? 'trial' : 'none';
}

export type DnsTrialCountdown = {
  // Display-only "has the trial window passed" — from the server-written expiry and the
  // device clock. The server re-checks with its own clock; this never unlocks anything.
  expired: boolean;
  // Whole days left, rounded up, clamped to 0..14. null when it can't be computed sensibly
  // (unusable clock), in which case the UI shows "Free trial" without a number.
  daysRemaining: number | null;
};

export function computeTrialCountdown(trial: DnsTrialInfo, nowMs: number): DnsTrialCountdown {
  if (!Number.isFinite(nowMs)) return { expired: false, daysRemaining: null };
  const remainingMs = trial.expiresAtMs - nowMs;
  if (remainingMs <= 0) return { expired: true, daysRemaining: 0 };
  const days = Math.ceil(remainingMs / MS_PER_DAY);
  return { expired: false, daysRemaining: Math.min(Math.max(days, 0), DNS_TRIAL_DISPLAY_MAX_DAY) };
}

export function trialCountdownLabel(countdown: DnsTrialCountdown): string {
  if (countdown.expired) return 'Free trial ended';
  if (countdown.daysRemaining === null) return 'Free trial';
  return `Free trial · ${countdown.daysRemaining} ${countdown.daysRemaining === 1 ? 'day' : 'days'} remaining`;
}

// --- Settings "Program Access" card (display only) -------------------------------------
// Reproduces the existing Settings labels exactly for loading / permanent (Stripe paid or
// $0) / beta / ordinary unentitled accounts, and adds the two trial states. An expired-
// trial label requires an actual well-formed trial record — an unentitled account that
// never started a trial keeps "Free Tier".
export type SettingsDnsAccessDisplay = {
  kind: 'loading' | 'active' | 'beta' | 'trial_active' | 'trial_expired' | 'none';
  primary: string;
  secondary: string | null;
};

export function resolveSettingsDnsAccessDisplay(
  entitlementState: 'loading' | 'entitled' | 'not-entitled',
  entitlementSource: string | null,
  trialState: DnsTrialState,
  nowMs: number
): SettingsDnsAccessDisplay {
  if (entitlementState === 'loading') return { kind: 'loading', primary: 'Checking…', secondary: null };
  if (entitlementState === 'entitled') {
    return entitlementSource === 'beta_grant'
      ? { kind: 'beta', primary: 'DNS Foundations — Beta Access', secondary: null }
      : { kind: 'active', primary: 'DNS Foundations — Active', secondary: null };
  }
  if (trialState.trial) {
    const countdown = computeTrialCountdown(trialState.trial, nowMs);
    if (countdown.expired) {
      return { kind: 'trial_expired', primary: 'Trial ended', secondary: 'Completed lessons remain available for review.' };
    }
    return {
      kind: 'trial_active',
      primary: '14-Day Trial',
      secondary:
        countdown.daysRemaining === null
          ? null
          : `${countdown.daysRemaining} ${countdown.daysRemaining === 1 ? 'day' : 'days'} remaining`,
    };
  }
  return { kind: 'none', primary: 'Free Tier', secondary: null };
}

// --- End-of-trial (conversion) screen copy ----------------------------------------------
// dnsCourse.currentDay is the next lesson NOT yet completed (see dnsCourseProgression.ts:
// completing Day N sets currentDay = N + 1), so Day 14 is completed exactly when
// currentDay > 14. That is the authoritative signal — completionDates is not backfilled
// for history before 2026-08-13, so it can't be used to decide this.
export const TRIAL_REVIEW_LABEL = 'Review completed days';
export const TRIAL_FOUNDATION_COMPLETE_COPY =
  'You’ve learned to create support from both sides of your foundation. The full program now carries that control into turning, sitting, kneeling, crawling, transitioning, standing, and integrated movement flows.';
export const TRIAL_CONTINUE_STATEMENT =
  'Purchase the complete 12-week program to continue with Days 15–84. Your progress will be preserved.';
export const TRIAL_EXPIRED_EARLY_COPY =
  'Your 14-day free trial has ended. Purchase the complete program to continue from where you left off. Your progress will be preserved.';

export type TrialConversionVariant = 'foundation_complete' | 'expired_early' | 'voluntary';

// 'voluntary' = opened from "Unlock full program" mid-trial (Day 14 not completed, trial
// not over) — neither boundary statement is true yet, so only the continuation statement
// is shown.
export function trialConversionVariant(currentDay: number, trialExpired: boolean): TrialConversionVariant {
  if (currentDay > DNS_TRIAL_DISPLAY_MAX_DAY) return 'foundation_complete';
  if (trialExpired) return 'expired_early';
  return 'voluntary';
}

export function trialConversionCopy(variant: TrialConversionVariant): { body: string | null; statement: string | null } {
  switch (variant) {
    case 'foundation_complete':
      return { body: TRIAL_FOUNDATION_COMPLETE_COPY, statement: TRIAL_CONTINUE_STATEMENT };
    case 'expired_early':
      return { body: TRIAL_EXPIRED_EARLY_COPY, statement: null };
    case 'voluntary':
      return { body: null, statement: TRIAL_CONTINUE_STATEMENT };
  }
}

// Past Days lists exactly the completed lessons (1..currentDay-1) — unchanged existing
// behavior — capped at the trial's last day for trial users.
export function reviewableDayCount(currentDay: number, trialMode: boolean): number {
  const completed = Math.max(currentDay - 1, 0);
  return trialMode ? Math.min(completed, DNS_TRIAL_DISPLAY_MAX_DAY) : completed;
}

// --- Pending "start my trial" intent ---------------------------------------------------
// Remembers that the visitor pressed the landing page's trial CTA, so the intent survives
// the sign-in round trip (Google redirect reloads the page; an email link may open a new
// tab). It never starts a trial by itself — it only returns the user to the explicit
// "Begin my free 14 days" confirmation. localStorage (not sessionStorage) so a new tab
// opened from an email link still sees it; expires after an hour so a stale intent can't
// resurface days later.
export const PENDING_TRIAL_INTENT_KEY = 'na_pending_dns_trial';
export const PENDING_TRIAL_INTENT_TTL_MS = 60 * 60 * 1000;

export type IntentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function writePendingTrialIntent(storage: IntentStorage | null, nowMs: number): void {
  try {
    storage?.setItem(PENDING_TRIAL_INTENT_KEY, String(nowMs));
  } catch {
    // best-effort only
  }
}

export function clearPendingTrialIntent(storage: IntentStorage | null): void {
  try {
    storage?.removeItem(PENDING_TRIAL_INTENT_KEY);
  } catch {
    // best-effort only
  }
}

export function readPendingTrialIntent(storage: IntentStorage | null, nowMs: number): boolean {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PENDING_TRIAL_INTENT_KEY) ?? null;
  } catch {
    return false;
  }
  if (raw === null) return false;
  const savedAt = Number(raw);
  const fresh = Number.isFinite(savedAt) && savedAt <= nowMs && nowMs - savedAt < PENDING_TRIAL_INTENT_TTL_MS;
  if (!fresh) clearPendingTrialIntent(storage);
  return fresh;
}
