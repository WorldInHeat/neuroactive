export type DecisionNode = {
  id: string;
  type: 'question' | 'result' | 'video';
  text?: string;
  description?: string;
  options?: { label: string; nextId: string }[];
  videoId?: string;
  isPremium?: boolean;
  prescriptionDuration?: number;
  prescriptionFrequency?: string;
  replaces?: string[];
  journeyName?: string;
  libraryCategory?: 'Supine' | 'Prone' | 'Side Lying' | 'Quadruped' | 'Standing' | 'MDT';
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
  startTimes?: Record<string, number>;
  isPremium: boolean;
  hasAgreedToTerms: boolean;
  painLog: PainLogEntry[];
};
