// src/services/dnsCourseMedia.ts
// Fetches a single DNS course day's Vimeo credentials from the trusted backend
// (functions/src/index.ts: getDnsCourseDayMedia). videoId/hash are never bundled into
// the client — see src/data/dnsCourse.ts, which only carries a `hasVideo` flag now.
import { getFunctions, httpsCallable } from 'firebase/functions';

export type DnsCourseDayMedia = {
  videoId: string;
  hash?: string;
};

const getDnsCourseDayMediaFn = httpsCallable<{ day: number }, DnsCourseDayMedia>(
  getFunctions(),
  'getDnsCourseDayMedia'
);

export async function fetchDnsCourseDayMedia(day: number): Promise<DnsCourseDayMedia> {
  const result = await getDnsCourseDayMediaFn({ day });
  return result.data;
}
