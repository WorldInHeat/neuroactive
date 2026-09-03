// functions/src/calendarSubscriptions.test.ts
// Calendar Integration Phase 1, Stage 1 tests.
//
// IMPORTANT CAVEAT, stated explicitly rather than implied: the `firebase` CLI is not
// available in this environment, so these are NOT real Firebase emulator tests (unlike
// reminderDeliveryAuth.emulatorSuite.ts elsewhere in this project, which the project's own
// tooling can run against a live emulator). These tests exercise the db-parameterized
// "Core" functions (see calendarSubscriptions.ts's own header on this testing seam)
// against a minimal FAKE Firestore, matching the pattern already used in
// reminderDeliveryWorker.test.ts for the same reason (no live emulator dependency for fast
// unit-level coverage). Real emulator/rules verification is still recommended before this
// stage is considered fully verified — see the final report's open questions.
'use strict';

import { createHash } from 'node:crypto';
import {
  createCalendarSubscriptionCore,
  revokeCalendarSubscriptionCore,
  revokeAllCalendarSubscriptionsCore,
  handleCalendarUserDeletedCore,
  __test__,
} from './calendarSubscriptions';

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
// MINIMAL FAKE FIRESTORE — doc/collection/where(==)/get, runTransaction, batch. A value
// that looks like a Firestore FieldValue/Timestamp sentinel (has an `isEqual` method — the
// one trait shared by both real FieldValue.serverTimestamp() sentinels and real Timestamp
// instances, and nothing this test ever legitimately sets) is resolved to a plain fake
// timestamp marker so equality/truthiness checks in the tests behave sensibly.
// ---------------------------------------------------------------------------------------
type DocData = Record<string, unknown>;

function looksLikeFirestoreSentinel(v: unknown): boolean {
  return !!v && typeof v === 'object' && typeof (v as { isEqual?: unknown }).isEqual === 'function';
}
function resolveWrite(data: DocData): DocData {
  const out: DocData = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = looksLikeFirestoreSentinel(v) ? { __fakeTimestamp: true, atMs: Date.now() } : v;
  }
  return out;
}

class FakeDocRef {
  constructor(
    private store: Map<string, DocData>,
    public path: string,
    public id: string
  ) {}
  async get() {
    const exists = this.store.has(this.path);
    const data = exists ? { ...this.store.get(this.path)! } : undefined;
    return { exists, ref: this, data: () => data };
  }
  collection(name: string) {
    return makeCollection(this.store, `${this.path}/${name}`);
  }
}

function makeCollection(store: Map<string, DocData>, prefix: string, filters: { field: string; value: unknown }[] = []) {
  let autoCounter = 0;
  return {
    doc(id?: string) {
      // BUG FOUND DURING TESTING (documented rather than silently fixed): an earlier
      // version of this auto-ID template interpolated `prefix` (a full collection PATH)
      // directly into what must be a single path SEGMENT — e.g.
      // "auto-artifacts/neuroactive-prod/.../calendarSubscriptions-1-xyz". Since that
      // embedded slashes into the doc ID itself, every subsequent `rest.includes('/')`
      // "direct children only" check below saw those documents as (incorrectly) nested,
      // silently excluding them from every collection/query .get() — including the
      // active-subscription cap check — while direct-by-ID lookups (which don't call
      // `.get()` on a collection) still worked, and while genuine emulator-style testing
      // (not this fake) would never have hit this at all. Fixed to a short, slash-free
      // random token, matching every other fake-Firestore harness used elsewhere in this
      // project's test suites.
      // SECOND BUG FOUND DURING THIS REPAIR PASS: after the fix above, the token still
      // wasn't shaped like a real Firestore auto-ID (it contained hyphens and was the
      // wrong length). That was harmless until requireSubscriptionId() in
      // calendarSubscriptions.ts was tightened to a strict 20-char [A-Za-z0-9] allowlist
      // (Codex repair item 5) -- at which point every test that round-trips a
      // create-returned subscriptionId back into revokeCalendarSubscriptionCore started
      // throwing "subscriptionId must be a valid subscription identifier." Fixed by
      // generating a genuinely Firestore-auto-ID-shaped token (20 chars, [A-Za-z0-9] only)
      // instead of the ad hoc "auto-N-random" format.
      const docId = id ?? (() => {
        ++autoCounter;
        const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        let out = '';
        for (let i = 0; i < 20; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
        return out;
      })();
      return new FakeDocRef(store, `${prefix}/${docId}`, docId);
    },
    where(field: string, op: string, value: unknown) {
      if (op !== '==') throw new Error('fake Firestore: only "==" is supported');
      return makeCollection(store, prefix, [...filters, { field, value }]);
    },
    async get() {
      const docs: { id: string; ref: FakeDocRef; data: () => DocData }[] = [];
      for (const [path, data] of store.entries()) {
        if (!path.startsWith(prefix + '/')) continue;
        const rest = path.slice(prefix.length + 1);
        if (rest.includes('/')) continue; // direct children only
        if (!filters.every((f) => data[f.field] === f.value)) continue;
        docs.push({ id: rest, ref: new FakeDocRef(store, path, rest), data: () => ({ ...data }) });
      }
      return { size: docs.length, empty: docs.length === 0, docs };
    },
  };
}

function makeFakeDb() {
  const store = new Map<string, DocData>();
  const db = {
    doc(path: string) {
      const segs = path.split('/');
      return new FakeDocRef(store, path, segs[segs.length - 1]);
    },
    collection(path: string) {
      return makeCollection(store, path);
    },
    async runTransaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      const tx = {
        async get(refOrQuery: FakeDocRef | ReturnType<typeof makeCollection>) {
          return (refOrQuery as FakeDocRef | { get: () => unknown }).get();
        },
        set(ref: FakeDocRef, data: DocData) {
          store.set(ref.path, resolveWrite(data));
        },
        update(ref: FakeDocRef, data: DocData) {
          if (!store.has(ref.path)) throw new Error('fake Firestore: update on missing doc ' + ref.path);
          store.set(ref.path, { ...store.get(ref.path)!, ...resolveWrite(data) });
        },
        delete(ref: FakeDocRef) {
          store.delete(ref.path);
        },
      };
      return fn(tx);
    },
    batch() {
      const ops: (() => void)[] = [];
      return {
        update(ref: FakeDocRef, data: DocData) {
          ops.push(() => {
            if (!store.has(ref.path)) throw new Error('fake Firestore: batch update on missing doc ' + ref.path);
            store.set(ref.path, { ...store.get(ref.path)!, ...resolveWrite(data) });
          });
        },
        delete(ref: FakeDocRef) {
          ops.push(() => store.delete(ref.path));
        },
        async commit() {
          for (const op of ops) op();
        },
      };
    },
  };
  return { db: db as unknown as FirebaseFirestore.Firestore, store };
}

