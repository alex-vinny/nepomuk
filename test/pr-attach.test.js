'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const {
  sha1Hex, sanitizeAttachmentName, prAttachmentUploadUrl, predictedAttachmentUrl, attachmentMarkdown,
  checkPrAttachment, explainPrAttachmentError, uploadPrAttachment, attachToPullRequest,
  findLocalImageRefs, planImageUploads, rewriteImageRefs, PR_ATTACHMENT_MAX_BYTES,
} = require('../lib/pr');
const { request } = require('../lib/api');
const { prAttachmentSummary } = require('../lib/format');

// ── pure helpers ─────────────────────────────────────────────────────────────

test('prAttachmentUploadUrl: the name goes in the path, encoded, with the GUIDs of the PR', () => {
  const u = prAttachmentUploadUrl({ base: 'https://dev.azure.com/acme', projectId: 'p-guid', repoId: 'r-guid', prId: 7, fileName: 'a#b.png' });
  assert.strictEqual(u, 'https://dev.azure.com/acme/p-guid/_apis/git/repositories/r-guid/pullRequests/7/attachments/a%23b.png?api-version=7.1');
});

// Seen on !22936 and !23691 (2026-10-27): the url Azure stores is GUIDs and no api-version.
test('predictedAttachmentUrl: the form Azure returns, so a dry run has the real length', () => {
  assert.strictEqual(
    predictedAttachmentUrl({ base: 'https://dev.azure.com/acme', projectId: 'p-guid', repoId: 'r-guid', prId: 7, fileName: 'shot.png' }),
    'https://dev.azure.com/acme/p-guid/_apis/git/repositories/r-guid/pullRequests/7/attachments/shot.png'
  );
});

test('sanitizeAttachmentName: accents dropped, spaces and parentheses become one dash, extension kept', () => {
  assert.strictEqual(sanitizeAttachmentName('Evidência QA (1).png'), 'Evidencia-QA-1.png');
  assert.strictEqual(sanitizeAttachmentName('shot.png'), 'shot.png');
  assert.strictEqual(sanitizeAttachmentName('  relatório  final .PDF'), 'relatorio-final.PDF');
  assert.strictEqual(sanitizeAttachmentName('a#b%c.png'), 'a-b-c.png');
  assert.strictEqual(sanitizeAttachmentName('().png'), '');
  assert.strictEqual(sanitizeAttachmentName(''), '');
});

test('sha1Hex: upper-case hex, the form of contentHash', () => {
  assert.strictEqual(sha1Hex(Buffer.from('abc')), 'A9993E364706816ABA3E25717850C26C9CD0D89D');
});

test('attachmentMarkdown: space and parentheses in the url are encoded, brackets dropped from the alt', () => {
  assert.strictEqual(attachmentMarkdown({ url: 'https://x/a b(1).png', alt: 'a [b]' }), '![a b](https://x/a%20b%281%29.png)');
});

test('checkPrAttachment: intrinsic refusals come before anything else', () => {
  assert.strictEqual(checkPrAttachment({ fileName: '', size: 1 }).reason, 'no-name');
  const bad = checkPrAttachment({ fileName: 'a b.png', size: 1 });
  assert.strictEqual(bad.reason, 'bad-name');
  assert.match(bad.message, /--name "a-b.png"/);
  assert.strictEqual(checkPrAttachment({ fileName: 'run.ps1', size: 1 }).reason, 'blocked-type');
  assert.strictEqual(checkPrAttachment({ fileName: 'RUN.EXE', size: 1 }).reason, 'blocked-type');
  // undefined slips past both numeric checks unless refused explicitly
  assert.strictEqual(checkPrAttachment({ fileName: 'a.png', size: undefined }).reason, 'no-size');
  assert.strictEqual(checkPrAttachment({ fileName: 'a.png', size: 0 }).reason, 'empty');
  assert.strictEqual(checkPrAttachment({ fileName: 'a.png', size: PR_ATTACHMENT_MAX_BYTES + 1 }).reason, 'too-large');
  assert.deepStrictEqual(checkPrAttachment({ fileName: 'a.png', size: 10 }), { ok: true, action: 'upload' });
});

