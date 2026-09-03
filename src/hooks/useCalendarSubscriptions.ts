// src/hooks/useCalendarSubscriptions.ts
// Calendar Integration Phase 1 — frontend UI. Subscription LIFECYCLE only (create/list/
// revoke). Mirrors useCalendarPreferences.ts / useNotificationPreferences.ts's own
// established pattern for the read side (Firestore listener) and write side (httpsCallable).
//
// COMPONENT LIFETIME (Codex HIGH 1 repair): this hook is called ONLY from
// CalendarSettingsCard.tsx, which mounts/unmounts with the Calendar section of Settings
// (Settings itself is conditionally rendered by App.tsx, so it genuinely unmounts on
// navigation away). This hook must NEVER be called from App-lifetime code — doing so would
// keep `newlyCreated` (a one-time bearer credential) alive across Settings visits, which is
// exactly the bug this repair closes. Do not hoist this hook's call site back up to App().
//
// SYNCHRONOUS UID ISOLATION (Codex HIGH 2 repair): every piece of subscription state is
// held in ONE state object tagged with the uid that produced it (`SubscriptionsState.uid`).
// The value actually returned to the caller is computed at RENDER TIME via
// `exposed = state.uid === uid ? state : EMPTY_STATE(uid)` — never via a delayed effect.
// This closes the specific race Codex found: when `uid` changes (state update), React
// commits a render with the NEW `uid` value before the uid-change useEffect (which resets
// `state`) has had a chance to run — so for one render, `state` could still be tagged with
// the OLD uid while `uid` itself already reads as the new one. Filtering at render time
// means that render already returns the empty/default value for the new uid, regardless of
// when the reset effect actually fires. The effect below still exists — it's what makes the
// listener re-subscribe for the new uid and frees memory — but it is not what makes cross-
// uid exposure impossible; the render-time filter is.
//
// ASYNC RESULT DISCARD (Codex Section 3 repair): create()/revoke() capture the uid the
// request was made under (`requestUid`) before awaiting. The instant the callable resolves,
// and BEFORE any setState, `uidRef.current !== requestUid` is checked — if the authoritative
// uid has moved on, the response (including any returned secret) is discarded without ever
// entering React state and without ever being logged. This is a same-tick synchronous check
// (nothing else can run between the await resolving and this check), so it is not merely
// "eventual" — no interleaving window exists in which a stale response could be committed.
//
// SECRET HANDLING: the raw bearer secret returned by createCalendarSubscription is a
// credential — see functions/src/calendarSubscriptions.ts's own header: it is returned
// exactly once and never persisted anywhere server-side. This hook honors that same
// semantic on the client: the secret lives ONLY in this hook's in-memory state, is never
// written to localStorage/sessionStorage, is never logged via console.*, and is cleared by
// (a) explicit dismissal, (b) revoking that same subscription, (c) the uid changing
// (render-time filter, not just the reset effect), and (d) this hook's owning component
// unmounting (all React state is simply destroyed — see the COMPONENT LIFETIME note above).
import { useCallback, useEffect, useRef, useState } from 'react';
import { onIdTokenChanged, type User } from 'firebase/auth';
import { collection, onSnapshot, query, where, Timestamp } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { auth, db, appId } from '../services/firebase';

export type CalendarSubscriptionSummary = {
  subscriptionId: string;
  label: string | null;
  createdAtMs: number | null;
};

export type NewCalendarSubscription = {
  subscriptionId: string;
  secret: string;
  label: string | null;
};

type CreateResponse = { subscriptionId: string; secret: string; label: string | null };
type RevokeResponse = { revoked: true };

const MAX_LABEL_LENGTH = 60;
export { MAX_LABEL_LENGTH };

// Every field here is owned by `uid` — nothing in this object is ever meaningful except in
// combination with the `uid` it was tagged with at write time.
type SubscriptionsState = {
  uid: string;
  subscriptions: CalendarSubscriptionSummary[];
  listLoaded: boolean;
  listError: boolean;
  creating: boolean;
  createError: string | null;
  newlyCreated: NewCalendarSubscription | null;
  revokingId: string | null;
  revokeError: string | null;
};

