// functions/src/dnsTrialRules.emulatorSuite.ts
// Firestore-emulator-only proof of the firestore.rules guard on DNS course progression
// (userData/main.dnsCourse.currentDay may only increase for permanent entitlement, or for
// an unexpired free trial up to 15) — evaluated by the REAL rules engine, which the
// in-process fakes used by the ordinary *.test.ts files cannot do.
//
// EXCLUDED FROM THE PRODUCTION BUILD (tsconfig.json excludes src/**/*.emulatorSuite.ts)
// and from `npm test` (its glob only matches *.test.js) — same convention as
// reminderDeliveryAuth.emulatorSuite.ts. Uses only a synthetic demo project, never
// 'neuroactive', and refuses to run unless FIRESTORE_EMULATOR_HOST points at localhost.
// Talks to the emulator's REST API directly with unsigned test ID tokens (the emulator
// accepts alg:none tokens) and the emulator-only `Bearer owner` admin bypass for seeding.
//
// HOW TO RUN (from the repository root, never via `npm test`):
//   npm --prefix functions run build:test
//   npx firebase-tools emulators:exec --only firestore --project demo-neuroactive-trial-rules \
//     "node functions/lib-test/dnsTrialRules.emulatorSuite.js"

const PROJECT = 'demo-neuroactive-trial-rules';
const APP_ID = 'neuroactive-prod';
const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
if (!/^(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(host)) {
  throw new Error(`Refusing to run: FIRESTORE_EMULATOR_HOST must be a local emulator (got "${host}").`);
}
if ([process.env.GCLOUD_PROJECT, process.env.GOOGLE_CLOUD_PROJECT].includes('neuroactive')) {
  throw new Error('Refusing to run against the real neuroactive project.');
}
const BASE = `http://${host}/v1/projects/${PROJECT}/databases/(default)/documents`;

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, detail?: string): void {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail ? ': ' + detail : ''}`);
  if (cond) pass++;
  else fail++;
}

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken(uid: string): string {
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    sub: uid,
    user_id: uid,
    iat: now,
    exp: now + 3600,
    auth_time: now,
    firebase: { sign_in_provider: 'password', identities: {} },
  })}.`;
}

type Value = Record<string, unknown>;
const int = (n: number): Value => ({ integerValue: String(n) });
const str = (s: string): Value => ({ stringValue: s });
const bool = (b: boolean): Value => ({ booleanValue: b });
const ts = (ms: number): Value => ({ timestampValue: new Date(ms).toISOString() });
const map = (fields: Record<string, Value>): Value => ({ mapValue: { fields } });

async function write(path: string, fields: Record<string, Value>, auth: string): Promise<number> {
  const res = await fetch(`${BASE}/${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auth}` },
    body: JSON.stringify({ fields }),
  });
  await res.text();
  return res.status;
}
async function remove(path: string, auth: string): Promise<number> {
  const res = await fetch(`${BASE}/${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${auth}` } });
  await res.text();
  return res.status;
}
const ent = (uid: string) => `artifacts/${APP_ID}/users/${uid}/entitlement/main`;
const ud = (uid: string) => `artifacts/${APP_ID}/users/${uid}/userData/main`;
const course = (currentDay: Value) => ({ dnsCourse: map({ currentDay, startedAt: str('2026-10-07'), lastCompletedDate: str('') }) });
const DAY = 86400000;

async function seed(uid: string, entitlement: Record<string, Value> | null, currentDay: number | null): Promise<void> {
  if (entitlement) await write(ent(uid), entitlement, 'owner');
  if (currentDay !== null) await write(ud(uid), course(int(currentDay)), 'owner');
}
const asUser = (uid: string, fields: Record<string, Value>) => write(ud(uid), fields, idToken(uid));
const ok = (s: number) => s === 200;
const denied = (s: number) => s === 403;

const trialEnt = (expiresAtMs: number) => ({
  bases: map({ dns_trial: map({ type: str('dns_trial'), startedAt: ts(expiresAtMs - 14 * DAY), expiresAt: ts(expiresAtMs) }) }),
});

async function run(): Promise<void> {
  const now = Date.now();

  // Active trial
  await seed('trial', trialEnt(now + 7 * DAY), 1);
  check('active trial: Day 1 → 2 allowed', ok(await asUser('trial', course(int(2)))));
  await seed('trial', null, 14);
  check('active trial: complete Day 14 (→ 15) allowed', ok(await asUser('trial', course(int(15)))));
  check('13. active trial: complete Day 15 (→ 16) denied', denied(await asUser('trial', course(int(16)))));
  await seed('trial', null, 1);
  check('13. active trial: direct jump 1 → 40 denied', denied(await asUser('trial', course(int(40)))));
  check('13. active trial: fractional 15.5 denied', denied(await asUser('trial', course({ doubleValue: 15.5 }))));
  check('active trial: non-progress write (attribution-style) allowed', ok(await asUser('trial', { ...course(int(1)), isPremium: bool(false) })));

  // Malformed-value laundering
  await seed('launder', trialEnt(now + 7 * DAY), 1);
  check('junk currentDay write is harmless (allowed)', ok(await asUser('launder', course(str('x')))));
  check('13. junk-then-jump 40 denied', denied(await asUser('launder', course(int(40)))));

  // Expired trial
  await seed('expired', trialEnt(now - DAY), 5);
  check('expired trial: Day 5 → 6 denied (no further progression)', denied(await asUser('expired', course(int(6)))));
  check('expired trial: unrelated write with unchanged currentDay allowed', ok(await asUser('expired', { ...course(int(5)), hasAgreedToTerms: bool(true) })));
  check('expired trial: decrease allowed', ok(await asUser('expired', course(int(4)))));

  // Permanent
  await seed('perm', { dnsFoundationsEntitled: bool(true) }, 15);
  check('permanent: Day 15 → 16 allowed', ok(await asUser('perm', course(int(16)))));
  check('permanent: → 85 (course complete) allowed', ok(await asUser('perm', course(int(85)))));
  await seed('perm-plus-trial', { dnsFoundationsEntitled: bool(true), ...trialEnt(now - DAY) }, 15);
  check('14. purchased after expired trial: Day 15 → 16 allowed', ok(await asUser('perm-plus-trial', course(int(16)))));

  // No access
  await seed('none', null, null);
  check('no access: create userData without progress allowed', ok(await asUser('none', { hasAgreedToTerms: bool(true) })));
  check('no access: startedAt-only course write (Day 1) allowed', ok(await asUser('none', course(int(1)))));
  check('no access: Day 1 → 2 denied', denied(await asUser('none', course(int(2)))));
  await seed('revoked', { dnsFoundationsEntitled: bool(false) }, 30);
  check('revoked/refunded: unrelated write with existing currentDay 30 allowed', ok(await asUser('revoked', { ...course(int(30)), isPremium: bool(false) })));
  check('revoked/refunded: 30 → 31 denied', denied(await asUser('revoked', course(int(31)))));

  // Unchanged ownership semantics
  check('other uid cannot write', denied(await write(ud('trial'), course(int(1)), idToken('intruder'))));
  check('owner can still delete own userData', ok(await remove(ud('none'), idToken('none'))));
  check('entitlement remains client-unwritable', denied(await write(ent('trial'), { dnsFoundationsEntitled: bool(true) }, idToken('trial'))));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exitCode = fail > 0 ? 1 : 0;
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
