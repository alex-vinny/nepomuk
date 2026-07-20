'use strict';

// Unit tests for azure-connector's pure helpers. No network, no PAT.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { parseArgs, normalizeAzureRepoPath } = require('../index.js');
const { parseUrl } = require('../lib/config');
const { buildThreadBody } = require('../lib/pr');
const { normalizeBranchRef, buildRerunPayload, summarizeBuild } = require('../lib/build');
const { markdownToHtml } = require('../lib/workitem');

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
  const p = parseUrl('https://dev.azure.com/evuptec/ELOS/_git/ELOS-SVC-CRM/pullrequest/21371');
  assert.strictEqual(p.type, 'pr');
  assert.strictEqual(p.project, 'ELOS');
  assert.strictEqual(p.repo, 'ELOS-SVC-CRM');
  assert.strictEqual(p.prId, 21371);
});

test('parseUrl: work item', () => {
  const p = parseUrl('https://dev.azure.com/evuptec/ELOS/_workitems/edit/65239');
  assert.strictEqual(p.type, 'workitem');
  assert.strictEqual(p.id, 65239);
});

test('parseUrl: repo url and project with encoded spaces', () => {
  const p = parseUrl('https://dev.azure.com/evuptec/EVUP%20-%20ELOS/_git/SCH');
  assert.strictEqual(p.type, 'repo');
  assert.strictEqual(p.project, 'EVUP - ELOS');
  assert.strictEqual(p.repo, 'SCH');
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
  assert.strictEqual(normalizeBranchRef('features/65373_midia'), 'refs/heads/features/65373_midia');
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
    definition: { id: 369, name: 'APP-UI-CUSTOMER' },
    sourceBranch: 'refs/heads/features/65373_midia',
    parameters: '{"clientName":"botoclinic","platformName":"android"}',
    templateParameters: { groupName: 'boto-app' },
  };
  const p = buildRerunPayload(src);
  assert.deepStrictEqual(p, {
    definition: { id: 369 },
    sourceBranch: 'refs/heads/features/65373_midia',
    reason: 'manual',
    parameters: '{"clientName":"botoclinic","platformName":"android"}',
    templateParameters: { groupName: 'boto-app' },
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
    buildNumber: '20260713.1 APP-UI-CUSTOMER',
    definition: { id: 369, name: 'APP-UI-CUSTOMER' },
    status: 'notStarted',
    sourceBranch: 'refs/heads/features/65373_midia',
    sourceVersion: 'eb51ec9e5e54b0f3d516ac88b71db0035b206ee2',
    parameters: '{"clientName":"botoclinic"}',
  }, 'https://dev.azure.com/evuptec/ELOS');
  assert.strictEqual(s.id, 40658);
  assert.strictEqual(s.definition, 'APP-UI-CUSTOMER');
  assert.strictEqual(s.sourceVersion, 'eb51ec9e'); // truncated to 8
  assert.deepStrictEqual(s.parameters, { clientName: 'botoclinic' });
  assert.strictEqual(s.url, 'https://dev.azure.com/evuptec/ELOS/_build/results?buildId=40658');
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
