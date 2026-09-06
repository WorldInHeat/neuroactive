import { db, appId } from './firebase';
import { collection, addDoc, doc, onSnapshot, runTransaction } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import {
  captureLandingSignalOnce,
  readLocalAttributionState,
  bestEffortReconcileWithTimeout,
  checkoutWithAttributionFlush,
  validateAttributionState,
  type AttributionState,
} from './attribution';

// Bounded, single-attempt timeout for the checkout-time attribution flush below — see
// createCheckoutSession. Deliberately short: this exists to close the "just landed and
// bought immediately" gap, not to guarantee delivery — a slow/blocked/offline Firestore
// must cost at most this long, never hold up checkout waiting for a retry.
const ATTRIBUTION_FLUSH_TIMEOUT_MS = 1500;

// 'program' now points at a live-mode Stripe price. import.meta.env.DEV (same pattern as
// DevTimeSkip in App.tsx) keeps local dev on the test-mode price so `npm run dev` can
// never trigger a real charge. monthly/annual/elite stay on their test IDs, unchanged —
// this is the minimal version; a fuller test/live system can come later.
const PROGRAM_PRICE_TEST = 'price_1TJhw1RsRdChIWS1ZmkYWFy2';
const PROGRAM_PRICE_LIVE = 'price_1U4Bec2NbKaJ0YSoKoicGfHi';

const PRICES: Record<string, string> = {
  monthly: 'price_1TJhuYRsRdChIWS1HBZggMVK',
  annual:  'price_1TJhvBRsRdChIWS1SwRI53MQ',
  program: import.meta.env.DEV ? PROGRAM_PRICE_TEST : PROGRAM_PRICE_LIVE,
  elite:   'price_1TJhwVRsRdChIWS1twZddLiZ',
};

export type PriceKey = keyof typeof PRICES;

// Static customer-facing display string for the 'program' tier's live price — never
// fetched from Stripe (this is just a label, not a source of truth for what gets
// charged; Stripe itself is authoritative for the actual amount). Stripe Adaptive
// Pricing may show international customers an equivalent local-currency amount at
// checkout, but the account's configured price is USD $149, one-time (see
// PROGRAM_PRICE_LIVE above). Keep this in sync if that price is ever changed in the
// Stripe Dashboard.
export const PROGRAM_DISPLAY_PRICE = '$149 USD';

// 'program' and 'elite' are one-time purchases — Stripe rejects a one-time price
// submitted under the extension's default 'subscription' mode, so they need
// 'payment' mode explicitly. monthly/annual are recurring prices and use 'subscription'.
const CHECKOUT_MODE: Record<PriceKey, 'payment' | 'subscription'> = {
  monthly: 'subscription',
  annual: 'subscription',
  program: 'payment',
  elite: 'payment',
};

// Fast-checkout attribution gap: a visitor who lands and purchases within moments may
// invoke checkout before App.tsx's own (fire-and-forget, once-per-page-load) Firestore
// reconciliation has had a chance to run or land — see App.tsx's syncAttribution. This
// performs one bounded, best-effort, AWAITED attempt to flush the current local
// buffer into Firestore immediately before checkout, so the common case (Firestore
// reachable) is captured even on a rapid purchase. Never throws — a blocked/slow/offline
// Firestore degrades to "didn't finish in time," not an error, and the caller
// (checkoutWithAttributionFlush) proceeds to checkout exactly once regardless.
async function flushAttributionBeforeCheckout(userId: string): Promise<void> {
  const touch = captureLandingSignalOnce(); // idempotent — same touch as page load, this app has no router
  const attributionDocRef = doc(db, 'artifacts', appId, 'users', userId, 'userData', 'main');
  await bestEffortReconcileWithTimeout(
    {
      runAtomicUpdate: (update) => runTransaction(db, async (transaction) => {
        const snap = await transaction.get(attributionDocRef);
        const data = snap.exists() ? (snap.data() as { attribution?: AttributionState }) : undefined;
        const existing = validateAttributionState(data?.attribution);
        const next = update(existing);
        if (next.firstTouch !== existing.firstTouch || next.lastTouch !== existing.lastTouch) {
          transaction.set(attributionDocRef, { attribution: next }, { merge: true });
        }
        return next;
      }),
    },
    touch,
    ATTRIBUTION_FLUSH_TIMEOUT_MS
  );
}

export async function createCheckoutSession(userId: string, priceKey: PriceKey): Promise<void> {
  // Production DNS Checkout is created at a trusted server boundary using a modern
  // Stripe API version. Keep local development on the existing test price so running
  // the dev client can never create a live charge.
  if (priceKey === 'program' && !import.meta.env.DEV) {
    await checkoutWithAttributionFlush(
      () => flushAttributionBeforeCheckout(userId),
      async () => {
        const createDnsCheckout = httpsCallable<{ attribution?: AttributionState } | undefined, { url: string }>(
          getFunctions(),
          'createDnsCheckoutSession'
        );
        // Sent alongside the Firestore flush attempt above (not instead of it) — a
        // fallback the server reconciles as complete, indivisible touch objects (see
        // resolveCheckoutAttributionSnapshot), for the case where the flush
        // just above didn't land in time. Untrusted, independently re-validated
        // server-side either way; never a second call to this callable.
        let clientAttribution: AttributionState | undefined;
        try {
          clientAttribution = readLocalAttributionState();
        } catch {
          clientAttribution = undefined;
        }
        const result = await createDnsCheckout(clientAttribution ? { attribution: clientAttribution } : undefined);
        if (!result.data.url) throw new Error('Checkout URL was not returned.');
        window.location.assign(result.data.url);
      }
    );
    return;
  }

  const checkoutSessionRef = await addDoc(
    collection(db, 'customers', userId, 'checkout_sessions'),
    {
      price: PRICES[priceKey],
      mode: CHECKOUT_MODE[priceKey],
      success_url: `${window.location.origin}?payment=success`,
      cancel_url:  `${window.location.origin}?payment=canceled`,
      allow_promotion_codes: true,
    }
  );

  return new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(checkoutSessionRef, (snap) => {
      const data = snap.data();
      if (data?.url) {
        unsubscribe();
        window.location.assign(data.url);
        resolve();
      }
      if (data?.error) {
        unsubscribe();
        reject(new Error(data.error.message));
      }
    });
  });
}

export async function createPortalLink(): Promise<void> {
  const createPortal = httpsCallable<{ returnUrl: string }, { url?: unknown }>(
    getFunctions(),
    'ext-firestore-stripe-payments-createPortalLink'
  );
  const result = await createPortal({ returnUrl: window.location.origin });
  if (typeof result.data.url !== 'string') {
    throw new Error('The customer portal URL was not returned.');
  }

  let portalUrl: URL;
  try {
    portalUrl = new URL(result.data.url);
  } catch {
    throw new Error('The customer portal returned an invalid URL.');
  }
  if (portalUrl.protocol !== 'https:' || portalUrl.hostname !== 'billing.stripe.com') {
    throw new Error('The customer portal returned an unsafe URL.');
  }

  window.location.assign(portalUrl.href);
}
