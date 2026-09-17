'use strict';

// Unit tests for azure-connector's pure helpers. No network, no PAT.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { parseArgs, normalizeAzureRepoPath } = require('../index.js');
const { parseUrl } = require('../lib/config');
const { buildThreadBody } = require('../lib/pr');
const { normalizeBranchRef, buildRerunPayload, summarizeBuild } = require('../lib/build');
const { markdownToHtml, markdownToFieldHtml, assertRenderableFieldValue } = require('../lib/workitem');

// ── parseArgs ────────────────────────────────────────────────────────────────
test('parseArgs: separates positionals, valued flags, and boolean flags', () => {
  const { args, flags } = parseArgs(['pr', 'comment', 'url', '--body-file', 'x.md', '--line', '42', '--dry-run']);
  assert.deepStrictEqual(args, ['pr', 'comment', 'url']);
  assert.strictEqual(flags['body-file'], 'x.md');
  assert.strictEqual(flags.line, '42');
  assert.strictEqual(flags['dry-run'], true); // trailing boolean flag
});

test('parseArgs: a flag followed by another flag is boolean', () => {
  const { flags } = parseArgs(['--json', '--top', '5']);
  assert.strictEqual(flags.json, true);
  assert.strictEqual(flags.top, '5');
});

// ── normalizeAzureRepoPath (MSYS de-mangling) ─────────────────────────────────
test('normalizeAzureRepoPath: clean repo path passes through', () => {
  assert.strictEqual(normalizeAzureRepoPath('/SCH/Path/File.cs'), '/SCH/Path/File.cs');
});

test('normalizeAzureRepoPath: slash-less path gets a leading slash', () => {
  assert.strictEqual(normalizeAzureRepoPath('SCH/File.cs'), '/SCH/File.cs');
});

test('normalizeAzureRepoPath: backslashes become forward slashes', () => {
  assert.strictEqual(normalizeAzureRepoPath('\\SCH\\File.cs'), '/SCH/File.cs');
});

test('normalizeAzureRepoPath: strips the MSYS-prepended Git root', () => {
  const saved = process.env.EXEPATH;
  process.env.EXEPATH = 'C:/Program Files/Git/usr/bin';
  try {
    assert.strictEqual(
      normalizeAzureRepoPath('C:/Program Files/Git/SCH/File.cs'),
      '/SCH/File.cs'
    );
  } finally {
    if (saved === undefined) delete process.env.EXEPATH; else process.env.EXEPATH = saved;
  }
});

test('normalizeAzureRepoPath: null/true short-circuit', () => {
  assert.strictEqual(normalizeAzureRepoPath(null), null);
  assert.strictEqual(normalizeAzureRepoPath(true), null);
});

// ── parseUrl ──────────────────────────────────────────────────────────────────
test('parseUrl: pull request', () => {
  const p = parseUrl('https://dev.azure.com/contoso/Fabrikam/_git/Fabrikam-SVC-CRM/pullrequest/21371');
  assert.strictEqual(p.type, 'pr');
  assert.strictEqual(p.project, 'Fabrikam');
  assert.strictEqual(p.repo, 'Fabrikam-SVC-CRM');
  assert.strictEqual(p.prId, 21371);
});

test('parseUrl: work item', () => {
  const p = parseUrl('https://dev.azure.com/contoso/Fabrikam/_workitems/edit/65239');
  assert.strictEqual(p.type, 'workitem');
  assert.strictEqual(p.id, 65239);
});

test('parseUrl: repo url and project with encoded spaces', () => {
  const p = parseUrl('https://dev.azure.com/contoso/Contoso%20Labs/_git/Web');
  assert.strictEqual(p.type, 'repo');
  assert.strictEqual(p.project, 'Contoso Labs');
  assert.strictEqual(p.repo, 'Web');
});

test('parseUrl: garbage returns null', () => {
  assert.strictEqual(parseUrl('not a url'), null);
});

// ── buildThreadBody (inline anchor threadContext) ────────────────────────────
test('buildThreadBody: PR-level comment has no threadContext', () => {
  const t = buildThreadBody({ content: 'hi' });
  assert.strictEqual(t.threadContext, undefined);
  assert.strictEqual(t.comments[0].content, 'hi');
});

