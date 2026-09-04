// src/hooks/useCalendarPreferences.ts
// Calendar Integration Phase 1 — frontend UI, Stage 1. Schedule PREFERENCES only. Mirrors
// useNotificationPreferences.ts's own established pattern (Firestore listener for read,
// httpsCallable for write, CAS-conflict handling, uid-scoped state) — this hook never
// writes calendarPreferences/main directly (firestore.rules denies client writes entirely),
// it only calls updateCalendarPreferences, which re-validates and re-normalizes everything
// server-side (see functions/src/calendarPreferences.ts).
//
// UID ISOLATION: identical approach to useNotificationPreferences.ts — displayed state is
// synchronously cleared to null the instant uid changes, and every write path re-verifies
// the uid before and after its async call.
import { useCallback, useEffect, useRef, useState } from 'react';
import { onIdTokenChanged, type User } from 'firebase/auth';
import { doc, onSnapshot, Timestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { auth, db, appId } from '../services/firebase';

// 0=Sunday..6=Saturday — matches functions/src/calendarPreferences.ts's own convention
// exactly (which itself matches notificationPreferences.ts's convention).
export type CalendarPreferences = {
  weekdays: number[];
  localTime: string; // "HH:MM", 24-hour
  timezone: string; // IANA zone name (server-canonicalized)
  sessionDurationMinutes: number;
};

type StoredShape = CalendarPreferences & { revision: number };

type OkState = { kind: 'ok'; preferences: CalendarPreferences | null; revision: number };
type ReadErrorState = { kind: 'readError' };
type CorruptState = { kind: 'corrupt' };
type IncomingState = OkState | ReadErrorState | CorruptState;
type DisplayedState = { uid: string } & IncomingState;

export const DEFAULT_CALENDAR_PREFERENCES: CalendarPreferences = {
  weekdays: [1, 2, 3, 4, 5],
  localTime: '09:00',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  sessionDurationMinutes: 20,
};

const MIN_SESSION_DURATION_MINUTES = 5;
const MAX_SESSION_DURATION_MINUTES = 120;
export { MIN_SESSION_DURATION_MINUTES, MAX_SESSION_DURATION_MINUTES };

// STRICT STORED-DOCUMENT VALIDATION (Codex MEDIUM repair) — duplicated deliberately from
// functions/src/calendarPreferences.ts's own parseStoredCalendarPreferences /
// isValidExistingRevision / isPlainRecord / hasExactOwnKeys, following this project's own
// established per-file duplication convention (see e.g. calendarFeedAdapter.ts's header on
// why a small, stable validator is copied rather than imported across the frontend/backend
// boundary — there is no shared-code path between `src/` and `functions/`, and importing
// server-only code into the client bundle would be worse coupling than duplicating ~25
// lines of pure validation logic). If functions/src/calendarPreferences.ts's own constraints
// ever change, this block must be updated to match — it is not derived automatically.
//
// Every check below exists because the corresponding server-side check exists: a stored
// document is only ever written by the server's own transaction, so anything that doesn't
// match its exact contract is corruption, never something to weakly cast or default. A
// document that fails ANY check here must render as `corrupt`, never as a plausible-looking
// but partially-fabricated CalendarPreferences value.
const STORED_DOC_KEYS = ['weekdays', 'localTime', 'timezone', 'sessionDurationMinutes', 'revision', 'updatedAt'] as const;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasExactOwnKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expectedSet = new Set(expectedKeys);
  return actualKeys.every((k) => expectedSet.has(k));
}

// Mirrors the server's isValidExistingRevision exactly (functions/src/calendarPreferences.ts).
function isValidExistingRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    Number.isSafeInteger(value) &&
    value >= 1
  );
}

