// functions/src/dnsEntitlement.ts
// Shared, server-authoritative DNS Foundations entitlement model.
//
// A uid's access is derived from zero or more independent BASES — a real Stripe
// purchase, a legitimate $0 promotional Checkout, a manual beta grant — any one of
// which is sufficient on its own. `dnsFoundationsEntitled` (the field every existing
// reader already checks — the client listener in src/App.tsx and getDnsCourseDayMedia
// below) is a derived value: true iff at least one basis is currently active. Writers
// never set that field directly; they call applyDnsEntitlementBasis to activate or
// deactivate exactly one named basis, and the effective value is recomputed from every
// basis on the document. This is what lets a full-refund revocation turn off the paid
// basis without being able to see, let alone touch, an unrelated beta_grant basis that
// also happens to be active for the same uid.
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';

const APP_ID = 'neuroactive-prod';

// The live DNS Foundations 'program' Stripe price — see PROGRAM_PRICE_LIVE in
// src/services/stripe.ts. Single source of truth: functions/src/index.ts and
// dnsCheckout.ts both import this rather than redefining it, so the grant-side and
// revoke-side provenance checks can never drift apart.
export const DNS_PROGRAM_PRICE_ID = 'price_1U4Bec2NbKaJ0YSoKoicGfHi';

export type DnsEntitlementBasisType =
  | 'stripe_program'
  | 'stripe_program_zero_total'
  | 'beta_grant'
  | 'legacy_unknown';

export type DnsEntitlementBasisInput = {
  type: DnsEntitlementBasisType;
  active: boolean;
  // Once true on a basis, that basis can never be reactivated by any later/duplicate/
  // replayed write to the same basis key — see computeAndWriteBasis. Set by
  // handleDnsRefund when a full refund is processed; nothing else in this project ever
  // sets it.
  terminal?: boolean;
  stripePaymentId?: string;
  stripeCheckoutSessionId?: string;
  cohort?: string;
  revokedReason?: string;
  amountRefunded?: number;
  stripeEventId?: string;
  needsManualReview?: boolean;
  unrecognizedLegacySource?: string;
};

