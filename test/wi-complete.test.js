'use strict';

// Unit tests for the PATCH that `wi complete` sends. No network, no PAT.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { completeOps, rejectsMissingAssignee, onlyRemainingWorkMustBeEmpty } = require('../lib/tasks');

const paths = (ops) => ops.map((o) => o.path.replace('/fields/', ''));

test('completeOps: hours only — the state is not part of the PATCH', () => {
  const ops = completeOps({ hours: 6 });
  assert.deepStrictEqual(paths(ops), ['Microsoft.VSTS.Scheduling.CompletedWork', 'Microsoft.VSTS.Scheduling.RemainingWork']);
  assert.strictEqual(ops[0].value, 6);
  assert.strictEqual(ops[1].value, 0);
});

test('completeOps: --state and --assignee go in the same PATCH, state last', () => {
  const ops = completeOps({ hours: 1.5, state: ' Done ', assignee: ' someone@example.com ' });
  assert.deepStrictEqual(paths(ops), [
    'Microsoft.VSTS.Scheduling.CompletedWork',
    'Microsoft.VSTS.Scheduling.RemainingWork',
    'System.AssignedTo',
    'System.State',
  ]);
  assert.strictEqual(ops[2].value, 'someone@example.com');
  assert.strictEqual(ops[3].value, 'Done');
});

test('completeOps: 0 hours is valid; negative, missing or non-numeric is refused', () => {
  assert.strictEqual(completeOps({ hours: 0 })[0].value, 0);
  assert.throws(() => completeOps({ hours: -1 }), /invalid hours/);
  assert.throws(() => completeOps({}), /invalid hours/);
  assert.throws(() => completeOps({ hours: NaN }), /invalid hours/);
});

test('completeOps: blank state or assignee is left out instead of written empty', () => {
  assert.deepStrictEqual(paths(completeOps({ hours: 2, state: '  ', assignee: '' })).length, 2);
});

test('onlyRemainingWorkMustBeEmpty: the lone InvalidNotEmpty on Remaining Work, and nothing else', () => {
  const lone = 'HTTP 400 {"RuleValidationErrors":[{"fieldReferenceName":"Microsoft.VSTS.Scheduling.RemainingWork","errorMessage":"TF401320: Rule Error for field Remaining Work. Error code: InvalidNotEmpty."}]}';
  const two = 'HTTP 400 {"RuleValidationErrors":[{"fieldReferenceName":"Microsoft.VSTS.Scheduling.RemainingWork","errorMessage":"InvalidNotEmpty"},{"fieldReferenceName":"System.AssignedTo","errorMessage":"Required"}]}';
  assert.strictEqual(onlyRemainingWorkMustBeEmpty(lone), true);
  assert.strictEqual(onlyRemainingWorkMustBeEmpty(two), false);
  assert.strictEqual(onlyRemainingWorkMustBeEmpty('TF401320: Rule Error for field Remaining Work. Error code: InvalidNotEmpty.'), true);
  assert.strictEqual(onlyRemainingWorkMustBeEmpty('TF401320: Rule Error for field Remaining Work. Error code: Required.'), false);
  assert.strictEqual(onlyRemainingWorkMustBeEmpty(''), false);
});

test('rejectsMissingAssignee: matches the prose Azure returns, in English and Portuguese', () => {
  assert.strictEqual(rejectsMissingAssignee('TF401320: Rule Error for field Assigned To. Error code: Required, InvalidEmpty.'), true);
  assert.strictEqual(rejectsMissingAssignee('field System.AssignedTo cannot be empty'), true);
  assert.strictEqual(rejectsMissingAssignee('TF401320: Erro de regra para o campo Atribuído a.'), true);
  assert.strictEqual(rejectsMissingAssignee('TF401320: Rule Error for field Remaining Work.'), false);
  assert.strictEqual(rejectsMissingAssignee(undefined), false);
});
