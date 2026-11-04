'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { parseVote, voteBlockers, summarizeCommentThreads, VOTE_VALUES } = require('../lib/pr');
const { supportsJson } = require('../index');

// ── pure helpers ─────────────────────────────────────────────────────────────

test('parseVote: the five Azure values, as numbers or names', () => {
  assert.deepStrictEqual(VOTE_VALUES, [10, 5, 0, -5, -10]);
  for (const [input, want] of [['10', 10], ['+5', 5], ['0', 0], ['-5', -5], ['-10', -10],
    ['approve', 10], ['approve-with-suggestions', 5], ['reset', 0], ['wait-for-author', -5], ['Reject', -10], [-5, -5]]) {
    assert.strictEqual(parseVote(input), want, String(input));
  }
});

test('parseVote: anything else throws and lists what is accepted', () => {
  for (const bad of ['1', '-1', '100', 'approvd', '', undefined, true, '5.0']) {
    assert.throws(() => parseVote(bad), /Invalid vote .*10 \(approve\).*-10 \(reject\)/, String(bad));
  }
});

test('voteBlockers: an inactive PR and a moved head block; a matching head does not', () => {
  const pr = { status: 'active', lastMergeSourceCommit: { commitId: 'abcdef1234567890' } };
  assert.deepStrictEqual(voteBlockers(pr), []);
  assert.deepStrictEqual(voteBlockers(pr, { expectHead: 'abcdef1' }), []);
  assert.match(voteBlockers({ ...pr, status: 'completed' }).join(), /"completed", not active/);
  assert.match(voteBlockers(pr, { expectHead: '1234567' }).join(), /moved after the review/);
  assert.match(voteBlockers(pr, { expectHead: 'not-a-sha' }).join(), /not a commit sha/);
});

test('summarizeCommentThreads: drops deleted threads and comments, keeps file:line, never the author e-mail', () => {
  const out = summarizeCommentThreads({ value: [
    { id: 1, status: 'active', threadContext: { filePath: '/a.cs', rightFileStart: { line: 42 } }, publishedDate: 'd1',
      comments: [
        { id: 1, author: { displayName: 'Ana', uniqueName: 'ana@example.com' }, content: 'oi', commentType: 'text', publishedDate: 'd1' },
        { id: 2, parentCommentId: 1, author: { displayName: 'Bia', uniqueName: 'bia@example.com' }, content: 'x', isDeleted: true },
      ] },
    { id: 2, isDeleted: true, comments: [] },
    { id: 3, comments: [{ id: 1, author: { displayName: 'System' }, commentType: 'system', content: 'voted 10' }] },
  ] });
  assert.deepStrictEqual(out.map((t) => t.id), [1, 3]);
  assert.deepStrictEqual(out[0], {
    id: 1, status: 'active', filePath: '/a.cs', line: 42, publishedDate: 'd1',
    comments: [{ id: 1, parentCommentId: null, author: 'Ana', publishedDate: 'd1', commentType: 'text', content: 'oi' }],
  });
  assert.strictEqual(out[1].filePath, null);
  assert.doesNotMatch(JSON.stringify(out), /@example\.com/);
  assert.deepStrictEqual(summarizeCommentThreads(null), []);
});

test('supportsJson: commands that emit JSON pass, text-only ones do not', () => {
  for (const [g, s] of [['pr', 'get'], ['pr', 'comments'], ['wi', 'updates'], ['build', 'last'], ['sprints', 'Board'], ['create-repo', 'x']]) {
    assert.ok(supportsJson(g, s), `${g} ${s}`);
  }
  for (const [g, s] of [['pr', 'diff'], ['pr', 'vote'], ['wi', 'comments'], ['whoami', undefined], ['raw', 'GET'], ['pr', undefined]]) {
    assert.ok(!supportsJson(g, s), `${g} ${s}`);
  }
});

// ── CLI end to end against a fake Azure ──────────────────────────────────────

