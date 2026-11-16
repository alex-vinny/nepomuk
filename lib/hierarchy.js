'use strict';

// Same-level parent/child guard.
//
// A backlog shows one level per row type: Epics, Features, Backlog items, Tasks. A parent/child
// link between two items of the SAME level (a Bug under a Product Backlog Item when bugs are
// managed as requirements, a Task under a Task) is a "same category hierarchy": Azure stores it
// without complaint, and the board then hides both items, blocks reordering and points at the
// child. So every command that creates a parent/child link asks this module first.

const { request, buildBase } = require('./api');

const API = '7.1';
const BUG_CATEGORY = 'Microsoft.BugCategory';

/**
 * Pure: work item type (lower case) → { level, rank } from a backlogconfiguration payload.
 * Bug-category types are not listed on any backlog: they join the requirement or task level
 * according to `bugsBehavior` (a team setting), and stay off the backlogs when it is `off`.
 */
function backlogLevels(backlogConfig, bugTypes = []) {
  const map = new Map();
  const put = (backlog) => {
    if (!backlog) return;
    for (const t of backlog.workItemTypes || []) {
      if (t && t.name) map.set(t.name.toLowerCase(), { level: backlog.name, rank: backlog.rank });
    }
  };
  const bc = backlogConfig || {};
  for (const p of bc.portfolioBacklogs || []) put(p);
  put(bc.requirementBacklog);
  put(bc.taskBacklog);

  const host = bc.bugsBehavior === 'asRequirements' ? bc.requirementBacklog
    : bc.bugsBehavior === 'asTasks' ? bc.taskBacklog
      : null;
  if (host) {
    for (const name of bugTypes) {
      const key = String(name).toLowerCase();
      if (!map.has(key)) map.set(key, { level: host.name, rank: host.rank, viaBugsBehavior: bc.bugsBehavior });
    }
  }
  return map;
}

/**
 * Pure: the conflict a parent → child link would create, or null.
 * A type that is on no backlog cannot break one, so it is never a conflict.
 */
function hierarchyConflict({ parentLevels, parentType, childLevels = parentLevels, childType }) {
  const p = parentLevels && parentLevels.get(String(parentType || '').toLowerCase());
  const c = childLevels && childLevels.get(String(childType || '').toLowerCase());
  if (!p || !c) return null;
  if (p.rank === c.rank) return { level: p.level, viaBugsBehavior: p.viaBugsBehavior || c.viaBugsBehavior || null };
  return null;
}

/** Pure: the refusal text, with the two ways out. */
function conflictMessage({ parent, child, conflict }) {
  const who = (x) => (x.id ? `#${x.id} (${x.type})` : `the new ${x.type}`);
  const bugs = conflict.viaBugsBehavior ? ` (bugs are managed ${conflict.viaBugsBehavior === 'asRequirements' ? 'as requirements' : 'as tasks'} on this team)` : '';
  return `Refusing to make ${who(child)} a child of ${who(parent)}: both are on the "${conflict.level}" backlog level${bugs}. `
    + 'A parent/child link inside one level hides both items from the backlog and blocks reordering. '
    + 'Link them as Related instead, or pass --allow-same-level if the hierarchy is intended.';
}

/** Loads the backlog levels of a project (optionally one team's view of it). */
async function loadBacklogLevels({ config, org, project, team }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const teamSeg = team ? `/${encodeURIComponent(team)}` : '';
  const bc = await request(`${base}/${proj}${teamSeg}/_apis/work/backlogconfiguration?api-version=${API}`, { pat: config.pat });
  let bugTypes = [];
  if (bc && (bc.bugsBehavior === 'asRequirements' || bc.bugsBehavior === 'asTasks')) {
    const cat = await request(`${base}/${proj}/_apis/wit/workitemtypecategories/${BUG_CATEGORY}?api-version=${API}`, { pat: config.pat });
    bugTypes = ((cat && cat.workItemTypes) || []).map((t) => t.name);
  }
  return backlogLevels(bc, bugTypes);
}

/** Type and project of an existing work item (org-level read, no project needed). */
async function getTypeAndProject({ config, org, id }) {
  const base = buildBase(config, org);
  const item = await request(
    `${base}/_apis/wit/workItems/${id}?fields=System.WorkItemType,System.TeamProject&api-version=${API}`,
    { pat: config.pat }
  );
  const f = (item && item.fields) || {};
  return { id: Number(id), type: f['System.WorkItemType'], project: f['System.TeamProject'] };
}

/**
 * Throws when parent → child would be a same-level hierarchy. `parent` and `child` are
 * { id?, type, project }. Each project's levels are read once (`cache` is shared across calls).
 */
async function assertHierarchyAllowed({ config, org, parent, child, team, cache = new Map() }) {
  const levelsOf = async (project) => {
    const key = `${project}\u0000${team || ''}`;
    if (!cache.has(key)) cache.set(key, await loadBacklogLevels({ config, org, project, team }));
    return cache.get(key);
  };
  const parentLevels = await levelsOf(parent.project);
  const childLevels = child.project === parent.project ? parentLevels : await levelsOf(child.project);
  const conflict = hierarchyConflict({ parentLevels, parentType: parent.type, childLevels, childType: child.type });
  if (conflict) throw new Error(conflictMessage({ parent, child, conflict }));
}

module.exports = {
  backlogLevels, hierarchyConflict, conflictMessage, loadBacklogLevels, getTypeAndProject, assertHierarchyAllowed,
};
