// tests/useScreenWakeLock.test.ts
// Run: node --test tests/useScreenWakeLock.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createScreenWakeLock, type WakeLockDocument } from '../src/hooks/useScreenWakeLock.ts';

class FakeSentinel extends EventTarget {
  released = false;
  releaseCalls = 0;
  release(): Promise<void> {
    this.releaseCalls++;
    if (!this.released) {
      this.released = true;
      this.dispatchEvent(new Event('release'));
    }
    return Promise.resolve();
  }
}

type Pending = { resolve: (s: FakeSentinel) => void; reject: (e: Error) => void };

function setup() {
  const pending: Pending[] = [];
  const sentinels: FakeSentinel[] = [];
  const wakeLock = {
    request: () =>
      new Promise<FakeSentinel>((resolve, reject) => pending.push({ resolve, reject })),
  } as unknown as WakeLock;

  const target = new EventTarget();
  const doc = {
    visibilityState: 'visible' as DocumentVisibilityState,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const setVisibility = (state: DocumentVisibilityState) => {
    doc.visibilityState = state;
    target.dispatchEvent(new Event('visibilitychange'));
  };
  // Resolves the oldest pending request with a fresh sentinel.
  const grant = async () => {
    const s = new FakeSentinel();
    sentinels.push(s);
    pending.shift()!.resolve(s);
    await flush();
    return s;
  };
  const controller = createScreenWakeLock(wakeLock, doc as unknown as WakeLockDocument);
  return { controller, pending, sentinels, setVisibility, grant };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

test('unsupported browser: no throw', () => {
  const doc = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  const c = createScreenWakeLock(undefined, doc as unknown as WakeLockDocument);
  c.setActive(true);
  c.setActive(false);
  c.dispose();
});

test('page open but not playing: no request', () => {
  const { pending } = setup();
  assert.equal(pending.length, 0);
});

test('play acquires once; duplicate play does not re-request', async () => {
  const { controller, pending, grant } = setup();
  controller.setActive(true);
  controller.setActive(true);
  assert.equal(pending.length, 1);
  const s = await grant();
  controller.setActive(true);
  assert.equal(pending.length, 0);
  assert.equal(s.released, false);
});

test('pause / ended releases', async () => {
  const { controller, grant } = setup();
  controller.setActive(true);
  const s = await grant();
  controller.setActive(false);
  assert.equal(s.released, true);
});

test('hidden releases; visible re-acquires only while still playing', async () => {
  const { controller, pending, grant, setVisibility } = setup();
  controller.setActive(true);
  const s = await grant();
  setVisibility('hidden');
  assert.equal(s.released, true);
  assert.equal(pending.length, 0, 'no request while hidden');
  setVisibility('visible');
  assert.equal(pending.length, 1, 're-requested on return');
  const s2 = await grant();
  assert.equal(s2.released, false);

  controller.setActive(false);
  setVisibility('hidden');
  setVisibility('visible');
  assert.equal(pending.length, 0, 'paused: not re-acquired on return');
});

test('play is ignored while hidden', () => {
  const { controller, pending, setVisibility } = setup();
  setVisibility('hidden');
  controller.setActive(true);
  assert.equal(pending.length, 0);
});

test('rapid play/pause: late-resolving lock is released, not kept', async () => {
  const { controller, pending, grant } = setup();
  controller.setActive(true);
  controller.setActive(false);
  controller.setActive(true);
  controller.setActive(false);
  assert.equal(pending.length, 1, 'single in-flight request');
  const s = await grant();
  assert.equal(s.released, true);
});

test('hidden while request in flight: lock released on resolve', async () => {
  const { controller, grant, setVisibility } = setup();
  controller.setActive(true);
  setVisibility('hidden');
  const s = await grant();
  assert.equal(s.released, true);
});

test('NotAllowedError is swallowed; next play retries', async () => {
  const { controller, pending } = setup();
  controller.setActive(true);
  pending.shift()!.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
  await flush();
  controller.setActive(false);
  controller.setActive(true);
  assert.equal(pending.length, 1);
});

test('system-initiated release is forgotten; return to visible re-acquires', async () => {
  const { controller, pending, grant, setVisibility } = setup();
  controller.setActive(true);
  const s = await grant();
  await s.release(); // e.g. battery saver
  setVisibility('hidden');
  setVisibility('visible');
  assert.equal(pending.length, 1);
});

test('dispose (unmount / navigate away) releases and stops listening', async () => {
  const { controller, pending, grant, setVisibility } = setup();
  controller.setActive(true);
  const s = await grant();
  controller.dispose();
  assert.equal(s.released, true);
  setVisibility('hidden');
  setVisibility('visible');
  assert.equal(pending.length, 0);
});
