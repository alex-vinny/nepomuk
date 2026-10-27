'use strict';

const crypto = require('crypto');
const path = require('path');
const { request, buildBase } = require('./api');

const API = '7.1';

/**
 * GET /pullRequests/{prId}
 */
async function getPullRequest({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}?api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * GET the work items linked to a pull request.
 * Returns the raw [{ id, url }] list — the ids are what a reviewer needs; the
 * endpoint answers with an empty list (not a 404) when nothing is linked.
 */
async function getPullRequestWorkItems({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const res = await request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/workitems?api-version=${API}`,
    { pat: config.pat }
  );
  return res.value || [];
}

/**
 * GET pull request comment threads
 */
async function getComments({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/threads?api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * POST a new comment thread on the PR.
 * filePath and lineNumber are optional (omit for PR-level comments).
 * side: 'right' (post-image, added lines — default) or 'left' (pre-image, deleted lines).
 */
/**
 * Build the thread body for a PR comment. Pure (no network) so it can be unit-tested.
 * Omit filePath for a PR-level comment; pass side='left' to anchor a deleted line on
 * the pre-image, otherwise 'right' (added/edited lines, the default).
 */
function buildThreadBody({ content, filePath, lineNumber, side = 'right', status = 'active' }) {
  const thread = {
    comments: [{ content, commentType: 1 /* text */ }],
    status,
  };
  if (filePath) {
    thread.threadContext = { filePath };
    if (lineNumber != null) {
      const start = { line: lineNumber, offset: 1 };
      const end = { line: lineNumber, offset: 1 };
      if (side === 'left') {
        thread.threadContext.leftFileStart = start;
        thread.threadContext.leftFileEnd = end;
      } else {
        thread.threadContext.rightFileStart = start;
        thread.threadContext.rightFileEnd = end;
      }
    }
  }
  return thread;
}

async function addComment({ config, org, project, repo, prId, content, filePath, lineNumber, side = 'right', status = 'active' }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);

  const thread = buildThreadBody({ content, filePath, lineNumber, side, status });

  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/threads?api-version=${API}`,
    { method: 'POST', pat: config.pat, body: thread }
  );
}

/**
 * GET the iterations of a PR (each push produces an iteration). The newest is the
 * last element; it carries sourceRefCommit / targetRefCommit / commonRefCommit.
 */
async function getIterations({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/iterations?api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * GET the changed files (changeEntries) for one PR iteration. Each entry has
 * item.path (canonical casing) and changeType (add|edit|delete|...).
 */
async function getIterationChanges({ config, org, project, repo, prId, iterationId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/iterations/${iterationId}/changes?$top=2000&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * List pull requests in a repo, filtered by status/target/creator.
 * status: 'active' | 'completed' | 'abandoned' | 'all' (default 'completed').
 * Azure returns newest-first; date filtering (e.g. "last month") is done by the caller.
 */
async function listPullRequests({ config, org, project, repo, status = 'completed', top = 50, targetRef, creatorId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const params = new URLSearchParams();
  params.set('searchCriteria.status', status);
  if (targetRef) params.set('searchCriteria.targetRefName', targetRef.startsWith('refs/') ? targetRef : `refs/heads/${targetRef}`);
  if (creatorId) params.set('searchCriteria.creatorId', creatorId);
  params.set('$top', String(top));
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests?${params.toString()}&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Create a pull request. sourceRef/targetRef accept either a bare branch
 * ("my-branch") or a full ref ("refs/heads/my-branch").
 */
async function createPullRequest({ config, org, project, repo, sourceRef, targetRef, title, description = '', isDraft = false }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const fullRef = (r) => (r.startsWith('refs/') ? r : `refs/heads/${r}`);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests?api-version=${API}`,
    {
      method: 'POST',
      pat: config.pat,
      body: {
        sourceRefName: fullRef(sourceRef),
        targetRefName: fullRef(targetRef),
        title,
        description,
        isDraft,
      },
    }
  );
}

const ZERO_OID = '0000000000000000000000000000000000000000';

/**
 * GET the objectId (commit SHA) a branch currently points at, or null if absent.
 */
async function getRef({ config, org, project, repo, branch }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const filter = encodeURIComponent(`heads/${branch}`);
  const data = await request(
    `${base}/${proj}/_apis/git/repositories/${rep}/refs?filter=${filter}&api-version=${API}`,
    { pat: config.pat }
  );
  const ref = (data.value || []).find((r) => r.name === `refs/heads/${branch}`);
  return ref ? ref.objectId : null;
}

/**
 * Create a branch pointing at an existing commit (no new commit). Fails if it exists.
 */
async function createRef({ config, org, project, repo, branch, sha }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/refs?api-version=${API}`,
    { method: 'POST', pat: config.pat, body: [{ name: `refs/heads/${branch}`, oldObjectId: ZERO_OID, newObjectId: sha }] }
  );
}

/**
 * Delete a branch (ref → zero). Pass the branch's current sha as oldObjectId.
 */
async function deleteRef({ config, org, project, repo, branch, sha }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/refs?api-version=${API}`,
    { method: 'POST', pat: config.pat, body: [{ name: `refs/heads/${branch}`, oldObjectId: sha, newObjectId: ZERO_OID }] }
  );
}

/**
 * Push a single commit onto `branch`, based on `baseSha`. Creates the branch if it
 * doesn't exist yet (refUpdate oldObjectId = baseSha). `changes` is an array of
 * { changeType: 'add'|'edit'|'delete', path, content }.
 */
async function pushCommit({ config, org, project, repo, branch, baseSha, message, changes }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const commitChanges = changes.map((c) => {
    const change = { changeType: c.changeType, item: { path: c.path } };
    if (c.changeType !== 'delete') change.newContent = { content: c.content, contentType: 'rawtext' };
    return change;
  });
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pushes?api-version=${API}`,
    {
      method: 'POST',
      pat: config.pat,
      body: {
        refUpdates: [{ name: `refs/heads/${branch}`, oldObjectId: baseSha }],
        commits: [{ comment: message, changes: commitChanges }],
      },
    }
  );
}

/**
 * PATCH a PR's status to 'abandoned' (soft close; branches remain until deleted).
 */
async function abandonPullRequest({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}?api-version=${API}`,
    { method: 'PATCH', pat: config.pat, body: { status: 'abandoned' } }
  );
}

// ── Completing a pull request ──────────────────────────────────────────────

const MERGE_STRATEGIES = ['noFastForward', 'squash', 'rebase', 'rebaseMerge'];

/**
 * GET the policy evaluations of a PR (build, reviewers, work-item linking, …).
 * The artifact id needs the project GUID — the PR payload carries it under
 * repository.project.id — not the project name.
 */
async function getPolicyEvaluations({ config, org, project, projectId, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const artifactId = encodeURIComponent(`vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`);
  const res = await request(
    `${base}/${proj}/_apis/policy/evaluations?artifactId=${artifactId}&api-version=7.1-preview.1`,
    { pat: config.pat }
  );
  return res.value || [];
}

/**
 * Blocking policies that are not yet approved — what stands between the PR and a
 * normal completion. Pure. `notApplicable` is not pending: the policy does not
 * cover this PR.
 */
function pendingPolicies(evaluations) {
  return (evaluations || [])
    .filter((e) => e && e.configuration && e.configuration.isBlocking)
    .filter((e) => e.status !== 'approved' && e.status !== 'notApplicable')
    .map((e) => ({
      id: e.configuration.id,
      status: e.status,
      type: (e.configuration.type && e.configuration.type.displayName) || 'policy',
      name: (e.configuration.settings && e.configuration.settings.displayName) || '',
    }));
}

/**
 * Why this PR cannot be completed at all, whatever the flags. Pure.
 * A merge that is not `succeeded` is fatal for an immediate completion but not for
 * auto-complete, which waits for a push that fixes it.
 */
function completionBlockers(prData, { expectHead, auto, bypass, force } = {}) {
  const blockers = [];
  // A bypass skips the reviewer policies too, so it would merge over a "waiting for
  // author" or a rejection without anyone noticing. That takes an explicit --force.
  if (bypass && !force) {
    const against = ((prData && prData.reviewers) || []).filter((r) => r.vote < 0);
    if (against.length) {
      blockers.push(`--bypass would merge over ${against.map((r) => `${r.displayName} (${r.vote})`).join(', ')}. `
        + 'Get the votes changed, or add --force if merging over them is intended.');
    }
  }
  if (!prData || prData.status !== 'active') blockers.push(`PR status is "${prData && prData.status}", not active.`);
  if (prData && prData.isDraft) blockers.push('PR is a draft — publish it first.');
  const merge = prData && prData.mergeStatus;
  if (!auto && merge !== 'succeeded') {
    blockers.push(`Merge status is "${merge}"${merge === 'conflicts' ? ' — resolve the conflicts and push' : ''}; `
      + 'only a "succeeded" merge can be completed now.');
  }
  const head = prData && prData.lastMergeSourceCommit && prData.lastMergeSourceCommit.commitId;
  if (expectHead != null && expectHead !== true) {
    const check = checkExpectedHead(head, expectHead);
    if (!check.ok) blockers.push(`--expect-head ${check.expected} does not match the PR head ${check.actual || '(unknown)'} (${check.reason}).`);
  }
  return blockers;
}

/**
 * The commit message Azure's web UI proposes: "Merged PR <id>: <title>", the
 * description, and the linked work items. Pure.
 */
function defaultMergeMessage(prData, workItemIds = []) {
  const parts = [`Merged PR ${prData.pullRequestId}: ${prData.title}`];
  const desc = String(prData.description || '').trim();
  if (desc) parts.push(desc);
  if (workItemIds.length) parts.push(`Related work items: ${workItemIds.map((id) => `#${id}`).join(', ')}`);
  return parts.join('\n\n');
}

/**
 * PATCH body that completes the PR now, or arms auto-complete when
 * autoCompleteUserId is given. Pure. lastMergeSourceCommit pins the completion to
 * the head that was previewed: Azure refuses it if the branch moved since.
 */
function buildCompletionBody({ prData, strategy = 'noFastForward', deleteSourceBranch = false,
  transitionWorkItems = false, message, bypassReason, autoCompleteUserId }) {
  if (!MERGE_STRATEGIES.includes(strategy)) {
    throw new Error(`Unknown merge strategy "${strategy}". Use one of: ${MERGE_STRATEGIES.join(', ')}.`);
  }
  if (bypassReason && autoCompleteUserId) {
    throw new Error('Bypass and auto-complete do not mix: auto-complete waits for the policies, bypass skips them.');
  }
  const completionOptions = { mergeStrategy: strategy, deleteSourceBranch, transitionWorkItems };
  if (message) completionOptions.mergeCommitMessage = message;
  if (bypassReason) {
    completionOptions.bypassPolicy = true;
    completionOptions.bypassReason = bypassReason;
  }
  if (autoCompleteUserId) return { autoCompleteSetBy: { id: autoCompleteUserId }, completionOptions };
  return {
    status: 'completed',
    lastMergeSourceCommit: { commitId: prData.lastMergeSourceCommit.commitId },
    completionOptions,
  };
}

/** PATCH /pullRequests/{prId} with a body from buildCompletionBody. */
async function completePullRequest({ config, org, project, repo, prId, body }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}?api-version=${API}`,
    { method: 'PATCH', pat: config.pat, body }
  );
}

/**
 * PATCH /pullRequests/{prId} — update title and/or description in place.
 */
async function updatePullRequest({ config, org, project, repo, prId, title, description }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const body = {};
  if (title != null) body.title = title;
  if (description != null) body.description = description;
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}?api-version=${API}`,
    { method: 'PATCH', pat: config.pat, body }
  );
}

/**
 * GET changed files in a PR iteration.
 */
async function getChanges({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/iterations?api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Find existing open pull requests between two branches.
 */
async function findPullRequestsByBranch({ config, org, project, repo, sourceRef, targetRef }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const src = encodeURIComponent(`refs/heads/${sourceRef}`);
  const tgt = encodeURIComponent(`refs/heads/${targetRef}`);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests?searchCriteria.sourceRefName=${src}&searchCriteria.targetRefName=${tgt}&searchCriteria.status=all&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Get the list of files changed between two branches.
 */
async function getBranchDiff({ config, org, project, repo, sourceRef, targetRef, top = 200 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const src = encodeURIComponent(sourceRef);
  const tgt = encodeURIComponent(targetRef);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/diffs/commits?baseVersion=${tgt}&baseVersionType=branch&targetVersion=${src}&targetVersionType=branch&$top=${top}&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Get the raw text content of a file from a specific branch or commit.
 */
async function getFileContent({ config, org, project, repo, path: filePath, branch, commitId, versionType = 'branch' }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const version = commitId || branch;
  const vtype = commitId ? 'commit' : versionType;
  if (!version) throw new Error('Either branch or commitId is required to fetch file content.');
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/items?path=${encodeURIComponent(filePath)}&versionDescriptor.version=${encodeURIComponent(version)}&versionDescriptor.versionType=${vtype}&api-version=${API}`,
    { pat: config.pat, headers: { Accept: 'text/plain' } }
  );
}

/**
 * DELETE a single comment from a thread.
 * commentId defaults to 1 (first/only comment in a thread).
 */
async function deleteComment({ config, org, project, repo, prId, threadId, commentId = 1 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/threads/${threadId}/comments/${commentId}?api-version=${API}`,
    { method: 'DELETE', pat: config.pat }
  );
}

/**
 * PATCH the content of an existing comment (keeps the thread + its anchor).
 */
async function editComment({ config, org, project, repo, prId, threadId, commentId = 1, content }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/threads/${threadId}/comments/${commentId}?api-version=${API}`,
    { method: 'PATCH', pat: config.pat, body: { content } }
  );
}

/**
 * POST a reply into an existing thread (keeps it threaded under the original comment
 * instead of opening a new top-level thread). parentCommentId defaults to 1 (the first
 * comment in the thread).
 */
async function replyToThread({ config, org, project, repo, prId, threadId, content, parentCommentId = 1 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/threads/${threadId}/comments?api-version=${API}`,
    { method: 'POST', pat: config.pat, body: { content, parentCommentId, commentType: 1 /* text */ } }
  );
}

/**
 * PATCH a thread's status (e.g. 'closed', 'active', 'fixed', 'wontFix', 'byDesign', 'pending').
 */
async function updateThread({ config, org, project, repo, prId, threadId, status }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/pullRequests/${prId}/threads/${threadId}?api-version=${API}`,
    { method: 'PATCH', pat: config.pat, body: { status } }
  );
}

/**
 * Get a single commit by SHA.
 */
async function getCommit({ config, org, project, repo, commitId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/commits/${commitId}?api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Get the list of changes (files) for a single commit.
 */
async function getCommitChanges({ config, org, project, repo, commitId, top = 200 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/commits/${commitId}/changes?$top=${top}&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Get the diff between a commit and its first parent.
 * Azure's diffs/commits API supports commit version types.
 */
async function getCommitDiff({ config, org, project, repo, commitId, top = 200 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const sha = encodeURIComponent(commitId);
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/diffs/commits?baseVersion=${sha}~1&baseVersionType=commit&targetVersion=${sha}&targetVersionType=commit&$top=${top}&api-version=${API}`,
    { pat: config.pat }
  );
}

// ── review timeline ──────────────────────────────────────────────────────────
// Azure exposes a reviewer's CURRENT vote on the PR object, but not when it was
// cast, and never that a PR was completed with no vote at all. Both are recorded
// as system comments in the thread feed, so review health has to be reconstructed
// from there.

// Azure's vote scale. Worth naming: the numbers are not ordered intuitively —
// 5 is a weaker approval than 10, and 0 means "no vote", not "neutral".
const VOTE_LABELS = {
  10: 'approved',
  5: 'approved with suggestions',
  0: 'no vote',
  '-5': 'waiting for author',
  '-10': 'rejected',
};

const VOTE_RE = /^(.+?) voted (-?\d+)$/;
const PUBLISHED_RE = /published the pull request/i;

/** Human-readable name for a vote code. Pure. */
function voteLabel(vote) {
  const key = Number(vote);
  return VOTE_LABELS[key] !== undefined ? VOTE_LABELS[key] : `unknown (${vote})`;
}

function toDays(from, to) {
  return +((to - from) / 86400000).toFixed(1);
}

function median(sortedNumbers) {
  const a = sortedNumbers;
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : +(((a[mid - 1] + a[mid]) / 2).toFixed(1));
}

/**
 * Pull vote events and the draft-publish moment out of a PR's thread feed. Pure.
 *
 * Votes arrive as SYSTEM comments reading "<display name> voted <n>". Requiring
 * commentType === 'system' is what stops a human comment that happens to read
 * "Bob voted 10" from being counted as a review.
 */
function parseVoteEvents(threads) {
  const list = (threads && threads.value) || threads || [];
  const votes = [];
  let publishedAt = null;

  for (const thread of list) {
    for (const c of thread.comments || []) {
      if (c.commentType && c.commentType !== 'system') continue;
      const text = String(c.content || '').trim();
      const m = text.match(VOTE_RE);
      if (m) {
        votes.push({ who: m[1], vote: Number(m[2]), at: c.publishedDate || null });
        continue;
      }
      if (PUBLISHED_RE.test(text)) publishedAt = c.publishedDate || null;
    }
  }

  votes.sort((a, b) => (String(a.at) < String(b.at) ? -1 : 1));
  return { votes, publishedAt };
}

/**
 * One PR's review lifecycle. Pure — takes the PR object, its threads, and `now`.
 *
 * An open PR is measured to `now`, a closed one to its closedDate. A vote of 0 is
 * a reviewer CLEARING their vote, so it does not count as the first review and
 * does not save a PR from `noVote`.
 */
function summarizePrTimeline(pullRequest, threads, now) {
  const end = now instanceof Date ? now : new Date(now);
  const { votes, publishedAt } = parseVoteEvents(threads);
  const created = new Date(pullRequest.creationDate);
  const closed = pullRequest.closedDate ? new Date(pullRequest.closedDate) : null;
  const realVotes = votes.filter((v) => v.vote !== 0);
  const first = realVotes.length ? realVotes[0] : null;

  return {
    id: pullRequest.pullRequestId,
    title: pullRequest.title || '',
    author: (pullRequest.createdBy && pullRequest.createdBy.displayName) || '',
    status: pullRequest.status || '',
    isDraft: !!pullRequest.isDraft,
    created: pullRequest.creationDate || null,
    publishedAt,
    closed: pullRequest.closedDate || null,
    ageDays: toDays(created, closed || end),
    open: !closed,
    firstVote: first,
    daysToFirstVote: first && first.at ? toDays(created, new Date(first.at)) : null,
    votes,
    noVote: realVotes.length === 0,
  };
}

/**
 * Roll a repo's PR summaries into review-health figures. Pure.
 *
 * `noVote` is the headline: a completed PR nobody voted on was merged without
 * review, which no per-PR view surfaces. `neverVoted` counts PRs that have no
 * first-vote latency at all, so they are excluded from the latency median rather
 * than silently counted as zero.
 */
function reviewHealth(summaries) {
  const list = summaries || [];
  const ages = list.map((s) => s.ageDays).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const latencies = list.map((s) => s.daysToFirstVote).filter((n) => typeof n === 'number').sort((a, b) => a - b);
  const noVote = list.filter((s) => s.noVote);

  const byAuthor = {};
  for (const s of list) {
    const key = s.author || '(unknown)';
    if (!byAuthor[key]) byAuthor[key] = { n: 0, noVote: 0, ages: [] };
    byAuthor[key].n += 1;
    if (s.noVote) byAuthor[key].noVote += 1;
    if (typeof s.ageDays === 'number') byAuthor[key].ages.push(s.ageDays);
  }
  for (const key of Object.keys(byAuthor)) {
    const a = byAuthor[key];
    a.ages.sort((x, y) => x - y);
    a.medianAgeDays = median(a.ages);
    a.maxAgeDays = a.ages.length ? a.ages[a.ages.length - 1] : null;
  }

  return {
    total: list.length,
    noVote: noVote.map((s) => s.id),
    noVoteRatio: list.length ? +(noVote.length / list.length).toFixed(2) : 0,
    medianAgeDays: median(ages),
    maxAgeDays: ages.length ? ages[ages.length - 1] : null,
    medianDaysToFirstVote: median(latencies),
    neverVoted: list.length - latencies.length,
    byAuthor,
  };
}

/**
 * Compare a PR's current head against the commit the reviewer actually read.
 *
 * `--dry-run` does NOT protect against this. A head that moves between the diff
 * and the post still validates: the file still exists, the line still exists, and
 * the comment lands silently on whatever code now occupies that line number. The
 * only defence is refusing to post when the head is not the reviewed one.
 *
 * Pure so it is testable without a network: callers pass the commit id they read
 * from the latest iteration. A short sha (>= 7 chars) matches by prefix, since
 * that is how shas are quoted in notes and review scratchpads.
 */
function checkExpectedHead(actualCommitId, expected) {
  const actual = String(actualCommitId || '').toLowerCase();
  const want = String(expected == null ? '' : expected).trim().toLowerCase();
  if (!want) return { ok: true, actual, expected: null, reason: 'no-expectation' };
  if (!/^[0-9a-f]{7,40}$/.test(want)) {
    return { ok: false, actual, expected: want, reason: 'malformed' };
  }
  if (!actual) return { ok: false, actual, expected: want, reason: 'unknown-head' };
  const ok = actual === want || (want.length < actual.length && actual.startsWith(want));
  return { ok, actual, expected: want, reason: ok ? 'match' : 'moved' };
}

/**
 * Threads already anchored at a given file+line, so a second comment on the same
 * spot is a deliberate choice rather than an accident. Pure: hand it the payload
 * from getComments().
 *
 * Path comparison is normalized the same way the anchor resolver normalizes it
 * (leading slash, backslashes, casing) — Azure's canonical casing often differs
 * from what a reviewer typed. A null lineNumber matches file-level threads only.
 */
function threadsAnchoredAt(commentsResp, filePath, lineNumber) {
  const norm = (s) => String(s || '').replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase();
  const want = norm(filePath);
  if (!want) return [];
  const threads = (commentsResp && commentsResp.value) || [];
  return threads
    .filter((t) => !t.isDeleted && t.threadContext && norm(t.threadContext.filePath) === want)
    .filter((t) => {
      const line = (t.threadContext.rightFileStart && t.threadContext.rightFileStart.line)
        || (t.threadContext.leftFileStart && t.threadContext.leftFileStart.line)
        || null;
      return lineNumber == null ? line == null : line === lineNumber;
    })
    .map((t) => {
      const first = (t.comments || []).find((c) => !c.isDeleted && c.content) || {};
      const firstLine = String(first.content || '').split('\n')[0].slice(0, 80);
      return { id: t.id, status: t.status, firstLine };
    });
}

/** The source-side commit of the latest iteration — a PR's current head. */
function latestHeadCommit(iterations) {
  const list = (iterations && iterations.value) || iterations || [];
  if (!Array.isArray(list) || !list.length) return null;
  const latest = list[list.length - 1];
  return (latest && latest.sourceRefCommit && latest.sourceRefCommit.commitId) || null;
}

// ── PR attachments ─────────────────────────────────────────────────────────
//
// A PR attachment differs from a work-item one in the ways that matter here:
// the file name is the address (…/attachments/{fileName}, no blob id), the url
// Azure hands back (project and repo as GUIDs) is the form the PR UI itself writes
// into markdown and renders, and nothing collects an upload that no comment uses.

// Client-side guard only. Azure documents no size limit for PR attachments; this is
// the work-item limit, borrowed so a huge file is stopped before the bytes go out.
const PR_ATTACHMENT_MAX_BYTES = 60 * 1024 * 1024;

// Anyone who can read the repo can download a PR attachment. A script dressed as
// evidence is the obvious abuse, and nothing in Azure filters by type.
const BLOCKED_ATTACHMENT_EXT = new Set([
  '.bat', '.cmd', '.com', '.dll', '.exe', '.js', '.jse', '.msi', '.ps1', '.psm1', '.scr', '.sh', '.vbe', '.vbs', '.wsf',
]);

// What `![alt](./x)` may upload. SVG is left out: it can carry script.
const PR_IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

/** Pure: SHA-1 of the bytes in upper-case hex, the form Azure reports as contentHash. */
function sha1Hex(buffer) {
  return crypto.createHash('sha1').update(buffer).digest('hex').toUpperCase();
}

/**
 * Pure: a file name that survives inside `![alt](url)`. Accents are dropped and every
 * run of anything outside [A-Za-z0-9._-] becomes one '-': a space or a parenthesis in
 * the name ends up raw in the url Azure returns, and either one breaks the link.
 * Returns '' when nothing usable is left.
 */
function sanitizeAttachmentName(name) {
  const raw = String(name == null ? '' : name).trim();
  const dot = raw.lastIndexOf('.');
  const stem = dot > 0 ? raw.slice(0, dot) : raw;
  const ext = dot > 0 ? raw.slice(dot + 1) : '';
  const clean = (s) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  const cleanStem = clean(stem);
  if (!cleanStem) return '';
  const cleanExt = clean(ext);
  return cleanExt ? `${cleanStem}.${cleanExt}` : cleanStem;
}

/** Pure: the upload url. The name goes in the PATH (a work item takes ?fileName=). */
function prAttachmentUploadUrl({ base, projectId, repoId, prId, fileName, apiVersion = API }) {
  return `${base}/${encodeURIComponent(projectId)}/_apis/git/repositories/${encodeURIComponent(repoId)}`
    + `/pullRequests/${prId}/attachments/${encodeURIComponent(fileName)}?api-version=${apiVersion}`;
}

/**
 * Pure: the url Azure returns for an upload — GUIDs, no api-version. Used to show a
 * dry run with the real length, which matters against the 4000-char description cap.
 */
function predictedAttachmentUrl({ base, projectId, repoId, prId, fileName }) {
  return `${base}/${projectId}/_apis/git/repositories/${repoId}/pullRequests/${prId}/attachments/${encodeURIComponent(fileName)}`;
}

/** Pure: the markdown line for an attachment. Space and parentheses would end the link. */
function attachmentMarkdown({ url, alt }) {
  const safeUrl = String(url).replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  const safeAlt = String(alt == null ? '' : alt).replace(/[[\]]/g, '');
  return `![${safeAlt}](${safeUrl})`;
}

/**
 * Pure: reject an upload that cannot work, before spending the bytes, and decide
 * between uploading and reusing. Returns { ok, action: 'upload' | 'reuse', attachment? }
 * or { ok: false, reason, message }.
 *
 * The name is the address, so a second file under a taken name either fails or
 * replaces the first, and every comment already showing it would show the new one.
 * Same name with the same bytes is the same evidence: reuse it, which also makes a
 * re-run after a failure safe.
 */
function checkPrAttachment({ fileName, size, sha1, existing = [] }) {
  if (!fileName) {
    return { ok: false, reason: 'no-name', message: 'An attachment needs a file name.' };
  }
  const suggested = sanitizeAttachmentName(fileName);
  if (suggested !== fileName) {
    return {
      ok: false,
      reason: 'bad-name',
      message: `"${fileName}" has characters that break a markdown image link (space, accent, parenthesis…). `
        + (suggested ? `Use --name "${suggested}".` : 'Pick a name with letters, digits, ".", "_" or "-".'),
    };
  }
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  if (BLOCKED_ATTACHMENT_EXT.has(ext)) {
    return {
      ok: false,
      reason: 'blocked-type',
      message: `"${fileName}" is an executable or script type. A PR attachment can be downloaded by everyone `
        + 'who reads the repo, so this tool does not upload one. Zip it, or attach the evidence some other way.',
    };
  }
  // Explicit, because both numeric checks below pass on undefined (see checkAttachment).
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return { ok: false, reason: 'no-size', message: `Cannot check "${fileName}": size is ${JSON.stringify(size)}, not a byte count.` };
  }
  if (size === 0) {
    return { ok: false, reason: 'empty', message: `"${fileName}" is 0 bytes; there is nothing to show.` };
  }
  if (size > PR_ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `"${fileName}" is ${(size / 1024 / 1024).toFixed(1)} MB. This tool stops PR attachments over `
        + `${PR_ATTACHMENT_MAX_BYTES / 1024 / 1024} MB (a client guard: Azure documents no PR limit; this is the `
        + 'work-item one). Compress or crop the file.',
    };
  }
  const lower = fileName.toLowerCase();
  const taken = existing.find((a) => String(a.displayName || '').toLowerCase() === lower);
  if (taken) {
    if (!sha1) {
      return { ok: false, reason: 'no-hash', message: `"${fileName}" is already on the PR; its hash is needed to compare.` };
    }
    if (String(taken.contentHash || '').toUpperCase() === String(sha1).toUpperCase()) {
      return { ok: true, action: 'reuse', attachment: taken };
    }
    return {
      ok: false,
      reason: 'name-taken',
      message: `The PR already has "${taken.displayName}" with different content. Uploading again could replace `
        + 'the picture every existing comment shows. Pick another name with --name.',
    };
  }
  return { ok: true, action: 'upload' };
}

/**
 * Pure: turn an Azure error from a PR lookup or upload into what to do about it.
 * Returns null when there is nothing better to say than the raw message.
 */
function explainPrAttachmentError(err, { fileName, project, repo, prId } = {}) {
  const msg = String((err && err.message) || '');
  const status = err && err.statusCode;
  if (/TF401019/.test(msg)) {
    return `The repo "${repo}" was not found in project "${project}" (or the PAT cannot see it). The project is `
      + 'often not the default: pass the full PR url, or --project "<project>". Nothing was uploaded.';
  }
  if (/TF401180/.test(msg)) {
    return `PR !${prId} does not exist in ${project}/${repo}. A PR id is only unique within its repo: check --repo. `
      + 'Nothing was uploaded.';
  }
  if (status === 403) {
    return 'Azure refused the upload (HTTP 403): the PAT needs the Code (read & write) scope on this repo.';
  }
  if (status === 409) {
    return `Azure refused "${fileName}" (HTTP 409): most likely the PR already has an attachment with that name. `
      + 'Pick another with --name.';
  }
  if (status === 413) {
    return `Azure refused "${fileName}" as too large (HTTP 413). Compress or crop it.`;
  }
  return null;
}

/** GET the attachments of a PR: [{ id, displayName, url, contentHash, createdDate, author }]. */
async function listPrAttachments({ config, org, project, repo, prId }) {
  const base = buildBase(config, org);
  const res = await request(
    `${base}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`
      + `/pullRequests/${prId}/attachments?api-version=${API}`,
    { pat: config.pat }
  );
  return (res && res.value) || [];
}

/**
 * POST the bytes as an attachment of the PR. Returns the Attachment ({ id, displayName,
 * url, contentHash, … }). projectId/repoId are the GUIDs from the PR itself, so a
 * renamed repo or a wrong default project cannot redirect the upload.
 */
async function uploadPrAttachment({ config, org, projectId, repoId, prId, fileName, buffer }) {
  // A string body would take the JSON branch in api.js and land mangled (see attachFile).
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(`uploadPrAttachment needs a Buffer, got ${buffer === null ? 'null' : typeof buffer}. `
      + 'Read the file with fs.readFileSync(path) — with no encoding argument.');
  }
  const check = checkPrAttachment({ fileName, size: buffer.length });
  if (!check.ok) throw new Error(check.message);
  return request(prAttachmentUploadUrl({ base: buildBase(config, org), projectId, repoId, prId, fileName }), {
    method: 'POST',
    pat: config.pat,
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
    noRetryStatus: [409],
  });
}

/**
 * Attach a file to a PR, reusing an identical one already there.
 * Returns { attachment, reused, recovered, sha1 }.
 *
 * request() replays a POST after a 5xx or a timeout, and the first attempt may have
 * stored the file. So after a failure the list is read again: the same name with the
 * same hash means the upload landed, and saying "failed" would be wrong.
 */
async function attachToPullRequest({ config, org, project, repo, prId, projectId, repoId, fileName, buffer, existing = [] }) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(`attachToPullRequest needs a Buffer, got ${buffer === null ? 'null' : typeof buffer}.`);
  }
  const sha1 = sha1Hex(buffer);
  const check = checkPrAttachment({ fileName, size: buffer.length, sha1, existing });
  if (!check.ok) throw new Error(check.message);
  if (check.action === 'reuse') return { attachment: check.attachment, reused: true, recovered: false, sha1 };

  try {
    const attachment = await uploadPrAttachment({ config, org, projectId, repoId, prId, fileName, buffer });
    return { attachment, reused: false, recovered: false, sha1 };
  } catch (err) {
    let landed = null;
    try {
      const now = await listPrAttachments({ config, org, project, repo, prId });
      landed = now.find((a) => String(a.displayName || '').toLowerCase() === fileName.toLowerCase()
        && String(a.contentHash || '').toUpperCase() === sha1);
    } catch { /* the original error is the one worth reporting */ }
    if (landed) return { attachment: landed, reused: false, recovered: true, sha1 };
    throw err;
  }
}

// `![alt](ref)`, `![alt](<ref>)` or `![alt](ref "title")`. Unlike embedLocalImages in
// workitem.js the ref may hold spaces: a screenshot is usually "Print QA.png", and a
// ref that escaped detection would be posted as a broken image with no warning.
const IMAGE_REF = /!\[([^\]]*)\]\(\s*(<[^>\n]+>|[^)\n]+?)\s*\)/g;

/** Pure: the path inside `(…)` — brackets, an optional title and %-escapes removed. */
function imageRefTarget(inner) {
  let ref = inner.startsWith('<') ? inner.slice(1, -1) : inner.replace(/\s+("[^"]*"|'[^']*')$/, '');
  try { ref = decodeURIComponent(ref); } catch { /* a literal % stays as written */ }
  return ref.trim();
}

/** Pure: [start, end) ranges of fenced code blocks and inline code spans. */
function codeRanges(text) {
  const ranges = [];
  const fence = /^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm;
  let m;
  while ((m = fence.exec(text))) {
    ranges.push([m.index, m.index + m[0].length]);
    if (!m[0].length) fence.lastIndex++;
  }
  const inline = /`[^`\n]+`/g;
  while ((m = inline.exec(text))) {
    const at = m.index;
    if (!ranges.some(([s, e]) => at >= s && at < e)) ranges.push([at, at + m[0].length]);
  }
  return ranges;
}

/**
 * Pure: the local images a markdown body points at — `![alt](./shot.png)`, relative
 * to `baseDir` (the body file's folder) or absolute. Urls with a scheme (https:, data:)
 * and anything inside code are left out: a code sample is not a picture to upload.
 * Returns [{ start, end, alt, ref, file }].
 */
function findLocalImageRefs(md, { baseDir = process.cwd() } = {}) {
  const text = String(md == null ? '' : md);
  const code = codeRanges(text);
  const refs = [];
  let m;
  IMAGE_REF.lastIndex = 0;
  while ((m = IMAGE_REF.exec(text))) {
    const at = m.index;
    if (code.some(([s, e]) => at >= s && at < e)) continue;
    const ref = imageRefTarget(m[2]);
    if (!ref) continue;
    // A Windows drive ("C:\x.png", "D:/x.png") looks like a scheme to the test below.
    const isDrive = /^[a-zA-Z]:[\\/]/.test(ref);
    if (!isDrive && /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(ref)) continue;
    refs.push({ start: at, end: at + m[0].length, alt: m[1], ref, file: path.isAbsolute(ref) ? ref : path.resolve(baseDir, ref) });
  }
  return refs;
}

/**
 * Pure: one upload per distinct file, named for the url. Throws, listing every
 * problem, when a ref is not an image or two different files would share a name.
 * Returns [{ file, name, refs: [ref, …] }].
 */
function planImageUploads(refs) {
  const byFile = new Map();
  const problems = [];
  for (const r of refs) {
    const ext = path.extname(r.file).toLowerCase();
    if (!PR_IMAGE_EXT.has(ext)) {
      problems.push(`"${r.ref}" is not an image this tool uploads (${[...PR_IMAGE_EXT].join(', ')}).`);
      continue;
    }
    const key = path.resolve(r.file);
    if (!byFile.has(key)) byFile.set(key, { file: key, name: sanitizeAttachmentName(path.basename(key)), refs: [] });
    byFile.get(key).refs.push(r.ref);
  }
  const byName = new Map();
  for (const u of byFile.values()) {
    if (!u.name) { problems.push(`"${u.refs[0]}" leaves no usable attachment name; rename the file.`); continue; }
    const k = u.name.toLowerCase();
    if (byName.has(k)) problems.push(`"${byName.get(k).refs[0]}" and "${u.refs[0]}" would both be attached as "${u.name}"; rename one file.`);
    else byName.set(k, u);
  }
  if (problems.length) throw new Error(problems.join('\n'));
  return [...byFile.values()];
}

/** Pure: replace each ref (from findLocalImageRefs) with `![alt](urlFor(ref))`. */
function rewriteImageRefs(md, refs, urlFor) {
  const text = String(md == null ? '' : md);
  let out = '';
  let at = 0;
  for (const r of [...refs].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, r.start) + attachmentMarkdown({ url: urlFor(r), alt: r.alt });
    at = r.end;
  }
  return out + text.slice(at);
}

module.exports = { checkExpectedHead, latestHeadCommit, threadsAnchoredAt, getPullRequest, getPullRequestWorkItems, listPullRequests, createPullRequest, updatePullRequest, abandonPullRequest, MERGE_STRATEGIES, getPolicyEvaluations, pendingPolicies, completionBlockers, defaultMergeMessage, buildCompletionBody, completePullRequest, getRef, createRef, deleteRef, pushCommit, getComments, addComment, buildThreadBody, getIterations, getIterationChanges, editComment, replyToThread, deleteComment, updateThread, getChanges, findPullRequestsByBranch, getBranchDiff, getFileContent, getCommit, getCommitChanges, getCommitDiff, voteLabel, parseVoteEvents, summarizePrTimeline, reviewHealth, PR_ATTACHMENT_MAX_BYTES, PR_IMAGE_EXT, sha1Hex, sanitizeAttachmentName, prAttachmentUploadUrl, predictedAttachmentUrl, attachmentMarkdown, checkPrAttachment, explainPrAttachmentError, listPrAttachments, uploadPrAttachment, attachToPullRequest, findLocalImageRefs, planImageUploads, rewriteImageRefs };
