// src/components/Paywall.tsx
import { useEffect, useRef, useState } from 'react';
import type { Auth } from 'firebase/auth';
import { ArrowLeft, User, CheckCircle, CreditCard, AlertCircle } from 'lucide-react';
import { createCheckoutSession, type PriceKey, PROGRAM_DISPLAY_PRICE } from '../services/stripe';
import { DNS_ONLY_LAUNCH } from '../config/launchConfig';
import VideoPlayer from './VideoPlayer';
import AccountSignInPanel from './AccountSignInPanel';

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

// Full four-tier lineup — kept intact (not deleted) so restoring is a one-line change
// once DNS_ONLY_LAUNCH is flipped back. See visibleTiers below for what's actually shown.
const ALL_TIERS = [
  { key: 'monthly' as PriceKey, label: 'Monthly', sublabel: 'Billed monthly, cancel anytime' },
  { key: 'annual'  as PriceKey, label: 'Annual',  sublabel: 'Best value — save vs monthly' },
  { key: 'program' as PriceKey, label: '12-Week Program', sublabel: 'Self-guided 12-week DNS video course' },
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
  const visibleTiers = DNS_ONLY_LAUNCH ? ALL_TIERS.filter((t) => t.key === 'program') : ALL_TIERS;
  const features = DNS_ONLY_LAUNCH ? DNS_ONLY_FEATURES : FULL_FEATURES;
  // Treat the brief/no-user edge the same as an anonymous session: purchasing stays
  // disabled and account-access controls remain available until a real user exists.
  const isAnonymous = !auth?.currentUser || auth.currentUser.isAnonymous;

  // App.tsx has no router — every view (this one included) is a conditional render at a
  // fixed document root, never a real navigation, so the browser never resets scroll on
  // its own when Paywall mounts. Deliberately scoped to this component only (not a
  // shared/global scroll-reset hook) and deliberately not persisted to sessionStorage —
  // every fresh entry into Paywall should start at the top, not wherever it was left.
  // window.scrollTo runs first so the final position is deterministic before focus
  // moves, and focus uses preventScroll so it can't trigger a second, separate jump.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  // Renders the price disclosure, purchase button(s), loading/error state, and the
  // promo-code note — called once near the top of the page and again near the bottom
  // (see the two renderPurchaseSection call sites below), always from this single
  // definition so the two placements can never drift out of sync with each other or
  // independently trigger two Checkout Sessions: both read the same checkoutLoading prop,
  // so a click on either instance disables both immediately.
  function renderPurchaseSection(instanceKey: 'top' | 'bottom') {
    return (
      <div className="space-y-3">
        {isAnonymous && (
          <p className="text-center text-sm text-[#6b849e]">
            Sign in with Google or email before purchasing DNS Foundations.
          </p>
        )}
        {visibleTiers.map(({ key, label, sublabel }) => {
          const uid = auth?.currentUser?.uid;
          const loading = checkoutLoading === key;
          return (
            <div key={`${instanceKey}-${key}`}>
              {/* Price disclosure — required to be visible before checkout begins, for
                  both signed-out and signed-in states (this block renders regardless of
                  isAnonymous), without a modal/tooltip/redirect. Scoped to the 'program'
                  tier specifically since it's the only one-time-purchase tier; the other
                  (currently hidden) tiers are subscriptions and must never carry this
                  "one-time" wording. */}
              {key === 'program' && (
                <p className="text-center text-sm text-[#f0f4f8] mb-2">
                  <span className="font-bold">{PROGRAM_DISPLAY_PRICE}</span> — one-time purchase
                  <span className="block text-xs text-[#6b849e] mt-1">
                    International customers may see the equivalent amount in their local currency at checkout.
                  </span>
                </p>
              )}
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
                  {isAnonymous ? 'Sign in or create an account to continue to secure checkout' : loading ? 'Loading…' : label}
                </span>
                {!loading && <span className="text-xs font-normal opacity-70">{sublabel}</span>}
              </button>
              {checkoutError === key && (
                <div className="flex items-center gap-2 mt-2 px-1 text-sm text-[#ff4466]">
                  <AlertCircle size={14} className="flex-shrink-0" />
                  Something went wrong — please try again.
                </div>
              )}
              {key === 'program' && (
                <p className="text-center text-xs text-[#6b849e] mt-2">
                  Have a promotional code? You can enter it on the secure Stripe checkout page.
                </p>
              )}
            </div>
          );
        })}
      </div>
    );
  }

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

        {/* Top summary — price and access proposition visible without scrolling, before
            the testimonial video/bio/credentials below. Signed-in visitors get a real
            checkout CTA here (renderPurchaseSection, shared with the bottom copy so there
            is exactly one code path that can ever start checkout); anonymous visitors get
            the same price context plus a clear pointer to the sign-in step just below,
            rather than a purchase button they can't yet use. */}
        <div className="text-center space-y-3">
          <p className="text-xl font-extrabold text-[#f0f4f8]">12-Week DNS Foundations</p>
          <p className="text-sm text-[#6b849e] max-w-sm mx-auto">
            A guided, self-paced program to rebuild your stabilization foundation — one new video a day for 12
            weeks.
          </p>
        </div>
        {renderPurchaseSection('top')}

        {/* Anonymous account upgrade — authenticated users already have an account and
            should not be prompted to sign in again or create a duplicate identity. */}
        {isAnonymous && (
          <AccountSignInPanel
            onGoogleSignIn={onGoogleSignIn}
            onSendSignInLink={onSendSignInLink}
            onCreatePasswordAccount={onCreatePasswordAccount}
            onSignInWithPassword={onSignInWithPassword}
            signInLoading={signInLoading}
            signInError={signInError}
            isInAppBrowser={isInAppBrowser}
          />
        )}

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
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="text-2xl font-extrabold text-[#f0f4f8] mb-2 focus:outline-none"
          >
            Dr. Adam Bruene, DC, Cert. MDT, DNSP, DNSET
          </h1>
          <p className="text-[#6b849e] text-sm leading-relaxed max-w-sm mx-auto">
            Built by a clinician with advanced certification in both McKenzie MDT and Dynamic Neuromuscular Stabilization
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
            "17+ years of clinical experience in spine rehabilitation and movement-based care. Treated patients across MLB, NHL, MLS, and international rugby. This app runs on the same clinical reasoning frameworks used in real practice — not generic exercise content."
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

        {/* CTA — repeats renderPurchaseSection (see top of page); "No thanks" stays
            bottom-only since it's an exit action, not something to repeat near the top. */}
        <div className="space-y-3 pb-8">
          {renderPurchaseSection('bottom')}
          <button onClick={onBack} className="w-full text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors py-2">
            No thanks, take me back
          </button>
        </div>
      </div>
    </div>
  );
}
