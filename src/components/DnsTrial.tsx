// src/components/DnsTrial.tsx
// Presentation for the no-card 14-day DNS free trial: the explicit activation
// confirmation, the in-course status strip, the continuation (conversion) screen, and the
// short educational framing notes. None of these decide access — see
// src/services/dnsTrial.ts for why the server stays authoritative.
import { useRef, useState } from 'react';
import { ArrowLeft, CreditCard, Sparkles } from 'lucide-react';
import AccountSignInPanel from './AccountSignInPanel';
import { TRIAL_REVIEW_LABEL, trialConversionCopy, type TrialConversionVariant } from '../services/dnsTrial';

type SignInProps = {
  onGoogleSignIn: () => void;
  onSendSignInLink: (email: string) => Promise<void>;
  onCreatePasswordAccount: (email: string, password: string) => Promise<'ok' | 'account-exists'>;
  onSignInWithPassword: (email: string, password: string) => Promise<void>;
  signInLoading: boolean;
  signInError: string | null;
  isInAppBrowser: boolean;
};

function trialStartErrorMessage(err: unknown): string {
  const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
  if (code === 'functions/failed-precondition' && err instanceof Error && err.message) return err.message;
  return 'We couldn’t start your free trial just now. Please check your connection and try again.';
}

// Shown immediately before activation. Anonymous visitors see the existing sign-in UI
// instead of the activation button — signing in never starts the trial by itself.
export function DnsTrialStartScreen({
  isAnonymous,
  onBegin,
  onBack,
  ...signIn
}: SignInProps & { isAnonymous: boolean; onBegin: () => Promise<void>; onBack: () => void }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Synchronous guard: a second tap before React re-renders can never send a second request.
  const inFlight = useRef(false);

  const handleBegin = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStarting(true);
    setError(null);
    try {
      await onBegin();
      // Success: stay in the "Starting…" state — this screen unmounts as soon as the
      // server-written trial record arrives through the entitlement listener.
    } catch (err) {
      inFlight.current = false;
      setStarting(false);
      setError(trialStartErrorMessage(err));
    }
  };

  return (
    <div className="min-h-screen bg-[#080d1a]">
      <div className="max-w-lg mx-auto px-6 py-12 space-y-8">
        <button onClick={onBack} className="text-[#6b849e] hover:text-[#f0f4f8] flex items-center gap-1 transition-colors text-sm">
          <ArrowLeft size={16} /> Back
        </button>

        <div className="text-center space-y-3">
          <h1 className="text-2xl font-extrabold text-[#f0f4f8]">Try the first 14 days free</h1>
          <p className="text-sm text-[#6b849e] max-w-sm mx-auto leading-relaxed">
            No card required. Your 14-day trial begins when you continue and includes Days 1–14.
          </p>
        </div>

        {isAnonymous ? (
          <div className="space-y-3">
            <p className="text-center text-sm text-[#6b849e]">
              Create a free account or sign in first — your trial won’t start until you choose to begin it.
            </p>
            <AccountSignInPanel {...signIn} />
          </div>
        ) : (
          <div className="space-y-3">
            <button
              onClick={handleBegin}
              disabled={starting}
              className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all disabled:opacity-60 disabled:active:scale-100"
              style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
            >
              {starting ? 'Starting your free trial…' : 'Begin my free 14 days'}
            </button>
            {error && (
              <p className="text-center text-sm text-[#ffcc00]" role="alert">
                {error}
              </p>
            )}
          </div>
        )}

        <button onClick={onBack} className="w-full text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors py-2">
          Return to home
        </button>
      </div>
    </div>
  );
}

// Compact, non-alarming trial status for the top of the course. Display-only.
export function DnsTrialStatusBar({ label, onUnlock }: { label: string; onUnlock: () => void }) {
  return (
    <div className="mb-6 flex items-center justify-between gap-3 rounded-xl border border-[#00d4c8]/30 bg-[#00d4c8]/10 px-4 py-2.5">
      <span className="text-xs font-semibold text-[#00d4c8]">{label}</span>
      <button onClick={onUnlock} className="text-xs font-semibold text-[#f0f4f8] hover:underline whitespace-nowrap">
        Unlock full program
      </button>
    </div>
  );
}

// Continuation screen at the trial boundary (Day 14 completed, or the trial window has
// passed) or opened voluntarily mid-trial. Copy depends on actual progress — see
// trialConversionVariant. The purchase button starts the existing Stripe Checkout for the
// existing $149 one-time product; the review action always leads to the completed
// lessons, never back here.
export function DnsTrialConversion({
  variant,
  onUnlock,
  unlocking,
  unlockError,
  onReview,
  onBackToLessons,
}: {
  variant: TrialConversionVariant;
  onUnlock: () => void;
  unlocking: boolean;
  unlockError: boolean;
  onReview: () => void;
  // Present only when the user opened this voluntarily mid-trial (not at the boundary).
  onBackToLessons?: () => void;
}) {
  const { body, statement } = trialConversionCopy(variant);
  return (
    <div className="space-y-6">
      <div className="text-center space-y-3">
        <h2 className="text-2xl font-extrabold text-[#f0f4f8]">Continue your progress</h2>
        {body && <p className="text-sm text-[#6b849e] leading-relaxed">{body}</p>}
        {statement && <p className="text-sm text-[#f0f4f8] leading-relaxed">{statement}</p>}
      </div>

      <div className="space-y-3">
        <button
          onClick={onUnlock}
          disabled={unlocking}
          className="w-full py-4 rounded-xl font-bold text-base text-[#080d1a] hover:opacity-90 active:scale-95 transition-all flex items-center justify-center gap-2 disabled:opacity-60 disabled:active:scale-100"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          <CreditCard size={18} />
          {unlocking ? 'Opening secure checkout…' : 'Unlock the complete program — $149'}
        </button>
        {unlockError && (
          <p className="text-center text-sm text-[#ffcc00]" role="alert">
            Something went wrong — please try again.
          </p>
        )}
        <p className="text-center text-xs text-[#6b849e]">
          One-time purchase. International customers may see the equivalent amount in their local currency at checkout. Have a promotional code? You can enter it on the secure Stripe checkout page.
        </p>
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
        <button onClick={onReview} className="w-full py-3 rounded-xl text-sm font-semibold text-[#00d4c8] border border-[#00d4c8]/40 hover:bg-[#00d4c8]/10 transition-colors">
          {TRIAL_REVIEW_LABEL}
        </button>
        {onBackToLessons && (
          <button onClick={onBackToLessons} className="w-full text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors py-2">
            Back to today’s lesson
          </button>
        )}
      </div>
    </div>
  );
}

export const TRIAL_START_FRAMING =
  'These first two weeks establish the pressure, support, breathing, and joint organization that every later movement builds upon.';
export const TRIAL_MIDPOINT_FRAMING =
  'You’ve established the first half of your foundation. Next, you’ll learn to carry the same organization into prone support.';

export function DnsTrialFramingNote({ text }: { text: string }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-xl border border-[#7c5cfc]/30 bg-[#7c5cfc]/10 px-4 py-3">
      <Sparkles size={16} className="text-[#7c5cfc] flex-shrink-0 mt-0.5" />
      <p className="text-sm text-[#f0f4f8] leading-relaxed">{text}</p>
    </div>
  );
}
