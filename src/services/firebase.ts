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

// App Check readiness (registration deployment blocker #9): the push-installation callables
// (functions/src/pushInstallations.ts) currently run with enforceAppCheck: false, since
// enforcing it requires App Check to first be registered for this Web app in Firebase
// Console — a Console change this codebase deliberately does not make on its own. This block
// makes the CLIENT side ready in advance: once VITE_FIREBASE_APPCHECK_SITE_KEY is set to a
// real reCAPTCHA v3 site key obtained from that Console registration, App Check tokens start
// being attached to every request automatically, with no further code change needed here —
// only functions/src/pushInstallations.ts's CALLABLE_OPTIONS would then need
// enforceAppCheck flipped to true, once that Console step is actually done and reviewed.
//
// No key is ever hardcoded — with the env var unset (the current, pre-Console-configuration
// state), this block does nothing at all, so local dev and every existing feature behave
// exactly as before. Wrapped defensively: a misconfigured/invalid site key must never crash
// the rest of the app's module initialization over a feature that isn't enforced yet anyway.
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
