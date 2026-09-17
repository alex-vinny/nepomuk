'use strict';

const { request, requestBinary, buildBase } = require('./api');
const { findForbiddenMarkup } = require('./verify');

const API = '7.1';

/**
 * Minimal markdown-to-HTML converter for work-item content.
 * Azure DevOps WI comments and long-form fields render HTML, not Markdown. Feeding
 * raw markdown results in visible tags and collapsed line breaks. This covers the
 * common constructs: headings, bold, inline code, code blocks, bulleted and
 * numbered lists, GFM pipe tables, block quotes, paragraphs and line breaks.
 *
 * Two output profiles, because the two surfaces sanitize differently:
 *
 *   - 'comment' (default) — WI discussion. Keeps <table> with the inline styles that
 *     make it readable (Azure renders comment HTML without any stylesheet of ours).
 *   - 'field' — long-form form fields (System.Description, ReproSteps, Custom.*).
 *     The form strips `style=` and renders tables inconsistently, so this profile
 *     emits NO style attributes and turns every table into a <ul>.
 *
 * Text that is already HTML is passed through untouched.
 */
function markdownToHtml(md, { profile = 'comment' } = {}) {
  const field = profile === 'field';
  const BOLD = field ? 'b' : 'strong';
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
  // <pre><code> built here: escaped a second time, the block renders as a literal
  // "&lt;pre&gt;...". Restored verbatim at the very end.
  // The opening-fence info string (e.g. ```ts) is dropped.
  const codeBlocks = [];
  text = text.replace(/```[^\n]*\n([\s\S]*?)```/g, (match, code) => {
    const escaped = escapeHtml(code.replace(/\n+$/g, ''));
    codeBlocks.push(`<pre><code>${escaped}</code></pre>`);
    return `\n\n[[[CODEBLOCK${codeBlocks.length - 1}]]]\n\n`;
  });

  // Escape HTML in the remaining text before further transformations.
  text = escapeHtml(text);

  // Headings (h2-h4; a work-item body rarely needs deeper nesting).
  text = text.replace(/^## (.*)$/gm, '<h2>$1</h2>');
  text = text.replace(/^### (.*)$/gm, '<h3>$1</h3>');
  text = text.replace(/^#### (.*)$/gm, '<h4>$1</h4>');

  // Bold. The span may be hard-wrapped, so it has to survive a single newline: a body
  // wrapped at ~100 columns splits most emphasis across two lines, and a newline-blind
  // pattern leaves the asterisks visible. It must NOT cross a blank line, or an
  // unmatched `**` would swallow the rest of the document.
  text = text.replace(/\*\*([^*\n]+(?:\n(?!\s*\n)[^*\n]+)*)\*\*/g, `<${BOLD}>$1</${BOLD}>`);

  // Inline code (after escaping, backticks are still literal).
  text = text.replace(/`(.+?)`/g, '<code>$1</code>');

  // Horizontal rule.
  text = text.replace(/^---$/gm, '<hr/>');

  // A pipe inside inline code is content, not a table-cell separator. Mask it for the
  // block scan below and restore it at the very end.
  text = text.replace(/<code>([\s\S]*?)<\/code>/g, (m, code) => `<code>${code.replace(/\|/g, PIPE_MARKER)}</code>`);

  // Block scan: groups consecutive lines into tables, lists and quotes. Tables and
  // ordered lists live here because a line-at-a-time regex cannot see the delimiter
  // row (|---|---|) that turns the preceding line into a header.
  const lines = text.split('\n');
  const out = [];
  let listType = null;    // 'ul' | 'ol' while inside a list
  let quoting = false;
  let pendingItem = null; // text of the <li> still being collected (see the loop)
  let heldBlanks = 0;     // blank lines seen inside a list, replayed once it closes

  const flushItem = () => {
    if (pendingItem !== null) { out.push(`<li>${pendingItem}</li>`); pendingItem = null; }
  };
  const closeList = () => {
    flushItem();
    if (listType) { out.push(`</${listType}>`); listType = null; }
    while (heldBlanks > 0) { out.push(''); heldBlanks--; }
  };
  const closeQuote = () => { if (quoting) { out.push('</blockquote>'); quoting = false; } };
  const openList = (type) => {
    if (listType !== type) { closeList(); out.push(`<${type}>`); listType = type; }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // GFM pipe table — a header row immediately followed by a delimiter row.
    if (isTableRow(line) && isTableDelimiter(lines[i + 1])) {
      closeList();
      closeQuote();
      const header = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(cellAlign);
      const body = [];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) {
        body.push(splitTableRow(lines[j]));
        j++;
      }
      out.push(field ? renderTableAsList(header, body, BOLD) : renderTable(header, aligns, body));
      i = j - 1;
      continue;
    }

    // Inside a list, two kinds of line belong to the item that is still open:
    //   - an indented continuation, because the item is hard-wrapped;
    //   - a blank line, because a loose list is still one list.
    // Treating either as "the list ended" tears items in half: the tail of the
    // sentence lands after </ol> as loose text, and any **bold** or `code` span
    // straddling the wrap comes out broken.
    if (listType) {
      if (pendingItem !== null && /^\s+\S/.test(line)) {
        pendingItem += ' ' + line.trim();
        continue;
      }
      if (line.trim() === '') { heldBlanks++; continue; }
    }

    const bullet = line.match(/^- (.*)$/);
    const numbered = line.match(/^\d+\. (.*)$/);
    const quoted = line.match(/^&gt; ?(.*)$/); // '>' is already escaped at this point

    if (bullet || numbered) {
      closeQuote();
      flushItem();
      heldBlanks = 0; // a blank line between items separates nothing in the output
      openList(bullet ? 'ul' : 'ol');
      pendingItem = (bullet || numbered)[1];
      continue;
    }

    closeList();

    if (quoted) {
      if (!quoting) { out.push('<blockquote>'); quoting = true; }
      out.push(`<p>${quoted[1]}</p>`); // wrapped so the <br/> pass leaves the quote alone
      continue;
    }

    closeQuote();
    out.push(line);
  }
  closeList();
  closeQuote();
  text = out.join('\n');

  // Paragraphs: blank-line-separated blocks that are not already block elements.
  const blocks = text.split(/\n{2,}/).map((block) => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (/^(<h[234]|<pre|<ul|<ol|<table|<blockquote|<hr)/i.test(trimmed)) return trimmed;
    return `<p>${trimmed}</p>`;
  });

  text = blocks.filter(Boolean).join('\n');

  // Remaining single newlines become <br/> inside paragraphs — but only for comments.
  // A field body is authored hard-wrapped at ~100 columns and rendered in a narrow form
  // panel: honouring every source newline gives ragged text that breaks mid-sentence at
  // a width the panel does not have. Leaving the newline as plain whitespace lets the
  // paragraph reflow, which is what a markdown renderer does with a single newline.
  if (!field) text = text.replace(/([^>])\n/g, '$1<br/>\n');

  // Restore fenced code blocks, unwrapping any <p> the paragraph pass wrapped the marker in.
  text = text.replace(/<p>\[\[\[CODEBLOCK(\d+)\]\]\]<\/p>/g, (m, i) => codeBlocks[Number(i)]);
  text = text.replace(/\[\[\[CODEBLOCK(\d+)\]\]\]/g, (m, i) => codeBlocks[Number(i)]);

  // Restore pipes masked before the block scan.
  text = text.split(PIPE_MARKER).join('|');

  return text;
}

/** Field profile shorthand — see markdownToHtml. */
function markdownToFieldHtml(md) {
  return markdownToHtml(md, { profile: 'field' });
}

/**
 * Refuse a long-form field write whose body will not render in the work-item form.
 *
 * This lives in the lib, not in the CLI, on purpose. A one-off script that calls
 * createWorkItem() or setField() directly never touches the CLI, so every
 * CLI-side guard (`--verify`) is bypassed and raw markdown lands in a long-form
 * field with asterisks and pipe rows visible on the board. A guard that only
 * exists one layer above the API is a guard that scripts skip.
 *
 * Only multi-line string values are inspected — a one-line `set-field Custom.Status
 * "Open"` is never a formatting question. Callers that really mean it pass
 * { force: true }.
 */
function assertRenderableFieldValue(field, value, { force = false } = {}) {
  if (force) return;
  if (typeof value !== 'string' || !value.includes('\n')) return;
  const hits = findForbiddenMarkup(value);
  if (!hits.length) return;
  const detail = hits.map((h) => `  - ${h.name}: ${h.fix}`).join('\n');
  throw new Error(
    `Refusing to write "${field}": the body carries markup the work-item form will not render.\n${detail}\n` +
    'Convert it first — markdownToFieldHtml(md) in lib/workitem.js, or `wi set-field … --from-markdown`.\n' +
    'Pass --force (CLI) or { force: true } (lib) if you have decided the body is right as-is.'
  );
}

const PIPE_MARKER = '[[[PIPE]]]';
const CELL_STYLE = 'border:1px solid #ccc;padding:6px';

// A table line starts with '|' — requiring the leading pipe keeps prose that merely
// contains one from being read as a row. Outer-pipe-less GFM tables are not supported.
function isTableRow(line) {
  return typeof line === 'string' && /^\s*\|.*\|\s*$/.test(line);
}

// The |---|:--:|---:| row under the header; also carries per-column alignment.
function isTableDelimiter(line) {
  if (!isTableRow(line)) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)          // a cell may escape a literal pipe as \|
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

function cellAlign(delimiter) {
  const left = delimiter.startsWith(':');
  const right = delimiter.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

// Inline styles, not classes: Azure DevOps renders comment/field HTML without any
// stylesheet of ours, so an unstyled <table> comes out as borderless run-together text.
function renderTable(header, aligns, rows) {
  const cell = (tag, content, i) =>
    `<${tag} style="${CELL_STYLE};text-align:${aligns[i] || 'left'}">${content}</${tag}>`;

  const head = `<tr style="background-color:#f5f5f5">${header.map((c, i) => cell('th', c, i)).join('')}</tr>`;
  const body = rows.map((r) => `<tr>${r.map((c, i) => cell('td', c, i)).join('')}</tr>`).join('\n');

  // No blank line may appear inside the block: the paragraph pass splits on \n{2,}
  // and would tear a header-only table in half.
  return [
    '<table style="border-collapse:collapse;width:100%">',
    '<thead>',
    head,
    '</thead>',
    '<tbody>',
    body,
    '</tbody>',
    '</table>',
  ].filter((part) => part !== '').join('\n');
}

// Field profile: a table becomes a <ul>, one <li> per row. The form strips the inline
// styles that make a <table> readable, so a styled table degrades to run-together text —
// a list degrades to a list. Nothing is dropped: the first cell becomes the row's label
// and every other cell is emitted as "<column header>: <value>" on its own line.
//
// Callers get no say in the shape because the shape is the point: a table that cannot
// survive the form is better authored as the list it degrades into.
function renderTableAsList(header, rows, boldTag = 'b') {
  const b = (s) => `<${boldTag}>${s}</${boldTag}>`;
  const label = (cell) => (header[0] ? `${header[0]}: ${cell}` : cell);

  // Header-only table: no rows to hang the columns off, so keep the header as a line.
  if (!rows.length) return `<p>${b(header.filter(Boolean).join(' · '))}</p>`;

  const items = rows.map((row) => {
    const lines = [b(label(row[0] || ''))];
    for (let i = 1; i < Math.max(row.length, header.length); i++) {
      const value = (row[i] || '').trim();
      if (!value) continue;
      lines.push(header[i] ? `${b(header[i])}: ${value}` : value);
    }
    return `<li>${lines.join('<br/>')}</li>`;
  });

  return ['<ul>', ...items, '</ul>'].join('\n');
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

// Azure DevOps Services caps a work item attachment at 60 MB and an item at 100
// attachments; neither is raisable. (The 130 MB in the REST reference is the
// chunked-upload threshold, not the cap — it is only reachable on an on-prem
// Server whose max size was raised, where the default is 4 MB.) Refusing here with
// the real number beats spending the upload on a rejection that explains nothing.
const ATTACHMENT_MAX_BYTES = 60 * 1024 * 1024;
const ATTACHMENTS_PER_ITEM = 100;

/**
 * Pure: the upload URL for an attachment blob.
 *
 * `fileName` is what the work item will show, so it has to survive encoding —
 * spaces, accents and "#" all appear in real report names and all break a naive
 * concatenation. The project segment is optional: the org-level endpoint accepts
 * the upload, which lets a caller attach without knowing the project.
 */
function attachmentUploadUrl({ base, project, fileName, apiVersion = API }) {
  const projSeg = project ? `/${encodeURIComponent(project)}` : '';
  return `${base}${projSeg}/_apis/wit/attachments`
    + `?fileName=${encodeURIComponent(fileName)}`
    + `&api-version=${apiVersion}`;
}

/**
 * Pure: the JSON-Patch relation that links an uploaded blob to a work item.
 * Without this second step the blob exists but no work item references it, and
 * Azure garbage-collects it — the upload alone is not an attachment.
 */
function attachmentRelation({ url: blobUrl, name, comment }) {
  const attributes = { name };
  if (comment) attributes.comment = comment;
  return { rel: 'AttachedFile', url: blobUrl, attributes };
}

/**
 * Pure: reject an upload that cannot work, before spending the bytes.
 * Returns { ok } or { ok: false, reason, message }.
 */
function checkAttachment({ fileName, size, existingNames = [], allowDuplicate = false }) {
  if (!fileName) {
    return { ok: false, reason: 'no-name', message: 'An attachment needs a file name.' };
  }
  // Explicit, because both numeric checks below pass on undefined: `undefined === 0`
  // and `undefined > MAX` are each false, so a missing size would sail through the
  // one guard that exists to stop a bad upload.
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return {
      ok: false,
      reason: 'no-size',
      message: `Cannot check "${fileName}": size is ${JSON.stringify(size)}, not a byte count.`,
    };
  }
  if (size === 0) {
    return {
      ok: false,
      reason: 'empty',
      message: `"${fileName}" is 0 bytes. Azure stores it and the work item shows an attachment that downloads as nothing.`,
    };
  }
  if (size > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too-large',
      message: `"${fileName}" is ${(size / 1024 / 1024).toFixed(1)} MB; Azure DevOps Services rejects a work `
        + `item attachment over ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB, and the limit is not raisable. `
        + 'Compress or split the file.',
    };
  }
  if (existingNames.length >= ATTACHMENTS_PER_ITEM) {
    return {
      ok: false,
      reason: 'item-full',
      message: `This work item already has ${existingNames.length} attachments; Azure allows `
        + `${ATTACHMENTS_PER_ITEM}. Remove one before attaching another.`,
    };
  }
  // Azure accepts a duplicate name without complaint, and then `wi download <name>`
  // silently resolves to whichever copy comes first in the relations array.
  if (!allowDuplicate && existingNames.includes(fileName)) {
    return {
      ok: false,
      reason: 'duplicate',
      message: `This work item already has an attachment named "${fileName}". Azure would keep both, `
        + 'and `wi download <name>` could not tell them apart. Rename with --name, or pass --allow-duplicate.',
    };
  }
  return { ok: true };
}

/**
 * Upload a file's bytes and return the blob { id, url }.
 * The blob is not attached to anything yet — see attachFile.
 */
// NOTE: request() retries POSTs on 429/5xx/409 and on transient network errors, and
// this POST is NOT idempotent — each replay mints a new blob. That is bounded: only
// the blob returned by the last attempt gets linked, and the rest are unreferenced
// and collected. The cost is re-sending the body, which matters on a large file over
// a flaky link; set AZURE_MAX_RETRIES=0 if that is the situation.
async function uploadAttachment({ config, org, project, fileName, buffer }) {
  const target = attachmentUploadUrl({ base: buildBase(config, org), project, fileName });
  return request(target, {
    method: 'POST',
    pat: config.pat,
    body: buffer,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
}

/**
 * Attach a file to a work item: upload the bytes, then link the blob.
 * Returns { id, url, name, relations } where relations is the updated count.
 */
async function attachFile({ config, org, project, id, fileName, buffer, comment }) {
  // The intrinsic guards run here, not only in the CLI, so a script calling the
  // library gets them too. The duplicate-name and item-full checks need the item's
  // current relations, so they stay with the caller that already fetched them.
  //
  // The type check is part of the guard, not paranoia: a string body takes the JSON
  // branch in api.js and lands as a quoted, escape-mangled attachment, and
  // `'ação'.length` is characters, so the size guard would not even catch it.
  if (!Buffer.isBuffer(buffer)) {
    throw new Error(`attachFile needs a Buffer, got ${buffer === null ? 'null' : typeof buffer}. `
      + 'Read the file with fs.readFileSync(path) — with no encoding argument.');
  }
  const check = checkAttachment({ fileName, size: buffer.length });
  if (!check.ok) throw new Error(check.message);

  const blob = await uploadAttachment({ config, org, project, fileName, buffer });

  let updated;
  try {
    updated = await updateWorkItem({
      config,
      org,
      project,
      id,
      ops: [{ op: 'add', path: '/relations/-', value: attachmentRelation({ url: blob.url, name: fileName, comment }) }],
    });
  } catch (err) {
    // The bytes are already in Azure but nothing points at them. Say so: otherwise
    // the caller reads a work-item error and assumes the upload never happened.
    // Retrying is safe — the item has no relation yet, and the orphan blob is
    // unreferenced, so Azure collects it.
    err.message = `The file uploaded but linking it to #${id} failed, so the work item has NO `
      + `attachment. The orphan blob is ${blob.url} — unreferenced, so Azure collects it. `
      + `Retrying is safe.\n${err.message}`;
    throw err;
  }

  // The PATCH response carries relations in practice, but it is requested without
  // $expand, so treat a missing array as "unknown" rather than reporting 0 links on
  // a link that just succeeded.
  const relations = Array.isArray(updated.relations) ? updated.relations.length : null;
  return { id: blob.id, url: blob.url, name: fileName, relations };
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
 * Normalize a work item's relations into { rel, kind, target, ... } rows.
 * ArtifactLink URLs are vstfs:/// URIs whose id is ONE percent-encoded
 * segment (project%2Frepo%2Fid), so the decode must happen before the split —
 * otherwise every PR/commit link comes back as an opaque string.
 */
function normalizeRelation(r) {
  const rel = r.rel || '';
  const name = (r.attributes && r.attributes.name) || '';
  const comment = (r.attributes && r.attributes.comment) || '';

  if (rel === 'AttachedFile') return { rel, kind: 'attachment', target: name || r.url, name: comment };
  if (rel === 'Hyperlink') return { rel, kind: 'hyperlink', target: r.url, name: comment };

  if (rel === 'ArtifactLink') {
    const m = String(r.url || '').match(/^vstfs:\/\/\/([^/]+)\/([^/]+)\/(.+)$/);
    if (m) {
      const tool = m[1];
      const type = m[2];
      const parts = decodeURIComponent(m[3]).split('/');
      if (tool === 'Git' && type === 'PullRequestId') {
        return { rel, kind: 'pr', target: parts[2], repoId: parts[1], projectId: parts[0], name };
      }
      if (tool === 'Git' && type === 'Commit') {
        return { rel, kind: 'commit', target: parts[2], repoId: parts[1], projectId: parts[0], name };
      }
      if (tool === 'Git' && type === 'Ref') {
        // branch refs carry a GB prefix on the branch name; the name itself may contain slashes
        return { rel, kind: 'branch', target: parts.slice(2).join('/').replace(/^GB/, ''), repoId: parts[1], projectId: parts[0], name };
      }
      if (tool === 'Build' && type === 'Build') return { rel, kind: 'build', target: parts[0], name };
      return { rel, kind: 'artifact', target: decodeURIComponent(m[3]), name: name || tool + '/' + type };
    }
    return { rel, kind: 'artifact', target: r.url, name };
  }

  const kinds = {
    'System.LinkTypes.Hierarchy-Forward': 'child',
    'System.LinkTypes.Hierarchy-Reverse': 'parent',
    'System.LinkTypes.Related': 'related',
    'System.LinkTypes.Duplicate-Forward': 'duplicate',
    'System.LinkTypes.Duplicate-Reverse': 'duplicate-of',
    'System.LinkTypes.Dependency-Forward': 'successor',
    'System.LinkTypes.Dependency-Reverse': 'predecessor',
  };
  const wiMatch = String(r.url || '').match(/\/workItems\/(\d+)$/i);
  return { rel, kind: kinds[rel] || rel || 'unknown', target: wiMatch ? wiMatch[1] : r.url, name };
}

function normalizeRelations(workItem) {
  return ((workItem && workItem.relations) || []).map(normalizeRelation);
}

/**
 * Batch-fetch relations for many ids (200 per call — the workitemsbatch page
 * limit). errorPolicy 'omit' skips deleted/foreign ids instead of failing the
 * whole chunk. Returns raw work item objects ({ id, relations, ... }).
 */
async function getWorkItemsRelationsBatch({ config, org, project, ids }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const out = [];
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const batch = await request(
      `${base}/${proj}/_apis/wit/workitemsbatch?api-version=${API}`,
      { method: 'POST', pat: config.pat, body: { ids: chunk, $expand: 'relations', errorPolicy: 'omit' } }
    );
    out.push(...(batch.value || []));
  }
  return out;
}

/**
 * Update work item fields via PATCH /workItems/{id}.
 * ops is an array of { op, path, value } JSON Patch operations.
 */
/**
 * Ask Azure whether an update WOULD be accepted, without writing it.
 *
 * This exists because a state transition can be gated on a field whose own
 * definition reports `alwaysRequired: false` — the requirement is a transition
 * rule, not a field flag, so inspecting the field metadata does not predict the
 * failure. `validateOnly=true` runs the real rule engine and changes nothing.
 */
async function validateUpdate({ config, org, project, id, ops }) {
  const base = buildBase(config, org);
  const projSeg = project ? `/${encodeURIComponent(project)}` : '';
  return request(
    `${base}${projSeg}/_apis/wit/workItems/${id}?validateOnly=true&api-version=${API}`,
    {
      method: 'PATCH',
      pat: config.pat,
      body: ops,
      headers: { 'Content-Type': 'application/json-patch+json' },
    }
  );
}

/** One field's definition for a work item type, with its picklist values. */
async function getFieldDefinition({ config, org, project, type, field }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  return request(
    `${base}/${proj}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/fields/`
    + `${encodeURIComponent(field)}?$expand=allowedValues&api-version=${API}`,
    { pat: config.pat }
  );
}

/**
 * Pull the offending field reference names out of an Azure rule-validation error.
 * Pure — hand it the thrown error's message, which carries the raw response body.
 *
 * Azure reports these as TF401320 with the field names embedded in prose, so this
 * scrapes rather than parses a schema. Returns [] when nothing recognisable is
 * found; the caller must still show the original error.
 */
function parseRuleValidationErrors(message) {
  const text = String(message || '');
  const refs = new Set();
  // Explicit reference names: Custom.Foo, Microsoft.VSTS.X.Y, System.Z
  // Each dotted segment is matched separately so a sentence-ending period is not
  // swallowed into the reference name ("...f6ce2. Error code" -> "...f6ce2", not "...f6ce2.").
  for (const m of text.matchAll(/\b((?:Custom|System|Microsoft\.VSTS)(?:\.[A-Za-z0-9_-]+)+)/g)) {
    refs.add(m[1]);
  }
  // Quoted display labels, e.g. ... field 'Product Area' is required ...
  // Azure returns these messages in the org's language, so the trailing cue is matched
  // in more than one locale ('não pode' is the pt-BR wording of "cannot be").
  const labels = [];
  for (const m of text.matchAll(/['"]([^'"]{2,60})['"]\s*(?:field|is required|não pode)/gi)) labels.push(m[1]);
  for (const m of text.matchAll(/field\s+['"]([^'"]{2,60})['"]/gi)) labels.push(m[1]);
  return { referenceNames: [...refs], labels: [...new Set(labels)] };
}

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
 * Set a work item's state (System.State), e.g. 'In Progress', 'Done'.
 */
async function setState({ config, org, project, id, state }) {
  return updateWorkItem({ config, org, project, id, ops: [{ op: 'add', path: '/fields/System.State', value: state }] });
}

/**
 * Set an arbitrary field by its reference name (e.g. 'Custom.RootCause',
 * 'Microsoft.VSTS.TCM.ReproSteps'). HTML/markdown fields take their raw string.
 */
async function setField({ config, org, project, id, field, value, force = false }) {
  assertRenderableFieldValue(field, value, { force });
  return updateWorkItem({ config, org, project, id, ops: [{ op: 'add', path: `/fields/${field}`, value }] });
}

/**
 * Map the work item FORM layout (label -> field reference name) for a given
 * work item type. This is how you discover that a UI section like "Root Cause"
 * is backed by, say, Custom.RootCause — empty fields never show up in getWorkItem,
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
 * (e.g. "Root Cause" -> Custom.RootCause), as opposed to a plain comment.
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
/**
 * Classify a field value as 'empty', 'placeholder' or 'filled'.
 *
 * The middle case is the one that matters: a field holding `.` or `-` is returned
 * by the API, counts as populated everywhere, and reads as answered on the board —
 * but says nothing. Three such fields passed an audit as filled. Treat them as
 * unanswered and say so, rather than silently agreeing with the board.
 */
function classifyFieldValue(value) {
  if (value == null) return 'empty';
  const text = String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return 'empty';
  // Punctuation-only, or one of the conventional "nothing to say" tokens. The list spans
  // locales on purpose: whoever typed the placeholder did it in the board's language.
  if (/^[.\-–—_*·•\s]+$/.test(text)) return 'placeholder';
  if (/^(n\/?a|nao|não|none|nenhum[ao]?|sem|tbd|todo|xx+|\?+)$/i.test(text)) return 'placeholder';
  return 'filled';
}

/**
 * Form layout ⋈ current values, so "which fields are blank?" stops being a manual
 * cross-check. The API omits empty fields entirely, which is why `wi fields` alone
 * cannot answer it.
 *
 * Options widen the default narrow view: `onlyCustom: false` includes System./
 * Microsoft. fields, `longFormOnly: false` includes pickers, dates and the rest.
 */
async function getContentFields({ config, org, project, id, type, onlyCustom = true, longFormOnly = true }) {
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
    const seen = new Set();
    const out = [];
    for (const c of controls) {
      const ref = c.referenceName || '';
      if (!ref) continue;
      if (onlyCustom && !ref.startsWith('Custom.')) continue;
      if (longFormOnly && !LONG_FORM.has(c.controlType)) continue;
      if (seen.has(ref)) continue;
      seen.add(ref);
      const state = classifyFieldValue(values[ref]);
      out.push({
        label: c.label || '',
        referenceName: ref,
        controlType: c.controlType,
        state,
        // Kept for callers written against the old shape: a placeholder is not
        // an answer, so it counts as empty here.
        empty: state !== 'filled',
      });
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
async function createWorkItem({ config, org, project, type, fields, parentId, force = false }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  for (const [ref, value] of Object.entries(fields)) assertRenderableFieldValue(ref, value, { force });
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

// ── change history ───────────────────────────────────────────────────────────
// The board's own record of how an item moved. This is what makes cycle-time and
// "when did this reach QA" answerable — the work item itself only carries its
// CURRENT state, so any question about the path it took has to come from here.

// Azure stamps the newest revision with a year-9999 revisedDate meaning "still
// current". Treated as absent, otherwise every open item looks 8000 years old.
const OPEN_ENDED_DATE = /^9999-/;

/**
 * GET /workItems/{id}/updates — the revision feed.
 *
 * Each entry lists only the fields that revision touched, as { oldValue, newValue }.
 * Paginated: a long-lived work item easily passes 200 revisions.
 */
async function getWorkItemUpdates({ config, org, project, id, pageSize = 200 }) {
  const base = buildBase(config, org);
  const proj = encodeURIComponent(project);
  const out = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await request(
      `${base}/${proj}/_apis/wit/workItems/${id}/updates?$top=${pageSize}&$skip=${skip}&api-version=${API}`,
      { pat: config.pat }
    );
    const rows = (page && page.value) || [];
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

/**
 * Reduce an update feed to the transitions of ONE field. Pure.
 *
 * Two filters matter for counting: a revision that does not touch the field is
 * skipped, and so is one where oldValue === newValue — Azure records those when a
 * save re-writes the same value, and counting them inflates any transition total.
 *
 * Timestamp: System.ChangedDate is the authoritative edit time, but rule-engine and
 * bulk edits sometimes omit it, so revisedDate is the fallback.
 */
function extractFieldChanges(updates, fieldRef = 'System.State') {
  const out = [];
  for (const u of updates || []) {
    const f = (u && u.fields) || {};
    const change = f[fieldRef];
    if (!change) continue;
    const from = change.oldValue === undefined || change.oldValue === null ? '' : change.oldValue;
    const to = change.newValue === undefined || change.newValue === null ? '' : change.newValue;
    if (from === to) continue;
    let at = (f['System.ChangedDate'] && f['System.ChangedDate'].newValue) || u.revisedDate || null;
    if (at && OPEN_ENDED_DATE.test(String(at))) at = null;
    out.push({
      rev: u.rev,
      at,
      from,
      to,
      by: (u.revisedBy && u.revisedBy.displayName) || '',
    });
  }
  return out;
}

/**
 * Turn transitions into the spans of time the field held each value. Pure.
 *
 * The final span is still open, so it is measured against `now` and flagged
 * `open: true`. `now` is injected rather than read from the clock, which is what
 * lets this be unit-tested and what makes a re-run of an old measurement
 * reproduce the same numbers.
 */
function timeInState(changes, now) {
  const end = now instanceof Date ? now : new Date(now);
  const dated = (changes || []).filter((c) => c.at);
  return dated.map((c, i) => {
    const next = dated[i + 1] || null;
    const from = new Date(c.at);
    const to = next ? new Date(next.at) : end;
    return {
      state: c.to,
      enteredAt: c.at,
      leftAt: next ? next.at : null,
      open: !next,
      days: +((to - from) / 86400000).toFixed(2),
    };
  });
}

/** When the field FIRST took this value (null if it never did). Pure. */
function firstEntry(changes, value) {
  const hit = (changes || []).find((c) => c.to === value);
  return hit ? hit.at : null;
}

/** When the field LAST took this value — the one that matters after a bounce-back. Pure. */
function lastEntry(changes, value) {
  const hits = (changes || []).filter((c) => c.to === value);
  return hits.length ? hits[hits.length - 1].at : null;
}

module.exports = { classifyFieldValue, validateUpdate, getFieldDefinition, parseRuleValidationErrors, markdownToHtml, markdownToFieldHtml, assertRenderableFieldValue, getWorkItem, searchWorkItems, getComments, addComment, editComment, deleteComment, listAttachments, downloadAttachment, attachmentUploadUrl, attachmentRelation, checkAttachment, uploadAttachment, attachFile, ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_ITEM, updateWorkItem, setState, setField, getFormLayout, getContentFields, linkPullRequest, createWorkItem, getWorkItemUpdates, extractFieldChanges, timeInState, firstEntry, lastEntry, normalizeRelations, getWorkItemsRelationsBatch };
