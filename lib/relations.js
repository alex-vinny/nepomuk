'use strict';

// Work item → work item links (Related, Parent/Child, Predecessor/Successor, Duplicate).
// `wi create --parent` only covers the parent at creation time; this is the general case.

const { request, buildBase } = require('./api');
const { updateWorkItem } = require('./workitem');
const hierarchy = require('./hierarchy');

const API = '7.1';

const LINK_TYPES = {
  related: 'System.LinkTypes.Related',
  parent: 'System.LinkTypes.Hierarchy-Reverse',
  child: 'System.LinkTypes.Hierarchy-Forward',
  predecessor: 'System.LinkTypes.Dependency-Reverse',
  successor: 'System.LinkTypes.Dependency-Forward',
  duplicate: 'System.LinkTypes.Duplicate-Forward',
  'duplicate-of': 'System.LinkTypes.Duplicate-Reverse',
};

/** Pure: link type name → reference name; throws listing the accepted names. */
function resolveLinkType(name) {
  const key = String(name || 'related').toLowerCase();
  const rel = LINK_TYPES[key];
  if (!rel) throw new Error(`Unknown link type "${name}". Use one of: ${Object.keys(LINK_TYPES).join(', ')}.`);
  return rel;
}

/** Pure: the work item id at the end of a relation URL, or null. */
function relationTargetId(url) {
  const m = /\/workItems\/(\d+)\/?$/i.exec(String(url || ''));
  return m ? Number(m[1]) : null;
}

/** Pure: the relation already on the item with this type and target, or null. */
function findExistingLink(relations, rel, targetId) {
  return (relations || []).find((r) => r.rel === rel && relationTargetId(r.url) === Number(targetId)) || null;
}

/** Pure: JSON Patch ops that add one link. */
function buildAddLinkOps({ base, rel, targetId, comment }) {
  const value = { rel, url: `${base}/_apis/wit/workItems/${targetId}` };
  if (comment) value.attributes = { comment };
  return [{ op: 'add', path: '/relations/-', value }];
}

/** The item with its relations (fields come along: type and project feed the hierarchy guard). */
async function getItemWithRelations({ config, org, id }) {
  const base = buildBase(config, org);
  return request(`${base}/_apis/wit/workItems/${id}?$expand=relations&api-version=${API}`, { pat: config.pat });
}

/**
 * Before a parent/child link is written: refuses a same-level hierarchy (see lib/hierarchy.js).
 * `item` is the work item being changed (with fields); `rel` the link it gets to `targetId`.
 */
async function guardHierarchy({ config, org, item, rel, targetId, team, allowSameLevel }) {
  if (allowSameLevel || (rel !== LINK_TYPES.parent && rel !== LINK_TYPES.child)) return;
  const f = item.fields || {};
  const self = { id: Number(item.id), type: f['System.WorkItemType'], project: f['System.TeamProject'] };
  const target = await hierarchy.getTypeAndProject({ config, org, id: targetId });
  const [parent, child] = rel === LINK_TYPES.parent ? [target, self] : [self, target];
  await hierarchy.assertHierarchyAllowed({ config, org, parent, child, team });
}

/**
 * Adds the link unless the same type + target is already there.
 * Returns { status: 'exists' | 'planned' | 'added', rel }. With dryRun nothing is written.
 * A parent/child link inside one backlog level is refused unless allowSameLevel.
 */
async function addLink({ config, org, id, targetId, type, comment, dryRun = false, allowSameLevel = false, team }) {
  if (Number(id) === Number(targetId)) throw new Error('A work item cannot be linked to itself.');

  const rel = resolveLinkType(type);
  const item = await getItemWithRelations({ config, org, id });
  const current = item.relations || [];
  if (findExistingLink(current, rel, targetId)) return { status: 'exists', rel };

  const otherParent = rel === LINK_TYPES.parent && current.find((r) => r.rel === LINK_TYPES.parent);
  if (otherParent) throw new Error(`#${id} already has parent #${relationTargetId(otherParent.url)} — a work item has only one parent.`);
  await guardHierarchy({ config, org, item, rel, targetId, team, allowSameLevel });
  if (dryRun) return { status: 'planned', rel };

  const base = buildBase(config, org);
  await updateWorkItem({ config, org, id, ops: buildAddLinkOps({ base, rel, targetId, comment }) });
  return { status: 'added', rel };
}

