'use strict';

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

module.exports = { getPullRequest, listPullRequests, createPullRequest, updatePullRequest, abandonPullRequest, getRef, createRef, deleteRef, pushCommit, getComments, addComment, buildThreadBody, getIterations, getIterationChanges, editComment, replyToThread, deleteComment, updateThread, getChanges, findPullRequestsByBranch, getBranchDiff, getFileContent, getCommit, getCommitChanges, getCommitDiff, voteLabel, parseVoteEvents, summarizePrTimeline, reviewHealth };
