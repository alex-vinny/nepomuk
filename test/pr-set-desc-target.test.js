'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { targetBranchName } = require('../lib/pr');

test('targetBranchName: accepts the short name or the full ref, refuses empty', () => {
  assert.strictEqual(targetBranchName('releases/rc/x'), 'releases/rc/x');
  assert.strictEqual(targetBranchName('refs/heads/releases/rc/x'), 'releases/rc/x');
  assert.strictEqual(targetBranchName('  main  '), 'main');
  for (const empty of [undefined, null, true, '', '   ', 'refs/heads/']) {
    assert.strictEqual(targetBranchName(empty), null, String(empty));
  }
});

function fakeAzure() {
  const state = { requests: [], patches: [], branches: ['main', 'releases/rc/hf'] };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const [url, query = ''] = req.url.split('?');
      state.requests.push(`${req.method} ${url}`);
      if (req.method === 'GET' && url === '/acme/P/_apis/git/repositories/R/refs') {
        const filter = decodeURIComponent((query.match(/filter=([^&]*)/) || [])[1] || '');
        const value = state.branches.filter((b) => `heads/${b}` === filter)
          .map((b) => ({ name: `refs/heads/${b}`, objectId: 'abc123' }));
        return json(res, 200, { value });
      }
      if (req.method === 'PATCH' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7') {
        const body = JSON.parse(raw || '{}');
        state.patches.push(body);
        return json(res, 200, { pullRequestId: 7, ...body });
      }
      return json(res, 404, { message: `fake: no route for ${req.method} ${url}` });
    });
  };
  return { state, handler };
}

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-settarget-'));
  const fake = fakeAzure();
  const server = http.createServer(fake.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const cli = (...args) => runCli(base, [...args, '--project', 'P', '--repo', 'R'], dir);
    await fn({ cli, state: fake.state });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('pr set-desc --target (CLI): an existing branch becomes the new target, alone or with the title', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'set-desc', '7', '--target', 'refs/heads/releases/rc/hf');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(state.patches, [{ targetRefName: 'refs/heads/releases/rc/hf' }]);
  assert.match(res.stdout, /PR #7 updated \(target refs\/heads\/releases\/rc\/hf\)\./);

  const both = await cli('pr', 'set-desc', '7', '--title', 'novo', '--target', 'main');
  assert.strictEqual(both.status, 0, both.stderr);
  assert.deepStrictEqual(state.patches[1], { title: 'novo', targetRefName: 'refs/heads/main' });
}));

test('pr set-desc --target (CLI): a missing branch or an empty value is refused before any write', () => withFake(async ({ cli, state }) => {
  const missing = await cli('pr', 'set-desc', '7', '--target', 'releases/rc/nao-existe', '--title', 'x');
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /Target branch "releases\/rc\/nao-existe" does not exist in R\. Nothing was updated\./);

  const empty = await cli('pr', 'set-desc', '7', '--target', '');
  assert.strictEqual(empty.status, 1);

  assert.strictEqual(state.patches.length, 0);
}));

test('pr set-desc --target (CLI): --dry-run checks the branch and shows the target without writing', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'set-desc', '7', '--target', 'releases/rc/hf', '--dry-run');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN — nothing updated\./);
  assert.match(res.stdout, /Target: refs\/heads\/releases\/rc\/hf/);
  assert.strictEqual(state.patches.length, 0);
  assert.ok(state.requests.includes('GET /acme/P/_apis/git/repositories/R/refs'));
}));
