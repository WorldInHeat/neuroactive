// functions/src/dnsCheckout.test.ts
//
// Focused coverage for getOrCreateCheckoutAttempt (the new Checkout-Session idempotency
// mechanism), recordCheckoutCorrelation (the correlation-document race fix), and
// createDnsCheckoutSessionCore (the real session-creation-plus-retry path), plus
// code-review-documented coverage of what it deliberately does NOT touch.
//
// getOrCreateCheckoutAttempt is exported (see __test__ below) and tested directly against
// a minimal fake Firestore — it never calls Stripe at all, so no Stripe mock is needed for
// these tests. Unlike calendarSubscriptions.test.ts's fake (a plain sequential
// runTransaction with no real conflict detection — sufficient for that file's own tests,
// which never need genuine concurrent-transaction semantics), the fake here implements a
// minimal, faithful optimistic-concurrency retry loop: it snapshots the version of every
// document a transaction reads, and if any of them changed by the time the callback
// finishes, the whole callback is re-invoked from scratch — exactly like real Firestore —
// which is what makes the "concurrent calls collapse onto one attempt" test below
// meaningful rather than trivially true by construction.
'use strict';

import { __test__ } from './dnsCheckout';
import { DNS_PROGRAM_PRICE_ID } from './dnsEntitlement';
import { EMPTY_ATTRIBUTION_SNAPSHOT, ATTRIBUTION_SCHEMA_VERSION, type SanitizedAttributionSnapshot, type SanitizedAttributionTouch } from './attribution';

const {
  getOrCreateCheckoutAttempt,
  recordCheckoutCorrelation,
  createDnsCheckoutSessionCore,
  DNS_CHECKOUT_SUCCESS_URL,
  resolveCheckoutAttributionSnapshot,
  userDataRef,
  correlationMatches,
} = __test__;

function makeAttributionSnapshot(utmCampaign: string): SanitizedAttributionSnapshot {
  return {
    v: ATTRIBUTION_SCHEMA_VERSION,
    firstTouch: makeAttributionTouch(utmCampaign),
    lastTouch: null,
  };
}

