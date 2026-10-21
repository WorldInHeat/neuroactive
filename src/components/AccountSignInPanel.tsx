// src/components/AccountSignInPanel.tsx
// The anonymous-account sign-in / account-creation UI (Google, email + password, and
// email link), extracted verbatim from Paywall.tsx so the free-trial start screen can
// offer exactly the same sign-in mechanism. Behavior is unchanged: every action still
// goes through the same App.tsx handlers passed in as props.
import { useState } from 'react';

// UX-only guardrail (Task 6) — not a security boundary. Kept at 10 chars, no complexity
// rules, pending eventual alignment with whatever the Firebase Console password policy
// ends up set to.
const MIN_PASSWORD_LENGTH = 10;

type Props = {
  onGoogleSignIn: () => void;
  onSendSignInLink: (email: string) => Promise<void>;
  onCreatePasswordAccount: (email: string, password: string) => Promise<'ok' | 'account-exists'>;
  onSignInWithPassword: (email: string, password: string) => Promise<void>;
  signInLoading: boolean;
  signInError: string | null;
  isInAppBrowser: boolean;
};

export default function AccountSignInPanel({
  onGoogleSignIn,
  onSendSignInLink,
  onCreatePasswordAccount,
  onSignInWithPassword,
  signInLoading,
  signInError,
  isInAppBrowser,
}: Props) {
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

  return (
    <div className="text-center">
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
    </div>
  );
}