test('buildThreadBody: right side anchors on rightFileStart/End', () => {
  const t = buildThreadBody({ content: 'x', filePath: '/a.cs', lineNumber: 42, side: 'right' });
  assert.strictEqual(t.threadContext.filePath, '/a.cs');
  assert.deepStrictEqual(t.threadContext.rightFileStart, { line: 42, offset: 1 });
  assert.deepStrictEqual(t.threadContext.rightFileEnd, { line: 42, offset: 1 });
  assert.strictEqual(t.threadContext.leftFileStart, undefined);
});

test('buildThreadBody: left side (deleted line) anchors on leftFileStart/End', () => {
  const t = buildThreadBody({ content: 'x', filePath: '/a.cs', lineNumber: 7, side: 'left' });
  assert.deepStrictEqual(t.threadContext.leftFileStart, { line: 7, offset: 1 });
  assert.strictEqual(t.threadContext.rightFileStart, undefined);
});

test('buildThreadBody: file-level comment (no line) keeps filePath, no anchors', () => {
  const t = buildThreadBody({ content: 'x', filePath: '/a.cs' });
  assert.strictEqual(t.threadContext.filePath, '/a.cs');
  assert.strictEqual(t.threadContext.rightFileStart, undefined);
});

// ── build: normalizeBranchRef ────────────────────────────────────────────────
test('normalizeBranchRef: short branch becomes a heads ref', () => {
  assert.strictEqual(normalizeBranchRef('features/1234-new-widget'), 'refs/heads/features/1234-new-widget');
  assert.strictEqual(normalizeBranchRef('main'), 'refs/heads/main');
});

test('normalizeBranchRef: an existing ref passes through unchanged', () => {
  assert.strictEqual(normalizeBranchRef('refs/heads/main'), 'refs/heads/main');
  assert.strictEqual(normalizeBranchRef('refs/tags/v1'), 'refs/tags/v1');
});

test('normalizeBranchRef: no branch (undefined/true) yields undefined', () => {
  assert.strictEqual(normalizeBranchRef(undefined), undefined);
  assert.strictEqual(normalizeBranchRef(''), undefined);
  assert.strictEqual(normalizeBranchRef(true), undefined);
});

// ── build: buildRerunPayload (generic replay) ────────────────────────────────
test('buildRerunPayload: replays definition, branch, parameters, templateParameters', () => {
  const src = {
    id: 40587,
    definition: { id: 369, name: 'APP-UI-WEB' },
    sourceBranch: 'refs/heads/features/1234-new-widget',
    parameters: '{"clientName":"acme-retail","platformName":"android"}',
    templateParameters: { groupName: 'acme-app' },
  };
  const p = buildRerunPayload(src);
  assert.deepStrictEqual(p, {
    definition: { id: 369 },
    sourceBranch: 'refs/heads/features/1234-new-widget',
    reason: 'manual',
    parameters: '{"clientName":"acme-retail","platformName":"android"}',
    templateParameters: { groupName: 'acme-app' },
  });
});

test('buildRerunPayload: pipeline WITHOUT variables omits parameters/templateParameters', () => {
  const src = {
    id: 100,
    definition: { id: 5, name: 'Some-SVC' },
    sourceBranch: 'refs/heads/main',
    templateParameters: {}, // empty → omitted
  };
  const p = buildRerunPayload(src);
  assert.deepStrictEqual(p, {
    definition: { id: 5 },
    sourceBranch: 'refs/heads/main',
    reason: 'manual',
  });
  assert.ok(!('parameters' in p));
  assert.ok(!('templateParameters' in p));
});

test('buildRerunPayload: --branch override re-runs the same config on another ref', () => {
  const src = { definition: { id: 7 }, sourceBranch: 'refs/heads/main', parameters: '{"a":1}' };
  const p = buildRerunPayload(src, { branch: 'releases/rc/202606_1' });
  assert.strictEqual(p.sourceBranch, 'refs/heads/releases/rc/202606_1');
  assert.strictEqual(p.parameters, '{"a":1}');
});

test('buildRerunPayload: throws when the source build has no definition id', () => {
  assert.throws(() => buildRerunPayload({ sourceBranch: 'refs/heads/main' }), /definition id/);
});

