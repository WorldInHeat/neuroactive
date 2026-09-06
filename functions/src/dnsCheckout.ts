import { createHash, randomUUID } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, UserRecord } from 'firebase-admin/auth';
import { getFirestore, FieldValue, Firestore } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import Stripe from 'stripe';
import {
  applyDnsEntitlementBasis,
  applyDnsEntitlementBasisWithData,
  DNS_PROGRAM_PRICE_ID,
  readEntitlementForBasisUpdate,
} from './dnsEntitlement';
import {
  ATTRIBUTION_SCHEMA_VERSION,
  EMPTY_ATTRIBUTION_SNAPSHOT,
  sanitizeAttributionSnapshot,
  type SanitizedAttributionSnapshot,
  type SanitizedAttributionTouch,
} from './attribution';

// Matches every other server file's own local APP_ID constant (calendarSubscriptions.ts,
// dnsEntitlement.ts, notificationPreferences.ts, reminderScheduler.ts, etc.) — this
// codebase repeats it per-file rather than sharing one import.
const APP_ID = 'neuroactive-prod';

const DNS_CHECKOUT_SUCCESS_URL = 'https://neuroactivehealth.com/?payment=success';
const DNS_CHECKOUT_CANCEL_URL = 'https://neuroactivehealth.com/?payment=canceled';

// How long a single checkout "attempt" (see getOrCreateCheckoutAttempt below) stays
// eligible for reuse before a subsequent call mints a genuinely new one. Deliberately
// far shorter than Stripe's own idempotency-key retention window (~24h, undocumented
// exact value, treated as an implementation detail not to rely on) — this value only
// needs to comfortably cover realistic retry/double-click/two-tab timing (seconds), and
// staying well under Stripe's own window means this code's "is it still fresh" decision
// and Stripe's own idempotency cache can never disagree about whether a given key is
// still "live."
const DNS_CHECKOUT_ATTEMPT_TTL_MS = 30 * 60 * 1000;

// This is the API version bundled with stripe@22.5.0. Pinning it prevents the
// account's older default API version from disabling no-cost Checkout Sessions.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2026-07-29.dahlia';

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeDnsWebhookSecret = defineSecret('STRIPE_DNS_WEBHOOK_SECRET');
// Separate secret/endpoint from stripeDnsWebhookSecret above — Stripe issues a distinct
// signing secret per registered webhook endpoint, and handleDnsRefund is registered
// against a different event type (charge.refunded) than handleDnsNoCostCheckout
// (checkout.session.completed), so it needs its own endpoint and its own secret.
const stripeDnsRefundWebhookSecret = defineSecret('STRIPE_DNS_REFUND_WEBHOOK_SECRET');

if (getApps().length === 0) initializeApp();
const db = getFirestore();

type CorrelationRecord = {
  uid?: unknown;
  stripeCustomerId?: unknown;
  stripePriceId?: unknown;
  quantity?: unknown;
  mode?: unknown;
  livemode?: unknown;
  checkoutSessionId?: unknown;
  // Untrusted marketing metadata (see attribution.ts) — deliberately NOT read by
  // correlationMatches below: a differing or absent attribution snapshot must never be
  // treated as an integrity conflict, only the identity fields above are load-bearing.
  attribution?: unknown;
};

