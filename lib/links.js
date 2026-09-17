'use strict';

// Canonical Azure DevOps URLs and the reference lines a review ends with.
//
// Why this is a module and not a template someone retypes: a link is only valid
// with the right project segment, and the project is NOT guessable from the board
// you happen to be looking at. An org can hold repos spread across several
// projects and work items split across more than one board. The authoritative
// source is the ROOT SEGMENT OF THE WORK ITEM'S AREA PATH, which is always the
// project name.
//
// Everything here is pure: no network, no config. That keeps it unit-testable and
// keeps the formatting rule in one place.

/**
 * Project name from a work item's System.AreaPath.
 * `Platform\Digital\Squad 4` -> `Platform`. Accepts either slash.
 * Returns null for empty input rather than guessing a default.
 */
function projectFromAreaPath(areaPath) {
  const s = String(areaPath || '').trim();
  if (!s) return null;
  const root = s.split(/[\\/]/)[0].trim();
  return root || null;
}

/** Percent-encode one URL path segment. A space becomes %20, as Azure renders it. */
function seg(value) {
  return encodeURIComponent(String(value == null ? '' : value));
}

/**
 * Canonical browser URL for a pull request or a work item.
 * kind: 'pr' (needs repo) | 'wi'.
 */
function azureUrl({ org, project, kind, repo, id }) {
  if (!org) throw new Error('azureUrl: org is required.');
  if (!project) throw new Error('azureUrl: project is required — resolve it from the Area path root, never assume a default.');
  if (id == null || id === '') throw new Error('azureUrl: id is required.');
  const base = `https://dev.azure.com/${seg(org)}/${seg(project)}`;
  if (kind === 'wi') return `${base}/_workitems/edit/${seg(id)}`;
  if (kind === 'pr') {
    if (!repo) throw new Error('azureUrl: repo is required for a pull request URL.');
    return `${base}/_git/${seg(repo)}/pullrequest/${seg(id)}`;
  }
  throw new Error(`azureUrl: unknown kind "${kind}" (expected 'pr' or 'wi').`);
}

/**
 * The reference line that closes a review:
 *
 *   [Pull Request <id>](<url> "<url lowercase>"): [<Repo>][PBI <id>] <title>
 *
 * The link title is the SAME URL lowercased — that is what Azure DevOps produces
 * when you paste a link, so a generated line is indistinguishable from a pasted
 * one. `[<Repo>]` is the real repository taken from the PR, not the service name
 * that sounds like it matches the subject: the PR title alone never says where
 * the change lives.
 *
 * `wiId` is optional; with no linked work item the `[PBI ...]` group is omitted
 * rather than printed empty — a PR with no work item is a finding, not a blank.
 */
function prLinkLine({ org, project, repo, prId, title, wiId }) {
  const url = azureUrl({ org, project, kind: 'pr', repo, id: prId });
  const tags = `[${repo}]` + (wiId ? `[PBI ${wiId}]` : '');
  const text = String(title || '').trim();
  return `[Pull Request ${prId}](${url} "${url.toLowerCase()}"): ${tags}${text ? ` ${text}` : ''}`;
}

/**
 * Work-item counterpart, mirroring the PR line's shape: the work item type takes
 * the place of the repo tag.
 */
function wiLinkLine({ org, project, wiId, title, type }) {
  const url = azureUrl({ org, project, kind: 'wi', id: wiId });
  const tag = type ? `[${type}]` : '';
  const text = String(title || '').trim();
  return `[Work Item ${wiId}](${url} "${url.toLowerCase()}")${tag || text ? ':' : ''}${tag ? ` ${tag}` : ''}${text ? ` ${text}` : ''}`;
}

module.exports = { projectFromAreaPath, azureUrl, prLinkLine, wiLinkLine };
