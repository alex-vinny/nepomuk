'use strict';

// Repo-level reads. These come up constantly in promotion and merge-back flows —
// resolve a repo's default branch, confirm a source branch exists, get the repo
// *id* (several repo-property writes reject the name and only accept the id).

const { request, buildBase } = require('./api');

const API = '7.1';

/** GET every repo in a project, or across the whole org when project is omitted. */
async function listRepos({ config, org, project }) {
  const base = buildBase(config, org);
  const scope = project ? `/${encodeURIComponent(project)}` : '';
  return request(`${base}${scope}/_apis/git/repositories?api-version=${API}`, { pat: config.pat });
}

/** GET one repo by name or id — id, defaultBranch, size, clone urls. */
async function getRepo({ config, org, project, repo }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  return request(`${base}/${proj}/_apis/git/repositories/${rep}?api-version=${API}`, { pat: config.pat });
}

/**
 * GET refs, optionally narrowed by prefix. Pass filter 'heads/my-branch' to ask
 * "does this branch exist?" — the answer is whether the result is empty.
 */
async function listRefs({ config, org, project, repo, filter }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const rep = encodeURIComponent(repo);
  const qs = filter ? `filter=${encodeURIComponent(filter)}&` : '';
  return request(
    `${base}/${proj}/_apis/git/repositories/${rep}/refs?${qs}api-version=${API}`,
    { pat: config.pat }
  );
}

/** Drop the refs/heads/ prefix so a ref prints as the branch name. Pure. */
function shortBranch(ref) {
  return String(ref == null ? '' : ref).replace(/^refs\/heads\//, '');
}

/** Flatten a repo object to the fields callers actually use. Pure. */
function summarizeRepo(repo) {
  if (!repo) return null;
  return {
    id: repo.id || null,
    name: repo.name || '',
    project: (repo.project && repo.project.name) || '',
    defaultBranch: shortBranch(repo.defaultBranch),
    size: typeof repo.size === 'number' ? repo.size : null,
    isDisabled: !!repo.isDisabled,
    remoteUrl: repo.remoteUrl || null,
    webUrl: repo.webUrl || null,
  };
}

module.exports = { listRepos, getRepo, listRefs, shortBranch, summarizeRepo };
