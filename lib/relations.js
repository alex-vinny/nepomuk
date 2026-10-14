'use strict';

// Work item → work item links (Related, Parent/Child, Predecessor/Successor, Duplicate).
// `wi create --parent` only covers the parent at creation time; this is the general case.

const { request, buildBase } = require('./api');
const { updateWorkItem } = require('./workitem');

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

async function getRelations({ config, org, id }) {
  const base = buildBase(config, org);
  const item = await request(`${base}/_apis/wit/workItems/${id}?$expand=relations&api-version=${API}`, { pat: config.pat });
  return item.relations || [];
}

/**
 * Adds the link unless the same type + target is already there.
 * Returns { status: 'exists' | 'planned' | 'added', rel }. With dryRun nothing is written.
 */
async function addLink({ config, org, id, targetId, type, comment, dryRun = false }) {
  if (Number(id) === Number(targetId)) throw new Error('A work item cannot be linked to itself.');

  const rel = resolveLinkType(type);
  const current = await getRelations({ config, org, id });
  if (findExistingLink(current, rel, targetId)) return { status: 'exists', rel };

  const otherParent = rel === LINK_TYPES.parent && current.find((r) => r.rel === LINK_TYPES.parent);
  if (otherParent) throw new Error(`#${id} already has parent #${relationTargetId(otherParent.url)} — a work item has only one parent.`);
  if (dryRun) return { status: 'planned', rel };

  const base = buildBase(config, org);
  await updateWorkItem({ config, org, id, ops: buildAddLinkOps({ base, rel, targetId, comment }) });
  return { status: 'added', rel };
}

module.exports = { LINK_TYPES, resolveLinkType, relationTargetId, findExistingLink, buildAddLinkOps, addLink };
