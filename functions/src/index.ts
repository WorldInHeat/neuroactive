// functions/src/index.ts
// Trusted server boundary for DNS Foundations entitlement (security findings #1-3).
// The client can READ artifacts/{appId}/users/{uid}/entitlement/main; it can never WRITE
// it (see firestore.rules) — only these functions, via the Admin SDK, ever set it.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { DNS_COURSE_DAY_MEDIA } from './dnsCourseDayMedia';

initializeApp();
const db = getFirestore();

// Must match the appId constant in src/App.tsx / src/services/firebase.ts.
const APP_ID = 'neuroactive-prod';

// The live DNS Foundations 'program' Stripe price — see PROGRAM_PRICE_LIVE in
// src/services/stripe.ts. Deliberately excludes 'elite'/'monthly'/'annual': those are
// legacy NeuroActive/MDT tiers and are not authoritative for DNS Foundations access
// (explicit product decision). Their price constants stay defined in the client for
// when that broader product is reactivated; they're just not checked here.
const DNS_PROGRAM_PRICE_ID = 'price_1U4Bec2NbKaJ0YSoKoicGfHi';

function entitlementDocRef(uid: string) {
  return db.doc(`artifacts/${APP_ID}/users/${uid}/entitlement/main`);
}

// Single source of truth for "is this uid DNS-entitled", read via the Admin SDK (bypasses
// Security Rules entirely — same IAM-authorized access class as the rest of this trusted
// server boundary). Shared by getDnsCourseDayMedia and getDnsEntitlement so both callables
// apply the exact same predicate. Missing document, missing field, or anything other than
// the literal boolean true all resolve to false — this never infers entitlement from
// absence of data, only from an explicit true.
async function hasDnsEntitlement(uid: string): Promise<boolean> {
  const ref = entitlementDocRef(uid);
  const snap = await ref.get();
  const entitled = snap.exists && snap.data()?.dnsFoundationsEntitled === true;

  // TEMPORARY diagnostic — remove once the Firebase support case is resolved.
  console.log('[DNS entitlement] Admin SDK read', {
    project: process.env.GOOGLE_CLOUD_PROJECT,
    databaseId: db.databaseId,
    path: ref.path,
    exists: snap.exists,
    entitled,
  });

  return entitled;
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

function paymentGrantsDnsFoundations(payment: FirebaseFirestore.DocumentData | undefined): boolean {
  if (!payment) return false;
  if (payment.status !== 'succeeded') return false;
  const items = Array.isArray(payment.items) ? payment.items : [];
  return items.some((item: unknown) => lineItemPriceId(item) === DNS_PROGRAM_PRICE_ID);
}

// Fires on every write to a customer's payment records (all written server-side by the
// Stripe extension from verified webhook events — never client-writable, see
// firestore.rules). Only ever ASSERTS entitlement when the triggering document currently
// qualifies; it never revokes based on this trigger alone, since one payment document
// changing (or being deleted) says nothing about whether the customer's other payments
// still qualify. Refund/dispute revocation is an explicitly accepted manual process for
// this phase (see PR description) — the installed extension version does not sync
// charge.refunded or charge.dispute.* events into these documents at all.
export const recomputeDnsEntitlement = onDocumentWritten(
  'customers/{uid}/payments/{paymentId}',
  async (event) => {
    const uid = event.params.uid;
    const after = event.data?.after.data();

    if (!paymentGrantsDnsFoundations(after)) return;

    await entitlementDocRef(uid).set(
      {
        dnsFoundationsEntitled: true,
        source: 'stripe:program',
        stripePaymentId: event.params.paymentId,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  }
);

// Returns Vimeo credentials for exactly one requested DNS course day, and only to an
// authenticated, DNS-entitled caller. Deliberately does NOT check the caller's course
// progress (dnsCourse.currentDay in Firestore) — ownership of DNS Foundations is the
// security boundary, not which day the UI has reached; the existing client-side
// progression system remains responsible for which days the normal UI exposes.
export const getDnsCourseDayMedia = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  const day = request.data?.day;
  if (typeof day !== 'number' || !Number.isInteger(day) || !(day in DNS_COURSE_DAY_MEDIA)) {
    throw new HttpsError('invalid-argument', 'Invalid DNS course day.');
  }

  const entitled = await hasDnsEntitlement(request.auth.uid);
  if (!entitled) {
    throw new HttpsError('permission-denied', 'DNS Foundations entitlement required.');
  }

  return DNS_COURSE_DAY_MEDIA[day];
});

// Read-only entitlement status for the calling user, sourced via the Admin SDK rather
// than the client Firestore listener/REST path. Bridge for a reproduced, still-under-
// investigation inconsistency where Firebase-ID-token-governed Firestore reads report
// this document as absent while every IAM-authenticated read (Console, gcloud REST,
// batchGet) consistently finds it — see the open Firebase support case. Takes no input;
// the uid is exclusively request.auth.uid, verified server-side by the callable runtime,
// never client-supplied. Any failure to read fails closed (throws, never returns true).
export const getDnsEntitlement = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }

  try {
    return { dnsFoundationsEntitled: await hasDnsEntitlement(request.auth.uid) };
  } catch (error) {
    console.error('[DNS entitlement] Admin read failed', { uid: request.auth.uid, error });
    throw new HttpsError('internal', 'Unable to verify DNS Foundations entitlement.');
  }
});