function fakeAzure() {
  const state = {
    requests: [],
    puts: [],
    ignorePut: false,
    pr: {
      pullRequestId: 7, title: 'feat: x', status: 'active',
      sourceRefName: 'refs/heads/feature/x', targetRefName: 'refs/heads/main',
      lastMergeSourceCommit: { commitId: 'abcdef1234567890abcdef1234567890abcdef12' },
      reviewers: [{ id: 'other-guid', displayName: 'Other', vote: 10 }],
    },
    threads: { value: [
      { id: 11, status: 'active', threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 3 } },
        comments: [{ id: 1, author: { displayName: 'Ana', uniqueName: 'ana@example.com' }, content: 'fix this', commentType: 'text' }] },
    ] },
  };
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      state.requests.push(`${req.method} ${url}`);
      if (url === '/acme/_apis/connectionData') return json(res, 200, { authenticatedUser: { id: 'ME-GUID', providerDisplayName: 'Me' } });
      if (req.method === 'GET' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7') return json(res, 200, state.pr);
      if (req.method === 'GET' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7/threads') return json(res, 200, state.threads);
      if (req.method === 'PUT' && url === '/acme/P/_apis/git/repositories/R/pullRequests/7/reviewers/ME-GUID') {
        const body = JSON.parse(raw || '{}');
        state.puts.push(body);
        if (!state.ignorePut) {
          const others = state.pr.reviewers.filter((r) => r.id !== 'me-guid');
          state.pr.reviewers = [...others, { id: 'me-guid', displayName: 'Me', vote: body.vote }];
        }
        return json(res, 200, { id: 'me-guid', vote: body.vote });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-prvote-'));
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

test('pr vote (CLI): without --yes it previews the current and new vote and writes nothing', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'vote', '7', 'wait-for-author');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /reviewer: Me \(not on the PR yet — the vote adds you\)/);
  assert.match(res.stdout, /vote: \(none\) → -5 waiting for author/);
  assert.match(res.stdout, /DRY RUN — nothing was written/);
  assert.strictEqual(state.puts.length, 0);
}));

test('pr vote (CLI): --yes sets the vote for the PAT identity and confirms it by reading the PR back', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'vote', '7', '5', '--yes');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(state.puts, [{ vote: 5 }]);
  assert.match(res.stdout, /Voted 5 \(approved with suggestions\) on PR #7 as Me\./);
  assert.strictEqual(state.requests.filter((r) => r === 'GET /acme/P/_apis/git/repositories/R/pullRequests/7').length, 2,
    'the PR is read before and after the write');

  const again = await cli('pr', 'vote', '7', 'approve-with-suggestions', '--yes');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /already that — nothing to change/);
  assert.strictEqual(state.puts.length, 1, 'the same vote is not sent twice');
}));

test('pr vote (CLI): a vote Azure did not keep is reported as a failure', () => withFake(async ({ cli, state }) => {
  state.ignorePut = true;
  const res = await cli('pr', 'vote', '7', '10', '--yes');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /shows your vote as \(none\), not 10/);
}));

test('pr vote (CLI): a moved head, a closed PR and an invalid vote are refused before any write', () => withFake(async ({ cli, state }) => {
  const moved = await cli('pr', 'vote', '7', '10', '--expect-head', '1234567', '--yes');
  assert.strictEqual(moved.status, 1);
  assert.match(moved.stderr, /moved after the review/);

  const bad = await cli('pr', 'vote', '7', 'approvd', '--yes');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /Invalid vote "approvd"/);

  const missing = await cli('pr', 'vote', '7');
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /Missing vote/);

  state.pr.status = 'completed';
  const closed = await cli('pr', 'vote', '7', '10', '--yes');
  assert.strictEqual(closed.status, 1);
  assert.match(closed.stderr, /"completed", not active/);

  assert.strictEqual(state.puts.length, 0);
}));

test('pr comments (CLI): --json parses, keeps the thread id and file:line, and carries no e-mail', () => withFake(async ({ cli }) => {
  const res = await cli('pr', 'comments', '7', '--json');
  assert.strictEqual(res.status, 0, res.stderr);
  const threads = JSON.parse(res.stdout);
  assert.deepStrictEqual(threads.map((t) => [t.id, t.filePath, t.line, t.comments[0].author]), [[11, '/src/a.ts', 3, 'Ana']]);
  assert.doesNotMatch(res.stdout, /ana@example\.com/);
}));

test('--json on a text-only command is refused before any request', () => withFake(async ({ cli, state }) => {
  for (const args of [['pr', 'diff', '7'], ['pr', 'vote', '7', '10'], ['whoami']]) {
    const res = await cli(...args, '--json');
    assert.strictEqual(res.status, 1, args.join(' '));
    assert.match(res.stderr, /--json is not supported by "[^"]+" — nothing was run/);
  }
  assert.deepStrictEqual(state.requests, []);
}));
