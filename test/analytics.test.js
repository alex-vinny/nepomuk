'use strict';

// Unit tests for the measurement helpers behind `wi updates`, `sprints`,
// `pr timeline` and `repo`. Pure functions only — no network, no PAT.
// Every helper that needs the clock takes `now` as an argument, which is what
// lets an old measurement be re-run and produce the same numbers.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { extractFieldChanges, timeInState, firstEntry, lastEntry } = require('../lib/workitem');
const { flattenIterationTree, flattenTeamIterations, filterIterations, currentIteration } = require('../lib/iteration');
const { parseVoteEvents, summarizePrTimeline, reviewHealth, voteLabel } = require('../lib/pr');
const { shortBranch, summarizeRepo } = require('../lib/repo');

// ── extractFieldChanges (work-item history) ──────────────────────────────────
// The update feed is noisy: revisions that touch other fields, saves that rewrite
// the same value, and a year-9999 sentinel on the newest revision. Most of what
// follows is about what must NOT be counted as a transition.

const upd = (rev, fields, extra) => Object.assign(
  { rev, fields, revisedBy: { displayName: 'Ana' } },
  extra || {}
);
const stateChange = (from, to, at) => ({
  'System.State': { oldValue: from, newValue: to },
  'System.ChangedDate': { newValue: at },
});

test('extractFieldChanges: one row per real state transition', () => {
  const changes = extractFieldChanges([
    upd(1, stateChange(undefined, 'New', '2026-01-05T10:00:00Z')),
    upd(2, stateChange('New', 'Active', '2026-01-07T09:00:00Z')),
  ]);
  assert.strictEqual(changes.length, 2);
  assert.deepStrictEqual(changes.map((c) => c.from + '->' + c.to), ['->New', 'New->Active']);
  assert.strictEqual(changes[1].by, 'Ana');
});

test('extractFieldChanges: a revision rewriting the same value is not a transition', () => {
  const changes = extractFieldChanges([upd(1, stateChange('Active', 'Active', '2026-01-07T09:00:00Z'))]);
  assert.deepStrictEqual(changes, []); // counting these inflates every transition total
});

test('extractFieldChanges: revisions touching other fields are skipped', () => {
  const changes = extractFieldChanges([
    upd(1, { 'System.AssignedTo': { oldValue: 'a', newValue: 'b' } }),
    upd(2, stateChange('New', 'Active', '2026-01-07T09:00:00Z')),
  ]);
  assert.strictEqual(changes.length, 1);
});

test('extractFieldChanges: falls back to revisedDate when ChangedDate is absent', () => {
  const changes = extractFieldChanges([
    upd(1, { 'System.State': { oldValue: 'New', newValue: 'Active' } }, { revisedDate: '2026-02-02T08:00:00Z' }),
  ]);
  assert.strictEqual(changes[0].at, '2026-02-02T08:00:00Z');
});

test('extractFieldChanges: the year-9999 sentinel is treated as no date', () => {
  const changes = extractFieldChanges([
    upd(1, { 'System.State': { oldValue: 'New', newValue: 'Active' } }, { revisedDate: '9999-01-01T00:00:00Z' }),
  ]);
  assert.strictEqual(changes[0].at, null); // otherwise every open item looks 8000 years old
});

test('extractFieldChanges: tolerates an empty feed and revisions with no fields', () => {
  assert.deepStrictEqual(extractFieldChanges(undefined), []);
  assert.deepStrictEqual(extractFieldChanges([{ rev: 1 }, null]), []);
});

test('extractFieldChanges: tracks any field, not just State', () => {
  const changes = extractFieldChanges([
    upd(1, {
      'System.IterationPath': { oldValue: 'P\\S1', newValue: 'P\\S2' },
      'System.ChangedDate': { newValue: '2026-03-01T00:00:00Z' },
    }),
  ], 'System.IterationPath');
  assert.strictEqual(changes[0].to, 'P\\S2');
});

// ── timeInState ──────────────────────────────────────────────────────────────

test('timeInState: measures each span, the open one against the injected now', () => {
  const changes = extractFieldChanges([
    upd(1, stateChange('', 'New', '2026-01-01T00:00:00Z')),
    upd(2, stateChange('New', 'Active', '2026-01-03T00:00:00Z')),
  ]);
  const spans = timeInState(changes, new Date('2026-01-10T00:00:00Z'));
  assert.deepStrictEqual(spans.map((s) => [s.state, s.days, s.open]), [
    ['New', 2, false],
    ['Active', 7, true],
  ]);
  assert.strictEqual(spans[0].leftAt, '2026-01-03T00:00:00Z');
  assert.strictEqual(spans[1].leftAt, null);
});

