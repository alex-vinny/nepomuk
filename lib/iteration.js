'use strict';

// Iterations (sprints). Two different endpoints answer two different questions:
//
//   classificationnodes/iterations  — every iteration DEFINED in the project,
//                                     as a tree, whether or not a team uses it.
//   {team}/work/teamsettings/iterations — the flat list one team SUBSCRIBED to.
//
// Sprint dates live here and nowhere else: a work item carries only its
// IterationPath string, so any "was this delivered inside the sprint?" question
// needs this module to supply the window.

const { request, buildBase } = require('./api');

const API = '7.1';

/** GET the project's iteration tree. depth 4 covers project → release → sprint → sub. */
async function getIterationTree({ config, org, project, depth = 4 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/classificationnodes/iterations?$depth=${depth}&api-version=${API}`,
    { pat: config.pat }
  );
}

/** GET the iterations one team has subscribed to (that team's actual sprints). */
async function getTeamIterations({ config, org, project, team }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const tm = encodeURIComponent(team);
  return request(
    `${base}/${proj}/${tm}/_apis/work/teamsettings/iterations?api-version=${API}`,
    { pat: config.pat }
  );
}

// Dates come back as full ISO timestamps; only the day is meaningful for a sprint
// boundary, and trimming avoids timezone drift shifting a sprint by one day.
function dayOf(value) {
  return value ? String(value).slice(0, 10) : null;
}

/**
 * Flatten the classification-node tree into one row per node. Pure.
 *
 * Paths are joined with a backslash to match the System.IterationPath value Azure
 * puts on work items, so a row from here can be pasted straight into a WIQL
 * `UNDER` clause without translation.
 *
 * A node with no `attributes` is normal, not a bug — undated folders exist purely
 * to group sprints, and they are kept so the caller can see the shape of the tree.
 */
function flattenIterationTree(node, parentPath = '') {
  if (!node || !node.name) return [];
  const path = parentPath ? `${parentPath}\\${node.name}` : node.name;
  const attrs = node.attributes || {};
  const rows = [{
    path,
    name: node.name,
    start: dayOf(attrs.startDate),
    finish: dayOf(attrs.finishDate),
  }];
  for (const child of node.children || []) rows.push(...flattenIterationTree(child, path));
  return rows;
}

/** Normalize the teamsettings shape into the same rows as the tree. Pure. */
function flattenTeamIterations(response) {
  const list = (response && response.value) || response || [];
  return list.map((it) => {
    const attrs = it.attributes || {};
    return {
      path: it.path || it.name,
      name: it.name,
      start: dayOf(attrs.startDate),
      finish: dayOf(attrs.finishDate),
    };
  });
}

/**
 * Filter by case-insensitive regex, retried as a literal substring when the regex
 * matches nothing. Pure.
 *
 * The retry is the point. An iteration path is backslash-separated, so the natural
 * thing to paste is `Contoso\2026\Sprint 1` — and as a regex that is perfectly
 * VALID and silently wrong: `\2` is a backreference and `\S` means non-whitespace,
 * so it throws nothing and matches nothing. Catching a syntax error is not enough.
 *
 * Trying the regex first keeps `Sprint \d` working, since a pattern that already
 * matched never reaches the fallback. A pattern matching neither way returns
 * empty, which is the honest answer.
 */
function filterIterations(list, pattern) {
  if (!pattern || pattern === true) return list || [];
  const text = String(pattern);
  const rows = list || [];

  let re = null;
  try { re = new RegExp(text, 'i'); } catch (e) { re = null; }
  if (re) {
    const hits = rows.filter((it) => re.test(it.path));
    if (hits.length) return hits;
  }

  const needle = text.toLowerCase();
  return rows.filter((it) => String(it.path).toLowerCase().includes(needle));
}

/**
 * The iteration(s) containing `now`, boundaries inclusive. Pure.
 *
 * Returns an array, not one row: a project's tree legitimately nests a sprint
 * inside a dated release folder, so more than one node can be "current".
 * Compared as YYYY-MM-DD strings, which sidesteps timezone drift entirely.
 */
function currentIteration(list, now) {
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  return (list || []).filter((it) => it.start && it.finish && it.start <= today && today <= it.finish);
}

module.exports = {
  getIterationTree,
  getTeamIterations,
  flattenIterationTree,
  flattenTeamIterations,
  filterIterations,
  currentIteration,
};
