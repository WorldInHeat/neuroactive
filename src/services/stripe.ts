import { db } from './firebase';
import { collection, addDoc, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

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

// 'program' and 'elite' are one-time purchases — Stripe rejects a one-time price
// submitted under the extension's default 'subscription' mode, so they need
// 'payment' mode explicitly. monthly/annual are recurring prices and use 'subscription'.
const CHECKOUT_MODE: Record<PriceKey, 'payment' | 'subscription'> = {
  monthly: 'subscription',
  annual: 'subscription',
  program: 'payment',
  elite: 'payment',
};

export async function createCheckoutSession(userId: string, priceKey: PriceKey): Promise<void> {
  // Production DNS Checkout is created at a trusted server boundary using a modern
  // Stripe API version. Keep local development on the existing test price so running
  // the dev client can never create a live charge.
  if (priceKey === 'program' && !import.meta.env.DEV) {
    const createDnsCheckout = httpsCallable<void, { url: string }>(
      getFunctions(),
      'createDnsCheckoutSession'
    );
    const result = await createDnsCheckout();
    if (!result.data.url) throw new Error('Checkout URL was not returned.');
    window.location.assign(result.data.url);
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
