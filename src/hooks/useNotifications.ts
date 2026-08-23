// src/hooks/useNotifications.ts
// Phase 3A-1 (seventh Codex-review repair): device registration only — no send-side code
// anywhere in this file. This hook NEVER writes push-ownership data to Firestore directly —
// it only calls the trusted callables in functions/src/pushInstallations.ts. Ownership
// correctness is enforced entirely server-side via a lease/generation/transfer/recovery
// protocol; nothing in this file needs to — or can — guarantee it. The client-side
// "operation generation" tracking below (opGenerationRef) and the account-switch mutex
// (switchBusyRef) are UX/correctness/concurrency mechanisms, NOT security mechanisms.
//
// This round REMOVED a diagnostic callable (getPushInstallationStatus) and a
// credentialless-abandonment callable that used to run when initialize hit an existing
// record this device had no credential for. Both were correctly rejected: even though
// abandonment never granted the caller ownership, it still authorized a real mutation
// (state/token/credential/quota) based on nothing but installationId + elapsed time — a
// genuine violation of "installationId alone must never authorize mutation of a record that
// already exists."
//
// A LATER round of this file replaced that with automatically generating a fresh,
// independent installationId whenever a dead end was hit — reasoning that since this device
// never touches the existing record X, "X was not mutated" was satisfied. That reasoning
// was incomplete: it protected installationId uniqueness but not FCM TOKEN/push-endpoint
// uniqueness. getToken() on the same physical browser/device commonly returns the SAME
// token regardless of which local installationId is asking for it — so blindly registering
// a fresh Y with that same token could let two DIFFERENT installation documents both reach
// state=='active' holding the identical token (and, if a different uid is involved, deliver
// to the wrong account once a sender exists). This is now prevented at its actual source —
// server-side token-claim uniqueness, enforced inside registerPushInstallation (see
// functions/src/pushInstallations.ts's TOKEN UNIQUENESS note) — but the automatic fresh-id
// fallback here was ALSO removed regardless, since "not mutating X" was never the complete
// safety property to begin with. When this device holds no credential for an existing X, it
// now simply fails closed: no new installation is created, no fallback identity is
// attempted, notifications may become temporarily unavailable on this specific browser until
// some future recovery path exists. Security/privacy over automatic recovery.
//
// Notification.requestPermission() is called from exactly one place (enable()), itself only
// ever wired to an explicit user-tap button — never invoked on mount/automatically.
import { useCallback, useEffect, useRef, useState } from 'react';
import { onIdTokenChanged, type User } from 'firebase/auth';
import { getFunctions, httpsCallable, type FunctionsError } from 'firebase/functions';
import { getToken as getFcmToken, deleteToken as deleteFcmToken } from 'firebase/messaging';
import { auth, getMessagingIfSupported } from '../services/firebase';
import { useInstallPrompt } from './useInstallPrompt';

export type NotificationStatus =
  | 'unsupported'
  | 'ios-not-installed'
  | 'default'
  | 'denied'
  | 'registering'
  | 'registered'
  | 'error';

const SW_PATH = '/firebase-messaging-sw.js';
const INSTALLATION_ID_KEY = 'na_push_installation_id';
const LEASE_KEY = 'na_push_lease';
const PENDING_TRANSFER_KEY = 'na_push_pending_transfer';
const RECOVERY_KEY = 'na_push_recovery';
const PENDING_REVOCATION_KEY = 'na_push_pending_revocation';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX32_PATTERN = /^[0-9a-f]{32}$/i;

function isValidInstallationId(value: string): boolean {
  return UUID_V4_PATTERN.test(value) || HEX32_PATTERN.test(value);
}

function generateInstallationId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

type LeaseRecord = { uid: string; lease: string };
type PendingTransfer = { installationId: string; transferCredential: string; originatingUid: string };
type RecoveryRecord = { installationId: string; recoveryCredential: string };
type PendingRevocation = { installationId: string; uid: string; lease: string };

