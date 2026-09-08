// src/hooks/useInstallPrompt.ts
// Platform/install-state detection for the optional "Install NeuroActive" UX (PWA Phase 2).
// Captures beforeinstallprompt but never invokes it automatically — only promptInstall(),
// called from an explicit user tap, ever calls .prompt(). Never touches Firestore or
// requests notification permission.
import { useCallback, useEffect, useState } from 'react';

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
};

export type InstallPlatform = 'android' | 'ios' | 'desktop-chromium' | 'macos-safari' | 'other';

// Session-only, per the product spec: a dismissal must not nag again this session, but
// nothing long-term is persisted yet (no localStorage, no Firestore).
const SESSION_DISMISS_KEY = 'na_install_prompt_dismissed';

// Durable, cross-session record of "this device has been observed running NeuroActive in
// standalone (installed) mode at least once" — deliberately separate from `isStandalone`
// (see below), which only ever answers "is THIS tab/session standalone right now." Without
// this, a later ordinary-browser visit has no way to know installation happened earlier —
// display-mode/navigator.standalone answer only "now," never "ever" — which is exactly
// what let a genuinely-installed user's browser tab be told nothing about their Home
// Screen icon. Monotonic: once set, never cleared by this code (an uninstall simply means
// future visits stay in the ordinary browser, which the live isStandalone check already
// handles correctly on its own).
const EVER_STANDALONE_KEY = 'na_pwa_ever_standalone';

function readEverStandalone(): boolean {
  try {
    return window.localStorage.getItem(EVER_STANDALONE_KEY) === '1';
  } catch {
    return false;
  }
}

function persistEverStandalone(): void {
  try {
    window.localStorage.setItem(EVER_STANDALONE_KEY, '1');
  } catch {
    // best-effort only — a failure here just means a later ordinary-browser visit falls
    // back to treating this device as not-yet-confirmed-installed, same as before this
    // flag existed; it never blocks or breaks anything.
  }
}

// The three states any "is NeuroActive installed / am I in it right now" UI needs to
// distinguish — pure and DOM-free so it's directly unit-testable. `standalone` always wins
// over a stale `everStandalone` flag (the live signal is authoritative for "right now").
//
// `previously-standalone` is deliberately NOT named "installed" or "installed-elsewhere":
// the flag it's derived from is historical evidence only — proof this origin was opened
// standalone at some point in the past — never proof the Home Screen icon still exists
// today. A user can delete the app; the flag has no way to know that happened, and never
// will (there is no API for a web page to detect its own Home Screen icon's removal).
// Callers must treat this state as "probably still installed, guidance should assume so
// but never claim it with certainty" — never as a confirmed-current-install fact, and
// never as a reason to stop offering the real install/re-install instructions.
export type StandaloneDisplayState = 'standalone' | 'previously-standalone' | 'not-installed';

export function computeStandaloneDisplayState(params: { isStandalone: boolean; everStandalone: boolean }): StandaloneDisplayState {
  if (params.isStandalone) return 'standalone';
  if (params.everStandalone) return 'previously-standalone';
  return 'not-installed';
}

function detectPlatform(): InstallPlatform {
  const ua = navigator.userAgent;
  // iPadOS 13+ Safari reports as "Macintosh" but exposes multi-touch, unlike a real Mac.
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/Android/.test(ua)) return 'android';
  const isMac = /Macintosh/.test(ua);
  const isSafari = /^((?!chrome|android|crios|edg|firefox).)*safari/i.test(ua);
  if (isMac && isSafari) return 'macos-safari';
  return 'desktop-chromium';
}

function detectStandalone(): boolean {
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  // iOS Safari doesn't reflect standalone mode via matchMedia — it exposes this instead.
  if ((navigator as unknown as { standalone?: boolean }).standalone === true) return true;
  return false;
}

export function useInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isStandalone, setIsStandalone] = useState(detectStandalone);
  const [platform] = useState<InstallPlatform>(detectPlatform);
  const [dismissed, setDismissed] = useState(() => sessionStorage.getItem(SESSION_DISMISS_KEY) === '1');
  // Seeded from BOTH the persisted flag and this tab's own live state, so a genuinely
  // fresh install (isStandalone already true on first mount here, before any effect has
  // had a chance to persist it) is never reported as "not yet ever installed" for the
  // brief window before the effect below runs.
  const [everStandalone, setEverStandalone] = useState(() => readEverStandalone() || detectStandalone());

  // Whenever THIS tab is ever observed standalone — now or later via the display-mode
  // listener/appinstalled/promptInstall below — durably record it, once, for every future
  // ordinary-browser visit on this device to read back.
  //
  // Deliberately checks the ACTUAL persisted value (readEverStandalone(), a fresh read)
  // rather than the in-memory `everStandalone` state to decide whether a write is needed —
  // NOT redundant with the state seeding above. A genuinely fresh first-ever standalone
  // session seeds `everStandalone` to `true` immediately (via detectStandalone() in the
  // initializer above), so it never transitions false->true here; gating the write on the
  // in-memory state alone would silently skip persisting it forever. Re-checking the real
  // localStorage value instead makes this correct regardless of what the in-memory state
  // already believed.
  useEffect(() => {
    if (!isStandalone) return;
    if (!readEverStandalone()) persistEverStandalone();
    if (!everStandalone) setEverStandalone(true);
  }, [isStandalone, everStandalone]);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      // Suppress the browser's own mini-infobar so install only ever happens from our
      // explicit "Install NeuroActive" tap, never automatically.
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    const mql = window.matchMedia('(display-mode: standalone)');
    const handleDisplayModeChange = () => setIsStandalone(detectStandalone());
    mql.addEventListener?.('change', handleDisplayModeChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      mql.removeEventListener?.('change', handleDisplayModeChange);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferredPrompt) return 'unavailable';
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    // A captured prompt can only be used once — clear it either way so a dismissed
    // browser prompt doesn't leave a dead "Install" button behind.
    setDeferredPrompt(null);
    if (choice.outcome === 'accepted') setIsStandalone(true);
    return choice.outcome;
  }, [deferredPrompt]);

  const dismissForSession = useCallback(() => {
    sessionStorage.setItem(SESSION_DISMISS_KEY, '1');
    setDismissed(true);
  }, []);

  return {
    isStandalone,
    everStandalone,
    displayState: computeStandaloneDisplayState({ isStandalone, everStandalone }),
    platform,
    canInstall: deferredPrompt !== null,
    promptInstall,
    dismissedThisSession: dismissed,
    dismissForSession,
  };
}