test('checkPrAttachment: same name and same bytes is reused; same name and other bytes is refused', () => {
  const existing = [{ displayName: 'Shot.png', contentHash: 'ABC123', url: 'https://x/Shot.png' }];
  const reuse = checkPrAttachment({ fileName: 'shot.png', size: 10, sha1: 'abc123', existing });
  assert.strictEqual(reuse.action, 'reuse', 'names compare case-insensitively, hashes too');
  assert.strictEqual(reuse.attachment.url, 'https://x/Shot.png');
  const taken = checkPrAttachment({ fileName: 'shot.png', size: 10, sha1: 'FFFF', existing });
  assert.strictEqual(taken.reason, 'name-taken');
  assert.match(taken.message, /--name/);
  assert.strictEqual(checkPrAttachment({ fileName: 'shot.png', size: 10, existing }).reason, 'no-hash');
});

test('explainPrAttachmentError: wrong project, missing PR, and the upload statuses get a way out', () => {
  const ctx = { fileName: 'a.png', project: 'ELOS', repo: 'EVUP - ELOS', prId: 7 };
  assert.match(explainPrAttachmentError(new Error('HTTP 404 Not Found\nTF401019: The Git repository …'), ctx), /not found in project "ELOS".*full PR url/s);
  assert.match(explainPrAttachmentError(new Error('HTTP 404\nTF401180: …'), ctx), /PR !7 does not exist/);
  const withStatus = (s) => Object.assign(new Error(`HTTP ${s}`), { statusCode: s });
  assert.match(explainPrAttachmentError(withStatus(403), ctx), /Code \(read & write\)/);
  assert.match(explainPrAttachmentError(withStatus(409), ctx), /already has an attachment with that name/);
  assert.match(explainPrAttachmentError(withStatus(413), ctx), /too large/);
  assert.strictEqual(explainPrAttachmentError(withStatus(500), ctx), null);
});

test('findLocalImageRefs: local files only, resolved from the body folder; urls and code are left alone', () => {
  const base = path.resolve('/tmp/body');
  const md = [
    '![a](./a.png) ![remote](https://x/y.png) ![inline](data:image/png;base64,AAAA)',
    '![abs](C:/shots/b.png)',
    '`![code](./inline.png)`',
    '```',
    '![fenced](./fenced.png)',
    '```',
    '![after](sub/c.png)',
  ].join('\n');
  const refs = findLocalImageRefs(md, { baseDir: base });
  assert.deepStrictEqual(refs.map((r) => r.ref), ['./a.png', 'C:/shots/b.png', 'sub/c.png']);
  assert.strictEqual(refs[0].file, path.resolve(base, 'a.png'));
  assert.strictEqual(refs[0].alt, 'a');
});

// The first CLI run of this suite caught it: "./img/Print QA.png" escaped detection and
// would have been posted as a broken image.
test('findLocalImageRefs: a path with spaces, in <…>, %-encoded or with a title is still found', () => {
  const md = '![a](./img/Print QA.png) ![b](<./Print B.png>) ![c](./Print%20C.png) ![d](./d.png "titulo") ![e](https://x/e.png "t")';
  assert.deepStrictEqual(findLocalImageRefs(md, { baseDir: '/x' }).map((r) => r.ref),
    ['./img/Print QA.png', './Print B.png', './Print C.png', './d.png']);
});

test('findLocalImageRefs: an unclosed fence still hides what follows it', () => {
  assert.deepStrictEqual(findLocalImageRefs('```\n![x](./x.png)\n', { baseDir: '/' }), []);
});

