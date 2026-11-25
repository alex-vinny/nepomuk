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
  { name: 'raw markdown heading', md: true, re: /^\s{0,3}#{1,6}\s+\S/m,
    fix: 'write HTML (<strong>) — headings are not converted inside a field.' },
  { name: 'raw markdown bold', md: true, re: /\*\*[^*\n]+\*\*/,
    fix: 'use <strong>…</strong>.' },
  { name: 'raw markdown bullet', md: true, re: /^\s{0,3}[-*+]\s+\S/m,
    fix: 'use <ul><li>…</li></ul>.' },
  { name: 'raw markdown numbered list', md: true, re: /^\s{0,3}\d+[.)]\s+\S/m,
    fix: 'use <ol><li>…</li></ol>.' },
  { name: 'raw markdown inline code', md: true, re: /(^|[^`])`[^`\n]+`(?!`)/m,
    fix: 'use <code>…</code>.' },
  { name: 'raw markdown link', md: true, re: /\[[^\]\n]+\]\([^)\s]+\)/,
    fix: 'use <a href="…">…</a>.' },
  // Plain text with no tag at all: the form collapses the line breaks into one paragraph.
  { name: 'plain-text paragraphs', md: true, re: /^(?![\s\S]*<[a-z][^>]*>)[\s\S]*\S\n\s*\n\s*\S/i,
    fix: 'the form joins the lines — wrap each paragraph in <p>…</p>.' },
  { name: 'markdown code fence', re: /```/,
    fix: 'use <pre><code>…</code></pre>.' },
  { name: 'emoji', re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u,
    fix: 'drop it — the field is a record, not a chat message.' },
];

/** Forbidden markup found in the draft. HTML input only — see isLikelyHtml. */
function findForbiddenMarkup(text, { html = true } = {}) {
  const s = String(text || '');
  // Inside <code> the characters are literal (`**x**` written as an example), so the
  // markdown rules look at the text with code contents removed.
  const prose = s.replace(/<code>[\s\S]*?<\/code>/gi, '<code></code>');
  const hits = [];
  for (const rule of FORBIDDEN) {
    // Markdown rules only matter when the field is going to be treated as HTML.
    if (!html && rule.md) continue;
    if (rule.re.test(rule.md ? prose : s)) hits.push({ name: rule.name, fix: rule.fix });
  }
  return hits;
}

/**
 * The CURRENT value of a field is stored and returned whole — values well past
 * 8192 characters are common (measured 2026-11-25: Description, ReproSteps and
 * Custom fields above 10 000 characters on the Kanban EL board). What Azure cuts
 * is the HISTORY: /revisions/{n}, /updates (oldValue/newValue) and ?asOf= return a
 * long text value cut at exactly 8192 CHARACTERS (not bytes: an accented value cut
 * there is ~8400 bytes). So a text read from history at that exact length is
 * almost certainly incomplete, and a baseline taken from it would invent losses.
 */
const HISTORY_TEXT_LIMIT = 8192;

/** True when a text has the length Azure's revision history cuts long values to. */
function looksHistoryCut(text) {
  return typeof text === 'string' && text.length === HISTORY_TEXT_LIMIT;
}

/**
 * Full verdict for a pending field write.
 * Returns { ok, lost, forbidden, truncatedBaseline, counts }.
 *
 * `baselineFromHistory`: the live value (the default baseline) is complete, so the
 * cut check only applies to an offline baseline (--against), which may have been
 * copied out of the revision history.
 */
function verifyFieldWrite({ before, after, html = true, baselineFromHistory = false }) {
  const truncatedBaseline = baselineFromHistory && looksHistoryCut(before);
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

// ---------------------------------------------------------------------------
// Generated blocks. /vault:refina writes its block between two VISIBLE markers
// (an HTML comment would be stripped by the form), and /vault:dev in batch mode
// reads the Bug's report from between them. A hand rewrite that drops one marker,
// duplicates the block or reverses the pair breaks both: the next refina run
// stacks a second copy, and the batch reads to the end of the field.
const GENERATED_BLOCK = {
  start: '[evup-refina] inicio do bloco gerado',
  end: '[evup-refina] fim do bloco gerado',
};

function countOf(haystack, needle) {
  let n = 0;
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
}

/**
 * Problems with the generated-block markers in a draft, given the live value.
 * Returns a list of { name, fix } — empty when the draft is fine.
 */
function findGeneratedBlockProblems(before, after) {
  const a = String(before || '');
  const b = String(after || '');
  const { start, end } = GENERATED_BLOCK;
  const hits = [];
  const starts = countOf(b, start);
  const ends = countOf(b, end);
  if (starts > 1 || ends > 1) {
    hits.push({ name: 'generated block duplicated',
      fix: `the draft has ${starts} start and ${ends} end markers — keep exactly one block.` });
  } else if (starts !== ends) {
    hits.push({ name: 'generated block broken',
      fix: 'one marker is missing — keep both lines of the [evup-refina] block intact.' });
  } else if (starts === 1 && b.indexOf(end) < b.indexOf(start)) {
    hits.push({ name: 'generated block reversed', fix: 'the end marker comes before the start marker.' });
  }
  if (starts === 0 && countOf(a, start) > 0) {
    hits.push({ name: 'generated block dropped',
      fix: 'the live value has an [evup-refina] block and the draft does not — write around it, or re-run /vault:refina.' });
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Personal data. A work-item field is a document: real personal data of a
// customer or employee must not go into it (LGPD, EVUP org rule). A pattern
// cannot tell a fictitious test phone from a real one, so a hit refuses the write
// and names only the KIND and how many — never the value, so the check itself
// does not copy the data into a log.

// Things that look like the patterns below and are not personal data. Removed
// before matching.
const NOT_PERSONAL = [
  /https?:\/\/[^\s"'<>]+/g, // links (attachment and work-item urls carry long digit runs)
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // GUIDs
  /\bMigration\d+\b/g, // FluentMigrator class names
  /\b\d{8}\.\d+(-rc)?\b/g, // image/build versions (20261112.4-rc)
  /\b\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?\b/g, // ISO dates
  /\b\d{2}\/\d{2}\/\d{4}\b/g, // dd/mm/yyyy
  /[!#]\d+/g, // PR and work-item references
];

const PERSONAL = [
  { name: 'CPF', re: /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g },
  { name: 'phone number', re: /(?:\+?55[\s.-]?)?\(?\b\d{2}\)?[\s.-]?9?\d{4}[\s.-]\d{4}\b/g },
  { name: '11-digit number (CPF or mobile phone)', re: /(?<![\d.])\d{11}(?![\d.])/g },
  { name: 'e-mail address', re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
];

/** Kinds of personal-data-looking text in a draft, with counts. No values. */
function findPersonalData(text) {
  let s = stripHtml(String(text || ''));
  for (const re of NOT_PERSONAL) s = s.replace(re, ' ');
  const hits = [];
  for (const { name, re } of PERSONAL) {
    const n = (s.match(re) || []).length;
    if (n) {
      hits.push({ name, count: n });
      s = s.replace(re, ' '); // a CPF is not counted again as an 11-digit number
    }
  }
  return hits;
}

module.exports = {
  extractNumbers, extractRefs, extractLinks, extractQuoted,
  findLostFacts, findForbiddenMarkup, looksHistoryCut, verifyFieldWrite,
  findGeneratedBlockProblems, findPersonalData,
  HISTORY_TEXT_LIMIT, GENERATED_BLOCK,
};
