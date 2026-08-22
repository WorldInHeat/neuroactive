// src/components/Paywall.tsx
import { useState } from 'react';
import type { Auth } from 'firebase/auth';
import { ArrowLeft, User, CheckCircle, CreditCard, AlertCircle } from 'lucide-react';
import { createCheckoutSession, type PriceKey } from '../services/stripe';
import { DNS_ONLY_LAUNCH } from '../config/launchConfig';
import VideoPlayer from './VideoPlayer';

type Props = {
  auth: Auth | null;
  checkoutLoading: PriceKey | null;
  setCheckoutLoading: (key: PriceKey | null) => void;
  onBack: () => void;
  onOpenSettings: () => void;
  onGoogleSignIn: () => void;
  onSendSignInLink: (email: string) => Promise<void>;
  onCreatePasswordAccount: (email: string, password: string) => Promise<'ok' | 'account-exists'>;
  onSignInWithPassword: (email: string, password: string) => Promise<void>;
  signInLoading: boolean;
  signInError: string | null;
  isInAppBrowser: boolean;
};

// UX-only guardrail (Task 6) — not a security boundary. Kept at 10 chars, no complexity
// rules, pending eventual alignment with whatever the Firebase Console password policy
// ends up set to.
const MIN_PASSWORD_LENGTH = 10;

// Full four-tier lineup — kept intact (not deleted) so restoring is a one-line change
// once DNS_ONLY_LAUNCH is flipped back. See visibleTiers below for what's actually shown.
const ALL_TIERS = [
  { key: 'monthly' as PriceKey, label: 'Monthly', sublabel: 'Billed monthly, cancel anytime' },
  { key: 'annual'  as PriceKey, label: 'Annual',  sublabel: 'Best value — save vs monthly' },
  { key: 'program' as PriceKey, label: '12-Week Program', sublabel: 'One-time guided program access' },
  { key: 'elite'   as PriceKey, label: 'Elite',   sublabel: 'Full access + priority support' },
] as const;

const DNS_ONLY_FEATURES = [
  'The complete 12-Week DNS Foundations course',
  'One new video every day — a structured path, not a library to get lost in',
  'Access to all 12 weeks and 84 days, no additional purchase required',
  'Yours to keep once purchased — no recurring payments',
];

const FULL_FEATURES = [
  'Full DNS Developmental Exercise Library',
  'All MDT Assessment Protocols',
  'Cervical & Lumbar clinical pathways',
  'Premium video instruction for every drill',
  'New clinical content added regularly',
];