async function main() {
  const APP_ID = __test__.APP_ID;
  const hashRefPath = (hash: string) => `artifacts/${APP_ID}/calendarSubscriptionsByHash/${hash}`;
  const subsCollectionPath = (uid: string) => `artifacts/${APP_ID}/users/${uid}/calendarSubscriptions`;
  const tombstonePath = (uid: string) => `artifacts/${APP_ID}/calendarAccountState/${uid}`;

  console.log('\n=== pure helpers ===');
  check('generateCalendarSecret produces a 256-bit (32-byte) base64url value', (() => {
    const secret = __test__.generateCalendarSecret();
    // base64url with no padding: 32 bytes -> 43 chars.
    return typeof secret === 'string' && secret.length === 43 && /^[A-Za-z0-9_-]+$/.test(secret);
  })());
  check('two generated secrets are never equal (astronomically unlikely to collide, sanity-checked)', __test__.generateCalendarSecret() !== __test__.generateCalendarSecret());
  check('hashSecret is deterministic and matches a plain sha256 hex digest', (() => {
    const secret = 'fixed-test-value';
    return __test__.hashSecret(secret) === createHash('sha256').update(secret).digest('hex');
  })());
  check('requireOptionalLabel: undefined -> null', __test__.requireOptionalLabel(undefined) === null);
  check('requireOptionalLabel: empty/whitespace-only -> null', __test__.requireOptionalLabel('   ') === null);
  check('requireOptionalLabel: trims surrounding whitespace', __test__.requireOptionalLabel('  Personal  ') === 'Personal');
  check('requireOptionalLabel: over-length label throws invalid-argument', (() => {
    try {
      __test__.requireOptionalLabel('x'.repeat(__test__.MAX_LABEL_LENGTH + 1));
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireOptionalLabel: non-string throws invalid-argument', (() => {
    try {
      __test__.requireOptionalLabel(42);
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  check('requireSubscriptionId: rejects empty string', (() => {
    try {
      __test__.requireSubscriptionId('');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  })());
  function rejectsSubscriptionId(value: unknown): boolean {
    try {
      __test__.requireSubscriptionId(value);
      return false; // should have thrown
    } catch (err) {
      return (err as { code?: string }).code === 'invalid-argument';
    }
  }
  check('requireSubscriptionId: accepts a genuine 20-char Firestore-auto-ID-shaped value', (() => {
    try {
      return __test__.requireSubscriptionId('aB3xY9kL2mN8pQ7rS1tU') === 'aB3xY9kL2mN8pQ7rS1tU';
    } catch {
      return false;
    }
  })());
  check('requireSubscriptionId: rejects a value containing "/" (path escape attempt)', rejectsSubscriptionId('abc123/../otherUser'));
  check('requireSubscriptionId: rejects a value containing "\\\\" (backslash)', rejectsSubscriptionId('abc123\\otherUser'));
  check('requireSubscriptionId: rejects a value containing a control character (null byte)', rejectsSubscriptionId('abc123\u0000def456'));
  check('requireSubscriptionId: rejects a value containing a newline', rejectsSubscriptionId('abc123\ndef456ghijk'));
  check('requireSubscriptionId: rejects an oversized value (well beyond 20 chars)', rejectsSubscriptionId('x'.repeat(200)));
  check('requireSubscriptionId: rejects a too-short value (19 chars, one short of the real Firestore auto-ID length)', rejectsSubscriptionId('aB3xY9kL2mN8pQ7rS1t'));
  check('requireSubscriptionId: rejects a value with disallowed punctuation even at the right length', rejectsSubscriptionId('aB3xY9kL2mN8pQ7rS1-'));
  check('requireSubscriptionId: rejects non-string input', rejectsSubscriptionId(12345));
  check('requireNonAnonymousAuth: no auth -> unauthenticated', (() => {
    try {
      __test__.requireNonAnonymousAuth({});
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'unauthenticated';
    }
  })());
  check('requireNonAnonymousAuth: anonymous sign-in provider -> permission-denied', (() => {
    try {
      __test__.requireNonAnonymousAuth({ auth: { uid: 'x', token: { firebase: { sign_in_provider: 'anonymous' } } } });
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'permission-denied';
    }
  })());
  check('requireNonAnonymousAuth: real provider -> returns uid', __test__.requireNonAnonymousAuth({ auth: { uid: 'real-uid', token: { firebase: { sign_in_provider: 'google.com' } } } }) === 'real-uid');

  console.log('\n=== CREATE ===');
  await checkAsync('create: succeeds for an authenticated non-anonymous-shaped call, returns a subscriptionId/secret/label', async () => {
    const { db } = makeFakeDb();
    const result = await createCalendarSubscriptionCore(db, 'uid-a', 'Personal');
    return typeof result.subscriptionId === 'string' && typeof result.secret === 'string' && result.secret.length === 43 && result.label === 'Personal';
  });
  await checkAsync('create: raw secret is NOT persisted anywhere in the fake store', async () => {
    const { db, store } = makeFakeDb();
    const result = await createCalendarSubscriptionCore(db, 'uid-a', null);
    for (const data of store.values()) {
      if (JSON.stringify(data).includes(result.secret)) return false;
    }
    return true;
  });
  await checkAsync('create: hash-index entry exists at sha256(secret), maps to correct uid+subscriptionId', async () => {
    const { db, store } = makeFakeDb();
    const result = await createCalendarSubscriptionCore(db, 'uid-a', null);
    const hash = __test__.hashSecret(result.secret);
    const hashDoc = store.get(hashRefPath(hash));
    return !!hashDoc && hashDoc.uid === 'uid-a' && hashDoc.subscriptionId === result.subscriptionId;
  });
  await checkAsync('create: owner-facing doc has createdAt, revokedAt:null, and the correct secretHash (never the raw secret)', async () => {
    const { db, store } = makeFakeDb();
    const result = await createCalendarSubscriptionCore(db, 'uid-a', null);
    const ownerDoc = store.get(`${subsCollectionPath('uid-a')}/${result.subscriptionId}`);
    return (
      !!ownerDoc &&
      ownerDoc.revokedAt === null &&
      ownerDoc.secretHash === __test__.hashSecret(result.secret) &&
      !!ownerDoc.createdAt
    );
  });
  await checkAsync('create: does not modify any existing subscription', async () => {
    const { db, store } = makeFakeDb();
    const first = await createCalendarSubscriptionCore(db, 'uid-a', 'first');
    const before = JSON.stringify(store.get(`${subsCollectionPath('uid-a')}/${first.subscriptionId}`));
    await createCalendarSubscriptionCore(db, 'uid-a', 'second');
    const after = JSON.stringify(store.get(`${subsCollectionPath('uid-a')}/${first.subscriptionId}`));
    return before === after;
  });
  await checkAsync('create: exactly 5 active subscriptions succeed, a 6th is denied with resource-exhausted', async () => {
    const { db } = makeFakeDb();
    for (let i = 0; i < __test__.MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS; i++) {
      await createCalendarSubscriptionCore(db, 'uid-cap', `sub-${i}`);
    }
    try {
      await createCalendarSubscriptionCore(db, 'uid-cap', 'sixth');
      return false;
    } catch (err) {
      return (err as { code?: string }).code === 'resource-exhausted';
    }
  });
  await checkAsync('create: revoked subscriptions do NOT count toward the active cap', async () => {
    const { db } = makeFakeDb();
    const created: string[] = [];
    for (let i = 0; i < __test__.MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS; i++) {
      created.push((await createCalendarSubscriptionCore(db, 'uid-cap2', `sub-${i}`)).subscriptionId);
    }
    await revokeCalendarSubscriptionCore(db, 'uid-cap2', created[0]);
    // One revoked -> room for exactly one more active subscription.
    const result = await createCalendarSubscriptionCore(db, 'uid-cap2', 'replacement');
    return typeof result.subscriptionId === 'string';
  });
  await checkAsync('create: a second user\'s subscriptions are entirely independent of the first\'s cap', async () => {
    const { db } = makeFakeDb();
    for (let i = 0; i < __test__.MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS; i++) {
      await createCalendarSubscriptionCore(db, 'uid-full', `sub-${i}`);
    }
    // A DIFFERENT uid, entirely unaffected by uid-full's cap.
    const result = await createCalendarSubscriptionCore(db, 'uid-other', 'first-for-other-user');
    return typeof result.subscriptionId === 'string';
  });
  // Codex repair pass 2, PRIMARY HIGH FINDING: proves createCalendarSubscriptionCore's own
  // half of the create-versus-deletion race repair — the tombstone read happens INSIDE its
  // transaction, before any write, so a tombstone that already exists (regardless of how it
  // got there) must fail the whole create attempt closed, leaving no owner doc and no hash
  // entry behind. The tombstone is seeded directly here (bypassing
  // handleCalendarUserDeletedCore) specifically to isolate this half of the invariant from
  // the deletion-side tests in the ACCOUNT DELETION section below.
  await checkAsync('create: fails closed (permission-denied) with no owner doc and no hash entry when a deletion tombstone exists for the uid', async () => {
    const { db, store } = makeFakeDb();
    store.set(tombstonePath('uid-tombstoned'), { deleted: true, deletedAt: { __fakeTimestamp: true, atMs: Date.now() } });
    const sizeBeforeAttempt = store.size;
    let threw = false;
    let code: string | undefined;
    try {
      await createCalendarSubscriptionCore(db, 'uid-tombstoned', 'attempted');
      return false;
    } catch (err) {
      threw = true;
      code = (err as { code?: string }).code;
    }
    // The store must contain EXACTLY what it did before the attempt (the tombstone alone) —
    // no owner doc, no hash entry, nothing written by the failed transaction.
    return threw && code === 'permission-denied' && store.size === sizeBeforeAttempt;
  });

  console.log('\n=== REVOKE ONE ===');
  await checkAsync('revoke: owner can revoke their own subscription; owner doc revokedAt becomes non-null', async () => {
    const { db, store } = makeFakeDb();
    const created = await createCalendarSubscriptionCore(db, 'uid-b', null);
    await revokeCalendarSubscriptionCore(db, 'uid-b', created.subscriptionId);
    const ownerDoc = store.get(`${subsCollectionPath('uid-b')}/${created.subscriptionId}`);
    return !!ownerDoc && ownerDoc.revokedAt !== null;
  });
  await checkAsync('revoke: hash-index entry is removed (credential becomes unusable)', async () => {
    const { db, store } = makeFakeDb();
    const created = await createCalendarSubscriptionCore(db, 'uid-b', null);
    const hash = __test__.hashSecret(created.secret);
    await revokeCalendarSubscriptionCore(db, 'uid-b', created.subscriptionId);
    return !store.has(hashRefPath(hash));
  });
  await checkAsync('revoke: wrong user cannot revoke another user\'s subscription (path is uid-scoped — this call is simply a no-op against a path that does not exist under the wrong uid)', async () => {
    const { db, store } = makeFakeDb();
    const created = await createCalendarSubscriptionCore(db, 'uid-owner', null);
    await revokeCalendarSubscriptionCore(db, 'uid-attacker', created.subscriptionId);
    const ownerDoc = store.get(`${subsCollectionPath('uid-owner')}/${created.subscriptionId}`);
    // The real owner's subscription must remain untouched — revokedAt still null.
    return !!ownerDoc && ownerDoc.revokedAt === null;
  });
  await checkAsync('revoke: unknown subscriptionId fails safely (no throw, no-op)', async () => {
    const { db } = makeFakeDb();
    // Must be shaped like a real Firestore auto-ID (20 chars, [A-Za-z0-9]) so this test
    // exercises "well-formed but nonexistent -> safe no-op", not the separate
    // "malformed -> invalid-argument" path already covered by the subscriptionId
    // validation tests above.
    const result = await revokeCalendarSubscriptionCore(db, 'uid-c', 'nonexistent000000001');
    return result.revoked === true;
  });
  await checkAsync('revoke: retried/repeated revoke on an already-revoked subscription is idempotent (no throw, unrelated state unaffected)', async () => {
    const { db, store } = makeFakeDb();
    const created = await createCalendarSubscriptionCore(db, 'uid-d', null);
    await revokeCalendarSubscriptionCore(db, 'uid-d', created.subscriptionId);
    const afterFirst = JSON.stringify(store.get(`${subsCollectionPath('uid-d')}/${created.subscriptionId}`));
    await revokeCalendarSubscriptionCore(db, 'uid-d', created.subscriptionId); // second call
    const afterSecond = JSON.stringify(store.get(`${subsCollectionPath('uid-d')}/${created.subscriptionId}`));
    return afterFirst === afterSecond;
  });
  await checkAsync('revoke: an unrelated subscription for the same user is untouched', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-e', 'A');
    const b = await createCalendarSubscriptionCore(db, 'uid-e', 'B');
    await revokeCalendarSubscriptionCore(db, 'uid-e', a.subscriptionId);
    const bDoc = store.get(`${subsCollectionPath('uid-e')}/${b.subscriptionId}`);
    return !!bDoc && bDoc.revokedAt === null;
  });

  console.log('\n=== REVOKE ALL ===');
  await checkAsync('revokeAll: revokes every active subscription for the authenticated user only', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-f', 'A');
    const b = await createCalendarSubscriptionCore(db, 'uid-f', 'B');
    const result = await revokeAllCalendarSubscriptionsCore(db, 'uid-f');
    const aDoc = store.get(`${subsCollectionPath('uid-f')}/${a.subscriptionId}`);
    const bDoc = store.get(`${subsCollectionPath('uid-f')}/${b.subscriptionId}`);
    return result.revokedCount === 2 && aDoc?.revokedAt !== null && bDoc?.revokedAt !== null;
  });
  await checkAsync('revokeAll: all corresponding hash-index entries are removed', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-g', 'A');
    const b = await createCalendarSubscriptionCore(db, 'uid-g', 'B');
    await revokeAllCalendarSubscriptionsCore(db, 'uid-g');
    return !store.has(hashRefPath(__test__.hashSecret(a.secret))) && !store.has(hashRefPath(__test__.hashSecret(b.secret)));
  });
  await checkAsync('revokeAll: a different user\'s subscriptions are entirely untouched', async () => {
    const { db, store } = makeFakeDb();
    const other = await createCalendarSubscriptionCore(db, 'uid-other-2', 'untouched');
    await createCalendarSubscriptionCore(db, 'uid-h', 'A');
    await revokeAllCalendarSubscriptionsCore(db, 'uid-h');
    const otherDoc = store.get(`${subsCollectionPath('uid-other-2')}/${other.subscriptionId}`);
    return !!otherDoc && otherDoc.revokedAt === null;
  });
  await checkAsync('revokeAll: repeated invocation is safe/idempotent (second call revokes zero)', async () => {
    const { db } = makeFakeDb();
    await createCalendarSubscriptionCore(db, 'uid-i', 'A');
    await revokeAllCalendarSubscriptionsCore(db, 'uid-i');
    const second = await revokeAllCalendarSubscriptionsCore(db, 'uid-i');
    return second.revokedCount === 0;
  });
  await checkAsync('revokeAll: is bounded by the max-cap invariant (never processes more than MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS in one call)', async () => {
    const { db } = makeFakeDb();
    for (let i = 0; i < __test__.MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS; i++) {
      await createCalendarSubscriptionCore(db, 'uid-j', `sub-${i}`);
    }
    const result = await revokeAllCalendarSubscriptionsCore(db, 'uid-j');
    return result.revokedCount === __test__.MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS;
  });

  console.log('\n=== ACCOUNT DELETION ===');
  await checkAsync('accountDeletion: all calendar hashes for the deleted uid are invalidated, and a tombstone is written', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-del', 'A');
    const b = await createCalendarSubscriptionCore(db, 'uid-del', 'B');
    await handleCalendarUserDeletedCore(db, 'uid-del');
    return (
      !store.has(hashRefPath(__test__.hashSecret(a.secret))) &&
      !store.has(hashRefPath(__test__.hashSecret(b.secret))) &&
      store.has(tombstonePath('uid-del'))
    );
  });
  await checkAsync('accountDeletion: owner-facing docs for the deleted uid are marked revoked', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-del2', 'A');
    await handleCalendarUserDeletedCore(db, 'uid-del2');
    const doc = store.get(`${subsCollectionPath('uid-del2')}/${a.subscriptionId}`);
    return !!doc && doc.revokedAt !== null;
  });
  await checkAsync('accountDeletion (item 9): a different (non-deleted) user\'s hashes AND tombstone are untouched', async () => {
    const { db, store } = makeFakeDb();
    const survivor = await createCalendarSubscriptionCore(db, 'uid-survivor', 'still here');
    const deleted = await createCalendarSubscriptionCore(db, 'uid-deleted-2', 'gone');
    await handleCalendarUserDeletedCore(db, 'uid-deleted-2');
    return (
      store.has(hashRefPath(__test__.hashSecret(survivor.secret))) &&
      !store.has(hashRefPath(__test__.hashSecret(deleted.secret))) &&
      !store.has(tombstonePath('uid-survivor')) &&
      store.has(tombstonePath('uid-deleted-2'))
    );
  });
  await checkAsync('accountDeletion (item 9, repeated deletion): repeat/retry invocation is safe, idempotent, and does not shift the original tombstone\'s deletedAt', async () => {
    const { db, store } = makeFakeDb();
    await createCalendarSubscriptionCore(db, 'uid-del3', 'A');
    await handleCalendarUserDeletedCore(db, 'uid-del3');
    const firstTombstone = JSON.stringify(store.get(tombstonePath('uid-del3')));
    await handleCalendarUserDeletedCore(db, 'uid-del3'); // must not throw
    const secondTombstone = JSON.stringify(store.get(tombstonePath('uid-del3')));
    // The `!tombstoneSnap.exists` guard in handleCalendarUserDeletedCore's critical
    // transaction means a retry must find the tombstone already present and skip rewriting
    // it — proving that directly (not just "didn't throw") by comparing the doc byte-for-byte
    // across both calls.
    return firstTombstone === secondTombstone && store.has(tombstonePath('uid-del3'));
  });
  await checkAsync('accountDeletion: partially-already-revoked state (mix of revoked and active) is handled safely', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-del4', 'A');
    const b = await createCalendarSubscriptionCore(db, 'uid-del4', 'B');
    await revokeCalendarSubscriptionCore(db, 'uid-del4', a.subscriptionId); // pre-revoke one
    await handleCalendarUserDeletedCore(db, 'uid-del4'); // must handle the mix without throwing
    const bDoc = store.get(`${subsCollectionPath('uid-del4')}/${b.subscriptionId}`);
    return !store.has(hashRefPath(__test__.hashSecret(b.secret))) && bDoc?.revokedAt !== null && store.has(tombstonePath('uid-del4'));
  });
  await checkAsync('accountDeletion (item 9, zero hashes): deleted user with zero subscriptions still gets a permanent tombstone', async () => {
    const { db, store } = makeFakeDb();
    await handleCalendarUserDeletedCore(db, 'uid-never-subscribed'); // must not throw
    return store.has(tombstonePath('uid-never-subscribed'));
  });
  // Codex repair pass item 9 (round 1): the fix for the HIGH finding made hash-index
  // cleanup query calendarSubscriptionsByHash directly by uid, independent of owner-facing
  // metadata (see handleCalendarUserDeletedCore's STEP 1/STEP 2 split). The tests below
  // exist specifically to prove that independence — each seeds a hash-index entry through a
  // path that a naive "read the owner doc, then delete what it points to" implementation
  // would fail on, and confirms the hash is still invalidated AND the tombstone is written.
  await checkAsync('accountDeletion (item 9): an ORPHAN hash-index entry (no owner-facing doc at all) is still deleted, and a tombstone is written', async () => {
    const { db, store } = makeFakeDb();
    const secret = __test__.generateCalendarSecret();
    const hash = __test__.hashSecret(secret);
    // Deliberately write only the hash-index doc, bypassing createCalendarSubscriptionCore
    // entirely, so no owner-facing subscription doc exists anywhere in the store.
    store.set(hashRefPath(hash), { uid: 'uid-orphan', subscriptionId: 'orphanSubscriptionId0' });
    await handleCalendarUserDeletedCore(db, 'uid-orphan'); // must not throw despite missing owner doc
    return !store.has(hashRefPath(hash)) && store.has(tombstonePath('uid-orphan'));
  });
  await checkAsync('accountDeletion (item 9): a MALFORMED owner-facing doc (missing/wrong fields) does not prevent hash-index invalidation or the tombstone', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-malformed', 'A');
    // Corrupt the owner-facing doc in place after creation, simulating data corruption or a
    // partially-written document, without touching the hash-index entry.
    store.set(`${subsCollectionPath('uid-malformed')}/${a.subscriptionId}`, { unexpectedField: 123 } as unknown as DocData);
    await handleCalendarUserDeletedCore(db, 'uid-malformed'); // must not throw despite malformed owner doc
    return !store.has(hashRefPath(__test__.hashSecret(a.secret))) && store.has(tombstonePath('uid-malformed'));
  });
  await checkAsync('accountDeletion (item 9, five hashes): at the maximum normal active set (5 subscriptions, the enforced cap) every hash is invalidated and a tombstone is written', async () => {
    const { db, store } = makeFakeDb();
    const created = [];
    for (let i = 0; i < __test__.MAX_ACTIVE_CALENDAR_SUBSCRIPTIONS; i++) {
      created.push(await createCalendarSubscriptionCore(db, 'uid-maxcap', `label-${i}`));
    }
    await handleCalendarUserDeletedCore(db, 'uid-maxcap');
    return created.every((c) => !store.has(hashRefPath(__test__.hashSecret(c.secret)))) && store.has(tombstonePath('uid-maxcap'));
  });
  // Codex repair pass 2, PRIMARY HIGH FINDING (create-versus-account-deletion race) — items
  // 1/2/3 of the DELETION CLEANUP TESTS list. Per the FAKE FIRESTORE LIMITATION this repair
  // pass explicitly calls out: this fake models neither genuine Firestore locking,
  // transaction retry, nor true concurrency, so these tests exercise the two logical
  // serializations SEQUENTIALLY (one full operation completing before the next begins),
  // not a real interleaving of two in-flight transactions. They prove the two operations'
  // OUTCOMES compose correctly in either order; they do NOT by themselves prove production
  // Firestore's transaction-conflict/retry machinery serializes a genuine race the same way
  // — that is exactly what the real-emulator deployment gate below still exists to check.
  await checkAsync('serialization A (create commits BEFORE deletion): deletion subsequently removes the created hash and writes the tombstone', async () => {
    const { db, store } = makeFakeDb();
    const created = await createCalendarSubscriptionCore(db, 'uid-serA', 'A');
    const hashExistedBeforeDeletion = store.has(hashRefPath(__test__.hashSecret(created.secret)));
    const noTombstoneBeforeDeletion = !store.has(tombstonePath('uid-serA'));
    await handleCalendarUserDeletedCore(db, 'uid-serA');
    const tombstoneAfter = store.has(tombstonePath('uid-serA'));
    const hashAfter = store.has(hashRefPath(__test__.hashSecret(created.secret)));
    // FINAL STATE required by the repair: tombstone present, hash absent.
    return hashExistedBeforeDeletion && noTombstoneBeforeDeletion && tombstoneAfter && !hashAfter;
  });
  await checkAsync('serialization B (deletion commits BEFORE create): the subsequent create attempt refuses, creating neither an owner doc nor a hash entry', async () => {
    const { db, store } = makeFakeDb();
    await handleCalendarUserDeletedCore(db, 'uid-serB'); // deletion first; zero prior subscriptions.
    const sizeAfterDeletion = store.size; // tombstone doc only.
    let threw = false;
    let code: string | undefined;
    try {
      await createCalendarSubscriptionCore(db, 'uid-serB', 'attempted-after-deletion');
    } catch (err) {
      threw = true;
      code = (err as { code?: string }).code;
    }
    // FINAL STATE required by the repair: tombstone present, hash absent — and here,
    // additionally, no owner doc either, since create must not write ANYTHING.
    return threw && code === 'permission-denied' && store.size === sizeAfterDeletion && store.has(tombstonePath('uid-serB'));
  });
  // Item 10: prove a STEP 2 (best-effort owner-bookkeeping) failure cannot undo or
  // invalidate STEP 1's critical result. db.batch() is used ONLY by STEP 2 in the real
  // implementation (STEP 1 uses db.runTransaction) — overriding it here for one call
  // surgically isolates exactly the failure mode this test needs to inject, without
  // touching the critical transaction path at all.
  await checkAsync('accountDeletion (item 10): a STEP 2 owner-bookkeeping failure after a successful critical transaction does not undo the tombstone or revive the deleted hash', async () => {
    const { db, store } = makeFakeDb();
    const a = await createCalendarSubscriptionCore(db, 'uid-step2fail', 'A');
    const mutableDb = db as unknown as { batch: () => { update: (ref: unknown, data: unknown) => void; delete: (ref: unknown) => void; commit: () => Promise<void> } };
    mutableDb.batch = () => ({
      update: () => {},
      delete: () => {},
      commit: async () => {
        throw new Error('SIMULATED STEP 2 FAILURE (owner bookkeeping only, injected for this test)');
      },
    });
    await handleCalendarUserDeletedCore(db, 'uid-step2fail'); // must not throw despite STEP 2 failing internally
    return store.has(tombstonePath('uid-step2fail')) && !store.has(hashRefPath(__test__.hashSecret(a.secret)));
  });

  console.log('\n=== STATIC SECURITY AUDIT (source-text checks) ===');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const srcPath = path.join(__dirname, '..', 'src', 'calendarSubscriptions.ts');
  const src = fs.readFileSync(srcPath, 'utf8');
  // Normalize CRLF/CR to LF FIRST, before any of the structural checks below that search
  // for exact line-boundary sequences like '\n}\n'. Without this, a CRLF checkout (e.g. a
  // fresh Windows worktree without this repo's line-ending normalization applied) leaves a
  // trailing '\r' attached to every retained line — split('\n') keeps it, and the later
  // .filter(...).join('\n') never strips it, so the literal 3-byte sequence '\n}\n' no
  // longer occurs anywhere in `stripped`. That silently makes the function-body-boundary
  // search below return -1 and fall through to end-of-file, scanning unrelated later
  // functions too. Normalizing here makes every source-text check below independent of the
  // file's on-disk line-ending style.
  const stripped = src
    .replace(/\r\n?/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  check('no console.log/logger call anywhere references the raw secret variable by name', !/console\.(log|warn|error)\([^)]*\bsecret\b/i.test(stripped));
  check('the raw secret is returned only from createCalendarSubscriptionCore\'s own return statement (single occurrence of ", secret," as an object literal value)', (stripped.match(/\bsecret,/g) || []).length <= 2); // definition + return
  check('no uid is ever read from request.data (client-supplied uid never used as ownership authority)', !/request\.data[^;]*uid/i.test(stripped));
  // Codex repair pass, item 6: the PREVIOUS version of this check was a bare `true`
  // literal — an assertion that could never fail regardless of what the implementation
  // actually did. Replaced with two REAL checks, either of which can genuinely fail: (a) a
  // behavioral check that seeds several unrelated pre-existing documents — another
  // subscription for the SAME uid, a hash-index entry, and a subscription for a totally
  // DIFFERENT uid — and asserts their exact byte-for-byte content is unchanged after a new
  // create call; (b) a source-level check that the only two `transaction.set(`/
  // `transaction.update(` targets inside createCalendarSubscriptionCore's own function body
  // are the two local variables this function is supposed to write, `subscriptionRef` and
  // `hashRef` — a stray write to any other ref would be caught here.
  check('createCalendarSubscriptionCore never modifies any OTHER existing document (behavioral, deep-equality check)', await (async () => {
    const { db, store } = makeFakeDb();
    const otherOwn = await createCalendarSubscriptionCore(db, 'uid-audit', 'pre-existing, same uid');
    const otherUser = await createCalendarSubscriptionCore(db, 'uid-audit-other', 'pre-existing, different uid');
    const snapshotBefore = new Map(store);
    await createCalendarSubscriptionCore(db, 'uid-audit', 'newly created');
    let allUnchanged = true;
    for (const [path, dataBefore] of snapshotBefore.entries()) {
      if (JSON.stringify(store.get(path)) !== JSON.stringify(dataBefore)) allUnchanged = false;
    }
    // Sanity: the audit above is only meaningful if there really WERE pre-existing docs to
    // compare against — guard against a vacuous pass if seeding itself silently failed.
    const seededSomething = typeof otherOwn.subscriptionId === 'string' && typeof otherUser.subscriptionId === 'string' && snapshotBefore.size >= 4;
    return allUnchanged && seededSomething;
  })());
  check('createCalendarSubscriptionCore (source): the only transaction.set(/transaction.update( targets in its own function body are subscriptionRef/hashRef', (() => {
    const fnStart = stripped.indexOf('export async function createCalendarSubscriptionCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    const writeTargets = [...fnBody.matchAll(/transaction\.(?:set|update)\(([a-zA-Z0-9_]+),/g)].map((m) => m[1]);
    return writeTargets.length >= 2 && writeTargets.every((t) => t === 'subscriptionRef' || t === 'hashRef');
  })());
  check('CALLABLE_OPTIONS enforces App Check for all three callables', (stripped.match(/onCall\(CALLABLE_OPTIONS,/g) || []).length === 3);
  check('CALLABLE_OPTIONS itself sets enforceAppCheck: true', /const CALLABLE_OPTIONS = \{ enforceAppCheck: true \}/.test(stripped));
  check('this file contains no import from any first-real-send-experiment/reminder/notification-delivery module', !/reminderDelivery|notificationRollout|first-real-send/i.test(stripped));
  // Codex repair pass item 9 (retry/failure-policy confirmation): this is a source-text
  // check, not a behavioral one — the fake Firestore harness in this file has no way to
  // simulate a real Auth-deletion-trigger invocation or its retry behavior, so this is as
  // far as "where testable" can go without a real emulator (see the deployment-gate note in
  // the final report). Confirms onCalendarUserDeleted is still wired through
  // functionsV1.runWith({ failurePolicy: true }) exactly as verified against the installed
  // firebase-functions v1 typings.
  check('onCalendarUserDeleted is configured with automatic retry (functionsV1.runWith({ failurePolicy: true }))', /functionsV1\.runWith\(\{\s*failurePolicy:\s*true\s*\}\)\.auth\.user\(\)\.onDelete\(/.test(stripped));

  // Codex repair pass 2 static checks (tombstone architecture).
  check('firestore.rules denies ALL client read/write access to calendarAccountState (the tombstone collection)', (() => {
    const rulesPath = path.join(__dirname, '..', '..', 'firestore.rules');
    const rules = fs.readFileSync(rulesPath, 'utf8');
    const m = rules.match(/match \/artifacts\/\{appId\}\/calendarAccountState\/\{uid\} \{([^}]*)\}/);
    return !!m && /allow read, write: if false;/.test(m[1]);
  })());
  check('createCalendarSubscriptionCore reads the tombstone (transaction.get(tombstoneRef)) strictly BEFORE any transaction.set(/transaction.update( in its own transaction body', (() => {
    const fnStart = stripped.indexOf('export async function createCalendarSubscriptionCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    const tombstoneReadIndex = fnBody.indexOf('transaction.get(tombstoneRef)');
    const firstWriteIndex = fnBody.search(/transaction\.(?:set|update)\(/);
    return tombstoneReadIndex !== -1 && firstWriteIndex !== -1 && tombstoneReadIndex < firstWriteIndex;
  })());
  check('handleCalendarUserDeletedCore\'s critical transaction reads the tombstone and hash-index query strictly BEFORE writing the tombstone or deleting any hash entry', (() => {
    const fnStart = stripped.indexOf('export async function handleCalendarUserDeletedCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    const txStart = fnBody.indexOf('await db.runTransaction(async (transaction) => {');
    const txEnd = fnBody.indexOf('\n  });', txStart);
    const txBody = fnBody.slice(txStart, txEnd);
    const lastReadIndex = Math.max(txBody.lastIndexOf('transaction.get('), 0);
    const firstWriteIndex = txBody.search(/transaction\.(?:set|delete)\(/);
    return txStart !== -1 && txEnd !== -1 && firstWriteIndex !== -1 && lastReadIndex < firstWriteIndex;
  })());
  check('handleCalendarUserDeletedCore\'s critical transaction both writes the tombstone AND deletes matching hash entries, in that ONE transaction block', (() => {
    const fnStart = stripped.indexOf('export async function handleCalendarUserDeletedCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    const txStart = fnBody.indexOf('await db.runTransaction(async (transaction) => {');
    const txEnd = fnBody.indexOf('\n  });', txStart);
    const txBody = fnBody.slice(txStart, txEnd);
    return txBody.includes('transaction.set(tombstoneRef') && txBody.includes('transaction.delete(doc.ref)');
  })());
  check('handleCalendarUserDeletedCore only ever calls db.batch( AFTER the critical transaction (STEP 2, never inside STEP 1)', (() => {
    const fnStart = stripped.indexOf('export async function handleCalendarUserDeletedCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    const txStart = fnBody.indexOf('await db.runTransaction(async (transaction) => {');
    const txEnd = fnBody.indexOf('\n  });', txStart);
    const txBody = fnBody.slice(txStart, txEnd);
    const batchIndex = fnBody.indexOf('db.batch(');
    return !txBody.includes('db.batch(') && batchIndex > txEnd;
  })());
  check('handleCalendarUserDeletedCore\'s STEP 2 catch block never rethrows (a bookkeeping failure can never surface as, or undo, the critical transaction\'s outcome)', (() => {
    const fnStart = stripped.indexOf('export async function handleCalendarUserDeletedCore(');
    const fnEnd = stripped.indexOf('\n}\n', fnStart);
    const fnBody = stripped.slice(fnStart, fnEnd);
    const catchStart = fnBody.indexOf('} catch {');
    return catchStart !== -1 && !fnBody.slice(catchStart).includes('throw');
  })());
  check('db.batch( is called from exactly one place in this file (handleCalendarUserDeletedCore\'s STEP 2)', (stripped.match(/db\.batch\(/g) || []).length === 1);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL ERROR:', err);
  process.exitCode = 1;
});
