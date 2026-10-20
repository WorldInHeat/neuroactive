// src/hooks/useElementFullscreen.ts
import { useState } from 'react';

// Standard Fullscreen API only — feature-detected, never browser-sniffed. Where it's
// unavailable (iPhone Safari, which only fullscreens <video> elements; old Safari with
// only webkit-prefixed methods; a frame denied `fullscreen` by permissions policy)
// callers hide their control and the player's own native fullscreen control remains.

type FullscreenDocument = Pick<Document, 'fullscreenEnabled' | 'documentElement'>;

export function isFullscreenAvailable(doc: FullscreenDocument): boolean {
  return doc.fullscreenEnabled === true && typeof doc.documentElement?.requestFullscreen === 'function';
}

// Must be called synchronously from the user's click/tap handler: the request is issued
// before this returns, so it runs inside the gesture's transient user activation. Never
// throws or rejects — resolves false on any refusal so the UI can simply carry on.
export function enterFullscreen(element: Pick<Element, 'requestFullscreen'> | null): Promise<boolean> {
  if (!element || typeof element.requestFullscreen !== 'function') return Promise.resolve(false);
  try {
    return element.requestFullscreen().then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false);
  }
}

// Which fullscreen affordance a player opted into showFullscreenButton renders: the
// explicit button where standard element fullscreen works, otherwise a short hint
// pointing at the player's own (overflow-tucked) native control. Never both.
export type FullscreenControl = 'button' | 'hint' | null;

export function fullscreenControlFor(enabled: boolean, available: boolean): FullscreenControl {
  if (!enabled) return null;
  return available ? 'button' : 'hint';
}

// Evaluated once per mount — fullscreenEnabled doesn't change during a page's life.
export function useFullscreenAvailable(): boolean {
  const [available] = useState(() => typeof document !== 'undefined' && isFullscreenAvailable(document));
  return available;
}
