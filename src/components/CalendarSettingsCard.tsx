// src/components/CalendarSettingsCard.tsx
// Calendar Integration Phase 1 — frontend UI. Minimal, real (not disposable) Calendar
// settings/subscription UI: configure a schedule, create a private subscribed calendar URL,
// copy it once, and revoke it later.
//
// SELF-CONTAINED BY DESIGN (Codex HIGH 1 repair): this component calls
// useCalendarPreferences()/useCalendarSubscriptions() directly, rather than receiving their
// state as props from App-lifetime code. That is deliberate and load-bearing, not a style
// choice: this component is only ever rendered while the user is on the Settings screen
// (see App.tsx's SettingsView, which itself is conditionally rendered and genuinely
// unmounts on navigation away), so calling the hooks HERE means the one-time bearer
// credential (`newlyCreated`) they may hold lives and dies with a single Settings visit. If
// these hooks were instead called in App() and merely passed down as props (the prior
// architecture), the credential would survive navigating away from and back to Settings,
// because the hook instance — and therefore its state — would never actually unmount. Do
// not hoist these hook calls back up to App() or thread their state through props again.
//
// PRIVATE URL HANDLING: the returned URL/secret is treated as a credential throughout this
// file — never passed to console.*, never persisted, never put in a query string, only ever
// written to the clipboard in direct response to the user's own Copy click.
import { useEffect, useRef, useState } from 'react';
import { Calendar, Copy, Check, Trash2 } from 'lucide-react';
import { useCalendarPreferences, MIN_SESSION_DURATION_MINUTES, MAX_SESSION_DURATION_MINUTES, type CalendarPreferences } from '../hooks/useCalendarPreferences';
import { useCalendarSubscriptions, MAX_LABEL_LENGTH, type CalendarSubscriptionSummary, type NewCalendarSubscription } from '../hooks/useCalendarSubscriptions';

const WEEKDAY_LABELS: { value: number; short: string; full: string }[] = [
  { value: 0, short: 'S', full: 'Sunday' },
  { value: 1, short: 'M', full: 'Monday' },
  { value: 2, short: 'T', full: 'Tuesday' },
  { value: 3, short: 'W', full: 'Wednesday' },
  { value: 4, short: 'T', full: 'Thursday' },
  { value: 5, short: 'F', full: 'Friday' },
  { value: 6, short: 'S', full: 'Saturday' },
];

function buildFeedUrl(secret: string): string {
  return `${window.location.origin}/calendar/${secret}.ics`;
}

