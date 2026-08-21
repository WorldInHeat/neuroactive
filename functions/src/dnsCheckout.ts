import { createHash } from 'node:crypto';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth, UserRecord } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { defineSecret } from 'firebase-functions/params';
import { HttpsError, onCall, onRequest } from 'firebase-functions/v2/https';
import Stripe from 'stripe';

const APP_ID = 'neuroactive-prod';
const DNS_PROGRAM_PRICE_ID = 'price_1U4Bec2NbKaJ0YSoKoicGfHi';
const DNS_CHECKOUT_SUCCESS_URL = 'https://neuroactivehealth.com/?payment=success';
const DNS_CHECKOUT_CANCEL_URL = 'https://neuroactivehealth.com/?payment=canceled';

// This is the API version bundled with stripe@22.5.0. Pinning it prevents the
// account's older default API version from disabling no-cost Checkout Sessions.
const STRIPE_API_VERSION: Stripe.LatestApiVersion = '2026-07-29.dahlia';

const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');
const stripeDnsWebhookSecret = defineSecret('STRIPE_DNS_WEBHOOK_SECRET');

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
  // deliberately commits this server-created ID rather than trusting a client-writable ID
  // that may have appeared while the Stripe request was running.
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

      const receiptRef = db.doc(`stripeDnsCheckoutReceipts/${session.id}`);
      const entitlementRef = db.doc(`artifacts/${APP_ID}/users/${uid}/entitlement/main`);
      const granted = await db.runTransaction(async (transaction) => {
        const receiptSnap = await transaction.get(receiptRef);
        if (receiptSnap.exists) return false;

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
        transaction.set(
          entitlementRef,
          {
            dnsFoundationsEntitled: true,
            source: 'stripe:program:zero-total-checkout',
            stripeCheckoutSessionId: session.id,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
        return true;
      });

      response.status(200).send(granted ? 'Granted' : 'Already processed');
    } catch (error) {
      console.error('[DNS Checkout] No-cost fulfillment failed.', error);
      response.status(500).send('Webhook processing failed');
    }
  }
);