// ── build: summarizeBuild ─────────────────────────────────────────────────────
test('summarizeBuild: flattens key fields, parses parameters, builds web url', () => {
  const s = summarizeBuild({
    id: 40658,
    buildNumber: '20260713.1 APP-UI-WEB',
    definition: { id: 369, name: 'APP-UI-WEB' },
    status: 'notStarted',
    sourceBranch: 'refs/heads/features/1234-new-widget',
    sourceVersion: 'eb51ec9e5e54b0f3d516ac88b71db0035b206ee2',
    parameters: '{"clientName":"acme-retail"}',
  }, 'https://dev.azure.com/contoso/Fabrikam');
  assert.strictEqual(s.id, 40658);
  assert.strictEqual(s.definition, 'APP-UI-WEB');
  assert.strictEqual(s.sourceVersion, 'eb51ec9e'); // truncated to 8
  assert.deepStrictEqual(s.parameters, { clientName: 'acme-retail' });
  assert.strictEqual(s.url, 'https://dev.azure.com/contoso/Fabrikam/_build/results?buildId=40658');
});

// ── markdownToHtml (WI comments) ─────────────────────────────────────────────
test('markdownToHtml: bold, inline code and lists', () => {
  const html = markdownToHtml('**Bold** and `code`\n\n- a\n- b');
  assert.ok(html.includes('<strong>Bold</strong>'));
  assert.ok(html.includes('<code>code</code>'));
  assert.ok(html.includes('<li>a</li>'));
  assert.ok(html.includes('<li>b</li>'));
});

test('markdownToHtml: fenced code block renders once, not double-escaped', () => {
  const html = markdownToHtml('```ts\nconst a = x > 1 && y < 2;\nline2;\n```');
  assert.ok(html.includes('<pre><code>'), 'emits real <pre><code>');
  assert.ok(!/&lt;pre/.test(html), 'does not double-escape the <pre> tag');
  assert.ok(html.includes('x &gt; 1 &amp;&amp; y &lt; 2'), 'inner code escaped exactly once');
  assert.ok(!/<p><pre>/.test(html), 'code block is not wrapped in <p>');
  assert.ok(!/CODEBLOCK/.test(html), 'no leftover placeholder marker');
  assert.ok(!/<pre>[\s\S]*<br\/>[\s\S]*<\/pre>/.test(html), 'no <br/> injected inside the block');
});

test('markdownToHtml: drops the opening-fence info string', () => {
  const html = markdownToHtml('```js\nfoo();\n```');
  assert.ok(!/>js/.test(html) && !html.includes('>js\n'), 'language token is not emitted');
  assert.ok(html.includes('foo();'));
});

// ── loadConfig profile resolution ─────────────────────────────────────────────
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../lib/config');

// Run loadConfig against a temp config file, with the AZURE_* env vars controlled.
function withConfig(fileObj, env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(fileObj));
  const keys = ['AZURE_CONFIG_FILE', 'AZURE_PAT', 'AZURE_ORG', 'AZURE_PROJECT', 'AZURE_PROFILE', 'AZURE_PAT_OTHER'];
  const saved = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.AZURE_CONFIG_FILE = file;
  Object.assign(process.env, env || {});
  try { return fn((opts) => loadConfig(opts)); }
  finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const MULTI = {
  defaultProfile: 'work',
  profiles: {
    work: { org: 'work-org', project: 'Platform', pat: 'work-pat' },
    home: { org: 'home-org', patEnv: 'AZURE_PAT_OTHER' },
  },
};

test('loadConfig: top-level single profile is the fallback', () => {
  withConfig({ pat: 'top-pat', org: 'solo-org', project: 'P' }, {}, (load) => {
    const c = load();
    assert.strictEqual(c.pat, 'top-pat');
    assert.strictEqual(c.org, 'solo-org');
    assert.strictEqual(c.profileName, '(default)');
    assert.strictEqual(c.patSource, 'config');
  });
});

test('loadConfig: defaultProfile selected when nothing else does', () => {
  withConfig(MULTI, {}, (load) => {
    const c = load();
    assert.strictEqual(c.profileName, 'work');
    assert.strictEqual(c.pat, 'work-pat');
    assert.strictEqual(c.org, 'work-org');
  });
});

test('loadConfig: --profile wins over the default', () => {
  withConfig(MULTI, { AZURE_PAT_OTHER: 'injected' }, (load) => {
    const c = load({ flagProfile: 'home' });
    assert.strictEqual(c.profileName, 'home');
    assert.strictEqual(c.pat, 'injected'); // resolved from patEnv
    assert.strictEqual(c.org, 'home-org');
  });
});