// ── unlink / relink ──────────────────────────────────────────────────────────

const LINK_NAMES = Object.fromEntries(Object.entries(LINK_TYPES).map(([name, rel]) => [rel, name]));

/** Pure: the link's short name (related, parent, …), or the reference name for any other type. */
function linkName(rel) {
  return LINK_NAMES[rel] || rel;
}

/** Pure: every work item → work item link from this item to targetId, with its index in `relations`. */
function linksTo(relations, targetId) {
  return (relations || [])
    .map((r, index) => ({ index, rel: r.rel, url: r.url }))
    .filter((r) => relationTargetId(r.url) === Number(targetId));
}

/**
 * Pure: picks the one link to act on. `type` (a short name) narrows it; without it the item must
 * have exactly one link to the target, so an ambiguous call is refused instead of guessed.
 */
function pickLink(links, { id, targetId, type }) {
  const shown = (ls) => ls.map((l) => linkName(l.rel)).join(', ');
  if (!links.length) throw new Error(`#${id} has no link to #${targetId}.`);
  if (type) {
    const rel = resolveLinkType(type);
    const match = links.find((l) => l.rel === rel);
    if (!match) throw new Error(`#${id} has no ${type} link to #${targetId} (it has: ${shown(links)}).`);
    return match;
  }
  if (links.length > 1) throw new Error(`#${id} has ${links.length} links to #${targetId} (${shown(links)}) — pass --type to choose one.`);
  return links[0];
}

/**
 * Pure: one atomic PATCH. The test of /rev makes Azure refuse the whole PATCH when the item
 * changed after it was read; an unchanged revision means the index still points at that link.
 */
function buildReplaceLinkOps({ rev, link, newRel, comment }) {
  const ops = [
    { op: 'test', path: '/rev', value: rev },
    { op: 'remove', path: `/relations/${link.index}` },
  ];
  if (newRel) {
    const value = { rel: newRel, url: link.url };
    if (comment) value.attributes = { comment };
    ops.push({ op: 'add', path: '/relations/-', value });
  }
  return ops;
}

/**
 * Removes one link to targetId (no newType: unlink) or turns it into another type (relink).
 * `type` picks which existing link when there is more than one.
 * Returns { status: 'same' | 'planned' | 'done', from, to }. With dryRun nothing is written.
 */
async function replaceLink({ config, org, id, targetId, type, newType, comment, dryRun = false, allowSameLevel = false, team }) {
  if (Number(id) === Number(targetId)) throw new Error('A work item cannot be linked to itself.');
  const newRel = newType ? resolveLinkType(newType) : null;

  const item = await getItemWithRelations({ config, org, id });
  const links = linksTo(item.relations, targetId);
  if (!type && newRel && links.length === 1 && links[0].rel === newRel) return { status: 'same', from: newRel, to: newRel };
  const link = pickLink(links, { id, targetId, type });
  if (newRel && link.rel === newRel) return { status: 'same', from: newRel, to: newRel };
  if (newRel && findExistingLink(item.relations, newRel, targetId)) {
    throw new Error(`#${id} already has a ${linkName(newRel)} link to #${targetId} — remove the ${linkName(link.rel)} one with wi unlink instead.`);
  }
  if (newRel === LINK_TYPES.parent) {
    const otherParent = (item.relations || []).find((r, i) => r.rel === LINK_TYPES.parent && i !== link.index);
    if (otherParent) throw new Error(`#${id} already has parent #${relationTargetId(otherParent.url)} — a work item has only one parent.`);
  }
  if (newRel) await guardHierarchy({ config, org, item, rel: newRel, targetId, team, allowSameLevel });
  if (dryRun) return { status: 'planned', from: link.rel, to: newRel };

  const ops = buildReplaceLinkOps({ rev: item.rev, link, newRel, comment });
  try {
    await updateWorkItem({ config, org, id, ops });
  } catch (e) {
    throw new Error(`${e.message}\nNothing was changed on #${id}: the PATCH is all-or-nothing. If the item was edited since it was read, re-run.`);
  }
  return { status: 'done', from: link.rel, to: newRel };
}

module.exports = {
  LINK_TYPES, resolveLinkType, relationTargetId, findExistingLink, buildAddLinkOps, addLink,
  linkName, linksTo, pickLink, buildReplaceLinkOps, replaceLink,
};
