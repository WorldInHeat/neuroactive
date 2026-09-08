// src/components/InstallSettingsCard.tsx
// Persistent "Install NeuroActive" row for Settings — unlike InstallPromptCard, this
// never self-dismisses for the session, so a user who dismissed the contextual prompt
// (or who deleted the app after having it installed) can always find the real
// install/re-install instructions here. PWA Phase 2: install UX only.
import { Download, Share } from 'lucide-react';
import { useInstallPrompt } from '../hooks/useInstallPrompt';

export default function InstallSettingsCard() {
  const { displayState, platform, canInstall, promptInstall } = useInstallPrompt();

  if (displayState === 'standalone') {
    return (
      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
        <h3 className="font-bold text-[#f0f4f8] mb-1 flex items-center gap-2">
          <Download size={20} className="text-[#00d4c8]" /> App
        </h3>
        <p className="text-sm text-[#6b849e]">NeuroActive is installed on this device.</p>
      </div>
    );
  }

  const showsInstructionsOnly = platform === 'ios' || platform === 'macos-safari';
  if (!showsInstructionsOnly && !canInstall) return null;

  // `previously-standalone` (see useInstallPrompt.ts's StandaloneDisplayState) is
  // historical evidence only — this origin was opened standalone at some point, never
  // proof the Home Screen icon still exists today. The instructions below are therefore
  // always shown regardless of this state, never suppressed — a user who deleted the app
  // must still land on a real, complete route back to installing it, not a dead end.
  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
      <h3 className="font-bold text-[#f0f4f8] mb-1 flex items-center gap-2">
        <Download size={20} className="text-[#00d4c8]" /> {displayState === 'previously-standalone' ? 'App' : 'Install NeuroActive'}
      </h3>
      {displayState === 'previously-standalone' && (
        <p className="text-sm text-[#f0f4f8] leading-relaxed mb-3">
          NeuroActive may already be on your Home Screen — open it from there for the full experience. If you
          don't see the icon, you can add it again below.
        </p>
      )}
      <p className="text-sm text-[#6b849e] mb-4 leading-relaxed">
        Keep your program one tap away. Add NeuroActive to your Home Screen for quick access and, on supported
        devices, optional reminders.
      </p>

      {platform === 'ios' ? (
        <div className="space-y-2">
          <ol className="text-sm text-[#f0f4f8] space-y-1.5 list-decimal list-inside">
            <li>
              Tap the <Share size={13} className="inline align-text-bottom mx-0.5" aria-hidden="true" /> Share button
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