test('loadConfig: a URL org auto-selects its profile', () => {
  withConfig(MULTI, { AZURE_PAT_OTHER: 'injected' }, (load) => {
    const c = load({ urlOrg: 'home-org' });
    assert.strictEqual(c.profileName, 'home');
    assert.strictEqual(c.pat, 'injected');
  });
});

test('loadConfig: AZURE_PROFILE selects a profile', () => {
  withConfig(MULTI, { AZURE_PROFILE: 'work' }, (load) => {
    assert.strictEqual(load().profileName, 'work');
  });
});

test('loadConfig: AZURE_PAT env overrides the resolved profile', () => {
  withConfig(MULTI, { AZURE_PAT: 'env-pat' }, (load) => {
    const c = load();
    assert.strictEqual(c.pat, 'env-pat');
    assert.strictEqual(c.patSource, 'env');
  });
});

test('loadConfig: patEnv yields empty PAT when the env var is unset', () => {
  withConfig(MULTI, {}, (load) => {
    const c = load({ flagProfile: 'home' });
    assert.strictEqual(c.pat, ''); // AZURE_PAT_OTHER not set → no secret on disk, none injected
  });
});

// ── markdownToHtml: tables, ordered lists, quotes ─────────────────────────────
test('markdownToHtml: pipe table becomes a real <table> with styled cells', () => {
  const html = markdownToHtml('| # | Cenário |\n|---|---|\n| 1 | Só uma condição |\n| 2 | Duas condições |');
  assert.ok(html.includes('<table'), 'emits a table element');
  assert.ok(html.includes('<th style="border:1px solid #ccc;padding:6px;text-align:left">#</th>'), 'header cell is styled');
  assert.ok(html.includes('>Só uma condição</td>'), 'body cell content preserved');
  assert.strictEqual((html.match(/<tr/g) || []).length, 3, 'one header row + two body rows');
  assert.ok(!html.includes('|---|'), 'delimiter row is consumed, not printed');
  assert.ok(!/<p>\s*\|/.test(html), 'rows are not left as literal paragraphs');
});

test('markdownToHtml: table honours column alignment and inline formatting', () => {
  const html = markdownToHtml('| a | b | c |\n|:---|:--:|---:|\n| **x** | `y` | z |');
  assert.ok(html.includes('text-align:left">a</th>'));
  assert.ok(html.includes('text-align:center">b</th>'));
  assert.ok(html.includes('text-align:right">c</th>'));
  assert.ok(html.includes('<strong>x</strong>'), 'bold works inside a cell');
  assert.ok(html.includes('<code>y</code>'), 'inline code works inside a cell');
});

test('markdownToHtml: header-only table is not torn apart by the paragraph pass', () => {
  const html = markdownToHtml('| a | b |\n|---|---|');
  assert.ok(html.startsWith('<table'), 'stays one block');
  assert.ok(!html.includes('<p>'), 'no paragraph wrapping inside the table');
  assert.ok(html.includes('</table>'));
});

test('markdownToHtml: a pipe inside inline code is not a cell separator', () => {
  const html = markdownToHtml('Text with `a|b` in the middle.');
  assert.ok(html.includes('<code>a|b</code>'), 'pipe restored inside the code span');
  assert.ok(!html.includes('[[[PIPE]]]'), 'no leftover placeholder marker');
  assert.ok(!html.includes('<table'), 'prose with a pipe is not read as a table');
});

test('markdownToHtml: prose containing a pipe is not read as a table', () => {
  const html = markdownToHtml('Rodar A | B para comparar.\n\nOutra linha.');
  assert.ok(!html.includes('<table'));
});

test('markdownToHtml: numbered list becomes <ol>, separate from an adjacent <ul>', () => {
  const html = markdownToHtml('1. um\n2. dois\n\n- a\n- b');
  assert.ok(html.includes('<ol>'), 'ordered list');
  assert.ok(html.includes('<li>um</li>'));
  assert.ok(html.includes('<ul>'), 'unordered list still works');
  assert.ok(html.includes('<li>a</li>'));
  assert.ok(!/<ol>[\s\S]*<li>a<\/li>[\s\S]*<\/ol>/.test(html), 'bullets do not leak into the <ol>');
});

test('markdownToHtml: block quote becomes <blockquote> without stray breaks', () => {
  const html = markdownToHtml('> Atenção ao caso 3.');
  assert.ok(html.includes('<blockquote>'));
  assert.ok(html.includes('<p>Atenção ao caso 3.</p>'));
  assert.ok(!html.includes('&gt; Atenção'), 'the marker is consumed, not escaped into the text');
  assert.ok(!/<br\/>\s*<\/blockquote>/.test(html), 'no trailing <br/> inside the quote');
});

