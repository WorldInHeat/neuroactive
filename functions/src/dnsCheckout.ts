import { createHash } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, UserRecord } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import Stripe from 'stripe';
import {
  applyDnsEntitlementBasis,
  applyDnsEntitlementBasisWithData,
  DNS_PROGRAM_PRICE_ID,
  readEntitlementForBasisUpdate,
} from './dnsEntitlement';

const DNS_CHECKOUT_SUCCESS_URL = 'https://neuroactivehealth.com/?payment=success';
const DNS_CHECKOUT_CANCEL_URL = 'https://neuroactivehealth.com/?payment=canceled';

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
};

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

    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.create({
        customer: stripeCustomerId,
        line_items: [{ price: DNS_PROGRAM_PRICE_ID, quantity: 1 }],
        mode: 'payment',
        allow_promotion_codes: true,
        success_url: DNS_CHECKOUT_SUCCESS_URL,
        cancel_url: DNS_CHECKOUT_CANCEL_URL,
      });
    } catch (error) {
      console.error('[DNS Checkout] Stripe Session creation failed.', error);
      throw new HttpsError('internal', 'Unable to start checkout. Please try again.');
    }

    if (!session.url) {
      throw new HttpsError('internal', 'Stripe did not return a Checkout URL.');
    }

    // This Admin-only record binds fulfillment to a Session created by this callable.
    // Firestore's default deny applies because no client rule matches this collection.
    try {
      await db.doc(`stripeDnsCheckoutSessions/${session.id}`).create({
        uid,
        stripeCustomerId,
        stripePriceId: DNS_PROGRAM_PRICE_ID,
        quantity: 1,
        mode: 'payment',
        livemode: session.livemode,
        checkoutSessionId: session.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    } catch (error) {
      console.error('[DNS Checkout] Correlation record creation failed.', error);
      throw new HttpsError('internal', 'Unable to finalize checkout setup. Please try again.');
    }

    return { url: session.url, sessionId: session.id };
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
