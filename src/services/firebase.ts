import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, linkWithPopup, signInAnonymously } from 'firebase/auth';
export { GoogleAuthProvider, signInWithPopup, linkWithPopup, signInAnonymously };
import { getFirestore } from 'firebase/firestore';
import { getMessaging, isSupported as isMessagingSupported, type Messaging } from 'firebase/messaging';
import { initializeAppCheck, ReCaptchaV3Provider } from 'firebase/app-check';

const firebaseConfig = {
  apiKey: "AIzaSyBlNWkezjbXlOZ7SQCuN9FWO0ScV4zuTc8",
  authDomain: "neuroactivehealth.com",
  projectId: "neuroactive",
  storageBucket: "neuroactive.firebasestorage.app",
  messagingSenderId: "1010503840940",
  appId: "1:1010503840940:web:90874fb37a70c9c7115b09",
  measurementId: "G-4X86RF0RQT"
};

export const appId = 'neuroactive-prod';

// This is the ONLY Firebase initialization call site in the client (App.tsx imports auth/db
// from here rather than initializing its own app). The getApps()/getApp() guard keeps this
// idempotent under HMR/module-reload/test re-evaluation regardless of import order.
const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);

// App Check: initializes below whenever VITE_FIREBASE_APPCHECK_SITE_KEY is supplied. No
// key is ever hardcoded — it comes from .env.local (gitignored) or the deploying
// environment. A production build (`vite build`) now fails fast if this var is missing or
// blank (see vite.config.ts's validateRequiredEnv); local development (`vite`/`vite dev`)
// may still omit it, in which case this block is simply a no-op and everything else
// behaves exactly as before. Wrapped defensively regardless — a misconfigured/invalid site
// key must never crash the rest of the app's module initialization. Server-side,
// functions/src/pushInstallations.ts's push-installation callables (initializePushInstallation,
// registerPushInstallation, etc.) enforce App Check (`enforceAppCheck: true`); other
// callables — e.g. getDnsCourseDayMedia — do not, and rely on their own
// entitlement/auth checks instead.
const appCheckSiteKey = import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY as string | undefined;
if (appCheckSiteKey) {
  try {
    initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(appCheckSiteKey),
      isTokenAutoRefreshEnabled: true,
    });
  } catch (err) {
    console.warn('[AppCheck] initialization failed; continuing without it:', err);
  }
}

// Messaging is created lazily, only on first use, and only after isSupported() resolves
// true — calling getMessaging() unconditionally throws in browsers/contexts without Push
// API support (older Safari, non-HTTPS). Phase 3A-1: registration only, no send-side code.
let messagingPromise: Promise<Messaging | null> | null = null;

export function getMessagingIfSupported(): Promise<Messaging | null> {
  if (!messagingPromise) {
    messagingPromise = isMessagingSupported()
      .then((supported) => (supported ? getMessaging(app) : null))
      .catch(() => null);
  }
  return messagingPromise;
}