test('markdownToHtml: full HTML input is still passed through untouched', () => {
  const src = '<h2>T</h2>\n<table><tbody><tr><td>a</td></tr></tbody></table>';
  assert.strictEqual(markdownToHtml(src), src);
});

// ── markdownToFieldHtml: the 'field' profile ─────────────────────────────────
// Long-form form fields sanitize differently from comments: `style=` is dropped and
// tables render inconsistently. So the field profile must emit neither.
test('markdownToFieldHtml: emits no inline style attribute anywhere', () => {
  const html = markdownToFieldHtml('## T\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x');
  assert.ok(!/style\s*=/.test(html), 'no style attribute survives the form, so none is written');
});

test('markdownToFieldHtml: a table becomes a list, losing no cell', () => {
  const html = markdownToFieldHtml('| | Polling | Real event |\n|---|---|---|\n| Quem dispara | timer | Service Bus |');
  assert.ok(!html.includes('<table'), 'no table element');
  assert.ok(html.includes('<ul>') && html.includes('</ul>'));
  assert.ok(html.includes('<b>Quem dispara</b>'), 'first cell is the row label');
  assert.ok(html.includes('<b>Polling</b>: timer'), 'column header labels its value');
  assert.ok(html.includes('<b>Real event</b>: Service Bus'));
});

test('markdownToFieldHtml: a non-empty first header prefixes the row label', () => {
  const html = markdownToFieldHtml('| # | Cenário |\n|---|---|\n| 1 | Só uma condição |');
  assert.ok(html.includes('<b>#: 1</b>'), 'the first column header is not dropped');
  assert.ok(html.includes('Só uma condição'));
});

test('markdownToFieldHtml: header-only table degrades to a line, not a torn block', () => {
  const html = markdownToFieldHtml('| a | b |\n|---|---|');
  assert.ok(html.includes('<b>a · b</b>'));
  assert.ok(!html.includes('|---|'), 'delimiter row is consumed');
});

test('markdownToFieldHtml: bold uses <b>, the tag verified to survive the form', () => {
  const html = markdownToFieldHtml('**forte**');
  assert.ok(html.includes('<b>forte</b>'));
  assert.ok(!html.includes('<strong>'));
});

test('markdownToFieldHtml: comment profile is untouched by the field profile', () => {
  const md = '| a | b |\n|---|---|\n| 1 | 2 |';
  assert.ok(markdownToHtml(md).includes('<table'), 'comments still get a real table');
  assert.ok(markdownToHtml(md).includes('style='), 'comments still get the inline styles');
});

// ── assertRenderableFieldValue: the guard that WI 67322 needed ───────────────
test('assertRenderableFieldValue: refuses raw markdown in a long-form field', () => {
  assert.throws(
    () => assertRenderableFieldValue('System.Description', '## Título\n\n**negrito**'),
    /raw markdown heading[\s\S]*markdownToFieldHtml/
  );
});

test('assertRenderableFieldValue: converted HTML passes', () => {
  const html = markdownToFieldHtml('## Título\n\n**negrito**\n\n| a | b |\n|---|---|\n| 1 | 2 |');
  assert.doesNotThrow(() => assertRenderableFieldValue('System.Description', html));
});

test('assertRenderableFieldValue: a one-line value is never a formatting question', () => {
  assert.doesNotThrow(() => assertRenderableFieldValue('Custom.Status', '**Open**'));
});

test('assertRenderableFieldValue: force is the deliberate override', () => {
  assert.doesNotThrow(() => assertRenderableFieldValue('System.Description', '## a\nb', { force: true }));
});

// ── stripHtml: table read-back ────────────────────────────────────────────────
const { stripHtml } = require('../lib/format');

test('stripHtml: table cells keep a visible separator and rows stay on their own line', () => {
  const html = '<table><thead><tr><th>#</th><th>Cenário</th></tr></thead>'
    + '<tbody><tr><td>1</td><td>Uma condição</td></tr><tr><td>2</td><td>Duas condições</td></tr></tbody></table>';
  const text = stripHtml(html);
  assert.ok(text.includes('# | Cenário'), 'header cells separated');
  assert.ok(text.includes('1 | Uma condição'), 'body cells separated');
  assert.ok(!text.includes('CenárioUma'), 'rows do not run together');
  assert.strictEqual(text.split('\n').filter((l) => l.includes('|')).length, 3, 'one line per row');
});

