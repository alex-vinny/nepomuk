'use strict';

// Unit tests for the Task helpers behind `wi create-task` / `wi create-tasks`.
// No network, no PAT. Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { taskFields, parsePlan, totalHours } = require('../lib/tasks');

const parent = {
  'System.AreaPath': 'Board\\Digital',
  'System.IterationPath': 'Board\\Sprint 112026',
  'System.AssignedTo': { uniqueName: 'dono@example.com' },
};

test('taskFields: area and iteration come from the parent, estimate fills both hour fields', () => {
  const f = taskFields({ title: ' T1 ', hours: 6 }, parent);
  assert.strictEqual(f['System.Title'], 'T1');
  assert.strictEqual(f['System.AreaPath'], 'Board\\Digital');
  assert.strictEqual(f['System.IterationPath'], 'Board\\Sprint 112026');
  assert.strictEqual(f['Microsoft.VSTS.Scheduling.OriginalEstimate'], 6);
  assert.strictEqual(f['Microsoft.VSTS.Scheduling.RemainingWork'], 6);
  assert.strictEqual(f['Microsoft.VSTS.Common.Activity'], 'Development');
});

test('taskFields: the task assignee wins, then the parent', () => {
  assert.strictEqual(taskFields({ title: 'a', assignee: 'x@example.com' }, parent)['System.AssignedTo'], 'x@example.com');
  assert.strictEqual(taskFields({ title: 'a' }, parent)['System.AssignedTo'], 'dono@example.com');
  assert.strictEqual(taskFields({ title: 'a' }, {})['System.AssignedTo'], undefined);
});

test('taskFields: 0 hours is an estimate, not a missing one; negative is refused', () => {
  assert.strictEqual(taskFields({ title: 'a', hours: 0 }, {})['Microsoft.VSTS.Scheduling.OriginalEstimate'], 0);
  assert.strictEqual('Microsoft.VSTS.Scheduling.OriginalEstimate' in taskFields({ title: 'a' }, {}), false);
  assert.throws(() => taskFields({ title: 'a', hours: -1 }, {}), /invalid hours/);
});

test('parsePlan: a list, or an object keyed by parent id, with English or Portuguese keys', () => {
  assert.deepStrictEqual(parsePlan([{ title: 'a', hours: 2 }], 1).map(t => [t.title, t.hours]), [['a', 2]]);
  const plan = { 69426: [{ titulo: 'T1', horas: 6, desc: 'd' }], 69427: [{ titulo: 'X' }] };
  const tasks = parsePlan(plan, 69426);
  assert.deepStrictEqual(tasks.map(t => [t.title, t.hours, t.desc]), [['T1', 6, 'd']]);
  assert.strictEqual(parsePlan(plan, '69427')[0].hours, null);
});

test('parsePlan: every task is checked before anything is created', () => {
  assert.throws(() => parsePlan([{ title: 'ok', hours: 1 }, { hours: 2 }, { title: 'b', hours: 'x' }], 1),
    e => /task 2: missing title/.test(e.message) && /task 3: invalid hours/.test(e.message) && /nothing created/.test(e.message));
});

test('parsePlan: a plan without this parent, or empty, is refused', () => {
  assert.throws(() => parsePlan({ 1: [{ title: 'a' }] }, 2), /no tasks for parent #2/);
  assert.throws(() => parsePlan([], 1), /empty/);
});

test('totalHours: sums only the estimates that were given', () => {
  assert.strictEqual(totalHours([{ hours: 6 }, { hours: null }, { hours: 2.5 }]), 8.5);
});
