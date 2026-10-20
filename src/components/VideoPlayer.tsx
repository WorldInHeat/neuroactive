// src/components/VideoPlayer.tsx
import { useMemo, useState, useEffect, useRef } from 'react';import { Play, ExternalLink, Maximize } from 'lucide-react';
import { useScreenWakeLock } from '../hooks/useScreenWakeLock';
import { enterFullscreen, fullscreenControlFor, useFullscreenAvailable } from '../hooks/useElementFullscreen';

// Vimeo's iframe postMessage protocol — the same messages @vimeo/player sends/receives,
// used directly so no SDK dependency is needed just to observe playback state.
const VIMEO_PLAYER_ORIGIN = 'https://player.vimeo.com';
const VIMEO_PLAYBACK_EVENTS = ['play', 'playing', 'pause', 'ended'] as const;

type VimeoMessage = { event?: string; method?: string };

// Vimeo posts either an object or a JSON string depending on player version.
function parseVimeoMessage(data: unknown): VimeoMessage | null {
  let parsed: unknown = data;
  if (typeof data === 'string') {
    try {
      parsed = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { event, method } = parsed as Record<string, unknown>;
  return {
    event: typeof event === 'string' ? event : undefined,
    method: typeof method === 'string' ? method : undefined,
  };
}

type Props = {
  nodeId: string;
  title: string;
  frequency?: string;
  videoId: string;
  // Vimeo's privacy hash, required for Unlisted videos to play. Must be the first query
  // parameter on the embed URL — see the comment on vimeoSrc below.
  hash?: string;
  // Token pattern "nodeId:timestamp" guarantees intent is specific to THIS video instance
  autoplayToken?: string | null;
  // Callback to clear the token once used (One-Shot Pattern)
  onConsumeAutoplay?: () => void;
  // Every video in the app is landscape except the Paywall's portrait testimonial —
  // default stays 16:9 so no other call site is affected.
  orientation?: 'landscape' | 'portrait';
  // DNS lesson videos only. Mounts the real Vimeo iframe immediately (skipping this
  // component's own custom paused-thumbnail overlay below) and omits autoplay/muted from
  // the embed URL entirely, so the user's one click lands directly on Vimeo's own native
  // Play control — the one case every major browser's autoplay policy unconditionally
  // allows to start audible playback. A prior custom-overlay click followed by a freshly
  // mounted cross-origin iframe requesting unmuted autoplay is NOT reliably honored across
  // browsers (confirmed against Chromium's and WebKit's own autoplay-policy documentation
  // during the investigation this prop resolves) — this sidesteps that entirely rather
  // than relying on it. Defaults to false: every existing caller (onboarding video,
  // assessment-flow autoplay-token videos, paywall testimonial) is completely unaffected.
  nativePlayback?: boolean;
  // DNS lesson videos only. Holds a Screen Wake Lock while Vimeo reports the video is
  // actually playing (embedded or fullscreen) — never merely because the page is open.
  // Defaults to false so every other caller is unaffected.
  keepScreenAwakeWhilePlaying?: boolean;
  // DNS lesson videos only. Shows an explicit "View fullscreen" button under the video —
  // on phone widths Vimeo tucks its own fullscreen control behind a small overflow
  // chevron, which testers didn't find. Fullscreens the iframe itself (the same element
  // Vimeo's native control fullscreens), so playback position and play/pause state carry
  // over untouched. Where the standard Fullscreen API is unavailable (e.g. iPhone Safari)
  // a short hint pointing at Vimeo's own ‹-tucked control is shown instead — never both.
  // Defaults to false.
  showFullscreenButton?: boolean;
};

export default function VideoPlayer({
  nodeId,
  title,
  frequency,
  videoId,
  hash,
  autoplayToken,
  onConsumeAutoplay,
  orientation = 'landscape',
  nativePlayback = false,
  keepScreenAwakeWhilePlaying = false,
  showFullscreenButton = false,
}: Props) {
  const [isPlaying, setIsPlaying] = useState(false);
  // Bumped by the "Trouble playing? Retry" control below to force a fresh iframe mount
  // (new DOM node, fresh request to player.vimeo.com) without touching isPlaying,
  // nodeId, autoplayToken, or anything outside this component — see the iframe's key
  // below. Never triggers a new getDnsCourseDayMedia call: videoId/hash are unchanged
  // props, not re-fetched here.
  const [retryKey, setRetryKey] = useState(0);

  // Guard against Strict Mode double-invocation or re-renders
  const consumedRef = useRef<string | null>(null);

  // 1) Hard reset when the player's IDENTITY changes — nodeId, videoId, and hash
  // together, not nodeId alone. Every current caller happens to remount this whole
  // component via a `key` whenever its day/video changes (DNSCourseView's DayVideo is
  // rendered with key={dayIndex}; Paywall's testimonial call site never changes videoId
  // at all), so nodeId, videoId, and hash already only ever change in lockstep today —
  // but this component's own contract shouldn't rely on every caller preserving that
  // invariant. Depending on all three closes that gap directly: if a future caller ever
  // reuses one nodeId across different videoId/hash values without remounting, playback
  // state still resets correctly instead of silently continuing to show/attempt the
  // previous video's iframe.
  //
  // Kept as an effect rather than moved to a render-time state adjustment: the ref reset
  // below (consumedRef) is itself a side effect, not a value used in this render, and
  // React's own rules disallow writing refs during render outside of lazy-init — an
  // effect is the correct place for it regardless. The two setState calls alongside it
  // were already flagged by react-hooks/set-state-in-effect before this patch (see the
  // separate lint verification below); widening this effect's dependencies doesn't add a
  // new violation, only changes when the same two, already-necessary calls fire. No loop
  // risk: the dependencies (nodeId/videoId/hash) are plain string props from the parent,
  // never derived from isPlaying/retryKey/consumedRef, so this effect can't cause its own
  // dependencies to change. No stale-state risk: isPlaying, retryKey, and consumedRef are
  // all reset together, synchronously, in the same effect run — there's no intermediate
  // render where one is reset and another still holds a previous video's value.
  useEffect(() => {
    setIsPlaying(false);
    setRetryKey(0);
    consumedRef.current = null; // Reset consumption tracking for the new identity
  }, [nodeId, videoId, hash]);

  // 2) Honoring Autoplay Intent (Token Pattern) + One-shot consumption
  useEffect(() => {
    if (!autoplayToken) return;

    // Prevent double-consumption of the same token
    if (consumedRef.current === autoplayToken) return;

    const tokenNodeId = autoplayToken.split(':')[0];

    if (tokenNodeId === nodeId) {
      // Mark as consumed locally so we don't re-fire in this lifecycle
      consumedRef.current = autoplayToken;

      setIsPlaying(true);

      // Tell parent to clear the token so it never re-fires globally
      onConsumeAutoplay?.();
    }
  }, [autoplayToken, nodeId, onConsumeAutoplay]);

  const vimeoSrc = useMemo(() => {
    // Vimeo requires the privacy hash (h) to be the first query parameter for Unlisted
    // videos to play — every other parameter must come after it via &, not before.
    // Confirmed against Vimeo's own embed documentation, not assumed.
    const params = new URLSearchParams();
    if (hash) params.set('h', hash);
    // nativePlayback (DNS lessons) deliberately omits both — see the prop's own doc
    // comment above for why a prior custom-overlay click can't reliably substitute for a
    // direct click on Vimeo's own native Play control across browsers.
    if (!nativePlayback) params.set('autoplay', '1');
    params.set('title', '0');
    params.set('byline', '0');
    params.set('portrait', '0');
    if (!nativePlayback) params.set('muted', '1'); // required by most browsers for autoplay
    params.set('playsinline', '1');
    params.set('loop', '1');
    // Vimeo's documented "do not track" opt-out — disables the player's own tracking
    // scripts/cookies. Purely a privacy tightening; it doesn't touch the hash, domain
    // allowlist, or any other access control.
    params.set('dnt', '1');
    return `https://player.vimeo.com/video/${videoId}?${params.toString()}`;
  }, [videoId, hash, nativePlayback]);

  // Only ever rendered for a hash-less (public) video — see the "Watch on Vimeo" link
  // below. Deliberately does NOT append hash: for an Unlisted/hash-protected video,
  // exposing player.vimeo.com's videoId+hash pair as a plain, copyable/shareable <a>
  // href would let it be played by anyone it's shared with, bypassing this app's
  // getDnsCourseDayMedia entitlement check entirely — Vimeo itself doesn't re-check our
  // entitlement once the hash is known. The iframe above already needs the hash to embed
  // the video at all; that's not newly exposed, but a dedicated shareable link is a much
  // easier thing to copy/forward than reading a src attribute out of page source.
  const vimeoLink = useMemo(() => {
    const cleanId = videoId.split('?')[0];
    return `https://vimeo.com/${cleanId}`;
  }, [videoId]);

  const handlePlay = () => setIsPlaying(true);
  const handleRetry = () => setRetryKey((k) => k + 1);

  // nativePlayback skips this component's own paused-thumbnail overlay entirely — the
  // iframe (and Vimeo's own native paused frame/Play control) is what the user sees from
  // the moment this component mounts, rather than waiting for a tap on our overlay first.
  const showIframe = isPlaying || nativePlayback;

  // Full identity (nodeId + videoId + hash) plus the manual retry generation — forces a
  // fresh DOM node (and so a fresh request to player.vimeo.com) on any video change OR a
  // Retry tap, independent of the reset effect above.
  const iframeKey = `${nodeId}:${videoId}:${hash ?? ''}:${retryKey}`;
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Which iframe instance Vimeo last reported as playing. Keyed rather than a boolean so
  // a remount (Retry, video change) reads as "not playing" without resetting state.
  const [playingIframeKey, setPlayingIframeKey] = useState<string | null>(null);
  const trackPlayback = keepScreenAwakeWhilePlaying && showIframe;

  useEffect(() => {
    if (!trackPlayback) return;
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      // Only genuine messages from this component's own Vimeo iframe.
      if (!frame || event.source !== frame || event.origin !== VIMEO_PLAYER_ORIGIN) return;
      const message = parseVimeoMessage(event.data);
      if (!message) return;
      if (message.event === 'ready' || message.method === 'ping') {
        for (const value of VIMEO_PLAYBACK_EVENTS) {
          frame.postMessage({ method: 'addEventListener', value }, VIMEO_PLAYER_ORIGIN);
        }
      } else if (message.event === 'play' || message.event === 'playing') {
        setPlayingIframeKey(iframeKey);
      } else if (message.event === 'pause' || message.event === 'ended') {
        setPlayingIframeKey(null);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [trackPlayback, iframeKey]);

  // Covers a 'ready' that Vimeo sent before the listener above was attached — the player
  // answers a ping the same way, which then triggers the event subscription.
  const handleIframeLoad = () => {
    iframeRef.current?.contentWindow?.postMessage({ method: 'ping' }, VIMEO_PLAYER_ORIGIN);
  };

  useScreenWakeLock(trackPlayback && playingIframeKey === iframeKey);

  const fullscreenControl = fullscreenControlFor(showFullscreenButton, useFullscreenAvailable());
  // Requested synchronously inside the tap handler so it carries the tap's user
  // activation. A refusal resolves false and is ignored — no error UI.
  const handleFullscreen = () => {
    void enterFullscreen(iframeRef.current);
  };

  return (
    <div className="mb-6">
      <div
        className={`bg-black ${orientation === 'portrait' ? 'aspect-[9/16] max-w-xs mx-auto' : 'aspect-video'} rounded-xl overflow-hidden shadow-lg relative`}
      >
        {showIframe ? (
          <iframe
            key={iframeKey}
            ref={iframeRef}
            onLoad={trackPlayback ? handleIframeLoad : undefined}
            src={vimeoSrc}
            className="w-full h-full"
            frameBorder="0"
            // Sends only the origin (https://neuroactivehealth.com), not the full page
            // path, as the Referer to player.vimeo.com — strictly more private than the
            // default, and confirmed (during the earlier beta-defect investigation) not
            // to affect Vimeo's own domain-allowlist check, which only needs the origin.
            referrerPolicy="origin"
            allow="autoplay; fullscreen; picture-in-picture; clipboard-write"
            allowFullScreen
          />
        ) : (
          <button
            onClick={handlePlay}
            className="w-full h-full relative flex items-center justify-center group"
            aria-label={`Play: ${title}`}
          >
            <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent z-10" />
            <div className="absolute inset-0 bg-gradient-to-br from-slate-900 via-slate-800 to-slate-700" />
            <div className="absolute inset-0 opacity-40 bg-[radial-gradient(circle_at_30%_20%,rgba(59,130,246,0.55),transparent_45%),radial-gradient(circle_at_70%_60%,rgba(99,102,241,0.55),transparent_50%)]" />

            <div className="absolute bottom-4 left-4 right-4 text-white">
              <div className="text-xs font-semibold uppercase tracking-wider text-white/70">Exercise</div>
              <div className="text-lg font-extrabold leading-tight line-clamp-2">{title}</div>

              {frequency && (
                <div className="mt-2 inline-flex items-center rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white/90 border border-white/15">
                  {frequency}
                </div>
              )}
            </div>

            <div className="absolute z-20 bg-white/20 backdrop-blur-sm p-4 rounded-full border border-white/30 group-hover:scale-110 transition-transform">
              <Play className="text-white fill-current" size={32} />
            </div>
          </button>
        )}
      </div>

      <div className="mt-3 text-center space-y-1">
        {showIframe && fullscreenControl === 'hint' && (
          <p className="pb-1 text-xs text-[#6b849e]">
            For fullscreen, tap ‹ in the video controls, then tap the fullscreen icon.
          </p>
        )}
        {showIframe && fullscreenControl === 'button' && (
          <div className="pb-1">
            <button
              type="button"
              onClick={handleFullscreen}
              className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-full border border-[#00d4c8]/40 bg-[#00d4c8]/10 px-5 py-2 text-sm font-semibold text-[#00d4c8] hover:bg-[#00d4c8]/20 active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-[#00d4c8]/60"
            >
              <Maximize size={16} aria-hidden="true" />
              View fullscreen
            </button>
          </div>
        )}
        {showIframe && (
          <button
            type="button"
            onClick={handleRetry}
            className="block mx-auto text-xs font-medium text-gray-500 hover:text-blue-600 transition-colors"
          >
            Trouble playing? Retry
          </button>
        )}
        {/* Hash-protected (Unlisted) videos never get this link — see vimeoLink above. */}
        {!hash && (
          <a
            href={vimeoLink}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-600 transition-colors"
          >
            <ExternalLink size={12} /> Watch on Vimeo
          </a>
        )}
      </div>
    </div>
  );
}
