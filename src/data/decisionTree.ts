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

  vid_mdt_retraction: {
    id: 'vid_mdt_retraction',
    type: 'video',
    text: 'Cervical Retraction',
    description: 'Chin tuck for upper cervical flexion and lower cervical extension.',
    videoId: '1151050180',
    prescriptionFrequency: '10 reps every 2 hours',
    libraryCategory: 'MDT',
    options: [
      { label: 'Pain Centralized', nextId: 'vid_mdt_ret_ext_standard' },
      { label: 'No Change', nextId: 'vid_mdt_ret_overpressure' },
    ],
  },

  vid_mdt_ret_overpressure: {
    id: 'vid_mdt_ret_overpressure',
    type: 'video',
    text: 'Retraction + Overpressure',
    description: 'Add hand pressure.',
    videoId: '1151050180',
    libraryCategory: 'MDT',
    options: [{ label: 'Better', nextId: 'vid_mdt_ret_ext_standard' }],
  },

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
  low_back_1: {
    id: 'low_back_1',
    type: 'video',
    text: 'Lumbar Assessment',
    description:
      'Watch this video to understand how to classify your back pain. We need to determine if there is nerve root involvement (Sciatica) or if it is mechanical back pain.',
    videoId: '1151049975',
    journeyName: 'Lumbar Rehab',
    options: [
      { label: 'Pain goes below the knee (Sciatica)', nextId: 'lb_red_flag_check' },
      { label: 'Pain is in the back/buttock/thigh only', nextId: 'lb_lateral_shift_check' },
    ],
  },

  lb_red_flag_check: {
    id: 'lb_red_flag_check',
    type: 'question',
    text: 'Severe symptoms?',
    description: 'Any true weakness, progressive numbness, or loss of control?',
    options: [
      { label: 'Numbness/Weakness', nextId: 'refer_out_urgent' },
      { label: 'Just Pain', nextId: 'lb_lateral_shift_check' },
    ],
  },

  lb_lateral_shift_check: {
    id: 'lb_lateral_shift_check',
    type: 'question',
    text: 'Look in a mirror. Is your upper body visibly shifted to one side?',
    options: [
      { label: 'Yes, I am shifted to one side', nextId: 'lb_shift_hardness_test' },
      { label: 'No, I am straight / symmetrical', nextId: 'lb_mechanical_pattern' },
    ],
  },

  lb_shift_hardness_test: {
    id: 'lb_shift_hardness_test',
    type: 'question',
    text: 'Test your shift: Can you correct it?',
    options: [
      { label: 'Yes, I can cross the midline', nextId: 'lb_soft_shift_confirmed' },
      { label: 'No, it feels hard/blocked', nextId: 'vid_mdt_side_glide' },
    ],
  },

  vid_mdt_side_glide: {
    id: 'vid_mdt_side_glide',
    type: 'video',
    text: 'Side Glide Correction',
    description: 'Shift correction drill.',
    videoId: '1151049975',
    libraryCategory: 'MDT',
    options: [{ label: 'Shift Reduced', nextId: 'lb_mechanical_pattern' }],
  },

  lb_soft_shift_confirmed: {
    id: 'lb_soft_shift_confirmed',
    type: 'result',
    text: 'Soft Shift',
    description: 'Good news: it’s correctable. Next: test extension response.',
    options: [{ label: 'Start Extension', nextId: 'lb_extension_tolerance_check' }],
  },

  lb_mechanical_pattern: {
    id: 'lb_mechanical_pattern',
    type: 'question',
    text: 'What makes it worse?',
    options: [
      { label: 'Sitting/Bending', nextId: 'lb_extension_tolerance_check' },
      { label: 'Standing/Walking', nextId: 'lb_flexion_intolerant' },
    ],
  },

  lb_extension_tolerance_check: {
    id: 'lb_extension_tolerance_check',
    type: 'question',
    text: 'Extension Tolerance',
    description: 'Test standing extension or gentle prone progression.',
    options: [
      { label: 'Feels Good', nextId: 'vid_mdt_standing_ext' },
      { label: 'Painful/Blocked', nextId: 'vid_mdt_prone_gradual' },
    ],
  },

  vid_mdt_standing_ext: {
    id: 'vid_mdt_standing_ext',
    type: 'video',
    text: 'Standing Extension (EIS)',
    description: 'Lumbar extension in standing.',
    videoId: '1151050042',
    libraryCategory: 'MDT',
    options: [{ label: 'Better', nextId: 'vid_dns_3mo' }],
  },

  vid_mdt_prone_gradual: {
    id: 'vid_mdt_prone_gradual',
    type: 'video',
    text: 'Prone Lying',
    description: 'Start with prone lying, then progress.',
    videoId: '1151050929',
    libraryCategory: 'MDT',
    options: [{ label: 'Centralizing', nextId: 'vid_mdt_pressup' }],
  },

  lb_nerve_check_post_mdt: {
    id: 'lb_nerve_check_post_mdt',
    type: 'question',
    text: 'Leg tightness?',
    description: 'After extension work: do you still feel nerve-type tightness down the leg?',
    options: [
      { label: 'Yes', nextId: 'vid_sciatic_slider' },
      { label: 'No', nextId: 'vid_dns_3mo' },
    ],
  },

  vid_sciatic_slider: {
    id: 'vid_sciatic_slider',
    type: 'video',
    text: 'Sciatic Slider',
    description: 'Gentle nerve mobilization.',
    videoId: '1151050929',
    libraryCategory: 'MDT',
    options: [{ label: 'Better', nextId: 'vid_dns_3mo' }],
  },

  lb_flexion_intolerant: {
    id: 'lb_flexion_intolerant',
    type: 'result',
    text: 'Flexion Intolerance',
    description: 'Standing/walking sensitivity often benefits from stabilization and neutral control.',
    options: [{ label: 'Start Stabilization', nextId: 'vid_dns_3mo' }],
  },

  dns_sagittal_progression_choice: {
    id: 'dns_sagittal_progression_choice',
    type: 'question',
    text: 'Stabilization Progression: Sagittal Plane',
    description:
      'You have mastered the static 3-month position. Now we challenge your stability while moving your limbs.',
    options: [{ label: 'Start Dynamic Stability', nextId: 'vid_dns_deadbug' }],
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
      { label: 'Localized to neck/upper trap', nextId: 'neck_posture_screen' },
      { label: 'Radiating down arm', nextId: 'neck_red_flag_check' },
    ],
  },

  neck_red_flag_check: {
    id: 'neck_red_flag_check',
    type: 'question',
    text: 'Severe symptoms?',
    description: 'Check for weakness or loss of coordination.',
    options: [
      { label: 'Weakness', nextId: 'refer_out_urgent' },
      { label: 'Pain/Tingle', nextId: 'neck_posture_screen' },
    ],
  },

  neck_posture_screen: {
    id: 'neck_posture_screen',
    type: 'question',
    text: 'What makes it worse?',
    description: 'Identifying directional stress.',
    options: [
      { label: 'Looking Down/Phone', nextId: 'vid_mdt_retraction' },
      { label: 'Looking Up', nextId: 'neck_extension_intolerant' },
    ],
  },

  neck_extension_intolerant: {
    id: 'neck_extension_intolerant',
    type: 'result',
    text: 'Extension Intolerance',
    description: 'Pain looking up can suggest facet irritation. Start neutral stabilization.',
    options: [{ label: 'Start Stabilization', nextId: 'vid_dns_dnf' }],
  },

  vid_mdt_ret_ext_standard: {
    id: 'vid_mdt_ret_ext_standard',
    type: 'video',
    text: 'Retraction w/ Extension (Seated/Standing)',
    description: 'Standard MDT progression if tolerated.',
    videoId: '1151050180',
    libraryCategory: 'MDT',
    options: [{ label: 'Better', nextId: 'neck_nerve_check_post_mdt' }],
  },

  // MISSING NODE IN YOUR FILE: add it so navigation never dies
  neck_nerve_check_post_mdt: {
    id: 'neck_nerve_check_post_mdt',
    type: 'question',
    text: 'Arm symptoms after exercises?',
    description: 'After retraction/extension, did arm symptoms centralize?',
    options: [
      { label: 'Centralizing / Better', nextId: 'vid_dns_dnf' },
      { label: 'No change', nextId: 'vid_mdt_ret_overpressure' },
      { label: 'Worse / further down arm', nextId: 'refer_out' },
    ],
  },

  vid_mdt_ret_ext_gentle: {
    id: 'vid_mdt_ret_ext_gentle',
    type: 'video',
    text: 'Retraction & Extension (Supine)',
    description: 'Gentle "Kissing the Pain" protocol in supine.',
    videoId: '1151050108',
    prescriptionFrequency: '10 gentle reps every 2 hours',
    prescriptionDuration: 24,
    options: [
      { label: 'Feeling better & gaining Range of Motion', nextId: 'vid_mdt_ret_ext_gentle_phase2' },
      { label: 'No improvement / Still blocked', nextId: 'vid_mdt_cervical_troubleshoot' },
      { label: 'Worse / Pain moves further down arm', nextId: 'refer_out' },
    ],
  },

  vid_mdt_ret_ext_gentle_phase2: {
    id: 'vid_mdt_ret_ext_gentle_phase2',
    type: 'video',
    text: 'Continue: Gentle Retraction & Extension (Day 2)',
    description: 'Continue another 24 hours.',
    videoId: '1151050108',
    prescriptionFrequency: '10 gentle reps every 2 hours',
    prescriptionDuration: 24,
    replaces: ['vid_mdt_ret_ext_gentle'],
    options: [
      { label: 'Pain Centralized / Range of Motion Full', nextId: 'vid_dns_dnf' },
      { label: 'Progress Stalled / Block returned', nextId: 'vid_mdt_cervical_troubleshoot' },
    ],
  },

  vid_mdt_cervical_troubleshoot: {
    id: 'vid_mdt_cervical_troubleshoot',
    type: 'video',
    text: 'Troubleshooting: Traction & Static Extension',
    description: 'If you stall, try traction/static extension patterns.',
    videoId: '1151050180',
    options: [
      { label: 'Symptoms Improved / Centralized', nextId: 'vid_mdt_ret_ext_standard' },
      { label: 'No Change / Worse', nextId: 'refer_out' },
    ],
  },

  // =========================
  // MISSING DNS NODES REFERENCED IN YOUR FILE
  // =========================
  vid_dns_low_oblique_cervical: {
    id: 'vid_dns_low_oblique_cervical',
    type: 'video',
    text: 'DNS Low Oblique (Cervical focus)',
    description: 'Stub video node for your cervical progression. Replace with the real Vimeo ID when ready.',
    videoId: '1151048835',
    isPremium: true,
    libraryCategory: 'Side Lying',
    options: [{ label: 'Continue', nextId: 'vid_dns_dnf' }],
  },

  vid_dns_dnf: {
    id: 'vid_dns_dnf',
    type: 'video',
    text: 'Deep Neck Flexor (DNF) Control',
    description: 'Stub node so neck pathway completes without errors. Replace with your real video.',
    videoId: '1151050180',
    isPremium: true,
    libraryCategory: 'Supine',
    options: [{ label: 'Done', nextId: 'start' }],
  },
};