export function entitlementDocRef(db: Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/entitlement/main`);
}

// Single source of truth for "is this uid DNS-entitled" — reads only the derived field,
// exactly as before this module existed. Missing document, missing field, or anything
// other than the literal boolean true all resolve to false.
export async function hasDnsEntitlement(db: Firestore, uid: string): Promise<boolean> {
  const snap = await entitlementDocRef(db, uid).get();
  return snap.exists && snap.data()?.dnsFoundationsEntitled === true;
}

// The Stripe Firebase Extension (invertase/firestore-stripe-payments) writes each
// completed Checkout Session's line items onto the payment document as `items`, with
// `item.price` as either an expanded Price object or a plain price ID string depending
// on API/expand behavior — handle both rather than assume one shape.
function lineItemPriceId(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const price = (item as { price?: unknown }).price;
  if (!price) return undefined;
  if (typeof price === 'string') return price;
  if (typeof price === 'object' && 'id' in price) return (price as { id?: unknown }).id as string;
  return undefined;
}

// Does this customers/{uid}/payments/{paymentId} document (written server-side, by the
// extension, from a verified Stripe webhook — never client-writable, see
// firestore.rules) represent a succeeded DNS Foundations purchase? Shared by
// recomputeDnsEntitlement (grant side, functions/src/index.ts) and handleDnsRefund
// (revoke side, functions/src/dnsCheckout.ts) so the two can never check different
// things for what counts as "a real DNS purchase."
export function paymentGrantsDnsFoundations(payment: FirebaseFirestore.DocumentData | undefined): boolean {
  if (!payment) return false;
  if (payment.status !== 'succeeded') return false;
  const items = Array.isArray(payment.items) ? payment.items : [];
  return items.some((item: unknown) => lineItemPriceId(item) === DNS_PROGRAM_PRICE_ID);
}

// The exact historical `source` string values this project has always written — kept
// unchanged so nothing that reads `source` for display/logging sees a different value
// than before, even though it's now computed from `bases` rather than hardcoded per call site.
function legacySourceForType(type: DnsEntitlementBasisType): string {
  switch (type) {
    case 'stripe_program':
      return 'stripe:program';
    case 'stripe_program_zero_total':
      return 'stripe:program:zero-total-checkout';
    case 'beta_grant':
      return 'beta_grant';
    case 'legacy_unknown':
      return 'legacy_unknown';
  }
}

// The single validity predicate for "does this basis entry actually authorize DNS
// access" — the only thing that may ever set dnsFoundationsEntitled true, and the only
// thing that may ever be offered as the display source. `active: true` alone is NOT
// sufficient: the basis's key, type, and provenance ID must all agree with one of the
// three recognized, structurally valid forms. Anything else — legacy_unknown, a
// key/type mismatch, a missing or mismatched provenance ID, an unrecognized type, a
// malformed key — is never authorizing, regardless of what its `active` field says.
// grantBetaEntitlement.js mirrors this exact predicate so the standalone script can
// never compute effective entitlement differently than the deployed Functions do.
function isValidActiveBasis(basisKey: string, basis: Record<string, unknown> | undefined): boolean {
  if (!basis || basis.active !== true) return false;
  // A terminally revoked basis can never authorize, independent of key/type/provenance
  // checks below — this must hold even if `active: true` is also present due to
  // malformed, historical, or otherwise corrupt state.
  if (basis.terminal === true) return false;

  if (basisKey === 'beta_grant') {
    return basis.type === 'beta_grant';
  }

  const paidPrefix = 'stripe_program:';
  if (basisKey.startsWith(paidPrefix)) {
    const paymentIntentId = basisKey.slice(paidPrefix.length);
    return (
      basis.type === 'stripe_program' &&
      paymentIntentId.length > 0 &&
      basis.stripePaymentId === paymentIntentId
    );
  }

  const zeroTotalPrefix = 'stripe_program_zero_total:';
  if (basisKey.startsWith(zeroTotalPrefix)) {
    const checkoutSessionId = basisKey.slice(zeroTotalPrefix.length);
    return (
      basis.type === 'stripe_program_zero_total' &&
      checkoutSessionId.length > 0 &&
      basis.stripeCheckoutSessionId === checkoutSessionId
    );
  }

  // Every other key shape, including any `legacy_unknown:*` key and the `dns_trial` key
  // (see the FREE TRIAL section below — a trial is time/day-limited access resolved by
  // resolveDnsAccess, never permanent entitlement), is never authorizing.
  return false;
}

// Display/log priority when more than one basis is simultaneously active (e.g. a real
// purchase AND a beta grant): a Stripe-derived basis (paid or a legitimate $0 promo)
// takes priority over a beta grant, matching the DNS_ONLY_LAUNCH account-status label in
// src/App.tsx ("DNS Foundations — Active" before "— Beta Access"). Purely cosmetic — has
// no effect on `dnsFoundationsEntitled`, which is computed from isValidActiveBasis alone.
// legacy_unknown is deliberately excluded — it never passes isValidActiveBasis, so it
// never needs a display label either.
const SOURCE_PRIORITY: DnsEntitlementBasisType[] = [
  'stripe_program',
  'stripe_program_zero_total',
  'beta_grant',
];

function pickPrimarySource(bases: Record<string, Record<string, unknown>>): string | null {
  for (const type of SOURCE_PRIORITY) {
    const hit = Object.entries(bases).find(
      ([key, b]) => b.type === type && isValidActiveBasis(key, b)
    );
    if (hit) return legacySourceForType(type);
  }
  return null;
}

// Documents written before this module existed only ever had a single flat
// {dnsFoundationsEntitled, source, stripePaymentId | stripeCheckoutSessionId | cohort}
// shape. The first basis-aware write against such a document must represent that
// implicit grant as its own basis entry before doing anything else — otherwise the
// moment a second, different basis is ever recorded, the original legacy grant would
// silently disappear from the effective computation instead of coexisting with it.
//
// Fail-closed on anything unrecognized: only the three source strings this project has
// ever actually written are migrated as ACTIVE bases. Every source string this project
// has ever written is one of those three, so hitting the fallback branch should be
// structurally unreachable — but if it's ever hit anyway (data corruption, a manual
// Console edit, anything), it is migrated INACTIVE and flagged for manual review rather
// than silently continuing to grant access from a state nothing recognizes. This can
// change dnsFoundationsEntitled from true to false for an account whose only basis was
// such a state — intentional: unknown provenance must never authorize access.
function migrateLegacyBasis(
  data: FirebaseFirestore.DocumentData
): [string, Record<string, unknown>] | null {
  if (data.bases || data.dnsFoundationsEntitled !== true || typeof data.source !== 'string') {
    return null;
  }
  const now = FieldValue.serverTimestamp();

  if (data.source === 'stripe:program' && typeof data.stripePaymentId === 'string') {
    return [
      `stripe_program:${data.stripePaymentId}`,
      {
        type: 'stripe_program',
        active: true,
        stripePaymentId: data.stripePaymentId,
        migratedFromLegacy: true,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  if (
    data.source === 'stripe:program:zero-total-checkout' &&
    typeof data.stripeCheckoutSessionId === 'string'
  ) {
    return [
      `stripe_program_zero_total:${data.stripeCheckoutSessionId}`,
      {
        type: 'stripe_program_zero_total',
        active: true,
        stripeCheckoutSessionId: data.stripeCheckoutSessionId,
        migratedFromLegacy: true,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  if (data.source === 'beta_grant') {
    return [
      'beta_grant',
      {
        type: 'beta_grant',
        active: true,
        ...(typeof data.cohort === 'string' ? { cohort: data.cohort } : {}),
        migratedFromLegacy: true,
        createdAt: now,
        updatedAt: now,
      },
    ];
  }

  console.error(
    '[DNS Entitlement] Encountered an unrecognized legacy entitlement source during migration — ' +
      'this should be structurally unreachable. Migrating as INACTIVE and flagging for manual ' +
      'review rather than continuing to grant access from an unrecognized state.',
    { source: data.source }
  );
  return [
    `legacy_unknown:${data.source}`,
    {
      type: 'legacy_unknown',
      active: false,
      needsManualReview: true,
      unrecognizedLegacySource: data.source,
      migratedFromLegacy: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
}

// The write half only — takes data already read by the caller (see
// readEntitlementForBasisUpdate below) and issues the transaction.set(). Split out so
// applyDnsEntitlementBasisWithData can compose this write into a transaction that already
// did its own reads first, without duplicating the merge/migration/recompute logic.
function computeAndWriteBasis(
  transaction: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  currentData: FirebaseFirestore.DocumentData,
  basisKey: string,
  basis: DnsEntitlementBasisInput
): { effective: boolean } {
  const bases: Record<string, Record<string, unknown>> = { ...(currentData.bases ?? {}) };

  const migrated = migrateLegacyBasis(currentData);
  if (migrated && migrated[0] !== basisKey) {
    bases[migrated[0]] = migrated[1];
  }

  const now = FieldValue.serverTimestamp();
  const existing = bases[basisKey];

  // A basis that has ever been marked terminal (a full refund) can never be reactivated
  // by a later write to the SAME basis key — regardless of what `active` that write
  // asks for. This is what stops a redelivered/replayed "payment succeeded" webhook (the
  // extension's mirrored payment document never stops saying status: succeeded after a
  // refund — refund state lives on the Charge/Refund objects, not the PaymentIntent) from
  // resurrecting access after a genuine refund, and what makes grant-then-refund and
  // refund-then-grant converge to the same final state regardless of delivery order: a
  // refund arriving before any basis exists still creates one, already sealed inactive.
  const wasSealed = existing?.terminal === true;
  if (wasSealed && basis.active === true) {
    console.warn(
      '[DNS Entitlement] Ignored an attempt to reactivate a terminally revoked basis.',
      { basisKey }
    );
  }
  const nextActive = wasSealed ? false : basis.active;

  bases[basisKey] = {
    ...(existing ?? {}),
    ...basis,
    active: nextActive,
    terminal: wasSealed || basis.terminal === true,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };

  const effective = Object.entries(bases).some(([key, b]) => isValidActiveBasis(key, b));
  const source = pickPrimarySource(bases);

  transaction.set(
    ref,
    {
      dnsFoundationsEntitled: effective,
      source,
      bases,
      updatedAt: now,
    },
    { merge: true }
  );

  return { effective };
}

// Activates or deactivates exactly one named basis (e.g. `stripe_program:pi_xxx`,
// `stripe_program_zero_total:cs_xxx`, or the single `beta_grant` key) and recomputes the
// derived `dnsFoundationsEntitled`/`source` fields from every basis currently on the
// document — every other basis is read back unchanged and rewritten as-is. Transactional
// so a concurrent call touching a different basis on the same document can never lose
// either write (Firestore retries on read/write conflict). Opens its own transaction —
// use this when the basis update is the only thing that needs to happen atomically.
export async function applyDnsEntitlementBasis(
  db: Firestore,
  uid: string,
  basisKey: string,
  basis: DnsEntitlementBasisInput
): Promise<{ effective: boolean }> {
  const ref = entitlementDocRef(db, uid);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data()! : {};
    return computeAndWriteBasis(transaction, ref, data, basisKey, basis);
  });
}

// For a caller that needs the basis update to be atomic with OTHER reads/writes in its
// own transaction (e.g. a receipt-existence check + create) — Firestore requires every
// read in a transaction to happen before any write, so the read half is split out here
// and must be called, alongside every other read the caller needs, before any writes
// (including this one) are issued. Pass the same `transaction` to both.
export async function readEntitlementForBasisUpdate(
  transaction: FirebaseFirestore.Transaction,
  db: Firestore,
  uid: string
): Promise<{ ref: FirebaseFirestore.DocumentReference; data: FirebaseFirestore.DocumentData }> {
  const ref = entitlementDocRef(db, uid);
  const snap = await transaction.get(ref);
  return { ref, data: snap.exists ? snap.data()! : {} };
}

export function applyDnsEntitlementBasisWithData(
  transaction: FirebaseFirestore.Transaction,
  ref: FirebaseFirestore.DocumentReference,
  data: FirebaseFirestore.DocumentData,
  basisKey: string,
  basis: DnsEntitlementBasisInput
): { effective: boolean } {
  return computeAndWriteBasis(transaction, ref, data, basisKey, basis);
}

// ---------------------------------------------------------------------------------------
// FREE TRIAL (no card) — Days 1–14 for 14 calendar days after explicit activation.
//
// Stored as one more entry in the same `bases` map, under the fixed key `dns_trial`, so
// it travels with every existing basis writer for free: computeAndWriteBasis and
// grantBetaEntitlement.js both copy the whole map and touch only their own key, so the
// trial record is preserved by every purchase, refund, zero-total, and beta write.
//
// It is deliberately NOT an entitlement basis in the isValidActiveBasis sense: the
// `dns_trial` key never matches any recognized key shape there, so it can never set
// `dnsFoundationsEntitled` (which keeps meaning "permanent, full-program access" for every
// existing reader — App.tsx's listener, Settings, firestore.rules). Trial access is
// resolved separately by resolveDnsAccess below, and a permanent basis always wins.
//
// The record is created exactly once per uid, by startDnsTrialForUid, from the server
// clock only — never from anything the client sends — and is never deleted, extended, or
// recreated: its presence is the durable "this uid has used its trial" marker, so signing
// out, clearing storage, switching devices, or changing the device clock cannot restart it.
// ---------------------------------------------------------------------------------------

export const DNS_TRIAL_BASIS_KEY = 'dns_trial';
export const DNS_TRIAL_DURATION_DAYS = 14;
export const DNS_TRIAL_MAX_COURSE_DAY = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// "14 calendar days after activation" = activation instant + 14 × 24h, computed on the
// server. Instant arithmetic is immune to device timezone/DST/clock changes.
export const DNS_TRIAL_DURATION_MS = DNS_TRIAL_DURATION_DAYS * MS_PER_DAY;

export type DnsAccessType = 'permanent' | 'trial_active' | 'trial_expired' | 'none';

// Sanitized access summary — the only entitlement shape returned to clients by a
// callable. Never contains Vimeo credentials, Stripe IDs, or basis internals.
export type DnsAccessStatus = {
  accessType: DnsAccessType;
  // True once this uid has ever activated a trial (including a malformed record — a
  // trial that can't be parsed still counts as used and is never recreated).
  trialUsed: boolean;
  trialStartedAt: string | null; // ISO-8601, server clock
  trialExpiresAt: string | null; // ISO-8601, server clock
  // Highest course day whose media this uid may load; null = no day limit (permanent).
  maxAccessibleDay: number | null;
  purchaseRequired: boolean;
};

type ParsedTrial = { startedAtMs: number; expiresAtMs: number };

function timestampMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
    const ms = (value as { toMillis: () => number }).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function trialRecordOf(data: FirebaseFirestore.DocumentData): unknown {
  const bases = data.bases;
  return bases && typeof bases === 'object' ? (bases as Record<string, unknown>)[DNS_TRIAL_BASIS_KEY] : undefined;
}

// Fail-closed parse: anything other than a well-formed, server-shaped record grants no
// trial access (but still counts as "used" — see trialUsed above).
function parseTrialRecord(record: unknown): ParsedTrial | null {
  if (!record || typeof record !== 'object') return null;
  const r = record as Record<string, unknown>;
  if (r.type !== 'dns_trial') return null;
  const startedAtMs = timestampMillis(r.startedAt);
  const expiresAtMs = timestampMillis(r.expiresAt);
  if (startedAtMs === null || expiresAtMs === null || expiresAtMs <= startedAtMs) return null;
  // Never trust a stored window longer than the configured one, however it got there.
  if (expiresAtMs - startedAtMs > DNS_TRIAL_DURATION_MS) return null;
  return { startedAtMs, expiresAtMs };
}

// The single authoritative resolver. `nowMs` is always the SERVER clock at the call site.
export function resolveDnsAccess(data: FirebaseFirestore.DocumentData | undefined, nowMs: number): DnsAccessStatus {
  const doc = data ?? {};
  const record = trialRecordOf(doc);
  const trialUsed = record !== undefined;
  if (doc.dnsFoundationsEntitled === true) {
    return { accessType: 'permanent', trialUsed, trialStartedAt: null, trialExpiresAt: null, maxAccessibleDay: null, purchaseRequired: false };
  }
  const trial = parseTrialRecord(record);
  if (trial) {
    return {
      accessType: nowMs < trial.expiresAtMs ? 'trial_active' : 'trial_expired',
      trialUsed: true,
      trialStartedAt: new Date(trial.startedAtMs).toISOString(),
      trialExpiresAt: new Date(trial.expiresAtMs).toISOString(),
      maxAccessibleDay: DNS_TRIAL_MAX_COURSE_DAY,
      purchaseRequired: true,
    };
  }
  return { accessType: 'none', trialUsed, trialStartedAt: null, trialExpiresAt: null, maxAccessibleDay: null, purchaseRequired: true };
}

// Media authorization for one requested course day. Permanent: any day. Active OR expired
// trial: Days 1..DNS_TRIAL_MAX_COURSE_DAY only (expired keeps review access to the same
// days). Otherwise: nothing.
export function canAccessDnsCourseDay(access: DnsAccessStatus, day: number): boolean {
  if (!Number.isInteger(day) || day < 1) return false;
  if (access.accessType === 'permanent') return true;
  if (access.accessType === 'trial_active' || access.accessType === 'trial_expired') {
    return access.maxAccessibleDay !== null && day <= access.maxAccessibleDay;
  }
  return false;
}

// Caller precondition for startDnsTrial, kept pure so it can be tested without the
// Functions runtime: a signed-in, NON-anonymous account is required, so the one-trial-per-
// uid rule binds to a durable identity rather than a throwaway anonymous session.
export type DnsTrialCaller = { uid: string; token: { firebase?: { sign_in_provider?: string } } } | undefined;
export function dnsTrialCallerError(auth: DnsTrialCaller): { code: 'unauthenticated' | 'failed-precondition'; message: string } | null {
  if (!auth) return { code: 'unauthenticated', message: 'Sign in required.' };
  const provider = auth.token.firebase?.sign_in_provider;
  if (!provider || provider === 'anonymous') {
    return { code: 'failed-precondition', message: 'Create an account or sign in to start your free trial.' };
  }
  return null;
}

export type DnsTrialStartOutcome ='started' | 'already_active' | 'already_used' | 'permanent' | 'needs_review';

// Pure decision for a start request against the CURRENT document. Never extends,
// restarts, or replaces an existing trial record — malformed included.
function decideDnsTrialStart(data: FirebaseFirestore.DocumentData, nowMs: number): DnsTrialStartOutcome {
  if (data.dnsFoundationsEntitled === true) return 'permanent';
  const record = trialRecordOf(data);
  if (record !== undefined) {
    const trial = parseTrialRecord(record);
    if (!trial) return 'needs_review';
    return nowMs < trial.expiresAtMs ? 'already_active' : 'already_used';
  }
  // Accounts an admin or the system has deliberately flagged/revoked are not silently
  // handed new access: an unreviewed legacy_unknown basis, or a pre-`bases` legacy
  // document whose dnsFoundationsEntitled was explicitly set false (the same state
  // grantBetaEntitlement.js refuses to auto-grant over, for the same reason).
  const bases = data.bases && typeof data.bases === 'object' ? (data.bases as Record<string, unknown>) : null;
  if (bases && Object.values(bases).some((b) => !!b && typeof b === 'object' && (b as { needsManualReview?: unknown }).needsManualReview === true)) {
    return 'needs_review';
  }
  if (!bases && data.dnsFoundationsEntitled === false && typeof data.source === 'string') return 'needs_review';
  return 'started';
}

// Transactional start. `now` reads the server clock and is called inside the transaction
// callback, so a retried attempt recomputes from the winner's committed state: a second,
// concurrent, or retried request for the same uid sees the first one's record and returns
// it unchanged ('already_active') instead of extending or recreating it.
export async function startDnsTrialForUid(
  db: Firestore,
  uid: string,
  now: () => Timestamp = () => Timestamp.now()
): Promise<{ outcome: DnsTrialStartOutcome; access: DnsAccessStatus }> {
  const ref = entitlementDocRef(db, uid);
  return db.runTransaction(async (transaction) => {
    const snap = await transaction.get(ref);
    const data = snap.exists ? snap.data()! : {};
    const startedAt = now();
    const nowMs = startedAt.toMillis();
    const outcome = decideDnsTrialStart(data, nowMs);
    if (outcome !== 'started') return { outcome, access: resolveDnsAccess(data, nowMs) };

    const record = {
      type: 'dns_trial',
      startedAt,
      expiresAt: Timestamp.fromMillis(nowMs + DNS_TRIAL_DURATION_MS),
      durationDays: DNS_TRIAL_DURATION_DAYS,
      maximumCourseDay: DNS_TRIAL_MAX_COURSE_DAY,
      createdAt: FieldValue.serverTimestamp(),
    };
    // Whole-map rewrite from the transaction's own read — the same pattern as
    // computeAndWriteBasis — so every other basis is preserved exactly as read.
    const bases = { ...((data.bases as Record<string, unknown> | undefined) ?? {}), [DNS_TRIAL_BASIS_KEY]: record };
    transaction.set(ref, { bases, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return { outcome, access: resolveDnsAccess({ ...data, bases }, nowMs) };
  });
}

// Exported for tests only — not part of the public callable surface. Mirrors the same
// pattern already used in dnsCheckout.ts's own __test__ bundle.
export const __test__ = {
  isValidActiveBasis,
  migrateLegacyBasis,
  pickPrimarySource,
  parseTrialRecord,
  decideDnsTrialStart,
};
