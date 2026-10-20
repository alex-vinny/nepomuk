'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  pendingPolicies, completionBlockers, defaultMergeMessage, buildCompletionBody,
} = require('../lib/pr');

const evaluation = (status, isBlocking, type = 'Minimum number of reviewers', id = 1) => ({
  status, configuration: { id, isBlocking, type: { displayName: type }, settings: {} },
});

const activePr = (over = {}) => ({
  pullRequestId: 42,
  title: 'Add the thing',
  description: 'Why it matters.',
  status: 'active',
  isDraft: false,
  mergeStatus: 'succeeded',
  lastMergeSourceCommit: { commitId: 'abcdef1234567890abcdef1234567890abcdef12' },
  ...over,
});

// Seen on a real PR (2026-10-20): votes stayed 5 after a push, but the reviewer policy
// asks for a vote on the last iteration and went back to "queued".
test('pendingPolicies: blocking and not approved only', () => {
  const pending = pendingPolicies([
    evaluation('queued', true, 'Minimum number of reviewers', 377),
    evaluation('approved', true, 'Required reviewers', 395),
    evaluation('rejected', false, 'Build', 400),
    evaluation('notApplicable', true, 'Build', 401),
    evaluation('running', true, 'Build', 402),
  ]);
  assert.deepStrictEqual(pending.map((x) => [x.id, x.status]), [[377, 'queued'], [402, 'running']]);
});

test('completionBlockers: a clean active PR has none', () => {
  assert.deepStrictEqual(completionBlockers(activePr()), []);
});

test('completionBlockers: conflicts block now, not auto-complete', () => {
  const pr = activePr({ mergeStatus: 'conflicts' });
  assert.match(completionBlockers(pr).join(' '), /conflicts/);
  assert.deepStrictEqual(completionBlockers(pr, { auto: true }), []);
});

test('completionBlockers: draft, closed and a moved head', () => {
  assert.match(completionBlockers(activePr({ isDraft: true })).join(' '), /draft/);
  assert.match(completionBlockers(activePr({ status: 'completed' })).join(' '), /not active/);
  assert.deepStrictEqual(completionBlockers(activePr(), { expectHead: 'abcdef1' }), []);
  assert.match(completionBlockers(activePr(), { expectHead: '1234567' }).join(' '), /does not match/);
});

test('completionBlockers: bypass over a negative vote needs --force', () => {
  const pr = activePr({ reviewers: [{ displayName: 'Ana', vote: 10 }, { displayName: 'Bia', vote: -5 }] });
  assert.match(completionBlockers(pr, { bypass: true }).join(' '), /Bia \(-5\)/);
  assert.deepStrictEqual(completionBlockers(pr, { bypass: true, force: true }), []);
  assert.deepStrictEqual(completionBlockers(pr), []);
});

test('defaultMergeMessage: the web UI shape', () => {
  assert.strictEqual(defaultMergeMessage(activePr(), [7, 8]),
    'Merged PR 42: Add the thing\n\nWhy it matters.\n\nRelated work items: #7, #8');
  assert.strictEqual(defaultMergeMessage(activePr({ description: '' }), []), 'Merged PR 42: Add the thing');
});

test('buildCompletionBody: completes now, pinned to the previewed head', () => {
  const body = buildCompletionBody({ prData: activePr(), message: 'm', bypassReason: 'approved before the merge push' });
  assert.deepStrictEqual(body, {
    status: 'completed',
    lastMergeSourceCommit: { commitId: 'abcdef1234567890abcdef1234567890abcdef12' },
    completionOptions: {
      mergeStrategy: 'noFastForward', deleteSourceBranch: false, transitionWorkItems: false,
      mergeCommitMessage: 'm', bypassPolicy: true, bypassReason: 'approved before the merge push',
    },
  });
});

test('buildCompletionBody: auto-complete sets no status', () => {
  const body = buildCompletionBody({ prData: activePr(), strategy: 'squash', deleteSourceBranch: true, autoCompleteUserId: 'u1' });
  assert.deepStrictEqual(body, {
    autoCompleteSetBy: { id: 'u1' },
    completionOptions: { mergeStrategy: 'squash', deleteSourceBranch: true, transitionWorkItems: false },
  });
});

test('buildCompletionBody: refuses an unknown strategy and bypass with auto', () => {
  assert.throws(() => buildCompletionBody({ prData: activePr(), strategy: 'ff' }), /Unknown merge strategy/);
  assert.throws(() => buildCompletionBody({ prData: activePr(), bypassReason: 'x', autoCompleteUserId: 'u1' }), /do not mix/);
});
