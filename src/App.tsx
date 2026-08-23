// src/App.tsx
import { useEffect, useRef, useState } from 'react'; // Removed 'React' default import
import {
  Activity,
  Play,
  Lock,
  CheckCircle,
  ChevronRight,
  User,
  ShieldAlert,
  ArrowLeft,
  CreditCard,
  FastForward,
  HelpCircle,
  // ArrowUp,   <-- Commented out unused icons
  // ArrowDown,
  ClipboardList,
  Library,
  TrendingUp,
  TrendingDown,
  Minus,
  LogOut,
  Trash2,
  Mail,
  FileText,
  Bell,
  X,
  Dumbbell,
} from 'lucide-react';

import {
  GoogleAuthProvider,
  EmailAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  linkWithRedirect,
  linkWithCredential,
  sendSignInLinkToEmail,
  isSignInWithEmailLink,
  signInWithEmailLink,
  signInWithEmailAndPassword,
  updatePassword,
  fetchSignInMethodsForEmail,
  signInAnonymously,
  onAuthStateChanged,
  signOut,
  type Auth,
} from 'firebase/auth';
import { doc, setDoc, getDoc, onSnapshot, collection } from 'firebase/firestore';

import { DECISION_TREE } from './data/decisionTree';
import type { PainLogEntry, UserData, DnsCourseProgress } from './state/types';
import VideoPlayer from './components/VideoPlayer';
import SessionSummary from './components/SessionSummary';
import Paywall from './components/Paywall';
import DNSCourseView from './components/DNSCourseView';
import InstallSettingsCard from './components/InstallSettingsCard';
import NotificationSettingsCard from './components/NotificationSettingsCard';
import { useNotifications, type NotificationStatus } from './hooks/useNotifications';
import { useNotificationPreferences, type NotificationPreferences } from './hooks/useNotificationPreferences';
import { auth, db, appId } from './services/firebase';
import { createPortalLink, type PriceKey } from './services/stripe';
import { DNS_ONLY_LAUNCH } from './config/launchConfig';

// Firebase itself is initialized exactly once, in src/services/firebase.ts — imported above,
// not re-initialized here. This file previously performed its OWN separate
// initializeApp(firebaseConfig) call with this same config; since useNotifications (imported
// above) transitively imports services/firebase.ts, and ES module imports are evaluated
// before this module's own top-level code runs, services/firebase.ts's initialization
// ALWAYS executed first — meaning this file's own initializeApp() call was unconditionally
// throwing app/duplicate-app on every load, silently caught, leaving auth/db here as null
// for the entire app's lifetime. Build/typecheck never exercises this runtime-only path,
// which is why it went unnoticed. Fixed by having this file import the SAME auth/db/appId
// services/firebase.ts already exports (which itself guards against double-initialization
// via getApps()/getApp(), so it's safe regardless of which module actually evaluates first).

const googleProvider = new GoogleAuthProvider();
const isInAppBrowser = /Instagram|FBAN|FBAV|TikTok/i.test(navigator.userAgent);

// Set right before signInWithRedirect/linkWithRedirect navigates away, cleared once
// getRedirectResult settles on the page load that follows. Survives the full-page
// navigation (React state doesn't), so on return we can tell "no redirect was in
// flight" apart from "a redirect was in flight but getRedirectResult came back null" —
// the latter means the redirect round-trip silently failed to resolve and should
// surface as an error instead of being treated as a fresh anonymous session.
const REDIRECT_PENDING_KEY = 'na_google_redirect_pending';

// Firebase's documented pattern for email-link sign-in: the email is needed again once
// the user opens the link, but that may happen in a different tab/browser/device than
// the one that requested it (e.g. opening the link from a phone's mail app), so it has
// to be persisted somewhere that survives that gap rather than kept in React state.
const EMAIL_LINK_STORAGE_KEY = 'na_email_for_signin';

// Pinned to the canonical apex host (see tonight's www/apex CSP fix) rather than
// window.location.href, so the emailed link always lands on the one canonical origin
// regardless of which host the user happened to be on when they requested it.
const EMAIL_LINK_CONTINUE_URL = 'https://neuroactivehealth.com/';

// signInWithRedirect/linkWithRedirect navigate the page away on success, so normally
// this promise's resolution is moot — execution just stops. But if the browser fails to
// actually perform that navigation (observed as an indefinite hang with no throw and no
// console output), the awaited call never settles and callers get stuck forever. Racing
// it against a timeout turns that silent hang into a catchable error.
const REDIRECT_TIMEOUT_MS = 10000;
function withRedirectTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error('redirect-timeout')), REDIRECT_TIMEOUT_MS)
    ),
  ]);
}

// Turns an email-link auth error into a message worth showing the user. Every branch is
// explicit on purpose — no silent failures, matching the redirect-sign-in fix.
function mapEmailAuthError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  switch (code) {
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'That email address doesn’t look valid.';
    case 'auth/invalid-action-code':
      return 'This sign-in link is invalid or has already been used.';
    case 'auth/expired-action-code':
      return 'This sign-in link has expired. Please request a new one.';
    case 'auth/too-many-requests':
    case 'auth/quota-exceeded':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in isn’t available right now. Please try Google instead.';
    case 'auth/unauthorized-continue-uri':
      return 'Sign-in link setup issue — please contact support.';
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      return 'This email already belongs to an existing NeuroActive account. Please sign in to that existing account.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists using another sign-in method. Please sign in using the method associated with that account.';
    default:
      console.error('Email auth error:', error);
      return 'Something went wrong. Please try again.';
  }
}

// Mirrors mapEmailAuthError for the password paths (create/sign-in/set-password). Kept
// separate rather than merged, since the two error codespaces barely overlap (weak-password
// and invalid-credential only apply here) and a shared function would need a mode flag.
// 'auth/invalid-credential' is the modern consolidated code Firebase now returns for both
// wrong-password and no-such-user on sign-in, specifically to avoid revealing which one it
// was — the message here deliberately doesn't distinguish them either, for the same reason.
function mapPasswordAuthError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  switch (code) {
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'That email address doesn’t look valid.';
    case 'auth/weak-password':
      return 'Please choose a longer password.';
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'Incorrect email or password.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/operation-not-allowed':
      return 'Email/password sign-in isn’t available right now. Please try Google instead.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists using another sign-in method. Please sign in using the method associated with that account.';
    default:
      console.error('Password auth error:', error);
      return 'Something went wrong. Please try again.';
  }
}

// If a link/sign-in attempt fails because the email is already registered, check which
// providers already own it so we can point the user at the right one instead of a dead
// end — e.g. someone who originally signed up with Google trying to use a magic link here.
async function describeExistingEmailAccount(auth: Auth, email: string): Promise<string> {
  try {
    const methods = await fetchSignInMethodsForEmail(auth, email);
    if (methods.includes('google.com') && !methods.includes('emailLink')) {
      return 'This email is already registered with Google — please use "Continue with Google" to sign in.';
    }
  } catch (err) {
    console.error('fetchSignInMethodsForEmail failed:', err);
  }
  return 'An account with this email already exists.';
}

// Fields saveUserData strips under DNS_ONLY_LAUNCH — see the comment above saveUserData
// itself for why. Module-scoped (not per-render) so it doesn't make saveUserData look
// unstable to exhaustive-deps.
const ASSESSMENT_FIELDS_GATED_UNDER_DNS_ONLY_LAUNCH = [
  'activeJourney', 'activePrescriptions', 'history', 'currentNodeId', 'painLog',
] as const;

// Canonical fresh-account DNS course state — used both as the initial useState value and
// as what dnsCourse resets to whenever the authenticated uid actually changes (see the
// auth effect's userDataUidRef check), so a new/different account never starts from a
// previous account's in-memory progress.
const DEFAULT_DNS_COURSE: DnsCourseProgress = { currentDay: 1, lastCompletedDate: '', startedAt: '' };

// Firestore data is never runtime-type-checked (docSnap.data() is an unchecked cast, same
// as every other field hydrated below) — a malformed/legacy currentDay (wrong type, out of
// range, non-integer, or a numeric string that would silently string-concatenate instead
// of adding on the next `currentDay + 1`) has to be caught right here, at the one point
// untrusted stored data enters dnsCourse state. Applied at hydration time (not in
// DNSCourseView) so everything downstream can keep assuming currentDay is always a real
// integer in 1..85 — DNSCourseView's Course Complete/pacing logic is unchanged and relies
// on that. Malformed data resets the whole dnsCourse to the fresh default rather than
// trying to guess/repair a value, so it can never fabricate progress or expose days that
// weren't actually earned (e.g. a corrupted 0 must not read as "past days 1-83", and a
// corrupted >85 must not read as "course complete").
function normalizeDnsCourse(raw: DnsCourseProgress): DnsCourseProgress {
  const { currentDay } = raw;
  const isValidCurrentDay =
    typeof currentDay === 'number' && Number.isInteger(currentDay) && currentDay >= 1 && currentDay <= 85;
  return isValidCurrentDay ? raw : DEFAULT_DNS_COURSE;
}

// --- Helper Components ---

