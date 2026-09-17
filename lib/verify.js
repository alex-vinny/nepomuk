'use strict';

// Pre-write verification for work-item field content.
//
// Two distinct failure classes:
//
//   1. FACT LOSS — a rewrite that reads better but silently drops a number, a
//      quoted string, a link or a `!id`/`#id` reference. Prose review does not
//      catch this; a machine comparison does.
//   2. FORBIDDEN MARKUP — content that renders correctly in a terminal and breaks
//      in the Azure DevOps work-item form (raw Markdown, inline `style=`, tables,
//      emoji).
//
// Everything here is pure so it can be unit-tested without a network, and so the
// same check works offline against a file (`--against`).

const { stripHtml } = require('./format');

/** Numbers that carry meaning — ids, counts, versions, money. Ignores pure punctuation. */
function extractNumbers(text) {
  return (String(text || '').match(/\d[\d.,:/-]*\d|\d/g) || [])
    .map((n) => n.replace(/[.,:/-]+$/, ''))
    .filter(Boolean);
}

/** `!123` (PR) and `#123` (work item) references — Azure's own auto-link form. */
function extractRefs(text) {
  return (String(text || '').match(/[!#]\d+/g) || []);
}

/** URLs, however they are wrapped. */
function extractLinks(text) {
  return (String(text || '').match(/https?:\/\/[^\s)"'<>]+/g) || [])
    .map((u) => u.replace(/[.,;]+$/, ''));
}

/** Double-quoted spans — usually a literal identifier, message or value. */
function extractQuoted(text) {
  return (String(text || '').match(/"[^"\n]{2,80}"|«[^»\n]{2,80}»/g) || []);
}

/**
 * Facts present in `before` and absent from `after`.
 *
 * Multiset-aware: losing one of three occurrences of a number is still a loss.
 * Both sides are stripped of HTML first, so a pure markup change is not mistaken
 * for a content change.
 */
function findLostFacts(before, after) {
  const a = stripHtml(String(before || ''));
  const b = stripHtml(String(after || ''));
  const categories = {
    numbers: extractNumbers,
    references: extractRefs,
    links: extractLinks,
    quoted: extractQuoted,
  };
  const lost = {};
  for (const [name, fn] of Object.entries(categories)) {
    const remaining = fn(b).slice();
    const missing = [];
    for (const item of fn(a)) {
      const idx = remaining.indexOf(item);
      if (idx === -1) missing.push(item);
      else remaining.splice(idx, 1);
    }
    if (missing.length) lost[name] = missing;
  }
  return lost;
}

// Markup that does not survive the work-item form. Each entry says what to do
// instead, because "rejected" without a remedy just moves the guessing.
const FORBIDDEN = [
  { name: 'inline style attribute', re: /style\s*=\s*["'][^"']*["']/i,
    fix: 'the form strips it — use <strong>/<em>, or nothing.' },
  { name: 'table', re: /<table[\s>]/i,
    fix: 'tables render inconsistently — use a <ul> list.' },
  { name: 'raw markdown heading', re: /^\s{0,3}#{1,6}\s+\S/m,
    fix: 'write HTML (<strong>) — headings are not converted inside a field.' },
  { name: 'raw markdown bold', re: /\*\*[^*\n]+\*\*/,
    fix: 'use <strong>…</strong>.' },
  { name: 'raw markdown bullet', re: /^\s{0,3}[-*+]\s+\S/m,
    fix: 'use <ul><li>…</li></ul>.' },
  { name: 'markdown code fence', re: /```/,
    fix: 'use <pre><code>…</code></pre>.' },
  { name: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    fix: 'drop it — the field is a record, not a chat message.' },
];

/** Forbidden markup found in the draft. HTML input only — see isLikelyHtml. */
function findForbiddenMarkup(text, { html = true } = {}) {
  const s = String(text || '');
  const hits = [];
  for (const rule of FORBIDDEN) {
    // Markdown rules only matter when the field is going to be treated as HTML.
    if (!html && rule.name.startsWith('raw markdown')) continue;
    if (rule.re.test(s)) hits.push({ name: rule.name, fix: rule.fix });
  }
  return hits;
}

/**
 * Azure truncates a long field value at exactly 8192 bytes and reports no error.
 * A value that comes back at exactly that length is almost certainly cut, and any
 * comparison against it is then meaningless — the check would report invented
 * losses. Flag it loudly instead of quietly producing a wrong verdict.
 */
const TRUNCATION_BYTES = 8192;

function looksTruncated(text) {
  return Buffer.byteLength(String(text || ''), 'utf8') === TRUNCATION_BYTES;
}

/**
 * Full verdict for a pending field write.
 * Returns { ok, lost, forbidden, truncatedBaseline, counts }.
 */
function verifyFieldWrite({ before, after, html = true }) {
  const truncatedBaseline = looksTruncated(before);
  const lost = truncatedBaseline ? {} : findLostFacts(before, after);
  const forbidden = findForbiddenMarkup(after, { html });
  return {
    ok: !Object.keys(lost).length && !forbidden.length && !truncatedBaseline,
    lost,
    forbidden,
    truncatedBaseline,
    counts: {
      beforeChars: String(before || '').length,
      afterChars: String(after || '').length,
      beforeBytes: Buffer.byteLength(String(before || ''), 'utf8'),
    },
  };
}

module.exports = {
  extractNumbers, extractRefs, extractLinks, extractQuoted,
  findLostFacts, findForbiddenMarkup, looksTruncated, verifyFieldWrite,
  TRUNCATION_BYTES,
};
