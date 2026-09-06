// functions/src/attribution.test.ts
//
// Focused coverage for the server-side independent re-validation of client-supplied
// marketing-attribution snapshots (see attribution.ts's own header for the trust model:
// this data is written under an owner-write-only Firestore rule, which restricts WHO can
// write it but not WHAT it contains, so every field is re-validated from scratch here).
'use strict';

import {
  sanitizeAttributionSnapshot as sanitizeRawAttributionSnapshot,
  EMPTY_ATTRIBUTION_SNAPSHOT,
  ATTRIBUTION_SCHEMA_VERSION,
} from './attribution';

function sanitizeAttributionSnapshot(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sanitizeRawAttributionSnapshot(raw);
  return sanitizeRawAttributionSnapshot({ v: ATTRIBUTION_SCHEMA_VERSION, ...raw });
}

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log('PASS  ' + label);
    pass++;
  } else {
    console.log('FAIL  ' + label + (detail ? ': ' + detail : ''));
    fail++;
  }
}

function validTouch(overrides: Record<string, unknown> = {}) {
  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    landingPath: '/',
    referrerHostname: null,
    utmSource: 'instagram',
    utmMedium: 'social',
    utmCampaign: 'launch',
    utmContent: null,
    utmTerm: null,
    source: 'utm',
    sourceLabel: null,
    capturedAt: Date.UTC(2026, 0, 1),
    ...overrides,
  };
}

