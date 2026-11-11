'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const LIVE = '## O que corrige\r\n\r\nTexto.\r\n\r\nBug #2, Bug Task #1.\r\n';

function fakeAzure() {
  const state = { requests: [], patches: [], description: LIVE };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      state.requests.push(`${req.method} ${url}`);
      if (url === '/acme/P/_apis/git/repositories/R/pullRequests/7') {
        if (req.method === 'GET') return json(res, 200, { pullRequestId: 7, description: state.description });
        if (req.method === 'PATCH') {
          const body = JSON.parse(raw || '{}');
          state.patches.push(body);
          return json(res, 200, { pullRequestId: 7, ...body });
        }
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-setdesc-base-'));
  const fake = fakeAzure();
  const server = http.createServer(fake.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = (name, content) => { const f = path.join(dir, name); fs.writeFileSync(f, content); return f; };
  try {
    const cli = (...args) => runCli(base, [...args, '--project', 'P', '--repo', 'R'], dir);
    await fn({ cli, state: fake.state, file });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('pr set-desc --base-file: the live description equal to the base (CRLF and trailing space aside) is written', () => withFake(async ({ cli, state, file }) => {
  const baseFile = file('base.md', LIVE.replace(/\r\n/g, '\n') + '\n\n');
  const novo = file('novo.md', 'texto novo');
  const res = await cli('pr', 'set-desc', '7', '--body-file', novo, '--base-file', baseFile);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(state.patches, [{ description: 'texto novo' }]);
}));

test('pr set-desc --base-file: a description changed after the read is refused, naming the first different line', () => withFake(async ({ cli, state, file }) => {
  const baseFile = file('base.md', LIVE.replace('Bug #2, Bug Task #1.', 'Task #1 (filha do PBI #3).'));
  const novo = file('novo.md', 'texto novo');
  const res = await cli('pr', 'set-desc', '7', '--body-file', novo, '--base-file', baseFile);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /description changed since --base-file was read \(first difference at line 5\)/);
  assert.match(res.stderr, /base: Task #1 \(filha do PBI #3\)\./);
  assert.match(res.stderr, /live: Bug #2, Bug Task #1\./);
  assert.strictEqual(state.patches.length, 0);

  const dry = await cli('pr', 'set-desc', '7', '--body-file', novo, '--base-file', baseFile, '--dry-run');
  assert.strictEqual(dry.status, 1, 'the dry-run also stops on a moved description');
}));

test('pr set-desc --base-file: without a new description or without a path, nothing is read or written', () => withFake(async ({ cli, state, file }) => {
  const baseFile = file('base.md', LIVE);
  const soTitulo = await cli('pr', 'set-desc', '7', '--title', 'x', '--base-file', baseFile);
  assert.strictEqual(soTitulo.status, 1);
  assert.match(soTitulo.stderr, /--base-file guards a description change/);

  const semCaminho = await cli('pr', 'set-desc', '7', '--body-file', file('novo.md', 'y'), '--base-file');
  assert.strictEqual(semCaminho.status, 1);
  assert.strictEqual(state.patches.length, 0);
}));