// Returns null for ANY shape/value violation — the caller must treat null as `corrupt`,
// never fall back to a default. Mirrors functions/src/calendarPreferences.ts's
// parseStoredCalendarPreferences check-by-check:
//   1. exact plain-object shape with exactly the six expected own keys
//   2. weekdays: non-empty, integers 0-6, strictly ascending (catches both duplicates and
//      out-of-order values — a stored document the server itself wrote is never re-sorted
//      here, only rejected if it isn't already canonical)
//   3. localTime: strict 24-hour HH:MM
//   4. timezone: byte-for-byte equal to what Intl.DateTimeFormat resolves it to (an alias
//      like 'US/Central' is a valid REQUEST value but not valid STORED state, since nothing
//      in the server's own write path would ever persist anything but the canonical form)
//   5. sessionDurationMinutes: integer in [MIN, MAX]
//   6. updatedAt: a genuine Timestamp instance
function parseStoredCalendarPreferencesDoc(data: unknown): { preferences: CalendarPreferences; revision: number } | null {
  if (!isPlainRecord(data)) return null;
  if (!hasExactOwnKeys(data, STORED_DOC_KEYS)) return null;
  if (!isValidExistingRevision(data.revision)) return null;

  const weekdays = data.weekdays;
  if (
    !Array.isArray(weekdays) ||
    weekdays.length === 0 ||
    !weekdays.every((d: unknown) => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    return null;
  }
  for (let i = 1; i < weekdays.length; i++) {
    if (weekdays[i] <= weekdays[i - 1]) return null; // catches both duplicates and non-ascending order
  }

  if (typeof data.localTime !== 'string' || !TIME_PATTERN.test(data.localTime)) return null;

  if (typeof data.timezone !== 'string' || data.timezone.length === 0) return null;
  let canonicalTimezone: string;
  try {
    canonicalTimezone = new Intl.DateTimeFormat('en-US', { timeZone: data.timezone }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  if (data.timezone !== canonicalTimezone) return null;

  if (
    typeof data.sessionDurationMinutes !== 'number' ||
    !Number.isInteger(data.sessionDurationMinutes) ||
    data.sessionDurationMinutes < MIN_SESSION_DURATION_MINUTES ||
    data.sessionDurationMinutes > MAX_SESSION_DURATION_MINUTES
  ) {
    return null;
  }

  if (!(data.updatedAt instanceof Timestamp)) return null;

  return {
    preferences: {
      weekdays: weekdays as number[],
      localTime: data.localTime,
      timezone: data.timezone,
      sessionDurationMinutes: data.sessionDurationMinutes,
    },
    revision: data.revision,
  };
}

function isConflictError(err: unknown): err is FunctionsError {
  return !!err && typeof err === 'object' && (err as FunctionsError).code === 'functions/aborted';
}

// Same friendly-mapping convention as useCalendarSubscriptions.ts's mapCalendarCallableError
// (duplicated per this project's established per-file convention, not imported) — without
// this, a callable failure whose target doesn't exist or whose transport fails surfaces as
// the raw, unhelpful FunctionsError message (e.g. the literal string "internal"). Validation
// failures (functions/invalid-argument) keep the server's own message, since
// calendarPreferences.ts's validators already produce specific, actionable, non-sensitive
// text (e.g. "localTime must be in strict 24-hour HH:MM format.").
function mapSaveCalendarPreferencesError(err: unknown): string {
  const code = err && typeof err === 'object' ? (err as FunctionsError).code : undefined;
  switch (code) {
    case 'functions/unauthenticated':
      return 'You need to be signed in to save calendar settings.';
    case 'functions/permission-denied':
      return 'Unable to save calendar settings for this account right now.';
    case 'functions/invalid-argument':
      return (err instanceof Error && err.message) || 'Please check your schedule settings and try again.';
    case 'functions/internal':
    case 'functions/unavailable':
      return 'A temporary server issue occurred. Please try again.';
    default:
      return 'Failed to save calendar settings. Please try again.';
  }
}

// Same watermark-aware reconciliation contract as useNotificationPreferences.ts's own
// reconcileIncoming — see that file's header for the full rationale (it applies unchanged
// here: a callable response can never overwrite already-observed listener content at the
// same revision, but the listener can always recover a readError/corrupt display).
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

export function useCalendarPreferences() {
  const [uid, setUid] = useState<string | null>(null);
  const uidRef = useRef<string | null>(null);
  uidRef.current = uid;

  const [displayed, setDisplayed] = useState<DisplayedState | null>(null);
  const displayedRef = useRef<DisplayedState | null>(null);
  const watermarkRef = useRef<number>(0);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [conflictToken, setConflictToken] = useState(0);
  const conflictUidRef = useRef<string | null>(null);
  const conflictTokenCounterRef = useRef(0);

  const applyIncoming = useCallback(
    (forUid: string, incoming: IncomingState, source: 'listener' | 'callable'): DisplayedState | null => {
      if (uidRef.current !== forUid) return displayedRef.current;
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

    displayedRef.current = null;
    setDisplayed(null);
    watermarkRef.current = 0;
    setConflictMessage(null);
    setConflictToken(0);
    conflictUidRef.current = null;

    if (!db || !uid) {
      return () => {
        cancelled = true;
      };
    }

    const ref = doc(db, 'artifacts', appId, 'users', uid, 'calendarPreferences', 'main');
    const unsubscribe = onSnapshot(
      ref,
      (snap) => {
        if (cancelled) return;
        let incoming: IncomingState;
        if (!snap.exists()) {
          incoming = { kind: 'ok', preferences: null, revision: 0 };
        } else {
          const parsed = parseStoredCalendarPreferencesDoc(snap.data());
          incoming = parsed
            ? { kind: 'ok', preferences: parsed.preferences, revision: parsed.revision }
            : { kind: 'corrupt' };
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

  const save = useCallback(async (next: CalendarPreferences): Promise<boolean> => {
    if (savingRef.current) return false;

    const currentUid = uidRef.current;
    const currentDisplayed = displayedRef.current;
    if (!currentUid) return false;
    if (!currentDisplayed || currentDisplayed.uid !== currentUid) return false;
    if (currentDisplayed.kind !== 'ok') return false;

    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const expectedRevision = currentDisplayed.revision;
      const updateFn = httpsCallable<CalendarPreferences & { expectedRevision: number }, StoredShape & { unchanged: boolean }>(
        getFunctions(),
        'updateCalendarPreferences'
      );
      const result = await updateFn({ ...next, expectedRevision });

      applyIncoming(
        currentUid,
        {
          kind: 'ok',
          preferences: {
            weekdays: result.data.weekdays,
            localTime: result.data.localTime,
            timezone: result.data.timezone,
            sessionDurationMinutes: result.data.sessionDurationMinutes,
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
                  weekdays: details.current.weekdays,
                  localTime: details.current.localTime,
                  timezone: details.current.timezone,
                  sessionDurationMinutes: details.current.sessionDurationMinutes,
                }
              : null,
            revision: typeof details.currentRevision === 'number' ? details.currentRevision : 0,
          };
          const resultState = applyIncoming(currentUid, conflictIncoming, 'callable');
          if (uidRef.current === currentUid && resultState && resultState.kind === 'ok') {
            conflictTokenCounterRef.current += 1;
            conflictUidRef.current = currentUid;
            setConflictToken(conflictTokenCounterRef.current);
            setConflictMessage('Your calendar schedule changed elsewhere. The latest settings have been loaded.');
          }
        }
        return false;
      }
      if (uidRef.current === currentUid) {
        setError(mapSaveCalendarPreferencesError(err));
      }
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [applyIncoming]);

  const current = displayed && displayed.uid === uid ? displayed : null;
  const exposedConflictMessage = conflictUidRef.current === uid ? conflictMessage : null;
  const exposedConflictToken = conflictUidRef.current === uid ? conflictToken : 0;

  return {
    uid,
    loaded: uid === null || current !== null,
    preferences: current && current.kind === 'ok' ? current.preferences : null,
    revision: current && current.kind === 'ok' ? current.revision : 0,
    readError: current?.kind === 'readError',
    corrupt: current?.kind === 'corrupt',
    defaultPreferences: DEFAULT_CALENDAR_PREFERENCES,
    saving,
    error,
    conflictMessage: exposedConflictMessage,
    conflictToken: exposedConflictToken,
    save,
  };
}