test('planImageUploads: one upload per file, named for the url; non-image and name clash are refused together', () => {
  const ref = (r) => ({ ref: r, file: path.resolve('/b', r) });
  const plan = planImageUploads([ref('./Evidência 1.png'), ref('./Evidência 1.png'), ref('./b.jpg')]);
  assert.strictEqual(plan.length, 2);
  assert.strictEqual(plan[0].name, 'Evidencia-1.png');
  assert.deepStrictEqual(plan[0].refs, ['./Evidência 1.png', './Evidência 1.png']);
  assert.throws(() => planImageUploads([ref('./a.svg'), ref('./x/a b.png'), ref('./y/a-b.png')]), (err) => {
    assert.match(err.message, /"\.\/a\.svg" is not an image/);
    assert.match(err.message, /would both be attached as "a-b.png"/);
    return true;
  });
});

test('rewriteImageRefs: each local ref becomes the url, the rest of the text is untouched', () => {
  const md = 'antes ![a](./a.png) meio ![b](./b.png) fim';
  const refs = findLocalImageRefs(md, { baseDir: '/x' });
  const out = rewriteImageRefs(md, refs, (r) => `https://h/${path.basename(r.file)}`);
  assert.strictEqual(out, 'antes ![a](https://h/a.png) meio ![b](https://h/b.png) fim');
});

test('prAttachmentSummary: the author e-mail is not carried', () => {
  const s = prAttachmentSummary({ id: 1, displayName: 'a.png', url: 'u', contentHash: 'H', createdDate: 'd',
    author: { displayName: 'Ana', uniqueName: 'ana@example.com' } });
  assert.deepStrictEqual(s, { id: 1, name: 'a.png', url: 'u', contentHash: 'H', createdDate: 'd', author: 'Ana' });
  assert.doesNotMatch(JSON.stringify(s), /@/);
});

// ── network helpers against a local server ───────────────────────────────────

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

function withRetries(n, fn) {
  const before = process.env.AZURE_MAX_RETRIES;
  process.env.AZURE_MAX_RETRIES = String(n);
  return fn().finally(() => {
    if (before === undefined) delete process.env.AZURE_MAX_RETRIES; else process.env.AZURE_MAX_RETRIES = before;
  });
}

test('request: noRetryStatus returns a 409 at once and the error carries statusCode', () => withRetries(2, async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(409); res.end('{"message":"exists"}'); }, async (base) => {
    await assert.rejects(request(`${base}/x`, { method: 'POST', pat: 'p', body: { a: 1 }, noRetryStatus: [409] }),
      (err) => err.statusCode === 409);
  });
  assert.strictEqual(hits, 1);
}));

test('request: without noRetryStatus a 409 is still retried (work-item contention)', () => withRetries(1, async () => {
  let hits = 0;
  await withServer((req, res) => { hits++; res.writeHead(409); res.end('{}'); }, async (base) => {
    await assert.rejects(request(`${base}/x`, { method: 'POST', pat: 'p', body: { a: 1 } }));
  });
  assert.strictEqual(hits, 2);
}));

test('uploadPrAttachment: bytes go out as-is to the path url; 202 is accepted', async () => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
  let seen = null;
  await withServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen = { url: req.url, method: req.method, type: req.headers['content-type'], body: Buffer.concat(chunks) };
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 1, displayName: 'shot.png', url: 'https://x/shot.png' }));
    });
  }, async (base) => {
    const out = await uploadPrAttachment({
      config: { baseUrl: base, org: 'acme', pat: 'p' }, projectId: 'pg', repoId: 'rg', prId: 7, fileName: 'shot.png', buffer: bytes,
    });
    assert.strictEqual(out.url, 'https://x/shot.png');
  });
  assert.strictEqual(seen.method, 'POST');
  assert.strictEqual(seen.url, '/acme/pg/_apis/git/repositories/rg/pullRequests/7/attachments/shot.png?api-version=7.1');
  assert.strictEqual(seen.type, 'application/octet-stream');
  assert.ok(seen.body.equals(bytes));
});