function readJSON<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJSON(key: string, value: unknown): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function functionsErrorCode(err: unknown): string | undefined {
  return err && typeof err === 'object' ? (err as FunctionsError).code : undefined;
}

function functionsErrorMessage(err: unknown): string {
  return err && typeof err === 'object' && typeof (err as FunctionsError).message === 'string'
    ? (err as FunctionsError).message
    : '';
}

function isFunctionsErrorCode(err: unknown, code: string): boolean {
  return functionsErrorCode(err) === `functions/${code}`;
}

// The server's requireCredential() bakes the credential's label into its invalid-argument
// message text specifically so this can distinguish "the LEASE/credential shape itself is
// malformed" from "the TOKEN is bad" — both currently share the same invalid-argument code,
// but they demand opposite client reactions (see isTokenValidationError below).
function isCredentialShapeError(err: unknown): boolean {
  if (!isFunctionsErrorCode(err, 'invalid-argument')) return false;
  const message = functionsErrorMessage(err);
  return message.includes('Invalid lease') || message.includes('Invalid transfer credential') || message.includes('Invalid recovery credential');
}

// A bad/expired FCM token is never a reason to destroy an ownership credential (lease/
// transfer/recovery) — the fix is simply to re-acquire a token via getToken() on the next
// attempt, which every call site here already does fresh each time rather than reusing a
// cached value.
function isTokenValidationError(err: unknown): boolean {
  if (!isFunctionsErrorCode(err, 'invalid-argument')) return false;
  const message = functionsErrorMessage(err);
  return message.includes('device token');
}

// The token this device presented is already claimed by a DIFFERENT installation (server-
// side token-claim uniqueness — see functions/src/pushInstallations.ts). This is also never
// a reason to destroy the lease: the lease and uid checks already passed by the time this
// fires, so the credential is fine — the problem is specifically that this exact push
// endpoint is currently spoken for elsewhere. Clearing the lease here would be actively
// wrong (it's valid) as well as pointless (the conflict is about the token, not the lease).
function isTokenClaimConflictError(err: unknown): boolean {
  if (!isFunctionsErrorCode(err, 'failed-precondition')) return false;
  return functionsErrorMessage(err).includes('already claimed by another registration');
}

// A credential/transfer/revocation call failing this way means the credential itself is
// genuinely dead — invalid/malformed (isCredentialShapeError), rejected as wrong/rotated
// (permission-denied), or the operation it targets has already reached a different terminal
// state (failed-precondition — already consumed, already resolved). Nothing further this
// device does with the SAME credential can ever succeed, so it's safe (and necessary, to
// avoid retrying forever) to discard it. Two problem types are explicitly excluded, because
// neither means the credential itself is at fault: a token-shape problem (isTokenValidationError
// — the fix is re-acquiring a token, not touching the credential) and a token-claim conflict
// (isTokenClaimConflictError — the lease/uid were already validated by the time this can
// fire; the problem is that this exact push endpoint is claimed elsewhere, not that the
// credential is wrong). Anything else — unavailable, deadline-exceeded, internal, a bare
// network failure with no code at all, or any other transient condition — is treated as
// retryable: the credential is the only recovery capability this device has, so a network
// hiccup must never destroy it.
function isTerminalCredentialError(err: unknown): boolean {
  if (isTokenValidationError(err) || isTokenClaimConflictError(err)) return false;
  return (
    isFunctionsErrorCode(err, 'permission-denied') ||
    isFunctionsErrorCode(err, 'failed-precondition') ||
    isCredentialShapeError(err)
  );
}

