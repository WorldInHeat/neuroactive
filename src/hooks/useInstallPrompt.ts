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
    platform,
    canInstall: deferredPrompt !== null,
    promptInstall,
    dismissedThisSession: dismissed,
    dismissForSession,
  };
}
