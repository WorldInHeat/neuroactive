// functions/src/index.ts
// Trusted server boundary for DNS Foundations entitlement (security findings #1-3).
// The client can READ artifacts/{appId}/users/{uid}/entitlement/main; it can never WRITE
// it (see firestore.rules) — only these functions, via the Admin SDK, ever set it.

import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DNS_COURSE_DAY_MEDIA } from './dnsCourseDayMedia';
import { applyDnsEntitlementBasis, hasDnsEntitlement, paymentGrantsDnsFoundations } from './dnsEntitlement';

export { createDnsCheckoutSession, handleDnsNoCostCheckout, handleDnsRefund } from './dnsCheckout';
export {
  initializePushInstallation,
  reclaimPushInstallation,
  registerPushInstallation,
  revokePushInstallation,
  preparePushInstallationTransfer,
  claimPushInstallationTransfer,
  cancelPushInstallationTransfer,
} from './pushInstallations';
export { updateNotificationPreferences, refreshNotificationTimezone } from './notificationPreferences';
// Calendar Integration Phase 1, Stage 1 — account-deletion + token-lifecycle foundation
// only. No relationship to, and no imports from, the reminder/notification pipeline below.
export {
  createCalendarSubscription,
  revokeCalendarSubscription,
  revokeAllCalendarSubscriptions,
  onCalendarUserDeleted,
} from './calendarSubscriptions';
// Calendar Integration Phase 1, Stage 2 — calendar schedule preferences only. No
// dependency on, or coupling with, notificationPreferences/reminder/course-progress state
// — see functions/src/calendarPreferences.ts's own header for the full decoupling
// guarantee. Deliberately does NOT export any Auth-deletion trigger for this document —
// see that file's own ACCOUNT DELETION section for the explicit, documented reasoning.
export { updateCalendarPreferences } from './calendarPreferences';
export { notificationReminderSchedulerDryRun } from './reminderScheduler';
// Phase 3A-3 Step 3C-3, renamed Step 3C-5 (M1) — the delivery-pipeline export. This function
// transitively reaches real FCM transport via reminderDeliverySender.ts, but whether a real
// send is ever authorized depends on the production rollout document (currently
// `{mode:"paused"}`) and both files' own REAL_DELIVERY_STAGE constants (currently
// 'allowlisted-only') — see reminderDeliveryWorker.ts's and reminderDeliveryAuth.ts's own
// headers for the full reachability analysis. The deepest state reachable TODAY, given the
// current rollout document, is still 'dry-run-validated'.
export { notificationReminderDeliveryWorker } from './reminderDeliveryWorker';

if (getApps().length === 0) initializeApp();
const db = getFirestore();

// Fires on every write to a customer's payment records (all written server-side by the
// Stripe extension from verified webhook events — never client-writable, see
// firestore.rules). Only ever ASSERTS this specific payment's basis; it never revokes
// based on this trigger, since one payment document changing (or being deleted) says
// nothing about whether the customer's other payments — or other entitlement bases
// entirely, e.g. a beta grant — still qualify. Refund revocation is handled separately
// and independently by handleDnsRefund (see dnsCheckout.ts), which deactivates only the
// one basis tied to the refunded PaymentIntent; every other basis on the document is
// read back unchanged. See dnsEntitlement.ts for the full basis model.
export const recomputeDnsEntitlement = onDocumentWritten(
  'customers/{uid}/payments/{paymentId}',
  async (event) => {
    const uid = event.params.uid;
    const paymentId = event.params.paymentId;
    const after = event.data?.after.data();

    if (!paymentGrantsDnsFoundations(after)) return;

    await applyDnsEntitlementBasis(db, uid, `stripe_program:${paymentId}`, {
      type: 'stripe_program',
      active: true,
      stripePaymentId: paymentId,
    });
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

  const entitled = await hasDnsEntitlement(db, request.auth.uid);
  if (!entitled) {
    throw new HttpsError('permission-denied', 'DNS Foundations entitlement required.');
  }

  return DNS_COURSE_DAY_MEDIA[day];
});