// `db` is a parameter (not the module-level Firestore instance) purely for testability —
// mirrors getOrCreateStripeCustomer/getOrCreateCheckoutAttempt's own shape above.
function userDataRef(db: Firestore, uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/userData/main`);
}

// True only for a touch that is BOTH structurally valid (already guaranteed by
// sanitizeAttributionSnapshot) AND semantically eligible to occupy the lastTouch slot —
// 'direct' is a valid touch source in general, but reduceAttributionState's own contract
// never lets a 'direct' touch become a last-touch (see isMeaningfulTouch client-side); a
// 'direct' value found sitting in the lastTouch slot violates that invariant and must be
// treated as invalid for this slot specifically, not repaired or reinterpreted.
function isEligibleLastTouch(touch: SanitizedAttributionTouch | null): touch is SanitizedAttributionTouch {
  return touch !== null && (touch.source === 'utm' || touch.source === 'referral');
}

// Deterministically selects ONE COMPLETE last-touch object — never a composite of fields
// from both sources (see the header comment on resolveCheckoutAttributionSnapshot below
// for why field-level merging is never done anywhere in this module). Only touches that
// are independently eligible (see isEligibleLastTouch) are even considered. When both
// sources have one, the one with the strictly newer capturedAt wins whole; a tie (or
// Firestore being newer-or-equal) deterministically prefers Firestore, since it is the
// more-established, cross-device source of truth once it exists — this mirrors
// firstTouch's own "existing beats fresh" bias at the tie boundary specifically, while
// still letting a genuinely newer client touch win when it truly is newer.
function selectLastTouch(
  remoteLastTouch: SanitizedAttributionTouch | null,
  clientLastTouch: SanitizedAttributionTouch | null
): SanitizedAttributionTouch | null {
  const remote = isEligibleLastTouch(remoteLastTouch) ? remoteLastTouch : null;
  const client = isEligibleLastTouch(clientLastTouch) ? clientLastTouch : null;
  if (remote && client) {
    return client.capturedAt > remote.capturedAt ? client : remote; // tie -> remote
  }
  return remote ?? client;
}

// Best-effort read of this uid's client-captured attribution (see src/services/
// attribution.ts for how the client populates it), reconciled with an OPTIONAL
// client-supplied fallback (see services/stripe.ts's checkout-time flush — a client that
// just landed and purchases immediately may not have finished writing to Firestore yet).
// Never blocks or fails checkout: a missing document, a Firestore read error, and a
// malformed/tampered value from EITHER source all degrade gracefully rather than
// throwing.
//
// sanitizeAttributionSnapshot performs an INDEPENDENT server-side re-validation of BOTH
// sources — the Firestore document was written under a client-owned Firestore rule
// (owner-write-only), which restricts WHO can write it but not WHAT shape or content it
// contains, and the request payload is raw client input by definition — neither is ever
// trusted merely because of where it came from. Critically, that validation already
// treats each touch as ONE INDIVISIBLE OBJECT (valid whole, or discarded whole) — nothing
// in this function (or sanitizeAttributionSnapshot) ever builds a hybrid touch out of
// fields taken from two different sources, since that could describe a visit that never
// actually happened (e.g. a UTM campaign paired with a landing path/timestamp from an
// unrelated direct visit).
//
// firstTouch: Firestore's entire touch wins whenever it has one (it is the more
// established, cross-device source of truth); the client payload's entire touch is used
// only when Firestore has none at all. lastTouch: see selectLastTouch above — the same
// "pick one complete object" rule, additionally scoped to touches that are actually
// eligible to be a last-touch, with a capturedAt-based freshness comparison specifically
// for this slot (since, unlike firstTouch, a genuinely newer last-touch IS the more
// useful signal for checkout-time attribution).
async function resolveCheckoutAttributionSnapshot(
  db: Firestore,
  uid: string,
  clientSuppliedRaw: unknown
): Promise<SanitizedAttributionSnapshot> {
  const nowMs = Date.now(); // shared reference so remote and client are judged against the same "now"
  const clientSanitized = sanitizeAttributionSnapshot(clientSuppliedRaw, nowMs);
  let remote: SanitizedAttributionSnapshot;
  try {
    const snap = await userDataRef(db, uid).get();
    const raw = snap.exists ? (snap.data() as Record<string, unknown> | undefined)?.attribution : undefined;
    remote = sanitizeAttributionSnapshot(raw, nowMs);
  } catch (error) {
    console.warn('[DNS Checkout] Attribution snapshot read failed; falling back to client-supplied value only.', { uid, error });
    remote = EMPTY_ATTRIBUTION_SNAPSHOT;
  }
  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    firstTouch: remote.firstTouch ?? clientSanitized.firstTouch,
    lastTouch: selectLastTouch(remote.lastTouch, clientSanitized.lastTouch),
  };
}

function stripeClient(): Stripe {
  return new Stripe(stripeSecretKey.value(), { apiVersion: STRIPE_API_VERSION });
}

function stripeObjectId(value: string | { id: string } | null): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof value.id === 'string' &&
    value.id.length > 0
  ) {
    return value.id;
  }
  return null;
}

function isCompletedNoCostPaymentSession(session: Stripe.Checkout.Session): boolean {
  return (
    session.livemode === true &&
    session.mode === 'payment' &&
    session.status === 'complete' &&
    session.amount_total === 0 &&
    session.payment_intent === null &&
    (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') &&
    stripeObjectId(session.customer) !== null
  );
}

function correlationMatches(
  correlation: CorrelationRecord | undefined,
  sessionId: string,
  uid: string,
  customerId: string
): boolean {
  return (
    correlation?.uid === uid &&
    correlation.stripeCustomerId === customerId &&
    correlation.stripePriceId === DNS_PROGRAM_PRICE_ID &&
    correlation.quantity === 1 &&
    correlation.mode === 'payment' &&
    correlation.livemode === true &&
    correlation.checkoutSessionId === sessionId
  );
}

function validStripeCustomerId(value: unknown): value is string {
  return typeof value === 'string' && /^cus_[A-Za-z0-9]+$/.test(value);
}

async function verifyStripeCustomerOwnership(
  stripe: Stripe,
  stripeCustomerId: string,
  uid: string
): Promise<string | null> {
  try {
    const customer = await stripe.customers.retrieve(stripeCustomerId);
    if (customer.deleted) return null;
    return customer.metadata.firebaseUID === uid ? customer.id : null;
  } catch (error) {
    if (
      error instanceof Stripe.errors.StripeInvalidRequestError &&
      error.code === 'resource_missing'
    ) {
      return null;
    }
    throw error;
  }
}

async function getOrCreateStripeCustomer(
  stripe: Stripe,
  uid: string,
  user: UserRecord
): Promise<string> {
  const customerRef = db.doc(`customers/${uid}`);
  const customerSnap = await customerRef.get();
  const existingStripeId = customerSnap.data()?.stripeId;
  if (validStripeCustomerId(existingStripeId)) {
    const verifiedStripeId = await verifyStripeCustomerOwnership(stripe, existingStripeId, uid);
    if (verifiedStripeId) return verifiedStripeId;
  }

  const customerParams: Stripe.CustomerCreateParams = {
    metadata: { firebaseUID: uid },
  };
  if (user.email) customerParams.email = user.email;
  if (user.displayName) customerParams.name = user.displayName;
  if (user.phoneNumber) customerParams.phone = user.phoneNumber;

  const provisioningIdentity = validStripeCustomerId(existingStripeId)
    ? existingStripeId
    : 'missing';
  const provisioningKey = createHash('sha256')
    .update(`${uid}:${provisioningIdentity}`)
    .digest('hex');

  // Stripe idempotency prevents concurrent callable invocations for the same Firebase
  // UID from creating multiple customers. Once provisioning is necessary, the transaction
  // deliberately commits this server-created ID rather than re-trusting whatever was read
  // at the top of this function, in case a concurrent writer (another invocation of this
  // same provisioning flow, or the extension's own customer-creation trigger) committed a
  // valid stripeId in the meantime — stripeId/stripeLink are themselves Admin-SDK-only,
  // write-once fields (see firestore.rules), so this is about a same-side race, not a
  // client one.
  const createdCustomer = await stripe.customers.create(customerParams, {
    idempotencyKey: `neuroactive-dns-customer-${provisioningKey}`,
  });

  return db.runTransaction(async (transaction) => {
    await transaction.get(customerRef);
    const customerRecord: Record<string, unknown> = {
      email: createdCustomer.email,
      stripeId: createdCustomer.id,
      stripeLink: `https://dashboard.stripe.com${
        createdCustomer.livemode ? '' : '/test'
      }/customers/${createdCustomer.id}`,
    };
    if (user.displayName) customerRecord.name = user.displayName;
    if (user.phoneNumber) customerRecord.phone = user.phoneNumber;
    transaction.set(customerRef, customerRecord, { merge: true });
    return createdCustomer.id;
  });
}

// Produces a Stripe idempotency key for the Checkout Session creation call, scoped to a
// single "attempt" per uid rather than the uid alone forever — see the module-level
// design note above DNS_CHECKOUT_ATTEMPT_TTL_MS. A fresh (non-expired) prior attempt for
// this uid is reused as-is, so: a client retry after an ambiguous response, a
// double-click, and two tabs racing this same call within the window all resolve to the
// SAME idempotency key — Stripe itself then guarantees at most one Checkout Session is
// ever created for that key, regardless of how many times this function executes it.
// Once the window elapses, the next call mints a genuinely new attempt (and therefore a
// new key), so an abandoned/expired attempt can never permanently block a later,
// intentional checkout.
//
// Deliberately mirrors getOrCreateStripeCustomer's own shape immediately above: a
// Firestore transaction is the concurrency boundary (real Firestore transactions retry
// automatically on conflicting concurrent reads/writes to the same document, which is
// what actually makes two truly simultaneous calls collapse onto the same attempt rather
// than a plain read-then-write race), and the key is derived from server-controlled state
// only — never a value invented independently on every invocation, and never the uid
// alone with no bound on how long it stays authoritative.
//
// `db` and `ttlMs` are parameters (rather than reading the module-level `db`/constant
// directly) purely so this function is unit-testable against a fake Firestore with a
// short TTL, without needing a real Firestore emulator or a mocked system clock; the
// production call site below always passes the real db and the real TTL.
//
// options.forceNew: Stripe's idempotency cache replays the ORIGINAL response for a reused
// key regardless of what has since happened to the object it returned — a Checkout
// Session that has since been completed, expired, or otherwise closed is still handed
// back as-is. The call site below checks the returned session's own status and, if it is
// no longer 'open', calls this again with forceNew so a stale-but-still-within-the-TTL
// attempt can never keep handing back an unusable session (or block a genuinely new one)
// for the rest of the window. A forced attempt still goes through the same transaction as
// every other path — it just skips the freshness check unconditionally.
async function getOrCreateCheckoutAttempt(
  db: Firestore,
  uid: string,
  ttlMs: number = DNS_CHECKOUT_ATTEMPT_TTL_MS,
  options?: { forceNew?: boolean }
): Promise<{ attemptId: string; idempotencyKey: string }> {
  const attemptRef = db.doc(`dnsCheckoutAttempts/${uid}`);
  const now = Date.now();
  const forceNew = options?.forceNew === true;

  const attemptId = await db.runTransaction(async (transaction) => {
    const snap = await transaction.get(attemptRef);
    const data = snap.exists ? (snap.data() as { attemptId?: unknown; createdAtMs?: unknown } | undefined) : undefined;
    const existingAttemptId = data?.attemptId;
    const existingCreatedAtMs = data?.createdAtMs;
    const isFresh =
      !forceNew &&
      typeof existingAttemptId === 'string' &&
      typeof existingCreatedAtMs === 'number' &&
      now - existingCreatedAtMs < ttlMs;

    if (isFresh) {
      // Reuse: either a retry/duplicate of the SAME logical attempt, or a genuinely
      // concurrent call racing this same transaction for the same uid.
      return existingAttemptId;
    }

    // No fresh attempt exists (first-ever call for this uid, or the previous one aged
    // out) — mint a new one. Never trusted as a security boundary; it only needs to
    // reliably distinguish "this attempt" from whatever attempt preceded it for this uid,
    // which a fresh random id does regardless of predictability.
    const newAttemptId = randomUUID();
    // A plain numeric field (createdAtMs), not FieldValue.serverTimestamp(): this value
    // is read back and compared against Date.now() in the SAME kind of check above on
    // every subsequent call, including possibly within the same transaction retry — a
    // server-timestamp sentinel doesn't resolve to a concrete value until after commit,
    // which is exactly wrong for a value this function needs to reason about immediately.
    transaction.set(attemptRef, { attemptId: newAttemptId, createdAtMs: now });
    return newAttemptId;
  });

  const idempotencyKey = createHash('sha256').update(`${uid}:${attemptId}`).digest('hex');
  return { attemptId, idempotencyKey: `neuroactive-dns-checkout-session-${idempotencyKey}` };
}

// True for the Admin SDK's "document already exists" failure from DocumentReference.create
// — checked defensively across the shapes actually observed from @google-cloud/firestore
// (a numeric gRPC code, its string alias, or a message substring) rather than committing to
// exactly one, since getting this wrong in either direction is asymmetric: a false negative
// here just falls through to the existing generic error path below (still fails closed,
// merely with a less specific log), while a false positive would have to *match* an
// unrelated error to matter at all, which none of these three signals do independently.
function isFirestoreAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (code === 6 || code === 'already-exists') return true;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /already exists/i.test(message);
}

// Idempotently records the (uid, Stripe customer, Checkout Session) correlation used by
// handleDnsNoCostCheckout to resolve identity. Never blindly overwrites: if a document is
// already there — written by an earlier invocation of this SAME attempt (retry,
// double-click, two tabs, all sharing the Stripe idempotency key and therefore the same
// session.id) — it is read back and validated with the exact same correlationMatches
// check the webhook itself uses, and an exact match is treated as idempotent success.
// A document that exists but does NOT match is a genuine integrity conflict (this
// session.id somehow correlates to a different uid/customer/price/mode than this
// invocation expects) and fails closed rather than silently reusing or overwriting it.
//
// Also closes the narrower race where the document appears AFTER this function's own
// existence check but BEFORE its own .create() call commits (two concurrent invocations
// that both observed "absent" and both proceed to create): the .create() failure is
// inspected specifically for "already exists" and, only then, re-read and validated the
// same way — every other error still fails closed as a genuine, unrecognized failure.
async function recordCheckoutCorrelation(
  db: Firestore,
  params: {
    sessionId: string;
    uid: string;
    stripeCustomerId: string;
    livemode: boolean;
    // Immutable marketing-attribution snapshot — see attribution.ts. Deliberately NOT
    // part of correlationMatches' comparison (see CorrelationRecord above): whichever
    // invocation's .create() call actually wins the race below is the one whose
    // attribution snapshot is permanently recorded. A concurrent retry that read a
    // different (or no) snapshot is treated as fully compatible regardless — first
    // successful writer wins, and this field is never re-validated or updated afterward.
    attribution: SanitizedAttributionSnapshot;
  }
): Promise<void> {
  const { sessionId, uid, stripeCustomerId, livemode, attribution } = params;
  const correlationRef = db.doc(`stripeDnsCheckoutSessions/${sessionId}`);
  const conflictError = () =>
    new HttpsError(
      'internal',
      'Checkout could not be verified. Please contact support before retrying.'
    );

  const existing = await correlationRef.get();
  if (existing.exists) {
    if (!correlationMatches(existing.data() as CorrelationRecord | undefined, sessionId, uid, stripeCustomerId)) {
      throw conflictError();
    }
    return; // Idempotent success — an earlier invocation of this same attempt already recorded this exact session.
  }

  try {
    await correlationRef.create({
      uid,
      stripeCustomerId,
      stripePriceId: DNS_PROGRAM_PRICE_ID,
      quantity: 1,
      mode: 'payment',
      livemode,
      checkoutSessionId: sessionId,
      attribution,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    if (!isFirestoreAlreadyExistsError(error)) throw error;
    // A concurrent invocation of this same attempt won the race between our own
    // existence check above and this .create() call — re-read and validate exactly as
    // above rather than assuming success outright.
    const reread = await correlationRef.get();
    if (!reread.exists || !correlationMatches(reread.data() as CorrelationRecord | undefined, sessionId, uid, stripeCustomerId)) {
      throw conflictError();
    }
  }
}

// Minimal structural subset of Stripe actually needed to create AND authoritatively
// re-read a Checkout Session — lets tests exercise the REAL call path below against a
// fake Stripe object, without needing a fake for the entire Stripe SDK surface. The real
// `Stripe` client satisfies this structurally as-is.
type CheckoutSessionCreator = {
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
        options: Stripe.RequestOptions
      ): Promise<Stripe.Checkout.Session>;
      retrieve(id: string): Promise<Stripe.Checkout.Session>;
    };
  };
};

// Resolves this uid's current checkout attempt into a USABLE outcome: either a Checkout
// Session the client should be sent to pay via, or — for a session Stripe's own
// authoritative state already shows as finished — a safe "already completed" outcome that
// reuses this app's own success destination instead of ever creating a second payable
// Checkout Session for the same one-time-access purchase.
//
// CRITICAL correctness note (this function previously checked `.status` on the object
// returned directly from stripe.checkout.sessions.create, which cannot detect a session
// that has since completed or expired — see below):
//
// Stripe's idempotency layer replays the ORIGINAL cached HTTP response body verbatim for
// a reused key: "Stripe's idempotency works by saving the resulting status code and body
// of the first request made for any given idempotency key... Subsequent requests with the
// same key return the same result." (https://docs.stripe.com/api/idempotent_requests). A
// Checkout Session is always created with status:'open' — the API reference defines
// 'open' as "Payment processing has not started" (https://docs.stripe.com/api/checkout/
// sessions/object) — so the response returned directly from create(), whether this
// particular call is a brand-new creation or an idempotency-cache replay of an old one,
// ALWAYS reports status:'open', regardless of what has actually happened to the session
// since (paid, expired, etc.). The only way to learn the session's actual current state
// is a separate, non-idempotent `retrieve` call: a GET is never cached by Stripe's
// idempotency layer ("Don't send idempotency keys in GET ... requests because it has no
// effect. These requests are idempotent by definition." — same docs page), so it always
// reflects live state. `stripe`/`db`/`ttlMs` are parameters purely for testability — the
// onCall handler below always passes the real Stripe client, the real db, and the real
// TTL.
async function createDnsCheckoutSessionCore(
  stripe: CheckoutSessionCreator,
  db: Firestore,
  uid: string,
  stripeCustomerId: string,
  ttlMs: number = DNS_CHECKOUT_ATTEMPT_TTL_MS
): Promise<{ url: string; sessionId: string; livemode: boolean }> {
  const failClosed = (detail: string, extra: Record<string, unknown>): HttpsError => {
    console.error(`[DNS Checkout] ${detail}`, extra);
    return new HttpsError('internal', 'Unable to start checkout. Please try again.');
  };

  // Creates a session for the given idempotency key, then immediately re-reads its
  // authoritative current state via `retrieve` — see the function header above for why
  // the create() response itself must never be trusted for `.status`.
  const createAndResolveLiveSession = async (key: string): Promise<Stripe.Checkout.Session> => {
    let created: Stripe.Checkout.Session;
    try {
      created = await stripe.checkout.sessions.create(
        {
          customer: stripeCustomerId,
          line_items: [{ price: DNS_PROGRAM_PRICE_ID, quantity: 1 }],
          mode: 'payment',
          allow_promotion_codes: true,
          success_url: DNS_CHECKOUT_SUCCESS_URL,
          cancel_url: DNS_CHECKOUT_CANCEL_URL,
        },
        { idempotencyKey: key }
      );
    } catch (error) {
      throw failClosed('Stripe Session creation failed.', { error });
    }
    try {
      return await stripe.checkout.sessions.retrieve(created.id);
    } catch (error) {
      throw failClosed('Stripe Session live-state retrieval failed.', { sessionId: created.id, error });
    }
  };

  // See getOrCreateCheckoutAttempt above: this makes a retry of the same logical
  // checkout attempt (client retry after an ambiguous response, a double-click, two
  // tabs racing each other) reuse the exact same Stripe idempotency key, so at most one
  // Checkout Session is ever created for it — while a genuinely later, intentional
  // checkout (after the attempt window elapses) still gets a fresh key and a fresh
  // session, exactly as before.
  let idempotencyKey: string;
  try {
    ({ idempotencyKey } = await getOrCreateCheckoutAttempt(db, uid, ttlMs));
  } catch (error) {
    throw failClosed('Checkout attempt provisioning failed.', { error });
  }

  let session = await createAndResolveLiveSession(idempotencyKey);

  if (session.status === 'expired') {
    // The attempt this uid held resolves to a session that has since expired — Stripe's
    // idempotency cache would keep handing back this same dead session (see the header
    // comment above) for the rest of the attempt TTL otherwise. Force a genuinely new
    // attempt: a brand-new idempotency key that has never been used before always yields
    // a brand-new, just-created session.
    let freshKey: string;
    try {
      ({ idempotencyKey: freshKey } = await getOrCreateCheckoutAttempt(db, uid, ttlMs, { forceNew: true }));
    } catch (error) {
      throw failClosed('Fresh checkout attempt provisioning failed.', { error });
    }
    session = await createAndResolveLiveSession(freshKey);
    if (session.status !== 'open') {
      // A session obtained through a brand-new idempotency key is, by Stripe's own
      // contract, always created 'open' — reaching here means something is badly wrong.
      // Fail closed rather than loop indefinitely.
      throw failClosed('Freshly created checkout session was not open.', {
        sessionId: session.id,
        status: session.status,
      });
    }
  }

  if (session.status === 'open') {
    if (!session.url) {
      throw failClosed('Open checkout session had no URL.', { sessionId: session.id });
    }
    return { url: session.url, sessionId: session.id, livemode: session.livemode };
  }

  if (session.status === 'complete') {
    // This is a ONE-TIME-ACCESS product: a session Stripe already reports as complete
    // must never result in a second payable Checkout Session being handed to the client —
    // that would turn an innocuous retry after a successful purchase into a second
    // purchase opportunity. Only the two payment_status values Stripe defines as "funds
    // secured, nothing further to collect" are treated as safe to short-circuit here.
    // Anything else (e.g. 'unpaid' — an async payment method still settling; the API
    // reference itself notes status:'complete' means "Payment processing may still be in
    // progress") is NOT assumed safe and fails closed instead, without ever creating
    // another session.
    if (session.payment_status === 'paid' || session.payment_status === 'no_payment_required') {
      // Entitlement fulfillment is driven asynchronously by the completion webhook and
      // may not have run yet — webhook delivery can lag — so this deliberately does not
      // wait for or assume entitlement has been granted. It only avoids ever creating a
      // second payable session for a purchase Stripe itself already reports as finished.
      // Reusing this app's own existing success destination (the same URL Stripe's own
      // success_url would have sent the customer to) means the EXISTING client contract
      // ({ url }) already handles this outcome correctly by simply navigating there — no
      // client change is required (see src/services/stripe.ts: it only ever reads
      // result.data.url and redirects to it).
      return { url: DNS_CHECKOUT_SUCCESS_URL, sessionId: session.id, livemode: session.livemode };
    }
    throw failClosed('Completed checkout session had an unexpected payment_status.', {
      sessionId: session.id,
      paymentStatus: session.payment_status,
    });
  }

  throw failClosed('Checkout session had an unexpected status.', {
    sessionId: session.id,
    status: session.status,
  });
}

export const createDnsCheckoutSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }

    const uid = request.auth.uid;
    if (request.auth.token.firebase?.sign_in_provider === 'anonymous') {
      throw new HttpsError('failed-precondition', 'Sign in before purchasing DNS Foundations.');
    }

    // Optional, additive request field — omitted entirely (request.data is undefined/null)
    // by any client that doesn't send it, which behaves identically to before this field
    // existed. See services/stripe.ts: a client that just landed and purchases
    // immediately flushes to Firestore first, but also attaches its own freshest local
    // state here as a fallback in case that flush didn't land in time. Raw, untrusted
    // client input either way — resolveCheckoutAttributionSnapshot re-validates it
    // independently, exactly like the Firestore-read path.
    const clientSuppliedAttribution = (request.data as { attribution?: unknown } | null | undefined)?.attribution;

    // Kicked off in parallel with Stripe customer/session provisioning below — a single,
    // independent, best-effort Firestore read (see resolveCheckoutAttributionSnapshot)
    // that never throws and is never awaited until the correlation record is about to be
    // written, so it adds no serial latency to the checkout path.
    const attributionPromise = resolveCheckoutAttributionSnapshot(db, uid, clientSuppliedAttribution);

    const stripe = stripeClient();
    let stripeCustomerId: string;
    try {
      const user = await getAuth().getUser(uid);
      if (user.disabled || user.providerData.length === 0) {
        throw new HttpsError('failed-precondition', 'Sign in before purchasing DNS Foundations.');
      }
      stripeCustomerId = await getOrCreateStripeCustomer(stripe, uid, user);
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error('[DNS Checkout] Stripe customer provisioning failed.', error);
      throw new HttpsError('internal', 'Unable to prepare your payment account. Please try again.');
    }

    const { url, sessionId, livemode } = await createDnsCheckoutSessionCore(stripe, db, uid, stripeCustomerId);
    const attribution = await attributionPromise;

    // This Admin-only record binds fulfillment to a Session created by this callable.
    // Firestore's default deny applies because no client rule matches this collection.
    // See recordCheckoutCorrelation above for how it safely handles a retry of the same
    // attempt (or a later, already-completed re-resolution) reaching this point a second
    // time with the same session.id.
    try {
      await recordCheckoutCorrelation(db, {
        sessionId,
        uid,
        stripeCustomerId,
        livemode,
        attribution,
      });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error('[DNS Checkout] Correlation record creation failed.', error);
      throw new HttpsError('internal', 'Unable to finalize checkout setup. Please try again.');
    }

    return { url, sessionId };
  }
);

export const handleDnsNoCostCheckout = onRequest(
  { secrets: [stripeSecretKey, stripeDnsWebhookSecret] },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.status(405).send('Method not allowed');
      return;
    }

    const signature = request.header('stripe-signature');
    if (!signature) {
      response.status(400).send('Missing Stripe signature');
      return;
    }

    const stripe = stripeClient();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.rawBody,
        signature,
        stripeDnsWebhookSecret.value()
      );
    } catch (error) {
      console.warn('[DNS Checkout] Invalid webhook signature.', error);
      response.status(400).send('Invalid Stripe signature');
      return;
    }

    if (event.type !== 'checkout.session.completed') {
      response.status(200).send('Ignored');
      return;
    }

    const eventSession = event.data.object;
    if (!isCompletedNoCostPaymentSession(eventSession)) {
      response.status(200).send('Ignored');
      return;
    }

    try {
      // Retrieve authoritative finalized state rather than relying only on the event's
      // expansion shape. listLineItems also captures promotion-adjusted final contents.
      const session = await stripe.checkout.sessions.retrieve(eventSession.id);
      if (!isCompletedNoCostPaymentSession(session)) {
        response.status(200).send('Ignored');
        return;
      }

      const customerId = stripeObjectId(session.customer);
      const eventCustomerId = stripeObjectId(eventSession.customer);
      if (!customerId || customerId !== eventCustomerId) {
        response.status(200).send('Ignored');
        return;
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(session.id, { limit: 100 });
      if (lineItems.has_more || lineItems.data.length !== 1) {
        response.status(200).send('Ignored');
        return;
      }

      const lineItem = lineItems.data[0];
      const priceId = stripeObjectId(lineItem.price);
      if (priceId !== DNS_PROGRAM_PRICE_ID || lineItem.quantity !== 1) {
        response.status(200).send('Ignored');
        return;
      }

      const customersSnap = await db
        .collection('customers')
        .where('stripeId', '==', customerId)
        .limit(2)
        .get();
      if (customersSnap.size !== 1) {
        response.status(200).send('Ignored');
        return;
      }

      const uid = customersSnap.docs[0].id;
      const correlationRef = db.doc(`stripeDnsCheckoutSessions/${session.id}`);
      const correlationSnap = await correlationRef.get();
      if (
        !correlationSnap.exists ||
        !correlationMatches(
          correlationSnap.data() as CorrelationRecord | undefined,
          session.id,
          uid,
          customerId
        )
      ) {
        response.status(200).send('Ignored');
        return;
      }

      // Same atomicity/idempotency guarantee as the original production implementation:
      // receipt existence-check-and-create and the entitlement basis write happen in one
      // transaction, so a receipt can never exist without the grant having happened (or
      // vice versa), and a replayed event sees the receipt already present and applies
      // no further writes at all. Firestore requires every read in a transaction before
      // any write, so both reads (receipt, entitlement) happen first via
      // readEntitlementForBasisUpdate, then both writes.
      const receiptRef = db.doc(`stripeDnsCheckoutReceipts/${session.id}`);
      const basisKey = `stripe_program_zero_total:${session.id}`;
      const result = await db.runTransaction(async (transaction) => {
        const receiptSnap = await transaction.get(receiptRef);
        if (receiptSnap.exists) return { granted: false };

        const entitlement = await readEntitlementForBasisUpdate(transaction, db, uid);

        transaction.create(receiptRef, {
          checkoutSessionId: session.id,
          stripeEventId: event.id,
          uid,
          stripeCustomerId: customerId,
          stripePriceId: DNS_PROGRAM_PRICE_ID,
          amountTotal: 0,
          livemode: true,
          processedAt: FieldValue.serverTimestamp(),
        });
        applyDnsEntitlementBasisWithData(transaction, entitlement.ref, entitlement.data, basisKey, {
          type: 'stripe_program_zero_total',
          active: true,
          stripeCheckoutSessionId: session.id,
        });

        return { granted: true };
      });

      response.status(200).send(result.granted ? 'Granted' : 'Already processed');
    } catch (error) {
      console.error('[DNS Checkout] No-cost fulfillment failed.', error);
      response.status(500).send('Webhook processing failed');
    }
  }
);

// A full refund of a DNS Foundations purchase revokes only the specific `stripe_program`
// basis that purchase created — never any other basis on the same uid (a beta grant, a
// separate purchase, a legitimate $0 promotional Checkout). $0 promotional completions
// are structurally exempt: Stripe never creates a PaymentIntent/Charge for a genuinely
// free Checkout Session (see handleDnsNoCostCheckout above), so a `charge.refunded` event
// can never exist for one — there is nothing for this handler to match against. Partial
// refunds are recorded but never revoke access; only a refund that returns the full
// original charge amount does. Disputes/chargebacks are deliberately not handled here.
export const handleDnsRefund = onRequest(
  { secrets: [stripeSecretKey, stripeDnsRefundWebhookSecret] },
  async (request, response) => {
    if (request.method !== 'POST') {
      response.status(405).send('Method not allowed');
      return;
    }

    const signature = request.header('stripe-signature');
    if (!signature) {
      response.status(400).send('Missing Stripe signature');
      return;
    }

    const stripe = stripeClient();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.rawBody,
        signature,
        stripeDnsRefundWebhookSecret.value()
      );
    } catch (error) {
      console.warn('[DNS Refund] Invalid webhook signature.', error);
      response.status(400).send('Invalid Stripe signature');
      return;
    }

    if (event.type !== 'charge.refunded') {
      response.status(200).send('Ignored');
      return;
    }

    const eventCharge = event.data.object;
    if (eventCharge.livemode !== true) {
      response.status(200).send('Ignored');
      return;
    }

    try {
      // Retrieve authoritative finalized state rather than relying only on the event's
      // payload — same pattern as handleDnsNoCostCheckout above.
      const charge = await stripe.charges.retrieve(eventCharge.id);
      if (charge.livemode !== true) {
        response.status(200).send('Ignored');
        return;
      }

      const paymentIntentId = stripeObjectId(charge.payment_intent);
      const customerId = stripeObjectId(charge.customer);
      if (!paymentIntentId || !customerId) {
        response.status(200).send('Ignored');
        return;
      }

      // Identity is resolved from Stripe's own Customer metadata — set once, server-side,
      // at provisioning time (getOrCreateStripeCustomer above) — never from a Firestore
      // collection query keyed on `customers/{uid}.stripeId`. That field is Admin-SDK-only
      // and write-once (see firestore.rules), so it's no longer client-forgeable, but a
      // collection-wide query for it would still depend on our own Firestore data being
      // present and correct at query time — the same category of ordering dependency the
      // provenance check above is designed to avoid. Resolving identity directly from
      // Stripe, then only ever reading `customers/{uid}` at the exact uid already
      // resolved (never a collection search), removes that dependency entirely: no other
      // document, and no Firestore write timing, can affect this outcome at all.
      const customer = await stripe.customers.retrieve(customerId);
      if (customer.deleted || typeof customer.metadata?.firebaseUID !== 'string' || !customer.metadata.firebaseUID) {
        console.warn('[DNS Refund] Stripe customer has no valid metadata.firebaseUID — cannot resolve identity.', {
          customerId,
        });
        response.status(200).send('Ignored');
        return;
      }
      const uid = customer.metadata.firebaseUID;

      // Best-effort, informational cross-check only — a direct lookup of this exact uid's
      // own document (never a collection search), so it can never be influenced by any
      // other user's document. A mismatch or missing mapping doesn't block revocation
      // (that would reintroduce the same kind of Firestore-timing dependency the identity
      // and provenance checks above are designed to avoid) but is logged loudly since it
      // indicates something worth a human look.
      const firestoreCustomerSnap = await db.doc(`customers/${uid}`).get();
      const firestoreStripeId = firestoreCustomerSnap.data()?.stripeId;
      if (firestoreStripeId !== customerId) {
        console.warn(
          '[DNS Refund] Firestore customers/{uid}.stripeId disagrees with (or is missing relative to) the Stripe-authoritative mapping — proceeding on Stripe metadata alone, but this is worth investigating.',
          { uid, customerId, firestoreStripeId: firestoreStripeId ?? null }
        );
      }

      // Provenance is established directly from Stripe's own API — never from any
      // Firestore document, including the extension's payment mirror
      // (customers/{uid}/payments/{paymentIntentId}). That mirror is written
      // asynchronously by a DIFFERENT, independently-delivered webhook endpoint and
      // offers no ordering guarantee relative to this one — Stripe delivers events to
      // each registered endpoint via its own independent HTTP request, so there is no
      // guarantee our endpoint processes a later event after the extension's endpoint
      // has finished processing an earlier one, even though Stripe generated the events
      // in the correct order. A `payment`-mode Checkout Session has exactly one
      // resulting PaymentIntent, and Stripe's Checkout Sessions List API lets that
      // relationship be queried back live, in the other direction, at any time — this is
      // a synchronous call to Stripe itself, so it can never be "not there yet" the way
      // a Firestore mirror written by separate webhook processing can.
      const sessionsForPaymentIntent = await stripe.checkout.sessions.list({
        payment_intent: paymentIntentId,
        limit: 2,
      });
      if (sessionsForPaymentIntent.data.length !== 1) {
        response.status(200).send('Ignored');
        return;
      }
      const originatingSession = sessionsForPaymentIntent.data[0];
      if (originatingSession.mode !== 'payment' || originatingSession.livemode !== true) {
        response.status(200).send('Ignored');
        return;
      }

      // The session Stripe returns for this PaymentIntent must belong to the same
      // customer as the charge being refunded — a PaymentIntent can't actually change
      // owning customer between its Checkout Session and its resulting Charge, so this
      // should never fail in practice, but it's cheap, load-bearing insurance against
      // ever sealing or reasoning about a basis using a session that turns out not to be
      // the one this specific charge/customer pairing actually belongs to.
      const sessionCustomerId = stripeObjectId(originatingSession.customer);
      if (sessionCustomerId !== customerId) {
        console.warn(
          '[DNS Refund] Originating Checkout Session customer does not match the refunded Charge customer — refusing to proceed.',
          { paymentIntentId, sessionCustomerId, chargeCustomerId: customerId }
        );
        response.status(200).send('Ignored');
        return;
      }

      const lineItems = await stripe.checkout.sessions.listLineItems(originatingSession.id, {
        limit: 100,
      });
      if (lineItems.has_more || lineItems.data.length !== 1) {
        response.status(200).send('Ignored');
        return;
      }
      const lineItem = lineItems.data[0];
      const priceId = stripeObjectId(lineItem.price);
      if (priceId !== DNS_PROGRAM_PRICE_ID || lineItem.quantity !== 1) {
        response.status(200).send('Ignored');
        return;
      }

      const basisKey = `stripe_program:${paymentIntentId}`;
      const amount = charge.amount;
      const amountRefunded = charge.amount_refunded;
      const isFullRefund = charge.refunded === true && amountRefunded === amount;

      if (!isFullRefund) {
        console.warn('[DNS Refund] Partial refund recorded — DNS entitlement unchanged.', {
          uid,
          paymentIntentId,
          amount,
          amountRefunded,
        });
        response.status(200).send('Partial refund noted, not revoked');
        return;
      }

      // `terminal: true` seals this basis permanently inactive — see
      // computeAndWriteBasis in dnsEntitlement.ts. Applied unconditionally, whether or
      // not a `stripe_program:{paymentIntentId}` basis already exists: if it doesn't
      // (this refund event arrived before recomputeDnsEntitlement ever processed the
      // grant), this creates it already-sealed, so that a later or redelivered
      // "succeeded" payment write can never activate it. If it does exist, this seals
      // it. Either way every other basis on the document (beta_grant, a $0 promotional
      // basis, a different PaymentIntent's basis) is read back unchanged.
      await applyDnsEntitlementBasis(db, uid, basisKey, {
        type: 'stripe_program',
        active: false,
        terminal: true,
        stripePaymentId: paymentIntentId,
        revokedReason: 'full_refund',
        amountRefunded,
        stripeEventId: event.id,
      });

      response.status(200).send('Revoked');
    } catch (error) {
      console.error('[DNS Refund] Refund processing failed.', error);
      response.status(500).send('Webhook processing failed');
    }
  }
);

// Exported for tests only — not part of the public callable surface.
export const __test__ = {
  getOrCreateCheckoutAttempt,
  recordCheckoutCorrelation,
  isFirestoreAlreadyExistsError,
  createDnsCheckoutSessionCore,
  DNS_CHECKOUT_SUCCESS_URL,
  resolveCheckoutAttributionSnapshot,
  userDataRef,
  APP_ID,
  correlationMatches,
};