// Resolves the stable per-browser-installation identifier. Never an in-memory-only fallback.
// A malformed stored value is replaced only when NOTHING local could be orphaned by doing
// so: a lease, a pending transfer, a pending recovery credential, or a pending revocation
// all imply some real server-side record exists for the old id that this browser would
// permanently lose the ability to manage if a fresh id were generated instead.
function resolveInstallationId(): string | null {
  try {
    const existing = window.localStorage.getItem(INSTALLATION_ID_KEY);
    if (existing && isValidInstallationId(existing)) return existing;
    if (existing) {
      const hasManagedState =
        readJSON<LeaseRecord>(LEASE_KEY) !== null ||
        readJSON<PendingTransfer>(PENDING_TRANSFER_KEY) !== null ||
        readJSON<RecoveryRecord>(RECOVERY_KEY) !== null ||
        readJSON<PendingRevocation>(PENDING_REVOCATION_KEY) !== null;
      if (hasManagedState) return null;
    }
    const fresh = generateInstallationId();
    window.localStorage.setItem(INSTALLATION_ID_KEY, fresh);
    return fresh;
  } catch {
    return null;
  }
}

type InitResult = { lease: string };
type RegisterResult = { accepted: boolean };
type RevokeResult = { ok: boolean; recoveryCredential: string | null };
type PrepareTransferResult = { transferCredential: string };
type ClaimTransferResult = { lease: string };
type CancelTransferResult = { lease: string };
type ReclaimResult = { lease: string };

