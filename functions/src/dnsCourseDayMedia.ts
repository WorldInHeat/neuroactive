// functions/src/dnsCourseDayMedia.ts
// Server-only Vimeo credentials for the DNS Foundations course, keyed by 1-based day
// index (1-84). Deliberately lives only in the Cloud Functions codebase, never in
// src/ — Vite only bundles what's under src/, so this file can never end up in the
// public client JavaScript. The client-side src/data/dnsCourse.ts keeps everything
// else (titles, descriptions, week structure, hasVideo/isPremium flags) — only the
// actual videoId/hash pairs live here, and are only ever returned to a caller that
// getDnsCourseDayMedia has verified is both authenticated and DNS-entitled.

export interface DnsCourseDayMedia {
  videoId: string;
  hash?: string;
}

export const DNS_COURSE_DAY_MEDIA: Record<number, DnsCourseDayMedia> = {
  1: { videoId: '1215609094', hash: '3e19868043' },
  2: { videoId: '1215609304', hash: '99a4928270' },
  3: { videoId: '1215625311', hash: '5d7533e4d6' },
  4: { videoId: '1215625310', hash: '1ca352626d' },
  5: { videoId: '1215625390', hash: '6dc9e2a82a' },
  6: { videoId: '1215625313', hash: '99945d20b5' },
  7: { videoId: '1215625312', hash: '6c851871ab' },
  8: { videoId: '1215647164', hash: '5b10105a75' },
  9: { videoId: '1215647165', hash: '94daa14c62' },
  10: { videoId: '1215647162', hash: 'df7c59a5ba' },
  11: { videoId: '1215647163', hash: 'd12f93c42a' },
  12: { videoId: '1215647703', hash: '32b66f36d8' },
  13: { videoId: '1215647702', hash: '1bb0ecacf2' },
  14: { videoId: '1215647704', hash: '6da276333d' },
  15: { videoId: '1217513188', hash: 'c38d13bebd' },
  16: { videoId: '1217513189', hash: '0bc10b53cc' },
  17: { videoId: '1217514578', hash: '57afb0f930' },
  18: { videoId: '1217513853', hash: '6f4ef35f4e' },
  19: { videoId: '1217514278', hash: 'd88911b148' },
  20: { videoId: '1217517863', hash: '63c0a918fa' },
  21: { videoId: '1217515820', hash: 'f1640b615d' },
  22: { videoId: '1217517372', hash: '6f4e59ecf6' },
  23: { videoId: '1217517222', hash: '51dc0635bb' },
  24: { videoId: '1217517220', hash: '28df72d6bf' },
  25: { videoId: '1217517223', hash: '5fc29569d0' },
  26: { videoId: '1217517221', hash: 'be984526aa' },
  27: { videoId: '1217517455', hash: 'fcd88ab4d8' },
  28: { videoId: '1217517454', hash: '47b92fc227' },
  29: { videoId: '1218738743', hash: '76e8e4540f' },
  30: { videoId: '1218738742', hash: '3625066147' },
  31: { videoId: '1218740619', hash: '525e758965' },
  32: { videoId: '1218740618', hash: '81b12db26e' },
  33: { videoId: '1218740620', hash: 'd0254e3128' },
  34: { videoId: '1218741275', hash: '4e27bfa7d9' },
  35: { videoId: '1218741274', hash: '3653d7ab74' },
  36: { videoId: '1218779978', hash: '765f630459' },
  37: { videoId: '1218779769', hash: '54d1083b67' },
  38: { videoId: '1218779771', hash: 'c0074c37fc' },
  39: { videoId: '1218779968', hash: '93d20870b4' },
  40: { videoId: '1218779772', hash: '4d2c75ea31' },
  41: { videoId: '1218779770', hash: 'a4b763c1ea' },
  42: { videoId: '1218779967', hash: '772c2fe9ae' },
};
