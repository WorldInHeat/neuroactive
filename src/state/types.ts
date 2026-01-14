// src/state/types.ts

export type DecisionNode = {
  id: string;
  type: 'question' | 'video' | 'result';
  text: string;
  description?: string;
  options?: { label: string; nextId: string }[];

  // video / library metadata
  videoId?: string;
  isPremium?: boolean; // keep for Library-only gating
  journeyName?: string;

  prescriptionFrequency?: string;
  prescriptionDuration?: number;
  replaces?: string[];

  libraryCategory?: 'All' | 'Supine' | 'Prone' | 'Side Lying' | 'Quadruped' | 'Standing' | 'MDT';

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
};
