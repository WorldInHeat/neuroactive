// src/services/attribution.ts
//
// First-party, privacy-conscious marketing attribution. Captures AT MOST: a sanitized
// external-referrer hostname, the five standard UTM parameters, and the landing path —
// never the full URL, never arbitrary query parameters, never IP/user-agent/device data.
// See PrivacyPolicyPage.tsx's "Marketing Attribution" disclosure, which this collection
// must stay within.
//
// This is explicitly UNTRUSTED, client-supplied marketing metadata. It must never be
// treated as authorization evidence and must never influence price, entitlement, payment,
// or access anywhere in this app — see functions/src/attribution.ts and
// functions/src/dnsCheckout.ts's read-only, best-effort use of it at checkout-creation
// time, which independently re-validates everything read back rather than trusting this
// module's own output (this module runs in the customer's own browser and could in
// principle be tampered with before it ever reaches Firestore).
//
// Pure functions (buildAttributionTouch, isMeaningfulTouch, reduceAttributionState,
// parsePersistedState, computeNextLocalState) take explicit inputs instead of reading
// window/document/localStorage directly, so they're fully unit-testable with plain Node —
// no DOM/jsdom required. Only captureLandingSignalOnce (the real call site, from App.tsx)
// touches the actual browser globals, and is a thin, deliberately-untested wrapper around
// the tested pure pieces.

export const ATTRIBUTION_SCHEMA_VERSION = 1 as const;

const MAX_UTM_LEN = 100;
const MAX_HOSTNAME_LEN = 128;
const MAX_PATH_LEN = 200;
const MIN_PLAUSIBLE_CAPTURED_AT_MS = Date.UTC(2020, 0, 1);
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

const ALLOWED_UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'] as const;
type UtmKey = (typeof ALLOWED_UTM_KEYS)[number];

// Domains this app itself is served from — navigating between them (INCLUDING legitimate
// subdomains, e.g. app.neuroactivehealth.com) is never a new acquisition source.
// neuroactivefitness.com (the separate marketing site) is DELIBERATELY excluded: it is one
// of the acquisition sources this system needs to be able to attribute, not an internal
// domain of the app.
const INTERNAL_HOSTNAMES = ['neuroactivehealth.com', 'neuroactive.web.app', 'neuroactive.firebaseapp.com', 'localhost', '127.0.0.1'];

// Exact-host-or-dot-suffix boundary matching ONLY — deliberately not substring matching.
// 'evilneuroactivehealth.com' must NOT match 'neuroactivehealth.com': the character
// immediately before the candidate suffix has to be a literal '.' (a real subdomain
// boundary), which `'.' + base` enforces — a bare `.endsWith(base)` would not.
export function isInternalHostname(hostname: string): boolean {
  return INTERNAL_HOSTNAMES.some((base) => hostname === base || hostname.endsWith(`.${base}`));
}

// Best-effort, corrigible human label for a REFERRAL source only — a UTM source value is
// already its own clear, direct label and is never re-labeled here. Small and exact-match
// only (never substring/heuristic matching on arbitrary hostnames), so an incorrect label
// can never be produced from unexpected input. The sanitized raw hostname is always
// preserved alongside it regardless, so a future, larger classification pass can always
// improve on this without any data having been lost.
const REFERRAL_SOURCE_LABELS: Record<string, string> = {
  'instagram.com': 'Instagram',
  'www.instagram.com': 'Instagram',
  'l.instagram.com': 'Instagram',
  'youtube.com': 'YouTube',
  'www.youtube.com': 'YouTube',
  'youtu.be': 'YouTube',
  'm.youtube.com': 'YouTube',
  'google.com': 'Google',
  'www.google.com': 'Google',
  'facebook.com': 'Facebook',
  'www.facebook.com': 'Facebook',
  'm.facebook.com': 'Facebook',
  'l.facebook.com': 'Facebook',
  'substack.com': 'Substack',
  'neuroactivefitness.com': 'NeuroActive Website',
  'www.neuroactivefitness.com': 'NeuroActive Website',
};