test('uploadPrAttachment: a string body is refused before any request', async () => {
  await assert.rejects(uploadPrAttachment({ config: { baseUrl: 'http://127.0.0.1:9', org: 'a', pat: 'p' },
    projectId: 'p', repoId: 'r', prId: 1, fileName: 'a.png', buffer: 'texto' }), /needs a Buffer/);
});

test('attachToPullRequest: an identical file already on the PR is reused, nothing is posted', async () => {
  const buffer = Buffer.from('same');
  const existing = [{ displayName: 'a.png', contentHash: sha1Hex(buffer), url: 'https://x/a.png' }];
  const out = await attachToPullRequest({ config: { baseUrl: 'http://127.0.0.1:9', org: 'a', pat: 'p' },
    project: 'P', repo: 'R', prId: 1, projectId: 'pg', repoId: 'rg', fileName: 'a.png', buffer, existing });
  assert.strictEqual(out.reused, true);
  assert.strictEqual(out.attachment.url, 'https://x/a.png');
});

test('attachToPullRequest: an upload that errors but landed (same name and hash) is reported as attached', () => withRetries(0, async () => {
  const buffer = Buffer.from('bytes');
  await withServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.method === 'POST') { res.writeHead(500); res.end('{}'); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ count: 1, value: [{ displayName: 'a.png', contentHash: sha1Hex(buffer), url: 'https://x/a.png' }] }));
    });
  }, async (base) => {
    const out = await attachToPullRequest({ config: { baseUrl: base, org: 'acme', pat: 'p' },
      project: 'P', repo: 'R', prId: 7, projectId: 'pg', repoId: 'rg', fileName: 'a.png', buffer, existing: [] });
    assert.strictEqual(out.recovered, true);
    assert.strictEqual(out.attachment.url, 'https://x/a.png');
  });
}));

// ── CLI end to end, against a fake Azure ─────────────────────────────────────
// The config points at a file that does not exist and the base url at the fake, so a
// run can never read a real config or reach a real org.

function fakeAzure() {
  const state = { attachments: [], requests: [], posts: [], comments: [], patches: [], prStatus: 'active', prError: null };
  const handler = (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = decodeURIComponent(req.url.split('?')[0]);
      state.requests.push(`${req.method} ${url}`);
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7') {
        if (state.prError) return json(404, { message: state.prError });
        return json(200, { pullRequestId: 7, title: 'T', status: state.prStatus,
          repository: { id: 'repo-guid', name: 'R', project: { id: 'proj-guid', name: 'P' } } });
      }
      if (req.method === 'GET' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7/attachments') {
        return json(200, { count: state.attachments.length, value: state.attachments });
      }
      const up = url.match(/^\/acme\/proj-guid\/_apis\/git\/repositories\/repo-guid\/pullRequests\/7\/attachments\/(.+)$/);
      if (req.method === 'POST' && up) {
        const a = { id: state.attachments.length + 1, displayName: up[1], contentHash: crypto.createHash('sha1').update(body).digest('hex').toUpperCase(),
          url: `${state.base}/acme/proj-guid/_apis/git/repositories/repo-guid/pullRequests/7/attachments/${up[1]}`,
          author: { displayName: 'Ana', uniqueName: 'ana@example.com' } };
        state.attachments.push(a);
        state.posts.push({ name: up[1], body });
        return json(201, a);
      }
      if (req.method === 'POST' && /\/pullRequests\/7\/threads\/99\/comments$/.test(url)) {
        state.comments.push(JSON.parse(body.toString('utf8')));
        return json(200, { id: 2 });
      }
      if (req.method === 'PATCH' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7') {
        state.patches.push(JSON.parse(body.toString('utf8')));
        return json(200, {});
      }
      return json(404, { message: `fake: no route for ${req.method} ${url}` });
    });
  };
  return { state, handler };
}

