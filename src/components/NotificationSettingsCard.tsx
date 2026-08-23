// src/components/NotificationSettingsCard.tsx
// Settings card for Phase 3A-1: permission request + device registration only. State machine
// lives in useNotifications.ts — this component only renders it. Deliberately says nothing
// about reminders, schedules, or lesson content — that's out of scope this phase.
import { Bell } from 'lucide-react';
import type { NotificationStatus } from '../hooks/useNotifications';

export default function NotificationSettingsCard({
  status,
  error,
  onEnable,
}: {
  status: NotificationStatus;
  error: string | null;
  onEnable: () => void;
}) {
  if (status === 'unsupported') {
    return (
      <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
        <h3 className="font-bold text-[#f0f4f8] mb-1 flex items-center gap-2">
          <Bell size={20} className="text-[#00d4c8]" /> Notifications
        </h3>
        <p className="text-sm text-[#6b849e]">Notifications aren't supported in this browser.</p>
      </div>
    );
  }

  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
      <h3 className="font-bold text-[#f0f4f8] mb-1 flex items-center gap-2">
        <Bell size={20} className="text-[#00d4c8]" /> Notifications
      </h3>

      {status === 'registered' ? (
        <p className="text-sm text-[#00e096]">Notifications are enabled on this device.</p>
      ) : status === 'ios-not-installed' ? (
        <p className="text-sm text-[#6b849e] leading-relaxed">
          Add NeuroActive to your Home Screen before enabling notifications on iPhone or iPad.
        </p>
      ) : status === 'denied' ? (
        <p className="text-sm text-[#6b849e] leading-relaxed">
          Notifications are blocked for NeuroActive on this device. You can re-enable them in your browser or
          system settings.
        </p>
      ) : (
        <>
          <p className="text-sm text-[#6b849e] mb-4">Get reminders from NeuroActive on this device.</p>
          <button
            type="button"
            onClick={onEnable}
            disabled={status === 'registering'}
            className="w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50"
          >
            {status === 'registering' ? 'Enabling…' : 'Enable notifications'}
          </button>
          {status === 'error' && error && (
            <p className="text-xs text-red-400 mt-2" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </div>
  );
}