export type AttributionSource = 'utm' | 'referral' | 'direct';

export type AttributionTouch = {
  v: typeof ATTRIBUTION_SCHEMA_VERSION;
  landingPath: string;
  referrerHostname: string | null;
  utmSource: string | null;
  utmMedium: string | null;
  utmCampaign: string | null;
  utmContent: string | null;
  utmTerm: string | null;
  source: AttributionSource;
  sourceLabel: string | null;
  capturedAt: number; // ms epoch, client clock — untrusted, informational only
};

export type AttributionState = {
  v: typeof ATTRIBUTION_SCHEMA_VERSION;
  firstTouch: AttributionTouch | null;
  lastTouch: AttributionTouch | null;
};

export const EMPTY_ATTRIBUTION_STATE: AttributionState = {
  v: ATTRIBUTION_SCHEMA_VERSION,
  firstTouch: null,
  lastTouch: null,
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

function isSafeString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !CONTROL_CHAR_RE.test(value);
}

function truncate(value: string, maxLen: number): string {
  return value.length > maxLen ? value.slice(0, maxLen) : value;
}

function sanitizeUtmValue(raw: string | null): string | null {
  if (raw === null || !isSafeString(raw)) return null;
  return truncate(raw, MAX_UTM_LEN);
}

function sanitizePath(raw: string): string {
  if (!isSafeString(raw)) return '/';
  // Fragments/query strings must never reach here — callers are expected to pass
  // pathname only, but this strips and truncates defensively regardless.
  const noFragmentOrQuery = raw.split('#')[0].split('?')[0];
  return truncate(noFragmentOrQuery || '/', MAX_PATH_LEN);
}

function sanitizeReferrerHostname(referrer: string): string | null {
  if (!referrer || !isSafeString(referrer)) return null;
  let hostname: string;
  try {
    hostname = new URL(referrer).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!hostname || !isSafeString(hostname)) return null;
  if (isInternalHostname(hostname)) return null; // internal navigation, not an external referrer
  return truncate(hostname, MAX_HOSTNAME_LEN);
}

function parseAllowlistedUtm(search: string): Record<UtmKey, string | null> {
  const result = {
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
  } as Record<UtmKey, string | null>;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(search);
  } catch {
    return result;
  }
  for (const key of ALLOWED_UTM_KEYS) {
    result[key] = sanitizeUtmValue(params.get(key));
  }
  return result;
}

function deriveSourceLabel(source: AttributionSource, referrerHostname: string | null): string | null {
  if (source !== 'referral' || !referrerHostname) return null;
  return REFERRAL_SOURCE_LABELS[referrerHostname] ?? null;
}

// Pure core: builds one touch from explicit inputs. No DOM access.
export function buildAttributionTouch(input: {
  pathname: string;
  search: string;
  referrer: string;
  now: number;
}): AttributionTouch {
  const utm = parseAllowlistedUtm(input.search);
  const hasUtm = Object.values(utm).some((v) => v !== null);
  const referrerHostname = sanitizeReferrerHostname(input.referrer);

  const source: AttributionSource = hasUtm ? 'utm' : referrerHostname ? 'referral' : 'direct';

  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    landingPath: sanitizePath(input.pathname),
    referrerHostname,
    utmSource: utm.utm_source,
    utmMedium: utm.utm_medium,
    utmCampaign: utm.utm_campaign,
    utmContent: utm.utm_content,
    utmTerm: utm.utm_term,
    source,
    sourceLabel: deriveSourceLabel(source, referrerHostname),
    capturedAt: input.now,
  };
}

// Explicit UTM parameters or a real external referrer — never plain 'direct' — is what
// SOURCE CLASSIFICATION and the last-touch overwrite rule both call "meaningful."
export function isMeaningfulTouch(touch: AttributionTouch): boolean {
  return touch.source === 'utm' || touch.source === 'referral';
}