// Reused by SettingsView's "Sign in with Google" button
const GoogleLogoSvg = ({ dim = false }: { dim?: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" className={dim ? 'opacity-40' : undefined}>
    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
  </svg>
);

const LegalDisclaimer = ({ onAgree, onCancel }: { onAgree: () => void; onCancel: () => void }) => (
  <div className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4 backdrop-blur-sm animate-fade-in">
    <div className="bg-white max-w-2xl w-full rounded-xl shadow-2xl max-h-[90vh] flex flex-col">
      <div className="p-6 border-b bg-red-50 rounded-t-xl">
        <div className="flex items-center gap-3 text-red-700 mb-2">
          <ShieldAlert size={28} />
          <h2 className="text-2xl font-bold">Medical Disclaimer & Liability Waiver</h2>
        </div>
        <p className="text-sm text-red-600 font-medium">Please read carefully before proceeding.</p>
      </div>

      <div className="p-8 overflow-y-auto text-sm text-gray-700 space-y-4 flex-1">
        <p className="font-semibold text-lg">Dr. Bruene & NeuroActive Team</p>

        <div className="p-4 bg-gray-50 rounded-lg border border-gray-100">
          <p className="mb-2">
            <strong>1. Not Medical Advice:</strong> The content provided in this application (NeuroActive) including
            text, graphics, images, and video, is for informational and educational purposes only. It is not intended
            to be a substitute for professional medical advice, diagnosis, or treatment.
          </p>

          <p className="mb-2">
            <strong>2. No Doctor-Patient Relationship:</strong> Usage of this app does not establish a doctor-patient
            relationship between you and Dr. Bruene. Dr. Bruene is licensed in Illinois, and this application is not
            intended to provide medical services outside of this jurisdiction.
          </p>

          <p className="mb-2">
            <strong>3. Consult Your Doctor First:</strong> This program involves physical movement and exercise. If
            you have a pre-existing heart, lung, or neurological condition, are pregnant or postpartum, or have had a
            recent injury or surgery you haven't been cleared for, consult a physician before beginning.
          </p>

          <p className="mb-2">
            <strong>4. Listen to Your Body:</strong> Stop immediately if you experience chest pain, dizziness,
            shortness of breath beyond normal exertion, or sharp or shooting pain. Discomfort from effort is normal;
            pain that feels wrong is not. This program is not personalized medical advice — it's based on general
            training principles, not an evaluation of your individual body or medical history.
          </p>

          <p className="mb-2">
            <strong>5. Assumption of Risk:</strong> You acknowledge that participation in these exercises involves a
            risk of injury. By continuing, you voluntarily assume all risks associated with these activities.
          </p>

          <p>
            <strong>6. Emergency:</strong> If you think you may have a medical emergency, call your doctor or 911
            immediately. Do not disregard professional medical advice or delay in seeking it because of something you
            have read in this app.
          </p>
        </div>

        <p className="text-xs text-gray-500 mt-4">By clicking "I Agree", you acknowledge that you have read and understood these terms.</p>
      </div>

      <div className="p-6 border-t bg-gray-50 rounded-b-xl flex justify-end gap-3">
        <button onClick={onCancel} className="px-4 py-2 text-gray-600 font-medium hover:bg-gray-200 rounded-lg transition-colors">
          Decline
        </button>
        <button
          onClick={onAgree}
          className="px-6 py-2 bg-blue-600 text-white font-bold rounded-lg hover:bg-blue-700 shadow-lg transition-all transform hover:scale-105"
        >
          I Agree & Understand
        </button>
      </div>
    </div>
  </div>
);

// --- Settings Component ---
const SettingsView = ({
  isPremium,
  dnsAccountStatus,
  onBack,
  onGoToDashboard,
  onLogout,
  onReset,
  onUpgrade,
  onManageSubscription,
  userInfo,
  onGoogleSignIn,
  onSetPassword,
  signInLoading,
  signInError,
  notificationStatus,
  notificationError,
  onEnableNotifications,
  preferencesUid,
  preferencesLoaded,
  preferences,
  preferencesReadError,
  preferencesCorrupt,
  defaultPreferences,
  preferencesSaving,
  preferencesError,
  preferencesConflictMessage,
  preferencesConflictToken,
  onSavePreferences,
}: {
  isPremium: boolean;
  // DNS_ONLY_LAUNCH-only account status, computed in App() from the server-authoritative
  // entitlement basis (see functions/src/dnsEntitlement.ts) — drives the Current Plan
  // label below instead of the legacy isPremium/Stripe-subscription signal, so a
  // beta-granted account never shows "Free Tier" and a purchaser's refund never shows
  // "God Mode (Pro)" merely because some unrelated legacy isPremium flag is still true.
  // When DNS_ONLY_LAUNCH is off, the legacy isPremium-driven label is used unchanged.
  dnsAccountStatus: 'active' | 'beta' | 'none';
  onBack: () => void;
  onGoToDashboard: () => void;
  onLogout: () => void;
  onReset: () => void;
  onUpgrade: () => void;
  onManageSubscription?: () => Promise<void>;
  userInfo?: { displayName: string | null; photoURL: string | null; email: string | null; isAnonymous: boolean };
  onGoogleSignIn: () => void;
  onSetPassword: (password: string) => Promise<'ok' | 'requires-recent-login'>;
  signInLoading: boolean;
  signInError: string | null;
  notificationStatus: NotificationStatus;
  notificationError: string | null;
  onEnableNotifications: () => void;
  preferencesUid: string | null;
  preferencesLoaded: boolean;
  preferences: NotificationPreferences | null;
  preferencesReadError: boolean;
  preferencesCorrupt: boolean;
  defaultPreferences: NotificationPreferences;
  preferencesSaving: boolean;
  preferencesError: string | null;
  preferencesConflictMessage: string | null;
  preferencesConflictToken: number;
  onSavePreferences: (next: NotificationPreferences) => Promise<boolean>;
}) => {
  const [portalLoading, setPortalLoading] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);
  const portalInFlightRef = useRef(false);
  // Task 4: existing permanent (Google or magic-link) users setting up a password for
  // reliable installed-PWA sign-in, via updatePassword (see handleSetPassword in App.tsx —
  // not linkWithCredential, which was found to misfire for magic-link-only users). On
  // 'requires-recent-login' the form stays open (with signInError explaining why) rather
  // than a distinct mode, since it's a retryable failure, not a stable state.
  const [setPasswordMode, setSetPasswordMode] = useState<'idle' | 'form' | 'done'>('idle');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [setPasswordValidationError, setSetPasswordValidationError] = useState<string | null>(null);

  const handleManageSubscription = async () => {
    if (!onManageSubscription || portalInFlightRef.current) return;
    portalInFlightRef.current = true;
    setPortalLoading(true);
    setPortalError(null);
    try {
      await onManageSubscription();
    } catch (err) {
      console.error('Portal link error:', err);
      setPortalError('Unable to open subscription management. Please try again or contact support.');
      portalInFlightRef.current = false;
      setPortalLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30 flex items-center justify-between p-4">
        <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors">
          <ArrowLeft size={20} /> Back
        </button>
        <div className="font-semibold text-[#f0f4f8]">Profile & Settings</div>
        {/* Separate from Back above — always jumps to Dashboard specifically, regardless
            of what Back would otherwise return to. */}
        <button onClick={onGoToDashboard} className="text-[#6b849e] hover:text-[#f0f4f8] text-sm font-medium transition-colors">
          Dashboard
        </button>
      </div>

      <div className="max-w-xl mx-auto p-6 space-y-6">
        {/* User card */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] flex items-center gap-4">
          {userInfo?.photoURL ? (
            <img
              src={userInfo.photoURL}
              alt="Profile"
              className="w-16 h-16 rounded-full object-cover border-2 border-[#00d4c8]/30 flex-shrink-0"
            />
          ) : (
            <div className="bg-[#00d4c8]/15 p-4 rounded-full border border-[#00d4c8]/30 flex-shrink-0">
              <User size={32} className="text-[#00d4c8]" />
            </div>
          )}
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-[#f0f4f8] truncate">
              {userInfo?.isAnonymous ? 'Guest User' : (userInfo?.displayName ?? 'NeuroActive User')}
            </h2>
            {!userInfo?.isAnonymous && userInfo?.email && (
              <p className="text-sm text-[#6b849e] truncate">{userInfo.email}</p>
            )}
            <p className="text-xs text-[#3a4a5e] mt-0.5">
              {userInfo?.isAnonymous
                ? 'Session not saved across devices'
                : userInfo?.email
                ? `Signed in as ${userInfo.email}`
                : 'Signed in'}
            </p>
          </div>
        </div>

        {/* Save progress — guests only */}
        {userInfo?.isAnonymous && (
          <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
            <h3 className="font-bold text-[#f0f4f8] mb-1">Save your progress</h3>
            <p className="text-sm text-[#6b849e] mb-4">
              Sign in with Google to keep your history and access this account on other devices.
            </p>
            {isInAppBrowser ? (
              <div className="w-full flex items-center justify-center gap-3 bg-white/10 text-[#6b849e] font-semibold py-3 px-4 rounded-xl border border-white/10 cursor-not-allowed select-none">
                <GoogleLogoSvg dim />
                Open in Browser to Sign in with Google
              </div>
            ) : (
              <button
                onClick={onGoogleSignIn}
                disabled={signInLoading}
                className="w-full flex items-center justify-center gap-3 bg-white text-gray-800 font-semibold py-3 px-4 rounded-xl hover:bg-gray-50 active:scale-95 transition-all disabled:opacity-60 shadow"
              >
                <GoogleLogoSvg />
                {signInLoading ? 'Signing in…' : 'Sign in with Google'}
              </button>
            )}
            {signInError && (
              <p className="text-xs text-red-400 mt-3 leading-relaxed">{signInError}</p>
            )}
          </div>
        )}

        {/* Subscription */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
          <h3 className="font-bold text-[#f0f4f8] mb-4 flex items-center gap-2">
            <CreditCard size={20} className="text-[#7c5cfc]" /> Subscription
          </h3>
          <div className="flex justify-between items-center bg-[#080d1a] p-4 rounded-xl border border-[#1a2a42]">
            <div>
              <span className="text-xs font-bold text-[#6b849e] uppercase">Current Plan</span>
              <div className="text-lg font-bold text-[#f0f4f8]">
                {DNS_ONLY_LAUNCH
                  ? dnsAccountStatus === 'active'
                    ? 'DNS Foundations — Active'
                    : dnsAccountStatus === 'beta'
                    ? 'DNS Foundations — Beta Access'
                    : 'Free Tier'
                  : isPremium
                  ? 'God Mode (Pro)'
                  : 'Free Tier'}
              </div>
            </div>
            {(DNS_ONLY_LAUNCH ? dnsAccountStatus !== 'none' : isPremium) ? (
              <div className="flex flex-col items-end gap-2">
                <span className="bg-[#00e096]/15 text-[#00e096] border border-[#00e096]/30 px-3 py-1 rounded-full text-xs font-bold">Active</span>
                {onManageSubscription && (
                  <button
                    onClick={handleManageSubscription}
                    disabled={portalLoading}
                    className="text-xs text-[#6b849e] hover:text-[#f0f4f8] transition-colors underline disabled:opacity-50"
                  >
                    {portalLoading ? 'Opening…' : 'Manage Subscription'}
                  </button>
                )}
              </div>
            ) : (
              <button
                onClick={onUpgrade}
                className="px-4 py-2 rounded-lg text-sm font-bold text-[#080d1a] hover:opacity-90 transition-all"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                Upgrade
              </button>
            )}
          </div>
          {portalError && <p className="mt-3 text-sm text-[#ff4466]" role="alert">{portalError}</p>}
        </div>

        {/* Set a password — existing Google/magic-link users only. Lets them sign in from
            an installed PWA where the magic link can't reliably reach them, without
            touching entitlement/progress: updatePassword mutates the already-signed-in
            uid's own credential, it never links/creates anything.
            Gating requires userInfo to actually exist and isAnonymous === false explicitly
            (rather than `!userInfo?.isAnonymous`, which is also true while userInfo is
            still undefined/loading) plus a real email, since onSetPassword has nothing to
            act on without one. */}
        {userInfo && userInfo.isAnonymous === false && userInfo.email && (
          <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
            <h3 className="font-bold text-[#f0f4f8] mb-1">Password sign-in</h3>
            {setPasswordMode === 'done' ? (
              <p className="text-sm text-[#00e096]">
                Password updated. You can sign in directly with your email and password.
              </p>
            ) : setPasswordMode === 'form' ? (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setSetPasswordValidationError(null);
                  if (newPassword.length < 10) {
                    setSetPasswordValidationError('Password must be at least 10 characters.');
                    return;
                  }
                  if (newPassword !== confirmNewPassword) {
                    setSetPasswordValidationError('Passwords don’t match.');
                    return;
                  }
                  try {
                    const result = await onSetPassword(newPassword);
                    if (result === 'ok') {
                      setSetPasswordMode('done');
                      setNewPassword('');
                      setConfirmNewPassword('');
                    } else {
                      // requires-recent-login — a retryable failure, not a stable state;
                      // stay on the form (signInError below explains why) but don't leave
                      // the typed password sitting in state.
                      setNewPassword('');
                      setConfirmNewPassword('');
                    }
                  } catch {
                    // Any other failure — surfaced via signInError below. Clear the typed
                    // password rather than leaving a secret sitting in component state
                    // after a failed attempt.
                    setNewPassword('');
                    setConfirmNewPassword('');
                  }
                }}
                className="space-y-2 mt-3"
              >
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  className="w-full bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] focus:outline-none focus:border-[#00d4c8]/50"
                />
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm new password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  required
                  className="w-full bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] focus:outline-none focus:border-[#00d4c8]/50"
                />
                {setPasswordValidationError && (
                  <p className="text-xs text-red-400">{setPasswordValidationError}</p>
                )}
                {signInError && (
                  <p className="text-xs text-red-400" role="alert">{signInError}</p>
                )}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={signInLoading || !newPassword}
                    className="flex-1 border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50"
                  >
                    {signInLoading ? 'Saving…' : 'Set or change password'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSetPasswordMode('idle'); setSetPasswordValidationError(null); setNewPassword(''); setConfirmNewPassword(''); }}
                    className="text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors px-2"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <>
                <p className="text-sm text-[#6b849e] mb-4">
                  Set or change your NeuroActive password so you can sign in directly with your email and
                  password.
                </p>
                <button
                  onClick={() => setSetPasswordMode('form')}
                  className="w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors"
                >
                  Set or change password
                </button>
              </>
            )}
          </div>
        )}

        {/* Install NeuroActive — shows an "installed" confirmation in standalone mode,
            install/instructions otherwise, or hides itself on an unsupported browser
            with no install path available. */}
        <InstallSettingsCard />

        {/* Notifications — Phase 3A-1, device registration only. Same gating as the
            password card above: only shown for an authenticated, non-anonymous user, since
            a push token is registered under a real uid, never an anonymous session. */}
        {userInfo && userInfo.isAnonymous === false && (
          <NotificationSettingsCard
            status={notificationStatus}
            error={notificationError}
            onEnable={onEnableNotifications}
            preferencesUid={preferencesUid}
            preferencesLoaded={preferencesLoaded}
            preferences={preferences}
            preferencesReadError={preferencesReadError}
            preferencesCorrupt={preferencesCorrupt}
            defaultPreferences={defaultPreferences}
            preferencesSaving={preferencesSaving}
            preferencesError={preferencesError}
            preferencesConflictMessage={preferencesConflictMessage}
            preferencesConflictToken={preferencesConflictToken}
            onSavePreferences={onSavePreferences}
          />
        )}

        {/* Support */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] space-y-1">
          <h3 className="font-bold text-[#f0f4f8] mb-3 flex items-center gap-2">
            <HelpCircle size={20} className="text-[#00d4c8]" /> Support
          </h3>
          <a href="mailto:DrB@neuroactivehealth.com" className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#1a2a42] text-left transition-colors">
            <span className="flex items-center gap-3 text-[#6b849e]">
              <Mail size={18} /> Contact Dr. Bruene
            </span>
            <ChevronRight size={16} className="text-[#1a2a42]" />
          </a>
          <a href="/privacy" className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#1a2a42] text-left transition-colors">
            <span className="flex items-center gap-3 text-[#6b849e]">
              <Lock size={18} /> Privacy Policy
            </span>
            <ChevronRight size={16} className="text-[#1a2a42]" />
          </a>
          <a href="/terms" className="w-full flex items-center justify-between p-3 rounded-lg hover:bg-[#1a2a42] text-left transition-colors">
            <span className="flex items-center gap-3 text-[#6b849e]">
              <FileText size={18} /> Terms of Service
            </span>
            <ChevronRight size={16} className="text-[#1a2a42]" />
          </a>
        </div>

        {/* Danger zone */}
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#ff4466]/20">
          <h3 className="font-bold text-[#ff4466] mb-2 flex items-center gap-2">
            <ShieldAlert size={20} /> Danger Zone
          </h3>
          <p className="text-sm text-[#6b849e] mb-4">Resetting your journey will clear your current prescription and history. This cannot be undone.</p>
          <button
            onClick={() => {
              if (confirm('Are you sure you want to reset your journey? All progress will be lost.')) {
                onReset();
              }
            }}
            className="w-full bg-[#080d1a] border border-[#ff4466]/30 text-[#ff4466] py-3 rounded-lg font-bold hover:bg-[#ff4466]/10 transition-colors flex items-center justify-center gap-2"
          >
            <Trash2 size={18} /> Reset Journey
          </button>
        </div>

        <button onClick={onLogout} className="w-full text-[#6b849e] font-medium py-4 hover:text-[#f0f4f8] flex items-center justify-center gap-2 transition-colors">
          <LogOut size={18} /> Sign Out
        </button>
      </div>
    </div>
  );
};

// --- Welcome Video Screen ---
const WelcomeVideoScreen = ({
  onContinue,
}: {
  onContinue: () => void;
}) => (
  <div className="min-h-screen bg-[#080d1a] flex flex-col">
    <div className="bg-[#0f1829] border-b border-[#1a2a42] px-6 py-4 flex items-center justify-between">
      <span className="font-semibold text-[#f0f4f8]">Welcome to NeuroActive</span>
      <button
        onClick={onContinue}
        className="text-sm text-[#6b849e] hover:text-[#f0f4f8] transition-colors"
      >
        Skip
      </button>
    </div>
    <div className="flex-1 flex flex-col max-w-2xl mx-auto w-full px-6 py-8 gap-6">
      <VideoPlayer
        nodeId="onboarding_welcome"
        title="Welcome to NeuroActive"
        videoId="PLACEHOLDER_WELCOME"
        autoplayToken={null}
        onConsumeAutoplay={() => {}}
      />
      <p className="text-sm text-[#6b849e] leading-relaxed text-center">
        A quick orientation before you begin. Dr. Bruene explains what to expect, how to get the most out of the app, and what makes this approach different.
      </p>
      <button
        onClick={onContinue}
        className="w-full py-4 rounded-xl font-bold text-[#080d1a] text-base hover:opacity-90 transition-all"
        style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
      >
        Continue to Dashboard
      </button>
    </div>
  </div>
);

// --- Baseline Pain Capture Screen ---
const BaselineCaptureScreen = ({
  onSave,
  todayISO,
}: {
  onSave: (entry: PainLogEntry) => Promise<void>;
  todayISO: () => string;
}) => {
  const [score, setScore] = useState(5);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    await onSave({ date: todayISO(), score, status: 'Same' });
    // painLog.length becomes > 0 after save — parent re-render switches to Dashboard automatically
  };

  return (
    <div className="min-h-screen bg-[#080d1a] flex flex-col">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] px-6 py-4 flex items-center">
        <span className="font-semibold text-[#f0f4f8]">Before we begin</span>
      </div>
      <div className="flex-1 flex flex-col max-w-md mx-auto w-full px-6 py-12 gap-8">
        <div>
          <h1 className="text-2xl font-bold text-[#f0f4f8] mb-3">Before we begin</h1>
          <p className="text-[#6b849e] leading-relaxed">
            Rate your current pain level so we have a baseline to measure your progress against. You will log this daily going forward.
          </p>
        </div>
        <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
          <label className="block text-sm font-medium text-[#6b849e] mb-4">Pain Level (0–10)</label>
          <input
            type="range"
            min="0"
            max="10"
            value={score}
            onChange={(e) => setScore(parseInt(e.target.value))}
            className="w-full h-2 bg-[#1a2a42] rounded-lg appearance-none cursor-pointer accent-[#00d4c8]"
          />
          <div className="flex justify-between items-center text-xs text-[#6b849e] mt-3">
            <span>No Pain</span>
            <span className="font-bold text-[#f0f4f8] text-3xl">{score}</span>
            <span>Worst Possible</span>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-4 rounded-xl font-bold text-[#080d1a] text-base disabled:opacity-50 hover:opacity-90 transition-all"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          {saving ? 'Saving…' : 'Save & Continue'}
        </button>
      </div>
    </div>
  );
};