export default function Paywall({
  auth,
  checkoutLoading,
  setCheckoutLoading,
  onBack,
  onOpenSettings,
  onGoogleSignIn,
  onSendSignInLink,
  onCreatePasswordAccount,
  onSignInWithPassword,
  signInLoading,
  signInError,
  isInAppBrowser,
}: Props) {
  const [checkoutError, setCheckoutError] = useState<PriceKey | null>(null);
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  // Task 1's auth UX: Google/email choice up front, magic link demoted to a secondary
  // option reachable from inside the password view rather than shown by default.
  const [authView, setAuthView] = useState<'choice' | 'password' | 'magic-link'>('choice');
  // 'signin' is the default per Task 1's layout (Email/Password/[Sign in], with "Create
  // account" as a secondary control) — most Paywall visitors already have an account from
  // a prior device/session, not none at all.
  const [passwordMode, setPasswordMode] = useState<'signin' | 'create'>('signin');
  const [pwEmail, setPwEmail] = useState('');
  const [pwPassword, setPwPassword] = useState('');
  const [pwConfirmPassword, setPwConfirmPassword] = useState('');
  const [pwValidationError, setPwValidationError] = useState<string | null>(null);
  const visibleTiers = DNS_ONLY_LAUNCH ? ALL_TIERS.filter((t) => t.key === 'program') : ALL_TIERS;
  const features = DNS_ONLY_LAUNCH ? DNS_ONLY_FEATURES : FULL_FEATURES;
  // Treat the brief/no-user edge the same as an anonymous session: purchasing stays
  // disabled and account-access controls remain available until a real user exists.
  const isAnonymous = !auth?.currentUser || auth.currentUser.isAnonymous;

  return (
    <div className="min-h-screen bg-[#080d1a] overflow-y-auto">
      <div className="max-w-lg mx-auto px-6 py-12 space-y-8">
        {/* Back + persistent account access, matching Dashboard/DNSCourseView's header icon */}
        <div className="flex items-center justify-between">
          <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors text-sm">
            <ArrowLeft size={16} /> Back
          </button>
          <button onClick={onOpenSettings} className="bg-[#1a2a42] p-2 rounded-full hover:opacity-80 transition-opacity" aria-label="Profile & Settings">
            <User size={20} className="text-[#6b849e]" />
          </button>
        </div>

        {/* Anonymous account upgrade — authenticated users already have an account and
            should not be prompted to sign in again or create a duplicate identity. */}
        {isAnonymous && <div className="text-center">
          <p className="text-[#f0f4f8] text-sm font-semibold mb-3">Sign in or create an account</p>

          {authView === 'choice' && (
            <div className="max-w-xs mx-auto space-y-3">
              {/* Google — hidden inside an in-app browser since the redirect flow can't
                  complete there. */}
              {isInAppBrowser ? (
                <p className="text-[#3a4a5e] text-xs">
                  Open this page in your browser (not this app) to sign in with Google.
                </p>
              ) : (
                <button
                  type="button"
                  onClick={onGoogleSignIn}
                  disabled={signInLoading}
                  className="text-[#00d4c8] text-sm font-semibold hover:underline disabled:opacity-60"
                >
                  {signInLoading ? 'Signing in…' : 'Continue with Google'}
                </button>
              )}
              <div>
                <button
                  type="button"
                  onClick={() => setAuthView('password')}
                  className="text-[#00d4c8] text-sm font-semibold hover:underline"
                >
                  Continue with email
                </button>
              </div>
            </div>
          )}

          {authView === 'password' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setPwValidationError(null);
                if (passwordMode === 'create') {
                  if (pwPassword.length < MIN_PASSWORD_LENGTH) {
                    setPwValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
                    return;
                  }
                  if (pwPassword !== pwConfirmPassword) {
                    setPwValidationError('Passwords don’t match.');
                    return;
                  }
                  try {
                    const result = await onCreatePasswordAccount(pwEmail, pwPassword);
                    if (result === 'account-exists') {
                      // Task 2: never fall back to signing in automatically here — just
                      // switch the form to sign-in mode with the email kept; nothing about
                      // the current anonymous session changes until the user submits it.
                      setPasswordMode('signin');
                    }
                    setPwPassword('');
                    setPwConfirmPassword('');
                  } catch {
                    // Any other failure — surfaced via signInError. Clear the typed
                    // password rather than leaving a secret sitting in component state
                    // after a failed attempt.
                    setPwPassword('');
                    setPwConfirmPassword('');
                  }
                } else {
                  // handleSignInWithPassword never throws (it catches internally and
                  // surfaces failures via signInError) — clear the typed password either
                  // way rather than leaving it sitting in state after a failed attempt; on
                  // success this view is about to unmount anyway once isAnonymous flips.
                  await onSignInWithPassword(pwEmail, pwPassword);
                  setPwPassword('');
                }
              }}
              className="max-w-xs mx-auto space-y-2 text-left"
            >
              <input
                type="email"
                autoComplete="email"
                placeholder="Email"
                value={pwEmail}
                onChange={(e) => setPwEmail(e.target.value)}
                required
                className="w-full bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] focus:outline-none focus:border-[#00d4c8]/50"
              />
              <input
                type="password"
                autoComplete={passwordMode === 'create' ? 'new-password' : 'current-password'}
                placeholder="Password"
                value={pwPassword}
                onChange={(e) => setPwPassword(e.target.value)}
                required
                className="w-full bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] focus:outline-none focus:border-[#00d4c8]/50"
              />
              {passwordMode === 'create' && (
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder="Confirm password"
                  value={pwConfirmPassword}
                  onChange={(e) => setPwConfirmPassword(e.target.value)}
                  required
                  className="w-full bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] focus:outline-none focus:border-[#00d4c8]/50"
                />
              )}
              {pwValidationError && (
                <p className="text-xs text-red-400">{pwValidationError}</p>
              )}
              <button
                type="submit"
                disabled={signInLoading || !pwEmail || !pwPassword}
                className="w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50"
              >
                {signInLoading
                  ? passwordMode === 'create' ? 'Creating account…' : 'Signing in…'
                  : passwordMode === 'create' ? 'Create account' : 'Sign in'}
              </button>

              <div className="flex items-center justify-between pt-1 text-xs">
                <button
                  type="button"
                  onClick={() => {
                    setPasswordMode((m) => (m === 'create' ? 'signin' : 'create'));
                    setPwValidationError(null);
                  }}
                  className="text-[#00d4c8] font-semibold hover:underline"
                >
                  {passwordMode === 'create' ? 'Sign in instead' : 'Create account'}
                </button>
                <button
                  type="button"
                  onClick={() => setAuthView('magic-link')}
                  className="text-[#6b849e] hover:text-[#f0f4f8] hover:underline"
                >
                  Sign in with an email link instead
                </button>
              </div>
              <button
                type="button"
                onClick={() => setAuthView('choice')}
                className="text-[#6b849e] text-xs hover:text-[#f0f4f8] hover:underline pt-1"
              >
                ← Back
              </button>
            </form>
          )}

          {authView === 'magic-link' && (
            <div className="max-w-xs mx-auto">
              {linkSent ? (
                <div className="bg-[#0f1829] border border-[#00d4c8]/30 rounded-lg p-4">
                  <p className="text-sm text-[#f0f4f8] font-semibold">Check your email</p>
                  <p className="text-xs text-[#6b849e] mt-1">
                    We sent a sign-in link to {email}. Open it on this device to finish signing in.
                  </p>
                  <button
                    type="button"
                    onClick={() => setLinkSent(false)}
                    className="text-[#00d4c8] text-xs font-semibold hover:underline mt-3"
                  >
                    Use a different email
                  </button>
                </div>
              ) : (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    try {
                      await onSendSignInLink(email);
                      setLinkSent(true);
                    } catch {
                      // Failure already surfaced via signInError.
                    }
                  }}
                  className="space-y-2 text-left"
                >
                  <input
                    type="email"
                    autoComplete="email"
                    placeholder="Email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] focus:outline-none focus:border-[#00d4c8]/50"
                  />
                  <button
                    type="submit"
                    disabled={signInLoading || !email}
                    className="w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50"
                  >
                    {signInLoading ? 'Sending…' : 'Email me a sign-in link'}
                  </button>
                </form>
              )}
              <button
                type="button"
                onClick={() => setAuthView('password')}
                className="text-[#6b849e] text-xs hover:text-[#f0f4f8] hover:underline mt-3"
              >
                ← Back
              </button>
            </div>
          )}

          {signInError && (
            <p className="text-xs text-red-400 mt-2 leading-relaxed">{signInError}</p>
          )}
        </div>}

        {/* Paywall hero video — personal testimonial, filmed vertically unlike every
            other video in the app, hence orientation="portrait" (see VideoPlayer). */}
        <VideoPlayer
          nodeId="onboarding_paywall_hero"
          title="My Own DNS Story"
          videoId="1217789552"
          autoplayToken={null}
          onConsumeAutoplay={() => {}}
          orientation="portrait"
        />

        {/* Doctor header */}
        <div className="text-center">
          <div
            className="w-20 h-20 rounded-full mx-auto mb-5 flex items-center justify-center border-2 border-[#00d4c8]/40"
            style={{ background: 'linear-gradient(135deg, rgba(0,212,200,0.15), rgba(124,92,252,0.15))' }}
          >
            <User size={36} className="text-[#00d4c8]" />
          </div>
          <h1 className="text-2xl font-extrabold text-[#f0f4f8] mb-2">Dr. Adam Bruene, D.C., Cert. MDT, DNSP</h1>
          <p className="text-[#6b849e] text-sm leading-relaxed max-w-sm mx-auto">
            The only app built on dual certification in McKenzie MDT and Dynamic Neuromuscular Stabilization
          </p>
        </div>

        {/* Credential pills */}
        <div className="flex flex-wrap justify-center gap-2">
          {[
            'Licensed Chiropractic Physician · Illinois',
            'Certified McKenzie Practitioner (MDT)',
            'DNS Certified Practitioner (DNSP)',
            'DNS Exercise Trainer Certified (DNSET)',
          ].map((cred) => (
            <span
              key={cred}
              className="text-xs font-semibold px-3 py-1.5 rounded-full text-[#00d4c8]"
              style={{ border: '1px solid rgba(0,212,200,0.4)', backgroundColor: 'rgba(0,212,200,0.08)' }}
            >
              {cred}
            </span>
          ))}
        </div>

        {/* Bio */}
        <div className="bg-[#0f1829] border border-[#1a2a42] rounded-2xl p-6">
          <p className="text-[#6b849e] text-sm leading-relaxed">
            "15+ years of clinical experience in spine rehabilitation and movement-based care. Treated patients across MLB, NHL, MLS, and international rugby. This app runs on the same clinical reasoning frameworks used in real practice — not generic exercise content."
          </p>
        </div>

        {/* Feature list */}
        <div className="bg-[#0f1829] border border-[#1a2a42] rounded-2xl p-6 space-y-3">
          <h3 className="font-bold text-[#f0f4f8] mb-4">What you unlock</h3>
          {features.map((feature) => (
            <div key={feature} className="flex items-start gap-3">
              <CheckCircle size={16} className="text-[#00d4c8] flex-shrink-0 mt-0.5" />
              <span className="text-sm text-[#f0f4f8]">{feature}</span>
            </div>
          ))}
        </div>

        {/* Legal disclosure — shown immediately before purchase */}
        <div className="space-y-3">
          <p className="text-center text-xs text-[#6b849e] leading-relaxed">
            By purchasing, you agree to the{' '}
            <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-[#00d4c8] hover:underline">
              Terms of Service
            </a>{' '}
            and acknowledge the{' '}
            <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-[#00d4c8] hover:underline">
              Privacy Policy
            </a>
            .
          </p>
        </div>

        {/* CTA */}
        <div className="space-y-3 pb-8">
          {isAnonymous && (
            <p className="text-center text-sm text-[#6b849e]">
              Sign in with Google or email before purchasing DNS Foundations.
            </p>
          )}
          {visibleTiers.map(({ key, label, sublabel }) => {
            const uid = auth?.currentUser?.uid;
            const loading = checkoutLoading === key;
            return (
              <div key={key}>
                <button
                  disabled={checkoutLoading !== null || !uid || isAnonymous}
                  onClick={async () => {
                    if (!uid || isAnonymous) return;
                    setCheckoutError(null);
                    setCheckoutLoading(key);
                    try {
                      await createCheckoutSession(uid, key);
                    } catch (err) {
                      console.error('Checkout error:', err);
                      setCheckoutLoading(null);
                      setCheckoutError(key);
                    }
                  }}
                  className="w-full py-4 rounded-xl font-bold text-base hover:opacity-90 active:scale-95 transition-all flex flex-col items-center gap-0.5 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)', color: '#080d1a' }}
                >
                  <span className="flex items-center gap-2">
                    <CreditCard size={18} />
                    {isAnonymous ? 'Sign in above to purchase' : loading ? 'Loading…' : label}
                  </span>
                  {!loading && <span className="text-xs font-normal opacity-70">{sublabel}</span>}
                </button>
                {checkoutError === key && (
                  <div className="flex items-center gap-2 mt-2 px-1 text-sm text-[#ff4466]">
                    <AlertCircle size={14} className="flex-shrink-0" />
                    Something went wrong — please try again.
                  </div>
                )}
              </div>
            );
          })}
          <button onClick={onBack} className="w-full text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors py-2">
            No thanks, take me back
          </button>
        </div>
      </div>
    </div>
  );
}
