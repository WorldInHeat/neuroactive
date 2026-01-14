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
  lb_unlock_checkin_required: {
    id: 'lb_unlock_checkin_required',
    type: 'result',
    text: 'Quick check-in required',
    description:
      'Before you progress, do today’s Daily Check-in on your Dashboard. This keeps your plan tight and prevents half-dosing.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  lb_hold_24_48h: {
    id: 'lb_hold_24_48h',
    type: 'result',
    text: 'Hold the line (24–48 hours)',
    description:
      'If you’re feeling better, even if leg symptoms lag behind, that’s still progress. Stay consistent with your current plan for 24–48 hours before adding new drills.',
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
    options: [
      { label: 'Continue', nextId: 'vid_dns_3mo' },
      { label: 'I feel worse / symptoms spreading', nextId: 'refer_out' },
    ],
  },
  // =========================
  // TROUBLESHOOTING NODES
  // =========================

  // --- Lumbar troubleshooting ---
  lb_troubleshoot_intro: {
    id: 'lb_troubleshoot_intro',
    type: 'video',
    text: 'Lumbar Troubleshooting (Next Best Options)',
    description:
      'If extension work causes peripheralization or stalls, try these two adjustments before you stop: (1) sustained positioning + lateral bias options, then (2) traction if needed.',
    // TODO: replace with your real “long troubleshooting” video id
    videoId: '1151049975',
    journeyTier: 'A',
    options: [
      { label: 'Tried these options and improved / centralized', nextId: 'lb_nerve_check_post_mdt' },
      { label: 'No change / still peripheralizing → Try traction', nextId: 'lb_troubleshoot_traction' },
    ],
  },

  lb_troubleshoot_traction: {
    id: 'lb_troubleshoot_traction',
    type: 'video',
    text: 'Lumbar Traction Option',
    description:
      'Traction can help when symptoms will not respond to spinal movement testing. If symptoms worsen or travel further down the leg, stop.',
    // TODO: replace with real traction video id
    videoId: '1151049975',
    journeyTier: 'A',
    options: [
      { label: 'Improved / centralized', nextId: 'lb_nerve_check_post_mdt' },
      { label: 'No change / worse → Refer out', nextId: 'refer_out' },
    ],
  },

  // --- Cervical troubleshooting ---
  cs_troubleshoot_intro: {
    id: 'cs_troubleshoot_intro',
    type: 'video',
    text: 'Cervical Troubleshooting (Next Best Options)',
    description:
      'If retraction/extension causes symptoms to move further down the arm, try: (1) sustained options + lateral bias, then (2) traction if needed.',
    // TODO: replace with your real “long troubleshooting” video id
    videoId: '1151051123',
    journeyTier: 'A',
    options: [
      { label: 'Improved / centralized', nextId: 'neck_nerve_check_post_mdt' },
      { label: 'No change / still peripheralizing → Try traction', nextId: 'cs_troubleshoot_traction' },
    ],
  },

  cs_troubleshoot_traction: {
    id: 'cs_troubleshoot_traction',
    type: 'video',
    text: 'Cervical Traction Option',
    description:
      'If movement testing fails, traction can sometimes reduce peripheral symptoms. If weakness is worsening or symptoms escalate, stop and seek in-person evaluation.',
    // TODO: replace with real traction video id
    videoId: '1151051123',
    journeyTier: 'A',
    options: [
      { label: 'Improved / centralized', nextId: 'neck_nerve_check_post_mdt' },
      { label: 'No change / worse → Refer out', nextId: 'refer_out' },
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
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  refer_out_urgent: {
    id: 'refer_out_urgent',
    type: 'result',
    text: 'Urgent evaluation recommended',
    description:
      'Symptoms like significant weakness, progressive numbness, bowel/bladder changes, severe unrelenting pain, or loss of coordination warrant urgent medical evaluation.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  // =========================
  // “COMING SOON” STUB TREES
  // (These prevent crashes until you build them out)
  // =========================
  shoulder_1: {
    id: 'shoulder_1',
    type: 'result',
    text: 'Shoulder pathway coming soon',
    description: 'This section is stubbed so the app stays runnable. Build the shoulder decision tree next.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  hip_1: {
    id: 'hip_1',
    type: 'result',
    text: 'Hip pathway coming soon',
    description: 'Stub node. Add your hip assessment flow here.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  knee_1: {
    id: 'knee_1',
    type: 'result',
    text: 'Knee pathway coming soon',
    description: 'Stub node. Add your knee assessment flow here.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  foot_1: {
    id: 'foot_1',
    type: 'result',
    text: 'Foot & ankle pathway coming soon',
    description: 'Stub node. Add your foot/ankle assessment flow here.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  elbow_wrist_1: {
    id: 'elbow_wrist_1',
    type: 'result',
    text: 'Elbow & wrist pathway coming soon',
    description: 'Stub node. Add your elbow/wrist assessment flow here.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },
  performance_start: {
    id: 'performance_start',
    type: 'result',
    text: 'Performance pathway coming soon',
    description: 'Stub node. Add your performance screening + progressions here.',
    options: [{ label: 'Back to start', nextId: 'start' }],
  },

  // =========================
  // LIBRARY EXERCISES
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
    options: [{ label: 'I feel stable & can breathe deeply', nextId: 'dns_sagittal_progression_choice' }],
  },

  vid_dns_deadbug: {
    id: 'vid_dns_deadbug',
    type: 'video',
    text: 'DNS Dead Bug',
    description: 'Dynamic sagittal stability. Moving limbs while maintaining the 3-month cylinder.',
    // NOTE: Vimeo embed expects numeric IDs. This is a placeholder so the app runs.
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 reps per side',
    libraryCategory: 'Supine',
    options: [{ label: 'Core holds strong', nextId: 'vid_dns_rolling' }],
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
      { label: 'Using momentum / Back arching', nextId: 'vid_dns_deadbug' },
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
    options: [{ label: 'Neck feels long & shoulders stable', nextId: 'vid_dns_low_oblique_cervical' }],
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
    options: [{ label: 'Shoulder stable', nextId: 'vid_dns_bear_lumbar' }],
  },

  vid_dns_bear: {
    id: 'vid_dns_bear',
    type: 'video',
    text: 'DNS Bear Position',
    description: 'Quadruped stability. Loading the hands and toes while maintaining a flat back.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths',
    libraryCategory: 'Quadruped',
    options: [{ label: 'Solid stability', nextId: 'start' }],
  },

  vid_dns_star: {
    id: 'vid_dns_star',
    type: 'video',
    text: 'DNS Star Pattern',
    description: 'Advanced side plank for lateral chain integration.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 reps/side',
    libraryCategory: 'Side Lying',
    options: [{ label: 'Continue', nextId: 'start' }],
  },

  vid_mdt_pressup: {
    id: 'vid_mdt_pressup',
    type: 'video',
    text: 'MDT Prone Press-Up (EIL)',
    description: 'Lumbar extension in lying mobilization.',
    videoId: '1151050929',
    isPremium: false,
    prescriptionDuration: 48,
    prescriptionFrequency: '10 reps every waking hour',
    libraryCategory: 'MDT',
    options: [{ label: 'Pain Centralized', nextId: 'lb_nerve_check_post_mdt' }],
  },

  // NOTE: Removed duplicated 'vid_mdt_retraction' and 'vid_mdt_ret_overpressure' here.
  // They are defined more specifically in the NECK TREE section below.

  vid_dns_iap: {
    id: 'vid_dns_iap',
    type: 'video',
    text: 'IAP Drill',
    description: 'Intra-abdominal pressure.',
    videoId: '1151048835',
    libraryCategory: 'Supine',
    options: [{ label: 'Done', nextId: 'start' }],
  },

  vid_dns_rotation: {
    id: 'vid_dns_rotation',
    type: 'video',
    text: 'Thoracic Rotation',
    description: 'Mobility drill.',
    videoId: '1151048835',
    libraryCategory: 'Side Lying',
    options: [{ label: 'Done', nextId: 'start' }],
  },

  vid_dns_bear_lumbar: {
    id: 'vid_dns_bear_lumbar',
    type: 'video',
    text: 'DNS Bear Position',
    description:
      'Quadruped stability. Hands and knees, toes tucked. Lift knees 1 inch off floor using pure IAP (abdominal pressure). Flat back.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths, 2x per day',
    replaces: ['vid_dns_low_oblique'],
    libraryCategory: 'Quadruped',
    options: [
      { label: 'Solid stability', nextId: 'start' },
      { label: 'Wrists hurt / Back rounds', nextId: 'vid_dns_low_oblique' },
    ],
  },
  // =========================
  // 1) LOWER BACK TREE
  // =========================

  'low_back_1': {
    id: 'low_back_1',
    type: 'video',
    text: 'Lumbar Assessment',
    description:
      'Watch this video to understand how to classify your back pain. We need to determine if there is nerve root involvement (Sciatica) or if it is mechanical back pain.',
    videoId: '1151049975',
    journeyName: 'Lumbar Rehab',
    options: [
      // Phase 0 split (acute/reactive vs nagging/able to self-run)
      { label: 'I am in very acute pain (8–10/10), can barely move', nextId: 'lb_phase0a_entry' },
      { label: 'It is annoying/nagging (0–7/10), I can move around', nextId: 'lb_phase0b_entry' },
    ],
  },

  // ---------- Phase 0A: very acute / reactive ----------
  'lb_phase0a_entry': {
    id: 'lb_phase0a_entry',
    type: 'question',
    text: 'Phase 0A: Safety first',
    description:
      'If you have progressive weakness, loss of bladder/bowel control, saddle numbness, fever, or major trauma, you should not use this app for self-treatment.',
    options: [
      { label: 'I have red flags / progressive weakness', nextId: 'refer_out_urgent' },
      { label: 'No red flags, just severe pain', nextId: 'lb_leg_symptom_check' },
    ],
  },

  // ---------- Phase 0B: nagging / can self-run ----------
  'lb_phase0b_entry': {
    id: 'lb_phase0b_entry',
    type: 'question',
    text: 'Phase 0B: Quick screen',
    description:
      'We will still treat this like a derangement until proven otherwise. Next: check leg symptoms and shift.',
    options: [
      { label: 'Continue', nextId: 'lb_leg_symptom_check' },
    ],
  },

  // ---------- Leg symptoms / nerve screen ----------
  'lb_leg_symptom_check': {
    id: 'lb_leg_symptom_check',
    type: 'question',
    text: 'Do symptoms go below the knee?',
    description: 'Below-the-knee symptoms can indicate nerve root involvement.',
    options: [
      { label: 'Yes, below the knee (sciatica)', nextId: 'lb_red_flag_check' },
      { label: 'No, back/buttock/thigh only', nextId: 'lb_lateral_shift_check' },
    ],
  },

  'lb_red_flag_check': {
    id: 'lb_red_flag_check',
    type: 'question',
    text: 'Severe symptoms?',
    description: 'Any true weakness, progressive numbness, or loss of control?',
    options: [
      { label: 'Numbness/Weakness is significant or worsening', nextId: 'refer_out_urgent' },
      { label: 'Just pain/tingle, no true weakness', nextId: 'lb_lateral_shift_check' },
    ],
  },

  // ---------- Shift detection ----------
  lb_lateral_shift_check: {
    id: 'lb_lateral_shift_check',
    type: 'question',
    text: 'Look in a mirror. Is your upper body visibly shifted?',
    description: 'A lateral shift often needs correction before extension works.',
    options: [
      { label: 'Yes, I am shifted to one side', nextId: 'lb_shift_direction' },
      { label: 'No, I am straight / symmetrical', nextId: 'lb_mechanical_pattern' },
    ],
  },

  lb_shift_direction: {
    id: 'lb_shift_direction',
    type: 'question',
    text: 'Which way are you shifted?',
    description: 'From your perspective in the mirror.',
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
      { label: 'No leg symptoms (back/buttock only)', nextId: 'lb_shift_ok_then_hardness' },
    ],
  },

  lb_shift_left_ipsilateral_flag: {
    id: 'lb_shift_left_ipsilateral_flag',
    type: 'result',
    text: 'Ipsilateral shift pattern (more stubborn)',
    description:
      'If your torso is shifted LEFT and symptoms are also primarily LEFT-sided, this tends to be more stubborn. You can still proceed, but be more conservative. If you worsen or symptoms spread further down the leg, stop and seek in-person evaluation.',
    options: [
      { label: 'Proceed to shift correction', nextId: 'lb_shift_hardness_test' },
      { label: 'I am getting worse / symptoms spreading', nextId: 'refer_out' },
    ],
  },

  // IMPORTANT: only ONE definition of this node should exist
  lb_shift_leg_side_check_right: {
    id: 'lb_shift_leg_side_check_right',
    type: 'question',
    text: 'Which leg are symptoms traveling down?',
    description: 'This helps flag a more stubborn ipsilateral shift pattern.',
    options: [
      { label: 'Right leg', nextId: 'lb_shift_right_ipsilateral_flag' },
      { label: 'Left leg', nextId: 'lb_shift_ok_then_hardness' },
      { label: 'No leg symptoms (back/buttock only)', nextId: 'lb_shift_ok_then_hardness' },
    ],
  },

  lb_shift_right_ipsilateral_flag: {
    id: 'lb_shift_right_ipsilateral_flag',
    type: 'result',
    text: 'Ipsilateral shift pattern (more stubborn)',
    description:
      'If your torso is shifted RIGHT and symptoms are also primarily RIGHT-sided, this tends to be more stubborn. You can still proceed, but be more conservative. If you worsen or symptoms spread further down the leg, stop and seek in-person evaluation.',
    options: [
      { label: 'Proceed to shift correction', nextId: 'lb_shift_hardness_test' },
      { label: 'I am getting worse / symptoms spreading', nextId: 'refer_out' },
    ],
  },

  lb_shift_ok_then_hardness: {
    id: 'lb_shift_ok_then_hardness',
    type: 'result',
    text: 'Shift noted',
    description: 'Next step: test whether the shift is “soft” (correctable) or “hard” (blocked).',
    options: [{ label: 'Test if you can cross midline', nextId: 'lb_shift_hardness_test' }],
  },

  lb_shift_hardness_test: {
    id: 'lb_shift_hardness_test',
    type: 'question',
    text: 'Test your shift: Can you correct it past midline?',
    description: 'Goal: restore and maintain past-midline access.',
    options: [
      { label: 'Yes, I can cross midline', nextId: 'lb_soft_shift_confirmed' },
      { label: 'No, it feels hard/blocked', nextId: 'lb_hard_shift_plan' },
    ],
  },

  lb_soft_shift_confirmed: {
    id: 'lb_soft_shift_confirmed',
    type: 'result',
    text: 'Soft Shift (Correctable)',
    description: 'Good news: it’s correctable. Next: test extension response.',
    options: [{ label: 'Test extension response', nextId: 'lb_extension_tolerance_check' }],
  },

  lb_hard_shift_plan: {
    id: 'lb_hard_shift_plan',
    type: 'question',
    text: 'Hard shift (blocked)',
    description:
      'Start with side glides until you can cross midline. If you stall, we may need a blend: side glide + extension bias.',
    options: [
      { label: 'Start side glides now', nextId: 'vid_mdt_side_glide' },
      { label: 'I already tried side glides and stalled', nextId: 'lb_hard_shift_fallback' },
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
      { label: 'I can now cross midline', nextId: 'lb_soft_shift_confirmed' },
      { label: 'Still blocked / stalled', nextId: 'lb_hard_shift_fallback' },
    ],
  },

  lb_hard_shift_fallback: {
    id: 'lb_hard_shift_fallback',
    type: 'question',
    text: 'Fallback for stalled hard shift',
    description:
      'Rarely, some people need a blend: side glide + extension bias (standing or prone). Stop if pain spreads further down the leg.',
    options: [
      { label: 'Try blended shift + extension (next)', nextId: 'lb_shifted_extension_intro' },
      { label: 'This is worsening / spreading', nextId: 'refer_out' },
    ],
  },

  lb_shifted_extension_intro: {
    id: 'lb_shifted_extension_intro',
    type: 'result',
    text: 'Shift + Extension Blend',
    description:
      'Do a small set of side glides, then test gentle extension. Goal: regain midline + centralization. If pain moves further down the leg, stop.',
    options: [
      { label: 'Test extension tolerance now', nextId: 'lb_extension_tolerance_check' },
      { label: 'Stop and refer out', nextId: 'refer_out' },
    ],
  },


  // ---------- Mechanical pattern + extension dosing ----------
  'lb_mechanical_pattern': {
    id: 'lb_mechanical_pattern',
    type: 'question',
    text: 'What makes it worse?',
    description: 'This helps confirm directional stress.',
    options: [
      { label: 'Sitting/Bending', nextId: 'lb_extension_tolerance_check' },
      { label: 'Standing/Walking', nextId: 'lb_flexion_intolerant' },
    ],
  },

  'lb_extension_tolerance_check': {
    id: 'lb_extension_tolerance_check',
    type: 'question',
    text: 'Extension tolerance',
    description:
      'If very acute, start micro-dosing or static prone. If tolerable, start standing extension or press-ups.',
    options: [
      { label: 'Extension feels good or freeing', nextId: 'vid_mdt_standing_ext' },
      { label: 'Extension is painful/blocked (need to go slow)', nextId: 'vid_mdt_prone_gradual' },
    ],
  },

  'vid_mdt_standing_ext': {
    id: 'vid_mdt_standing_ext',
    type: 'video',
    text: 'Standing Extension (EIS)',
    description: 'Lumbar extension in standing.',
    videoId: '1151050042',
    libraryCategory: 'MDT',
    options: [
      { label: 'Better / more centralized', nextId: 'lb_nerve_check_post_mdt' },
      { label: 'No change yet', nextId: 'lb_extension_dose_hold_24h' },
      { label: 'Worse / pain spreading further down', nextId: 'refer_out' },
    ],
  },

  'vid_mdt_prone_gradual': {
    id: 'vid_mdt_prone_gradual',
    type: 'video',
    text: 'Prone Lying → Gradual Extension',
    description: 'Start with prone lying, then progress slowly toward press-ups.',
    videoId: '1151050929',
    libraryCategory: 'MDT',
    options: [
      { label: 'Centralizing / improving', nextId: 'vid_mdt_pressup' },
      { label: 'No change', nextId: 'lb_extension_dose_hold_24h' },
      { label: 'Worse / peripheralizing', nextId: 'refer_out' },
    ],
  },

  // This node already exists elsewhere in your file; keep it if you have it.
  // If not, you can add it or route to the press-up node you already use.
  'lb_extension_dose_hold_24h': {
    id: 'lb_extension_dose_hold_24h',
    type: 'result',
    text: 'Hold the line (24–48h)',
    description:
      'If you are improving even without perfect centralization, that is still a green/yellow light. Stay consistent. Do NOT half-dose. Re-check tomorrow.',
    options: [
      { label: 'Continue extension only for now', nextId: 'lb_nerve_check_post_mdt' },
      { label: 'I am worse / spreading', nextId: 'refer_out' },
    ],
  },

  'lb_nerve_check_post_mdt': {
    id: 'lb_nerve_check_post_mdt',
    type: 'question',
    text: 'After extension: leg tightness or nerve symptoms?',
    description: 'After extension work: do you still feel nerve-type tightness down the leg?',
    options: [
      { label: 'Yes', nextId: 'vid_sciatic_slider' },
      { label: 'No', nextId: 'vid_dns_3mo' },
    ],
  },

  'vid_sciatic_slider': {
    id: 'vid_sciatic_slider',
    type: 'video',
    text: 'Sciatic Slider',
    description: 'Gentle nerve mobilization.',
    videoId: '1151050929',
    libraryCategory: 'MDT',
    options: [
      { label: 'Better', nextId: 'vid_dns_3mo' },
      { label: 'No change', nextId: 'vid_dns_3mo' },
      { label: 'Worse', nextId: 'refer_out' },
    ],
  },

  'lb_flexion_intolerant': {
    id: 'lb_flexion_intolerant',
    type: 'result',
    text: 'Flexion Intolerance',
    description:
      'Standing/walking sensitivity can still be derangement, but if extension is clearly not tolerated, we shift to neutral stabilization and loading control.',
    options: [
      { label: 'Start Stabilization (DNS 3-month)', nextId: 'vid_dns_3mo' },
    ],
  },

  'dns_sagittal_progression_choice': {
    id: 'dns_sagittal_progression_choice',
    type: 'question',
    text: 'Stabilization Progression: Sagittal Plane',
    description:
      'You have mastered the static 3-month position. Now we challenge your stability while moving your limbs.',
    options: [{ label: 'Start Dynamic Stability', nextId: 'vid_dns_deadbug' }],
  },

  // =========================
  // 2) NECK TREE (MDT-first, Ret+Ext default)
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
      { label: 'Localized to neck/upper trap', nextId: 'neck_directional_screen' },
      { label: 'Radiating down arm', nextId: 'neck_red_flag_check' },
    ],
  },

  neck_red_flag_check: {
    id: 'neck_red_flag_check',
    type: 'question',
    text: 'Severe symptoms?',
    description: 'Any true weakness, progressive numbness, loss of coordination, or major neurologic changes?',
    options: [
      { label: 'Yes / concerning symptoms', nextId: 'refer_out_urgent' },
      { label: 'No true weakness (pain/tingle only)', nextId: 'neck_directional_screen' },
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
    ],
  },

  neck_extension_intolerant: {
    id: 'neck_extension_intolerant',
    type: 'result',
    text: 'Extension intolerance',
    description:
      'If looking up is clearly provocative, we will start with neutral stabilization and gentle control instead of forcing extension.',
    options: [{ label: 'Start Stabilization', nextId: 'vid_dns_dnf' }],
  },

  // Gate: default is Retraction+Extension, but allow regression to Retraction-only for acute/blocked patients
  neck_ret_only_gate: {
    id: 'neck_ret_only_gate',
    type: 'question',
    text: 'Before we test extension',
    description:
      'If you are very acute, feel blocked, or do not feel safe extending, start with retraction only. Otherwise, test retraction + extension (end-range).',
    options: [
      { label: 'Very acute / blocked / not safe to extend', nextId: 'vid_mdt_retraction' },
      { label: 'I can try retraction + extension', nextId: 'vid_mdt_ret_ext_standard' },
    ],
  },

  // Retraction-only (regression / on-ramp)
  vid_mdt_retraction: {
    id: 'vid_mdt_retraction',
    type: 'video',
    text: 'Cervical Retraction (Regression / On-ramp)',
    description:
      'Start here only if you are very acute or blocked. As soon as tolerated, progress to retraction + extension.',
    videoId: '1151050180',
    prescriptionFrequency: '10 reps every 2 hours',
    libraryCategory: 'MDT',
    options: [
      { label: 'I can now add extension', nextId: 'vid_mdt_ret_ext_standard' },
      { label: 'No change', nextId: 'vid_mdt_ret_overpressure' },
      { label: 'Worse / symptoms spread further down arm', nextId: 'refer_out' },
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

  // Default test: Retraction + Extension (end-range)
  vid_mdt_ret_ext_standard: {
    id: 'vid_mdt_ret_ext_standard',
    type: 'video',
    text: 'Retraction + Extension (Seated/Standing)',
    description:
      'This is the primary test when tolerated. Aim for end-range without peripheralizing symptoms.',
    videoId: '1151050180',
    libraryCategory: 'MDT',
    options: [
      { label: 'Centralizing / clearly better', nextId: 'neck_hold_then_stabilize' },
      { label: 'Better, but not perfect centralization', nextId: 'neck_hold_24_48h' },
      { label: 'No change', nextId: 'vid_mdt_ret_overpressure' },
      { label: 'Worse / symptoms spread further down arm', nextId: 'refer_out' },
    ],
  },

  // “Better but not perfect” hold node (your green/yellow light)
  neck_hold_24_48h: {
    id: 'neck_hold_24_48h',
    type: 'result',
    text: 'Hold the line (24–48 hours)',
    description:
      'If you feel meaningfully better (even without perfect centralization), stay consistent and do not half-dose. Re-check tomorrow.',
    options: [
      { label: 'Continue this for now', nextId: 'neck_recheck_after_hold' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
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
      { label: 'Stalled / no longer improving', nextId: 'vid_mdt_cervical_troubleshoot' },
      { label: 'Worse / spreading', nextId: 'refer_out' },
    ],
  },

  neck_hold_then_stabilize: {
    id: 'neck_hold_then_stabilize',
    type: 'result',
    text: 'Good response',
    description:
      'Great. Next step is to keep your directional preference “wins” while building stability so symptoms don’t return.',
    options: [{ label: 'Start Stabilization (DNS)', nextId: 'vid_dns_dnf' }],
  },

  // Gentle supine option if standing/seated end-range is too spicy
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
  // DNS NODES (stubs if you haven't built them yet)
  // =========================
  vid_dns_low_oblique_cervical: {
    id: 'vid_dns_low_oblique_cervical',
    type: 'video',
    text: 'DNS Low Oblique (Cervical focus)',
    description: 'Placeholder. Replace with your real cervical DNS progression video when ready.',
    videoId: '1151048835',
    isPremium: true,
    libraryCategory: 'Side Lying',
    options: [{ label: 'Continue', nextId: 'vid_dns_dnf' }],
  },

  vid_dns_dnf: {
    id: 'vid_dns_dnf',
    type: 'video',
    text: 'Deep Neck Flexor (DNF) Control',
    description: 'Placeholder. Replace with your real DNF video when ready.',
    videoId: '1151050180',
    isPremium: true,
    libraryCategory: 'Supine',
    options: [{ label: 'Done', nextId: 'start' }],
  },
};

function validateDecisionTree(tree: Record<string, DecisionNode>) {
  const keys = new Set(Object.keys(tree));
  const idToKeys = new Map<string, string[]>();
  const missingNext: Array<{ from: string; nextId: string; label: string }> = [];

  for (const [key, node] of Object.entries(tree)) {
    // track duplicate node.id values (different from duplicate object keys)
    if (node?.id) {
      const arr = idToKeys.get(node.id) ?? [];
      arr.push(key);
      idToKeys.set(node.id, arr);
    }

    // track missing nextId
    for (const opt of node.options ?? []) {
      if (!keys.has(opt.nextId)) {
        missingNext.push({ from: key, nextId: opt.nextId, label: opt.label });
      }
    }
  }

  const duplicateIds = [...idToKeys.entries()].filter(([, arr]) => arr.length > 1);

  if (missingNext.length || duplicateIds.length) {
    console.groupCollapsed('❌ DecisionTree validation issues');

    if (missingNext.length) {
      console.group('Missing nextId targets');
      for (const m of missingNext) {
        console.error(`From "${m.from}" -> nextId "${m.nextId}" (label: "${m.label}")`);
      }
      console.groupEnd();
    }

    if (duplicateIds.length) {
      console.group('Duplicate node.id values (multiple keys share same id)');
      for (const [id, arr] of duplicateIds) {
        console.error(`id "${id}" used by keys: ${arr.join(', ')}`);
      }
      console.groupEnd();
    }

    console.groupEnd();
  } else {
    console.log('✅ DecisionTree looks consistent.');
  }
}

// Only run in dev
if (import.meta.env.DEV) {
  validateDecisionTree(DECISION_TREE);
}