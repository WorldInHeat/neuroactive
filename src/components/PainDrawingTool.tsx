import { useState } from 'react';

type ZoneId =
  | 'head' | 'neck' | 'shoulder' | 'upper_back' | 'mid_back'
  | 'low_back' | 'hip' | 'left_arm' | 'right_arm'
  | 'left_forearm' | 'right_forearm' | 'thigh' | 'knee' | 'calf' | 'foot';

type Zone = { id: ZoneId; label: string; d: string; type: 'path' | 'ellipse'; ellipse?: { cx: number; cy: number; rx: number; ry: number } };

const ZONES: Zone[] = [
  { id: 'head', label: 'Head', type: 'ellipse', d: '', ellipse: { cx: 120, cy: 36, rx: 26, ry: 30 } },
  { id: 'neck', label: 'Neck', type: 'path', d: 'M108,65 L132,65 L130,88 L110,88 Z' },
  { id: 'shoulder', label: 'Shoulder / Trap', type: 'path', d: 'M60,92 C60,92 85,86 110,88 L130,88 C155,86 180,92 180,92 C188,100 192,112 190,122 L158,118 C150,108 136,104 120,104 C104,104 90,108 82,118 L50,122 C48,112 52,100 60,92 Z' },
  { id: 'upper_back', label: 'Upper Back', type: 'path', d: 'M82,118 C90,108 104,104 120,104 C136,104 150,108 158,118 L162,170 L78,170 Z' },
  { id: 'left_arm', label: 'Left Arm', type: 'path', d: 'M50,122 L82,118 L78,170 L68,210 C62,224 54,234 46,238 L36,200 C34,180 36,156 42,138 Z' },
  { id: 'right_arm', label: 'Right Arm', type: 'path', d: 'M190,122 L158,118 L162,170 L172,210 C178,224 186,234 194,238 L204,200 C206,180 204,156 198,138 Z' },
  { id: 'left_forearm', label: 'Left Forearm', type: 'path', d: 'M46,238 C54,234 62,224 68,210 L72,252 C72,266 68,278 62,286 L48,278 C42,266 40,252 46,238 Z' },
  { id: 'right_forearm', label: 'Right Forearm', type: 'path', d: 'M194,238 C186,234 178,224 172,210 L168,252 C168,266 172,278 178,286 L192,278 C198,266 200,252 194,238 Z' },
  { id: 'mid_back', label: 'Mid Back', type: 'path', d: 'M78,170 L162,170 L164,228 L76,228 Z' },
  { id: 'low_back', label: 'Lower Back', type: 'path', d: 'M76,228 L164,228 L166,278 L74,278 Z' },
  { id: 'hip', label: 'Hip / Pelvis', type: 'path', d: 'M74,278 L166,278 C170,296 170,314 164,328 L76,328 C70,314 70,296 74,278 Z' },
  { id: 'thigh', label: 'Thigh', type: 'path', d: 'M76,328 L164,328 C166,348 166,374 162,400 C154,416 140,424 120,424 C100,424 86,416 78,400 C74,374 74,348 76,328 Z' },
  { id: 'knee', label: 'Knee', type: 'path', d: 'M78,400 C86,416 100,424 120,424 C140,424 154,416 162,400 L164,438 C158,450 142,458 120,458 C98,458 82,450 76,438 Z' },
  { id: 'calf', label: 'Calf / Shin', type: 'path', d: 'M76,438 C82,450 98,458 120,458 C142,458 158,450 164,438 L162,510 C156,524 140,532 120,532 C100,532 84,524 78,510 Z' },
  { id: 'foot', label: 'Foot / Ankle', type: 'path', d: 'M78,510 C84,524 100,532 120,532 C140,532 156,524 162,510 L164,548 C162,558 148,566 120,566 C92,566 78,558 76,548 Z' },
];

const SILHOUETTE = `
  M120,6 C104,6 94,16 94,36 C94,50 100,60 108,65
  L108,65 C96,67 72,72 60,92 C52,100 48,112 50,122
  L42,138 C36,156 34,180 36,200 L46,238 C40,252 42,266 48,278
  L62,286 C60,294 60,302 62,310 L60,320
  C58,330 58,340 60,350 L64,380 C68,398 76,414 78,438
  C76,450 78,470 82,490 L78,510 C78,530 90,552 120,566
  C150,552 162,530 162,510 L158,490 C162,470 164,450 162,438
  C164,414 172,398 176,380 L180,350
  C182,340 182,330 180,320 L178,310
  C180,302 180,294 178,286 L192,278
  C198,266 200,252 194,238 L204,200
  C206,180 204,156 198,138 L190,122
  C192,112 188,100 180,92 C168,72 144,67 132,65
  C140,60 146,50 146,36 C146,16 136,6 120,6 Z
`;

type Props = { onComplete: (selections: Record<string, number>) => void };

