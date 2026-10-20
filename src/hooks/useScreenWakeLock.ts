// src/hooks/useScreenWakeLock.ts
import { useEffect, useRef } from 'react';

// Framework-free Screen Wake Lock controller. Holds a 'screen' wake lock only while the
// caller says it's wanted (setActive(true)) AND the document is visible. Progressive
// enhancement: when the API is missing, or a request is rejected (NotAllowedError from
// battery saver, a permissions policy, a hidden document, etc.), it silently does
// nothing — never throws, never surfaces an error, never affects playback.
//
// Race handling: at most one request is ever in flight. A request that resolves after
// the lock stopped being wanted (paused, tab hidden, disposed) is released immediately
// instead of being kept. The browser itself auto-releases on hide; this controller then
// re-requests on the next visible transition only if still active.

export interface ScreenWakeLockController {
  setActive(active: boolean): void;
  dispose(): void;
}

// Only the parts of `document` this controller touches — lets tests pass a fake.
export type WakeLockDocument = Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;

export function createScreenWakeLock(
  wakeLock: WakeLock | undefined,
  doc: WakeLockDocument,
): ScreenWakeLockController {
  let active = false;
  let disposed = false;
  let sentinel: WakeLockSentinel | null = null;
  let requesting = false;

  const wanted = () => active && !disposed && doc.visibilityState === 'visible';

  const release = () => {
    const held = sentinel;
    sentinel = null;
    held?.release().catch(() => {});
  };

  const sync = () => {
    if (!wakeLock) return;
    if (!wanted()) {
      release();
      return;
    }
    if (sentinel || requesting) return;
    let request: Promise<WakeLockSentinel>;
    try {
      request = wakeLock.request('screen');
    } catch {
      return; // Non-conforming implementations may throw synchronously — still silent.
    }
    requesting = true;
    request.then(
      (lock) => {
        requesting = false;
        if (!wanted()) {
          lock.release().catch(() => {});
          return;
        }
        sentinel = lock;
        // System-initiated release (tab hidden, battery saver): just forget it. Not
        // re-requested here — the next visibilitychange or play does that, which avoids
        // a request/reject loop while the system is refusing locks.
        lock.addEventListener('release', () => {
          if (sentinel === lock) sentinel = null;
        });
      },
      () => {
        requesting = false;
      },
    );
  };

  doc.addEventListener('visibilitychange', sync);

  return {
    setActive(next) {
      active = next;
      sync();
    },
    dispose() {
      disposed = true;
      doc.removeEventListener('visibilitychange', sync);
      release();
    },
  };
}

// Keeps the screen awake while `active` is true and the page is visible. Released on
// active=false, on hide (re-acquired on return if still active), and on unmount. Silent
// no-op where the Screen Wake Lock API is unsupported or refused.
export function useScreenWakeLock(active: boolean): void {
  const controllerRef = useRef<ScreenWakeLockController | null>(null);

  useEffect(() => {
    const wakeLock = 'wakeLock' in navigator ? navigator.wakeLock : undefined;
    const controller = createScreenWakeLock(wakeLock, document);
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setActive(active);
  }, [active]);
}