// Pure reducer: given whatever state already exists (local OR remote — same shape either
// way) and a freshly captured touch for THIS page load, returns the next state. First
// touch is write-once (never overwritten once present, in EITHER argument); last touch is
// overwritten only when the fresh touch is meaningful — ordinary internal navigation and
// direct refreshes (both classified 'direct') leave both fields untouched.
export function reduceAttributionState(existing: AttributionState, freshTouch: AttributionTouch): AttributionState {
  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    firstTouch: existing.firstTouch ?? freshTouch,
    lastTouch: isMeaningfulTouch(freshTouch) ? freshTouch : existing.lastTouch,
  };
}

function isValidNullableString(value: unknown, maxLen: number): boolean {
  return value === null || (isSafeString(value) && value.length <= maxLen);
}

function isValidTouchShape(value: unknown, nowMs: number): value is AttributionTouch {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  const structurallyValid = (
    t.v === ATTRIBUTION_SCHEMA_VERSION &&
    isSafeString(t.landingPath) && t.landingPath.length <= MAX_PATH_LEN &&
    isValidNullableString(t.referrerHostname, MAX_HOSTNAME_LEN) &&
    isValidNullableString(t.utmSource, MAX_UTM_LEN) &&
    isValidNullableString(t.utmMedium, MAX_UTM_LEN) &&
    isValidNullableString(t.utmCampaign, MAX_UTM_LEN) &&
    isValidNullableString(t.utmContent, MAX_UTM_LEN) &&
    isValidNullableString(t.utmTerm, MAX_UTM_LEN) &&
    (t.source === 'utm' || t.source === 'referral' || t.source === 'direct') &&
    isValidNullableString(t.sourceLabel, MAX_UTM_LEN) &&
    Number.isSafeInteger(t.capturedAt) &&
    (t.capturedAt as number) >= MIN_PLAUSIBLE_CAPTURED_AT_MS &&
    (t.capturedAt as number) <= nowMs + MAX_CLOCK_SKEW_MS
  );
  if (!structurallyValid) return false;
  const hasUtm = [t.utmSource, t.utmMedium, t.utmCampaign, t.utmContent, t.utmTerm].some((field) => field !== null);
  if (t.source === 'utm') return hasUtm && t.sourceLabel === null;
  if (t.source === 'referral') return !hasUtm && t.referrerHostname !== null;
  return !hasUtm && t.referrerHostname === null && t.sourceLabel === null;
}

export function validateAttributionState(raw: unknown, nowMs: number = Date.now()): AttributionState {
  if (!raw || typeof raw !== 'object') return EMPTY_ATTRIBUTION_STATE;
  const p = raw as Record<string, unknown>;
  if (p.v !== ATTRIBUTION_SCHEMA_VERSION) return EMPTY_ATTRIBUTION_STATE;
  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    firstTouch: isValidTouchShape(p.firstTouch, nowMs) ? p.firstTouch : null,
    lastTouch: isValidTouchShape(p.lastTouch, nowMs) ? p.lastTouch : null,
  };
}

// Pure parse of whatever raw string was (or wasn't) found in localStorage. Malformed JSON,
// a wrong schema version, or an unexpected shape all degrade to EMPTY_STATE rather than
// throwing — a corrupted/foreign value in this key must never crash capture.
export function parsePersistedState(raw: string | null): AttributionState {
  if (!raw) return EMPTY_ATTRIBUTION_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_ATTRIBUTION_STATE;
  }
  return validateAttributionState(parsed);
}

// Pure: raw persisted string + this load's touch -> next state to persist. Isolates the
// "parse then reduce" decision from the actual localStorage I/O for full testability.
export function computeNextLocalState(existingRaw: string | null, touch: AttributionTouch): AttributionState {
  return reduceAttributionState(parsePersistedState(existingRaw), touch);
}