function callable<Req, Res>(name: string) {
  return httpsCallable<Req, Res>(getFunctions(), name);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useNotifications() {
  const { platform, isStandalone } = useInstallPrompt();
  const [status, setStatus] = useState<NotificationStatus>('default');
  const [error, setError] = useState<string | null>(null);
  const [uid, setUid] = useState<string | null>(null);

  const installationIdRef = useRef<string | null>(resolveInstallationId());
  const swRegistrationRef = useRef<ServiceWorkerRegistration | null>(null);

  const opGenerationRef = useRef(0);
  const beginOp = useCallback(() => ++opGenerationRef.current, []);
  const isStale = useCallback((myGen: number) => myGen !== opGenerationRef.current, []);

  // Account-switch mutex (UX/concurrency only — see file header).
  const switchBusyRef = useRef(false);
  const isAccountSwitchBusy = useCallback((): boolean => {
    return switchBusyRef.current || readJSON<PendingTransfer>(PENDING_TRANSFER_KEY) !== null;
  }, []);

  const iosNotInstalled = platform === 'ios' && !isStandalone;
  const baseUnsupported =
    typeof window === 'undefined' ||
    !('Notification' in window) ||
    !('serviceWorker' in navigator) ||
    installationIdRef.current === null;

  // onIdTokenChanged, not onAuthStateChanged: reliably observes the isAnonymous flip after
  // anonymous -> permanent linking, which preserves uid and can otherwise go unnoticed.
  useEffect(() => {
    if (!auth) return;
    return onIdTokenChanged(auth, (user: User | null) => {
      setUid(user && !user.isAnonymous ? user.uid : null);
    });
  }, []);

  const persistLease = useCallback((forUid: string, lease: string) => {
    return writeJSON(LEASE_KEY, { uid: forUid, lease } satisfies LeaseRecord);
  }, []);

  const currentLeaseFor = useCallback((forUid: string): string | null => {
    const record = readJSON<LeaseRecord>(LEASE_KEY);
    return record && record.uid === forUid ? record.lease : null;
  }, []);

  const ensureMessagingReady = useCallback(async (): Promise<
    | { ok: true; messaging: NonNullable<Awaited<ReturnType<typeof getMessagingIfSupported>>>; vapidKey: string }
    | { ok: false; status: NotificationStatus; error: string | null }
  > => {
    const messaging = await getMessagingIfSupported();
    if (!messaging) return { ok: false, status: 'unsupported', error: null };
    const vapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;
    if (!vapidKey) {
      return { ok: false, status: 'error', error: 'Notifications are not configured yet (missing VAPID key).' };
    }
    if (!swRegistrationRef.current) {
      swRegistrationRef.current = await navigator.serviceWorker.register(SW_PATH);
    }
    return { ok: true, messaging, vapidKey };
  }, []);

  const getFreshToken = useCallback(
    async (vapidKey: string, messaging: NonNullable<Awaited<ReturnType<typeof getMessagingIfSupported>>>) => {
      return getFcmToken(messaging, { vapidKey, serviceWorkerRegistration: swRegistrationRef.current! });
    },
    []
  );

  // Persists a freshly-issued lease, then IMMEDIATELY confirms it via registerPushInstallation
  // (which accepts the server's 'activation-pending' starting state and promotes it to
  // 'active' on success). If the local persist itself fails, this function does NOT call the
  // confirming register — the server-side record simply stays 'activation-pending' — and
  // returns false either way a confirmation didn't happen. Deliberately does not attempt to
  // classify a confirm failure here: whether it was transient or not, the record stays
  // exactly where it is (activation-pending, harmless), and the next normal startup
  // reconfirmation (see the main effect below) will simply try again with the SAME lease,
  // since it was already durably saved.
  const persistAndConfirmLease = useCallback(
    async (forUid: string, lease: string, token: string): Promise<boolean> => {
      const installationId = installationIdRef.current;
      if (!installationId) return false;
      const persisted = persistLease(forUid, lease);
      if (!persisted) {
        console.error(
          '[Notifications] server issued a new lease, but it could not be persisted locally — ' +
            'this installation will remain unconfirmed (activation-pending) rather than becoming a ' +
            'future send target this browser cannot manage.'
        );
        return false;
      }
      try {
        await callable<
          { installationId: string; lease: string; token: string; platform: string },
          RegisterResult
        >('registerPushInstallation')({ installationId, lease, token, platform });
        return true;
      } catch (err) {
        console.warn('[Notifications] confirm-after-issue failed; will retry on next reconfirm:', err);
        return false;
      }
    },
    [persistLease, platform]
  );

  // Registers this device under the current uid — called on EVERY startup/reload/uid
  // observation where permission is granted, not merely when no local lease is known yet
  // (see the main effect below). This is deliberate: a lease's mere local presence is never
  // treated as proof the server considers the record active, and this is also how ordinary
  // FCM token rotation gets discovered (a rotated token is otherwise invisible to the server
  // until some call happens to carry it). Tries, in order: (1) an existing lease for this
  // uid, via registerPushInstallation (confirms AND refreshes token/platform in one call);
  // (2) a pending recovery credential for this installationId, via reclaimPushInstallation;
  // (3) initializePushInstallation, for a genuinely never-before-seen id.
  const register = useCallback(async () => {
    const myGen = beginOp();
    const installationId = installationIdRef.current;
    if (!uid || !installationId) {
      if (!isStale(myGen)) {
        setError(!uid ? 'Sign in required before enabling notifications.' : 'This device cannot register for notifications.');
        setStatus('error');
      }
      return;
    }
    if (!isStale(myGen)) {
      setStatus('registering');
      setError(null);
    }
    try {
      const ready = await ensureMessagingReady();
      if (isStale(myGen)) return;
      if (!ready.ok) {
        setStatus(ready.status);
        if (ready.error) setError(ready.error);
        return;
      }
      const token = await getFreshToken(ready.vapidKey, ready.messaging);
      if (isStale(myGen)) return;
      if (!token) {
        setError('Could not get a notification token for this device.');
        setStatus('error');
        return;
      }

      const existingLease = currentLeaseFor(uid);
      if (existingLease) {
        try {
          await callable<
            { installationId: string; lease: string; token: string; platform: string },
            RegisterResult
          >('registerPushInstallation')({ installationId, lease: existingLease, token, platform });
          if (isStale(myGen)) return;
          setStatus('registered');
        } catch (err) {
          if (isStale(myGen)) return;
          if (isTerminalCredentialError(err)) {
            // The lease is dead for us specifically — clear our own local pointer. This does
            // NOT mutate or abandon anything server-side; whether the server's copy of X can
            // later be safely replaced is decided separately (and only with server
            // confirmation) by attemptFreshIdentityAfterDeadEnd, never assumed here.
            console.warn('[Notifications] stale/invalid lease for this uid, clearing local copy:', err);
            writeJSON(LEASE_KEY, null);
            setError('Notifications need to be re-enabled on this device.');
          } else {
            // Retryable (including a token-shape problem, which never touches the lease) —
            // preserve the lease, let the next reconfirm retry it with a fresh token.
            setError('Notifications could not be enabled — please try again.');
          }
          setStatus('error');
        }
        return;
      }

      const recovery = readJSON<RecoveryRecord>(RECOVERY_KEY);
      if (recovery && recovery.installationId === installationId) {
        try {
          const result = await callable<
            { installationId: string; recoveryCredential: string; token: string; platform: string },
            ReclaimResult
          >('reclaimPushInstallation')({
            installationId,
            recoveryCredential: recovery.recoveryCredential,
            token,
            platform,
          });
          if (isStale(myGen)) return;
          writeJSON(RECOVERY_KEY, null);
          const confirmed = await persistAndConfirmLease(uid, result.data.lease, token);
          if (isStale(myGen)) return;
          if (!confirmed) {
            setError('Notifications could not be fully enabled on this device — please try again.');
            setStatus('error');
            return;
          }
          setStatus('registered');
          return;
        } catch (err) {
          if (!isTerminalCredentialError(err)) {
            // Retryable (including a token-shape problem) — the recovery credential is this
            // device's only path back to that installation; preserve it rather than falling
            // through to initialize, which could otherwise abandon a still-recoverable
            // installation on a mere network blip.
            if (!isStale(myGen)) {
              setError('Notifications could not be enabled — please try again.');
              setStatus('error');
            }
            return;
          }
          console.warn('[Notifications] recovery credential rejected, clearing:', err);
          writeJSON(RECOVERY_KEY, null);
        }
      }

      try {
        const result = await callable<
          { installationId: string; token: string; platform: string },
          InitResult
        >('initializePushInstallation')({ installationId, token, platform });
        if (isStale(myGen)) return;
        const confirmed = await persistAndConfirmLease(uid, result.data.lease, token);
        if (isStale(myGen)) return;
        if (!confirmed) {
          setError('Notifications could not be fully enabled on this device — please try again.');
          setStatus('error');
          return;
        }
        setStatus('registered');
      } catch (err) {
        if (!isFunctionsErrorCode(err, 'failed-precondition')) throw err;
        // installationId X already exists server-side and this device holds no credential
        // for it (lease and recovery were both already checked above). FAIL CLOSED here —
        // do NOT generate a fresh installationId. A prior version of this file did exactly
        // that, reasoning that never touching X's document made it safe; that reasoning was
        // incomplete, since X and a fresh Y could still end up sharing the same underlying
        // FCM token (getToken() commonly returns the same value for the same browser
        // regardless of which local installationId asks), producing two active
        // registrations for one push endpoint — duplicate or, if a different uid is
        // involved, cross-account delivery once a sender exists. Server-side token-claim
        // uniqueness (see functions/src/pushInstallations.ts) now also independently blocks
        // that specific outcome, but the automatic fallback itself is still removed: "did
        // not mutate X" was never the complete safety property. installationIdRef and
        // INSTALLATION_ID_KEY are deliberately left untouched — X's id is preserved locally
        // exactly as it was, in case a future recovery path can use it.
        setError(
          'Notifications could not be enabled on this device right now. This may resolve later — please try again.'
        );
        setStatus('error');
      }
    } catch (err) {
      console.error('[Notifications] registration failed:', err);
      if (!isStale(myGen)) {
        setError('Something went wrong enabling notifications. Please try again.');
        setStatus('error');
      }
    }
  }, [uid, platform, beginOp, isStale, currentLeaseFor, persistAndConfirmLease, ensureMessagingReady, getFreshToken]);

  // Reconciles a pending account-switch transfer. Error classification matters here:
  // terminal failures (invalid/consumed credential) clear the pending record, since retrying
  // with the same credential could never succeed; anything else (network, unavailable,
  // token-shape, etc.) PRESERVES it — the transfer credential is this device's only path to
  // finishing the switch, and a transient failure must never destroy it.
  const reconcilePendingTransfer = useCallback(
    async (pending: PendingTransfer, currentUid: string | null) => {
      const myGen = beginOp();
      if (!currentUid) return;
      if (!isStale(myGen)) {
        setStatus('registering');
        setError(null);
      }

      const ready = await ensureMessagingReady();
      if (isStale(myGen)) return;
      if (!ready.ok) {
        setStatus(ready.status);
        if (ready.error) setError(ready.error);
        return;
      }
      const token = await getFreshToken(ready.vapidKey, ready.messaging);
      if (isStale(myGen)) return;
      if (!token) {
        setError('Could not get a notification token for this device.');
        setStatus('error');
        return;
      }

      try {
        const lease =
          currentUid === pending.originatingUid
            ? (
                await callable<
                  { installationId: string; transferCredential: string },
                  CancelTransferResult
                >('cancelPushInstallationTransfer')({
                  installationId: pending.installationId,
                  transferCredential: pending.transferCredential,
                })
              ).data.lease
            : (
                await callable<
                  { installationId: string; transferCredential: string; token: string; platform: string },
                  ClaimTransferResult
                >('claimPushInstallationTransfer')({
                  installationId: pending.installationId,
                  transferCredential: pending.transferCredential,
                  token,
                  platform,
                })
              ).data.lease;
        if (isStale(myGen)) return;

        const confirmed = await persistAndConfirmLease(currentUid, lease, token);
        if (isStale(myGen)) return;
        if (!confirmed) {
          setError('Notifications could not be fully enabled on this device — please try again.');
          setStatus('error');
          return;
        }
        writeJSON(PENDING_TRANSFER_KEY, null);
        switchBusyRef.current = false;
        setStatus('registered');
      } catch (err) {
        if (!isTerminalCredentialError(err)) {
          if (!isStale(myGen)) {
            setError('Finishing that account change is taking longer than expected — please try again shortly.');
            setStatus('error');
          }
          return;
        }
        console.warn('[Notifications] pending transfer reconciliation terminally failed, clearing:', err);
        writeJSON(PENDING_TRANSFER_KEY, null);
        switchBusyRef.current = false;
        if (!isStale(myGen)) {
          setError('Notifications need to be re-enabled after that account change.');
          setStatus('error');
        }
      }
    },
    [platform, beginOp, isStale, persistAndConfirmLease, ensureMessagingReady, getFreshToken]
  );

  const retryPendingRevocation = useCallback(async (pending: PendingRevocation) => {
    try {
      const result = await callable<
        { installationId: string; lease: string },
        RevokeResult
      >('revokePushInstallation')({ installationId: pending.installationId, lease: pending.lease });
      writeJSON(PENDING_REVOCATION_KEY, null);
      if (result.data.recoveryCredential) {
        writeJSON(RECOVERY_KEY, {
          installationId: pending.installationId,
          recoveryCredential: result.data.recoveryCredential,
        } satisfies RecoveryRecord);
      }
    } catch (err) {
      if (isTerminalCredentialError(err)) {
        console.warn('[Notifications] pending revocation terminally failed, clearing:', err);
        writeJSON(PENDING_REVOCATION_KEY, null);
        return;
      }
      console.warn('[Notifications] retrying pending revocation still failing (non-fatal):', err);
    }
  }, []);

  const enable = useCallback(async () => {
    if (baseUnsupported || iosNotInstalled) return;
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        await register();
      } else if (permission === 'denied') {
        setStatus('denied');
      } else {
        setStatus('default');
      }
    } catch (err) {
      console.error('[Notifications] permission request failed:', err);
      setError('Something went wrong requesting permission.');
      setStatus('error');
    }
  }, [baseUnsupported, iosNotInstalled, register]);

  // Step 1 of an account switch. Returns:
  //  - 'not-applicable': nothing registered on this device for the current uid — proceed
  //    normally, with no notification-related blocking at all.
  //  - 'ok': prepared AND durably persisted; the auth switch may proceed.
  //  - 'blocked': either prepare itself failed, or it succeeded server-side but this device
  //    could not durably persist the resulting transfer credential — in the latter case,
  //    persistence is retried a few times (the credential is the ONLY copy in existence
  //    until it's durably saved or the transfer reaches a terminal server state — it must
  //    not be given up on after a single transient localStorage hiccup), and only if all
  //    retries fail is an immediate best-effort cancel attempted (also retried), using the
  //    credential still held in this call stack, to restore A rather than leave the
  //    server-side record stranded transfer-pending. Either way, the caller MUST NOT proceed
  //    with the auth switch; A stays authenticated throughout — nothing here ever touches
  //    Firebase Auth. If even the retried cancel fails, the credential is genuinely lost from
  //    this call stack and X remains transfer-pending indefinitely — a narrow, explicitly
  //    logged residual limitation (see the implementation report) — but the switch is still
  //    correctly blocked, never silently treated as resolved.
  const prepareForAccountSwitch = useCallback(async (): Promise<'ok' | 'blocked' | 'not-applicable'> => {
    const installationId = installationIdRef.current;
    const currentUid = auth?.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : null;
    if (!installationId || !currentUid) return 'not-applicable';
    const lease = currentLeaseFor(currentUid);
    if (!lease) return 'not-applicable';

    switchBusyRef.current = true;

    let transferCredential: string;
    try {
      const result = await callable<
        { installationId: string; lease: string },
        PrepareTransferResult
      >('preparePushInstallationTransfer')({ installationId, lease });
      transferCredential = result.data.transferCredential;
    } catch (err) {
      console.error('[Notifications] could not prepare account-switch transfer:', err);
      switchBusyRef.current = false;
      return 'blocked';
    }

    const pendingRecord = { installationId, transferCredential, originatingUid: currentUid } satisfies PendingTransfer;
    let persisted = writeJSON(PENDING_TRANSFER_KEY, pendingRecord);
    if (!persisted) {
      // The credential's only copy right now is this local variable — try harder before
      // resorting to cancellation, in case the first failure was a momentary blip.
      for (const delay of [50, 150]) {
        await sleep(delay);
        persisted = writeJSON(PENDING_TRANSFER_KEY, pendingRecord);
        if (persisted) break;
      }
    }

    if (persisted) {
      writeJSON(LEASE_KEY, null);
      return 'ok';
    }

    console.error(
      '[Notifications] transfer credential could not be persisted locally after retries; attempting immediate cancellation to restore this device.'
    );
    for (const delay of [0, 300, 800]) {
      if (delay) await sleep(delay);
      try {
        const cancelResult = await callable<
          { installationId: string; transferCredential: string },
          CancelTransferResult
        >('cancelPushInstallationTransfer')({ installationId, transferCredential });
        const ready = await ensureMessagingReady();
        if (ready.ok) {
          const token = await getFreshToken(ready.vapidKey, ready.messaging);
          if (token) await persistAndConfirmLease(currentUid, cancelResult.data.lease, token);
        }
        switchBusyRef.current = false;
        return 'blocked';
      } catch {
        // try the next backoff step, if any
      }
    }
    // The server-side record is still sitting transfer-pending with a credential this device
    // could neither durably store nor use to cancel — genuinely lost from this call stack.
    // installationId alone still cannot claim or cancel it (see the security invariants in
    // the implementation report), so this remains safe, just permanently unresolved from
    // this device until some future maintenance process addresses it.
    console.error(
      '[Notifications] transfer credential permanently lost after repeated persistence and cancellation failures; ' +
        'this installation will remain transfer-pending indefinitely, inert and unclaimable by anyone.'
    );
    switchBusyRef.current = false;
    return 'blocked';
  }, [currentLeaseFor, ensureMessagingReady, getFreshToken, persistAndConfirmLease]);

  const recoverFromFailedSwitch = useCallback(async () => {
    const pending = readJSON<PendingTransfer>(PENDING_TRANSFER_KEY);
    if (!pending) return;
    const currentUid = auth?.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : null;
    await reconcilePendingTransfer(pending, currentUid);
  }, [reconcilePendingTransfer]);

  const unregisterThisDevice = useCallback(async () => {
    const installationId = installationIdRef.current;
    const currentUid = auth?.currentUser && !auth.currentUser.isAnonymous ? auth.currentUser.uid : null;
    const lease = currentUid ? currentLeaseFor(currentUid) : null;

    if (installationId && currentUid && lease) {
      writeJSON(PENDING_REVOCATION_KEY, { installationId, uid: currentUid, lease } satisfies PendingRevocation);

      const backoffsMs = [0, 300, 800];
      let revoked = false;
      for (const delay of backoffsMs) {
        if (delay) await sleep(delay);
        try {
          const result = await callable<
            { installationId: string; lease: string },
            RevokeResult
          >('revokePushInstallation')({ installationId, lease });
          writeJSON(PENDING_REVOCATION_KEY, null);
          if (result.data.recoveryCredential) {
            const persisted = writeJSON(RECOVERY_KEY, {
              installationId,
              recoveryCredential: result.data.recoveryCredential,
            } satisfies RecoveryRecord);
            if (!persisted) {
              console.error(
                '[Notifications] server revoked this installation, but the recovery credential could not be ' +
                  'persisted locally — this device can no longer reclaim it. A fresh installation identity ' +
                  'will be used next time notifications are enabled here.'
              );
            }
          }
          revoked = true;
          break;
        } catch {
          // try the next backoff step, if any
        }
      }
      if (!revoked) {
        console.error(
          '[Notifications] could not revoke this device on logout after retries; proceeding with logout ' +
            'anyway. A pending-revocation record was saved locally for a future retry if this account ' +
            'signs back in on this device.'
        );
      }
      writeJSON(LEASE_KEY, null);
    }

    try {
      const messaging = await getMessagingIfSupported();
      if (messaging) await deleteFcmToken(messaging);
    } catch (err) {
      console.warn('[Notifications] deleteToken() failed (non-fatal):', err);
    }
  }, [currentLeaseFor]);

  // Derives the resting status on every relevant change, STRICTLY sequenced: a pending
  // revocation matching the current uid is resolved (or definitively fails to resolve)
  // BEFORE either transfer reconciliation or normal registration is even attempted in the
  // same pass. Note the fallthrough to register() at the end is NOT gated on "no local lease
  // known yet" — register() is always attempted whenever permission is granted and a uid is
  // known, specifically so it reconfirms/refreshes an already-active registration on every
  // startup rather than trusting local lease possession as proof of server state.
  useEffect(() => {
    if (baseUnsupported) {
      setStatus('unsupported');
      return;
    }
    if (iosNotInstalled) {
      setStatus('ios-not-installed');
      return;
    }

    let cancelled = false;

    (async () => {
      if (uid) {
        const pendingRevocation = readJSON<PendingRevocation>(PENDING_REVOCATION_KEY);
        if (pendingRevocation && pendingRevocation.uid === uid) {
          setStatus('registering');
          setError(null);
          await retryPendingRevocation(pendingRevocation);
          if (cancelled) return;
          if (readJSON<PendingRevocation>(PENDING_REVOCATION_KEY)) {
            setStatus('error');
            setError('Finishing sign-out cleanup for a previous session — please try again shortly.');
            return;
          }
        }
      }

      const pendingTransfer = readJSON<PendingTransfer>(PENDING_TRANSFER_KEY);
      if (pendingTransfer && pendingTransfer.installationId === installationIdRef.current) {
        await reconcilePendingTransfer(pendingTransfer, uid);
        return;
      }

      const permission = Notification.permission;
      if (permission === 'denied') {
        setStatus('denied');
        return;
      }
      if (permission === 'default') {
        setStatus('default');
        return;
      }
      if (!uid) return;
      await register();
    })();

    return () => {
      cancelled = true;
    };
  }, [baseUnsupported, iosNotInstalled, uid, register, reconcilePendingTransfer, retryPendingRevocation]);

  return {
    status,
    error,
    enable,
    prepareForAccountSwitch,
    recoverFromFailedSwitch,
    unregisterThisDevice,
    isAccountSwitchBusy,
  };
}