export default function PainDrawingTool({ onComplete }: Props) {
  const [selected, setSelected] = useState<Partial<Record<ZoneId, number>>>({});
  const [hovered, setHovered] = useState<ZoneId | null>(null);

  const toggle = (id: ZoneId) => {
    setSelected(prev => {
      if (id in prev) {
        const next = { ...prev };
        delete next[id];
        return next;
      }
      return { ...prev, [id]: 1 };
    });
  };

  const zoneStyle = (id: ZoneId) => {
    const sel = id in selected;
    const hov = hovered === id;
    if (sel) return { fill: 'rgba(255,68,102,0.45)', stroke: '#ff4466', strokeWidth: 1.5 };
    if (hov) return { fill: 'rgba(0,212,200,0.2)', stroke: '#00d4c8', strokeWidth: 1.5 };
    return { fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(160,190,220,0.2)', strokeWidth: 1 };
  };

  const selectedEntries = Object.entries(selected) as [ZoneId, number][];

  return (
    <div style={{ background: '#0f1829', borderRadius: 16, border: '1px solid #1a2a42', padding: 16, color: '#f0f4f8' }}>
      <p style={{ fontSize: 13, color: '#6b849e', textAlign: 'center', marginBottom: 12 }}>
        Tap the regions where you feel pain.
      </p>

      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <svg
          viewBox="0 0 240 580"
          style={{ width: '100%', maxWidth: 220, height: 'auto', display: 'block' }}
          aria-label="Body region selector"
        >
          <defs>
            <radialGradient id="bodyGrad" cx="50%" cy="35%" r="65%">
              <stop offset="0%" stopColor="#1e3252" />
              <stop offset="100%" stopColor="#0d1a2e" />
            </radialGradient>
            <filter id="bodyGlow">
              <feGaussianBlur stdDeviation="2.5" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* Silhouette background */}
          <path d={SILHOUETTE} fill="url(#bodyGrad)" stroke="#2a4a72" strokeWidth="1.5" strokeLinejoin="round" />
          {/* Subtle teal edge glow */}
          <path d={SILHOUETTE} fill="none" stroke="#00d4c8" strokeWidth="3" opacity="0.08" filter="url(#bodyGlow)" />

          {/* Clickable zones */}
          {ZONES.map(zone => {
            const s = zoneStyle(zone.id);
            const handlers = {
              onClick: () => toggle(zone.id),
              onMouseEnter: () => setHovered(zone.id),
              onMouseLeave: () => setHovered(null),
              style: { cursor: 'pointer', transition: 'fill 0.15s, stroke 0.15s' } as React.CSSProperties,
            };
            if (zone.type === 'ellipse' && zone.ellipse) {
              const { cx, cy, rx, ry } = zone.ellipse;
              return <ellipse key={zone.id} cx={cx} cy={cy} rx={rx} ry={ry} fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeWidth} {...handlers} />;
            }
            return <path key={zone.id} d={zone.d} fill={s.fill} stroke={s.stroke} strokeWidth={s.strokeWidth} {...handlers} />;
          })}

          {/* Hover label */}
          {hovered && (() => {
            const zone = ZONES.find(z => z.id === hovered)!;
            let lx = 120, ly = 300;
            if (zone.ellipse) { lx = zone.ellipse.cx; ly = zone.ellipse.cy; }
            else {
              const nums = zone.d.match(/[\d.]+,[\d.]+/g) ?? [];
              const pts = nums.map(p => p.split(',').map(Number));
              if (pts.length) {
                lx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
                ly = pts.reduce((s, p) => s + p[1], 0) / pts.length;
              }
            }
            return (
              <text x={lx} y={ly} textAnchor="middle" dominantBaseline="middle"
                fontSize="10" fontWeight="700" fill="#f0f4f8"
                style={{ pointerEvents: 'none', userSelect: 'none' } as React.CSSProperties}>
                {zone.label}
              </text>
            );
          })()}
        </svg>
      </div>

      {/* Selected chips */}
      {selectedEntries.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <p style={{ fontSize: 11, color: '#6b849e', marginBottom: 6 }}>Pain regions marked:</p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {selectedEntries.map(([id]) => {
              const zone = ZONES.find(z => z.id === id)!;
              return (
                <button key={id} onClick={() => toggle(id)} style={{
                  background: 'rgba(255,68,102,0.15)', border: '1px solid rgba(255,68,102,0.5)',
                  color: '#ff8fa3', borderRadius: 20, padding: '3px 10px', fontSize: 12,
                  fontWeight: 700, cursor: 'pointer',
                }}>
                  {zone.label} ✕
                </button>
              );
            })}
          </div>
        </div>
      )}

      <button
        onClick={() => onComplete(selected as Record<string, number>)}
        style={{
          marginTop: 16, width: '100%', padding: '12px 0', borderRadius: 12, border: 'none',
          background: 'linear-gradient(135deg, #00d4c8, #7c5cfc)', color: '#080d1a',
          fontSize: 14, fontWeight: 800, cursor: 'pointer',
        }}>
        {selectedEntries.length === 0 ? 'Skip' : `Continue (${selectedEntries.length} region${selectedEntries.length > 1 ? 's' : ''} marked)`}
      </button>
    </div>
  );
}
