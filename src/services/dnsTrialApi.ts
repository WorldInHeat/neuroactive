// src/services/dnsTrialApi.ts
// Calls the trusted startDnsTrial callable (functions/src/index.ts). Sends no data at all:
// start time, duration, day limit, and uid are all decided server-side.
import { getFunctions, httpsCallable } from 'firebase/functions';

export type StartDnsTrialResult = {
  outcome: 'started' | 'already_active' | 'already_used' | 'permanent';
  access: {
    accessType: 'permanent' | 'trial_active' | 'trial_expired' | 'none';
    trialUsed: boolean;
    trialStartedAt: string | null;
    trialExpiresAt: string | null;
    maxAccessibleDay: number | null;
    purchaseRequired: boolean;
  };
};

export async function startDnsTrial(): Promise<StartDnsTrialResult> {
  const fn = httpsCallable<undefined, StartDnsTrialResult>(getFunctions(), 'startDnsTrial');
  const result = await fn(undefined);
  return result.data;
}