// --- Pain Tracker Component ---
const PainTracker = ({
  onSaveLog,
  existingLog,
  todayISO,
}: {
  onSaveLog: (entry: PainLogEntry) => void;
  existingLog?: PainLogEntry;
  todayISO: () => string;
}) => {
  const [score, setScore] = useState(existingLog ? existingLog.score : 5);
  const [status, setStatus] = useState<'Better' | 'Same' | 'Worse' | null>(existingLog ? existingLog.status : null);
  const [submitted, setSubmitted] = useState(!!existingLog);

  // Sync state when existingLog loads (e.g. from Firestore)
  useEffect(() => {
    if (existingLog) {
      setScore(existingLog.score);
      setStatus(existingLog.status);
      setSubmitted(true);
    }
  }, [existingLog]);

  const handleSubmit = () => {
    if (!status) return;
    const entry: PainLogEntry = {
      date: todayISO(),
      score,
      status,
    };
    onSaveLog(entry);
    setSubmitted(true);
  };

  if (submitted) {
    return (
      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#00e096]/20 text-center animate-fade-in">
        <CheckCircle className="text-[#00e096] mx-auto mb-2" size={32} />
        <h3 className="font-bold text-[#f0f4f8]">Check-in Complete</h3>
        <p className="text-sm text-[#6b849e]">Thanks for logging your progress today.</p>
        <div className="mt-4 flex justify-center gap-4 text-sm">
          <div className="bg-[#1a2a42] text-[#f0f4f8] px-3 py-1 rounded">
            Pain: <strong>{score}/10</strong>
          </div>
          <div
            className={`px-3 py-1 rounded font-bold ${
              status === 'Better' ? 'bg-[#00e096]/15 text-[#00e096]' : status === 'Worse' ? 'bg-[#ff4466]/15 text-[#ff4466]' : 'bg-[#ffcc00]/15 text-[#ffcc00]'
            }`}
          >
            {status}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
      <h3 className="font-bold text-lg text-[#f0f4f8] mb-4 flex items-center gap-2">
        <Activity className="text-[#00d4c8]" /> Daily Check-in
      </h3>

      <div className="mb-6">
        <label className="block text-sm font-medium text-[#6b849e] mb-2">Pain Level (0-10)</label>
        <input
          type="range"
          min="0"
          max="10"
          value={score}
          onChange={(e) => setScore(parseInt(e.target.value))}
          className="w-full h-2 bg-[#1a2a42] rounded-lg appearance-none cursor-pointer accent-[#00d4c8]"
        />
        <div className="flex justify-between text-xs text-[#6b849e] mt-1">
          <span>No Pain</span>
          <span className="font-bold text-[#f0f4f8] text-lg">{score}</span>
          <span>Worst Possible</span>
        </div>
      </div>

      <div className="mb-6">
        <label className="block text-sm font-medium text-[#6b849e] mb-2">Status vs Yesterday</label>
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => setStatus('Better')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Better' ? 'bg-[#00e096]/20 text-[#00e096] border-[#00e096]' : 'bg-[#080d1a] border-[#1a2a42] text-[#6b849e] hover:border-[#00e096]/50'
            }`}
          >
            <TrendingUp className="mx-auto mb-1" size={16} /> Better
          </button>
          <button
            onClick={() => setStatus('Same')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Same' ? 'bg-[#ffcc00]/20 text-[#ffcc00] border-[#ffcc00]' : 'bg-[#080d1a] border-[#1a2a42] text-[#6b849e] hover:border-[#ffcc00]/50'
            }`}
          >
            <Minus className="mx-auto mb-1" size={16} /> Same
          </button>
          <button
            onClick={() => setStatus('Worse')}
            className={`p-3 rounded-lg border text-sm font-medium transition-all ${
              status === 'Worse' ? 'bg-[#ff4466]/20 text-[#ff4466] border-[#ff4466]' : 'bg-[#080d1a] border-[#1a2a42] text-[#6b849e] hover:border-[#ff4466]/50'
            }`}
          >
            <TrendingDown className="mx-auto mb-1" size={16} /> Worse
          </button>
        </div>
      </div>

      <button
        onClick={handleSubmit}
        disabled={!status}
        className="w-full py-3 rounded-lg font-bold disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-90 transition-all text-[#080d1a]"
        style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
      >
        Save Log
      </button>
    </div>
  );
};

