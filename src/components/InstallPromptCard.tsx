// src/components/InstallPromptCard.tsx
// Contextual, dismissible "Install NeuroActive" card shown inside the DNS course
// experience — never before entitlement/checkout. PWA Phase 2: install UX only, no
// notification permission requests, no push, no reminder scheduling.
import { Download, Share, X } from 'lucide-react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

type Props = {
  // Caller-computed "the user has experienced the program, not just arrived" signal —
  // kept as a plain prop rather than reading dnsCourse here, so this component still has
  // no course-progress knowledge of its own.
  eligible: boolean;
};

export default function InstallPromptCard({ eligible }: Props) {
  const { isStandalone, platform, canInstall, promptInstall, dismissedThisSession, dismissForSession } =
    useInstallPrompt();

  if (!eligible || isStandalone || dismissedThisSession) return null;

  // iOS/macOS Safari always have actionable manual instructions; Android/desktop
  // Chromium only have something to offer once beforeinstallprompt has actually fired —
  // fail gracefully (render nothing) rather than show a button that can't install.
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
      <h3 className="font-bold text-[#f0f4f8] pr-8 mb-1">Install NeuroActive</h3>
      <p className="text-sm text-[#6b849e] leading-relaxed mb-4">
        Keep your program one tap away. Add NeuroActive to your Home Screen for quick access and, on supported
        devices, optional reminders.
      </p>

      {platform === 'ios' ? (
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
    </div>
  );
}