function emptyState(uid: string): SubscriptionsState {
  return {
    uid,
    subscriptions: [],
    listLoaded: false,
    listError: false,
    creating: false,
    createError: null,
    newlyCreated: null,
    revokingId: null,
    revokeError: null,
  };
}

export function useCalendarSubscriptions() {
  const [uid, setUid] = useState<string | null>(null);
  const uidRef = useRef<string | null>(null);
  uidRef.current = uid;

  const [state, setState] = useState<SubscriptionsState>(emptyState(''));
  const creatingRef = useRef(false);
  const revokingRef = useRef<string | null>(null);

  useEffect(() => {
    if (!auth) return;
    return onIdTokenChanged(auth, (user: User | null) => {
      setUid(user && !user.isAnonymous ? user.uid : null);
    });
  }, []);

  // Re-subscribes the Firestore listener for the new uid and frees the old listener. This
  // effect is what makes the data eventually correct; it is NOT what makes cross-uid
  // rendering impossible — see the render-time filter in the return statement below, which
  // is the actual safety property and holds even during the one render (if any) before this
  // effect has run.
  useEffect(() => {
    setState(emptyState(uid ?? ''));
    creatingRef.current = false;
    revokingRef.current = null;

    let cancelled = false;

    if (!db || !uid) {
      return () => {
        cancelled = true;
      };
    }

    const col = collection(db, 'artifacts', appId, 'users', uid, 'calendarSubscriptions');
    const activeQuery = query(col, where('revokedAt', '==', null));
    const unsubscribe = onSnapshot(
      activeQuery,
      (snap) => {
        if (cancelled || uidRef.current !== uid) return;
        const next: CalendarSubscriptionSummary[] = snap.docs.map((d) => {
          const data = d.data();
          const label = typeof data.label === 'string' ? data.label : null;
          const createdAtMs = data.createdAt instanceof Timestamp ? data.createdAt.toMillis() : null;
          return { subscriptionId: d.id, label, createdAtMs };
        });
        next.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
        setState((prev) =>
          prev.uid === uid ? { ...prev, subscriptions: next, listLoaded: true, listError: false } : prev
        );
      },
      () => {
        if (cancelled || uidRef.current !== uid) return;
        setState((prev) => (prev.uid === uid ? { ...prev, listLoaded: true, listError: true } : prev));
      }
    );

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [uid]);

  const create = useCallback(async (labelInput: string): Promise<boolean> => {
    if (creatingRef.current) return false;
    const requestUid = uidRef.current;
    if (!requestUid) return false;

    creatingRef.current = true;
    setState((prev) => (prev.uid === requestUid ? { ...prev, creating: true, createError: null } : prev));
    try {
      const trimmed = labelInput.trim();
      const label = trimmed.length > 0 ? trimmed : undefined;
      const createFn = httpsCallable<{ label?: string }, CreateResponse>(getFunctions(), 'createCalendarSubscription');
      const result = await createFn(label !== undefined ? { label } : {});
      // Same-tick discard: if the authoritative uid has moved on since this request began,
      // the response — including the raw secret — is dropped here, before it ever reaches
      // React state, and is never logged.
      if (uidRef.current !== requestUid) return false;
      setState((prev) =>
        prev.uid === requestUid
          ? {
              ...prev,
              newlyCreated: {
                subscriptionId: result.data.subscriptionId,
                secret: result.data.secret,
                label: result.data.label,
              },
            }
          : prev
      );
      return true;
    } catch (err) {
      if (uidRef.current !== requestUid) return false;
      const message = mapCalendarCallableError(err, 'create');
      setState((prev) => (prev.uid === requestUid ? { ...prev, createError: message } : prev));
      return false;
    } finally {
      creatingRef.current = false;
      setState((prev) => (prev.uid === requestUid ? { ...prev, creating: false } : prev));
    }
  }, []);

  const revoke = useCallback(async (subscriptionId: string): Promise<boolean> => {
    if (revokingRef.current) return false;
    const requestUid = uidRef.current;
    if (!requestUid) return false;

    revokingRef.current = subscriptionId;
    setState((prev) => (prev.uid === requestUid ? { ...prev, revokingId: subscriptionId, revokeError: null } : prev));
    try {
      const revokeFn = httpsCallable<{ subscriptionId: string }, RevokeResponse>(getFunctions(), 'revokeCalendarSubscription');
      await revokeFn({ subscriptionId });
      if (uidRef.current !== requestUid) return false;
      // If the just-revoked subscription is the one whose secret is still showing, clear
      // it — a revoked credential's URL is no longer valid and must not linger on screen
      // implying it still works.
      setState((prev) =>
        prev.uid === requestUid
          ? { ...prev, newlyCreated: prev.newlyCreated?.subscriptionId === subscriptionId ? null : prev.newlyCreated }
          : prev
      );
      return true;
    } catch (err) {
      if (uidRef.current !== requestUid) return false;
      const message = mapCalendarCallableError(err, 'revoke');
      setState((prev) => (prev.uid === requestUid ? { ...prev, revokeError: message } : prev));
      return false;
    } finally {
      if (revokingRef.current === subscriptionId) revokingRef.current = null;
      setState((prev) => (prev.uid === requestUid ? { ...prev, revokingId: null } : prev));
    }
  }, []);

  // User-initiated dismissal of the just-created secret (e.g. after copying it) — the only
  // other path (besides uid change/unmount/revoke) that ever clears it.
  const dismissNewlyCreated = useCallback(() => {
    const requestUid = uidRef.current;
    if (!requestUid) return;
    setState((prev) => (prev.uid === requestUid ? { ...prev, newlyCreated: null } : prev));
  }, []);

  // THE RENDER-TIME OWNERSHIP GUARD (Codex HIGH 2's actual required fix): `state` may
  // transiently still carry a previous uid's data for one render if the reset effect above
  // hasn't run yet. `exposed` recomputes on every render from the CURRENT `uid` and never
  // returns `state` unless it's tagged with that exact uid — so this component tree can
  // never observe another uid's subscriptions or newlyCreated secret, in any render, at any
  // point, regardless of effect scheduling.
  const exposed = state.uid === (uid ?? '') ? state : emptyState(uid ?? '');

  return {
    uid,
    subscriptions: exposed.subscriptions,
    listLoaded: exposed.listLoaded,
    listError: exposed.listError,
    creating: exposed.creating,
    createError: exposed.createError,
    newlyCreated: exposed.newlyCreated,
    create,
    dismissNewlyCreated,
    revokingId: exposed.revokingId,
    revokeError: exposed.revokeError,
    revoke,
  };
}

type CallableErrorLike = { code?: string; message?: string };

function mapCalendarCallableError(err: unknown, action: 'create' | 'revoke'): string {
  const e = err as CallableErrorLike | undefined;
  const code = e && typeof e === 'object' ? e.code : undefined;
  switch (code) {
    case 'functions/unauthenticated':
      return 'You need to be signed in to manage calendar subscriptions.';
    case 'functions/resource-exhausted':
      return e?.message || 'You have reached the maximum number of active calendar subscriptions.';
    case 'functions/invalid-argument':
      return action === 'create'
        ? 'That label isn’t valid. Try a shorter one.'
        : 'That subscription couldn’t be identified.';
    case 'functions/permission-denied':
      return 'Unable to create a calendar subscription for this account right now.';
    case 'functions/internal':
    case 'functions/unavailable':
      return 'A temporary server issue occurred. Please try again.';
    default:
      return action === 'create'
        ? 'Failed to create calendar subscription. Please try again.'
        : 'Failed to revoke calendar subscription. Please try again.';
  }
}
