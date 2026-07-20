'use strict';

const { request, requestBinary, buildBase } = require('./api');

const API = '7.1';

/**
 * Minimal markdown-to-HTML converter for work-item comments.
 * Azure DevOps WI comments render HTML, not Markdown. Feeding raw markdown
 * results in visible tags and collapsed line breaks. This covers the constructs
 * used in our update comments: headings, bold, inline code, code blocks, lists,
 * paragraphs and line breaks.
 */
function markdownToHtml(md) {
  if (md == null) return '';
  let text = String(md).trim();

  // If the text already looks like HTML, leave it alone (but normalize newlines).
  if (/^\s*<[a-zA-Z][^>]*[\s\S]*<\/[a-zA-Z]+>\s*$/.test(text)) {
    return text.replace(/\r\n/g, '\n');
  }

  // Replace CRLF with LF.
  text = text.replace(/\r\n/g, '\n');

  // Fenced code blocks (``` ... ```). Stash them as placeholders BEFORE escaping so the
  // escapeHtml() pass below (and the later paragraph/<br/> passes) don't mangle the
  // <pre><code> we build here — previously the tags were escaped a second time and the
  // block rendered as literal "&lt;pre&gt;...". Restored verbatim at the very end.
  // The opening-fence info string (e.g. ```ts) is dropped.
  const codeBlocks = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, code) => {
    const escaped = escapeHtml(code.replace(/\n+$/g, ''));
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return `\n\n[[[CODEBLOCK${codeBlocks.length - 1}]]]\n\n`;
  });

  // Escape HTML in the remaining text before further transformations.
  text = escapeHtml(text);

  // Headings (h2 and h3 are enough for our templates).
  text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  text = text.replace(/^#### (.*)$/gm, '<h4>$1</h4>');

  // Bold.
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Inline code (after escaping, backticks are still literal).
  text = text.replace(/`(.+?)`/g, '<code>$1</code>');

  // Horizontal rule.
  text = text.replace(/^---$/gm, '<hr/>');

  // Lists: group consecutive dash lines into <ul> ... </li></ul>.
  const lines = text.split('\n');
  const out = [];
  let inList = false;
  for (const line of lines) {
    const listMatch = line.match(/^- (.*)$/);
    if (listMatch) {
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push(`<li>${listMatch[1]}</li>`);
    } else {
      if (inList) {
        out.push('</ul>');
        inList = false;
      }
      out.push(line);
    }
  }
  if (inList) out.push('</ul>');
  text = out.join('\n');

  // Paragraphs: blank-line-separated blocks that are not already block elements.
  const blocks = text.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^(<h[234]|<pre|<ul|<hr)/i.test(trimmed)) return trimmed;
    return `<p>${trimmed}</p>`;
  });

  text = blocks.filter(Boolean).join('\n');

  // Remaining single newlines become <br/> inside paragraphs.
  text = text.replace(/([^>])\n/g, '$1<br/>\n');

  // Restore fenced code blocks, unwrapping any <p> the paragraph pass wrapped the marker in.
  text = text.replace(/<p>\[\[\[CODEBLOCK(\d+)\]\]\]<\/p>/g, (m, i) => codeBlocks[Number(i)]);
  text = text.replace(/\[\[\[CODEBLOCK(\d+)\]\]\]/g, (m, i) => codeBlocks[Number(i)]);

  return text;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * GET /workItems/{id}
 * $expand=all includes relations, links, and attachments.
 */
async function getWorkItem({ config, org, project, id }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/workItems/${id}?$expand=all&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Search work items via WIQL, then hydrate the matching ids with the requested
 * fields. WIQL only returns ids, so we batch-fetch fields in chunks of 200
 * (the API's workitemsbatch page-size limit). Returns the raw work item objects
 * ({ id, fields, ... }).
 *
 * - wiql: a full WIQL query string (SELECT [System.Id] FROM WorkItems WHERE ...).
 * - fields: array of field reference names to hydrate (default: id/title/state/type).
 */
async function searchWorkItems({ config, org, project, wiql, fields }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const wiqlRes = await request(
    `${base}/${proj}/_apis/wit/wiql?api-version=${API}`,
    { method: 'POST', pat: config.pat, body: { query: wiql } }
  );
  const ids = (wiqlRes.workItems || []).map((w) => w.id);
  if (!ids.length) return [];

  const fieldList = (fields && fields.length)
    ? fields
    : ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType'];

  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const batch = await request(
      `${base}/_apis/wit/workitemsbatch?api-version=${API}`,
      { method: 'POST', pat: config.pat, body: { ids: chunk, fields: fieldList } }
    );
    out.push(...(batch.value || []));
  }
  return out;
}

/**
 * GET comments on a work item (uses wit/workItems/{id}/comments endpoint).
 */
async function getComments({ config, org, project, id }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.3`,
    { pat: config.pat }
  );
}

/**
 * POST a comment to a work item. Azure DevOps renders HTML; plain markdown is
 * converted to HTML so tags and line breaks do not show literally.
 */
async function addComment({ config, org, project, id, text }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.3`,
    { method: 'POST', pat: config.pat, body: { text: markdownToHtml(text) } }
  );
}

