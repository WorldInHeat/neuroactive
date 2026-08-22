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
import { FieldValue, type Firestore } from 'firebase-admin/firestore';

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

  // Every other key shape, including any `legacy_unknown:*` key, is never authorizing.
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