function formatCreatedAt(ms: number | null): string {
  if (ms === null) return '';
  try {
    return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// Same remount-per-uid convention as NotificationSettingsCard's SchedulePreferences — a
// fresh component instance per uid structurally guarantees no cross-account state leakage
// in this form's own local draft state (independent of, and in addition to, the hook's own
// render-time uid filter).
function SchedulePreferencesForm({
  preferencesLoaded,
  preferences,
  defaultPreferences,
  saving,
  error,
  conflictMessage,
  conflictToken,
  onSave,
}: {
  preferencesLoaded: boolean;
  preferences: CalendarPreferences | null;
  defaultPreferences: CalendarPreferences;
  saving: boolean;
  error: string | null;
  conflictMessage: string | null;
  conflictToken: number;
  onSave: (next: CalendarPreferences) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState<CalendarPreferences>(preferences ?? defaultPreferences);
  const [saved, setSaved] = useState(false);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (hydratedRef.current) return;
    if (!preferencesLoaded) return;
    setDraft(preferences ?? defaultPreferences);
    hydratedRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferencesLoaded]);

  useEffect(() => {
    if (conflictToken === 0) return;
    setDraft(preferences ?? defaultPreferences);
    setSaved(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflictToken]);

  if (!preferencesLoaded) return null;

  const toggleWeekday = (day: number) => {
    setSaved(false);
    setDraft((prev) => {
      const has = prev.weekdays.includes(day);
      const weekdays = has ? prev.weekdays.filter((d) => d !== day) : [...prev.weekdays, day].sort((a, b) => a - b);
      return { ...prev, weekdays };
    });
  };

  const canSave = draft.weekdays.length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaved(false);
    // Timezone always comes from the current device, never a stale draft or a
    // user-editable field — same convention as the notification schedule form.
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const ok = await onSave({ ...draft, timezone });
    if (ok) setSaved(true);
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-1 justify-between" role="group" aria-label="Session weekdays">
        {WEEKDAY_LABELS.map(({ value, short, full }) => {
          const active = draft.weekdays.includes(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => toggleWeekday(value)}
              aria-pressed={active}
              aria-label={full}
              title={full}
              className={`w-9 h-9 rounded-full text-xs font-semibold border transition-colors ${
                active ? 'border-[#00d4c8] text-[#00d4c8] bg-[#00d4c8]/10' : 'border-[#1a2a42] text-[#6b849e]'
              }`}
            >
              {short}
            </button>
          );
        })}
      </div>

      <label className="block text-xs text-[#6b849e]">
        Session time
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

      <label className="block text-xs text-[#6b849e]">
        Session duration (minutes, {MIN_SESSION_DURATION_MINUTES}–{MAX_SESSION_DURATION_MINUTES})
        <input
          type="number"
          min={MIN_SESSION_DURATION_MINUTES}
          max={MAX_SESSION_DURATION_MINUTES}
          value={draft.sessionDurationMinutes}
          onChange={(e) => {
            setSaved(false);
            const parsed = parseInt(e.target.value, 10);
            setDraft((prev) => ({
              ...prev,
              sessionDurationMinutes: Number.isFinite(parsed) ? parsed : prev.sessionDurationMinutes,
            }));
          }}
          className="mt-1 w-full bg-[#0a1220] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8]"
        />
      </label>

      <p className="text-xs text-[#3a4a5e]">
        Times shown in your device's timezone ({Intl.DateTimeFormat().resolvedOptions().timeZone}).
      </p>

      <button
        type="button"
        onClick={handleSave}
        disabled={saving || !canSave}
        className="w-full border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50"
      >
        {saving ? 'Saving…' : 'Save schedule'}
      </button>

      {!canSave && <p className="text-xs text-[#6b849e]">Select at least one day.</p>}
      {conflictMessage && (
        <p className="text-xs text-[#6b849e]" role="status">
          {conflictMessage}
        </p>
      )}
      {saved && !saving && <p className="text-xs text-[#00e096]">Schedule saved.</p>}
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function NewSubscriptionPanel({
  subscription,
  onDismiss,
}: {
  subscription: NewCalendarSubscription;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const url = buildFeedUrl(subscription.secret);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Never log the URL/secret here, even on failure. The raw link remains selectable
      // below (select-all), so manual copy is still available.
      setCopyFailed(true);
      setCopied(false);
    }
  };

  return (
    <div className="bg-[#080d1a] border border-[#00d4c8]/30 rounded-xl p-4 space-y-3">
      <p className="text-sm font-semibold text-[#f0f4f8]">Your private calendar link is ready</p>
      <p className="text-xs text-[#ffcc00] leading-relaxed">
        This link is private — anyone with it can see your session schedule. Don't share it publicly. For your
        security, it's shown only this once and can't be displayed again after you leave this page (you can revoke
        it and create a new one anytime).
      </p>
      <div className="bg-[#0a1220] border border-[#1a2a42] rounded-lg px-3 py-2 text-xs text-[#f0f4f8] break-all select-all">
        {url}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleCopy}
          className="flex-1 flex items-center justify-center gap-2 border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold py-2 rounded-lg hover:bg-[#00d4c8]/10 transition-colors"
        >
          {copied ? <Check size={16} /> : <Copy size={16} />}
          {copied ? 'Copied' : 'Copy URL'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-[#6b849e] text-sm hover:text-[#f0f4f8] transition-colors px-3"
        >
          Done
        </button>
      </div>
      {copyFailed && (
        <p className="text-xs text-red-400" role="alert">
          Couldn't copy automatically — select the link above and copy it manually.
        </p>
      )}
      <p className="text-xs text-[#3a4a5e] leading-relaxed">
        Calendar apps check subscribed links for updates on their own schedule, not instantly — it may take a
        while for new sessions to appear after you add this link.
      </p>
      <details className="text-xs text-[#6b849e]">
        <summary className="cursor-pointer text-[#00d4c8] select-none">How do I add this to Google Calendar?</summary>
        <ol className="mt-2 space-y-1.5 list-decimal list-inside leading-relaxed">
          <li>Copy the private link above, then open Google Calendar on a computer — adding a calendar by URL isn't supported from the phone app.</li>
          <li>
            In the sidebar, next to <span className="text-[#f0f4f8]">Other calendars</span>, click{' '}
            <span className="text-[#f0f4f8]">+ → From URL</span>.
          </li>
          <li>Paste the link and click Add calendar.</li>
          <li>You may need to toggle the new calendar visible before its sessions show up.</li>
        </ol>
      </details>
    </div>
  );
}

function SubscriptionList({
  subscriptions,
  listLoaded,
  listError,
  revokingId,
  revokeError,
  onRevoke,
}: {
  subscriptions: CalendarSubscriptionSummary[];
  listLoaded: boolean;
  listError: boolean;
  revokingId: string | null;
  revokeError: string | null;
  onRevoke: (subscriptionId: string) => void;
}) {
  if (!listLoaded) return null;
  if (listError) {
    return (
      <p className="text-xs text-red-400" role="alert">
        Couldn't load your calendar subscriptions. Try again shortly.
      </p>
    );
  }
  if (subscriptions.length === 0) {
    return <p className="text-xs text-[#6b849e]">No active calendar subscriptions yet.</p>;
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-[#3a4a5e]">
        Lost a link? It can't be shown again — revoke it below and create a new one.
      </p>
      {subscriptions.map((sub) => (
        <SubscriptionRow
          key={sub.subscriptionId}
          subscription={sub}
          revoking={revokingId === sub.subscriptionId}
          onRevoke={() => onRevoke(sub.subscriptionId)}
        />
      ))}
      {revokeError && (
        <p className="text-xs text-red-400" role="alert">
          {revokeError}
        </p>
      )}
    </div>
  );
}

function SubscriptionRow({
  subscription,
  revoking,
  onRevoke,
}: {
  subscription: CalendarSubscriptionSummary;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const label = subscription.label || 'Calendar subscription';

  return (
    <div className="bg-[#080d1a] border border-[#1a2a42] rounded-lg px-3 py-2 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm text-[#f0f4f8] truncate">{label}</div>
          {subscription.createdAtMs !== null && (
            <div className="text-xs text-[#6b849e]">Created {formatCreatedAt(subscription.createdAtMs)}</div>
          )}
        </div>
        {!confirming && (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={revoking}
            aria-label={`Revoke ${label}`}
            className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50 flex-shrink-0"
          >
            <Trash2 size={14} />
            {revoking ? 'Revoking…' : 'Revoke'}
          </button>
        )}
      </div>
      {confirming && (
        <div className="space-y-2 pt-1 border-t border-[#1a2a42]">
          <p className="text-xs text-[#6b849e] leading-relaxed">
            Revoke this link? New requests will be denied right away. Your calendar app may still show sessions
            it already downloaded, even after refreshing — remove the subscribed calendar there if you want
            those events gone immediately.
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="text-xs text-[#6b849e] hover:text-[#f0f4f8] transition-colors px-3 py-2 min-h-[36px]"
            >
              Keep it
            </button>
            <button
              type="button"
              onClick={onRevoke}
              disabled={revoking}
              className="flex items-center gap-1 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50 px-3 py-2 min-h-[36px]"
            >
              <Trash2 size={14} />
              {revoking ? 'Revoking…' : 'Yes, revoke'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default function CalendarSettingsCard() {
  const {
    uid: preferencesUid,
    loaded: preferencesLoaded,
    preferences,
    readError: preferencesReadError,
    corrupt: preferencesCorrupt,
    defaultPreferences,
    saving: preferencesSaving,
    error: preferencesError,
    conflictMessage: preferencesConflictMessage,
    conflictToken: preferencesConflictToken,
    save: onSavePreferences,
  } = useCalendarPreferences();

  const {
    subscriptions,
    listLoaded: subscriptionsListLoaded,
    listError: subscriptionsListError,
    creating,
    createError,
    newlyCreated,
    create: onCreateSubscription,
    dismissNewlyCreated: onDismissNewlyCreated,
    revokingId,
    revokeError,
    revoke: onRevokeSubscription,
  } = useCalendarSubscriptions();

  const [labelInput, setLabelInput] = useState('');
  const atCap = subscriptions.length >= 5;

  const handleCreate = async () => {
    const ok = await onCreateSubscription(labelInput);
    if (ok) setLabelInput('');
  };

  return (
    <div className="bg-[#0f1829] p-6 rounded-2xl border border-[#1a2a42]">
      <h3 className="font-bold text-[#f0f4f8] mb-1 flex items-center gap-2">
        <Calendar size={20} className="text-[#00d4c8]" /> Calendar
      </h3>
      <p className="text-sm text-[#6b849e] mb-4">
        Subscribe to your NeuroActive session schedule from Apple Calendar, Google Calendar, or Outlook.
      </p>

      {preferencesReadError ? (
        <p className="text-xs text-red-400" role="alert">
          Couldn't load your calendar settings. Try again shortly.
        </p>
      ) : preferencesCorrupt ? (
        <p className="text-xs text-red-400" role="alert">
          There's a problem with your calendar settings. Please contact support.
        </p>
      ) : (
        <SchedulePreferencesForm
          key={preferencesUid ?? 'signed-out'}
          preferencesLoaded={preferencesLoaded}
          preferences={preferences}
          defaultPreferences={defaultPreferences}
          saving={preferencesSaving}
          error={preferencesError}
          conflictMessage={preferencesConflictMessage}
          conflictToken={preferencesConflictToken}
          onSave={onSavePreferences}
        />
      )}

      <div className="mt-4 pt-4 border-t border-[#1a2a42] space-y-3">
        <span className="text-sm font-semibold text-[#f0f4f8]">Calendar subscriptions</span>

        {newlyCreated ? (
          <NewSubscriptionPanel subscription={newlyCreated} onDismiss={onDismissNewlyCreated} />
        ) : (
          <>
            <div className="flex gap-2">
              <input
                type="text"
                value={labelInput}
                onChange={(e) => setLabelInput(e.target.value.slice(0, MAX_LABEL_LENGTH))}
                placeholder="Label (optional, e.g. Phone)"
                aria-label="Subscription label (optional)"
                maxLength={MAX_LABEL_LENGTH}
                disabled={atCap}
                className="flex-1 bg-[#0a1220] border border-[#1a2a42] rounded-lg px-3 py-2 text-sm text-[#f0f4f8] placeholder-[#3a4a5e] disabled:opacity-50"
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || atCap}
                className="border border-[#00d4c8]/40 text-[#00d4c8] text-sm font-semibold px-4 rounded-lg hover:bg-[#00d4c8]/10 transition-colors disabled:opacity-50 whitespace-nowrap"
              >
                {creating ? 'Creating…' : 'Create link'}
              </button>
            </div>
            {creating && (
              <p className="text-xs text-[#6b849e]">Stay on this page — your link will appear here in a moment.</p>
            )}
            {atCap && (
              <p className="text-xs text-[#6b849e]">
                You've reached the maximum of 5 active calendar links. Revoke one to create another.
              </p>
            )}
            {createError && (
              <p className="text-xs text-red-400" role="alert">
                {createError}
              </p>
            )}
          </>
        )}

        <SubscriptionList
          subscriptions={subscriptions}
          listLoaded={subscriptionsListLoaded}
          listError={subscriptionsListError}
          revokingId={revokingId}
          revokeError={revokeError}
          onRevoke={(id) => { void onRevokeSubscription(id); }}
        />
      </div>
    </div>
  );
}
