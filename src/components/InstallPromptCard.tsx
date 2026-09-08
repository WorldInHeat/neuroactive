// src/components/InstallPromptCard.tsx
// Contextual, dismissible "Install NeuroActive" card shown inside the DNS course
// experience — never before entitlement/checkout. PWA Phase 2: install UX only, no
// notification permission requests, no push, no reminder scheduling.
//
// Encouragement, never a requirement: this card must never block or degrade course access
// (it renders inline, above the day content, never as a modal/overlay), and its copy must
// always make clear the course remains usable in the browser without installing anything.
// Dismissing it (via either the X or "Maybe later") is remembered for the rest of this
// browser session (see useInstallPrompt.ts's SESSION_DISMISS_KEY) so it never nags on
// every navigation — but it is intentionally NOT dismissed forever: the full instructions
// remain reachable any time from Settings (see InstallSettingsCard.tsx).
import { Download, Share, X } from 'lucide-react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

type Props = {
  // Caller-computed "the user has experienced the program, not just arrived" signal —
  // kept as a plain prop rather than reading dnsCourse here, so this component still has
  // no course-progress knowledge of its own.
  eligible: boolean;
};

export default function InstallPromptCard({ eligible }: Props) {
  const { displayState, platform, canInstall, promptInstall, dismissedThisSession, dismissForSession } =
    useInstallPrompt();

  if (!eligible || displayState === 'standalone' || dismissedThisSession) return null;

  // iOS/macOS Safari always have actionable manual instructions; Android/desktop
  // Chromium only have something to offer once beforeinstallprompt has actually fired —
  // fail gracefully (render nothing) rather than show a button that can't install. Applies
  // to 'previously-standalone' too: that state is historical evidence only (see
  // useInstallPrompt.ts), never proof the app is still installed, so it must fall back to
  // the same real install action a genuinely-uninstalled user would see, not skip it.
  const showsInstructionsOnly = platform === 'ios' || platform === 'macos-safari';
  if (!showsInstructionsOnly && !canInstall) return null;

  return (
    <div className="bg-[#0f1829] border border-[#00d4c8]/20 rounded-2xl p-5 mb-6 relative">
      <button
        onClick={dismissForSession}
        aria-label="Dismiss install prompt"
        className="absolute top-3 right-3 text-[#6b849e] hover:text-[#f0f4f8] p-1.5 rounded-full hover:bg-[#1a2a42] transition-colors"
      >
        <X size={16} />
      </button>
      <h3 className="font-bold text-[#f0f4f8] pr-8 mb-1">Get the best NeuroActive experience</h3>
      <p className="text-sm text-[#6b849e] leading-relaxed mb-4">
        Add NeuroActive to your Home Screen for quicker access and session reminders. You can continue using the
        course in your browser anytime.
      </p>

      {displayState === 'previously-standalone' ? (
        // Historical evidence only (see StandaloneDisplayState's doc comment) — never
        // asserted as a confirmed-current-install fact. Offers the likely path (open the
        // existing icon) alongside the fallback (re-add it), concise since the full
        // step-by-step instructions remain one tap away in Settings.
        <p className="text-sm text-[#f0f4f8] leading-relaxed">
          To enable notifications on this iPhone or iPad, open NeuroActive from its Home Screen icon. If you no
          longer see the icon, add NeuroActive to your Home Screen again.
        </p>
      ) : platform === 'ios' ? (
        <div className="space-y-2">
          <ol className="text-sm text-[#f0f4f8] space-y-1.5 list-decimal list-inside">
            <li className="flex items-start gap-1.5">
              <span>
                Tap the <Share size={13} className="inline align-text-bottom mx-0.5" aria-hidden="true" /> Share
                button
              </span>
            </li>
            <li>Choose "Add to Home Screen"</li>
            <li>Open NeuroActive from the new icon</li>
          </ol>
          <p className="text-xs text-[#3a4a5e] leading-relaxed pt-1">
            On iPhone and iPad, Home Screen installation is required for reminder notifications.
          </p>
        </div>
      ) : platform === 'macos-safari' ? (
        <p className="text-sm text-[#6b849e] leading-relaxed">
          In Safari's menu bar, choose File → Add to Dock to install NeuroActive.
        </p>
      ) : (
        <button
          type="button"
          onClick={() => {
            void promptInstall();
          }}
          className="w-full flex items-center justify-center gap-2 py-3 rounded-xl font-bold text-sm text-[#080d1a] hover:opacity-90 active:scale-95 transition-all"
          style={{ background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)' }}
        >
          <Download size={16} /> Install NeuroActive
        </button>
      )}

      <button
        type="button"
        onClick={dismissForSession}
        className="mt-4 text-xs text-[#6b849e] hover:text-[#f0f4f8] underline transition-colors"
      >
        Maybe later
      </button>
    </div>
  );
}