const PainGraph = ({ logs }: { logs: PainLogEntry[] }) => {
  const last7Logs = logs.slice(-7);
  if (logs.length === 0) return null;

  let trend: { label: string; color: string; Icon: typeof TrendingDown } | null = null;
  if (logs.length >= 3) {
    const last3 = logs.slice(-3);
    const prevAvg = (last3[0].score + last3[1].score) / 2;
    const latest = last3[2].score;
    if (latest < prevAvg - 0.5) {
      trend = { label: 'Pain improving', color: '#00e096', Icon: TrendingDown };
    } else if (latest > prevAvg + 0.5) {
      trend = { label: 'Pain worsening', color: '#ff4466', Icon: TrendingUp };
    } else {
      trend = { label: 'Holding steady', color: '#ffcc00', Icon: Minus };
    }
  }

  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42] mt-6">
      <div className="flex justify-between items-center mb-4">
        <h3 className="font-bold text-sm text-[#6b849e] uppercase tracking-wider">Pain History</h3>
        {trend && (
          <div className="flex items-center gap-1 text-xs font-bold" style={{ color: trend.color }}>
            <trend.Icon size={13} />
            {trend.label}
          </div>
        )}
      </div>
      <div className="flex items-end justify-between h-32 gap-2">
        {last7Logs.map((log, i) => (
          <div key={i} className="flex flex-col items-center flex-1">
            <div
              className="w-full rounded-t-sm transition-all"
              style={{
                height: `${(log.score / 10) * 100}%`,
                minHeight: '4px',
                backgroundColor: log.score < 4 ? '#00e096' : log.score < 7 ? '#ffcc00' : '#ff4466',
              }}
            />
            <span className="text-[10px] text-[#6b849e] mt-1">{log.date.slice(5)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const LibraryView = ({ isPremium, onUnlock, onPlay }: { isPremium: boolean; onUnlock: () => void; onPlay: (id: string) => void }) => {
  const [filter, setFilter] = useState<'All' | 'Supine' | 'Prone' | 'Side Lying' | 'Quadruped' | 'MDT' | 'Orientation' | 'DNS'>('All');

  // DNS-only launch: ALL old-library content — DNS position videos included — is
  // off-limits to DNS-course customers by hard rule, no exceptions. The Dashboard card
  // that links here is hidden entirely for the same reason; this is defense-in-depth in
  // case LibraryView is ever reached another way.
  const libraryItems = DNS_ONLY_LAUNCH
    ? []
    : Object.values(DECISION_TREE).filter((node) => node.type === 'video' && node.libraryCategory);
  const filteredItems = filter === 'All' ? libraryItems : libraryItems.filter((item) => item.libraryCategory === filter);
  const visibleCategories = DNS_ONLY_LAUNCH
    ? ['All']
    : ['All', 'Orientation', 'DNS', 'Supine', 'Prone', 'Side Lying', 'Quadruped', 'MDT'];

  return (
    <div className="min-h-screen bg-[#080d1a] pb-20">
      <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30 p-4">
        <h2 className="text-2xl font-bold text-[#f0f4f8] mb-4 flex items-center gap-2">
          <Library className="text-[#00d4c8]" /> Movement Library
        </h2>
        <div className="flex gap-2 overflow-x-auto pb-2 scrollbar-hide">
          {visibleCategories.map((cat) => (
            <button
              key={cat}
              onClick={() => setFilter(cat as any)}
              className="px-4 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-all"
              style={
                filter === cat
                  ? { background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)', color: '#080d1a' }
                  : { backgroundColor: '#1a2a42', color: '#6b849e' }
              }
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      <div className="p-4 grid md:grid-cols-2 gap-4 max-w-5xl mx-auto">
        {!isPremium && (
          <div className="col-span-full rounded-xl p-6 mb-2 border border-[#00d4c8]/20 flex justify-between items-center" style={{ background: 'linear-gradient(135deg, rgba(0,212,200,0.12), rgba(124,92,252,0.12))' }}>
            <div>
              <h3 className="font-bold text-lg text-[#f0f4f8] mb-1">Unlock God Mode</h3>
              <p className="text-[#6b849e] text-sm">
                {DNS_ONLY_LAUNCH ? 'Access the full DNS exercise library.' : 'Access the full DNS & MDT exercise library.'}
              </p>
            </div>
            <button
              onClick={onUnlock}
              className="px-4 py-2 rounded-lg font-bold text-sm text-[#080d1a] hover:opacity-90 transition-all flex-shrink-0 ml-4"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              Upgrade
            </button>
          </div>
        )}

        {filteredItems.map((item) => (
          <div key={item.id} className="bg-[#0f1829] rounded-xl border border-[#1a2a42] overflow-hidden group hover:border-[#00d4c8]/30 transition-all">
            <div className="aspect-video relative flex items-center justify-center">
              {/* Dark thumbnail background */}
              <div className="absolute inset-0 bg-gradient-to-br from-[#0f1829] via-[#1a2a42] to-[#080d1a]" />
              <div className="absolute inset-0 opacity-25 bg-[radial-gradient(circle_at_30%_20%,#00d4c8,transparent_50%),radial-gradient(circle_at_70%_70%,#7c5cfc,transparent_50%)]" />

              {item.isPremium && !isPremium ? (
                <div className="absolute inset-0 bg-[#080d1a]/70 flex flex-col items-center justify-center backdrop-blur-sm z-10">
                  <Lock size={28} className="mb-2 text-[#6b849e]" />
                  <span className="text-xs font-bold text-[#6b849e] uppercase tracking-wider">Premium</span>
                </div>
              ) : (
                <Play size={36} className="relative z-10 text-[#6b849e] group-hover:text-[#00d4c8] transition-colors" />
              )}

              <div className="absolute bottom-3 left-3 right-3 z-10">
                <div className="text-xs font-semibold text-[#6b849e] uppercase tracking-wider">{item.libraryCategory}</div>
                <div className="text-sm font-bold text-[#f0f4f8] line-clamp-1">{item.text}</div>
              </div>
            </div>

            <div className="p-4">
              <div className="flex justify-between items-start mb-2">
                <span className="text-xs font-bold text-[#00d4c8] bg-[#00d4c8]/10 px-2 py-1 rounded">{item.libraryCategory}</span>
                {item.isPremium && (
                  <span className="text-xs text-[#7c5cfc] font-bold flex items-center gap-1">
                    <Activity size={12} /> Pro
                  </span>
                )}
              </div>
              <h3 className="font-bold text-[#f0f4f8] mb-1">{item.text}</h3>
              <p className="text-xs text-[#6b849e] line-clamp-2">{item.description}</p>
              <button
                onClick={() => {
                  if (item.isPremium && !isPremium) {
                    onUnlock();
                  } else {
                    onPlay(item.id);
                  }
                }}
                className="mt-4 w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-medium py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors"
              >
                {item.isPremium && !isPremium ? 'Unlock to Watch' : 'Watch Video'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// --- Main App Component ---
export default function App() {
  const [currentView, setCurrentView] = useState<'landing' | 'assessment' | 'dashboard' | 'paywall' | 'library' | 'settings' | 'dns-course'>('landing');
  const [currentNodeId, setCurrentNodeId] = useState<string>('start');
  const [history, setHistory] = useState<string[]>([]);
  const [isPremium, setIsPremium] = useState(false);
  // Server-computed DNS Foundations entitlement (artifacts/{appId}/users/{uid}/entitlement/main) —
  // written only by Cloud Functions from verified Stripe data, never client-writable (see
  // firestore.rules). This is the actual DNS course security boundary; `isPremium` above
  // stays wired to Settings/Library for legacy display only, per security findings #1-3.
  //
  // Tri-state rather than boolean: 'loading' covers both "waiting on this uid's first
  // snapshot" (avoids flashing the paywall at a legitimate purchaser while their real
  // entitlement is still in flight) AND "uid just changed, previous value no longer
  // applies" (closes the stale-entitlement gap Codex found — see the auth effect below).
  // Only 'entitled' unlocks anything; 'loading' and 'not-entitled' are both treated as
  // locked, so there's no window where a wrong/stale value can unlock the course.
  const [dnsEntitlementState, setDnsEntitlementState] = useState<'loading' | 'entitled' | 'not-entitled'>('loading');
  // The entitlement document's derived `source` field (e.g. 'stripe:program',
  // 'beta_grant') — see functions/src/dnsEntitlement.ts. Display-only: drives the
  // DNS_ONLY_LAUNCH account-status label in Settings, never a security decision (that's
  // dnsEntitlementState alone). Reset alongside dnsEntitlementState everywhere below.
  const [dnsEntitlementSource, setDnsEntitlementSource] = useState<string | null>(null);
  // Tracks whose entitlement dnsEntitlementState currently reflects, so the auth effect
  // can tell "uid actually changed, reset to loading" apart from "same uid, listener
  // re-fired" (e.g. a token refresh) — resetting on every re-fire would flash the
  // loading state for no reason.
  const entitlementUidRef = useRef<string | null>(null);
  const [activePrescriptions, setActivePrescriptions] = useState<string[]>([]);
  const [activeJourney, setActiveJourney] = useState<string | null>(null);
  const [painLog, setPainLog] = useState<PainLogEntry[]>([]);
  const [troubleshootingAttempts, setTroubleshootingAttempts] = useState(0);
  const [checkInBannerDismissed, setCheckInBannerDismissed] = useState(false);
  const painTrackerRef = useRef<HTMLDivElement>(null);
  const [hasWatchedWelcome, setHasWatchedWelcome] = useState(false);
  const [hasWatchedAssessmentIntro, setHasWatchedAssessmentIntro] = useState(false);
  const [authUser, setAuthUser] = useState<{ displayName: string | null; photoURL: string | null; email: string | null; isAnonymous: boolean } | null>(null);
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  // Phase 3A-1: device push registration only (no send-side code exists yet). Ownership
  // transfer on account switching now goes through the server-side lease/transfer protocol
  // in functions/src/pushInstallations.ts (see useNotifications.ts) — this hook lives here,
  // not inside SettingsView, so handleLogout and every account-switching auth handler below
  // can call prepareForAccountSwitch/recoverFromFailedSwitch/unregisterThisDevice regardless
  // of which view is currently active.
  const notifications = useNotifications();
  const notificationPreferences = useNotificationPreferences();
  const [checkoutLoading, setCheckoutLoading] = useState<PriceKey | null>(null);
  const [paymentMessage, setPaymentMessage] = useState<{ type: 'success' | 'canceled'; text: string } | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [dnsCourse, setDnsCourse] = useState<DnsCourseProgress>(DEFAULT_DNS_COURSE);
  // Tracks whose userData/main-derived state (dnsCourse plus every other UID-scoped field
  // below) currently reflects, mirroring entitlementUidRef below — lets the auth effect
  // tell "uid actually changed, reset before hydrating" apart from "same uid, listener
  // re-fired." Originally only guarded dnsCourse; expanded (Codex review, Auth Phase A) to
  // guard the whole UserData-shaped state group after finding several fields used a
  // conditional-hydration pattern (`if (typeof data.x !== 'undefined') setX(...)`) that
  // never resets a field the destination user's document happens to lack — leaving the
  // previous uid's value rendered, and readable by saveUserData's merge writes, under the
  // new uid. Renamed accordingly.
  const userDataUidRef = useRef<string | null>(null);

  // Captured once at mount, before anything has a chance to clear the flag — tells us
  // whether this page load is potentially the return leg of a redirect sign-in.
  const wasRedirectPendingRef = useRef(sessionStorage.getItem(REDIRECT_PENDING_KEY) === '1');
  // Set once onAuthStateChanged has fired for the first time this session.
  const [authStateResolved, setAuthStateResolved] = useState(false);
  // Set once getRedirectResult has settled (resolved or rejected). Only relevant when
  // wasRedirectPendingRef is true — otherwise there's nothing to wait for.
  const [redirectResultResolved, setRedirectResultResolved] = useState(false);

  // NOTE: These are unused in this build but kept for future phases
  // const [phaseLocks, setPhaseLocks] = useState<Record<string, number>>({});
  // const [lastCheckInAt, setLastCheckInAt] = useState<string | null>(null);

  const [showTerms, setShowTerms] = useState(false);
  const [hasAgreedToTerms, setHasAgreedToTerms] = useState(false);
  
  // Pending state for terms agreement flow + Autoplay Intent
  const [pendingNodeId, setPendingNodeId] = useState<string | null>(null);
  const [pendingView, setPendingView] = useState<'landing' | 'assessment' | 'dashboard' | 'paywall' | 'library' | 'settings' | 'dns-course' | null>(null);

  // Pending intent for the baseline pain-log gate — set when "Start Assessment" is
  // clicked but no baseline exists yet; replayed once the baseline is captured.
  const [pendingBaselineNodeId, setPendingBaselineNodeId] = useState<string | null>(null);
  
  // CHANGED: Token pattern "nodeId:timestamp" prevents stale autoplay across nodes
  const [autoplayToken, setAutoplayToken] = useState<string | null>(null);
  const [pendingAutoplay, setPendingAutoplay] = useState(false);
  
  const [simulatedTime, setSimulatedTime] = useState<number>(Date.now());

  // --- time helpers (single source of truth)
  const todayISO = () => new Date(simulatedTime).toISOString().split('T')[0];
  // Local calendar date (not UTC like todayISO) — the DNS course's "complete once per
  // calendar day" rule needs the user's actual local date, not a UTC-shifted one.
  const todayLocalISO = () => {
    const d = new Date(simulatedTime);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  // NOTE: Unused, kept for future logic
  /*
  const hasTodayCheckIn = () => {
    const t = todayISO();
    return painLog.some((l) => l.date === t);
  };

  const isPhaseLocked = (key: string) => {
    const until = phaseLocks?.[key];
    if (!until) return false;
    return simulatedTime < until;
  };
  */

  // Firebase: save user data
  //
  // Under DNS_ONLY_LAUNCH, the pain-recovery/assessment flow has no reachable UI entry
  // point, but the underlying write paths (handleOptionClick, handleResetJourney,
  // handleSavePainLog, the Library/prescription shortcuts) are all still fully wired —
  // hiding a button doesn't stop the function behind it from running if something reaches
  // it another way. Stripping these specific fields here, in the one place all of them
  // funnel through, means no assessment/pain data can reach Firestore while the flag is
  // on, regardless of which call site triggered the write — without special-casing every
  // call site individually, and without touching dnsCourse or any other field. Flip
  // DNS_ONLY_LAUNCH back to restore normal behavior, same as everywhere else it's used.
  const saveUserData = async (updates: Partial<UserData>) => {
    if (!auth || !db || !auth.currentUser) return;

    let toWrite = updates;
    if (DNS_ONLY_LAUNCH) {
      toWrite = { ...updates };
      for (const field of ASSESSMENT_FIELDS_GATED_UNDER_DNS_ONLY_LAUNCH) {
        delete toWrite[field];
      }
      if (Object.keys(toWrite).length === 0) return;
    }

    const uid = auth.currentUser.uid;
    const docRef = doc(db, 'artifacts', appId, 'users', uid, 'userData', 'main');
    await setDoc(docRef, toWrite, { merge: true });
  };

  // setDoc with merge:true replaces the whole dnsCourse map rather than merging it key
  // by key, so always spread the current value first — a partial update (e.g. just
  // currentDay) must never silently drop startedAt.
  const updateDnsCourse = (updates: Partial<DnsCourseProgress>) => {
    const merged = { ...dnsCourse, ...updates };
    setDnsCourse(merged);
    saveUserData({ dnsCourse: merged });
  };

  // NOTE: Unused in this build
  /*
  const lockPhaseForHours = async (key: string, hours: number) => {
    const until = simulatedTime + hours * 60 * 60 * 1000;
    const updated = { ...(phaseLocks || {}), [key]: until };
    setPhaseLocks(updated);
    await saveUserData({ phaseLocks: updated });
  };
  */

  // Reset checkout loading state whenever the view changes so stale loading
  // state from a previous paywall visit never bleeds into the next one.
  useEffect(() => {
    setCheckoutLoading(null);
  }, [currentView]);

  // authLoading only drops once onAuthStateChanged has fired for the first time AND,
  // if this page load is potentially the return leg of a redirect sign-in, getRedirectResult
  // has also settled. Without this second condition, onAuthStateChanged can fire first with
  // a freshly-created anonymous user (see the anonymous-fallback branch below) before the
  // real redirect result has had a chance to resolve and correct it — that race is what
  // produced the "routes through onboarding as a brand-new user" reports on Android Chrome.
  useEffect(() => {
    if (authStateResolved && (!wasRedirectPendingRef.current || redirectResultResolved)) {
      setAuthLoading(false);
    }
  }, [authStateResolved, redirectResultResolved]);

  // Last-resort ceiling so a truly hung auth/redirect check can never block the app
  // permanently. Long enough to cover a slow redirect round-trip; the effect above should
  // almost always win first.
  useEffect(() => {
    const timer = setTimeout(() => setAuthLoading(false), 10000);
    return () => clearTimeout(timer);
  }, []);

  // Handle redirect result after Google sign-in returns to the page. Both mobile and
  // desktop now use the redirect flow (no popup-to-opener handoff to break), so this
  // one effect covers every sign-in/link attempt regardless of device.
  useEffect(() => {
    if (!auth) return;

    // Passwordless email-link completion — same "returning from an external auth step"
    // shape as the Google redirect handled below, just triggered by a normal link click
    // (sendSignInLinkToEmail) rather than a JS-initiated redirect.
    completeEmailLinkSignIn();

    getRedirectResult(auth).then(async (result) => {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
      if (!result) {
        // A redirect was in flight (per the flag set before we navigated away) but
        // Firebase couldn't resolve it on return — e.g. the pending-redirect state didn't
        // survive the round-trip. Surface it instead of silently treating this session as
        // a fresh anonymous user.
        if (wasRedirectPendingRef.current) {
          setSignInError("Sign-in didn't complete — please try again.");
        }
        setRedirectResultResolved(true);
        return;
      }
      // Redirect succeeded — the user stays on whatever view they were on (e.g. Settings)
      // since Google sign-in no longer forces a view change. Save provider info if this
      // was a link-from-anonymous flow.
      await saveUserData({ authProvider: 'google' });
      setRedirectResultResolved(true);
    }).catch(async (error: any) => {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
      setRedirectResultResolved(true);
      if (
        error.code === 'auth/credential-already-in-use' ||
        error.code === 'auth/email-already-in-use'
      ) {
        // Switching accounts here abandons the current anonymous session's data,
        // so confirm first.
        const proceed = window.confirm(
          'This Google identity already belongs to an existing NeuroActive account. Continuing will switch you from this temporary session to that existing account, and progress from this temporary session will not automatically transfer. Continue?'
        );
        if (proceed) {
          sessionStorage.setItem(REDIRECT_PENDING_KEY, '1');
          try {
            await withRedirectTimeout(signInWithRedirect(auth, googleProvider));
          } catch (err) {
            sessionStorage.removeItem(REDIRECT_PENDING_KEY);
            const message = err instanceof Error ? err.message : undefined;
            if (message !== 'redirect-timeout') console.error('Redirect sign-in error:', err);
            setSignInError('Sign-in failed. Please try again.');
          }
        }
      } else if (error.code === 'auth/account-exists-with-different-credential') {
        setSignInError(
          'An account already exists using another sign-in method. Please sign in using the method associated with that account.'
        );
      } else if (error.code !== 'auth/user-cancelled' && error.code !== 'auth/popup-closed-by-user') {
        console.error('Redirect sign-in error:', error);
        setSignInError('Sign-in failed. Please try again.');
      }
    });
  }, []);

  // Check for payment success/canceled URL params on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const payment = params.get('payment');
    if (payment === 'success') {
      // Real premium status comes from the subscriptions/payments listeners below, which
      // reflect the actual Firestore-persisted state — not set optimistically here, since
      // that raced with and got silently overwritten by the real (still-false) data.
      setPaymentMessage({ type: 'success', text: 'Payment successful — welcome to NeuroActive!' });
    } else if (payment === 'canceled') {
      setPaymentMessage({ type: 'canceled', text: 'Payment canceled — no charge was made.' });
    }
    if (payment) {
      const clean = new URL(window.location.href);
      clean.searchParams.delete('payment');
      window.history.replaceState({}, '', clean.toString());
      setTimeout(() => setPaymentMessage(null), 5000);
    }
  }, []);

  // Firebase Auth & Data Sync
  useEffect(() => {
    if (!auth || !db) return;

    let unsubscribeSnapshot: (() => void) | null = null;
    let unsubscribeSubscriptions: (() => void) | null = null;
    let unsubscribePayments: (() => void) | null = null;
    let unsubscribeEntitlement: (() => void) | null = null;

    const unsubscribeAuth = onAuthStateChanged(auth, (user) => {
      // Safety net: an unexpected throw anywhere in here must never leave authLoading
      // stuck true (permanent splash screen) — setAuthLoading(false) always runs.
      try {
      if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
      }

      console.log('[Auth] state change:', user?.uid, user?.isAnonymous, user?.providerData);

      if (user) {
        setAuthUser({ displayName: user.displayName, photoURL: user.photoURL, email: user.email, isAnonymous: user.isAnonymous });

        if (!user.isAnonymous) {
          // Ensure a customers/{uid} document exists so the Stripe extension
          // createCustomer function fires. Must be a CREATE (not UPDATE) to trigger
          // the extension's onDocumentCreated listener.
          const customerRef = doc(db, 'customers', user.uid);
          getDoc(customerRef).then((snap) => {
            if (!snap.exists()) {
              setDoc(customerRef, { email: user.email ?? '', name: user.displayName ?? '' })
                .catch((err) => console.warn('[Stripe] customer doc create failed:', err));
            }
          }).catch((err) => console.warn('[Stripe] customer doc check failed:', err));
        }

        if (userDataUidRef.current !== user.uid) {
          // uid actually changed — synchronously reset every UID-scoped field to its safe
          // default BEFORE this uid's userData listener has any chance to hydrate it, so a
          // different account never starts out showing (or later persisting, via
          // saveUserData's merge writes) the previous account's in-memory state. If the
          // destination uid's document lacks any of these fields, the default is simply
          // what stays — several of these (activeJourney, activePrescriptions, history,
          // currentNodeId, isPremium, painLog, hasAgreedToTerms) previously used a
          // conditional-hydration pattern in the listener below (only set if the field was
          // actually present on the new doc) that left the OLD uid's value on screen
          // whenever the new doc lacked that field — this closes that gap. Linking a new
          // Google/email identity onto an existing (anonymous) session keeps the same uid,
          // so this branch doesn't fire and progress is left untouched, same as before.
          userDataUidRef.current = user.uid;
          setDnsCourse(DEFAULT_DNS_COURSE);
          setActiveJourney(null);
          setActivePrescriptions([]);
          setHistory([]);
          setCurrentNodeId('start');
          setIsPremium(false);
          setPainLog([]);
          setHasAgreedToTerms(false);
          setTroubleshootingAttempts(0);
          setHasWatchedWelcome(false);
          setHasWatchedAssessmentIntro(false);
        }

        const docRef = doc(db, 'artifacts', appId, 'users', user.uid, 'userData', 'main');

        unsubscribeSnapshot = onSnapshot(docRef, (docSnap) => {
          if (!docSnap.exists()) return;

          const data = docSnap.data() as Partial<UserData>;

          if (typeof data.activeJourney !== 'undefined') setActiveJourney(data.activeJourney ?? null);
          if (Array.isArray(data.activePrescriptions)) setActivePrescriptions(data.activePrescriptions);
          if (Array.isArray(data.history)) setHistory(data.history);
          if (typeof data.currentNodeId === 'string') setCurrentNodeId(data.currentNodeId);
          if (typeof data.isPremium === 'boolean') setIsPremium(data.isPremium);
          if (Array.isArray(data.painLog)) setPainLog(data.painLog);
          // if (data.phaseLocks && typeof data.phaseLocks === 'object') setPhaseLocks(data.phaseLocks as Record<string, number>);
          // if (typeof data.lastCheckInAt === 'string') setLastCheckInAt(data.lastCheckInAt);
          if (typeof data.hasAgreedToTerms === 'boolean') setHasAgreedToTerms(data.hasAgreedToTerms);
          setTroubleshootingAttempts(data.troubleshootingAttempts ?? 0);
          setHasWatchedWelcome(data.hasWatchedWelcome ?? false);
          setHasWatchedAssessmentIntro(data.hasWatchedAssessmentIntro ?? false);
          if (data.dnsCourse) setDnsCourse(normalizeDnsCourse(data.dnsCourse));
        });

        // DNS Foundations entitlement — server-written only (functions/src/index.ts
        // recomputeDnsEntitlement), never client-writable (see firestore.rules). This is
        // the actual security boundary for DNS course access/video credentials; it's
        // read-only here, never set from client state.
        if (unsubscribeEntitlement) unsubscribeEntitlement();
        if (entitlementUidRef.current !== user.uid) {
          // uid actually changed (not just this listener re-firing for the same user) —
          // drop the previous user's entitlement value immediately, before the new
          // listener has had any chance to report anything. Closes the window Codex
          // found: without this, a stale `true` from the previous account could remain
          // on screen (and gate a DayVideo fetch) until the new snapshot — or its error
          // callback — resolves, which might never happen.
          entitlementUidRef.current = user.uid;
          setDnsEntitlementState('loading');
          setDnsEntitlementSource(null);
        }
        const entitlementRef = doc(db, 'artifacts', appId, 'users', user.uid, 'entitlement', 'main');
        unsubscribeEntitlement = onSnapshot(
          entitlementRef,
          (snap) => {
            const entitled = snap.exists() && snap.data()?.dnsFoundationsEntitled === true;
            setDnsEntitlementState(entitled ? 'entitled' : 'not-entitled');
            setDnsEntitlementSource(entitled ? (snap.data()?.source ?? null) : null);
          },
          (err) => {
            console.warn('[Entitlement] snapshot failed:', err);
            // Fail closed: an errored listener must never leave a stale 'entitled' (or
            // indefinite 'loading') on screen.
            setDnsEntitlementState('not-entitled');
            setDnsEntitlementSource(null);
          }
        );

        // Stripe sync — isPremium is the OR of two independent signals: an active/trialing
        // subscription, or a succeeded one-time payment (e.g. the 12-Week Program). Each
        // listener only knows about its own collection, so neither may write isPremium
        // unilaterally — that would let one listener's snapshot stomp the other's
        // contribution. Both funnel through recomputeIsPremium so the combined truth is
        // always what gets persisted, regardless of which listener fired most recently.
        let hasActiveSubscription = false;
        let hasSucceededPayment = false;
        const userDocRef = doc(db, 'artifacts', appId, 'users', user.uid, 'userData', 'main');
        const recomputeIsPremium = () => {
          const premium = hasActiveSubscription || hasSucceededPayment;
          setIsPremium(premium);
          const updates: Partial<UserData> = { isPremium: premium };
          if (hasSucceededPayment) updates.subscriptionTier = 'program';
          setDoc(userDocRef, updates, { merge: true }).catch((err) =>
            console.warn('[Stripe] isPremium write failed:', err)
          );
        };

        if (unsubscribeSubscriptions) unsubscribeSubscriptions();
        unsubscribeSubscriptions = onSnapshot(
          collection(db, 'customers', user.uid, 'subscriptions'),
          (snap) => {
            const active = snap.docs.find(
              (d) => d.data().status === 'active' || d.data().status === 'trialing'
            );
            hasActiveSubscription = !!active;
            recomputeIsPremium();
          }
        );

        // One-time purchases (e.g. 'program') land in customers/{uid}/payments rather than
        // /subscriptions — without this, a one-time purchase never durably grants access.
        if (unsubscribePayments) unsubscribePayments();
        unsubscribePayments = onSnapshot(
          collection(db, 'customers', user.uid, 'payments'),
          (snap) => {
            const succeeded = snap.docs.find((d) => d.data().status === 'succeeded');
            hasSucceededPayment = !!succeeded;
            recomputeIsPremium();
          }
        );
      } else {
        setAuthUser(null);
        if (unsubscribeSubscriptions) { unsubscribeSubscriptions(); unsubscribeSubscriptions = null; }
        if (unsubscribePayments) { unsubscribePayments(); unsubscribePayments = null; }
        if (unsubscribeEntitlement) { unsubscribeEntitlement(); unsubscribeEntitlement = null; }
        entitlementUidRef.current = null;
        setDnsEntitlementState('loading');
        setDnsEntitlementSource(null);
        userDataUidRef.current = null;
        setDnsCourse(DEFAULT_DNS_COURSE);
        // Symmetric with the userDataUidRef reset in the `if (user)` branch above — closes
        // the same staleness gap for the brief window between sign-out and the fresh
        // anonymous sign-in below resolving, rather than relying solely on the uid-changed
        // check to catch it once the new anonymous user's onAuthStateChanged fires.
        setActiveJourney(null);
        setActivePrescriptions([]);
        setHistory([]);
        setCurrentNodeId('start');
        setIsPremium(false);
        setPainLog([]);
        setHasAgreedToTerms(false);
        setTroubleshootingAttempts(0);
        setHasWatchedWelcome(false);
        setHasWatchedAssessmentIntro(false);
        // No session at all — sign in anonymously in the background so guest access is
        // frictionless. The user stays on whatever view they're on (default: landing);
        // no separate sign-in screen or explicit "continue as guest" click required.
        if (auth) {
          signInAnonymously(auth).catch((err) => console.error('Anonymous sign-in failed:', err));
        }
      }
      } catch (err) {
        console.error('[Auth] onAuthStateChanged callback threw:', err);
      } finally {
        setAuthStateResolved(true);
      }
    });

    return () => {
      if (unsubscribeSnapshot) unsubscribeSnapshot();
      if (unsubscribeSubscriptions) unsubscribeSubscriptions();
      if (unsubscribePayments) unsubscribePayments();
      if (unsubscribeEntitlement) unsubscribeEntitlement();
      unsubscribeAuth();
    };
  }, []);

  const handleSavePainLog = async (entry: PainLogEntry) => {
    // Replace today's log if it already exists
    const next = [...painLog.filter((l) => l.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date));
    setPainLog(next);
    // setLastCheckInAt(entry.date);
    await saveUserData({ painLog: next, lastCheckInAt: entry.date });
  };

  // Saves the baseline entry, then replays the assessment entry that was queued
  // when the baseline gate intercepted "Start Assessment".
  const handleBaselineSaveAndContinue = async (entry: PainLogEntry) => {
    await handleSavePainLog(entry);
    const nodeId = pendingBaselineNodeId;
    setPendingBaselineNodeId(null);
    if (nodeId) {
      setHistory([]);
      setCurrentNodeId(nodeId);
      attemptNavigation('assessment');
    }
  };

  const handleResetJourney = async () => {
    const updates: Partial<UserData> = {
      activeJourney: null,
      activePrescriptions: [],
      history: [],
      currentNodeId: 'start',
      troubleshootingAttempts: 0,
    };
    await saveUserData(updates);

    setActiveJourney(null);
    setActivePrescriptions([]);
    setHistory([]);
    setCurrentNodeId('start');
    setTroubleshootingAttempts(0);
    setCurrentView('dashboard');
    setAutoplayToken(null);
  };

  const handleLogout = async () => {
    if (!auth) return;
    // Best-effort — revokes (tombstones) this device's installation server-side before
    // signing out, so it's immediately ineligible as a future send target. Logout is never
    // blocked on this: if it fails, the record simply stays active under the outgoing uid
    // until a future claim supersedes it through the lease/transfer protocol, never through
    // a bare takeover (see useNotifications.ts's unregisterThisDevice).
    await notifications.unregisterThisDevice();
    await signOut(auth);

    setActiveJourney(null);
    setActivePrescriptions([]);
    setHistory([]);
    setCurrentNodeId('start');
    setIsPremium(false);
    entitlementUidRef.current = null;
    setDnsEntitlementState('loading');
    setDnsEntitlementSource(null);
    userDataUidRef.current = null;
    setDnsCourse(DEFAULT_DNS_COURSE);
    setPainLog([]);
    // setPhaseLocks({});
    // setLastCheckInAt(null);
    setHasAgreedToTerms(false);
    setTroubleshootingAttempts(0);
    setHasWatchedWelcome(false);
    setHasWatchedAssessmentIntro(false);
    setAuthUser(null);
    setCurrentView('landing');
    setAutoplayToken(null);
  };

  const handleGoogleSignIn = async () => {
    if (!auth) return;
    setSignInLoading(true);
    setSignInError(null);
    sessionStorage.setItem(REDIRECT_PENDING_KEY, '1');
    try {
      const currentUser = auth.currentUser;
      // Full-page redirect, on both mobile and desktop — result handled by the shared
      // getRedirectResult effect on page reload. Avoids the popup-to-opener handoff,
      // which was found to silently fail when Google's MFA/2FA step is involved: the
      // user completes auth successfully but the popup never relays the result back,
      // leaving the app stuck in a permanent "signing in" state.
      //
      // Raced against a timeout: if the browser never actually performs the top-level
      // navigation, the promise hangs with no throw — this surfaces an error and resets
      // the button instead of leaving it stuck on "Signing in…" forever.
      if (currentUser && currentUser.isAnonymous) {
        await withRedirectTimeout(linkWithRedirect(currentUser, googleProvider));
      } else {
        // currentUser is either null or already a different permanent uid — signInWithRedirect
        // can replace it with a different account entirely.
        if (notifications.isAccountSwitchBusy()) {
          sessionStorage.removeItem(REDIRECT_PENDING_KEY);
          setSignInError('An account change is already in progress on this device. Please wait a moment and try again.');
          return;
        }
        // Must prepare the notification transfer BEFORE the redirect navigates away: this is
        // the last point at which auth.currentUser still proves ownership of the outgoing
        // uid's installation. If prepare fails, the switch must NOT proceed — A stays
        // authenticated and unaffected, rather than silently losing the ability to ever
        // transfer this device's registration. 'not-applicable' (nothing registered here)
        // proceeds immediately with no notification-related blocking at all.
        const prepareResult = await notifications.prepareForAccountSwitch();
        if (prepareResult === 'blocked') {
          sessionStorage.removeItem(REDIRECT_PENDING_KEY);
          setSignInError('Could not prepare this device for an account change. Please check your connection and try again.');
          return;
        }
        // The actual claim (or cancellation, if the redirect fails/is canceled) happens on
        // whatever page load follows — see useNotifications.ts's reconciliation effect,
        // which persists across the redirect via localStorage.
        await withRedirectTimeout(signInWithRedirect(auth, googleProvider));
      }
    } catch (error: any) {
      sessionStorage.removeItem(REDIRECT_PENDING_KEY);
      // Covers the (rare) case where signInWithRedirect throws before actually navigating
      // away — no page reload happens, so the reconciliation effect won't naturally re-fire
      // on its own; this is what picks up and cancels the just-prepared transfer instead.
      await notifications.recoverFromFailedSwitch();
      if (error?.message === 'redirect-timeout') {
        setSignInError('Sign-in is taking longer than expected. Please check your connection and try again.');
      } else {
        console.error('Google sign-in error:', error);
        setSignInError('Sign-in failed. Please try again.');
      }
    } finally {
      setSignInLoading(false);
    }
  };

  // Kicks off the passwordless flow: send the link, remember the email locally (per
  // Firebase's documented pattern) so completeEmailLinkSignIn below can find it again
  // when the link is opened — possibly in a different browser/device than this one.
  // Failures surface via the shared signInError state; success is confirmed locally by
  // the caller (Paywall) since "email sent" isn't an error and doesn't belong there.
  const handleSendSignInLink = async (email: string) => {
    if (!auth) return;
    setSignInLoading(true);
    setSignInError(null);
    try {
      await sendSignInLinkToEmail(auth, email, {
        url: EMAIL_LINK_CONTINUE_URL,
        handleCodeInApp: true,
      });
      window.localStorage.setItem(EMAIL_LINK_STORAGE_KEY, email);
    } catch (error) {
      setSignInError(mapEmailAuthError(error));
      throw error;
    } finally {
      setSignInLoading(false);
    }
  };

  // Completes a magic-link sign-in when this page load is the return from the emailed
  // link. Mirrors handleGoogleSignIn's structure: link to the existing anonymous UID
  // when possible (so purchase/progress carries over), falling back to a plain sign-in —
  // with the same "this will switch accounts" confirmation — whenever completing here
  // would abandon whatever's currently active (an existing account for this email, or an
  // already-signed-in non-anonymous session).
  const completeEmailLinkSignIn = async () => {
    if (!auth || !isSignInWithEmailLink(auth, window.location.href)) return;

    let email = window.localStorage.getItem(EMAIL_LINK_STORAGE_KEY);
    if (!email) {
      // Opened on a different device/browser than the one that requested the link —
      // fall back to asking, rather than failing silently.
      email = window.prompt('Please confirm the email address you used to request this sign-in link:');
    }
    if (!email) {
      setSignInError('Sign-in link could not be confirmed — no email provided.');
      return;
    }

    setSignInLoading(true);
    setSignInError(null);
    try {
      const currentUser = auth.currentUser;

      if (currentUser && currentUser.isAnonymous) {
        try {
          await linkWithCredential(currentUser, EmailAuthProvider.credentialWithLink(email, window.location.href));
        } catch (linkError) {
          const code = linkError && typeof linkError === 'object' && 'code' in linkError ? (linkError as { code: unknown }).code : undefined;
          const isExistingEmailAccount =
            code === 'auth/email-already-in-use' ||
            code === 'auth/credential-already-in-use';
          if (code === 'auth/account-exists-with-different-credential') {
            setSignInError(
              'An account already exists using another sign-in method. Please sign in using the method associated with that account.'
            );
            return;
          }
          if (!isExistingEmailAccount) throw linkError;
          const description = await describeExistingEmailAccount(auth, email);
          if (description.includes('Google')) {
            setSignInError(description);
            return;
          }
          const proceed = window.confirm(
            `${description} Signing in will switch you to that account, and any progress from this session will not transfer. Continue?`
          );
          if (!proceed) return;
          await signInWithEmailLink(auth, email, window.location.href);
        }
      } else {
        const proceed = window.confirm(
          'Signing in with this email will switch your active account, and any progress from this session will not transfer. Continue?'
        );
        if (!proceed) return;
        // currentUser here is null or already a different permanent uid — this call replaces
        // it directly (no redirect involved).
        if (notifications.isAccountSwitchBusy()) {
          setSignInError('An account change is already in progress on this device. Please wait a moment and try again.');
          return;
        }
        // Prepare the notification transfer first, while still authenticated as the outgoing
        // uid. If it fails, do NOT proceed with the switch — stay signed in as the outgoing
        // account rather than silently losing the ability to transfer this device later.
        const prepareResult = await notifications.prepareForAccountSwitch();
        if (prepareResult === 'blocked') {
          setSignInError('Could not prepare this device for an account change. Please check your connection and try again.');
          return;
        }
        await signInWithEmailLink(auth, email, window.location.href);
      }

      window.localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
      const clean = new URL(window.location.href);
      ['apiKey', 'oobCode', 'mode', 'lang', 'continueUrl'].forEach((key) => clean.searchParams.delete(key));
      window.history.replaceState({}, '', clean.toString());
    } catch (error) {
      setSignInError(mapEmailAuthError(error));
      // No page reload happens on this path (unlike the Google redirect), so nothing else
      // would naturally pick up and cancel a transfer that was prepared but never completed.
      await notifications.recoverFromFailedSwitch();
    } finally {
      setSignInLoading(false);
    }
  };

  // AUTH PHASE A — reliable installed-PWA credential, alongside (not replacing) Google and
  // the magic link. All three password handlers below deliberately never call
  // fetchSignInMethodsForEmail (deprecated/silently degraded under email-enumeration
  // protection, per the investigation) — collisions are detected only from the auth error
  // Firebase itself throws.

  // Anonymous → permanent upgrade via linkWithCredential, mirroring handleGoogleSignIn's
  // linkWithRedirect and completeEmailLinkSignIn's linkWithCredential(credentialWithLink):
  // the SAME uid gets the new credential, so existing local progress/entitlement (both
  // keyed by uid, not email) is never disturbed. Deliberately does not fall back to
  // createUserWithEmailAndPassword — the app's auto-anonymous-sign-in effect guarantees
  // auth.currentUser is always set by the time this can be called from the UI, and a
  // fallback here would be an easy way to accidentally create a duplicate account instead
  // of linking. Returns 'account-exists' (rather than throwing) for the one collision case
  // the caller needs to react to in the UI — every other failure still throws/sets
  // signInError the same way the other handlers do.
  const handleCreatePasswordAccount = async (
    email: string,
    password: string
  ): Promise<'ok' | 'account-exists'> => {
    if (!auth) return 'ok';
    const currentUser = auth.currentUser;
    if (!currentUser) {
      setSignInError('Something went wrong. Please try again.');
      return 'ok';
    }
    setSignInLoading(true);
    setSignInError(null);
    try {
      const credential = EmailAuthProvider.credential(email, password);
      await linkWithCredential(currentUser, credential);
      return 'ok';
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
      // All three collision shapes Firebase can return here mean the same thing from the
      // user's perspective — this email already belongs to an account — and get the same
      // safe treatment: no duplicate, no auto-switch, generic guidance (never naming which
      // provider that account uses, so this can't be turned into an email-enumeration
      // oracle the way a provider-specific message would).
      if (
        code === 'auth/email-already-in-use' ||
        code === 'auth/credential-already-in-use' ||
        code === 'auth/account-exists-with-different-credential'
      ) {
        // Do NOT fall back to signing in automatically here — Task 2 requires the
        // anonymous session to stay untouched until the user deliberately signs in. The
        // caller (Paywall) switches its own local form to sign-in mode with the email
        // prefilled; nothing about auth.currentUser changes until they submit that form.
        setSignInError('An account with this email already exists.');
        return 'account-exists';
      }
      setSignInError(mapPasswordAuthError(error));
      throw error;
    } finally {
      setSignInLoading(false);
    }
  };

  // Returning password user. A plain sign-in (not a link attempt) — the user is explicitly
  // asserting "I already have an account", so unlike the create-account path this always
  // ends by replacing auth.currentUser with the pre-existing permanent uid, the same shape
  // as the existing "switch accounts" branches in handleGoogleSignIn/completeEmailLinkSignIn.
  // Only prompts for confirmation first if there's something real to lose — an anonymous
  // session that hasn't actually started the course/logged anything yet is dropped silently,
  // same as it would be by simply reloading the page.
  const handleSignInWithPassword = async (email: string, password: string) => {
    if (!auth) return;
    const currentUser = auth.currentUser;
    const isAbandoningRealAccount = !!currentUser && !currentUser.isAnonymous;
    const isAbandoningAnonymousProgress =
      !!currentUser?.isAnonymous && (!!dnsCourse.startedAt || painLog.length > 0 || !!activeJourney);
    if (isAbandoningRealAccount || isAbandoningAnonymousProgress) {
      const proceed = window.confirm(
        'Signing in will switch your active account, and any progress from this session will not transfer. Continue?'
      );
      if (!proceed) return;
    }
    if (isAbandoningRealAccount && notifications.isAccountSwitchBusy()) {
      setSignInError('An account change is already in progress on this device. Please wait a moment and try again.');
      return;
    }
    setSignInLoading(true);
    setSignInError(null);
    try {
      if (isAbandoningRealAccount) {
        // Replacing an already-signed-in permanent uid directly (no redirect involved) —
        // prepare the notification transfer first, while still authenticated as it. If it
        // fails, do NOT proceed with the switch — stay signed in as the outgoing account.
        const prepareResult = await notifications.prepareForAccountSwitch();
        if (prepareResult === 'blocked') {
          setSignInError('Could not prepare this device for an account change. Please check your connection and try again.');
          return;
        }
      }
      await signInWithEmailAndPassword(auth, email, password);
    } catch (error) {
      setSignInError(mapPasswordAuthError(error));
      // No page reload happens on this path, so nothing else would naturally pick up and
      // cancel a transfer that was prepared but never completed.
      await notifications.recoverFromFailedSwitch();
    } finally {
      setSignInLoading(false);
    }
  };

  // Settings-only: lets an already-authenticated permanent user (Google or magic-link
  // origin, doesn't matter which) set a password on their own current uid, so they can sign
  // in with it later from an installed PWA where the magic link can't reliably reach them.
  // Requires an actual signed-in, non-anonymous user with a real email — there is no
  // email-matching path here (updatePassword takes no email argument at all), auth.currentUser
  // is the sole authority.
  //
  // Uses updatePassword(currentUser, password), NOT linkWithCredential +
  // EmailAuthProvider.credential. Codex review caught that linkWithCredential was wrong here:
  // Firebase's email-link and email/password sign-in methods share the same underlying
  // 'password' provider, so an existing magic-link-only user already has a 'password'
  // provider entry — linkWithCredential would throw auth/provider-already-linked for them
  // even though they have no actual usable password, and the previous version of this
  // handler misread that as "already has a password," silently defeating the whole
  // migration use case this Settings action exists for. updatePassword instead mutates the
  // already-authenticated user's own credential in place — it doesn't add/link a new
  // provider, can't collide with an existing one, can't touch a different account, and
  // can't change uid (verified against Firebase's current "Manage Users" docs — this is the
  // documented primitive for "set a signed-in user's password").
  //
  // updatePassword requires a recent sign-in (a Firebase-enforced sensitivity requirement,
  // not something this app can bypass) — a session that authenticated more than roughly 5
  // minutes ago throws auth/requires-recent-login. Fails closed here: no reauthentication
  // flow is attempted, the error is surfaced plainly, and the caller stays on the form so
  // the user can sign out/in again and retry.
  const handleSetPassword = async (password: string): Promise<'ok' | 'requires-recent-login'> => {
    if (!auth) return 'ok';
    const currentUser = auth.currentUser;
    if (!currentUser || currentUser.isAnonymous || !currentUser.email) {
      setSignInError('Something went wrong. Please try again.');
      return 'ok';
    }
    setSignInLoading(true);
    setSignInError(null);
    try {
      await updatePassword(currentUser, password);
      return 'ok';
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? (error as { code: unknown }).code : undefined;
      if (code === 'auth/requires-recent-login') {
        setSignInError('For your security, please sign out and sign back in, then try again.');
        return 'requires-recent-login';
      }
      setSignInError(mapPasswordAuthError(error));
      throw error;
    } finally {
      setSignInLoading(false);
    }
  };

  // UPDATED: Honest navigation intent handler (Strict Mode)
  const attemptNavigation = (
    targetView: 'assessment' | 'dashboard' | 'library' | 'dns-course',
    nodeId?: string,
    autoplay: boolean = false
  ) => {
    if (hasAgreedToTerms) {
      if (targetView === 'assessment') {
        if (nodeId) {
          setCurrentNodeId(nodeId);
          if (autoplay) setAutoplayToken(`${nodeId}:${Date.now()}`);
          else setAutoplayToken(null);
        } else {
          // No specific node means "fresh assessment", kill any stale autoplay intent
          setAutoplayToken(null);
        }
      } else {
        // Leaving assessment implies killing the video token
        setAutoplayToken(null);
      }
      
      setCurrentView(targetView);
    } else {
      setPendingView(targetView);
      if (nodeId && targetView === 'assessment') setPendingNodeId(nodeId);
      setPendingAutoplay(autoplay); // Store intent
      setShowTerms(true);
    }
  };

  // DNS launch purchase entry points all pass through DNSCourseView so entitlement
  // loading and the pre-paywall introduction cannot be bypassed by an Upgrade button.
  const openUpgrade = () => {
    if (DNS_ONLY_LAUNCH) attemptNavigation('dns-course');
    else setCurrentView('paywall');
  };

  // Shared entry point for "Start/New/Begin Assessment" — the only callers that
  // enter the assessment flow fresh (no specific nodeId). Deep links (Library
  // playback, prescription follow-up, etc.) always pass a nodeId and skip this
  // gate entirely, since reaching those already implies a prior fresh entry.
  const startFreshAssessment = () => {
    const initialNodeId = !hasWatchedAssessmentIntro ? 'onboarding_assessment_intro' : 'start';
    if (hasAgreedToTerms && painLog.length === 0) {
      setPendingBaselineNodeId(initialNodeId);
      return;
    }
    setHistory([]);
    setCurrentNodeId(initialNodeId);
    attemptNavigation('assessment');
  };

  const handleTermsAgree = () => {
    setHasAgreedToTerms(true);
    setShowTerms(false);
    saveUserData({ hasAgreedToTerms: true });

    // Capture intent locally before clearing state (clean atomic transition)
    const nextNode = pendingNodeId;
    const nextView = pendingView;
    const shouldAutoplay = pendingAutoplay;

    // Clear pending state immediately
    setPendingNodeId(null);
    setPendingView(null);
    setPendingAutoplay(false);

    // Apply intent
    if (nextView === 'assessment') {
      if (nextNode) {
        setCurrentNodeId(nextNode);
        setAutoplayToken(shouldAutoplay ? `${nextNode}:${Date.now()}` : null);
      } else {
        // terms accepted then entering assessment generically: kill any stale token
        setAutoplayToken(null);
      }
    } else {
      // Going elsewhere? kill token
      setAutoplayToken(null);
    }
    
    if (nextView) {
      setCurrentView(nextView as any);
    }
  };

  const handleTermsDecline = () => {
    setShowTerms(false);
    setPendingView(null);
    setPendingNodeId(null);
    setPendingAutoplay(false);
  };

  const handleOptionClick = (nextId: string) => {
    if (nextId === '__RETURN__') {
      if (history.length > 0) {
        const prevId = history[history.length - 1];
        setCurrentNodeId(prevId);
        setHistory((prev) => prev.slice(0, -1));
      }
      return;
    }

    // Cross-system navigation sentinel: escape hatches into the DNS course view rather
    // than another DECISION_TREE node. True regardless of DNS_ONLY_LAUNCH — anyone who
    // reaches an option using this sentinel got there via DNS course content, so
    // returning to the course is correct in either launch mode.
    if (nextId === '__DNS_COURSE__') {
      setCurrentView('dns-course');
      return;
    }

    const nextNode = DECISION_TREE[nextId];

    if (!nextNode) {
      console.error(`Decision tree missing node: ${nextId}`);
      return;
    }

    const updates: Partial<UserData> = { currentNodeId: nextId };

    // Mark assessment intro as watched when navigating away from it
    if (currentNodeId === 'onboarding_assessment_intro' && !hasWatchedAssessmentIntro) {
      setHasWatchedAssessmentIntro(true);
      updates.hasWatchedAssessmentIntro = true;
    }

    if (nextId.includes('troubleshoot')) {
      const newCount = troubleshootingAttempts + 1;
      setTroubleshootingAttempts(newCount);
      updates.troubleshootingAttempts = newCount;
    }

    if (nextNode.journeyName) {
      setActiveJourney(nextNode.journeyName);
      updates.activeJourney = nextNode.journeyName;
    }

    if (nextNode.type === 'video') {
      const toRemove = new Set(nextNode.replaces ?? []);
      const newPrescriptions = [
        ...activePrescriptions.filter((id) => id !== nextId && !toRemove.has(id)),
        nextId,
      ];
      setActivePrescriptions(newPrescriptions);
      updates.activePrescriptions = newPrescriptions;
    }

    if (nextNode.prescribes && nextNode.prescribes.length > 0) {
      const toAdd = nextNode.prescribes;
      const existing = new Set(activePrescriptions);
      const newPrescriptions = [
        ...activePrescriptions,
        ...toAdd.filter((id) => !existing.has(id)),
      ];
      setActivePrescriptions(newPrescriptions);
      updates.activePrescriptions = newPrescriptions;
    }

    const newHistory = [...history, currentNodeId];
    setHistory(newHistory);
    updates.history = newHistory;

    // Clear autoplay intent when navigating deeper
    setAutoplayToken(null);
    setCurrentNodeId(nextId);

    saveUserData(updates);
  };

  const LandingPage = () => (
    <div className="flex flex-col min-h-screen bg-[#080d1a]">
      <header
        className="flex justify-between items-center p-6 border-b sticky top-0 z-50 backdrop-blur-md border-[#1a2a42]"
        style={{ backgroundColor: 'rgba(8,13,26,0.85)' }}
      >
        <div className="flex items-center gap-2">
          <img
            src="/logo.png"
            alt="NeuroActive"
            className="h-10 w-auto object-contain"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).src = '/logo.png';
            }}
          />
          <span className="text-xl font-bold text-[#f0f4f8]">NeuroActive</span>
        </div>
        {authUser && !authUser.isAnonymous ? (
          <button
            onClick={() => setCurrentView('settings')}
            className="flex-shrink-0 hover:opacity-80 transition-opacity"
            aria-label="Settings"
          >
            {authUser.photoURL ? (
              <img
                src={authUser.photoURL}
                alt="Profile"
                className="w-8 h-8 rounded-full object-cover border-2 border-[#00d4c8]/40"
              />
            ) : (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-[#080d1a]"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                {(authUser.displayName ?? 'U').split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
            )}
          </button>
        ) : (
          // Hidden for DNS-only launch (not deleted) — was a direct, unintended bypass
          // straight to Dashboard. Anonymous auth is already silent/automatic, so this
          // isn't needed for guest access; restore by flipping DNS_ONLY_LAUNCH.
          !DNS_ONLY_LAUNCH && (
            <button
              onClick={() => attemptNavigation('dashboard')}
              className="text-sm font-semibold text-[#00d4c8] hover:opacity-80 transition-opacity"
            >
              Login
            </button>
          )
        )}
      </header>

      <main className="flex-1 flex flex-col items-center justify-center text-center px-8 py-16 relative overflow-hidden">
        {/* ambient glow blobs */}
        <div className="absolute top-1/4 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full opacity-10 blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, #00d4c8 0%, transparent 70%)' }} />
        <div className="absolute bottom-1/4 left-1/2 -translate-x-1/2 w-[400px] h-[400px] rounded-full opacity-10 blur-3xl pointer-events-none" style={{ background: 'radial-gradient(circle, #7c5cfc 0%, transparent 70%)' }} />

        <img
          src="/logo.png"
          alt="NeuroActive"
          className="h-24 w-auto object-contain mb-10 relative z-10"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).src = '/logo.png';
          }}
        />

        <h1 className="text-4xl md:text-5xl font-extrabold text-[#f0f4f8] mb-6 max-w-3xl leading-tight relative z-10">
          {DNS_ONLY_LAUNCH ? (
            <>
              Rebuild your foundation with{' '}
              <span
                style={{
                  background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                DNS
              </span>
            </>
          ) : (
            <>
              Choose your own adventure rehab with{' '}
              <span
                style={{
                  background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                  backgroundClip: 'text',
                }}
              >
                DNS & MDT
              </span>
            </>
          )}
        </h1>

        <p className="text-lg text-[#6b849e] max-w-xl mb-10 relative z-10">
          {DNS_ONLY_LAUNCH
            ? 'A guided 12-week developmental progression, built to rebuild your stabilization foundation one position at a time.'
            : 'Clinical-grade self-assessment and rehabilitation, built to guide you step by step.'}
        </p>

        {DNS_ONLY_LAUNCH ? (
          // Single-path CTA for DNS-only launch. The two-path version below is kept
          // intact (not deleted) — flip DNS_ONLY_LAUNCH in src/config/launchConfig.ts
          // to restore it once the pain-recovery track is ready.
          <div className="w-full max-w-md relative z-10">
            <button
              onClick={() => attemptNavigation('dns-course')}
              className="w-full px-8 py-4 rounded-xl font-bold text-lg shadow-lg hover:opacity-90 active:scale-95 transition-all text-[#080d1a] flex flex-col items-center gap-1"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              <span className="flex items-center gap-2">
                Start the 12-Week DNS Program <ChevronRight size={20} />
              </span>
              <span className="text-xs font-normal opacity-70">Build lasting stability, one position at a time.</span>
            </button>
          </div>
        ) : (
          <>
            <p className="text-base md:text-lg font-semibold text-[#f0f4f8] mb-5 relative z-10">
              Are you dealing with pain right now?
            </p>

            <div className="flex flex-col md:flex-row gap-4 relative z-10 w-full max-w-2xl">
              <button
                onClick={() => attemptNavigation('dashboard')}
                className="flex-1 px-8 py-4 rounded-xl font-bold text-lg shadow-lg hover:opacity-90 active:scale-95 transition-all text-[#080d1a] flex flex-col items-center gap-1"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                <span className="flex items-center gap-2">
                  Yes — Start Your Recovery <ChevronRight size={20} />
                </span>
                <span className="text-xs font-normal opacity-70">Get a clear direction of relief in minutes.</span>
              </button>

              <button
                onClick={() => attemptNavigation('dns-course')}
                className="flex-1 px-8 py-4 rounded-xl font-bold text-lg shadow-lg hover:opacity-90 active:scale-95 transition-all text-[#080d1a] flex flex-col items-center gap-1"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                <span className="flex items-center gap-2">
                  No — I want to build strength and prevent injury <ChevronRight size={20} />
                </span>
                <span className="text-xs font-normal opacity-70">Build lasting stability, one position at a time.</span>
              </button>
            </div>
          </>
        )}
      </main>
    </div>
  );



  const Dashboard = () => {
    const today = todayISO();
    const todayLog = painLog.find((log) => log.date === today);

    // "Completed their MDT prescription" = actually reached one of the reveal nodes
    // where a directional preference was confirmed and a prescription was generated —
    // not just "has watched a video," which activePrescriptions alone can't distinguish
    // (a video watched during diagnostic testing pushes into activePrescriptions too).
    const mdtRevealNodeIds = [
      'lb_mdt_prescription',
      'cs_flexion_exception',
      'neck_extension_intolerant',
      'neck_hold_then_stabilize',
      'lb_troubleshoot_flexion_last',
    ];
    const hasCompletedMdtPrescription =
      mdtRevealNodeIds.includes(currentNodeId) || history.some((id) => mdtRevealNodeIds.includes(id));

    const streak = (() => {
      if (painLog.length === 0) return 0;
      const logDates = new Set(painLog.map((l) => l.date));
      const cursor = new Date(simulatedTime);
      if (!logDates.has(cursor.toISOString().split('T')[0])) {
        cursor.setDate(cursor.getDate() - 1);
      }
      let count = 0;
      while (logDates.has(cursor.toISOString().split('T')[0])) {
        count++;
        cursor.setDate(cursor.getDate() - 1);
      }
      return count;
    })();

    const flagAccent: Record<string, string> = {
      green: '#00e096',
      yellow: '#ffcc00',
      red: '#ff4466',
    };

    return (
      <div className="min-h-screen bg-[#080d1a] pb-20">
        <div className="border-b sticky top-0 z-30 bg-[#0f1829] border-[#1a2a42]">
          <div className="max-w-5xl mx-auto px-6 py-4 flex justify-between items-center">
            <div className="flex items-center gap-2">
              <img src="/logo.png" alt="NeuroActive" className="h-8 w-auto object-contain" onError={(e) => ((e.currentTarget as HTMLImageElement).src = '/logo.png')} />
              <span className="font-bold text-[#f0f4f8]">NeuroActive</span>
            </div>
            <div className="flex items-center gap-4">
              {!isPremium && (
                <button
                  onClick={openUpgrade}
                  className="text-xs font-bold text-[#080d1a] px-3 py-1.5 rounded-full hover:opacity-90 transition-all"
                  style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
                >
                  UPGRADE
                </button>
              )}
              <button onClick={() => setCurrentView('settings')} className="bg-[#1a2a42] p-2 rounded-full hover:opacity-80 transition-opacity">
                <User size={20} className="text-[#6b849e]" />
              </button>
            </div>
          </div>
        </div>

        <div className="max-w-5xl mx-auto p-6 space-y-8">
          {/* Pain-assessment entry hero — hidden for DNS-only launch, not deleted.
              Flip DNS_ONLY_LAUNCH in src/config/launchConfig.ts to restore. */}
          {!DNS_ONLY_LAUNCH && (() => {
            const hasStartedAssessment = activeJourney !== null || history.length > 0;
            return (
              <>
                {hasStartedAssessment && !todayLog && !checkInBannerDismissed && (
                  <div
                    className="flex items-center gap-3 px-4 py-3 rounded-xl"
                    style={{ background: 'rgba(0,212,200,0.08)', border: '1px solid rgba(0,212,200,0.25)' }}
                  >
                    <Bell size={18} className="flex-shrink-0" style={{ color: '#00d4c8' }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold text-[#f0f4f8]">You haven't logged your pain today</p>
                      <p className="text-xs text-[#6b849e]">Daily tracking helps us spot your progress</p>
                    </div>
                    <button
                      onClick={() => painTrackerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                      className="flex-shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg transition-colors hover:opacity-80"
                      style={{ background: 'rgba(0,212,200,0.15)', color: '#00d4c8', border: '1px solid rgba(0,212,200,0.3)' }}
                    >
                      Log Now
                    </button>
                    <button
                      onClick={() => setCheckInBannerDismissed(true)}
                      className="flex-shrink-0 text-[#6b849e] hover:text-[#f0f4f8] transition-colors"
                      aria-label="Dismiss"
                    >
                      <X size={16} />
                    </button>
                  </div>
                )}

                <div className="bg-[#0f1829] p-8 rounded-2xl border border-[#1a2a42] flex flex-col md:flex-row items-center justify-between gap-6">
                  <div>
                    <h1 className="text-2xl font-bold text-[#f0f4f8] mb-2">Welcome back.</h1>
                    <p className="text-[#6b849e]">
                      You are currently on the <span className="font-bold text-[#00d4c8]">{activeJourney || 'General'}</span> track.
                    </p>
                    {streak > 0 && (
                      <div className="flex items-center gap-1.5 mt-3 text-sm font-bold" style={{ color: '#ffcc00' }}>
                        <Activity size={14} />
                        {streak}-day check-in streak
                      </div>
                    )}
                  </div>
                  <button
                    onClick={startFreshAssessment}
                    className="px-6 py-3 rounded-lg font-semibold text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
                    style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
                  >
                    {hasStartedAssessment ? 'New Assessment' : 'Start Assessment'}
                  </button>
                </div>

                {hasStartedAssessment ? (
                  <div ref={painTrackerRef} className="grid md:grid-cols-2 gap-6">
                    <PainTracker onSaveLog={handleSavePainLog} existingLog={todayLog} todayISO={todayISO} />
                    <PainGraph logs={painLog} />
                  </div>
                ) : (
                  <div
                    className="rounded-2xl p-8 text-center"
                    style={{ background: 'rgba(0,212,200,0.05)', border: '1px solid rgba(0,212,200,0.2)' }}
                  >
                    <div
                      className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
                      style={{ background: 'rgba(0,212,200,0.1)', border: '1px solid rgba(0,212,200,0.3)' }}
                    >
                      <ClipboardList size={24} style={{ color: '#00d4c8' }} />
                    </div>
                    <h3 className="text-lg font-bold text-[#f0f4f8] mb-2">Start your assessment to unlock your personalized plan</h3>
                    <p className="text-sm text-[#6b849e] mb-6">Answer a few questions about your symptoms. We'll build your rehab protocol based on your individual presentation.</p>
                    <button
                      onClick={startFreshAssessment}
                      className="px-6 py-3 rounded-lg font-semibold text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
                      style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
                    >
                      Begin Assessment
                    </button>
                  </div>
                )}
              </>
            );
          })()}

          {/* Hidden entirely for DNS-only launch (not deleted) — the old library's DNS/MDT
              content is off-limits to DNS-course customers by hard rule, no exceptions,
              so a category-filtered-but-still-visible card isn't appropriate here; there's
              nothing left worth showing once both are excluded. Flip DNS_ONLY_LAUNCH to
              restore. */}
          {!DNS_ONLY_LAUNCH && (
            <div className="bg-[#0f1829] rounded-2xl border border-[#1a2a42] p-6 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="bg-[#1a2a42] p-3 rounded-full">
                  <Library size={24} className="text-[#00d4c8]" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-[#f0f4f8]">Movement Library</h3>
                  <p className="text-[#6b849e] text-sm">Browse DNS & MDT exercises by position.</p>
                </div>
              </div>
              <button
                onClick={() => setCurrentView('library')}
                className="border border-[#00d4c8] text-[#00d4c8] px-4 py-2 rounded-lg font-bold text-sm hover:bg-[#00d4c8]/10 transition-colors"
              >
                Browse
              </button>
            </div>
          )}

          <div className="bg-[#0f1829] rounded-2xl border border-[#1a2a42] p-6 flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="bg-[#1a2a42] p-3 rounded-full">
                <Dumbbell size={24} className="text-[#00d4c8]" />
              </div>
              <div>
                <h3 className="font-bold text-lg text-[#f0f4f8]">12-Week DNS Foundations</h3>
                <p className="text-[#6b849e] text-sm">A guided developmental progression, one day at a time.</p>
              </div>
            </div>
            <button
              onClick={() => attemptNavigation('dns-course')}
              className="border border-[#00d4c8] text-[#00d4c8] px-4 py-2 rounded-lg font-bold text-sm hover:bg-[#00d4c8]/10 transition-colors"
            >
              Open
            </button>
          </div>

          {/* Hidden for DNS-only launch (not deleted) — this only makes sense as a
              follow-up to completed pain treatment, which isn't reachable right now. */}
          {!DNS_ONLY_LAUNCH && hasCompletedMdtPrescription && (
            <div
              className="rounded-2xl p-6 flex items-center justify-between"
              style={{ background: 'linear-gradient(135deg, rgba(0,212,200,0.08), rgba(124,92,252,0.08))', border: '1px solid rgba(0,212,200,0.25)' }}
            >
              <div className="flex items-center gap-4">
                <div className="bg-[#1a2a42] p-3 rounded-full">
                  <TrendingUp size={24} className="text-[#00d4c8]" />
                </div>
                <div>
                  <h3 className="font-bold text-lg text-[#f0f4f8]">Ready to build lasting stability?</h3>
                  <p className="text-[#6b849e] text-sm">You've got your directional preference — now build the foundation that keeps it.</p>
                </div>
              </div>
              <button
                onClick={() => attemptNavigation('dns-course')}
                className="px-4 py-2 rounded-lg font-bold text-sm text-[#080d1a] hover:opacity-90 transition-all flex-shrink-0"
                style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
              >
                Start
              </button>
            </div>
          )}

          {!DNS_ONLY_LAUNCH && (() => {
            // Hard rule, independent of user status: never surface a premium node's
            // title/frequency here, same defense-in-depth as SessionSummary.
            const visiblePrescriptions = activePrescriptions.filter((id) => !DECISION_TREE[id]?.isPremium);
            if (visiblePrescriptions.length === 0) return null;
            return (
            <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
              <div className="flex items-center gap-2 mb-4">
                <ClipboardList className="text-[#7c5cfc]" />
                <h3 className="font-bold text-lg text-[#f0f4f8]">My Prescription</h3>
              </div>

              <div className="space-y-3">
                {visiblePrescriptions.map((id) => {
                  const node = DECISION_TREE[id];
                  if (!node) return null;
                  const accentColor = node.flagLevel ? flagAccent[node.flagLevel] : undefined;
                  return (
                    <button
                      key={id}
                      onClick={() => attemptNavigation('assessment', id, true)}
                      className="w-full bg-[#080d1a] p-4 rounded-lg border border-[#1a2a42] flex justify-between items-center hover:border-[#7c5cfc]/50 hover:bg-[#7c5cfc]/5 transition-all text-left"
                      style={accentColor ? { borderLeftColor: accentColor, borderLeftWidth: '3px' } : undefined}
                    >
                      <div>
                        <h4 className="font-bold text-[#f0f4f8]">{node.text}</h4>
                        {node.prescriptionFrequency && (
                          <div className="text-xs text-[#7c5cfc] font-bold bg-[#7c5cfc]/10 inline-block px-2 py-1 rounded mt-1">{node.prescriptionFrequency}</div>
                        )}
                      </div>
                      <Play size={20} className="text-[#6b849e]" />
                    </button>
                  );
                })}
              </div>
            </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const AssessmentView = () => {
    const currentNode = DECISION_TREE[currentNodeId];

    if (!currentNode) {
      return (
        <div className="min-h-screen bg-[#080d1a] p-6">
          <div className="max-w-2xl mx-auto bg-[#0f1829] p-6 rounded-xl border border-[#1a2a42]">
            <h2 className="text-xl font-bold text-[#ff4466]">Missing Node</h2>
            <p className="text-[#6b849e] mt-2">
              The decision tree does not contain a node with id: <span className="font-mono text-[#f0f4f8]">{currentNodeId}</span>
            </p>
            <button
              onClick={() => { setCurrentNodeId('start'); setHistory([]); }}
              className="mt-4 px-4 py-2 rounded-lg font-semibold text-[#080d1a]"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              Go to start
            </button>
          </div>
        </div>
      );
    }


    // Gate any premium node (reveal/prescription nodes and premium videos alike) behind the paywall,
    // regardless of which path in the tree led here.
    if (currentNode.isPremium && !isPremium) {
      return (
        <Paywall
          auth={auth}
          checkoutLoading={checkoutLoading}
          setCheckoutLoading={setCheckoutLoading}
          onBack={() => setCurrentView('dashboard')}
          onOpenSettings={() => setCurrentView('settings')}
          onGoogleSignIn={handleGoogleSignIn}
          onSendSignInLink={handleSendSignInLink}
          onCreatePasswordAccount={handleCreatePasswordAccount}
          onSignInWithPassword={handleSignInWithPassword}
          signInLoading={signInLoading}
          signInError={signInError}
          isInAppBrowser={isInAppBrowser}
        />
      );
    }

    // Show session summary when user reaches a terminal result node that has active prescriptions.
    // Exclude waypoint result nodes (e.g. explainers) whose options lead onward to video nodes.
    const nodeLeadsToVideo = currentNode.options?.some(
      (opt) => DECISION_TREE[opt.nextId]?.type === 'video'
    );
    // Red-flag nodes (refer_out, refer_out_urgent, peripheralization checkpoints) must always
    // render their own safety content — never let stale accumulated prescriptions from earlier
    // in the session hijack their render into a "your plan is ready" summary.
    if (
      currentNode.type === 'result' &&
      currentNode.flagLevel !== 'red' &&
      activePrescriptions.length > 0 &&
      !nodeLeadsToVideo
    ) {
      // A premium exercise anywhere in the accumulated prescriptions means this summary
      // would reveal that a personalized premium plan was generated — gate the whole
      // screen rather than show a plan with premium items missing.
      const hasPremiumPrescription = activePrescriptions.some((id) => DECISION_TREE[id]?.isPremium);
      if (hasPremiumPrescription && !isPremium) {
        return (
          <Paywall
            auth={auth}
            checkoutLoading={checkoutLoading}
            setCheckoutLoading={setCheckoutLoading}
            onBack={() => setCurrentView('dashboard')}
            onOpenSettings={() => setCurrentView('settings')}
            onGoogleSignIn={handleGoogleSignIn}
            onSendSignInLink={handleSendSignInLink}
            onCreatePasswordAccount={handleCreatePasswordAccount}
            onSignInWithPassword={handleSignInWithPassword}
            signInLoading={signInLoading}
            signInError={signInError}
            isInAppBrowser={isInAppBrowser}
          />
        );
      }
      return (
        <SessionSummary
          nodeId={currentNodeId}
          prescriptions={activePrescriptions}
          painDrawingData={null}
          onDone={() => setCurrentView('dashboard')}
          decisionTree={DECISION_TREE}
        />
      );
    }

    const flagMap = {
      green:  { color: '#00e096', label: currentNode.flagText || 'Safe to self-manage' },
      yellow: { color: '#ffcc00', label: currentNode.flagText || 'Caution — proceed carefully' },
      red:    { color: '#ff4466', label: currentNode.flagText || 'Stop — refer out' },
    };
    const flag = currentNode.flagLevel ? flagMap[currentNode.flagLevel] : null;

    const depth = history.length;
    const progressPct = Math.min((depth / 12) * 100, 100);

    return (
      <div className="min-h-screen bg-[#080d1a] pb-20">
        {/* Header */}
        <div className="bg-[#0f1829] border-b border-[#1a2a42] sticky top-0 z-30">
          <div className="p-4 flex items-center justify-between">
            <button
              onClick={() => {
                setAutoplayToken(null);
                if (history.length > 0) {
                  const prevId = history[history.length - 1];
                  setCurrentNodeId(prevId);
                  setHistory((prev) => prev.slice(0, -1));
                } else {
                  setCurrentView('dashboard');
                }
              }}
              className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors"
            >
              <ArrowLeft size={20} /> Back
            </button>
            <div className="font-semibold text-[#f0f4f8]">Assessment</div>
            <button
              onClick={() => setCurrentView('dashboard')}
              className="text-sm font-medium text-[#6b849e] hover:text-[#f0f4f8] transition-colors w-16 text-right"
            >
              Dashboard
            </button>
          </div>
          {/* Progress bar */}
          <div className="h-0.5 bg-[#1a2a42]">
            <div
              className="h-full transition-all duration-500 ease-out"
              style={{ width: `${progressPct}%`, background: 'linear-gradient(90deg, #00d4c8, #7c5cfc)' }}
            />
          </div>
        </div>

        <div className="max-w-2xl mx-auto p-6 mt-6">
          {/* Node card */}
          <div className="bg-[#0f1829] p-8 rounded-2xl border border-[#1a2a42] text-center mb-6">
            {flag && (
              <div
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold mb-5"
                style={{
                  backgroundColor: `${flag.color}18`,
                  color: flag.color,
                  border: `1px solid ${flag.color}40`,
                }}
              >
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: flag.color }} />
                {flag.label}
              </div>
            )}
            <h2 className="text-2xl font-bold text-[#f0f4f8] mb-4">{currentNode.text}</h2>
            <p className="text-[#6b849e]">{currentNode.description}</p>
          </div>

          {/* Phase prescription display — lb_mdt_prescription */}
          {currentNodeId === 'lb_mdt_prescription' && (
            <div className="space-y-3 mb-6">
              {[
                { title: 'Standing Extension (EIS)', detail: '10 repetitions every waking hour', nodeId: 'vid_mdt_standing_ext' },
                { title: 'Prone Press-Up (EIL)',     detail: '10 repetitions every waking hour', nodeId: 'vid_mdt_pressup' },
              ].map((rx) => (
                <button
                  key={rx.title}
                  onClick={() => {
                    console.log('[lb_mdt_prescription] navigating to:', rx.nodeId);
                    const newHistory = [...history, currentNodeId];
                    setHistory(newHistory);
                    saveUserData({ history: newHistory, currentNodeId: rx.nodeId });
                    attemptNavigation('assessment', rx.nodeId, true);
                  }}
                  className="w-full flex items-center gap-4 p-4 rounded-xl transition-all group"
                  style={{ background: '#0f1829', border: '1px solid rgba(0,212,200,0.3)', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.boxShadow = '0 0 0 1px rgba(0,212,200,0.5), 0 0 12px rgba(0,212,200,0.12)')}
                  onMouseLeave={(e) => (e.currentTarget.style.boxShadow = 'none')}
                >
                  <div
                    className="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center"
                    style={{ background: 'rgba(0,212,200,0.12)' }}
                  >
                    <CheckCircle size={16} style={{ color: '#00d4c8' }} />
                  </div>
                  <div className="flex-1 text-left">
                    <p className="font-semibold text-[#f0f4f8] text-sm">{rx.title}</p>
                    <p className="text-xs text-[#00d4c8] font-medium mt-0.5">{rx.detail}</p>
                  </div>
                  <span className="flex-shrink-0 text-xs font-bold text-[#00d4c8] flex items-center gap-1 opacity-70 group-hover:opacity-100 transition-opacity">
                    <Play size={10} fill="#00d4c8" /> Watch
                  </span>
                </button>
              ))}
              <p className="text-xs text-[#6b849e] leading-relaxed px-1 pt-1">
                Use whichever is available at any given hour — think of it like having both a flathead and Phillips screwdriver. You always want the right tool for the job. The goal is extension, every hour, consistently.
              </p>
              <p className="text-xs text-[#6b849e] leading-relaxed px-1">
                Both exercises are now saved to your dashboard. Return to them anytime.
              </p>
            </div>
          )}

          {/* Video player */}
          {currentNode.type === 'video' && currentNode.videoId && (
            <VideoPlayer
              key={currentNodeId}
              nodeId={currentNodeId}
              title={currentNode.text}
              frequency={currentNode.prescriptionFrequency}
              videoId={currentNode.videoId}
              autoplayToken={autoplayToken}
              onConsumeAutoplay={() => setAutoplayToken(null)}
            />
          )}

          {/* IAP explainer link — shown on DNS video nodes only */}
          {currentNode.type === 'video' && currentNodeId.startsWith('vid_dns_') && currentNodeId !== 'explainer_iap' && (
            <button
              onClick={() => {
                const newHistory = [...history, currentNodeId];
                setHistory(newHistory);
                saveUserData({ history: newHistory, currentNodeId: 'explainer_iap' });
                attemptNavigation('assessment', 'explainer_iap', true);
              }}
              className="flex items-center gap-2 text-sm text-[#6b849e] hover:text-[#00d4c8] transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }}>
                <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" />
                <path d="M8 7v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                <circle cx="8" cy="4.5" r="0.75" fill="currentColor" />
              </svg>
              What is IAP?
            </button>
          )}

          {/* Question options */}
          {currentNode.type !== 'video' && (() => {
            const isInTroubleshootContext = currentNodeId.includes('troubleshoot') || currentNodeId.includes('peripheralizing');
            const forceReferOut = troubleshootingAttempts >= 3 && isInTroubleshootContext;
            const effectiveOptions = forceReferOut
              ? (currentNode.options ?? []).map((opt) =>
                  opt.nextId === 'refer_out' || opt.nextId === 'refer_out_urgent'
                    ? opt
                    : { ...opt, nextId: 'refer_out' }
                )
              : (currentNode.options ?? []);
            return (
              <div className="grid gap-3">
                {forceReferOut && (
                  <div className="rounded-xl p-4 bg-yellow-900/20 border border-yellow-500/40 text-yellow-300 text-sm">
                    You have worked through several troubleshooting approaches without sufficient improvement. In-person evaluation is now recommended.
                  </div>
                )}
                {effectiveOptions.map((opt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleOptionClick(opt.nextId)}
                    className="bg-[#0f1829] hover:bg-[#00d4c8]/5 border border-[#1a2a42] hover:border-[#00d4c8]/40 p-5 rounded-xl transition-all text-left group flex items-center justify-between"
                  >
                    <span className="text-base font-medium text-[#f0f4f8] group-hover:text-[#00d4c8] transition-colors">{opt.label}</span>
                    <ChevronRight className="text-[#1a2a42] group-hover:text-[#00d4c8] flex-shrink-0 transition-colors" />
                  </button>
                ))}
              </div>
            );
          })()}

          {/* Clinical check-in for video nodes */}
          {currentNode.type === 'video' && (() => {
            const isInTroubleshootContext = currentNodeId.includes('troubleshoot') || currentNodeId.includes('peripheralizing');
            const forceReferOut = troubleshootingAttempts >= 3 && isInTroubleshootContext;
            const effectiveOptions = forceReferOut
              ? (currentNode.options ?? []).map((opt) =>
                  opt.nextId === 'refer_out' || opt.nextId === 'refer_out_urgent'
                    ? opt
                    : { ...opt, nextId: 'refer_out' }
                )
              : (currentNode.options ?? []);
            return (
              <div className="rounded-xl p-6 mt-4 bg-[#0f1829] border border-[#1a2a42]">
                <h3 className="font-bold text-[#f0f4f8] mb-4">Clinical Check-In</h3>
                {forceReferOut && (
                  <div className="rounded-xl p-4 mb-4 bg-yellow-900/20 border border-yellow-500/40 text-yellow-300 text-sm">
                    You have worked through several troubleshooting approaches without sufficient improvement. In-person evaluation is now recommended.
                  </div>
                )}
                <div className="grid gap-3">
                  {effectiveOptions.map((opt, idx) => (
                    <button
                      key={idx}
                      onClick={() => handleOptionClick(opt.nextId)}
                      className="bg-[#080d1a] p-4 rounded-lg border border-[#1a2a42] hover:border-[#7c5cfc]/50 hover:bg-[#7c5cfc]/5 text-left transition-all flex justify-between items-center group"
                    >
                      <span className="font-medium text-[#6b849e] group-hover:text-[#f0f4f8] transition-colors">{opt.label}</span>
                      <ChevronRight className="text-[#1a2a42] group-hover:text-[#7c5cfc] flex-shrink-0 transition-colors" size={20} />
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
        </div>
      </div>
    );
  };

  const DevTimeSkip = () => (
    <div className="fixed bottom-4 left-4 z-50">
      <button
        onClick={() => setSimulatedTime((prev) => prev + 48 * 60 * 60 * 1000)}
        className="bg-black text-white px-4 py-2 rounded-full shadow-lg text-xs font-mono flex items-center gap-2 hover:bg-gray-800"
      >
        <FastForward size={14} /> Dev: Fast-Fwd 48h
      </button>
    </div>
  );

  // DNS_ONLY_LAUNCH account-status label for Settings — see functions/src/dnsEntitlement.ts
  // for the server-side basis model this reads. 'beta_grant' as the *only* active basis
  // reads as 'beta'; any Stripe-derived basis (paid or a legitimate $0 promo) being active
  // reads as 'active', matching the source-priority the server already computes. Purely
  // for display — dnsEntitlementState alone still governs actual DNS course access.
  const dnsAccountStatus: 'active' | 'beta' | 'none' =
    dnsEntitlementState !== 'entitled'
      ? 'none'
      : dnsEntitlementSource === 'beta_grant'
      ? 'beta'
      : 'active';

  if (authLoading) {
    return (
      <div className="min-h-screen bg-[#080d1a] flex items-center justify-center">
        <span className="text-2xl font-extrabold text-[#f0f4f8] tracking-tight">NeuroActive</span>
      </div>
    );
  }

  return (
    <>
      {paymentMessage && (
        <div
          className={`fixed top-4 left-1/2 -translate-x-1/2 z-50 px-5 py-3 rounded-xl text-sm font-semibold shadow-lg flex items-center gap-2 ${
            paymentMessage.type === 'success'
              ? 'bg-[#00e096]/20 text-[#00e096] border border-[#00e096]/40'
              : 'bg-[#ffcc00]/15 text-[#ffcc00] border border-[#ffcc00]/40'
          }`}
        >
          {paymentMessage.type === 'success' ? <CheckCircle size={16} /> : <X size={16} />}
          {paymentMessage.text}
        </div>
      )}
      {showTerms && <LegalDisclaimer onAgree={handleTermsAgree} onCancel={handleTermsDecline} />}
      {currentView === 'landing' && <LandingPage />}
      {currentView === 'paywall' && (
        <Paywall
          auth={auth}
          checkoutLoading={checkoutLoading}
          setCheckoutLoading={setCheckoutLoading}
          onBack={() => setCurrentView('dashboard')}
          onOpenSettings={() => setCurrentView('settings')}
          onGoogleSignIn={handleGoogleSignIn}
          onSendSignInLink={handleSendSignInLink}
          onCreatePasswordAccount={handleCreatePasswordAccount}
          onSignInWithPassword={handleSignInWithPassword}
          signInLoading={signInLoading}
          signInError={signInError}
          isInAppBrowser={isInAppBrowser}
        />
      )}
      {currentView === 'assessment' && <AssessmentView />}
      {currentView === 'dns-course' && (
        <DNSCourseView
          key={auth?.currentUser?.uid ?? 'signed-out'}
          dnsCourse={dnsCourse}
          onUpdateDnsCourse={updateDnsCourse}
          today={todayLocalISO()}
          dnsEntitlementState={dnsEntitlementState}
          onBack={() => setCurrentView('dashboard')}
          onOpenSettings={() => setCurrentView('settings')}
          auth={auth}
          checkoutLoading={checkoutLoading}
          setCheckoutLoading={setCheckoutLoading}
          onGoogleSignIn={handleGoogleSignIn}
          onSendSignInLink={handleSendSignInLink}
          onCreatePasswordAccount={handleCreatePasswordAccount}
          onSignInWithPassword={handleSignInWithPassword}
          signInLoading={signInLoading}
          signInError={signInError}
          isInAppBrowser={isInAppBrowser}
        />
      )}
      {currentView === 'dashboard' && pendingBaselineNodeId
        ? <BaselineCaptureScreen onSave={handleBaselineSaveAndContinue} todayISO={todayISO} />
        : currentView === 'dashboard' && !hasWatchedWelcome && !DNS_ONLY_LAUNCH
        ? <WelcomeVideoScreen onContinue={() => { setHasWatchedWelcome(true); saveUserData({ hasWatchedWelcome: true }); }} />
        : currentView === 'dashboard' && <Dashboard />}
      {currentView === 'settings' && (
        <SettingsView
          isPremium={isPremium}
          dnsAccountStatus={dnsAccountStatus}
          onBack={() => setCurrentView('dashboard')}
          onGoToDashboard={() => setCurrentView('dashboard')}
          onLogout={handleLogout}
          onReset={handleResetJourney}
          onUpgrade={openUpgrade}
          onManageSubscription={async () => {
            const uid = auth?.currentUser?.uid;
            if (!uid) throw new Error('You must be signed in to manage a subscription.');
            await createPortalLink();
          }}
          userInfo={authUser ?? undefined}
          onGoogleSignIn={handleGoogleSignIn}
          onSetPassword={handleSetPassword}
          signInLoading={signInLoading}
          signInError={signInError}
          notificationStatus={notifications.status}
          notificationError={notifications.error}
          onEnableNotifications={() => { void notifications.enable(); }}
          preferencesUid={notificationPreferences.uid}
          preferencesLoaded={notificationPreferences.loaded}
          preferences={notificationPreferences.preferences}
          preferencesReadError={notificationPreferences.readError}
          preferencesCorrupt={notificationPreferences.corrupt}
          defaultPreferences={notificationPreferences.defaultPreferences}
          preferencesSaving={notificationPreferences.saving}
          preferencesError={notificationPreferences.error}
          preferencesConflictMessage={notificationPreferences.conflictMessage}
          preferencesConflictToken={notificationPreferences.conflictToken}
          onSavePreferences={notificationPreferences.save}
        />
      )}
      {currentView === 'library' && (
        <LibraryView
          isPremium={isPremium}
          onUnlock={openUpgrade}
          onPlay={(id) => {
            const newHistory = [...history, currentNodeId];
            setHistory(newHistory);
            saveUserData({ history: newHistory, currentNodeId: id });
            attemptNavigation('assessment', id, true);
          }}
        />
      )}
      {import.meta.env.DEV && <DevTimeSkip />}
    </>
  );
}
