// src/components/pain/zones.ts

export type ZoneId =
  | 'head'
  | 'neck'
  | 'shoulder'
  | 'left_arm'
  | 'right_arm'
  | 'upper_back'
  | 'mid_back'
  | 'low_back'
  | 'hip'
  | 'thigh'
  | 'knee'
  | 'calf'
  | 'foot';

export type Zone = {
  id: ZoneId;
  label: string;
  /** SVG polygon points string — "x1,y1 x2,y2 ..." */
  points?: string;
  /** Ellipse descriptor (head zone) */
  ellipse?: { cx: number; cy: number; rx: number; ry: number };
};

/** SVG viewBox for the body figure */
export const VIEW_BOX = '0 0 240 620';

/**
 * Zones on a 240×620 SVG, centered at x=120.
 *
 * Anatomy:
 *   Shoulder bar  x=44–196  (152 px, includes both shoulder caps)
 *   Arms          x=14–54 (L) / x=186–226 (R)  run alongside the torso
 *   Torso         tapers 132 px at top → 104 px at waist
 *   Pelvis        120 px, widens slightly
 *   Legs          combined zone, tapers to ~108 px at ankle
 *
 * All zones are side-neutral; left_arm / right_arm are the only lateralised
 * ones, which is valid because they are spatially distinct.
 */
export const ZONES: Zone[] = [
  {
    id: 'head',
    label: 'Head',
    ellipse: { cx: 120, cy: 40, rx: 28, ry: 34 },
  },
  {
    id: 'neck',
    label: 'Neck',
    //          TL       TR       BR       BL
    points: '108,73 132,73 130,100 110,100',
  },
  {
    id: 'shoulder',
    label: 'Shoulder',
    // Wide bar — covers trapezius + both shoulder caps
    points: '44,98 196,98 196,142 44,142',
  },
  {
    id: 'left_arm',
    label: 'Left Arm',
    // Outside the central torso on the left; runs from shoulder bottom to mid-hip
    points: '14,140 54,140 50,382 10,382',
  },
  {
    id: 'right_arm',
    label: 'Right Arm',
    // Mirror of left arm
    points: '186,140 226,140 230,382 190,382',
  },
  {
    id: 'upper_back',
    label: 'Upper Back',
    // Central torso top — 132 px wide at top, 124 px at bottom
    points: '54,140 186,140 182,210 58,210',
  },
  {
    id: 'mid_back',
    label: 'Mid Back',
    points: '58,208 182,208 178,268 62,268',
  },
  {
    id: 'low_back',
    label: 'Lower Back',
    // Narrows to ~104 px at waist
    points: '62,266 178,266 172,316 68,316',
  },
  {
    id: 'hip',
    label: 'Hip / Pelvis',
    // Pelvis widens slightly vs waist
    points: '60,314 180,314 184,384 56,384',
  },
  {
    id: 'thigh',
    label: 'Thigh',
    points: '56,382 184,382 180,480 60,480',
  },
  {
    id: 'knee',
    label: 'Knee',
    points: '60,478 180,478 178,512 62,512',
  },
  {
    id: 'calf',
    label: 'Calf / Shin',
    // Narrows toward ankle
    points: '62,510 178,510 174,586 66,586',
  },
  {
    id: 'foot',
    label: 'Foot / Ankle',
    // Foot splays slightly wider than ankle
    points: '66,584 174,584 180,614 60,614',
  },
];
