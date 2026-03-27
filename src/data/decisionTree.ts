// src/data/decisionTree.ts
import type { DecisionNode } from '../state/types';

export const DECISION_TREE: Record<string, DecisionNode> = {
  // =========================
  // START
  // =========================
  start: {
    id: 'start',
    type: 'question',
    text: 'What is your primary focus today?',
    description: 'Select an area of pain or a performance goal.',
    options: [
      { label: 'Lower Back Pain', nextId: 'low_back_1' },
      { label: 'Neck / Cervical Pain', nextId: 'neck_1' },
      { label: 'Shoulder Pain', nextId: 'shoulder_1' },
      { label: 'Hip Pain', nextId: 'hip_1' },
      { label: 'Knee Pain', nextId: 'knee_1' },
      { label: 'Foot & Ankle Pain', nextId: 'foot_1' },
      { label: 'Elbow & Wrist Pain', nextId: 'elbow_wrist_1' },
      { label: "I don't have pain, I want to improve performance", nextId: 'performance_start' },
    ],
  },

  // =========================
  // SAFETY / REFER OUT
  // =========================
  refer_out: {
    id: 'refer_out',
    type: 'result',
    text: 'Stop and get checked',
    description:
      'Your response suggests this may not be a good fit for self-management. Please see a licensed clinician for an in-person evaluation.',
    flagLevel: 'red',
    flagText: 'In-person evaluation recommended',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  refer_out_urgent: {
    id: 'refer_out_urgent',
    type: 'result',
    text: 'Urgent evaluation recommended',
    description:
      'Symptoms like significant weakness, progressive numbness, bowel/bladder changes, severe unrelenting pain, or loss of coordination warrant urgent medical evaluation.',
    flagLevel: 'red',
    flagText: 'Seek urgent care',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  // =========================
  // GATING / CHECK-IN NODES
  // =========================
  lb_unlock_checkin_required: {
    id: 'lb_unlock_checkin_required',
    type: 'result',
    text: 'Quick check-in required',
    description:
      'Before you progress, complete today\'s Daily Check-in on your Dashboard. This keeps your plan tight and prevents half-dosing.',
    flagLevel: 'yellow',
    options: [{ label: 'Back to Dashboard', nextId: 'start' }],
  },

  lb_hold_24_48h: {
    id: 'lb_hold_24_48h',
    type: 'result',
    text: 'Hold the line (24–48 hours)',
    description:
      'If you\'re feeling better, even if leg symptoms lag behind, that\'s still progress. Stay consistent with your current plan for 24–48 hours before adding new drills.',
    flagLevel: 'green',
    options: [
      { label: 'I understand, continue my current plan', nextId: 'lb_nerve_check_post_mdt' },
      { label: 'I feel worse / symptoms are spreading', nextId: 'refer_out' },
    ],
  },

  lb_hold_week1: {
    id: 'lb_hold_week1',
    type: 'result',
    text: 'Week 1: Master the basics',
    description:
      'For the next week, your job is to do ONLY your MDT directional work + DNS 3-month supine consistently. After 7 days, we unlock progression.',
    flagLevel: 'green',
    options: [
      { label: 'Continue to DNS Foundation', nextId: 'vid_dns_3mo' },
      { label: 'I feel worse / symptoms spreading', nextId: 'refer_out' },
    ],
  },

  // =========================
  // TROUBLESHOOTING NODES
  // =========================

  // --- Lumbar troubleshooting ---
  // FIX: Now reachable — linked from vid_mdt_standing_ext and vid_mdt_prone_gradual
  lb_troubleshoot_intro: {
    id: 'lb_troubleshoot_intro',
    type: 'video',
    text: 'Lumbar Troubleshooting (Next Best Options)',
    description:
      'If extension work causes peripheralization or stalls, try these two adjustments before you stop: (1) sustained positioning + lateral bias options, then (2) traction if needed.',
    videoId: '1151049975',
    journeyTier: 'A',
    flagLevel: 'yellow',
    options: [
      { label: 'Tried these options and improved / centralized', nextId: 'vid_dns_3mo' },
      { label: 'No change / still peripheralizing → Try traction', nextId: 'lb_troubleshoot_traction' },
    ],
  },

  lb_troubleshoot_traction: {
    id: 'lb_troubleshoot_traction',
    type: 'video',
    text: 'Lumbar Traction Option',
    description:
      'Traction can help when symptoms will not respond to spinal movement testing. If symptoms worsen or travel further down the leg, stop.',
    videoId: '1151049975',
    journeyTier: 'A',
    flagLevel: 'yellow',
    options: [
      { label: 'Improved / centralized', nextId: 'vid_dns_3mo' },
      { label: 'No change / worse → Refer out', nextId: 'refer_out' },
    ],
  },

  // --- Cervical troubleshooting ---
  cs_troubleshoot_intro: {
    id: 'cs_troubleshoot_intro',
    type: 'question',
    text: 'Cervical Troubleshooting — Step by Step',
    description: 'Work through these in order before moving to the next. Most non-responders are under-dosing or not reaching true end range.',
    flagLevel: 'yellow',
    options: [
      { label: 'Step 1 — Recheck technique: am I truly at end range retraction?', nextId: 'cs_troubleshoot_technique' },
      { label: 'I have already rechecked technique — move to Step 2', nextId: 'cs_troubleshoot_sustained' },
      { label: 'I have tried all steps and symptoms are spreading', nextId: 'refer_out' },
    ],
  },

  cs_troubleshoot_technique: {
    id: 'cs_troubleshoot_technique',
    type: 'result',
    text: 'End Range Check',
    description: 'True retraction means your chin moves straight back — not tucked down, not tilted. Your neck should feel compressed at the back. If you have been stopping short of this, full end range often changes the response completely. Dose: 10 reps every 2 hours for 24 hours at true end range.',
    flagLevel: 'yellow',
    options: [
      { label: 'Tried true end range — centralizing / improving', nextId: 'neck_post_mdt_check' },
      { label: 'Tried true end range — no change, move to sustained hold', nextId: 'cs_troubleshoot_sustained' },
      { label: 'Worse / spreading further down arm', nextId: 'refer_out' },
    ],
  },

  cs_troubleshoot_sustained: {
    id: 'cs_troubleshoot_sustained',
    type: 'result',
    text: 'Sustained End Range Hold',
    description: 'Instead of repetitions, hold retraction+extension at end range for 30–60 seconds. Some derangements respond to sustained loading rather than repeated movement. Do 3–5 holds per session, every 2 hours.',
    flagLevel: 'yellow',
    options: [
      { label: 'Improving / centralizing', nextId: 'neck_post_mdt_check' },
      { label: 'No change — move to overpressure', nextId: 'vid_mdt_ret_overpressure' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  cs_troubleshoot_traction: {
    id: 'cs_troubleshoot_traction',
    type: 'video',
    text: 'Cervical Traction Option',
    description:
      'If movement testing fails, traction can sometimes reduce peripheral symptoms. If weakness is worsening or symptoms escalate, stop and seek in-person evaluation.',
    videoId: '1151051123',
    journeyTier: 'A',
    flagLevel: 'yellow',
    options: [
      { label: 'Improved / centralized', nextId: 'neck_nerve_check_post_mdt' },
      { label: 'No change / worse → Refer out', nextId: 'refer_out' },
    ],
  },

  // =========================
  // "COMING SOON" STUB TREES
  // =========================
  shoulder_1: {
    id: 'shoulder_1',
    type: 'result',
    text: 'Shoulder pathway coming soon',
    description: 'This section is under development. Check back soon.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  hip_1: {
    id: 'hip_1',
    type: 'result',
    text: 'Hip pathway coming soon',
    description: 'This section is under development. Check back soon.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  knee_1: {
    id: 'knee_1',
    type: 'result',
    text: 'Knee pathway coming soon',
    description: 'This section is under development. Check back soon.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  foot_1: {
    id: 'foot_1',
    type: 'result',
    text: 'Foot & ankle pathway coming soon',
    description: 'This section is under development. Check back soon.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  elbow_wrist_1: {
    id: 'elbow_wrist_1',
    type: 'result',
    text: 'Elbow & wrist pathway coming soon',
    description: 'This section is under development. Check back soon.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  performance_start: {
    id: 'performance_start',
    type: 'result',
    text: 'Performance pathway coming soon',
    description: 'This section is under development. Check back soon.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  // =========================
  // DNS LIBRARY EXERCISES
  // =========================
  vid_dns_3mo: {
    id: 'vid_dns_3mo',
    type: 'video',
    text: 'DNS 3-Month Supine',
    description: 'The foundational sagittal stabilization position. Focus on IAP and neutral spine.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 minutes, 1-2x per day',
    libraryCategory: 'Supine',
    flagLevel: 'green',
    options: [{ label: 'I feel stable & can breathe deeply', nextId: 'dns_sagittal_progression_choice' }],
  },

  vid_dns_iap: {
    id: 'vid_dns_iap',
    type: 'video',
    text: 'IAP Breathing Drill',
    description: 'Intra-abdominal pressure foundation. Master this before progressing to dynamic DNS positions.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '5 minutes, 2x per day',
    libraryCategory: 'Supine',
    flagLevel: 'green',
    // FIX: Now reachable — used as regression from dns_sagittal_progression_choice
    options: [{ label: 'IAP feels solid', nextId: 'vid_dns_3mo' }],
  },

  vid_dns_deadbug: {
    id: 'vid_dns_deadbug',
    type: 'video',
    text: 'DNS Dead Bug',
    description: 'Dynamic sagittal stability. Moving limbs while maintaining the 3-month cylinder.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 reps per side',
    libraryCategory: 'Supine',
    options: [
      { label: 'Core holds strong', nextId: 'vid_dns_rolling' },
      { label: 'Core collapses / cannot maintain IAP', nextId: 'vid_dns_iap' },
    ],
  },

  vid_dns_rolling: {
    id: 'vid_dns_rolling',
    type: 'video',
    text: 'DNS Rolling Pattern (Supine to Side)',
    description:
      'The transition from back to side. Initiate the turn with your eyes and head, reaching across your body.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 slow rolls per side, 2x per day',
    libraryCategory: 'Supine',
    replaces: ['vid_dns_deadbug'],
    options: [
      { label: 'Smooth segmental turn, no pushing', nextId: 'vid_dns_low_oblique' },
      { label: 'Using momentum / back arching', nextId: 'vid_dns_deadbug' },
    ],
  },

  vid_dns_prone_3mo: {
    id: 'vid_dns_prone_3mo',
    type: 'video',
    text: 'DNS 3-Month Prone',
    description: 'Prone on elbows. Critical for cervical extension and scapular stability.',
    videoId: '1151048712',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths',
    libraryCategory: 'Prone',
    // FIX: Now reachable — used in cervical DNS progression after DNF
    options: [
      { label: 'Neck feels long & shoulders stable', nextId: 'vid_dns_low_oblique_cervical' },
      { label: 'Neck collapses / shoulders shrug', nextId: 'vid_dns_dnf' },
    ],
  },

  vid_dns_low_oblique: {
    id: 'vid_dns_low_oblique',
    type: 'video',
    text: 'DNS Low Oblique Sit',
    description: 'Side support. Connects the shoulder girdle to the hip through the oblique chain.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: 'Hold 30s per side',
    libraryCategory: 'Side Lying',
    options: [
      { label: 'Shoulder stable', nextId: 'vid_dns_bear_lumbar' },
      { label: 'Shoulder collapses / unstable', nextId: 'vid_dns_rolling' },
    ],
  },

  // FIX: vid_dns_bear now reachable — used as progression from vid_dns_bear_lumbar
  vid_dns_bear: {
    id: 'vid_dns_bear',
    type: 'video',
    text: 'DNS Bear Position (Advanced)',
    description: 'Quadruped stability with full load. Hands and toes, flat back, pure IAP lift.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths, 3x per day',
    libraryCategory: 'Quadruped',
    replaces: ['vid_dns_bear_lumbar'],
    options: [
      { label: 'Solid stability', nextId: 'vid_dns_star' },
      { label: 'Back rounds / cannot maintain', nextId: 'vid_dns_bear_lumbar' },
    ],
  },

  // FIX: vid_dns_star now reachable — used as progression from vid_dns_bear
  vid_dns_star: {
    id: 'vid_dns_star',
    type: 'video',
    text: 'DNS Star Pattern',
    description: 'Advanced side plank for lateral chain integration. Full body anti-rotation challenge.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 reps/side',
    libraryCategory: 'Side Lying',
    replaces: ['vid_dns_bear'],
    options: [
      { label: 'Lateral chain solid', nextId: 'start' },
      { label: 'Cannot maintain', nextId: 'vid_dns_bear' },
    ],
  },

  // FIX: vid_dns_rotation now reachable — used in thoracic mobility before bear
  vid_dns_rotation: {
    id: 'vid_dns_rotation',
    type: 'video',
    text: 'Thoracic Rotation',
    description: 'Thoracic mobility drill. Opens rotation before loading the bear position.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 reps/side, before quadruped work',
    libraryCategory: 'Side Lying',
    options: [
      { label: 'Rotation feels open', nextId: 'vid_dns_bear_lumbar' },
      { label: 'Still restricted', nextId: 'vid_dns_rotation' },
    ],
  },

  vid_dns_bear_lumbar: {
    id: 'vid_dns_bear_lumbar',
    type: 'video',
    text: 'DNS Bear Position',
    description:
      'Quadruped stability. Hands and knees, toes tucked. Lift knees 1 inch off floor using pure IAP. Flat back.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths, 2x per day',
    replaces: ['vid_dns_low_oblique'],
    libraryCategory: 'Quadruped',
    options: [
      { label: 'Solid stability', nextId: 'vid_dns_bear' },
      { label: 'Wrists hurt / back rounds', nextId: 'vid_dns_rotation' },
    ],
  },

  // =========================
  // MDT LIBRARY EXERCISES
  // =========================
  vid_mdt_pressup: {
    id: 'vid_mdt_pressup',
    type: 'video',
    text: 'MDT Prone Press-Up (EIL)',
    description: 'Lumbar extension in lying mobilization.',
    videoId: '1159492220',
    isPremium: false,
    prescriptionDuration: 48,
    prescriptionFrequency: '10 reps every waking hour',
    libraryCategory: 'MDT',
    flagLevel: 'green',
    options: [
      { label: '🟢 Green light — improving, centralizing, or abolishing', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — pain during that fully settles afterward (continue same dose)', nextId: 'lb_hold_24_48h' },
      { label: '🟡 Yellow — no change yet (increase volume / push end range)', nextId: 'lb_extension_dose_hold_24h' },
      { label: '🔴 Red — remaining worse after movement', nextId: 'lb_troubleshoot_remaining_worse' },
      { label: '🔴 Red — peripheralizing (symptoms spreading further down)', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  vid_mdt_side_glide: {
    id: 'vid_mdt_side_glide',
    type: 'video',
    text: 'Side Glide Correction',
    description: 'Shift correction drill. Do sets until you can cross midline.',
    videoId: '1151049975',
    libraryCategory: 'MDT',
    options: [
      { label: '🟢 Green light — shift correcting, can cross midline, symptoms improving', nextId: 'lb_soft_shift_confirmed' },
      { label: '🟡 Yellow — shift improving but not yet past midline (keep going)', nextId: 'lb_shift_hardness_test' },
      { label: '🔴 Red — no change in shift after consistent attempts, or symptoms spreading', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  vid_mdt_standing_ext: {
    id: 'vid_mdt_standing_ext',
    type: 'video',
    text: 'Standing Extension (EIS)',
    description: 'Lumbar extension in standing.',
    videoId: '1151050042',
    libraryCategory: 'MDT',
    flagLevel: 'green',
    options: [
      { label: '🟢 Green light — improving, centralizing, or abolishing', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — pain during that fully settles afterward (continue same dose)', nextId: 'lb_hold_24_48h' },
      { label: '🟡 Yellow — no change yet (increase volume / push end range)', nextId: 'lb_extension_dose_hold_24h' },
      { label: '🔴 Red — remaining worse after movement', nextId: 'lb_troubleshoot_remaining_worse' },
      { label: '🔴 Red — peripheralizing (symptoms spreading further down)', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  vid_mdt_prone_gradual: {
    id: 'vid_mdt_prone_gradual',
    type: 'video',
    text: 'Prone Lying → Gradual Extension',
    description: 'Start with prone lying, then progress slowly toward press-ups.',
    videoId: '1159492220',
    libraryCategory: 'MDT',
    options: [
      { label: '🟢 Green light — improving, centralizing, or abolishing', nextId: 'vid_mdt_pressup' },
      { label: '🟡 Yellow — pain during that fully settles afterward (continue same dose)', nextId: 'lb_hold_24_48h' },
      { label: '🟡 Yellow — no change yet (increase volume / push end range)', nextId: 'lb_extension_dose_hold_24h' },
      { label: '🔴 Red — remaining worse after movement', nextId: 'lb_troubleshoot_remaining_worse' },
      { label: '🔴 Red — peripheralizing (symptoms spreading further down)', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  vid_sciatic_slider: {
    id: 'vid_sciatic_slider',
    type: 'video',
    text: 'Sciatic Slider',
    description: 'Gentle nerve mobilization to reduce residual nerve tension after centralization.',
    videoId: '1159492220',
    libraryCategory: 'MDT',
    options: [
      { label: 'Better', nextId: 'vid_dns_3mo' },
      { label: 'No change', nextId: 'vid_dns_3mo' },
      { label: 'Worse', nextId: 'refer_out' },
    ],
  },

  // =========================
  // 1) LOWER BACK TREE
  // =========================
  low_back_1: {
    id: 'low_back_1',
    type: 'video',
    text: 'Lumbar Assessment',
    description:
      'Before anything else, we need to understand how your symptoms behave. What makes them worse? What makes them better? Your answers to these questions — not just where it hurts — are what guide your self-management. Watch this video, then answer a few questions about your pain behavior.',
    videoId: '1151049975',
    journeyName: 'Lumbar Rehab',
    options: [
      { label: 'I am in very acute pain (8–10/10), can barely move', nextId: 'lb_phase0a_entry' },
      { label: 'It is annoying/nagging (0–7/10), I can move around', nextId: 'lb_phase0b_entry' },
    ],
  },

  // ---------- Phase 0A: very acute ----------
  lb_phase0a_entry: {
    id: 'lb_phase0a_entry',
    type: 'question',
    text: 'Phase 0A: Safety first',
    description:
      'First, find the most comfortable position you can — lying face down is often the best option when pain is severe. Before we continue, we need to rule out a small number of symptoms that mean this program is not appropriate right now and you need to be seen in person. These include: numbness or tingling in the groin, inner thighs, or genitals (the area that would touch a bicycle seat), loss of control of your bladder or bowel, weakness that is getting progressively worse rather than staying the same, or symptoms following a significant fall or accident.',
    flagLevel: 'red',
    options: [
      { label: 'I have red flags / progressive weakness', nextId: 'refer_out_urgent' },
      { label: 'No red flags, just severe pain', nextId: 'lb_leg_symptom_check' },
    ],
  },

  // ---------- Phase 0B: nagging ----------
  lb_phase0b_entry: {
    id: 'lb_phase0b_entry',
    type: 'question',
    text: 'Phase 0B: Quick screen',
    description:
      'Good — the fact that you can move around means we have room to work. The goal right now is simple: find a movement direction that makes your symptoms better. Most people with back pain have one, even if they have not found it yet. Here is the key principle we work from: if we can change it, we can fix it. If your symptoms respond to movement or position — getting better or worse — we can exploit that. More of what helps, less of what does not, and give your body the conditions it needs to heal.',
    flagLevel: 'green',
    options: [
      { label: 'Continue', nextId: 'lb_leg_symptom_check' },
    ],
  },

  // ---------- Leg symptoms / nerve screen ----------
  // FIX: Split into radicular and non-radicular branches so they never cross
  lb_leg_symptom_check: {
    id: 'lb_leg_symptom_check',
    type: 'question',
    text: 'Do symptoms go below the knee?',
    description: 'Pain that travels below the knee tells us something important — it suggests the nerve root may be involved, not just the disc or surrounding tissue. This is still very manageable, but it changes which exercises we start with and how carefully we progress. Be precise here — thigh and buttock pain counts as local. Below the knee is a different category.',
    options: [
      { label: 'Yes, below the knee (sciatica / nerve pain)', nextId: 'lb_red_flag_check' },
      { label: 'No, back / buttock / thigh only', nextId: 'lb_non_radicular_path' },
    ],
  },

  // FIX: New node — non-radicular users bypass all nerve/leg questions
  lb_non_radicular_path: {
    id: 'lb_non_radicular_path',
    type: 'question',
    text: 'Good — local symptoms only',
    description:
      'Good news — pain that stays above the knee points to a more straightforward mechanical picture. Here is the key principle we work from: if we can change it, we can fix it. If your symptoms respond to movement or position — getting better or worse — we can exploit that. More of what helps, less of what does not, and give your body the conditions it needs to heal.',
    flagLevel: 'green',
    options: [
      { label: 'Continue to assessment', nextId: 'lb_lateral_shift_check' },
    ],
  },

  lb_red_flag_check: {
    id: 'lb_red_flag_check',
    type: 'question',
    text: 'Severity of leg symptoms?',
    description: 'There is an important distinction here. Are you avoiding certain movements because they hurt — but if you had to, you could do them? Or are you physically unable to perform tasks regardless of pain? True neurological weakness looks like: foot drop (dragging your foot when you walk), inability to climb stairs, difficulty lifting the front of your foot off the ground, or legs that simply give out. Pain that makes you not want to move is different from a leg that cannot move. Which describes you?',
    options: [
      { label: 'Numbness / weakness is significant or worsening', nextId: 'refer_out_urgent' },
      { label: 'Just pain / tingle, no true weakness', nextId: 'lb_lateral_shift_check' },
    ],
  },

  // ---------- Shift detection ----------
  lb_lateral_shift_check: {
    id: 'lb_lateral_shift_check',
    type: 'question',
    text: 'Look in a mirror. Is your upper body visibly shifted?',
    description: 'Stand in front of a mirror and look at your overall shape. Are you "I" shaped — shoulders stacked over your hips, relatively symmetrical? Or are you "C" shaped — your upper body visibly leaning or shifted to one side relative to your pelvis? A lateral shift is common with acute back pain and needs to be addressed before we move on. Be honest here — even a subtle shift matters.',
    options: [
      { label: 'Yes, I am shifted to one side', nextId: 'lb_shift_direction' },
      { label: 'No, I am straight / symmetrical', nextId: 'lb_mechanical_pattern' },
    ],
  },

  lb_shift_direction: {
    id: 'lb_shift_direction',
    type: 'question',
    text: 'Which way are you shifted?',
    description: 'From your perspective looking in the mirror.',
    options: [
      { label: 'My torso is shifted LEFT', nextId: 'lb_shift_leg_side_check_left' },
      { label: 'My torso is shifted RIGHT', nextId: 'lb_shift_leg_side_check_right' },
      { label: 'Not sure', nextId: 'lb_shift_hardness_test' },
    ],
  },

  lb_shift_leg_side_check_left: {
    id: 'lb_shift_leg_side_check_left',
    type: 'question',
    text: 'Which leg are symptoms traveling down?',
    description: 'This helps flag a more stubborn ipsilateral shift pattern.',
    options: [
      { label: 'Left leg', nextId: 'lb_shift_left_ipsilateral_flag' },
      { label: 'Right leg', nextId: 'lb_shift_ok_then_hardness' },
      { label: 'No leg symptoms (back / buttock only)', nextId: 'lb_shift_ok_then_hardness' },
    ],
  },

  lb_shift_left_ipsilateral_flag: {
    id: 'lb_shift_left_ipsilateral_flag',
    type: 'result',
    text: 'Ipsilateral shift pattern (more stubborn)',
    description:
      'Your torso is shifted LEFT and symptoms are also LEFT-sided. This tends to be more stubborn. Proceed carefully — if symptoms spread further down the leg, stop and seek in-person evaluation.',
    flagLevel: 'yellow',
    flagText: 'Stubborn ipsilateral pattern — proceed carefully',
    options: [
      { label: 'Proceed to shift correction', nextId: 'lb_shift_hardness_test' },
      { label: 'I am getting worse / symptoms spreading', nextId: 'refer_out' },
    ],
  },

  lb_shift_leg_side_check_right: {
    id: 'lb_shift_leg_side_check_right',
    type: 'question',
    text: 'Which leg are symptoms traveling down?',
    description: 'This helps flag a more stubborn ipsilateral shift pattern.',
    options: [
      { label: 'Right leg', nextId: 'lb_shift_right_ipsilateral_flag' },
      { label: 'Left leg', nextId: 'lb_shift_ok_then_hardness' },
      { label: 'No leg symptoms (back / buttock only)', nextId: 'lb_shift_ok_then_hardness' },
    ],
  },

  lb_shift_right_ipsilateral_flag: {
    id: 'lb_shift_right_ipsilateral_flag',
    type: 'result',
    text: 'Ipsilateral shift pattern (more stubborn)',
    description:
      'Your torso is shifted RIGHT and symptoms are also RIGHT-sided. This tends to be more stubborn. Proceed carefully — if symptoms spread further down the leg, stop and seek in-person evaluation.',
    flagLevel: 'yellow',
    flagText: 'Stubborn ipsilateral pattern — proceed carefully',
    options: [
      { label: 'Proceed to shift correction', nextId: 'lb_shift_hardness_test' },
      { label: 'I am getting worse / symptoms spreading', nextId: 'refer_out' },
    ],
  },

  lb_shift_ok_then_hardness: {
    id: 'lb_shift_ok_then_hardness',
    type: 'result',
    text: 'Shift noted',
    description: 'Next step: test whether the shift is "soft" (correctable) or "hard" (blocked).',
    flagLevel: 'yellow',
    options: [{ label: 'Test if you can cross midline', nextId: 'lb_shift_hardness_test' }],
  },

  lb_shift_hardness_test: {
    id: 'lb_shift_hardness_test',
    type: 'question',
    text: 'Test your shift: Can you correct it past midline?',
    description: 'Gently push your hips toward the opposite side and try to go past neutral — not just straight, but slightly past midline — and hold that position. A soft shift means you can get there and maintain it — it might be uncomfortable or it might actually feel relieving, but you can achieve and hold past midline. A hard shift means you literally cannot get past midline and stay there — not just because of pain, but because your body will not allow it. Which describes you?',
    options: [
      { label: 'Yes, I can cross midline', nextId: 'lb_soft_shift_confirmed' },
      { label: 'No, it feels hard / blocked', nextId: 'lb_hard_shift_plan' },
    ],
  },

  lb_soft_shift_confirmed: {
    id: 'lb_soft_shift_confirmed',
    type: 'result',
    text: 'Soft Shift (Correctable)',
    description: 'Good news — it\'s correctable. Next: test your extension response.',
    flagLevel: 'green',
    options: [{ label: 'Test extension response', nextId: 'lb_extension_tolerance_check' }],
  },

  lb_hard_shift_plan: {
    id: 'lb_hard_shift_plan',
    type: 'question',
    text: 'Hard shift (blocked)',
    description:
      'Start with side glides until you can cross midline. If you stall, we may need a blend: side glide + extension bias.',
    flagLevel: 'yellow',
    options: [
      { label: 'Start side glides now', nextId: 'vid_mdt_side_glide' },
      { label: 'I already tried side glides and stalled', nextId: 'lb_hard_shift_fallback' },
    ],
  },

  lb_hard_shift_fallback: {
    id: 'lb_hard_shift_fallback',
    type: 'question',
    text: 'Fallback for stalled hard shift',
    description:
      'Rarely, some people need a blend: side glide + extension bias (standing or prone). Stop if pain spreads further down the leg.',
    flagLevel: 'yellow',
    options: [
      { label: 'Try blended shift + extension', nextId: 'lb_shifted_extension_intro' },
      { label: 'This is worsening / spreading', nextId: 'refer_out' },
    ],
  },

  lb_shifted_extension_intro: {
    id: 'lb_shifted_extension_intro',
    type: 'result',
    text: 'Shift + Extension Blend',
    description:
      'Do a small set of side glides, then test gentle extension. Goal: regain midline + centralization. If pain moves further down the leg, stop.',
    flagLevel: 'yellow',
    options: [
      { label: 'Test extension tolerance now', nextId: 'lb_extension_tolerance_check' },
      { label: 'Stop and refer out', nextId: 'refer_out' },
    ],
  },

  // ---------- Mechanical pattern ----------
  lb_mechanical_pattern: {
    id: 'lb_mechanical_pattern',
    type: 'question',
    text: 'What makes it worse?',
    description: 'What consistently aggravates your symptoms most? This helps us decide where to start and how aggressively to load. There are no wrong answers.',
    options: [
      { label: 'Sitting or bending forward', nextId: 'lb_extension_tolerance_check' },
      { label: 'Standing or walking', nextId: 'lb_extension_caution' },
      { label: 'Load — lifting or carrying weight', nextId: 'lb_extension_caution' },
    ],
  },

  lb_extension_caution: {
    id: 'lb_extension_caution',
    type: 'result',
    text: 'Proceeding with caution — gentle extension first',
    description:
      'We are still going to test extension — but we will start gently, in a supported position, without pushing to end range initially. Here is the rule that guides everything from this point forward: pain during a movement is acceptable and does not mean stop. What matters is whether you remain worse after the movement than you were before. If symptoms settle back to baseline within a few minutes of finishing, we continue. If you are consistently worse afterwards, we change direction.',
    flagLevel: 'yellow',
    options: [
      { label: 'Start gentle prone extension', nextId: 'vid_mdt_prone_gradual' },
    ],
  },

  lb_extension_tolerance_check: {
    id: 'lb_extension_tolerance_check',
    type: 'question',
    text: 'Extension tolerance check',
    description:
      'If very acute, start micro-dosing or static prone. If tolerable, start standing extension or press-ups.',
    options: [
      { label: 'Before starting — show me how to read my symptoms', nextId: 'lb_traffic_light_explainer' },
      { label: 'Extension feels good or freeing', nextId: 'vid_mdt_standing_ext' },
      { label: 'Extension is painful / blocked (need to go slow)', nextId: 'vid_mdt_prone_gradual' },
    ],
  },

  lb_extension_dose_hold_24h: {
    id: 'lb_extension_dose_hold_24h',
    type: 'result',
    text: 'Hold the line (24–48h)',
    description:
      'If you are improving even without perfect centralization, that is still a green / yellow light. Stay consistent. Do NOT half-dose. Re-check tomorrow.',
    flagLevel: 'green',
    options: [
      { label: 'Continue extension only for now', nextId: 'lb_post_mdt_check' },
      { label: 'Making steady progress — hold another day', nextId: 'lb_hold_24_48h' },
      { label: 'I am worse / spreading', nextId: 'refer_out' },
    ],
  },

  lb_post_mdt_check: {
    id: 'lb_post_mdt_check',
    type: 'question',
    text: 'After your extension work — what happened to your symptoms?',
    description: 'Centralization means symptoms are moving toward the spine, the painful area is getting smaller, or peripheral symptoms are retreating. This is the goal — even partial centralization is a green light.',
    flagLevel: 'green',
    options: [
      { label: 'Centralized — pain moved toward spine / area got smaller', nextId: 'vid_dns_3mo' },
      { label: 'Partial — somewhat better but not fully centralized yet', nextId: 'lb_extension_dose_hold_24h' },
      { label: 'No change after consistent dosing', nextId: 'lb_troubleshoot_intro' },
      { label: 'Worse — symptoms spreading outward or further down', nextId: 'lb_troubleshoot_intro' },
    ],
  },

  // FIX: Radicular-only question — only reached if user confirmed leg symptoms above
  lb_nerve_check_post_mdt: {
    id: 'lb_nerve_check_post_mdt',
    type: 'question',
    text: 'After extension: any residual leg tightness or nerve symptoms?',
    description:
      'Even after centralization, some nerve tension can linger. This is normal and addressable.',
    options: [
      { label: 'Yes — still some nerve tightness down the leg', nextId: 'vid_sciatic_slider' },
      { label: 'No — all symptoms are now local / resolved', nextId: 'vid_dns_3mo' },
    ],
  },

  dns_sagittal_progression_choice: {
    id: 'dns_sagittal_progression_choice',
    type: 'question',
    text: 'Stabilization Progression: Sagittal Plane',
    description:
      'You have mastered the static 3-month position. Now we challenge your stability while moving your limbs.',
    options: [
      { label: 'Start Dynamic Stability (Dead Bug)', nextId: 'vid_dns_deadbug' },
      // FIX: Regression option added
      { label: 'I am struggling with IAP / breathing', nextId: 'vid_dns_iap' },
    ],
  },

  // =========================
  // 2) NECK TREE
  // =========================
  neck_1: {
    id: 'neck_1',
    type: 'video',
    text: 'Cervical Assessment',
    description:
      'Watch this video to understand how to categorize your neck pain. Determine if it is local mechanical pain or nerve involvement.',
    videoId: '1151051123',
    journeyName: 'Cervical Rehab',
    options: [
      { label: 'Localized to neck / upper trap', nextId: 'neck_directional_screen' },
      { label: 'Radiating down arm', nextId: 'neck_red_flag_check' },
    ],
  },

  neck_red_flag_check: {
    id: 'neck_red_flag_check',
    type: 'question',
    text: 'Any of the following?',
    description: 'These signs suggest spinal cord involvement or serious pathology and require in-person evaluation.',
    flagLevel: 'red',
    options: [
      {
        label: 'Yes — any of: hand clumsiness / dropping things, balance or gait changes, electric shock down spine with chin tuck (Lhermitte\'s), bilateral arm symptoms, progressive weakness, bowel/bladder changes',
        nextId: 'refer_out_urgent',
      },
      { label: 'No — pain/tingle in one arm only, no neurologic signs', nextId: 'neck_directional_screen' },
    ],
  },

  neck_directional_screen: {
    id: 'neck_directional_screen',
    type: 'question',
    text: 'What tends to aggravate you most?',
    description:
      'We usually test retraction + extension together unless symptoms are very acute or you feel blocked/unsafe extending.',
    options: [
      { label: 'Looking down / slouched positions', nextId: 'neck_ret_only_gate' },
      { label: 'Looking up clearly worsens symptoms', nextId: 'neck_extension_intolerant' },
      { label: 'Not sure', nextId: 'neck_ret_only_gate' },
      { label: 'Extension clearly worsens, flexion clearly helps (rare)', nextId: 'cs_flexion_exception' },
    ],
  },

  cs_flexion_exception: {
    id: 'cs_flexion_exception',
    type: 'result',
    text: 'Flexion as Directional Preference (Rare)',
    description: 'Flexion as a true directional preference is extremely rare in the cervical spine. Before proceeding, confirm: (1) retraction/extension was genuinely tried at true end range for at least 48 hours, (2) symptoms clearly and consistently worsen with extension and improve with flexion. If both are true, proceed cautiously with chin-to-chest end range loading.',
    flagLevel: 'yellow',
    flagText: 'Rare exception — confirm extension was truly trialed first',
    options: [
      { label: 'Confirmed — extension trialed properly, flexion clearly helps', nextId: 'vid_dns_dnf' },
      { label: 'Not sure — go back and retry extension properly', nextId: 'cs_troubleshoot_technique' },
    ],
  },

  neck_extension_intolerant: {
    id: 'neck_extension_intolerant',
    type: 'result',
    text: 'Extension intolerance',
    description:
      'If looking up is clearly provocative, we start with neutral stabilization and gentle control instead of forcing extension.',
    flagLevel: 'yellow',
    options: [{ label: 'Start Stabilization', nextId: 'vid_dns_dnf' }],
  },

  neck_ret_only_gate: {
    id: 'neck_ret_only_gate',
    type: 'question',
    text: 'Before we test extension',
    description:
      'If you are very acute, feel blocked, or do not feel safe extending, start with retraction only. Otherwise, test retraction + extension.',
    options: [
      { label: 'Very acute / blocked / not safe to extend', nextId: 'vid_mdt_retraction' },
      { label: 'I can try retraction + extension', nextId: 'vid_mdt_ret_ext_standard' },
    ],
  },

  vid_mdt_retraction: {
    id: 'vid_mdt_retraction',
    type: 'video',
    text: 'Cervical Retraction (Regression / On-ramp)',
    description:
      'Start here only if you are very acute or blocked. As soon as tolerated, progress to retraction + extension.',
    videoId: '1151050180',
    prescriptionFrequency: '10 reps every 2 hours',
    libraryCategory: 'MDT',
    flagLevel: 'yellow',
    options: [
      { label: '🟢 Green light — improving, centralizing, ready to add extension', nextId: 'vid_mdt_ret_ext_standard' },
      { label: '🟡 Yellow — pain during that fully settles afterward (continue same dose)', nextId: 'vid_mdt_ret_overpressure' },
      { label: '🟡 Yellow — no change yet (increase volume / push end range)', nextId: 'vid_mdt_ret_overpressure' },
      { label: '🔴 Red — remaining worse after movement', nextId: 'cs_troubleshoot_intro' },
      { label: '🔴 Red — peripheralizing (symptoms spreading further down arm)', nextId: 'cs_troubleshoot_intro' },
    ],
  },

  vid_mdt_ret_overpressure: {
    id: 'vid_mdt_ret_overpressure',
    type: 'video',
    text: 'Retraction + Overpressure',
    description:
      'Add gentle hand pressure to the end range of retraction. If this helps, re-test retraction + extension.',
    videoId: '1151050180',
    libraryCategory: 'MDT',
    options: [
      { label: 'Better', nextId: 'vid_mdt_ret_ext_standard' },
      { label: 'No change', nextId: 'vid_mdt_ret_ext_gentle' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  vid_mdt_ret_ext_standard: {
    id: 'vid_mdt_ret_ext_standard',
    type: 'video',
    text: 'Retraction + Extension (Seated/Standing)',
    description:
      'The primary test when tolerated. Aim for end-range without peripheralizing symptoms.',
    videoId: '1151050180',
    libraryCategory: 'MDT',
    flagLevel: 'green',
    options: [
      { label: '🟢 Green light — improving, centralizing, or arm symptoms retreating toward neck', nextId: 'neck_post_mdt_check' },
      { label: '🟡 Yellow — pain during that fully settles afterward (continue same dose)', nextId: 'neck_hold_24_48h' },
      { label: '🟡 Yellow — no change yet (increase volume / push end range)', nextId: 'neck_hold_24_48h' },
      { label: '🔴 Red — remaining worse after movement', nextId: 'cs_troubleshoot_intro' },
      { label: '🔴 Red — peripheralizing (symptoms spreading further down arm)', nextId: 'cs_troubleshoot_intro' },
    ],
  },

  neck_hold_24_48h: {
    id: 'neck_hold_24_48h',
    type: 'result',
    text: 'Hold the line (24–48 hours)',
    description:
      'If you feel meaningfully better (even without perfect centralization), stay consistent and do not half-dose. Re-check tomorrow.',
    flagLevel: 'green',
    options: [
      { label: 'Centralizing — symptoms retreating toward neck', nextId: 'neck_post_mdt_check' },
      { label: 'Worse / spreading further down arm', nextId: 'refer_out' },
    ],
  },

  neck_post_mdt_check: {
    id: 'neck_post_mdt_check',
    type: 'question',
    text: 'After your cervical retraction/extension work — what happened to your symptoms?',
    description: 'Centralization means arm symptoms are retreating toward the neck, the painful area is getting smaller, or neck pain is replacing arm pain. Even partial centralization is a green light.',
    flagLevel: 'green',
    options: [
      { label: 'Centralized — arm symptoms retreating / area got smaller', nextId: 'neck_hold_then_stabilize' },
      { label: 'Partial — somewhat better but not fully centralized yet', nextId: 'neck_hold_24_48h' },
      { label: 'No change after consistent dosing', nextId: 'cs_troubleshoot_intro' },
      { label: 'Worse — symptoms spreading further down arm', nextId: 'cs_troubleshoot_intro' },
    ],
  },

  neck_recheck_after_hold: {
    id: 'neck_recheck_after_hold',
    type: 'question',
    text: 'Re-check after 24–48 hours',
    description: 'After staying consistent, what happened?',
    options: [
      { label: 'Centralizing / clearly better', nextId: 'neck_hold_then_stabilize' },
      { label: 'Still somewhat better (not perfect)', nextId: 'neck_hold_then_stabilize' },
      { label: 'Stalled / no longer improving', nextId: 'cs_troubleshoot_intro' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  neck_hold_then_stabilize: {
    id: 'neck_hold_then_stabilize',
    type: 'result',
    text: 'Good response',
    description:
      'Keep your directional preference wins while building stability so symptoms don\'t return.',
    flagLevel: 'green',
    options: [{ label: 'Start Stabilization (DNS)', nextId: 'vid_dns_dnf' }],
  },

  vid_mdt_ret_ext_gentle: {
    id: 'vid_mdt_ret_ext_gentle',
    type: 'video',
    text: 'Retraction + Extension (Supine, Gentle)',
    description:
      'Use this if seated/standing feels too intense. Gentle exposure to end-range in a supported position.',
    videoId: '1151050108',
    prescriptionFrequency: '10 gentle reps every 2 hours',
    prescriptionDuration: 24,
    options: [
      { label: 'Better / gaining range', nextId: 'vid_mdt_ret_ext_gentle_phase2' },
      { label: 'No improvement / still blocked', nextId: 'vid_mdt_cervical_troubleshoot' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  vid_mdt_ret_ext_gentle_phase2: {
    id: 'vid_mdt_ret_ext_gentle_phase2',
    type: 'video',
    text: 'Continue: Gentle Retraction + Extension (Day 2)',
    description: 'Continue another 24 hours, then re-test upright end-range.',
    videoId: '1151050108',
    prescriptionFrequency: '10 gentle reps every 2 hours',
    prescriptionDuration: 24,
    replaces: ['vid_mdt_ret_ext_gentle'],
    options: [
      { label: 'Clearly better / centralized', nextId: 'neck_hold_then_stabilize' },
      { label: 'Stalled / blocked returned', nextId: 'vid_mdt_cervical_troubleshoot' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  vid_mdt_cervical_troubleshoot: {
    id: 'vid_mdt_cervical_troubleshoot',
    type: 'video',
    text: 'Troubleshooting: Traction & Static Extension',
    description:
      'If progress stalls, try traction/static extension patterns. Stop if symptoms spread further down the arm.',
    videoId: '1151050180',
    options: [
      { label: 'Improved / more centralized', nextId: 'neck_hold_then_stabilize' },
      { label: 'No change', nextId: 'refer_out' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  // =========================
  // DNS CERVICAL NODES
  // =========================
  vid_dns_low_oblique_cervical: {
    id: 'vid_dns_low_oblique_cervical',
    type: 'video',
    text: 'DNS Low Oblique (Cervical focus)',
    description: 'Side support with cervical neutral. Connects shoulder girdle stability to cervical control.',
    videoId: '1151048835',
    isPremium: true,
    libraryCategory: 'Side Lying',
    options: [
      { label: 'Shoulder and neck stable', nextId: 'vid_dns_dnf' },
      { label: 'Neck collapses / shoulder unstable', nextId: 'vid_dns_prone_3mo' },
    ],
  },

  // FIX: neck_nerve_check_post_mdt — CRITICAL missing node now defined
  neck_nerve_check_post_mdt: {
    id: 'neck_nerve_check_post_mdt',
    type: 'question',
    text: 'After cervical work: any residual arm or hand symptoms?',
    description:
      'Even after centralization, some nerve tension can linger in the arm. This is normal and addressable.',
    options: [
      { label: 'Yes — still some nerve symptoms in arm / hand', nextId: 'neck_nerve_slider' },
      { label: 'No — all symptoms are now local / resolved', nextId: 'neck_hold_then_stabilize' },
    ],
  },

  // New node to support neck_nerve_check_post_mdt
  neck_nerve_slider: {
    id: 'neck_nerve_slider',
    type: 'video',
    text: 'Median / Ulnar Nerve Slider',
    description:
      'Gentle upper limb nerve mobilization to reduce residual arm and hand tension after cervical centralization.',
    videoId: '1151050180',
    libraryCategory: 'MDT',
    prescriptionFrequency: '10 slow reps per side, 2x per day',
    options: [
      { label: 'Better — arm symptoms reducing', nextId: 'neck_hold_then_stabilize' },
      { label: 'No change', nextId: 'neck_hold_then_stabilize' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  vid_dns_dnf: {
    id: 'vid_dns_dnf',
    type: 'video',
    text: 'Deep Neck Flexor (DNF) Control',
    description: 'Foundational cervical stabilization. Chin tuck + IAP in supine. The cervical equivalent of the 3-month position.',
    videoId: '1151050180',
    isPremium: true,
    prescriptionFrequency: '10 reps, 2x per day',
    libraryCategory: 'Supine',
    options: [
      { label: 'DNF activating well', nextId: 'vid_dns_prone_3mo' },
      { label: 'Cannot find the movement / neck cramping', nextId: 'vid_dns_dnf' },
    ],
  },

  // =========================
  // TRAFFIC LIGHT EXPLAINER
  // =========================
  lb_traffic_light_explainer: {
    id: 'lb_traffic_light_explainer',
    type: 'result',
    text: 'How to read your symptoms',
    description: `🟢 GREEN LIGHT — three patterns all count:
- Improving — symptoms are in the same place but less intense, fading, or easier to ignore
- Centralizing — symptoms are moving toward the spine. Foot → calf → thigh → back is progress, even if the back feels more intense temporarily. A new or increased central pain while peripheral symptoms clear is still a green light
- Abolishing — symptoms are gone or nearly gone
Important: If you had leg symptoms and now have more back pain but less leg pain — that is not getting worse. That is centralization. That is exactly what we are looking for.

🟡 YELLOW LIGHT — two patterns, different instructions:
- Pain during movement that fully settles afterward — continue at the same dose. Your body is responding, give it time
- No change yet — increase your volume or push closer to true end range. Most non-responders are under-dosing or stopping short of end range

🔴 RED LIGHT — either of these means stop:
- You remain worse after the movement than you were before it started. If symptoms do not settle back to baseline within a few minutes of finishing, this direction needs to change
- Peripheralization — symptoms spreading further from the spine. Pain or numbness moving further down the leg or arm, or appearing in a new area below where it was before. This is the opposite of what we want and means we need to reassess immediately`,
    flagLevel: 'green',
    options: [
      { label: 'I understand — start my first exercise', nextId: 'vid_mdt_standing_ext' },
      { label: 'I need to start prone (more acute / blocked)', nextId: 'vid_mdt_prone_gradual' },
    ],
  },

  // =========================
  // LUMBAR TROUBLESHOOTING HIERARCHY
  // =========================
  lb_troubleshoot_remaining_worse: {
    id: 'lb_troubleshoot_remaining_worse',
    type: 'question',
    text: 'Troubleshooting — Remaining Worse',
    description: 'You are consistently worse after the movement. We are going to work through a hierarchy of options before considering referral. Most people find their response changes with one of these adjustments.',
    flagLevel: 'yellow',
    options: [
      { label: 'Step 1 — Recheck technique: am I truly at end range?', nextId: 'lb_troubleshoot_technique_check' },
      { label: 'I have rechecked technique — move to Step 2', nextId: 'lb_troubleshoot_sustained' },
      { label: 'I have tried Steps 1 and 2 — move to Step 3', nextId: 'vid_mdt_supine_knees_side' },
      { label: 'I have tried all steps — still no improvement', nextId: 'refer_out' },
    ],
  },

  lb_troubleshoot_technique_check: {
    id: 'lb_troubleshoot_technique_check',
    type: 'result',
    text: 'End Range Technique Check',
    description: 'True end range extension means your elbows are fully straight, your hips stay on the surface, and you are holding the top position for a full breath before lowering. Most people stop 80% of the way there. If you have been stopping short — try full end range for 24 hours before moving to the next step.',
    flagLevel: 'yellow',
    options: [
      { label: '🟢 Green light — improving with true end range', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — no change at true end range', nextId: 'lb_troubleshoot_sustained' },
      { label: '🔴 Red — still remaining worse', nextId: 'lb_troubleshoot_sustained' },
      { label: '🔴 Red — peripheralizing', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  lb_troubleshoot_sustained: {
    id: 'lb_troubleshoot_sustained',
    type: 'result',
    text: 'Sustained Hold vs Repeated Movement',
    description: 'Instead of doing repetitions, try holding end range extension for 30-60 seconds. Some presentations respond to sustained loading rather than repeated movement. Do 3-5 holds per session, every 2 hours. Give this 24 hours before moving on.',
    flagLevel: 'yellow',
    options: [
      { label: '🟢 Green light — improving with sustained hold', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — no change', nextId: 'vid_mdt_supine_knees_side' },
      { label: '🔴 Red — remaining worse', nextId: 'vid_mdt_supine_knees_side' },
      { label: '🔴 Red — peripheralizing', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  vid_mdt_supine_knees_side: {
    id: 'vid_mdt_supine_knees_side',
    type: 'video',
    text: 'Supine Knees to the Side',
    description: 'Lying on your back, knees bent, let both knees fall toward the symptomatic side. This position is often a back-door route into extension for people who are not yet responding to direct extension loading. Hold for 30-60 seconds or do slow repetitions. If this helps, we will progress back to extension.',
    videoId: 'PLACEHOLDER',
    libraryCategory: 'MDT',
    flagLevel: 'yellow',
    options: [
      { label: '🟢 Green light — improving or centralizing', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — no change', nextId: 'lb_troubleshoot_crooked' },
      { label: '🔴 Red — remaining worse', nextId: 'lb_troubleshoot_crooked' },
      { label: '🔴 Red — peripheralizing', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  lb_troubleshoot_crooked: {
    id: 'lb_troubleshoot_crooked',
    type: 'video',
    text: 'Crooked Press-Up and Overpressure Options',
    description: 'When standard press-ups are not working, two adjustments often help: (1) Crooked press-up — shift your hips away from the painful side before pressing up, creating a lateral bias in the extension. (2) Overpressure — use your hands to gently push your lower back further into extension at end range. Try each for 24 hours.',
    videoId: 'PLACEHOLDER',
    libraryCategory: 'MDT',
    flagLevel: 'yellow',
    options: [
      { label: '🟢 Green light — improving or centralizing', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — no change', nextId: 'lb_troubleshoot_side_glide_fallback' },
      { label: '🔴 Red — remaining worse', nextId: 'lb_troubleshoot_side_glide_fallback' },
      { label: '🔴 Red — peripheralizing', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  lb_troubleshoot_side_glide_fallback: {
    id: 'lb_troubleshoot_side_glide_fallback',
    type: 'result',
    text: 'Side Glides as Troubleshooting',
    description: 'Even without a visible lateral shift, side glides can sometimes unlock a stuck extension response. Try side glides toward the non-painful side for 24 hours, then retest extension.',
    flagLevel: 'yellow',
    options: [
      { label: '🟢 Green light — extension now working', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Yellow — no change', nextId: 'lb_troubleshoot_flexion_last' },
      { label: '🔴 Red — remaining worse or peripheralizing', nextId: 'lb_troubleshoot_peripheralizing' },
    ],
  },

  lb_troubleshoot_flexion_last: {
    id: 'lb_troubleshoot_flexion_last',
    type: 'result',
    text: 'Flexion — Last Resort',
    description: 'Flexion as a directional preference is rare — seen in less than 1% of cases in clinical practice. We are trying it here only because all extension-based options have been exhausted. If flexion clearly and consistently helps while extension clearly worsens, this may be your direction. Proceed cautiously and monitor closely.',
    flagLevel: 'yellow',
    flagText: 'Rare exception — all extension options exhausted',
    options: [
      { label: '🟢 Green light — flexion clearly helping', nextId: 'vid_dns_3mo' },
      { label: '🟡 Yellow — no clear direction found', nextId: 'refer_out' },
      { label: '🔴 Red — worse with everything', nextId: 'refer_out' },
    ],
  },

  lb_troubleshoot_peripheralizing: {
    id: 'lb_troubleshoot_peripheralizing',
    type: 'question',
    text: 'Peripheralization — Shorter Leash Protocol',
    description: 'Symptoms are spreading further from the spine. This requires a more cautious approach. We will try up to 3 adjustments. If symptoms are not returning toward baseline — or if you develop any new weakness — stop immediately and seek in-person evaluation.',
    flagLevel: 'red',
    flagText: 'Peripheralization — monitor closely',
    options: [
      { label: 'Try supine knees to the side (toward symptomatic side)', nextId: 'lb_peripheralizing_attempt_1' },
      { label: 'I have increasing weakness or cannot bear weight', nextId: 'refer_out_urgent' },
    ],
  },

  lb_peripheralizing_attempt_1: {
    id: 'lb_peripheralizing_attempt_1',
    type: 'video',
    text: 'Peripheralizing — Attempt 1: Supine Knees to Side',
    description: 'Try supine knees to the symptomatic side. After each attempt, the key question is: are symptoms returning toward baseline, staying the same further out, or continuing to spread? Any new or increasing weakness is an immediate stop sign.',
    videoId: 'PLACEHOLDER',
    flagLevel: 'red',
    options: [
      { label: '🟢 Symptoms returning toward baseline / centralizing', nextId: 'lb_post_mdt_check' },
      { label: '🟡 Stayed peripheral but not spreading further', nextId: 'lb_peripheralizing_attempt_2' },
      { label: '🔴 Continuing to spread / worsening', nextId: 'refer_out' },
      { label: '🔴 New or increasing weakness', nextId: 'refer_out_urgent' },
    ],
  },

  lb_peripheralizing_attempt_2: {
    id: 'lb_peripheralizing_attempt_2',
    type: 'result',
    text: 'Peripheralizing — Attempt 2: Sustained Positioning',
    description: 'Find the position that is least provocative — often prone lying without extension — and hold it for 5-10 minutes. The goal is to get symptoms back toward baseline before trying any directional loading. Do not push into pain.',
    flagLevel: 'red',
    options: [
      { label: '🟢 Symptoms returning toward baseline', nextId: 'lb_troubleshoot_remaining_worse' },
      { label: '🟡 Stayed peripheral but stable', nextId: 'lb_peripheralizing_attempt_3' },
      { label: '🔴 Continuing to spread', nextId: 'refer_out' },
      { label: '🔴 New or increasing weakness', nextId: 'refer_out_urgent' },
    ],
  },

  lb_peripheralizing_attempt_3: {
    id: 'lb_peripheralizing_attempt_3',
    type: 'result',
    text: 'Peripheralizing — Attempt 3: Final Check',
    description: 'This is the third attempt to bring symptoms back toward baseline. If symptoms are still peripheral after this, in-person evaluation is recommended. You have done everything right — some presentations need hands-on assessment that this program cannot provide.',
    flagLevel: 'red',
    options: [
      { label: '🟢 Symptoms finally returning toward baseline', nextId: 'lb_troubleshoot_remaining_worse' },
      { label: 'No improvement — symptoms still peripheral', nextId: 'refer_out' },
      { label: '🔴 New or increasing weakness at any point', nextId: 'refer_out_urgent' },
    ],
  },
};

// =========================
// VALIDATION (dev only)
// =========================
function validateDecisionTree(tree: Record<string, DecisionNode>) {
  const keys = new Set(Object.keys(tree));
  const missingNext: Array<{ from: string; nextId: string; label: string }> = [];

  for (const [key, node] of Object.entries(tree)) {
    for (const opt of node.options ?? []) {
      if (!keys.has(opt.nextId)) {
        missingNext.push({ from: key, nextId: opt.nextId, label: opt.label });
      }
    }
  }

  if (missingNext.length) {
    console.groupCollapsed('❌ DecisionTree validation issues');
    console.group('Missing nextId targets');
    for (const m of missingNext) {
      console.error(`From "${m.from}" -> nextId "${m.nextId}" (label: "${m.label}")`);
    }
    console.groupEnd();
    console.groupEnd();
  } else {
    console.log('✅ DecisionTree looks consistent.');
  }
}

if (import.meta.env.DEV) {
  validateDecisionTree(DECISION_TREE);
}