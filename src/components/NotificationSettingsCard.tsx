// src/components/NotificationSettingsCard.tsx
// Phase 3A-1: device-registration status/enable button (unchanged below).
// Phase 3A-3 Step 1: reminder SCHEDULE PREFERENCES only, added below that. There is still
// no scheduled sender anywhere in this project — this UI configures what a future sender
// will read, it does not promise reminders are currently being sent, and its copy says so
// explicitly rather than implying otherwise.
import { useEffect, useRef, useState } from 'react';
import { Bell } from 'lucide-react';
import type { NotificationStatus } from '../hooks/useNotifications';
import type { NotificationPreferences, ScheduleType } from '../hooks/useNotificationPreferences';

const WEEKDAY_LABELS: { value: number; label: string }[] = [
  { value: 0, label: 'Sun' },
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
];

// Remounted by the caller via `key={preferencesUid}` whenever the authenticated uid
// changes (see NotificationSettingsCard below) — a fresh component instance means fresh
// useState/useRef, so `hydratedRef`/`draft`/`saved` can never carry one uid's data into
// a render for a different uid. This was Codex's Blocker 3 finding: an earlier version
// reset none of this across an account switch. Remounting is the "simplest robust
// approach" the repair request itself named, and it structurally guarantees the fix
// rather than relying on a manually-maintained reset effect that could itself be
// incomplete.
function SchedulePreferences({
  preferencesLoaded,
  preferences,
  defaultPreferences,
  preferencesSaving,
  preferencesError,
  preferencesConflictMessage,
  preferencesConflictToken,
  onSavePreferences,
}: {
  preferencesLoaded: boolean;
  preferences: NotificationPreferences | null;
  defaultPreferences: NotificationPreferences;
  preferencesSaving: boolean;
  preferencesError: string | null;
  preferencesConflictMessage: string | null;
  preferencesConflictToken: number;
  onSavePreferences: (next: NotificationPreferences) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<NotificationPreferences>(preferences ?? defaultPreferences);
  const [saved, setSaved] = useState(false);
  const hydratedRef = useRef(false);

  // Hydrate the draft from the authoritative server-loaded value exactly once per
  // component instance (i.e. once per uid, since the whole component remounts on uid
  // change) — never again after that, so a user's in-progress edits are never silently
  // clobbered by a later external update for the SAME uid (e.g. the background timezone
  // refresh completing while the user is mid-edit).
  useEffect(() => {
    if (hydratedRef.current) return;
    if (!preferencesLoaded) return;
    setDraft(preferences ?? defaultPreferences);
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferencesLoaded]);

  // On a revision conflict (a save this form attempted was rejected because a newer
  // version already existed — see useNotificationPreferences.ts), the hook has already
  // reconciled `preferences` to the true authoritative state. This form must show that
  // real state, not whatever the user was mid-editing — so this OVERRIDES the
  // one-time-hydration guard above, deliberately, every time `preferencesConflictToken`
  // changes (a fresh value per conflict, even across repeated identical-looking
  // conflicts). This is the only path in this component that re-hydrates after the
  // initial load.
  useEffect(() => {
    if (preferencesConflictToken === 0) return; // 0 = no conflict has occurred yet
    setDraft(preferences ?? defaultPreferences);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferencesConflictToken]);

  if (!preferencesLoaded) {
    return null;
  }

  const toggleWeekday = (day: number) => {
    setSaved(false);
    setDraft((prev) => {
      const has = prev.weekdays.includes(day);
      const weekdays = has ? prev.weekdays.filter((d) => d !== day) : [...prev.weekdays, day].sort((a, b) => a - b);
      return { ...prev, weekdays };
    });
  };

  const canSave = draft.scheduleType === 'daily' || draft.weekdays.length > 0;

  const handleSave = async () => {
    setSaved(false);
    // Timezone always comes from the currently-known preferences/device value, never a
    // stale draft — this form never lets the user edit timezone directly.
    const timezone = preferences?.timezone ?? defaultPreferences.timezone;
    const ok = await onSavePreferences({ ...draft, timezone });
    if (ok) setSaved(true);
  };

  return (
    <div className="mt-4 pt-4 border-t border-[#1a2a42] space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-[#f0f4f8]">Session reminders</span>
        <button
          type="button"
          role="switch"
          aria-checked={draft.enabled}
          onClick={() => {
            setSaved(false);
            setDraft((prev) => ({ ...prev, enabled: !prev.enabled }));
          }}
          className={`relative w-11 h-6 rounded-full transition-colors ${
            draft.enabled ? 'bg-[#00d4c8]' : 'bg-[#1a2a42]'
          }`}
        >
          <span
            className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform ${
              draft.enabled ? 'translate-x-5' : ''
            }`}
          />
        </button>
      </div>

      {draft.enabled && (
        <>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                setSaved(false);
                setDraft((prev) => ({ ...prev, scheduleType: 'daily' as ScheduleType }));
              }}
              className={`flex-1 text-xs font-semibold py-1.5 rounded-lg border transition-colors ${
                draft.scheduleType === 'daily'
                  ? 'border-[#00d4c8] text-[#00d4c8] bg-[#00d4c8]/10'
                  : 'border-[#1a2a42] text-[#6b849e]'
              }`}
            >
              Daily
            </button>
            <button
              type="button"
              onClick={() => {
                setSaved(false);
                setDraft((prev) => ({ ...prev, scheduleType: 'weekdays' as ScheduleType }));
              }}
              className={`flex-1 text-xs font-semibold py-1.5 rounded-lg border transition-colors ${
                draft.scheduleType === 'weekdays'
                  ? 'border-[#00d4c8] text-[#00d4c8] bg-[#00d4c8]/10'
                  : 'border-[#1a2a42] text-[#6b849e]'
              }`}
            >
              Selected days
            </button>
          </div>

          {draft.scheduleType === 'weekdays' && (
            <div className="flex gap-1 justify-between">
              {WEEKDAY_LABELS.map(({ value, label }) => {
                const active = draft.weekdays.includes(value);
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => toggleWeekday(value)}
                    className={`w-9 h-9 rounded-full text-xs font-semibold border transition-colors ${
                      active
                        ? 'border-[#00d4c8] text-[#00d4c8] bg-[#00d4c8]/10'
                        : 'border-[#1a2a42] text-[#6b849e]'
                    }`}
                  >
                    {label[0]}
                  </button>
                );
              })}
            </div>
          )}

          <label className="block text-xs text-[#6b849e]">
            Reminder time
            <input
              type="time"
              value={draft.localTime}
              onChange={(e) => {
                setSaved(false);
                setDraft((prev) => ({ ...prev, localTime: e.target.value }));
              }}
              className="mt-1 w-full bg-[#0a1220] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8]"
            />
          </label>
        </>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={preferencesSaving || !canSave}
        className="w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50"
      >
        {preferencesSaving ? 'Saving…' : 'Save reminder schedule'}
      </button>

      {!canSave && (
        <p className="text-xs text-[#6b849e]">Select at least one day.</p>
      )}
      {preferencesConflictMessage && (
        <p className="text-xs text-[#6b849e]" role="status">
          {preferencesConflictMessage}
        </p>
      )}
      {saved && !preferencesSaving && (
        <p className="text-xs text-[#00e096]">Schedule saved. Reminders aren't sending yet — this sets up when they will.</p>
      )}
      {preferencesError && (
        <p className="text-xs text-red-400" role="alert">
          {preferencesError}
        </p>
      )}
    </div>
  );
}

export default function NotificationSettingsCard({
  status,
  error,
  onEnable,
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
  status: NotificationStatus;
  error: string | null;
  onEnable: () => void;
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

      {preferencesReadError ? (
        <div className="mt-4 pt-4 border-t border-[#1a2a42]">
          <p className="text-xs text-red-400" role="alert">
            Couldn't load your reminder settings. Try again shortly.
          </p>
        </div>
      ) : preferencesCorrupt ? (
        // Distinct from preferencesReadError (a transient/retry-worthy condition) — this
        // means an existing document was actually read but its data didn't pass
        // validation. Never rendered as though there's simply no schedule configured,
        // and never allowed to reach the editable form below, which would let a save
        // silently paper over the corruption.
        <div className="mt-4 pt-4 border-t border-[#1a2a42]">
          <p className="text-xs text-red-400" role="alert">
            There's a problem with your reminder settings. Please contact support.
          </p>
        </div>
      ) : (
        <SchedulePreferences
          // Remounts this entire subtree whenever the authenticated uid changes (see the
          // comment above SchedulePreferences) — the structural fix for Codex's Blocker 3.
          key={preferencesUid ?? 'signed-out'}
          preferencesLoaded={preferencesLoaded}
          preferences={preferences}
          defaultPreferences={defaultPreferences}
          preferencesSaving={preferencesSaving}
          preferencesError={preferencesError}
          preferencesConflictMessage={preferencesConflictMessage}
          preferencesConflictToken={preferencesConflictToken}
          onSavePreferences={onSavePreferences}
        />
      )}
    </div>
  );
}