test('timeInState: undated transitions are skipped, empty input returns empty', () => {
  assert.deepStrictEqual(timeInState([], new Date('2026-01-10T00:00:00Z')), []);
  assert.deepStrictEqual(timeInState([{ to: 'X', at: null }], new Date('2026-01-10T00:00:00Z')), []);
});

// ── firstEntry / lastEntry ───────────────────────────────────────────────────

test('firstEntry/lastEntry: a bounce-back has two entries and they differ', () => {
  const changes = [
    { to: 'Ready for Test', at: '2026-01-05T00:00:00Z' },
    { to: 'Active', at: '2026-01-06T00:00:00Z' },
    { to: 'Ready for Test', at: '2026-01-09T00:00:00Z' },
  ];
  assert.strictEqual(firstEntry(changes, 'Ready for Test'), '2026-01-05T00:00:00Z');
  assert.strictEqual(lastEntry(changes, 'Ready for Test'), '2026-01-09T00:00:00Z');
  assert.strictEqual(firstEntry(changes, 'Closed'), null);
  assert.strictEqual(lastEntry([], 'Closed'), null);
});

// ── iterations ───────────────────────────────────────────────────────────────

const TREE = {
  name: 'Contoso',
  attributes: {},
  children: [
    {
      // No attributes at all: a grouping folder. Real, and must not throw.
      name: '2026',
      children: [
        { name: 'Sprint 1', attributes: { startDate: '2026-01-05T00:00:00Z', finishDate: '2026-01-16T00:00:00Z' } },
        { name: 'Sprint 2', attributes: { startDate: '2026-01-19T00:00:00Z', finishDate: '2026-01-30T00:00:00Z' } },
      ],
    },
  ],
};

test('flattenIterationTree: paths use backslashes, matching System.IterationPath', () => {
  assert.deepStrictEqual(flattenIterationTree(TREE).map((r) => r.path), [
    'Contoso',
    'Contoso\\2026',
    'Contoso\\2026\\Sprint 1',
    'Contoso\\2026\\Sprint 2',
  ]);
});

test('flattenIterationTree: an undated folder yields null dates, not a crash', () => {
  const folder = flattenIterationTree(TREE).find((r) => r.path === 'Contoso\\2026');
  assert.strictEqual(folder.start, null);
  assert.strictEqual(folder.finish, null);
});

test('flattenIterationTree: dates are trimmed to the day', () => {
  const s1 = flattenIterationTree(TREE).find((r) => r.name === 'Sprint 1');
  assert.strictEqual(s1.start, '2026-01-05'); // trimming sidesteps timezone drift
  assert.strictEqual(s1.finish, '2026-01-16');
});

test('flattenIterationTree: null or nameless node returns empty', () => {
  assert.deepStrictEqual(flattenIterationTree(null), []);
  assert.deepStrictEqual(flattenIterationTree({}), []);
});

test('flattenTeamIterations: the teamsettings shape normalizes to the same rows', () => {
  const rows = flattenTeamIterations({
    value: [{
      name: 'Sprint 1',
      path: 'Contoso\\2026\\Sprint 1',
      attributes: { startDate: '2026-01-05T00:00:00Z', finishDate: '2026-01-16T00:00:00Z' },
    }],
  });
  assert.deepStrictEqual(rows, [
    { path: 'Contoso\\2026\\Sprint 1', name: 'Sprint 1', start: '2026-01-05', finish: '2026-01-16' },
  ]);
});

test('filterIterations: a backslash-free pattern is a regex', () => {
  const rows = flattenIterationTree(TREE);
  assert.strictEqual(filterIterations(rows, 'Sprint \\d').length, 2);
  assert.strictEqual(filterIterations(rows, 'sprint 1').length, 1); // case-insensitive
  assert.strictEqual(filterIterations(rows, null).length, rows.length);
});

test('filterIterations: a pasted iteration path falls back to a literal match', () => {
  const rows = flattenIterationTree(TREE);
  // As a regex this is VALID and matches nothing: \2 is a backreference and \S is
  // non-whitespace. The literal retry is what saves it.
  assert.strictEqual(filterIterations(rows, 'Contoso\\2026\\Sprint 1').length, 1);
  assert.strictEqual(filterIterations(rows, 'Contoso\\2026').length, 3);
  assert.strictEqual(filterIterations(rows, 'Contoso\\2027').length, 0);
});

test('currentIteration: boundaries are inclusive on both ends', () => {
  const rows = flattenIterationTree(TREE);
  assert.deepStrictEqual(currentIteration(rows, new Date('2026-01-05T23:00:00Z')).map((r) => r.name), ['Sprint 1']);
  assert.deepStrictEqual(currentIteration(rows, new Date('2026-01-16T01:00:00Z')).map((r) => r.name), ['Sprint 1']);
  assert.deepStrictEqual(currentIteration(rows, new Date('2026-01-17T12:00:00Z')), []);
});

