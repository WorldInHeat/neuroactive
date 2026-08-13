// src/state/types.ts

export type DecisionNode = {
  id: string;
  type: 'question' | 'video' | 'result';
  text: string;
  description?: string;
  options?: { label: string; nextId: string }[];

  // video / library metadata
  videoId?: string;
  isPremium?: boolean; // gates content in both Library and the assessment flow — shows paywall instead when the user isn't premium
  journeyName?: string;

  prescriptionFrequency?: string;
  prescriptionDuration?: number;
  replaces?: string[];
  prescribes?: string[]; // node IDs to add to activePrescriptions when this node is reached

  libraryCategory?: 'All' | 'Supine' | 'Prone' | 'Side Lying' | 'Quadruped' | 'Standing' | 'MDT' | 'Orientation' | 'DNS';

  // tiering
  journeyTier?: 'A' | 'B' | 'C'; // A=pain triage, B=performance, C=returning/graduate path

  // optional clinical flags (display-only)
  flagLevel?: 'green' | 'yellow' | 'red';
  flagText?: string;
};


export type PainLogEntry = {
  date: string; // YYYY-MM-DD
  score: number; // 0-10
  status: 'Better' | 'Same' | 'Worse';
};

export type DnsCourseProgress = {
  currentDay: number; // 1-84, only this day + earlier are unlocked
  lastCompletedDate: string; // YYYY-MM-DD, local calendar date
  startedAt: string; // ISO date, set once when the user first opens the course
  // Maps a completed day's 1-based index to the real calendar date (YYYY-MM-DD) it was
  // completed on. Only written going forward from when the History tab shipped — there's
  // no way to reconstruct dates for days completed before that, so entries simply don't
  // exist for those; nothing backfills or fabricates them.
  completionDates?: Record<number, string>;
};

export type UserData = {
  activeJourney: string | null;
  activePrescriptions: string[];
  history: string[];
  currentNodeId: string;

  isPremium: boolean;
  hasAgreedToTerms: boolean;
  painLog: PainLogEntry[];

  // Phase gating
  phaseLocks?: Record<string, number>; // Date.now() timestamps
  lastCheckInAt?: string; // YYYY-MM-DD

  troubleshootingAttempts?: number;
  hasWatchedWelcome?: boolean;
  hasWatchedAssessmentIntro?: boolean;

  authProvider?: 'google' | 'anonymous';
  displayName?: string;
  photoURL?: string;

  subscriptionTier?: 'monthly' | 'annual' | 'program' | 'elite' | null;
  stripeCustomerId?: string;
  subscriptionStatus?: 'active' | 'canceled' | 'past_due' | 'trialing' | null;

  // 12-Week DNS Foundations course — structurally separate from the assessment tree
  dnsCourse?: DnsCourseProgress;
};
