// src/data/decisionTree.ts
import type { DecisionNode } from '../state/types';

export const DECISION_TREE: Record<string, DecisionNode> = {
  // =========================
  // ONBOARDING
  // =========================
  onboarding_welcome: {
    id: 'onboarding_welcome',
    type: 'video',
    text: 'Welcome to NeuroActive',
    description: 'A quick orientation before you begin. Dr. Bruene explains what to expect, how to get the most out of the app, and what makes this approach different.',
    videoId: 'PLACEHOLDER_WELCOME',
    libraryCategory: 'Orientation',
    options: [
      { label: 'Continue to Assessment', nextId: 'start' },
    ],
  },

  onboarding_assessment_intro: {
    id: 'onboarding_assessment_intro',
    type: 'video',
    text: 'How This Assessment Works',
    description: 'Before your first question, understand what we are looking for — your directional preference — and how to use the green, yellow, and red light system to track your response.',
    videoId: '1207220674',
    libraryCategory: 'Orientation',
    options: [
      { label: 'Start Assessment', nextId: 'start' },
    ],
  },

  explainer_iap: {
    id: 'explainer_iap',
    type: 'video',
    text: 'What is IAP?',
    description: 'Intra-abdominal pressure — IAP — is the internal pressurization system that stabilizes your spine from the inside. Think of your trunk as a cylinder: your diaphragm is the top, your pelvic floor is the bottom, your deep abdominal muscles are the front and sides, and your deep spinal muscles are the back. When you breathe and pressurize correctly, this cylinder stiffens and protects your spine before any movement happens. This is not the same as sucking in your stomach or bracing hard — it is a coordinated 360-degree expansion that happens automatically when the system is working correctly. Every DNS exercise in this program is built on this foundation.',
    videoId: 'PLACEHOLDER_IAP_EXPLAINER',
    libraryCategory: 'Orientation',
    options: [
      { label: 'Back to my exercise', nextId: 'vid_dns_3mo' },
    ],
  },

  onboarding_paywall_hero: {
    id: 'onboarding_paywall_hero',
    type: 'video',
    text: 'Why NeuroActive is Different',
    description: 'Dr. Adam Bruene, D.C., Cert. MDT, DNSP explains the clinical methodology behind the app and why MDT + DNS together produce better outcomes than either approach alone.',
    videoId: '1206005431',
    options: [
      { label: 'Start My Subscription', nextId: 'start' },
    ],
  },

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
      { label: 'Continue to DNS Foundation', nextId: 'lb_mdt_prescription' },
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
    text: 'DNS — 3 Month Supine',
    description: 'This is the foundation — the position on which every other stabilization exercise in this program is built. Before we load anything, before we make anything harder, we need to establish this baseline. We are going to find your neutral spinal position and learn how to stabilize it from the inside out. Get this right and everything that follows becomes easier. Rush past it and nothing else will work as well as it should.',
    videoId: 'PLACEHOLDER_DNS_3MO',
    isPremium: true,
    prescriptionFrequency: '10 minutes, 1-2x per day',
    libraryCategory: 'DNS',
    flagLevel: 'green',
    options: [
      { label: 'I can find neutral and breathe into it consistently', nextId: 'vid_dns_prone_3mo' },
      { label: 'I am struggling with IAP or breathing', nextId: 'vid_dns_iap' },
      { label: 'This position is causing discomfort', nextId: 'dns_escape_supine' },
    ],
  },

  vid_dns_iap: {
    id: 'vid_dns_iap',
    type: 'video',
    text: 'IAP Breathing Drill',
    description: 'Intra-abdominal pressure foundation. Master this before progressing to dynamic DNS positions.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '5 minutes, 2x per day',
    libraryCategory: 'DNS',
    flagLevel: 'green',
    options: [{ label: 'IAP feels solid', nextId: 'vid_dns_3mo' }],
  },

  vid_dns_prone_3mo: {
    id: 'vid_dns_prone_3mo',
    type: 'video',
    text: 'DNS — 3 Month Prone',
    description: 'The prone counterpart to 3 month supine. Now the floor is under your front instead of your back, which changes everything — you have to actively find neutral rather than letting the surface guide you. We anchor the pubic symphysis to the floor to normalize lumbar paraspinal activity, lift the head from T4 rather than the neck, and find shoulder centration through the elbows. This position is foundational for lower back, neck, and shoulder rehabilitation.',
    videoId: 'PLACEHOLDER_DNS_PRONE_3MO',
    isPremium: true,
    prescriptionFrequency: '10 breaths, 2x per day',
    libraryCategory: 'DNS',
    flagLevel: 'green',
    options: [
      { label: 'Stable — pubic symphysis anchored, head lifting from T4', nextId: 'vid_dns_deadbug' },
      { label: 'Neck is uncomfortable in prone', nextId: 'dns_escape_prone' },
      { label: 'Lower back is uncomfortable in prone', nextId: 'dns_escape_prone' },
    ],
  },

  vid_dns_4_5_prone: {
    id: 'vid_dns_4_5_prone',
    type: 'video',
    text: 'DNS — 4.5 Month Prone',
    description: 'The first asymmetrical position in the progression. From 3 month prone, you shift into a diagonal load — contralateral elbow and knee become your fixed points, mirroring the pre-creeping pattern. This is where the body first learns to stabilize through rotation while prone, and where the diagonal stabilizing chains begin to integrate. It is the starting point of the creeping pattern that underlies walking, running, and all contralateral movement.',
    videoId: 'PLACEHOLDER_DNS_4_5_PRONE',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_prone_3mo'],
    flagLevel: 'green',
    options: [
      { label: 'Stable in the diagonal position', nextId: 'vid_dns_rolling' },
      { label: 'Cannot find stability asymmetrically', nextId: 'vid_dns_prone_3mo' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_prone' },
    ],
  },

  vid_dns_deadbug: {
    id: 'vid_dns_deadbug',
    type: 'video',
    text: 'DNS — Dead Bug',
    description: 'Now we add challenge. The 3 month position taught you how to find and hold proper stabilization — dead bug tests whether you can maintain it while your limbs are moving. This is closer to what your spine actually has to do in real life. The movement is secondary. The stabilization is the exercise. If you feel your lower back shifting or your breathing pattern breaking down, the load is too much — scale back before adding more range.',
    videoId: 'PLACEHOLDER_DNS_DEADBUG',
    isPremium: true,
    prescriptionFrequency: '10 reps per side, 2x per day',
    libraryCategory: 'DNS',
    flagLevel: 'green',
    options: [
      { label: 'Core holds stable through full range', nextId: 'vid_dns_4_5_prone' },
      { label: 'Core collapses or breathing breaks down', nextId: 'vid_dns_iap' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_supine' },
    ],
  },

  vid_dns_rolling: {
    id: 'vid_dns_rolling',
    type: 'video',
    text: 'DNS — Rolling / Turning',
    description: 'Rolling is the second most consequential pattern in this program after IAP. It trains your core through the oblique slings — the diagonal chains that connect your shoulder to the opposite hip — and it is the blueprint for every rotational movement in sport and daily life. Throwing, swinging, punching, kicking — they all trace back to this pattern. Learn to roll with proper segmental sequencing and you are building the foundation for powerful, protected movement. The goal is a smooth, segmental turn initiated from the eyes and head, not a momentum-driven flop.',
    videoId: 'PLACEHOLDER_DNS_ROLLING',
    isPremium: true,
    prescriptionFrequency: '10 slow rolls per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_deadbug'],
    flagLevel: 'green',
    options: [
      { label: 'Smooth segmental turn, no momentum', nextId: 'vid_dns_rotation' },
      { label: 'Using momentum or back arching', nextId: 'vid_dns_deadbug' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_supine' },
    ],
  },

  vid_dns_rotation: {
    id: 'vid_dns_rotation',
    type: 'video',
    text: 'DNS — Rotational Stabilization',
    description: 'Rotational stability is the last to develop and the first to break down. After establishing sagittal and frontal plane control, we introduce rotation — and almost immediately the brain recruits deeper stabilizers to protect the spine through the turn. This is not a stretching exercise. You are training the system to neutralize the spine automatically as rotation is introduced. This is the bridge between the floor progressions and the more complex upright patterns that follow.',
    videoId: 'PLACEHOLDER_DNS_ROTATION',
    isPremium: true,
    prescriptionFrequency: '10 reps per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_rolling'],
    flagLevel: 'green',
    options: [
      { label: 'Spine neutralizing well through rotation', nextId: 'vid_dns_kneeling' },
      { label: 'Still collapsing through rotation', nextId: 'vid_dns_rolling' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_supine' },
    ],
  },

  vid_dns_kneeling: {
    id: 'vid_dns_kneeling',
    type: 'video',
    text: 'DNS — Kneeling',
    description: "Kneeling on knees and elbows — similar in appearance to child's pose but fundamentally different in intent. For the first time, you must find spinal neutral without any surface behind you to reference. The deep stabilizers have to work independently, which drives greater activation and reduces tone in the more superficial paraspinals. This position is particularly valuable for anyone who gets back pain when sitting or squatting — it trains spinal neutral in hip flexion, directly addressing that pattern.",
    videoId: 'PLACEHOLDER_DNS_KNEELING',
    isPremium: true,
    prescriptionFrequency: '10 breaths, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_rotation'],
    flagLevel: 'green',
    options: [
      { label: 'Finding neutral without surface reference', nextId: 'vid_dns_rolling_to_low_oblique' },
      { label: 'Cannot find neutral in this position', nextId: 'vid_dns_rotation' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_kneeling' },
    ],
  },

  vid_dns_rolling_to_low_oblique: {
    id: 'vid_dns_rolling_to_low_oblique',
    type: 'video',
    text: 'DNS — Rolling to Low Oblique',
    description: 'The transition from floor to side support is its own exercise — not just a way to get from one position to another. The segmental control required to move from rolling through to low oblique sit without losing stability or collapsing is significant. Practice this transition deliberately. Each repetition is training the oblique slings to manage load through a full range of movement.',
    videoId: 'PLACEHOLDER_DNS_ROLLING_LOW_OBLIQUE',
    isPremium: true,
    prescriptionFrequency: '10 slow transitions per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_kneeling'],
    flagLevel: 'green',
    options: [
      { label: 'Smooth controlled transition', nextId: 'vid_dns_low_oblique' },
      { label: 'Collapsing or losing control in transition', nextId: 'vid_dns_rolling' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_sidelying' },
    ],
  },

  vid_dns_low_oblique: {
    id: 'vid_dns_low_oblique',
    type: 'video',
    text: 'DNS — Low Oblique Sit',
    description: 'Low oblique sit is the first time we load the frontal plane directly — the side-to-side stability that rolling only touched on. You are now supporting your body weight through one shoulder and one hip, which demands both shoulder centration and lateral trunk stability simultaneously. This is a significant step up from rolling. If your shoulder collapses or hikes toward your ear, scale back — the position only works if the shoulder is properly centrated in the socket first.',
    videoId: 'PLACEHOLDER_DNS_LOW_OBLIQUE',
    isPremium: true,
    prescriptionFrequency: 'Hold 30 seconds per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_rolling'],
    flagLevel: 'green',
    options: [
      { label: 'Shoulder stable, lateral chain engaged', nextId: 'vid_dns_tripod' },
      { label: 'Shoulder collapses or unstable', nextId: 'vid_dns_rolling' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_sidelying' },
    ],
  },

  vid_dns_tripod: {
    id: 'vid_dns_tripod',
    type: 'video',
    text: 'DNS — Tripod',
    description: 'Tripod is an asymmetrical three-point stance — two hands and one foot on the floor, the grounded leg flexed with foot flat, the other leg free. You get here by transitioning from low oblique through high oblique sit. The asymmetrical load demands hip, trunk, and shoulder stability simultaneously in a position that closely mirrors the demands of athletic movement and daily function.',
    videoId: 'PLACEHOLDER_DNS_TRIPOD',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_low_oblique'],
    flagLevel: 'green',
    options: [
      { label: 'Stable in tripod position', nextId: 'vid_dns_s_position' },
      { label: 'Cannot maintain stability', nextId: 'vid_dns_low_oblique' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_sidelying' },
    ],
  },

  vid_dns_s_position: {
    id: 'vid_dns_s_position',
    type: 'video',
    text: 'DNS — S Position',
    description: 'The S position is a variation of high oblique sit where one hip is in internal rotation and the other is in external rotation simultaneously — creating an S-shape through the pelvis. This is a significant rotational challenge through both hips at once, demanding independent hip control on each side. It is one of the most integrative positions in the progression, bridging the gap between floor work and the more complex demands of bear and upright movement.',
    videoId: 'PLACEHOLDER_DNS_S_POSITION',
    isPremium: true,
    prescriptionFrequency: 'Hold 30 seconds per side, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_tripod'],
    flagLevel: 'green',
    options: [
      { label: 'Comfortable and stable in S position', nextId: 'vid_dns_bear_lumbar' },
      { label: 'Hip mobility limiting the position', nextId: 'vid_dns_tripod' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_sidelying' },
    ],
  },

  vid_dns_bear_lumbar: {
    id: 'vid_dns_bear_lumbar',
    type: 'video',
    text: 'DNS — Bear (Modified)',
    description: 'Bear is one of the most demanding positions in this program — by the time you reach it, you have built the pieces that make it possible. Hands and knees on the floor, toes tucked, you lift your knees one inch off the ground using pure IAP. No momentum, no holding your breath, no arching or rounding the back. This modified version with knees hovering low is significantly more challenging than simply being on all fours. The integration of everything you have built so far happens here.',
    videoId: 'PLACEHOLDER_DNS_BEAR_MOD',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_s_position'],
    flagLevel: 'green',
    options: [
      { label: 'Stable — knees hovering, back flat, breathing intact', nextId: 'vid_dns_bear' },
      { label: 'Back rounds or cannot maintain IAP', nextId: 'vid_dns_rotation' },
      { label: 'Wrists uncomfortable', nextId: 'dns_escape_quadruped' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_quadruped' },
    ],
  },

  vid_dns_bear: {
    id: 'vid_dns_bear',
    type: 'video',
    text: 'DNS — Bear (Full)',
    description: 'Full bear raises the knees higher and increases the load through the shoulders, hips, and trunk simultaneously. Everything from the modified version applies — flat back, pure IAP, breathing intact — but now with greater range and demand. This is a true test of integrated stabilization.',
    videoId: 'PLACEHOLDER_DNS_BEAR_FULL',
    isPremium: true,
    prescriptionFrequency: 'Hold 10 breaths, 3x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_bear_lumbar'],
    flagLevel: 'green',
    options: [
      { label: 'Solid stability at full height', nextId: 'vid_dns_bear_to_squat' },
      { label: 'Cannot maintain at full height', nextId: 'vid_dns_bear_lumbar' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_quadruped' },
    ],
  },

  vid_dns_bear_to_squat: {
    id: 'vid_dns_bear_to_squat',
    type: 'video',
    text: 'DNS — Bear to Squat',
    description: 'The transition from bear to squat is the first time we move toward upright under load. From bear position, you shift your weight back and up into a deep squat, maintaining spinal neutral and IAP throughout the transition. This bridges the gap between quadruped stability and standing function.',
    videoId: 'PLACEHOLDER_DNS_BEAR_SQUAT',
    isPremium: true,
    prescriptionFrequency: '10 slow transitions, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_bear'],
    flagLevel: 'green',
    options: [
      { label: 'Smooth transition maintaining neutral', nextId: 'vid_dns_bear_to_stand' },
      { label: 'Cannot maintain neutral through transition', nextId: 'vid_dns_bear' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_quadruped' },
    ],
  },

  vid_dns_bear_to_stand: {
    id: 'vid_dns_bear_to_stand',
    type: 'video',
    text: 'DNS — Bear to Stand',
    description: 'The final progression in the lumbar rehabilitation track. From bear, you move through squat and into standing — the full developmental arc from quadruped to upright. Maintaining spinal neutral and IAP through this entire transition is the culmination of everything built in this program. When you can do this consistently, you have rebuilt the foundation.',
    videoId: 'PLACEHOLDER_DNS_BEAR_STAND',
    isPremium: true,
    prescriptionFrequency: '10 slow transitions, 2x per day',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_bear_to_squat'],
    flagLevel: 'green',
    options: [
      { label: 'Moving well through the full pattern', nextId: 'lumbar_track_complete' },
      { label: 'Losing neutral coming to stand', nextId: 'vid_dns_bear_to_squat' },
      { label: 'This exercise is causing discomfort', nextId: 'dns_escape_quadruped' },
    ],
  },

  vid_dns_star: {
    id: 'vid_dns_star',
    type: 'video',
    text: 'DNS Star Pattern',
    description: 'Advanced side plank for lateral chain integration. Full body anti-rotation challenge.',
    videoId: '1151048835',
    isPremium: true,
    prescriptionFrequency: '10 reps/side',
    libraryCategory: 'DNS',
    replaces: ['vid_dns_bear'],
    options: [
      { label: 'Lateral chain solid', nextId: 'start' },
      { label: 'Cannot maintain', nextId: 'vid_dns_bear' },
    ],
  },

  // =========================
  // DNS ESCAPE HATCHES
  // =========================
  dns_escape_supine: {
    id: 'dns_escape_supine',
    type: 'result',
    text: 'Supine Discomfort — Temporary Adjustment',
    description: 'Discomfort in the supine progression is uncommon but manageable. Try moving to 3 month prone instead — sometimes loading the front of the spine first makes returning to supine easier. We will circle back to this exercise once prone work has settled things down.',
    flagLevel: 'yellow',
    options: [
      { label: 'Try 3 month prone instead', nextId: 'vid_dns_prone_3mo' },
      { label: 'Return to my MDT exercises for now', nextId: 'lb_mdt_prescription' },
    ],
  },

  dns_escape_prone: {
    id: 'dns_escape_prone',
    type: 'result',
    text: 'Prone Discomfort — Temporary Adjustment',
    description: 'Prone work can occasionally aggravate neck or lower back symptoms early on. Try working on rolling and turning from supine first to develop deep neck flexor activation and oblique sling control, then return to prone once that foundation is more solid.',
    flagLevel: 'yellow',
    options: [
      { label: 'Work on rolling from supine first', nextId: 'vid_dns_rolling' },
      { label: 'Return to 3 month supine', nextId: 'vid_dns_3mo' },
    ],
  },

  dns_escape_sidelying: {
    id: 'dns_escape_sidelying',
    type: 'result',
    text: 'Side Lying Discomfort — Temporary Adjustment',
    description: 'If side lying work is causing discomfort, return to rolling for now and continue developing oblique sling control from supine. Side lying will become more accessible as rotational stability improves.',
    flagLevel: 'yellow',
    options: [
      { label: 'Return to rolling', nextId: 'vid_dns_rolling' },
      { label: 'Return to rotational stabilization', nextId: 'vid_dns_rotation' },
    ],
  },

  dns_escape_kneeling: {
    id: 'dns_escape_kneeling',
    type: 'result',
    text: 'Kneeling Discomfort — Temporary Adjustment',
    description: 'Kneeling discomfort is often knee or hip related rather than spinal. Try placing a folded blanket or pad under your knees. If the discomfort is spinal, return to rotational stabilization and low oblique work and revisit kneeling in a few days.',
    flagLevel: 'yellow',
    options: [
      { label: 'Return to rotational stabilization', nextId: 'vid_dns_rotation' },
      { label: 'Return to rolling to low oblique', nextId: 'vid_dns_rolling_to_low_oblique' },
    ],
  },

  dns_escape_quadruped: {
    id: 'dns_escape_quadruped',
    type: 'result',
    text: 'Quadruped Discomfort — Temporary Adjustment',
    description: 'Wrist discomfort in quadruped is common — try making fists instead of flat palms, or use push-up handles if available. If the discomfort is spinal, return to S position and tripod work and approach bear again when those feel more solid.',
    flagLevel: 'yellow',
    options: [
      { label: 'Return to S position', nextId: 'vid_dns_s_position' },
      { label: 'Return to tripod', nextId: 'vid_dns_tripod' },
    ],
  },

  lumbar_track_complete: {
    id: 'lumbar_track_complete',
    type: 'result',
    text: 'Lumbar Rehabilitation Complete',
    description: 'You have worked through the full lumbar rehabilitation track — from finding your directional preference with MDT to rebuilding your stabilization system through the DNS developmental progression. The foundation is rebuilt. Continue your bear to stand practice daily and return to your MDT exercises any time symptoms flare. You now have the tools to manage this independently.',
    flagLevel: 'green',
    flagText: 'Track Complete',
    options: [
      { label: 'Return to Dashboard', nextId: 'start' },
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
    type: 'question',
    text: 'How severe is your pain right now?',
    description:
      'Before we begin, we need to know where you are starting from. Your pain level right now determines which path we take first.',
    journeyName: 'Lumbar Rehab',
    options: [
      { label: 'I am in very acute pain (8–10/10), can barely move', nextId: 'lb_phase0a_entry' },
      { label: 'It is annoying/nagging (0–7/10), I can move around', nextId: 'lb_phase0b_entry' },
    ],
  },

  lb_assessment_video: {
    id: 'lb_assessment_video',
    type: 'video',
    text: 'Lumbar Assessment',
    description:
      'Before anything else, we need to understand how your symptoms behave. What makes them worse? What makes them better? Your answers to these questions — not just where it hurts — are what guide your self-management. Watch this video, then answer a few questions about your pain behavior.',
    videoId: '1207218101',
    options: [
      { label: 'Continue', nextId: 'lb_leg_symptom_check' },
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
      { label: 'Continue', nextId: 'lb_assessment_video' },
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
      { label: 'Both sitting AND standing bother me', nextId: 'lb_both_sitting_standing' },
    ],
  },

  lb_both_sitting_standing: {
    id: 'lb_both_sitting_standing',
    type: 'question',
    text: 'Both sitting and standing — which is driving things most right now?',
    description: 'Having both sitting and standing sensitivity is common and clinically useful information. The next question helps us sort out the primary driver so we can sequence your program correctly.',
    flagLevel: 'yellow',
    options: [
      { label: 'Sitting is clearly worse overall', nextId: 'lb_extension_tolerance_check' },
      { label: 'Standing is clearly worse overall', nextId: 'lb_extension_caution' },
      { label: 'Truly equal — no position gives significant relief', nextId: 'lb_both_equal' },
    ],
  },

  lb_both_equal: {
    id: 'lb_both_equal',
    type: 'result',
    text: 'Irritable presentation — proceeding carefully',
    description: 'When no position gives significant relief, we are dealing with a more irritable presentation. We will still test extension, but starting with prone lying only — no end range initially. Important: when both sitting and standing bother you, there is often a stabilization deficit running alongside the directional issue. The DNS exercises that follow MDT are specifically designed to address standing and loading sensitivity. For you they are not optional — they are addressing a second problem that MDT alone will not fix.',
    flagLevel: 'yellow',
    flagText: 'Irritable — start gentle, DNS critical',
    options: [
      { label: 'Start gentle prone extension', nextId: 'vid_mdt_prone_gradual' },
    ],
  },

  lb_extension_caution: {
    id: 'lb_extension_caution',
    type: 'result',
    text: 'Proceeding with caution — gentle extension first',
    description:
      'We are still going to test extension — but we will start gently, in a supported position, without pushing to end range initially. Here is the rule that guides everything from this point forward: pain during a movement is acceptable and does not mean stop. What matters is whether you remain worse after the movement than you were before. If symptoms settle back to baseline within a few minutes of finishing, we continue. If you are consistently worse afterwards, we change direction. Note: if standing and loading also bother you, the DNS stabilization work that follows MDT is addressing a second problem — a stabilization deficit that makes your spine vulnerable to load. Do not skip it.',
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
      { label: 'Continue extension only for now', nextId: 'lb_mdt_prescription' },
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
      { label: 'Centralized — pain moved toward spine / area got smaller', nextId: 'lb_mdt_prescription' },
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

  lb_mdt_prescription: {
    id: 'lb_mdt_prescription',
    type: 'result',
    text: 'Phase 1 Complete — Your Extension Prescription',
    description: 'You have identified your directional preference: EXTENSION. This is great news — it means we have a clear direction to work with.',
    flagLevel: 'green',
    flagText: 'Extension Responder',
    prescribes: ['vid_mdt_standing_ext', 'vid_mdt_pressup'],
    options: [
      { label: 'Continue to Phase 2 — Stabilization', nextId: 'vid_dns_3mo' },
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
    type: 'video',
    videoId: '1207224591',
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