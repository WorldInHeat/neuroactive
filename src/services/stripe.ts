import { db } from './firebase';
import { collection, addDoc, onSnapshot } from 'firebase/firestore';

const PRICES: Record<string, string> = {
  monthly: 'price_1TJhuYRsRdChIWS1HBZggMVK',
  annual:  'price_1TJhvBRsRdChIWS1SwRI53MQ',
  program: 'price_1TJhw1RsRdChIWS1ZmkYWFy2',
  elite:   'price_1TJhwVRsRdChIWS1twZddLiZ',
};

export type PriceKey = keyof typeof PRICES;

export async function createCheckoutSession(userId: string, priceKey: PriceKey): Promise<void> {
  const checkoutSessionRef = await addDoc(
    collection(db, 'customers', userId, 'checkout_sessions'),
    {
      price: PRICES[priceKey],
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

export async function createPortalLink(userId: string): Promise<void> {
  const portalLinkRef = await addDoc(
    collection(db, 'customers', userId, 'portal_links'),
    { return_url: window.location.origin }
  );

  return new Promise((resolve, reject) => {
    const unsubscribe = onSnapshot(portalLinkRef, (snap) => {
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