function run() {
  check(
    'A fully valid touch passes through unchanged, field for field',
    JSON.stringify(sanitizeAttributionSnapshot({ firstTouch: validTouch(), lastTouch: null })) ===
      JSON.stringify({ v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: validTouch(), lastTouch: null })
  );

  check('null root -> empty snapshot', JSON.stringify(sanitizeAttributionSnapshot(null)) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT));
  check('undefined root -> empty snapshot', JSON.stringify(sanitizeAttributionSnapshot(undefined)) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT));
  check('string root (wrong type) -> empty snapshot', JSON.stringify(sanitizeAttributionSnapshot('not an object')) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT));
  check('array root (wrong type) -> empty snapshot', JSON.stringify(sanitizeAttributionSnapshot([1, 2, 3])) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT));
  check('missing top-level schema version is rejected', JSON.stringify(sanitizeRawAttributionSnapshot({ firstTouch: validTouch() })) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT));
  check('wrong top-level schema version is rejected', JSON.stringify(sanitizeRawAttributionSnapshot({ v: 999, firstTouch: validTouch() })) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT));

  check(
    'missing firstTouch/lastTouch keys entirely -> both null, no throw',
    JSON.stringify(sanitizeAttributionSnapshot({})) === JSON.stringify(EMPTY_ATTRIBUTION_SNAPSHOT)
  );

  // --- Wrong/missing schema version ---
  check('wrong schema version is rejected (touch -> null)', sanitizeAttributionSnapshot({ firstTouch: validTouch({ v: 999 }) }).firstTouch === null);
  check('missing v is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ v: undefined }) }).firstTouch === null);

  // --- capturedAt validation ---
  check('non-numeric capturedAt is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ capturedAt: 'yesterday' }) }).firstTouch === null);
  check('negative capturedAt is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ capturedAt: -5 }) }).firstTouch === null);
  check('NaN capturedAt is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ capturedAt: NaN }) }).firstTouch === null);
  check('Infinity capturedAt is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ capturedAt: Infinity }) }).firstTouch === null);
  check('non-integer capturedAt is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ capturedAt: Date.UTC(2026, 0, 1) + 0.5 }) }).firstTouch === null);
  check('oversized capturedAt is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ capturedAt: Number.MAX_SAFE_INTEGER + 1 }) }).firstTouch === null);
  check('absurd future capturedAt is rejected', sanitizeRawAttributionSnapshot({ v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: validTouch({ capturedAt: Date.UTC(2099, 0, 1) }) }, Date.UTC(2026, 0, 1)).firstTouch === null);

  // --- source validation ---
  check('unknown source string is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ source: 'advertisement' }) }).firstTouch === null);
  check('non-string source is rejected', sanitizeAttributionSnapshot({ firstTouch: validTouch({ source: 42 }) }).firstTouch === null);
  check('coherent utm source is accepted', sanitizeAttributionSnapshot({ firstTouch: validTouch() }).firstTouch?.source === 'utm');
  check('coherent referral source is accepted', sanitizeAttributionSnapshot({ firstTouch: validTouch({ source: 'referral', referrerHostname: 'example.com', utmSource: null, utmMedium: null, utmCampaign: null }) }).firstTouch?.source === 'referral');
  check('coherent direct source is accepted', sanitizeAttributionSnapshot({ firstTouch: validTouch({ source: 'direct', utmSource: null, utmMedium: null, utmCampaign: null }) }).firstTouch?.source === 'direct');
  check('direct source carrying UTM data is rejected as contradictory', sanitizeAttributionSnapshot({ firstTouch: validTouch({ source: 'direct' }) }).firstTouch === null);

  // --- landingPath required ---
  check('missing landingPath rejects the whole touch', sanitizeAttributionSnapshot({ firstTouch: validTouch({ landingPath: undefined }) }).firstTouch === null);
  check('non-string landingPath rejects the whole touch', sanitizeAttributionSnapshot({ firstTouch: validTouch({ landingPath: 123 }) }).firstTouch === null);
  check(
    'control characters in landingPath reject the whole touch',
    sanitizeAttributionSnapshot({ firstTouch: validTouch({ landingPath: '/a\x00b' }) }).firstTouch === null
  );
  check(
    'oversized landingPath is truncated, not rejected',
    sanitizeAttributionSnapshot({ firstTouch: validTouch({ landingPath: '/' + 'x'.repeat(500) }) }).firstTouch?.landingPath.length === 200
  );

  // --- oversized UTM values truncated (not the whole touch rejected) ---
  check(
    'oversized utmCampaign is truncated to the 100-char limit',
    sanitizeAttributionSnapshot({ firstTouch: validTouch({ utmCampaign: 'c'.repeat(500) }) }).firstTouch?.utmCampaign?.length === 100
  );
  check(
    'oversized referrerHostname is truncated to the 128-char limit',
    sanitizeAttributionSnapshot({ firstTouch: validTouch({ referrerHostname: 'h'.repeat(500) }) }).firstTouch?.referrerHostname?.length === 128
  );

  // --- control characters / wrong types on nullable fields drop just that field ---
  check(
    'control characters in a UTM field drop just that field to null, not the whole touch',
    (() => {
      const result = sanitizeAttributionSnapshot({ firstTouch: validTouch({ utmSource: 'evil\x07bell' }) });
      return result.firstTouch !== null && result.firstTouch.utmSource === null;
    })()
  );
  check(
    'a non-string UTM value (wrong type) drops just that field to null',
    (() => {
      const result = sanitizeAttributionSnapshot({ firstTouch: validTouch({ utmMedium: { nested: 'object' } }) });
      return result.firstTouch !== null && result.firstTouch.utmMedium === null;
    })()
  );
  check(
    'an empty-string UTM value is treated as invalid/absent, not a real value',
    (() => {
      const result = sanitizeAttributionSnapshot({ firstTouch: validTouch({ utmSource: '' }) });
      return result.firstTouch !== null && result.firstTouch.utmSource === null;
    })()
  );

  // --- unexpected extra fields never leak into the output ---
  check(
    'arbitrary extra fields on the input are never copied to the output touch',
    (() => {
      const result = sanitizeAttributionSnapshot({
        firstTouch: validTouch({ ipAddress: '1.2.3.4', userAgent: 'evil-ua', email: 'x@y.com', __proto__evil: true }),
      });
      const keys = result.firstTouch ? Object.keys(result.firstTouch).sort() : [];
      const expected = [
        'capturedAt',
        'landingPath',
        'referrerHostname',
        'source',
        'sourceLabel',
        'utmCampaign',
        'utmContent',
        'utmMedium',
        'utmSource',
        'utmTerm',
        'v',
      ];
      return JSON.stringify(keys) === JSON.stringify(expected);
    })()
  );

  // --- firstTouch and lastTouch are validated independently ---
  check(
    'a valid firstTouch alongside an invalid lastTouch: firstTouch survives, lastTouch is dropped',
    (() => {
      const result = sanitizeAttributionSnapshot({ firstTouch: validTouch(), lastTouch: { v: 1 /* missing everything else */ } });
      return result.firstTouch !== null && result.lastTouch === null;
    })()
  );

  // --- malformed touch shapes (not just field-level issues) ---
  check('a string in place of a touch object -> null', sanitizeAttributionSnapshot({ firstTouch: 'not an object' }).firstTouch === null);
  check('null touch -> null (not an error)', sanitizeAttributionSnapshot({ firstTouch: null }).firstTouch === null);
  check('an array in place of a touch object -> null', sanitizeAttributionSnapshot({ firstTouch: [1, 2] }).firstTouch === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

run();
