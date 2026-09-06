// functions/src/attribution.ts
//
// Independent SERVER-SIDE re-validation of the client-captured marketing-attribution
// snapshot (see src/services/attribution.ts for the client-side capture/schema this
// mirrors). The client's Firestore document is owner-write-only (see firestore.rules'
// artifacts/{appId}/users/{uid}/userData/{doc} rule), which restricts WHO can write it but
// not WHAT shape or content it contains — a modified client could write anything. This
// module re-validates from scratch rather than trusting it merely because it came from
// Firestore.
//
// Attribution is explicitly UNTRUSTED, best-effort marketing metadata: every function here
// discards anything malformed rather than throwing, and nothing in this file ever affects
// price, entitlement, payment, or Checkout Session behavior — see dnsCheckout.ts's
// read-only, best-effort use of sanitizeAttributionSnapshot's output.

export const ATTRIBUTION_SCHEMA_VERSION = 1 as const;

const MAX_UTM_LEN = 100;
const MAX_HOSTNAME_LEN = 128;
const MAX_PATH_LEN = 200;
const ALLOWED_SOURCES = new Set(['utm', 'referral', 'direct']);

// capturedAt sanity bounds — a "defensible time range," not a precise clock check (this
// value is client-clock-sourced and never trusted for anything beyond a coarse freshness
// comparison at checkout time; see selectLastTouch in dnsCheckout.ts). Floor: well before
// this feature (or the app) existed, so a negative/near-zero/garbage value can never pass.
// Ceiling: "now" plus a generous clock-skew allowance, so a genuinely misconfigured device
// clock isn't punished, while an absurd/attacker-crafted far-future value (e.g. intended to
// always "win" a freshness comparison) is rejected outright.
const MIN_PLAUSIBLE_CAPTURED_AT_MS = Date.UTC(2020, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

function isValidCapturedAt(value: unknown, nowMs: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MIN_PLAUSIBLE_CAPTURED_AT_MS &&
    value <= nowMs + MAX_CLOCK_SKEW_MS
  );
}

export type SanitizedAttributionTouch = {
  v: typeof ATTRIBUTION_SCHEMA_VERSION;
  landingPath: string;
  referrerHostname: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  source: 'utm' | 'referral' | 'direct';
  sourceLabel: string | null;
  capturedAt: number;
};

export type SanitizedAttributionSnapshot = {
  v: typeof ATTRIBUTION_SCHEMA_VERSION;
  firstTouch: SanitizedAttributionTouch | null;
  lastTouch: SanitizedAttributionTouch | null;
};

export const EMPTY_ATTRIBUTION_SNAPSHOT: SanitizedAttributionSnapshot = {
  v: ATTRIBUTION_SCHEMA_VERSION,
  firstTouch: null,
  lastTouch: null,
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function isSafeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !CONTROL_CHAR_RE.test(value);
}

function truncatedOrNull(value: unknown, maxLen: number): string | null {
  if (!isSafeString(value)) return null;
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

// Same rule as every nullable field: not present -> null; present but invalid -> null
// (dropped, never thrown); present and valid -> truncated to the conservative limit.
function nullableTruncated(value: unknown, maxLen: number): string | null {
  if (value === null || typeof value === 'undefined') return null;
  return truncatedOrNull(value, maxLen);
}

function sanitizeTouch(raw: unknown, nowMs: number): SanitizedAttributionTouch | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;

  if (t.v !== ATTRIBUTION_SCHEMA_VERSION) return null;
  if (!isValidCapturedAt(t.capturedAt, nowMs)) return null;
  if (typeof t.source !== 'string' || !ALLOWED_SOURCES.has(t.source)) return null;

  const landingPath = truncatedOrNull(t.landingPath, MAX_PATH_LEN);
  if (landingPath === null) return null; // required, non-nullable client-side — malformed if absent/invalid

  const touch: SanitizedAttributionTouch = {
    v: ATTRIBUTION_SCHEMA_VERSION,
    landingPath,
    referrerHostname: nullableTruncated(t.referrerHostname, MAX_HOSTNAME_LEN),
    utmSource: nullableTruncated(t.utmSource, MAX_UTM_LEN),
    utmMedium: nullableTruncated(t.utmMedium, MAX_UTM_LEN),
    utmCampaign: nullableTruncated(t.utmCampaign, MAX_UTM_LEN),
    utmContent: nullableTruncated(t.utmContent, MAX_UTM_LEN),
    utmTerm: nullableTruncated(t.utmTerm, MAX_UTM_LEN),
    source: t.source as 'utm' | 'referral' | 'direct',
    sourceLabel: nullableTruncated(t.sourceLabel, MAX_UTM_LEN),
    capturedAt: t.capturedAt,
  };
  const hasUtm = [touch.utmSource, touch.utmMedium, touch.utmCampaign, touch.utmContent, touch.utmTerm]
    .some((field) => field !== null);
  if (touch.source === 'utm' && (!hasUtm || touch.sourceLabel !== null)) return null;
  if (touch.source === 'referral' && (hasUtm || touch.referrerHostname === null)) return null;
  if (touch.source === 'direct' && (hasUtm || touch.referrerHostname !== null || touch.sourceLabel !== null)) return null;
  return touch;
}

// Re-validates a full { firstTouch, lastTouch } snapshot read from a client-owned
// Firestore document OR a raw client-supplied request payload. Anything malformed,
// oversized, wrongly-typed, or otherwise invalid causes the WHOLE touch it belongs to to
// be dropped (this function never patches a touch back together field-by-field — see
// dnsCheckout.ts's resolveCheckoutAttributionSnapshot/selectLastTouch for why: an
// AttributionTouch is treated as one indivisible validated object, never a bag of
// independently-repairable fields), never thrown — a completely absent/garbled document
// degrades to EMPTY_ATTRIBUTION_SNAPSHOT, never an error.
//
// `nowMs` defaults to the real clock and is a parameter purely for testability (deterministic
// "absurd future timestamp" tests) — mirrors this codebase's established
// injectable-dependency convention (see e.g. getOrCreateCheckoutAttempt's db/ttlMs params).
export function sanitizeAttributionSnapshot(raw: unknown, nowMs: number = Date.now()): SanitizedAttributionSnapshot {
  if (!raw || typeof raw !== 'object') return EMPTY_ATTRIBUTION_SNAPSHOT;
  const r = raw as Record<string, unknown>;
  if (r.v !== ATTRIBUTION_SCHEMA_VERSION) return EMPTY_ATTRIBUTION_SNAPSHOT;
  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    firstTouch: sanitizeTouch(r.firstTouch, nowMs),
    lastTouch: sanitizeTouch(r.lastTouch, nowMs),
  };
}
