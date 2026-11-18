'use strict';

/**
 * @mentions in work-item comments.
 *
 * Azure DevOps notifies a person only when the comment HTML carries the mention anchor
 * with their identity id: `<a href="#" data-vss-mention="version:2.0,<id>">@Name</a>`.
 * A typed "@Name" is plain text and notifies nobody.
 *
 * `--mention` takes a comma-separated list. Each entry is one of:
 *   creator   — the item's System.CreatedBy
 *   assignee  — the item's System.AssignedTo (refused when unassigned)
 *   <email or name> — looked up in the organization's identities; it must match exactly
 *                     one active identity, otherwise nothing is posted.
 *
 * The anchors go in a paragraph at the top of the comment.
 */

const ROLE_FIELDS = { creator: 'System.CreatedBy', assignee: 'System.AssignedTo' };

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Pure: "creator, a@b.com" -> ['creator', 'a@b.com']; refuses an empty list or flag without value. */
function parseMentionSpecs(value) {
  if (value === undefined || value === null || value === false) return [];
  if (value === true) throw new Error('--mention needs a value: creator, assignee, an email or a name (comma-separated).');
  const specs = String(value).split(',').map((s) => s.trim()).filter(Boolean);
  if (!specs.length) throw new Error('--mention is empty. Use creator, assignee, an email or a name.');
  return [...new Set(specs)];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: the anchor Azure DevOps turns into a mention (and a notification). */
function mentionAnchor({ id, displayName }) {
  if (!GUID.test(String(id || ''))) throw new Error(`Invalid identity id for mention: "${id}".`);
  if (!displayName) throw new Error(`Identity ${id} has no display name.`);
  return `<a href="#" data-vss-mention="version:2.0,${id}">@${escapeHtml(displayName)}</a>`;
}

/** Pure: prepend the mentions paragraph to an already-converted comment body. */
function applyMentions(html, mentions) {
  if (!mentions || !mentions.length) return html;
  return `<p>${mentions.map(mentionAnchor).join(' ')}</p>\n${html}`;
}

/** Pure: identity ids Azure stored as mentions in a comment's HTML. */
function mentionedIds(html) {
  const ids = [];
  const re = /data-vss-mention="version:2\.0,([0-9a-f-]{36})"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) ids.push(m[1].toLowerCase());
  return ids;
}

/**
 * Resolve specs to identities. `request` and the urls are injected so the rules can be
 * tested without network.
 *   fetchFields(): Promise<fields of the work item>
 *   searchIdentities(term): Promise<array of { id, providerDisplayName, isActive, properties }>
 */
async function resolveMentions(specs, { fetchFields, searchIdentities }) {
  const out = [];
  let fields = null;
  for (const spec of specs) {
    const role = ROLE_FIELDS[spec.toLowerCase()];
    if (role) {
      fields = fields || await fetchFields();
      const ident = fields[role];
      if (!ident || !ident.id) throw new Error(`--mention ${spec}: the work item has no ${role}.`);
      out.push({ id: ident.id, displayName: ident.displayName, source: spec.toLowerCase() });
      continue;
    }
    const found = (await searchIdentities(spec) || []).filter((v) => v && v.isActive !== false);
    if (found.length === 0) throw new Error(`--mention "${spec}": no active identity found in the organization.`);
    if (found.length > 1) {
      const names = found.slice(0, 5).map((v) => v.providerDisplayName || v.id).join('; ');
      throw new Error(`--mention "${spec}" matches ${found.length} identities (${names}). Use the person's email.`);
    }
    out.push({ id: found[0].id, displayName: found[0].providerDisplayName, source: spec });
  }
  // The same person reached twice (e.g. creator and their email) is mentioned once.
  const seen = new Set();
  return out.filter((m) => (seen.has(m.id.toLowerCase()) ? false : seen.add(m.id.toLowerCase())));
}

module.exports = { parseMentionSpecs, mentionAnchor, applyMentions, mentionedIds, resolveMentions, ROLE_FIELDS };