// Async spawn: spawnSync would block the event loop the fake server runs on.
function runCli(base, args, dir) {
  const env = { ...process.env, AZURE_CONFIG_FILE: path.join(dir, 'none.json'), AZURE_PAT: 'dummy', AZURE_ORG: 'acme',
    AZURE_BASE_URL: base, AZURE_MAX_RETRIES: '0' };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

async function withFake(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-prattach-'));
  const fake = fakeAzure();
  try {
    await withServer(fake.handler, async (base) => {
      fake.state.base = base;
      const cli = (...args) => runCli(base, [...args, '--project', 'P', '--repo', 'R'], dir);
      await fn({ cli, state: fake.state, dir, file: (name, data) => { const f = path.join(dir, name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; } });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('pr attach (CLI): without --yes it previews, with the privacy note, and uploads nothing', () => withFake(async ({ cli, state, file }) => {
  const f = file('Evidência 1.png', Buffer.from('png-1'));
  const res = await cli('pr', 'attach', '7', f);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN — nothing uploaded/);
  assert.match(res.stdout, /"attachAs": "Evidencia-1.png"/);
  assert.match(res.stdout, /LGPD/);
  assert.strictEqual(state.posts.length, 0);
}));

test('pr attach (CLI): --yes uploads the exact bytes and prints the url and a ready markdown line', () => withFake(async ({ cli, state, file }) => {
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const f = file('shot.png', bytes);
  const res = await cli('pr', 'attach', '7', f, '--yes');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.posts.length, 1);
  assert.ok(state.posts[0].body.equals(bytes));
  assert.match(res.stdout, /Attached "shot.png" to PR !7 — 7 bytes/);
  assert.match(res.stdout, /!\[shot\.png\]\(http:\/\/127\.0\.0\.1:\d+\/acme\/proj-guid\/_apis\/git\/repositories\/repo-guid\/pullRequests\/7\/attachments\/shot\.png\)/);

  const again = await cli('pr', 'attach', '7', f, '--yes');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /already on PR !7 with the same content — nothing uploaded/);
  assert.strictEqual(state.posts.length, 1, 'a re-run does not upload a second copy');

  file('shot.png', Buffer.from('other bytes'));
  const clash = await cli('pr', 'attach', '7', f, '--yes');
  assert.strictEqual(clash.status, 1);
  assert.match(clash.stderr, /different content/);
  assert.strictEqual(state.posts.length, 1, 'the evidence already shown is not replaced');
}));

test('pr attach (CLI): a bad --name and a script are refused before any request', () => withFake(async ({ cli, state, file }) => {
  const f = file('a.png', 'x');
  const named = await cli('pr', 'attach', '7', f, '--name', 'a b.png', '--yes');
  assert.strictEqual(named.status, 1);
  assert.match(named.stderr, /--name "a-b.png"/);
  const script = await cli('pr', 'attach', '7', file('run.ps1', 'Write-Host'), '--yes');
  assert.strictEqual(script.status, 1);
  assert.match(script.stderr, /executable or script/);
  assert.deepStrictEqual(state.requests, []);
}));

test('pr attach (CLI): a wrong project is explained, and nothing is uploaded', () => withFake(async ({ cli, state, file }) => {
  state.prError = 'TF401019: The Git repository with name or identifier R does not exist or you do not have permissions';
  const res = await cli('pr', 'attach', '7', file('a.png', 'x'), '--yes');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /was not found in project "P".*Nothing was uploaded/s);
  assert.strictEqual(state.posts.length, 0);
}));

test('pr attachments (CLI): --json carries no author e-mail', () => withFake(async ({ cli, state }) => {
  state.attachments.push({ id: 1, displayName: 'a.png', url: 'u', contentHash: 'H', author: { displayName: 'Ana', uniqueName: 'ana@example.com' } });
  const res = await cli('pr', 'attachments', '7', '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(JSON.parse(res.stdout).map((a) => a.author), ['Ana']);
  assert.doesNotMatch(res.stdout, /ana@example\.com/);
}));

test('pr reply (CLI): a local image without --attach-images is refused, and nothing is sent', () => withFake(async ({ cli, state, file }) => {
  file('shot.png', 'png');
  const body = file('reply.md', 'Veja:\n\n![print](./shot.png)\n');
  const res = await cli('pr', 'reply', '7', '99', '--body-file', body);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /local image\(s\):\n {2}\.\/shot\.png/);
  assert.match(res.stderr, /--attach-images/);
  assert.deepStrictEqual(state.requests, []);
}));

test('pr reply (CLI): --dry-run shows the urls the uploads will get and uploads nothing', () => withFake(async ({ cli, state, file }) => {
  file('img/Print QA.png', 'png');
  const body = file('reply.md', '![print](./img/Print QA.png)\n');
  const res = await cli('pr', 'reply', '7', '99', '--body-file', body, '--attach-images', '--dry-run');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /upload {2}Print-QA\.png/);
  assert.match(res.stdout, /!\[print\]\(http:\/\/127\.0\.0\.1:\d+\/acme\/proj-guid\/.*\/attachments\/Print-QA\.png\)/);
  assert.strictEqual(state.posts.length, 0);
  assert.strictEqual(state.comments.length, 0);
}));

test('pr reply (CLI): --attach-images uploads each file once, links it, and leaves urls and code alone', () => withFake(async ({ cli, state, file }) => {
  file('a.png', 'png-a');
  const md = [
    '![um](./a.png) e de novo ![dois](./a.png)',
    '![remoto](https://example.com/r.png)',
    '```',
    '![exemplo](./nao-existe.png)',
    '```',
  ].join('\n');
  const body = file('reply.md', md);
  const res = await cli('pr', 'reply', '7', '99', '--body-file', body, '--attach-images');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.posts.length, 1, 'the same file referenced twice is uploaded once');
  const posted = state.comments[0].content;
  const url = state.attachments[0].url;
  assert.ok(posted.includes(`![um](${url}) e de novo ![dois](${url})`), posted);
  assert.ok(posted.includes('![remoto](https://example.com/r.png)'));
  assert.ok(posted.includes('![exemplo](./nao-existe.png)'), 'a fenced example is not touched');
}));

