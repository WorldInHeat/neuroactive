// src/components/VideoPlayer.tsx
import { useMemo, useState, useEffect, useRef } from 'react';import { Play, ExternalLink } from 'lucide-react';

type Props = {
  nodeId: string;
  title: string;
  frequency?: string;
  videoId: string;
  // Token pattern "nodeId:timestamp" guarantees intent is specific to THIS video instance
  autoplayToken?: string | null;
  // Callback to clear the token once used (One-Shot Pattern)
  onConsumeAutoplay?: () => void;
};

export default function VideoPlayer({
  nodeId,
  title,
  frequency,
  videoId,
  autoplayToken,
  onConsumeAutoplay,
}: Props) {
  const [isPlaying, setIsPlaying] = useState(false);

  // Guard against Strict Mode double-invocation or re-renders
  const consumedRef = useRef<string | null>(null);

  // 1) Hard reset when the specific video changes
  useEffect(() => {
    setIsPlaying(false);
    consumedRef.current = null; // Reset consumption tracking for new node
  }, [nodeId]);

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
    const separator = videoId.includes('?') ? '&' : '?';
    // muted=1 is required by most browsers for autoplay
    return `https://player.vimeo.com/video/${videoId}${separator}autoplay=1&title=0&byline=0&portrait=0&muted=1&playsinline=1&loop=1`;
  }, [videoId]);

  const vimeoLink = useMemo(() => {
    const cleanId = videoId.split('?')[0];
    return `https://vimeo.com/${cleanId}`;
  }, [videoId]);

  const handlePlay = () => setIsPlaying(true);

  return (
    <div className="mb-6">
      <div className="bg-black aspect-video rounded-xl overflow-hidden shadow-lg relative">
        {isPlaying ? (
          <iframe
            key={nodeId} // Forces fresh DOM on video change
            src={vimeoSrc}
            className="w-full h-full"
            frameBorder="0"
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
        <a
          href={vimeoLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-gray-500 hover:text-blue-600 transition-colors"
        >
          <ExternalLink size={12} /> Watch on Vimeo
        </a>
      </div>
    </div>
  );
}