// ── PR vote events ───────────────────────────────────────────────────────────
// Votes arrive as system comments. The test that matters most is the one proving
// a human comment cannot be mistaken for one.

const sysComment = (content, at) => ({ commentType: 'system', content, publishedDate: at });
const humanComment = (content, at) => ({ commentType: 'text', content, publishedDate: at });

test('parseVoteEvents: reads votes out of system comments, in time order', () => {
  const { votes } = parseVoteEvents({ value: [{ comments: [
    sysComment('Bruno Lima voted 10', '2026-02-03T10:00:00Z'),
    sysComment('Ana Costa voted -5', '2026-02-02T10:00:00Z'),
  ] }] });
  assert.deepStrictEqual(votes.map((v) => [v.who, v.vote]), [['Ana Costa', -5], ['Bruno Lima', 10]]);
});

test('parseVoteEvents: a HUMAN comment reading like a vote is not counted', () => {
  const { votes } = parseVoteEvents({ value: [{ comments: [
    humanComment('Bruno voted 10', '2026-02-03T10:00:00Z'),
    humanComment('looks good to me', '2026-02-03T11:00:00Z'),
  ] }] });
  assert.deepStrictEqual(votes, []); // requiring commentType 'system' is what stops this
});

test('parseVoteEvents: picks up the draft-publish moment', () => {
  const { publishedAt } = parseVoteEvents({ value: [{ comments: [
    sysComment('Ana Costa published the pull request', '2026-02-01T08:00:00Z'),
  ] }] });
  assert.strictEqual(publishedAt, '2026-02-01T08:00:00Z');
});

test('parseVoteEvents: accepts a bare array of threads, and an empty feed', () => {
  assert.deepStrictEqual(parseVoteEvents([]).votes, []);
  assert.deepStrictEqual(parseVoteEvents(undefined).votes, []);
  assert.strictEqual(parseVoteEvents([{ comments: [sysComment('Ana voted 5', '2026-01-01T00:00:00Z')] }]).votes.length, 1);
});

test('voteLabel: every code on the non-obvious Azure scale', () => {
  assert.strictEqual(voteLabel(10), 'approved');
  assert.strictEqual(voteLabel(5), 'approved with suggestions');
  assert.strictEqual(voteLabel(0), 'no vote');
  assert.strictEqual(voteLabel(-5), 'waiting for author');
  assert.strictEqual(voteLabel(-10), 'rejected');
  assert.ok(voteLabel(7).startsWith('unknown'));
});

// ── PR timeline ──────────────────────────────────────────────────────────────

const PR_OPEN = {
  pullRequestId: 100,
  title: 'Add suite',
  status: 'active',
  createdBy: { displayName: 'Ana Costa' },
  creationDate: '2026-02-01T00:00:00Z',
};
const PR_DONE = {
  pullRequestId: 101,
  title: 'Fix flake',
  status: 'completed',
  createdBy: { displayName: 'Bruno Lima' },
  creationDate: '2026-02-01T00:00:00Z',
  closedDate: '2026-02-05T00:00:00Z',
};
const NOW = new Date('2026-02-11T00:00:00Z');

test('summarizePrTimeline: an open PR measures to now, a closed one to closedDate', () => {
  assert.strictEqual(summarizePrTimeline(PR_OPEN, [], NOW).ageDays, 10);
  assert.strictEqual(summarizePrTimeline(PR_DONE, [], NOW).ageDays, 4);
  assert.strictEqual(summarizePrTimeline(PR_OPEN, [], NOW).open, true);
});

test('summarizePrTimeline: no votes at all flags noVote and leaves latency null', () => {
  const s = summarizePrTimeline(PR_DONE, [], NOW);
  assert.strictEqual(s.noVote, true);
  assert.strictEqual(s.daysToFirstVote, null);
  assert.strictEqual(s.firstVote, null);
});

test('summarizePrTimeline: a vote of 0 is a cleared vote, not a review', () => {
  const threads = [{ comments: [sysComment('Ana Costa voted 0', '2026-02-02T00:00:00Z')] }];
  const s = summarizePrTimeline(PR_DONE, threads, NOW);
  assert.strictEqual(s.noVote, true, 'a cleared vote does not count as review');
  assert.strictEqual(s.daysToFirstVote, null);
  assert.strictEqual(s.votes.length, 1, 'but it is still visible in the event list');
});