test('pr set-desc (CLI): the 4000-char cap counts the image urls, and refuses before uploading', () => withFake(async ({ cli, state, file }) => {
  file('a.png', 'png');
  const body = file('desc.md', `${'x'.repeat(3950)}\n![a](./a.png)\n`);
  const res = await cli('pr', 'set-desc', '7', '--body-file', body, '--attach-images');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /once the image urls are in.*Nothing was uploaded/s);
  assert.strictEqual(state.posts.length, 0);
  assert.strictEqual(state.patches.length, 0);
}));

test('pr set-desc (CLI): --attach-images uploads, then writes the description with the url', () => withFake(async ({ cli, state, file }) => {
  file('a.png', 'png');
  const body = file('desc.md', '## Evidência\n\n![a](./a.png)\n');
  const res = await cli('pr', 'set-desc', '7', '--body-file', body, '--attach-images');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.posts.length, 1);
  assert.ok(state.patches[0].description.includes(`![a](${state.attachments[0].url})`));
}));

// ── strict flags ─────────────────────────────────────────────────────────────

test('strict flags: a typo of --attach-images is refused with the right suggestion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-flags-'));
  try {
    const res = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js'), 'pr', 'reply', '7', '99', '--attach-imags'], {
      env: { ...process.env, AZURE_CONFIG_FILE: path.join(dir, 'none.json'), AZURE_PAT: 'd', AZURE_ORG: 'acme', AZURE_BASE_URL: 'http://127.0.0.1:9' },
      encoding: 'utf8',
    });
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /--attach-imags {3}did you mean --attach-images\?/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
