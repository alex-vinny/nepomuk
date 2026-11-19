'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildQueuePayload, isBuildDone, buildSucceeded, waitForBuild } = require('../lib/build');

test('buildQueuePayload: definition id + short branch → full ref, manual reason', () => {
  assert.deepStrictEqual(buildQueuePayload({ definitionId: 431, branch: 'releases/rc/2026_1' }), {
    definition: { id: 431 },
    sourceBranch: 'refs/heads/releases/rc/2026_1',
    reason: 'manual',
  });
});

test('buildQueuePayload: full ref passes through; numeric string id is accepted', () => {
  const p = buildQueuePayload({ definitionId: '12', branch: 'refs/heads/main' });
  assert.strictEqual(p.sourceBranch, 'refs/heads/main');
  assert.strictEqual(p.definition.id, 12);
});

test('buildQueuePayload: refuses without definition or branch', () => {
  assert.throws(() => buildQueuePayload({ branch: 'main' }), /definition/);
  assert.throws(() => buildQueuePayload({ definitionId: 1 }), /branch/);
  assert.throws(() => buildQueuePayload({ definitionId: 1, branch: true }), /branch/);
});

test('isBuildDone / buildSucceeded: only completed+succeeded is success', () => {
  assert.strictEqual(isBuildDone({ status: 'inProgress' }), false);
  assert.strictEqual(isBuildDone({ status: 'completed', result: 'failed' }), true);
  assert.strictEqual(buildSucceeded({ status: 'completed', result: 'succeeded' }), true);
  assert.strictEqual(buildSucceeded({ status: 'completed', result: 'partiallySucceeded' }), false);
  assert.strictEqual(buildSucceeded({ status: 'completed', result: 'canceled' }), false);
});

test('waitForBuild: polls until completed, reporting each tick', async () => {
  const states = [
    { status: 'notStarted' }, { status: 'inProgress' }, { status: 'completed', result: 'succeeded' },
  ];
  let calls = 0; const ticks = []; let slept = 0;
  const r = await waitForBuild(7, {
    get: async (id) => { assert.strictEqual(id, 7); return states[calls++]; },
    sleep: async () => { slept++; },
    onTick: (b) => ticks.push(b.status),
  });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(r.build.result, 'succeeded');
  assert.deepStrictEqual(ticks, ['notStarted', 'inProgress']);
  assert.strictEqual(slept, 2);
});

test('waitForBuild: stops at the deadline with timedOut and the last state', async () => {
  let t = 0;
  const r = await waitForBuild(1, {
    get: async () => ({ status: 'inProgress' }),
    sleep: async (ms) => { t += ms; },
    now: () => t,
    intervalMs: 1000, timeoutMs: 3000,
  });
  assert.strictEqual(r.timedOut, true);
  assert.strictEqual(r.build.status, 'inProgress');
});

test('waitForBuild: already completed returns without sleeping', async () => {
  let slept = 0;
  const r = await waitForBuild(1, { get: async () => ({ status: 'completed', result: 'failed' }), sleep: async () => { slept++; } });
  assert.strictEqual(r.timedOut, false);
  assert.strictEqual(slept, 0);
});