/**
 * PATCH an existing work-item comment in place. Same HTML conversion as addComment.
 */
async function editComment({ config, org, project, id, commentId, text }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${API}-preview.3`,
    { method: 'PATCH', pat: config.pat, body: { text: markdownToHtml(text) } }
  );
}

/**
 * DELETE a work-item comment. Azure does a soft-delete (the comment is marked
 * isDeleted and its text cleared); the comment id is freed from the thread view.
 * Returns {} on success (the API responds with an empty body).
 */
async function deleteComment({ config, org, project, id, commentId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/workItems/${id}/comments/${commentId}?api-version=${API}-preview.3`,
    { method: 'DELETE', pat: config.pat }
  );
}

/**
 * List attachments on a work item.
 * Relations with rel === "AttachedFile" are the attachments.
 */
async function listAttachments({ config, org, project, id }) {
  const wi = await getWorkItem({ config, org, project, id });
  const relations = wi.relations || [];
  return relations
    .filter((r) => r.rel === 'AttachedFile')
    .map((r) => ({
      name: r.attributes?.name || 'unknown',
      url: r.url,
      comment: r.attributes?.comment || '',
    }));
}

/**
 * Download an attachment by its REST URL. Returns { buffer, fileName, contentType }.
 */
async function downloadAttachment({ config, url: attachUrl }) {
  const result = await requestBinary(attachUrl, { pat: config.pat });
  const cd = result.headers['content-disposition'] || '';
  const match = cd.match(/filename[^;=\n]*=(['"]?)([^'";\n]+)\1/);
  const fileName = match ? match[2] : 'attachment';
  return { buffer: result.buffer, fileName, contentType: result.headers['content-type'] };
}

/**
 * Update work item fields via PATCH /workItems/{id}.
 * ops is an array of { op, path, value } JSON Patch operations.
 */
async function updateWorkItem({ config, org, project, id, ops }) {
  const base = buildBase(config, org);
  // project is optional — the org-level endpoint works for updates, which lets
  // callers (e.g. linking a PR) touch a work item without knowing its project.
  const projSeg = project ? `/${encodeURIComponent(project)}` : '';
  return request(
    `${base}${projSeg}/_apis/wit/workItems/${id}?api-version=${API}`,
    {
      method: 'PATCH',
      pat: config.pat,
      body: ops,
      headers: { 'Content-Type': 'application/json-patch+json' },
    }
  );
}

/**
 * Set a work item's state (System.State), e.g. 'In Progress', 'Aguardando CodeReview'.
 */
async function setState({ config, org, project, id, state }) {
  return updateWorkItem({ config, org, project, id, ops: [{ op: 'add', path: '/fields/System.State', value: state }] });
}

/**
 * Set an arbitrary field by its reference name (e.g. 'Custom.CausaRaiz',
 * 'Microsoft.VSTS.TCM.ReproSteps'). HTML/markdown fields take their raw string.
 */
async function setField({ config, org, project, id, field, value }) {
  return updateWorkItem({ config, org, project, id, ops: [{ op: 'add', path: `/fields/${field}`, value }] });
}

/**
 * Map the work item FORM layout (label -> field reference name) for a given
 * work item type. This is how you discover that a UI section like "Causa Raiz"
 * is backed by, say, Custom.CausaRaiz — empty fields never show up in getWorkItem,
 * so the layout is the reliable source of truth for custom field names.
 * Returns [{ label, referenceName, controlType }].
 */
async function getFormLayout({ config, org, project, type }) {
  const base = buildBase(config, org);
  // 1) project -> process template id
  const proj = await request(
    `${base}/_apis/projects/${encodeURIComponent(project)}?includeCapabilities=true&api-version=${API}`,
    { pat: config.pat }
  );
  const processId = proj.capabilities?.processTemplate?.templateTypeId;
  if (!processId) throw new Error('Could not resolve process template for project ' + project);
  // 2) process work item types -> exact ref name for the requested type
  const wits = await request(
    `${base}/_apis/work/processes/${processId}/workItemTypes?api-version=${API}`,
    { pat: config.pat }
  );
  const want = String(type || 'Bug').toLowerCase();
  const witType =
    (wits.value || []).find((w) => (w.name || '').toLowerCase() === want) ||
    (wits.value || []).find((w) => new RegExp(`(^|\\.)${want}$`, 'i').test(w.referenceName || ''));
  if (!witType) throw new Error(`Work item type "${type}" not found in process`);
  // 3) layout -> walk pages/sections/groups/controls
  const layout = await request(
    `${base}/_apis/work/processes/${processId}/workItemTypes/${witType.referenceName}/layout?api-version=${API}`,
    { pat: config.pat }
  );
  const out = [];
  for (const pg of layout.pages || []) {
    for (const sec of pg.sections || []) {
      for (const g of sec.groups || []) {
        for (const c of g.controls || []) {
          if (c.id) out.push({ label: c.label || '', referenceName: c.id, controlType: c.controlType || '' });
        }
      }
    }
  }
  return { witRefName: witType.referenceName, controls: out };
}

/**
 * Discover the "content" custom fields of a work item — the long-form,
 * rich-text/plain-text fields that are the intended home for analysis text
 * (e.g. "Causa Raiz" -> Custom.CausaRaiz), as opposed to a plain comment.
 *
 * Uses the FORM LAYOUT (so empty custom fields are still found) filtered to
 * long-form controls, cross-referenced with the work item's current values to
 * mark each field empty/filled. Single-line strings, dropdowns and the
 * built-in System./Microsoft. fields are excluded — only Custom. rich/plain
 * text controls qualify.
 *
 * Returns [] on any metadata-fetch failure so a transient process-API hiccup
 * never blocks a legitimate comment. Each entry: { label, referenceName,
 * controlType, empty }.
 */
async function getContentFields({ config, org, project, id, type }) {
  const LONG_FORM = new Set(['HtmlFieldControl', 'PlainTextControl']);
  try {
    const wi = type
      ? null
      : await getWorkItem({ config, org, project, id });
    const witType = type || wi?.fields?.['System.WorkItemType'] || 'Bug';
    const [{ controls }, valuesWi] = await Promise.all([
      getFormLayout({ config, org, project, type: witType }),
      wi ? Promise.resolve(wi) : getWorkItem({ config, org, project, id }),
    ]);
    const values = valuesWi.fields || {};
    const isEmpty = (ref) => {
      const v = values[ref];
      if (v == null) return true;
      // Strip tags/whitespace so an "<div><br></div>" placeholder counts as empty.
      return String(v).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === '';
    };
    const seen = new Set();
    const out = [];
    for (const c of controls) {
      const ref = c.referenceName || '';
      if (!ref.startsWith('Custom.')) continue;
      if (!LONG_FORM.has(c.controlType)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      out.push({ label: c.label || '', referenceName: ref, controlType: c.controlType, empty: isEmpty(ref) });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Link a pull request to a work item via an ArtifactLink relation.
 * projectId/repoId are the GUIDs of the PR's project and repository.
 */
async function linkPullRequest({ config, org, project, id, projectId, repoId, prId }) {
  const artifactUrl = `vstfs:///Git/PullRequestId/${projectId}%2F${repoId}%2F${prId}`;
  return updateWorkItem({
    config, org, project, id,
    ops: [{ op: 'add', path: '/relations/-', value: { rel: 'ArtifactLink', url: artifactUrl, attributes: { name: 'Pull Request' } } }],
  });
}

/**
 * Create a work item of the given type via POST /workitems/${type}.
 * fields is a map of { referenceName: value } turned into JSON Patch add ops.
 * parentId (optional) links the new item as a child of that work item
 * (System.LinkTypes.Hierarchy-Reverse points to the parent).
 */
async function createWorkItem({ config, org, project, type, fields, parentId }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const ops = Object.entries(fields).map(([ref, value]) => ({
    op: 'add',
    path: `/fields/${ref}`,
    value,
  }));
  if (parentId) {
    ops.push({
      op: 'add',
      path: '/relations/-',
      value: {
        rel: 'System.LinkTypes.Hierarchy-Reverse',
        url: `${base}/_apis/wit/workItems/${parentId}`,
      },
    });
  }
  return request(
    `${base}/${proj}/_apis/wit/workitems/$${encodeURIComponent(type)}?api-version=${API}`,
    {
      method: 'POST',
      pat: config.pat,
      body: ops,
      headers: { 'Content-Type': 'application/json-patch+json' },
    }
  );
}

module.exports = { markdownToHtml, getWorkItem, searchWorkItems, getComments, addComment, editComment, deleteComment, listAttachments, downloadAttachment, updateWorkItem, setState, setField, getFormLayout, getContentFields, linkPullRequest, createWorkItem };