test('stripHtml: non-table markup is unchanged by the cell separator rule', () => {
  assert.strictEqual(stripHtml('<p>a</p><p>b</p>').replace(/\n+/g, '|'), 'a|b');
  assert.strictEqual(stripHtml('one<br/>two'), 'one\ntwo');
});

// ── bare-id resolution (pr / wi) ─────────────────────────────────────────────

const { needPrUrlOrId, needWorkItemUrlOrId } = require('../index.js');
const { printPullRequest } = require('../lib/format');

const CFG = { org: 'contoso', project: 'DefaultProj', repo: 'DefaultRepo' };

test('needPrUrlOrId: a full PR URL wins over any flag/config default', () => {
  const p = needPrUrlOrId(
    'https://dev.azure.com/contoso/MyProj/_git/MyRepo/pullrequest/123',
    CFG,
    { project: 'Ignored', repo: 'Ignored' }
  );
  assert.deepStrictEqual(p, { type: 'pr', org: 'contoso', project: 'MyProj', repo: 'MyRepo', prId: 123 });
});

test('needPrUrlOrId: a bare id takes project/repo from flags first', () => {
  const p = needPrUrlOrId('456', CFG, { project: 'FlagProj', repo: 'FlagRepo' });
  assert.deepStrictEqual(p, { type: 'pr', org: 'contoso', project: 'FlagProj', repo: 'FlagRepo', prId: 456 });
});

test('needPrUrlOrId: a bare id falls back to the configured project/repo', () => {
  const p = needPrUrlOrId('789', CFG, {});
  assert.deepStrictEqual(p, { type: 'pr', org: 'contoso', project: 'DefaultProj', repo: 'DefaultRepo', prId: 789 });
});

test('needPrUrlOrId: a valueless flag (--project with no argument) is ignored', () => {
  const p = needPrUrlOrId('789', CFG, { project: true, repo: true });
  assert.strictEqual(p.project, 'DefaultProj');
  assert.strictEqual(p.repo, 'DefaultRepo');
});

test('needWorkItemUrlOrId: a bare id needs only a project (ids are org-unique)', () => {
  const w = needWorkItemUrlOrId('22604', CFG, {});
  assert.deepStrictEqual(w, { type: 'workitem', org: 'contoso', project: 'DefaultProj', id: 22604 });
});

// ── printPullRequest: linked work items + --full extras ──────────────────────

function capture(fn) {
  const orig = console.log;
  const out = [];
  console.log = (...args) => out.push(args.join(' '));
  try { fn(); } finally { console.log = orig; }
  return out.join('\n');
}

const PR_FIXTURE = {
  pullRequestId: 1, title: 'T', status: 'active',
  sourceRefName: 'refs/heads/a', targetRefName: 'refs/heads/b',
  reviewers: [{ displayName: 'Ann', vote: 10, isRequired: true }, { displayName: 'Bo', vote: 0 }],
};

test('printPullRequest: linked work items render as #id list', () => {
  const out = capture(() => printPullRequest(PR_FIXTURE, { workItems: [{ id: 11 }, { id: 22 }] }));
  assert.match(out, /Work items: #11, #22/);
});

test('printPullRequest: no linked work items says "(none)", not nothing', () => {
  const out = capture(() => printPullRequest(PR_FIXTURE, { workItems: [] }));
  assert.match(out, /Work items: \(none\)/);
});

test('printPullRequest: without the extras the work-item line is absent', () => {
  const out = capture(() => printPullRequest(PR_FIXTURE));
  assert.doesNotMatch(out, /Work items:/);
});

test('printPullRequest: --full renders votes and thread counts; vote 0 is "no vote"', () => {
  const threads = [
    { status: 'active', threadContext: { filePath: '/a.cs' } },
    { status: 'closed', threadContext: { filePath: '/b.cs' } },
    { status: 'active' },
    { status: 'active', isDeleted: true },
  ];
  const out = capture(() => printPullRequest(PR_FIXTURE, { workItems: [], threads }));
  assert.match(out, /Ann — approved \(required\)/);
  assert.match(out, /Bo — no vote/);
  // 4 threads, 1 deleted → 3 active; of those, 2 are status 'active' (open).
  assert.match(out, /Threads:\s+3 \(2 open, 2 anchored to a file\)/);
});