function makeAttributionTouch(utmCampaign: string, capturedAt = Date.UTC(2026, 0, 1)): SanitizedAttributionTouch {
  return {
      v: ATTRIBUTION_SCHEMA_VERSION,
      landingPath: '/',
      referrerHostname: null,
      utmSource: 'instagram',
      utmMedium: 'social',
      utmCampaign,
      utmContent: null,
      utmTerm: null,
      source: 'utm',
      sourceLabel: null,
      capturedAt,
  };
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
async function checkAsync(label: string, fn: () => Promise<boolean>): Promise<void> {
  try {
    check(label, await fn());
  } catch (err) {
    check(label, false, 'threw: ' + (err instanceof Error ? err.message : String(err)));
  }
}

// ---------------------------------------------------------------------------------------
// MINIMAL FAKE FIRESTORE with faithful optimistic-concurrency retry semantics — see the
// header comment above for why this differs from the shared fake used elsewhere.
// ---------------------------------------------------------------------------------------
type DocData = Record<string, unknown>;

function makeFakeDb() {
  const store = new Map<string, DocData>();
  const versions = new Map<string, number>();
  const bump = (path: string) => versions.set(path, (versions.get(path) ?? 0) + 1);

  function docRef(path: string) {
    return {
      path,
      async get() {
        const exists = store.has(path);
        return { exists, data: () => (exists ? { ...store.get(path)! } : undefined) };
      },
    };
  }

  const db = {
    doc: (path: string) => docRef(path),
    async runTransaction<T>(
      fn: (tx: {
        get: (ref: ReturnType<typeof docRef>) => ReturnType<ReturnType<typeof docRef>['get']>;
        set: (ref: ReturnType<typeof docRef>, data: DocData) => void;
      }) => Promise<T>
    ): Promise<T> {
      for (let attempt = 0; attempt < 25; attempt++) {
        const readVersions = new Map<string, number>();
        const pendingWrites: { path: string; data: DocData }[] = [];
        const tx = {
          get(ref: ReturnType<typeof docRef>) {
            readVersions.set(ref.path, versions.get(ref.path) ?? 0);
            return ref.get();
          },
          set(ref: ReturnType<typeof docRef>, data: DocData) {
            pendingWrites.push({ path: ref.path, data });
          },
        };
        const result = await fn(tx);
        const conflict = [...readVersions.entries()].some(([path, v]) => (versions.get(path) ?? 0) !== v);
        if (conflict) continue; // real Firestore: silently retries the whole callback
        for (const w of pendingWrites) {
          store.set(w.path, { ...w.data });
          bump(w.path);
        }
        return result;
      }
      throw new Error('fake Firestore: too many transaction retries');
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

// ---------------------------------------------------------------------------------------
// MINIMAL FAKE FIRESTORE for recordCheckoutCorrelation — a much smaller surface than
// makeFakeDb above (just doc(path).get()/.create()), since recordCheckoutCorrelation never
// calls runTransaction. Two concurrent calls sharing one of these naturally interleave
// exactly like real async Firestore calls do: both `get()`s resolve before either `create()`
// runs (see the concurrency test below), which is what makes that test a genuine
// reproduction of the race rather than an artificial one.
// ---------------------------------------------------------------------------------------
type CorrelationDocData = Record<string, unknown>;

function makeFakeCorrelationDb() {
  const store = new Map<string, CorrelationDocData>();

  function alreadyExistsError(path: string) {
    const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`);
    (err as { code?: unknown }).code = 6;
    return err;
  }

  function docRef(path: string) {
    return {
      path,
      async get() {
        const exists = store.has(path);
        return { exists, data: () => (exists ? { ...store.get(path)! } : undefined) };
      },
      async create(data: CorrelationDocData) {
        if (store.has(path)) throw alreadyExistsError(path);
        store.set(path, { ...data });
      },
    };
  }

  const db = { doc: (path: string) => docRef(path) };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db: db as any,
    store,
    seed: (path: string, data: CorrelationDocData) => store.set(path, { ...data }),
  };
}

// A dedicated, deterministic variant of the fake above whose FIRST .create() call
// simulates a concurrent invocation winning the race between this invocation's own
// existence check and its own .create() call: it writes a caller-supplied (matching)
// document into the store and THEN throws the "already exists" error, exactly like real
// Firestore would if a concurrent writer committed between our read and our write. This
// isolates and deterministically proves the specific recovery path (catch -> reread ->
// validate) without depending on incidental async-scheduling behavior.
function makeFakeCorrelationDbWithInjectedCreateRace(raceWinnerData: CorrelationDocData) {
  const store = new Map<string, CorrelationDocData>();
  let createCalls = 0;

  function alreadyExistsError(path: string) {
    const err = new Error(`6 ALREADY_EXISTS: Document already exists: ${path}`);
    (err as { code?: unknown }).code = 6;
    return err;
  }

  function docRef(path: string) {
    return {
      path,
      async get() {
        const exists = store.has(path);
        return { exists, data: () => (exists ? { ...store.get(path)! } : undefined) };
      },
      async create(data: CorrelationDocData) {
        createCalls++;
        if (createCalls === 1) {
          store.set(path, { ...raceWinnerData });
          throw alreadyExistsError(path);
        }
        if (store.has(path)) throw alreadyExistsError(path);
        store.set(path, { ...data });
      },
    };
  }

  const db = { doc: (path: string) => docRef(path) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return db as any;
}

// ---------------------------------------------------------------------------------------
// MINIMAL FAKE STRIPE — models create() and retrieve() as two SEPARATE, independently
// scripted calls, matching real Stripe behavior: create() ALWAYS reports status:'open' in
// its response (whether this is a genuinely fresh creation or an idempotency-cache replay
// of an old key — see the header comment on createDnsCheckoutSessionCore in dnsCheckout.ts
// for the documented evidence), so this fake deliberately does NOT let a test fake create()
// into returning a stale status — that would be an unrealistic simulation of the exact
// failure mode this round's fix addresses. Only retrieve() — a live, non-idempotent GET —
// is scripted to return a sequence of authoritative "current" statuses across successive
// create+retrieve pairs.
// ---------------------------------------------------------------------------------------
type FakeRetrieveSpec = {
  status: 'open' | 'complete' | 'expired';
  paymentStatus?: 'paid' | 'unpaid' | 'no_payment_required';
  livemode?: boolean;
};

function makeFakeStripe(retrieveSpecs: FakeRetrieveSpec[]) {
  const createCalls: { idempotencyKey: string }[] = [];
  const retrieveCalls: { id: string }[] = [];
  const stripe = {
    checkout: {
      sessions: {
        async create(_params: unknown, options: { idempotencyKey: string }) {
          createCalls.push({ idempotencyKey: options.idempotencyKey });
          // Real Stripe: a create() response ALWAYS shows status:'open' — see the header
          // comment above. url/livemode here are placeholders; only retrieve()'s response
          // is ever inspected by createDnsCheckoutSessionCore for branching decisions.
          return {
            id: `cs_test_${createCalls.length}`,
            livemode: true,
            url: `https://checkout.stripe.com/create_response_${createCalls.length}`,
            status: 'open',
          };
        },
        async retrieve(id: string) {
          retrieveCalls.push({ id });
          const spec = retrieveSpecs[Math.min(retrieveCalls.length - 1, retrieveSpecs.length - 1)];
          const isActive = spec.status === 'open';
          return {
            id,
            livemode: spec.livemode ?? true,
            // Real Stripe: `url` is only present while the session is active (see the API
            // reference for the `url` field) — null once complete/expired.
            url: isActive ? `https://checkout.stripe.com/live_${retrieveCalls.length}` : null,
            status: spec.status,
            payment_status: spec.paymentStatus ?? (isActive ? 'unpaid' : 'paid'),
          };
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { stripe: stripe as any, createCalls, retrieveCalls };
}

function makeFakeStripeWithFailingRetrieve() {
  const createCalls: { idempotencyKey: string }[] = [];
  const stripe = {
    checkout: {
      sessions: {
        async create(_params: unknown, options: { idempotencyKey: string }) {
          createCalls.push({ idempotencyKey: options.idempotencyKey });
          return {
            id: `cs_test_${createCalls.length}`,
            livemode: true,
            url: `https://checkout.stripe.com/create_response_${createCalls.length}`,
            status: 'open',
          };
        },
        async retrieve(): Promise<never> {
          throw new Error('simulated Stripe API failure (e.g. network error)');
        },
      },
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { stripe: stripe as any, createCalls };
}

async function run() {
  await checkAsync('same uid, immediate second call within the TTL reuses the same idempotency key (retry / double-click)', async () => {
    const db = makeFakeDb();
    const a = await getOrCreateCheckoutAttempt(db, 'uid-A', 60_000);
    const b = await getOrCreateCheckoutAttempt(db, 'uid-A', 60_000);
    return a.idempotencyKey === b.idempotencyKey && a.attemptId === b.attemptId;
  });

  await checkAsync('concurrent (racing) calls for the same uid collapse onto exactly one attempt', async () => {
    const db = makeFakeDb();
    const results = await Promise.all([
      getOrCreateCheckoutAttempt(db, 'uid-B', 60_000),
      getOrCreateCheckoutAttempt(db, 'uid-B', 60_000),
      getOrCreateCheckoutAttempt(db, 'uid-B', 60_000),
      getOrCreateCheckoutAttempt(db, 'uid-B', 60_000),
      getOrCreateCheckoutAttempt(db, 'uid-B', 60_000),
    ]);
    const uniqueKeys = new Set(results.map((r) => r.idempotencyKey));
    return uniqueKeys.size === 1;
  });

  await checkAsync('different uids never share an attempt or idempotency key', async () => {
    const db = makeFakeDb();
    const a = await getOrCreateCheckoutAttempt(db, 'uid-C1', 60_000);
    const b = await getOrCreateCheckoutAttempt(db, 'uid-C2', 60_000);
    return a.idempotencyKey !== b.idempotencyKey && a.attemptId !== b.attemptId;
  });

  await checkAsync('a later call after the attempt window expires mints a genuinely new attempt (does not block forever)', async () => {
    const db = makeFakeDb();
    const first = await getOrCreateCheckoutAttempt(db, 'uid-D', 10); // 10ms TTL
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = await getOrCreateCheckoutAttempt(db, 'uid-D', 10);
    return first.idempotencyKey !== second.idempotencyKey && first.attemptId !== second.attemptId;
  });

  await checkAsync('a call within the window after a first, still-fresh attempt does NOT create a new one merely because time passed a little', async () => {
    const db = makeFakeDb();
    const first = await getOrCreateCheckoutAttempt(db, 'uid-E', 60_000);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await getOrCreateCheckoutAttempt(db, 'uid-E', 60_000);
    return first.idempotencyKey === second.idempotencyKey;
  });

  await checkAsync('idempotency key is deterministic given the same (uid, attemptId) pair, not random per call', async () => {
    const db = makeFakeDb();
    const a = await getOrCreateCheckoutAttempt(db, 'uid-F', 60_000);
    // A second, completely independent db (simulating a fresh function instance with no
    // shared in-memory state) but the SAME uid and an attempt record already reflecting
    // the same attemptId (as real Firestore would durably persist) must derive the exact
    // same key — proving the key is a pure function of (uid, attemptId), not of process
    // identity, call count, or any other per-invocation randomness.
    const db2 = makeFakeDb();
    await db2.runTransaction(async (tx: { set: (ref: unknown, data: DocData) => void }) => {
      tx.set(db2.doc(`dnsCheckoutAttempts/uid-F`), { attemptId: a.attemptId, createdAtMs: Date.now() });
    });
    const b = await getOrCreateCheckoutAttempt(db2, 'uid-F', 60_000);
    return a.idempotencyKey === b.idempotencyKey;
  });

  // ---------------------------------------------------------------------------------------
  // recordCheckoutCorrelation — the correlation-document race fix.
  // ---------------------------------------------------------------------------------------

  await checkAsync('two simultaneous invocations resolving to the same Checkout Session both succeed, and only one compatible document results', async () => {
    const { db, store } = makeFakeCorrelationDb();
    const params = { sessionId: 'cs_race1', uid: 'uid-R1', stripeCustomerId: 'cus_R1', livemode: true, attribution: EMPTY_ATTRIBUTION_SNAPSHOT };
    const results = await Promise.allSettled([
      recordCheckoutCorrelation(db, params),
      recordCheckoutCorrelation(db, params),
    ]);
    const bothSucceeded = results.every((r) => r.status === 'fulfilled');
    const doc = store.get('stripeDnsCheckoutSessions/cs_race1');
    const exactlyOneMatchingDoc =
      store.size === 1 &&
      doc?.uid === 'uid-R1' &&
      doc?.stripeCustomerId === 'cus_R1' &&
      doc?.checkoutSessionId === 'cs_race1';
    return bothSucceeded && exactlyOneMatchingDoc;
  });

  await checkAsync('idempotent checkout retries with DIFFERING attribution snapshots produce exactly one compatible document (first successful writer wins, neither call throws)', async () => {
    const { db, store } = makeFakeCorrelationDb();
    const sessionId = 'cs_race_attr1';
    const uid = 'uid-R1B';
    const stripeCustomerId = 'cus_R1B';
    const attrA = makeAttributionSnapshot('campaign-A');
    const attrB = makeAttributionSnapshot('campaign-B');
    const results = await Promise.allSettled([
      recordCheckoutCorrelation(db, { sessionId, uid, stripeCustomerId, livemode: true, attribution: attrA }),
      recordCheckoutCorrelation(db, { sessionId, uid, stripeCustomerId, livemode: true, attribution: attrB }),
    ]);
    const bothSucceeded = results.every((r) => r.status === 'fulfilled');
    const doc = store.get(`stripeDnsCheckoutSessions/${sessionId}`);
    const storedCampaign = (doc?.attribution as SanitizedAttributionSnapshot | undefined)?.firstTouch?.utmCampaign;
    // Exactly one document, and its attribution is WHICHEVER call's snapshot actually won
    // the underlying create() race — never a merge, never both, and (critically) never a
    // thrown "mismatch" error merely because the two calls carried different attribution.
    const oneCompatibleSnapshot = store.size === 1 && (storedCampaign === 'campaign-A' || storedCampaign === 'campaign-B');
    return bothSucceeded && oneCompatibleSnapshot;
  });

  check('correlationMatches (the idempotent-reuse/conflict check) ignores attribution entirely — a differing attribution snapshot is never treated as a conflict', (() => {
    const base = {
      uid: 'uid-M1',
      stripeCustomerId: 'cus_M1',
      stripePriceId: DNS_PROGRAM_PRICE_ID,
      quantity: 1,
      mode: 'payment',
      livemode: true,
      checkoutSessionId: 'cs_m1',
    };
    const withAttrA = { ...base, attribution: makeAttributionSnapshot('A') };
    const withAttrB = { ...base, attribution: makeAttributionSnapshot('B') };
    const withNoAttr = { ...base };
    return (
      correlationMatches(withAttrA, 'cs_m1', 'uid-M1', 'cus_M1') === true &&
      correlationMatches(withAttrB, 'cs_m1', 'uid-M1', 'cus_M1') === true &&
      correlationMatches(withNoAttr, 'cs_m1', 'uid-M1', 'cus_M1') === true
    );
  })());

  await checkAsync('a sequential retry with attribution ABSENT after the first write had it PRESENT is still accepted as idempotent success (never a conflict)', async () => {
    const { db } = makeFakeCorrelationDb();
    const sessionId = 'cs_seq1';
    const uid = 'uid-SEQ1';
    const stripeCustomerId = 'cus_SEQ1';
    await recordCheckoutCorrelation(db, { sessionId, uid, stripeCustomerId, livemode: true, attribution: makeAttributionSnapshot('present-first') });
    // A later retry of the SAME logical attempt whose own attribution resolution came up
    // empty this time (e.g. Firestore was briefly unreachable on this particular retry) —
    // must still be accepted, and must NOT overwrite the first (already-recorded) snapshot.
    await recordCheckoutCorrelation(db, { sessionId, uid, stripeCustomerId, livemode: true, attribution: EMPTY_ATTRIBUTION_SNAPSHOT });
    return true; // must not have thrown
  });

  await checkAsync('a sequential retry with attribution PRESENT after the first write had it ABSENT is still accepted as idempotent success (and does not retroactively overwrite the recorded — empty — snapshot)', async () => {
    const { db, store } = makeFakeCorrelationDb();
    const sessionId = 'cs_seq2';
    const uid = 'uid-SEQ2';
    const stripeCustomerId = 'cus_SEQ2';
    await recordCheckoutCorrelation(db, { sessionId, uid, stripeCustomerId, livemode: true, attribution: EMPTY_ATTRIBUTION_SNAPSHOT });
    await recordCheckoutCorrelation(db, { sessionId, uid, stripeCustomerId, livemode: true, attribution: makeAttributionSnapshot('present-second') });
    const doc = store.get(`stripeDnsCheckoutSessions/${sessionId}`);
    // First successful writer wins — the second call's (differing) attribution is
    // silently discarded, exactly like the concurrent case, just observed sequentially.
    return (doc?.attribution as SanitizedAttributionSnapshot)?.firstTouch === null;
  });

  await checkAsync('an already-existing compatible correlation document is accepted as idempotent success', async () => {
    const { db } = makeFakeCorrelationDb();
    const params = { sessionId: 'cs_ok1', uid: 'uid-R2', stripeCustomerId: 'cus_R2', livemode: true, attribution: EMPTY_ATTRIBUTION_SNAPSHOT };
    await recordCheckoutCorrelation(db, params);
    await recordCheckoutCorrelation(db, params); // second call: doc already exists, must not throw
    return true;
  });

  await checkAsync('a conflicting existing correlation document fails closed', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    seed('stripeDnsCheckoutSessions/cs_conflict1', {
      uid: 'uid-OTHER',
      stripeCustomerId: 'cus_OTHER',
      stripePriceId: DNS_PROGRAM_PRICE_ID,
      quantity: 1,
      mode: 'payment',
      livemode: true,
      checkoutSessionId: 'cs_conflict1',
    });
    try {
      await recordCheckoutCorrelation(db, {
        sessionId: 'cs_conflict1',
        uid: 'uid-R3', // different uid than the seeded doc -> mismatch
        stripeCustomerId: 'cus_R3',
        livemode: true,
        attribution: EMPTY_ATTRIBUTION_SNAPSHOT,
      });
      return false; // must have thrown
    } catch {
      return true;
    }
  });

  await checkAsync('a create-time ALREADY_EXISTS race is recovered by rereading and validating', async () => {
    const params = { sessionId: 'cs_race2', uid: 'uid-R4', stripeCustomerId: 'cus_R4', livemode: true, attribution: EMPTY_ATTRIBUTION_SNAPSHOT };
    const db = makeFakeCorrelationDbWithInjectedCreateRace({
      uid: params.uid,
      stripeCustomerId: params.stripeCustomerId,
      stripePriceId: DNS_PROGRAM_PRICE_ID,
      quantity: 1,
      mode: 'payment',
      livemode: true,
      checkoutSessionId: params.sessionId,
    });
    await recordCheckoutCorrelation(db, params); // must not throw despite the injected race
    return true;
  });

  await checkAsync('a create-time ALREADY_EXISTS race whose winner does NOT match still fails closed', async () => {
    const params = { sessionId: 'cs_race3', uid: 'uid-R5', stripeCustomerId: 'cus_R5', livemode: true, attribution: EMPTY_ATTRIBUTION_SNAPSHOT };
    const db = makeFakeCorrelationDbWithInjectedCreateRace({
      uid: 'uid-DIFFERENT', // race winner recorded a DIFFERENT uid for this session id
      stripeCustomerId: params.stripeCustomerId,
      stripePriceId: DNS_PROGRAM_PRICE_ID,
      quantity: 1,
      mode: 'payment',
      livemode: true,
      checkoutSessionId: params.sessionId,
    });
    try {
      await recordCheckoutCorrelation(db, params);
      return false; // must have thrown
    } catch {
      return true;
    }
  });

  // ---------------------------------------------------------------------------------------
  // createDnsCheckoutSessionCore — the real Checkout Session creation + AUTHORITATIVE
  // live-state resolution path (create() response status is never trusted; only a
  // separate retrieve() call is).
  // ---------------------------------------------------------------------------------------

  await checkAsync('createDnsCheckoutSessionCore passes the SAME idempotency key getOrCreateCheckoutAttempt produces to stripe.checkout.sessions.create, and a live "open" retrieve reuses the original (no second session)', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S1';
    const ttlMs = 60_000;
    const expected = await getOrCreateCheckoutAttempt(db, uid, ttlMs); // pre-existing fresh attempt
    const { stripe, createCalls, retrieveCalls } = makeFakeStripe([{ status: 'open' }]);
    const result = await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S1', ttlMs);
    return (
      createCalls.length === 1 && // no forced-retry: the live retrieve said 'open', so the original is reused
      retrieveCalls.length === 1 &&
      createCalls[0].idempotencyKey === expected.idempotencyKey &&
      !!result.url &&
      result.url !== DNS_CHECKOUT_SUCCESS_URL
    );
  });

  await checkAsync('an expired ATTEMPT (TTL elapsed) produces a new Stripe idempotency key and a genuinely new Checkout Session', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S2';
    const ttlMs = 10; // short attempt TTL (unrelated to Stripe's own session status)
    const { stripe, createCalls } = makeFakeStripe([{ status: 'open' }, { status: 'open' }]);
    await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S2', ttlMs);
    await new Promise((resolve) => setTimeout(resolve, 30)); // let the attempt expire
    await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S2', ttlMs);
    return createCalls.length === 2 && createCalls[0].idempotencyKey !== createCalls[1].idempotencyKey;
  });

  await checkAsync('idempotent create() replay reports cached status "open" while the authoritative retrieve reports "expired": exactly one fresh replacement Session is created', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S3';
    const ttlMs = 60_000;
    // Realistic reproduction of this round's exact defect scenario: create()'s response is
    // NEVER told to lie about being 'open' (the fake can't even express that — see its
    // header comment) — instead the separately-scripted retrieve() is what reports the
    // true, changed state, exactly like the real Stripe API would.
    const { stripe, createCalls, retrieveCalls } = makeFakeStripe([{ status: 'expired' }, { status: 'open' }]);
    const result = await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S3', ttlMs);
    return (
      createCalls.length === 2 &&
      retrieveCalls.length === 2 &&
      createCalls[0].idempotencyKey !== createCalls[1].idempotencyKey &&
      !!result.url
    );
  });

  await checkAsync('idempotent create() replay reports "open" while the authoritative retrieve reports "complete" + paid: NO second Checkout Session is created, and the app success destination is returned', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S4';
    const ttlMs = 60_000;
    const { stripe, createCalls, retrieveCalls } = makeFakeStripe([{ status: 'complete', paymentStatus: 'paid' }]);
    const result = await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S4', ttlMs);
    return (
      createCalls.length === 1 && // NEVER a second create call for an already-completed purchase
      retrieveCalls.length === 1 &&
      result.url === DNS_CHECKOUT_SUCCESS_URL
    );
  });

  await checkAsync('the same pattern with payment_status "no_payment_required" (100%-off Session) is equally safe: no second Session, success destination returned', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S5';
    const ttlMs = 60_000;
    const { stripe, createCalls } = makeFakeStripe([{ status: 'complete', paymentStatus: 'no_payment_required' }]);
    const result = await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S5', ttlMs);
    return createCalls.length === 1 && result.url === DNS_CHECKOUT_SUCCESS_URL;
  });

  await checkAsync('webhook/entitlement fulfillment lag does not produce a duplicate purchase opportunity: the safe outcome does not depend on any correlation or entitlement document existing', async () => {
    // No Firestore document of ANY kind is seeded beyond the attempt record makeFakeDb
    // creates internally — createDnsCheckoutSessionCore never reads correlation or
    // entitlement state, proving its safety here does not (and must not) depend on
    // whether the completion webhook has run yet.
    const db = makeFakeDb();
    const uid = 'uid-S6';
    const { stripe, createCalls } = makeFakeStripe([{ status: 'complete', paymentStatus: 'paid' }]);
    const result = await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S6', 60_000);
    return createCalls.length === 1 && result.url === DNS_CHECKOUT_SUCCESS_URL;
  });

  await checkAsync('an unexpected status/payment_status combination (complete + unpaid, e.g. a still-settling async payment method) fails closed without creating another Session', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S7';
    const { stripe, createCalls } = makeFakeStripe([{ status: 'complete', paymentStatus: 'unpaid' }]);
    try {
      await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S7', 60_000);
      return false; // must have thrown
    } catch {
      return createCalls.length === 1; // and must not have attempted a second Session
    }
  });

  await checkAsync('a forced-new attempt whose session is STILL not open (pathological) fails closed rather than looping', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S8';
    const { stripe, createCalls } = makeFakeStripe([{ status: 'expired' }, { status: 'expired' }]);
    try {
      await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S8', 60_000);
      return false; // must have thrown
    } catch {
      return createCalls.length === 2; // exactly the original + one forced-new attempt, no loop
    }
  });

  await checkAsync('a Stripe retrieve failure (e.g. network error) fails closed without creating another Session', async () => {
    const db = makeFakeDb();
    const uid = 'uid-S9';
    const { stripe, createCalls } = makeFakeStripeWithFailingRetrieve();
    try {
      await createDnsCheckoutSessionCore(stripe, db, uid, 'cus_S9', 60_000);
      return false; // must have thrown
    } catch {
      return createCalls.length === 1;
    }
  });

  // ---------------------------------------------------------------------------------------
  // resolveCheckoutAttributionSnapshot — best-effort, never-blocking read at checkout time.
  // ---------------------------------------------------------------------------------------

  await checkAsync('missing userData document -> empty attribution snapshot, no throw (checkout proceeds normally)', async () => {
    const { db } = makeFakeCorrelationDb();
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-NOATTR1', undefined);
    return result.firstTouch === null && result.lastTouch === null;
  });

  await checkAsync('a userData document with no attribution field -> empty snapshot, no throw', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    seed(userDataRef(db, 'uid-NOATTR2').path, { dnsCourse: { currentDay: 3 } });
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-NOATTR2', undefined);
    return result.firstTouch === null && result.lastTouch === null;
  });

  await checkAsync('a valid attribution field on the userData document is read and passed through sanitization intact', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    const snapshot = makeAttributionSnapshot('read-through-campaign');
    seed(userDataRef(db, 'uid-ATTR1').path, { attribution: snapshot });
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-ATTR1', undefined);
    return result.firstTouch?.utmCampaign === 'read-through-campaign';
  });

  await checkAsync('a malformed attribution field on the userData document degrades to an empty snapshot rather than throwing', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    seed(userDataRef(db, 'uid-ATTR2').path, {
      attribution: { firstTouch: { v: 999, garbage: true } },
    });
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-ATTR2', undefined);
    return result.firstTouch === null && result.lastTouch === null;
  });

  await checkAsync('a Firestore read failure degrades to an empty snapshot rather than throwing (never blocks checkout)', async () => {
    const throwingDb = {
      doc: () => ({
        async get() {
          throw new Error('simulated Firestore outage');
        },
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveCheckoutAttributionSnapshot(throwingDb as any, 'uid-ATTR3', undefined);
    return result.firstTouch === null && result.lastTouch === null;
  });

  // ---------------------------------------------------------------------------------------
  // Fast-checkout attribution gap fix: the OPTIONAL client-supplied request payload is a
  // atomic-touch reconciliation for whatever the Firestore flush didn't land in time.
  // ---------------------------------------------------------------------------------------

  await checkAsync('Firestore has no attribution document at all: the client-supplied payload is used as a fallback (the fast-checkout case)', async () => {
    const { db } = makeFakeCorrelationDb();
    const clientPayload = makeAttributionSnapshot('rapid-purchase-campaign');
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-FAST1', clientPayload);
    return result.firstTouch?.utmCampaign === 'rapid-purchase-campaign';
  });

  await checkAsync('Firestore already has a (different) firstTouch: Firestore wins, the client payload is ignored for that field — a client can never override an already-established first touch', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    const firestoreSnapshot = makeAttributionSnapshot('original-firestore-campaign');
    seed(userDataRef(db, 'uid-FAST2').path, { attribution: firestoreSnapshot });
    const clientPayload = makeAttributionSnapshot('spoofed-client-campaign');
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-FAST2', clientPayload);
    return result.firstTouch?.utmCampaign === 'original-firestore-campaign';
  });

  await checkAsync('Firestore firstTouch and client lastTouch are selected as separate complete touches, never merged within a touch', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    seed(userDataRef(db, 'uid-FAST3').path, {
      attribution: { v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: makeAttributionSnapshot('remote-first').firstTouch, lastTouch: null },
    });
    const clientPayload: SanitizedAttributionSnapshot = {
      v: ATTRIBUTION_SCHEMA_VERSION,
      firstTouch: makeAttributionSnapshot('client-first-should-be-ignored').firstTouch,
      lastTouch: makeAttributionSnapshot('client-last-should-win').firstTouch, // reused as a lastTouch value
    };
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-FAST3', clientPayload);
    return result.firstTouch?.utmCampaign === 'remote-first' && result.lastTouch?.utmCampaign === 'client-last-should-win';
  });

  await checkAsync('a complete Firestore direct first touch remains whole when the client supplies a complete UTM first touch', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    const remoteDirect = { ...makeAttributionTouch('unused'), source: 'direct' as const, landingPath: '/', utmSource: null, utmMedium: null, utmCampaign: null };
    seed(userDataRef(db, 'uid-ATOMIC1').path, { attribution: { v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: remoteDirect, lastTouch: null } });
    const client = makeAttributionSnapshot('instagram-client');
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-ATOMIC1', client);
    return JSON.stringify(result.firstTouch) === JSON.stringify(remoteDirect);
  });

  await checkAsync('a partial Firestore first touch is discarded whole and falls back to the complete client first touch', async () => {
    const { db, seed } = makeFakeCorrelationDb();
    const client = makeAttributionSnapshot('complete-client');
    seed(userDataRef(db, 'uid-ATOMIC2').path, { attribution: { v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: { v: 1, source: 'direct', capturedAt: Date.UTC(2026, 0, 1) }, lastTouch: null } });
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-ATOMIC2', client);
    return JSON.stringify(result.firstTouch) === JSON.stringify(client.firstTouch);
  });

  for (const [label, remoteAt, clientAt, expected] of [
    ['newer client last touch wins whole', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2), 'client'],
    ['newer Firestore last touch wins whole', Date.UTC(2026, 0, 2), Date.UTC(2026, 0, 1), 'remote'],
    ['timestamp tie deterministically prefers Firestore whole', Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 1), 'remote'],
  ] as const) {
    await checkAsync(label, async () => {
      const { db, seed } = makeFakeCorrelationDb();
      const remote = makeAttributionTouch('remote', remoteAt);
      const client = makeAttributionTouch('client', clientAt);
      seed(userDataRef(db, `uid-LAST-${label}`).path, { attribution: { v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: null, lastTouch: remote } });
      const result = await resolveCheckoutAttributionSnapshot(db, `uid-LAST-${label}`, { v: ATTRIBUTION_SCHEMA_VERSION, firstTouch: null, lastTouch: client });
      return JSON.stringify(result.lastTouch) === JSON.stringify(expected === 'remote' ? remote : client);
    });
  }

  await checkAsync('a Firestore read failure falls back entirely to the (independently re-sanitized) client-supplied payload rather than an empty snapshot', async () => {
    const throwingDb = {
      doc: () => ({
        async get() {
          throw new Error('simulated Firestore outage');
        },
      }),
    };
    const clientPayload = makeAttributionSnapshot('offline-fallback-campaign');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await resolveCheckoutAttributionSnapshot(throwingDb as any, 'uid-FAST4', clientPayload);
    return result.firstTouch?.utmCampaign === 'offline-fallback-campaign';
  });

  await checkAsync('no attribution ANYWHERE (Firestore empty, no client payload) still resolves harmlessly — checkout is never blocked', async () => {
    const { db } = makeFakeCorrelationDb();
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-FAST5', undefined);
    return result.firstTouch === null && result.lastTouch === null;
  });

  await checkAsync('a malicious/malformed client-supplied payload (oversized value, control character, fabricated PII-shaped field) is independently re-sanitized — nothing raw ever survives into the recorded snapshot', async () => {
    const { db } = makeFakeCorrelationDb();
    const maliciousPayload = {
      v: ATTRIBUTION_SCHEMA_VERSION,
      firstTouch: {
        v: ATTRIBUTION_SCHEMA_VERSION,
        landingPath: '/',
        referrerHostname: null,
        utmSource: 'x'.repeat(9999), // wildly oversized
        utmMedium: 'evil\x07bell', // control character
        utmCampaign: null,
        utmContent: null,
        utmTerm: null,
        source: 'utm',
        sourceLabel: null,
        capturedAt: Date.now(),
        email: 'attacker@example.com', // fabricated field this schema has no place for
        ipAddress: '1.2.3.4',
      },
      lastTouch: null,
    };
    const result = await resolveCheckoutAttributionSnapshot(db, 'uid-FAST6', maliciousPayload);
    const json = JSON.stringify(result);
    return (
      result.firstTouch?.utmSource?.length === 100 && // truncated to the real limit, not 9999
      result.firstTouch?.utmMedium === null && // control character -> dropped, not stored raw
      !json.includes('attacker@example.com') &&
      !json.includes('1.2.3.4')
    );
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

void run();

// ---------------------------------------------------------------------------------------
// NOT re-tested here (unchanged by this diff — verified by code review instead):
//
// - "paid and 100%-off sessions remain correctly distinguishable": entirely governed by
//   isCompletedNoCostPaymentSession/handleDnsNoCostCheckout's own completion-time checks
//   (amount_total, payment_intent nullness, payment_status), none of which this diff
//   touches — creation-time idempotency has no bearing on what a session resolves to
//   once a customer completes or discounts it on Stripe's own hosted page.
// - "no entitlement is granted merely by creating a session": entitlement is granted
//   exclusively by handleDnsNoCostCheckout (no-cost) and recomputeDnsEntitlement (paid,
//   triggered off the Stripe extension's payments/ mirror write) — both fire only on
//   COMPLETION webhooks, never on session creation, and neither is touched by this diff.
// - "existing customer ownership checks remain intact": getOrCreateStripeCustomer and
//   verifyStripeCustomerOwnership are unmodified by this diff; this test file does not
//   need to re-prove code it never changed.
// ---------------------------------------------------------------------------------------