const STORAGE_KEY = 'na_attribution_v1';

// The one impure entry point, called exactly once per page load from App.tsx (as early as
// possible — before any internal view-state changes, though this app has no real routing,
// so window.location/document.referrer never change during a page's lifetime anyway).
// Never throws: a blocked/unavailable localStorage degrades to "captured for this page
// load only, not persisted" — nothing about checkout or any other feature depends on this
// succeeding.
export function captureLandingSignalOnce(): AttributionTouch {
  const touch = buildAttributionTouch({
    pathname: window.location.pathname,
    search: window.location.search,
    referrer: document.referrer,
    now: Date.now(),
  });
  try {
    const existingRaw = window.localStorage.getItem(STORAGE_KEY);
    const next = computeNextLocalState(existingRaw, touch);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort only
  }
  return touch;
}

// Reads back whatever is currently persisted locally, without mutating anything — used at
// checkout time to attach the freshest known local state to the callable request as a
// fallback source (see services/stripe.ts), for the case where the Firestore flush below
// didn't land in time. Never throws: blocked/unavailable localStorage degrades to empty.
export function readLocalAttributionState(): AttributionState {
  try {
    return parsePersistedState(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return EMPTY_ATTRIBUTION_STATE;
  }
}

// Generic atomic remote I/O. The real call sites implement this with a Firestore
// transaction, so concurrent tabs cannot both read an absent firstTouch and then
// overwrite each other's independently captured visit.
export type RemoteAttributionIO = {
  runAtomicUpdate: (update: (existing: AttributionState) => AttributionState) => Promise<AttributionState>;
};

// Transactionally reads whatever this uid's document currently holds, reduces in the given fresh touch
// (using the EXACT same reducer local persistence uses, so the two layers can never
// disagree about when it's OK to overwrite last-touch), and writes back only if the
// result actually changed anything. Returns the resulting state either way. Callers
// decide how to bound/guard failures (see bestEffortReconcileWithTimeout below) — this
// function itself propagates a genuine I/O error rather than swallowing it, so it stays
// usable both for the best-effort checkout-time flush and for a caller that DOES want to
// know whether it succeeded (e.g. tests).
export async function reconcileRemoteAttribution(io: RemoteAttributionIO, touch: AttributionTouch): Promise<AttributionState> {
  return io.runAtomicUpdate((existing) => reduceAttributionState(existing, touch));
}

// Best-effort, TIME-BOUNDED wrapper around reconcileRemoteAttribution for the one call
// site that must never meaningfully delay anything it precedes (checkout) and must never
// throw: a slow/blocked/offline Firestore degrades to "gave up after timeoutMs," not an
// error and not an indefinite wait. Deliberately a single attempt — no retry loop, so a
// slow backend can cost at most timeoutMs, never more.
export async function bestEffortReconcileWithTimeout(
  io: RemoteAttributionIO,
  touch: AttributionTouch,
  timeoutMs: number
): Promise<void> {
  await Promise.race([
    reconcileRemoteAttribution(io, touch).then(
      () => undefined,
      () => undefined // swallow: best-effort only, caller must never see this fail
    ),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}

// The orchestration this round's "fast-checkout attribution gap" fix is built on: attempt
// the flush, let it settle (success, failure, OR timeout — all three are "settled"), THEN
// invoke checkout — exactly once, regardless of how the flush went. Kept as its own pure,
// injectable-dependency function (rather than inlined in services/stripe.ts) specifically
// so the ORDERING and EXACTLY-ONCE guarantees are directly testable with fake flush/
// invokeCheckout callbacks, without needing real Firebase/network calls.
export async function checkoutWithAttributionFlush<T>(flush: () => Promise<void>, invokeCheckout: () => Promise<T>): Promise<T> {
  try {
    await flush();
  } catch {
    // best-effort only — attribution persistence failure must never block checkout
  }
  return invokeCheckout();
}