test('summarizePrTimeline: the first real vote sets the latency', () => {
  const threads = [{ comments: [
    sysComment('Ana Costa voted 0', '2026-02-02T00:00:00Z'),
    sysComment('Bruno Lima voted 10', '2026-02-03T12:00:00Z'),
  ] }];
  const s = summarizePrTimeline(PR_DONE, threads, NOW);
  assert.strictEqual(s.noVote, false);
  assert.strictEqual(s.daysToFirstVote, 2.5);
  assert.strictEqual(s.firstVote.who, 'Bruno Lima');
});

test('summarizePrTimeline: a draft published later keeps both moments', () => {
  const threads = [{ comments: [sysComment('Ana Costa published the pull request', '2026-02-04T00:00:00Z')] }];
  const s = summarizePrTimeline(Object.assign({}, PR_OPEN, { isDraft: true }), threads, NOW);
  assert.strictEqual(s.created, '2026-02-01T00:00:00Z');
  assert.strictEqual(s.publishedAt, '2026-02-04T00:00:00Z');
  assert.strictEqual(s.isDraft, true);
});

// ── reviewHealth ─────────────────────────────────────────────────────────────

test('reviewHealth: median averages the two middles on an even population', () => {
  const s = (id, author, ageDays, daysToFirstVote) => ({
    id, author, ageDays, daysToFirstVote, noVote: daysToFirstVote === null,
  });
  const h = reviewHealth([s(1, 'Ana', 2, 1), s(2, 'Ana', 4, 2), s(3, 'Bruno', 6, 3), s(4, 'Bruno', 10, 4)]);
  assert.strictEqual(h.medianAgeDays, 5); // (4 + 6) / 2
  assert.strictEqual(h.medianDaysToFirstVote, 2.5);
  assert.strictEqual(h.maxAgeDays, 10);
});

test('reviewHealth: median takes the middle on an odd population', () => {
  const s = (id, ageDays) => ({ id, author: 'Ana', ageDays, daysToFirstVote: 1, noVote: false });
  assert.strictEqual(reviewHealth([s(1, 2), s(2, 4), s(3, 30)]).medianAgeDays, 4);
});

test('reviewHealth: no-vote PRs are listed, ratioed, and excluded from latency', () => {
  const voted = { id: 1, author: 'Ana', ageDays: 3, daysToFirstVote: 1, noVote: false };
  const silent = { id: 2, author: 'Bruno', ageDays: 40, daysToFirstVote: null, noVote: true };
  const h = reviewHealth([voted, silent]);
  assert.deepStrictEqual(h.noVote, [2]);
  assert.strictEqual(h.noVoteRatio, 0.5);
  assert.strictEqual(h.neverVoted, 1);
  assert.strictEqual(h.medianDaysToFirstVote, 1); // the silent PR is not counted as 0
});

test('reviewHealth: groups per author with its own median and no-vote count', () => {
  const h = reviewHealth([
    { id: 1, author: 'Ana', ageDays: 2, daysToFirstVote: 1, noVote: false },
    { id: 2, author: 'Ana', ageDays: 8, daysToFirstVote: null, noVote: true },
    { id: 3, author: '', ageDays: 5, daysToFirstVote: 1, noVote: false },
  ]);
  assert.strictEqual(h.byAuthor.Ana.n, 2);
  assert.strictEqual(h.byAuthor.Ana.noVote, 1);
  assert.strictEqual(h.byAuthor.Ana.medianAgeDays, 5);
  assert.ok(h.byAuthor['(unknown)'], 'an author-less PR is still counted');
});

test('reviewHealth: an empty population does not divide by zero', () => {
  const h = reviewHealth([]);
  assert.deepStrictEqual([h.total, h.noVoteRatio, h.medianAgeDays, h.neverVoted], [0, 0, null, 0]);
});

// ── repo helpers ─────────────────────────────────────────────────────────────

test('shortBranch: strips refs/heads/ and tolerates null', () => {
  assert.strictEqual(shortBranch('refs/heads/main'), 'main');
  assert.strictEqual(shortBranch('refs/tags/v1'), 'refs/tags/v1'); // only heads/ is stripped
  assert.strictEqual(shortBranch(null), '');
});

test('summarizeRepo: flattens to the fields callers use, default branch shortened', () => {
  const r = summarizeRepo({
    id: 'abc-123',
    name: 'Web',
    project: { name: 'Fabrikam' },
    defaultBranch: 'refs/heads/main',
    size: 4096,
    remoteUrl: 'https://example/_git/Web',
    webUrl: 'https://example/_git/Web',
  });
  assert.strictEqual(r.defaultBranch, 'main');
  assert.strictEqual(r.project, 'Fabrikam');
  assert.strictEqual(r.isDisabled, false);
  assert.strictEqual(summarizeRepo(null), null);
});
