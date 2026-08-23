// src/hooks/useNotificationPreferences.ts
// Phase 3A-3 Step 1 (fourth Codex repair round) — reminder PREFERENCES only. No
// scheduler, no reminder records, no sends exist anywhere yet (see
// functions/src/notificationPreferences.ts). This hook never writes the preferences
// document directly — Firestore rules deny client writes entirely (see firestore.rules)
// — it only ever calls the two callables there, which re-validate/re-normalize
// everything server-side.
//
// UID ISOLATION (preserved from earlier rounds): displayed state is synchronously
// cleared to null the INSTANT uid changes — before the new listener has delivered
// anything — so no render frame can attribute a preferences snapshot to a uid other than
// the one that produced it. Every write path re-verifies `loadedState.uid === <current
// uid>` via refs both before AND after its async call, and fails closed otherwise.
//
// REVISION WATERMARK (this round — fixes a race Codex found: once the DISPLAYED state
// became `readError`/`corrupt`, a delayed lower-revision callable response could be
// accepted, because the prior rounds' monotonic check compared only against the
// currently DISPLAYED state's revision — and readError/corrupt states don't carry one).
// A separate `highestObservedRevision` watermark, tracked per-uid independently of what's
// currently displayed, now enforces the absolute floor: once revision N has been
// observed for a uid, nothing carrying revision < N is ever accepted again for that uid,
// regardless of what's currently displayed. See reconcileIncoming below — the single
// function every state-producing path funnels through.
//
// UID-OWNED CONFLICT STATE (this round — fixes a render-time leak Codex found: an
// effect-based reset of conflict state runs strictly after a re-render has already
// committed, so a single render frame could show uid A's conflict banner while `uid` had
// already flipped to B). Conflict state is now tagged with the uid that produced it and
// filtered at RENDER TIME — computed fresh from current props on every render, not
// gated behind an effect — so it is structurally impossible for a mismatched-uid
// conflict to ever be exposed, not even for one frame.
import { useCallback, useEffect, useRef, useState } from 'react';
import { onIdTokenChanged, type User } from 'firebase/auth';
import { doc, onSnapshot } from 'firebase/firestore';
import { getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { auth, db, appId } from '../services/firebase';

// 0=Sunday..6=Saturday — matches JS Date.getDay() exactly, same convention used
// server-side (functions/src/notificationPreferences.ts), so no translation layer is
// ever needed at any call site.
export type ScheduleType = 'daily' | 'weekdays';

export type NotificationPreferences = {
  enabled: boolean;
  scheduleType: ScheduleType;
  weekdays: number[];
  localTime: string; // "HH:MM", 24-hour
  timezone: string; // IANA zone name (server-canonicalized)
};

type StoredShape = NotificationPreferences & { revision: number };
type UpdateResult = StoredShape & { nextReminderDueAt: number | null };

// Discriminated so a corrupt/read-error state can never be mistaken for "no document" —
// only OkState carries `preferences`/`revision`.
type OkState = { kind: 'ok'; preferences: NotificationPreferences | null; revision: number };
type ReadErrorState = { kind: 'readError' };
type CorruptState = { kind: 'corrupt' };
type IncomingState = OkState | ReadErrorState | CorruptState;
type DisplayedState = { uid: string } & IncomingState;

type ConflictState = { uid: string; message: string; token: number };

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  enabled: false,
  scheduleType: 'daily',
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  localTime: '07:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

function detectDeviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

// Mirrors the server's isValidExistingRevision exactly (functions/src/notificationPreferences.ts).
function isValidExistingRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

function normalizePreferencesDoc(data: Record<string, unknown>): NotificationPreferences {
  return {
    enabled: !!data.enabled,
    scheduleType: data.scheduleType === 'weekdays' ? 'weekdays' : 'daily',
    weekdays: Array.isArray(data.weekdays) ? (data.weekdays as number[]) : DEFAULT_PREFERENCES.weekdays,
    localTime: typeof data.localTime === 'string' ? data.localTime : DEFAULT_PREFERENCES.localTime,
    timezone: typeof data.timezone === 'string' ? data.timezone : DEFAULT_PREFERENCES.timezone,
  };
}

function isConflictError(err: unknown): err is FunctionsError {
  return !!err && typeof err === 'object' && (err as FunctionsError).code === 'functions/aborted';
}

// CENTRAL, WATERMARK-AWARE STATE-RECONCILIATION HELPER — the single place the "never
// regress" invariant is enforced for a given uid, used by every state-producing path
// (listener success, listener error, save success, conflict reconciliation).
//
// Decision order (this is the exact fix for a race Codex found: a prior version only
// applied the equal-revision "callable never overwrites listener content" rule when the
// PREVIOUSLY DISPLAYED state was itself 'ok' — so an equal-revision callable response
// could wrongly recover a readError/corrupt display, since that branch didn't check
// source at all. The source rule is now enforced unconditionally, on the watermark
// alone, BEFORE any branch that considers what's currently displayed):
//
//   1. Incoming is corrupt/readError -> ALWAYS becomes the displayed state immediately
//      (data-integrity problems must never be suppressed); the watermark is left
//      completely untouched — never erased, never lowered.
//   2. Incoming is 'ok' with revision < watermark -> rejected outright, regardless of
//      source or what's currently displayed.
//   3. Incoming is 'ok' with revision === watermark AND source is 'callable' -> rejected,
//      regardless of what's currently displayed (ok, readError, or corrupt). A callable
//      response can never recover an error/corrupt display, nor overwrite
//      already-observed listener content, merely by matching the watermark.
//   4. Incoming is 'ok' with revision === watermark AND source is 'listener' -> applied.
//      The listener may legitimately carry newer timezone-maintenance content at an
//      unchanged revision, and is trusted to recover a readError/corrupt display.
//   5. Incoming is 'ok' with revision > watermark (any source) -> applied, watermark
//      advances to the new revision.
//
// Note: whenever the displayed state is 'ok', its revision is always exactly equal to
// the watermark (every acceptance path sets both together) — so "watermark" alone is a
// complete stand-in for "the currently displayed ok revision, if any" and no separate
// comparison against prevDisplayed's own revision is needed.
function reconcileIncoming(
  prevDisplayed: IncomingState | null,
  watermark: number,
  incoming: IncomingState,
  source: 'listener' | 'callable'
): { displayed: IncomingState; watermark: number } {
  if (incoming.kind !== 'ok') {
    return { displayed: incoming, watermark };
  }

  if (incoming.revision < watermark) {
    return { displayed: prevDisplayed ?? incoming, watermark };
  }

  if (incoming.revision === watermark && source === 'callable') {
    return { displayed: prevDisplayed ?? incoming, watermark };
  }

  return { displayed: incoming, watermark: Math.max(watermark, incoming.revision) };
}

export function useNotificationPreferences() {
  const [uid, setUid] = useState<string | null>(null);
  const uidRef = useRef<string | null>(null);
  uidRef.current = uid;

  const [displayed, setDisplayed] = useState<DisplayedState | null>(null);
  // Kept synchronously current so save()/refreshTimezone() and the reconciliation
  // helper always compare against the true latest state within a single tick.
  const displayedRef = useRef<DisplayedState | null>(null);
  // Highest revision ever observed for the CURRENT uid — independent of `displayed`,
  // never erased or lowered by a readError/corrupt transition. Reset only on uid change.
  const watermarkRef = useRef<number>(0);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  // Per-uid, not a single shared flag — completion of one uid's in-flight refresh must
  // never clear a DIFFERENT (newer) uid's independently in-flight refresh.
  const tzRefreshInFlightUidRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Tagged with the uid that produced it. Exposed to the return value ONLY when its uid
  // matches the CURRENT `uid`, filtered fresh on every render (see the return statement)
  // — not gated behind an effect, so there is no render frame in which a mismatched-uid
  // conflict can leak through.
  const [conflictState, setConflictState] = useState<ConflictState | null>(null);
  const conflictTokenCounterRef = useRef(0);

  // Applies an incoming state through the watermark-aware reconciliation helper for the
  // given uid, keeping the ref and React state in lockstep, and returns the value that
  // actually won (which may be unchanged) so callers needing the FINAL authoritative
  // state synchronously (the conflict path) don't have to wait for a re-render.
  const applyIncoming = useCallback(
    (forUid: string, incoming: IncomingState, source: 'listener' | 'callable'): DisplayedState | null => {
      if (uidRef.current !== forUid) {
        // A response/event for a uid that is no longer current — never touch displayed
        // state or the watermark for the now-active uid.
        return displayedRef.current;
      }
      const prevIncoming: IncomingState | null = displayedRef.current;
      const { displayed: nextIncoming, watermark: nextWatermark } = reconcileIncoming(
        prevIncoming,
        watermarkRef.current,
        incoming,
        source
      );
      watermarkRef.current = nextWatermark;
      const next: DisplayedState = { uid: forUid, ...nextIncoming } as DisplayedState;
      displayedRef.current = next;
      setDisplayed(next);
      return next;
    },
    []
  );

  useEffect(() => {
    if (!auth) return;
    return onIdTokenChanged(auth, (user: User | null) => {
      setUid(user && !user.isAnonymous ? user.uid : null);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;

    // Synchronously invalidate any previous uid's displayed state, watermark, and
    // conflict state the instant uid changes — before the new listener has delivered
    // anything, and before a freshly-remounted form (keyed by uid) could otherwise
    // observe leftover state from the previous uid.
    displayedRef.current = null;
    setDisplayed(null);
    watermarkRef.current = 0;
    setConflictState(null);

    if (!db || !uid) {
      return () => {
        cancelled = true;
      };
    }

    const ref = doc(db, 'artifacts', appId, 'users', uid, 'notificationPreferences', 'main');
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (cancelled) return;
        let incoming: IncomingState;
        if (!snap.exists()) {
          incoming = { kind: 'ok', preferences: null, revision: 0 };
        } else {
          const data = snap.data();
          if (!isValidExistingRevision(data.revision)) {
            incoming = { kind: 'corrupt' };
          } else {
            incoming = { kind: 'ok', preferences: normalizePreferencesDoc(data), revision: data.revision };
          }
        }
        applyIncoming(uid, incoming, 'listener');
      },
      () => {
        if (cancelled) return;
        applyIncoming(uid, { kind: 'readError' }, 'listener');
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [uid, applyIncoming]);

  const save = useCallback(async (next: NotificationPreferences): Promise<boolean> => {
    if (savingRef.current) return false;

    const currentUid = uidRef.current;
    const currentDisplayed = displayedRef.current;
    if (!currentUid) return false;
    if (!currentDisplayed || currentDisplayed.uid !== currentUid) return false;
    if (currentDisplayed.kind !== 'ok') {
      // Corrupt or read-error state — never submit a save built on untrustworthy data.
      return false;
    }

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const expectedRevision = currentDisplayed.revision;
      const updateFn = httpsCallable<NotificationPreferences & { expectedRevision: number }, UpdateResult>(
        getFunctions(),
        'updateNotificationPreferences'
      );
      const result = await updateFn({ ...next, expectedRevision });

      applyIncoming(
        currentUid,
        {
          kind: 'ok',
          preferences: {
            enabled: result.data.enabled,
            scheduleType: result.data.scheduleType,
            weekdays: result.data.weekdays,
            localTime: result.data.localTime,
            timezone: result.data.timezone,
          },
          revision: result.data.revision,
        },
        'callable'
      );
      return true;
    } catch (err) {
      if (isConflictError(err)) {
        const details = err.details as { currentRevision?: number; current?: StoredShape | null } | undefined;
        if (details) {
          const conflictIncoming: IncomingState = {
            kind: 'ok',
            preferences: details.current
              ? {
                  enabled: details.current.enabled,
                  scheduleType: details.current.scheduleType,
                  weekdays: details.current.weekdays,
                  localTime: details.current.localTime,
                  timezone: details.current.timezone,
                }
              : null,
            revision: typeof details.currentRevision === 'number' ? details.currentRevision : 0,
          };
          // Watermark-aware reconciliation decides whether this conflict response or an
          // already-newer/already-displayed state wins — the conflict response is not
          // assumed to be the newest thing in the system merely because it just arrived,
          // and (per reconcileIncoming's step 3) an equal-watermark conflict response
          // from a callable is never able to overwrite or "recover" a readError/corrupt
          // display. Guarded by applyIncoming's own uid check: a delayed response for a
          // uid that's no longer current is a no-op.
          const resultState = applyIncoming(currentUid, conflictIncoming, 'callable');
          // Only surface the conflict banner / bump the rehydration token when the
          // resulting displayed state is actually 'ok' — i.e. there is real authoritative
          // content to rehydrate the form from, whether that's this payload (it won) or
          // whatever was already displayed (it was already newer/equal and won instead).
          // If reconciliation rejected this payload while the display remains
          // readError/corrupt, there is nothing valid to rehydrate from — firing the
          // "latest settings have been loaded" message in that case would be false, and
          // the form must never be reset toward a rejected stale payload.
          if (uidRef.current === currentUid && resultState && resultState.kind === 'ok') {
            conflictTokenCounterRef.current += 1;
            setConflictState({
              uid: currentUid,
              message: 'Your reminder schedule changed on another device. The latest settings have been loaded.',
              token: conflictTokenCounterRef.current,
            });
          }
        }
        return false;
      }
      if (uidRef.current === currentUid) {
        setError(err instanceof Error ? err.message : 'Failed to save reminder preferences.');
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [applyIncoming]);

  // Narrow timezone-only maintenance call — never carries schedule fields, never touches
  // `revision`. Never creates a document, never fires for a uid mismatch, never fires
  // against corrupt/read-error state. In-flight-deduped PER UID: completion of one uid's
  // refresh clears only that uid's marker, so switching accounts mid-refresh never blocks
  // (or is blocked by) the new uid's own independent refresh.
  const refreshTimezone = useCallback(async (timezone: string): Promise<void> => {
    const currentUid = uidRef.current;
    if (!currentUid) return;
    if (tzRefreshInFlightUidRef.current === currentUid) return;

    const currentDisplayed = displayedRef.current;
    if (!currentDisplayed || currentDisplayed.uid !== currentUid || currentDisplayed.kind !== 'ok' || !currentDisplayed.preferences) return;

    tzRefreshInFlightUidRef.current = currentUid;
    try {
      const fn = httpsCallable<{ timezone: string }, { updated: boolean }>(
        getFunctions(),
        'refreshNotificationTimezone'
      );
      await fn({ timezone });
      // Deliberately no optimistic local write here — the read-only listener is the
      // sole source of truth for the result, applied via the same watermark-aware path.
    } catch {
      // Best-effort background maintenance, not a user-initiated action — silent.
    } finally {
      // Only clear THIS uid's marker — if the active uid changed while this call was in
      // flight, that newer uid's own (independent) in-flight marker must survive.
      if (tzRefreshInFlightUidRef.current === currentUid) {
        tzRefreshInFlightUidRef.current = null;
      }
    }
  }, []);

  // Timezone-drift refresh: on mount and whenever the tab/app regains foreground,
  // compare the device's CURRENT resolved IANA zone against the last-saved one. Only
  // acts when displayed state is proven to belong to the current uid, is 'ok', AND a
  // preferences document already exists — never implicitly creates one.
  useEffect(() => {
    if (!uid || !displayed || displayed.uid !== uid || displayed.kind !== 'ok' || !displayed.preferences) return;

    const check = () => {
      const current = displayedRef.current;
      if (!current || current.uid !== uidRef.current || current.kind !== 'ok' || !current.preferences) return;
      const deviceTz = detectDeviceTimezone();
      if (deviceTz && deviceTz !== current.preferences.timezone) {
        void refreshTimezone(deviceTz);
      }
    };

    check();
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [uid, displayed, refreshTimezone]);

  const current = displayed && displayed.uid === uid ? displayed : null;
  // Render-time-only filter: conflict state is exposed exclusively when it belongs to
  // the CURRENT uid, computed fresh on every render — this is the actual enforcement of
  // "uid A's conflict must never be visible to uid B," not the effect above (which only
  // does cleanup/GC).
  const exposedConflict = conflictState && conflictState.uid === uid ? conflictState : null;

  return {
    uid,
    loaded: uid === null || current !== null,
    preferences: current && current.kind === 'ok' ? current.preferences : null,
    revision: current && current.kind === 'ok' ? current.revision : 0,
    readError: current?.kind === 'readError',
    corrupt: current?.kind === 'corrupt',
    defaultPreferences: DEFAULT_PREFERENCES,
    saving,
    error,
    conflictMessage: exposedConflict?.message ?? null,
    conflictToken: exposedConflict?.token ?? 0,
    save,
  };
}
