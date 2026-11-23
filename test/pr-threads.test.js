'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  THREAD_STATUSES, parseThreadStatus, sameThreadStatus, findPrThread, findThreadComment, appendCommentContent,
} = require('../lib/pr');

// ── pure helpers ─────────────────────────────────────────────────────────────

test('parseThreadStatus: the six Azure statuses, any case, in Azure spelling', () => {
  assert.deepStrictEqual(THREAD_STATUSES, ['active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending']);
  for (const [input, want] of [['active', 'active'], ['Fixed', 'fixed'], ['wontfix', 'wontFix'], ['WONTFIX', 'wontFix'],
    ['closed', 'closed'], ['bydesign', 'byDesign'], [' pending ', 'pending']]) {
    assert.strictEqual(parseThreadStatus(input), want, input);
  }
});

test('parseThreadStatus: anything else throws and lists what is accepted', () => {
  for (const bad of ['resolved', 'won\'t fix', 'done', '', undefined, true, '1']) {
    assert.throws(() => parseThreadStatus(bad), /Invalid thread status .*active, fixed, wontFix, closed, byDesign, pending/, String(bad));
  }
});

test('findPrThread / findThreadComment: only a live thread of the listing, only a live comment', () => {
  const listing = { value: [
    { id: 11, status: 'active', comments: [{ id: 1, content: 'a' }, { id: 2, content: 'b', isDeleted: true }] },
    { id: 12, isDeleted: true, comments: [] },
  ] };
  assert.strictEqual(findPrThread(listing, 11).thread.id, 11);
  assert.strictEqual(findPrThread(listing, '11').ok, true);
  assert.deepStrictEqual(findPrThread(listing, 99), { ok: false, reason: 'not-on-pr' });
  assert.strictEqual(findPrThread(listing, 12).reason, 'deleted');
  assert.strictEqual(findPrThread(null, 11).reason, 'not-on-pr');
  const t = findPrThread(listing, 11).thread;
  assert.strictEqual(findThreadComment(t, 1).content, 'a');
  assert.strictEqual(findThreadComment(t, 2), null);
  assert.strictEqual(findThreadComment(t, 3), null);
  assert.ok(sameThreadStatus('wontFix', 'wontfix'));
  assert.ok(!sameThreadStatus(null, 'active'));
});

test('appendCommentContent: one blank line between, original text untouched', () => {
  assert.strictEqual(appendCommentContent('first\nline', 'added'), 'first\nline\n\nadded');
  assert.strictEqual(appendCommentContent('first\n\n\n', '\n\nadded\n'), 'first\n\nadded\n');
  assert.strictEqual(appendCommentContent('', 'added'), 'added');
  assert.strictEqual(appendCommentContent(null, 'added'), 'added');
});

// ── CLI end to end against a fake Azure ──────────────────────────────────────

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';

function fakeAzure() {
  const state = {
    requests: [],
    writes: [],
    ignorePatch: false,
    failReplyOn: null,
    head: HEAD,
    threads: {
      11: { id: 11, status: 'active', threadContext: { filePath: '/src/a.ts', rightFileStart: { line: 3 } },
        comments: [{ id: 1, author: { displayName: 'Reviewer' }, content: 'Original finding.\n\nSecond paragraph.', commentType: 'text' }] },
      12: { id: 12, status: 'active',
        comments: [{ id: 1, author: { displayName: 'Reviewer' }, content: 'PR-level note', commentType: 'text' }] },
      13: { id: 13, status: 'fixed',
        comments: [{ id: 1, author: { displayName: 'Reviewer' }, content: 'already fixed', commentType: 'text' }] },
    },
  };
  const prefix = '/acme/P/_apis/git/repositories/R/pullRequests/7';
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const url = req.url.split('?')[0];
      state.requests.push(`${req.method} ${url}`);
      const body = raw ? JSON.parse(raw) : null;
      if (req.method !== 'GET') state.writes.push({ method: req.method, url, body });

      if (req.method === 'GET' && url === `${prefix}/threads`) return json(res, 200, { value: Object.values(state.threads) });
      if (req.method === 'GET' && url === `${prefix}/iterations`) {
        return json(res, 200, { value: [{ id: 1, sourceRefCommit: { commitId: state.head } }] });
      }
      let m = url.match(new RegExp(`^${prefix}/threads/(\\d+)$`));
      if (m) {
        // Like Azure: the thread id is NOT checked against the PR in the url. A thread of
        // another PR (99 here) is answered as if it were this PR's.
        const t = state.threads[m[1]] || { id: Number(m[1]), status: 'active', comments: [] };
        if (req.method === 'GET') return json(res, 200, t);
        if (req.method === 'PATCH') {
          if (!state.ignorePatch && state.threads[m[1]]) t.status = body.status;
          return json(res, 200, t);
        }
      }
      m = url.match(new RegExp(`^${prefix}/threads/(\\d+)/comments$`));
      if (m && req.method === 'POST') {
        if (state.failReplyOn === Number(m[1])) return json(res, 403, { message: 'fake: permission denied' });
        const t = state.threads[m[1]];
        const c = { id: t.comments.length + 1, parentCommentId: body.parentCommentId, content: body.content, commentType: 'text' };
        t.comments.push(c);
        return json(res, 200, c);
      }
      m = url.match(new RegExp(`^${prefix}/threads/(\\d+)/comments/(\\d+)$`));
      if (m && req.method === 'PATCH') {
        const c = state.threads[m[1]].comments.find((x) => x.id === Number(m[2]));
        c.content = body.content;
        return json(res, 200, c);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-prthreads-'));
  const fake = fakeAzure();
  const server = http.createServer(fake.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const file = (name, content) => { const f = path.join(dir, name); fs.writeFileSync(f, content); return f; };
  try {
    const cli = (...args) => runCli(base, [...args, '--project', 'P', '--repo', 'R'], dir);
    await fn({ cli, state: fake.state, file, dir });
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// pr thread-status

test('pr thread-status (CLI): an invalid status exits 1 before any request', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'thread-status', '7', '11', 'resolved', '--yes');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Invalid thread status "resolved"/);
  const missing = await cli('pr', 'thread-status', '7', '11');
  assert.strictEqual(missing.status, 1);
  assert.match(missing.stderr, /Missing status/);
  assert.deepStrictEqual(state.requests, []);
}));

test('pr thread-status (CLI): without --yes it previews current → new and writes nothing', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'thread-status', '7', '11', 'fixed');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.match(res.stdout, /thread 11 \(\/src\/a\.ts:3\)/);
  assert.match(res.stdout, /status: active → fixed/);
  assert.match(res.stdout, /DRY RUN — nothing was written/);
  assert.deepStrictEqual(state.writes, []);
}));

test('pr thread-status (CLI): --yes writes once and reads the thread back; the same status again is a no-op', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'thread-status', '7', '11', 'wontfix', '--yes');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(state.writes, [{ method: 'PATCH', url: '/acme/P/_apis/git/repositories/R/pullRequests/7/threads/11', body: { status: 'wontFix' } }]);
  const i = state.requests.indexOf('PATCH /acme/P/_apis/git/repositories/R/pullRequests/7/threads/11');
  assert.strictEqual(state.requests[i + 1], 'GET /acme/P/_apis/git/repositories/R/pullRequests/7/threads/11', 'read back after the write');
  assert.match(res.stdout, /Thread 11 on PR #7 is now wontFix\./);

  const again = await cli('pr', 'thread-status', '7', '11', 'wontFix', '--yes');
  assert.strictEqual(again.status, 0, again.stderr);
  assert.match(again.stdout, /already in that status — nothing to change/);
  assert.strictEqual(state.writes.length, 1);
}));

test('pr thread-status (CLI): a thread of another PR is refused and nothing is written', () => withFake(async ({ cli, state }) => {
  const res = await cli('pr', 'thread-status', '7', '99', 'closed', '--yes');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /Thread 99 is not on PR #7\..*Nothing was written\./s);
  assert.deepStrictEqual(state.writes, []);
}));

test('pr thread-status (CLI): a status Azure did not keep is reported as a failure', () => withFake(async ({ cli, state }) => {
  state.ignorePatch = true;
  const res = await cli('pr', 'thread-status', '7', '11', 'closed', '--yes');
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /shows status "active", not "closed"/);
}));

// pr reply --batch

test('pr reply --batch (CLI): --dry-run validates and lists, writes nothing; the real run replies and sets status read back', () => withFake(async ({ cli, state, file }) => {
  file('r1.md', 'Fixed in the last commit.');
  file('r2.md', 'Not changing this, see the PR description.');
  const manifest = file('m.json', JSON.stringify({ expectHead: HEAD.slice(0, 10), replies: [
    { thread: 11, bodyFile: 'r1.md', status: 'fixed' },
    { thread: 12, bodyFile: 'r2.md', status: 'wontfix', comment: 1 },
    { thread: 13, bodyFile: 'r1.md', status: 'fixed' },
  ] }));

  const dry = await cli('pr', 'reply', '7', '--batch', manifest, '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /DRY RUN — 3 reply\(ies\) would be posted to PR #7/);
  assert.match(dry.stdout, /#1 thread 11 \(\/src\/a\.ts:3\) to comment 1 .*then status active → fixed/);
  assert.match(dry.stdout, /#3 thread 13 .*status already fixed/);
  assert.deepStrictEqual(state.writes, []);

  const res = await cli('pr', 'reply', '7', '--batch', manifest);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.deepStrictEqual(state.writes.map((w) => `${w.method} ${w.url.replace(/^.*pullRequests\/7/, '')}`), [
    'POST /threads/11/comments', 'PATCH /threads/11',
    'POST /threads/12/comments', 'PATCH /threads/12',
    'POST /threads/13/comments',
  ]);
  assert.strictEqual(state.threads[11].status, 'fixed');
  assert.strictEqual(state.threads[12].status, 'wontFix');
  assert.strictEqual(state.threads[11].comments[1].content, 'Fixed in the last commit.');
  assert.strictEqual(state.requests.filter((r) => r.endsWith('/threads/11') && r.startsWith('GET')).length, 1, 'status read back');
  assert.match(res.stdout, /3 reply\(ies\) posted to PR #7\./);
}));

test('pr reply --batch (CLI): one invalid item → every problem listed, nothing posted', () => withFake(async ({ cli, state, file }) => {
  file('ok.md', 'Fine.');
  file('empty.md', '   \n');
  file('img.md', 'See ![shot](./shot.png)');
  file('shot.png', 'x');
  const manifest = file('m.json', JSON.stringify([
    { thread: 11, bodyFile: 'ok.md' },
    { thread: 99, bodyFile: 'ok.md' },
    { thread: 12, bodyFile: 'empty.md' },
    { thread: 12, bodyFile: 'missing.md' },
    { thread: 12, bodyFile: 'img.md' },
    { thread: 12, bodyFile: 'ok.md', status: 'resolved' },
    { thread: 11, bodyFile: 'ok.md', comment: 5 },
  ]));
  const res = await cli('pr', 'reply', '7', '--batch', manifest);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /6 of 7 reply\(ies\) failed validation/);
  assert.match(res.stderr, /#2 thread 99 — thread 99 is not on PR #7/);
  assert.match(res.stderr, /#3 thread 12 — body file "empty.md" is empty/);
  assert.match(res.stderr, /#4 thread 12 — .*missing\.md/);
  assert.match(res.stderr, /#5 thread 12 — body points at local image/);
  assert.match(res.stderr, /#6 thread 12 — Invalid thread status "resolved"/);
  assert.match(res.stderr, /#7 thread 11 — comment 5 is not in thread 11/);
  assert.match(res.stderr, /Nothing was posted\./);
  assert.deepStrictEqual(state.writes, []);
}));

test('pr reply --batch (CLI): a head that moved past --expect-head holds every reply back', () => withFake(async ({ cli, state, file }) => {
  file('ok.md', 'Fine.');
  const manifest = file('m.json', JSON.stringify({ expectHead: HEAD, replies: [{ thread: 11, bodyFile: 'ok.md' }] }));
  state.head = '1234567890abcdef1234567890abcdef12345678';
  const fromManifest = await cli('pr', 'reply', '7', '--batch', manifest);
  assert.strictEqual(fromManifest.status, 1);
  assert.match(fromManifest.stderr, /head has MOVED.*Nothing was posted — all 1 reply\(ies\) were held back/s);

  const fromFlag = await cli('pr', 'reply', '7', '--batch', manifest, '--expect-head', 'abcdef1');
  assert.strictEqual(fromFlag.status, 1);
  assert.match(fromFlag.stderr, /expected: abcdef1/);

  const malformed = await cli('pr', 'reply', '7', '--batch', manifest, '--expect-head', 'zzz');
  assert.strictEqual(malformed.status, 1);
  assert.match(malformed.stderr, /is not a commit sha/);
  assert.deepStrictEqual(state.writes, []);
}));

test('pr reply --batch (CLI): a failure after posting started lists what landed and exits 1', () => withFake(async ({ cli, state, file }) => {
  file('ok.md', 'Fine.');
  const manifest = file('m.json', JSON.stringify([
    { thread: 11, bodyFile: 'ok.md', status: 'fixed' },
    { thread: 12, bodyFile: 'ok.md' },
    { thread: 13, bodyFile: 'ok.md' },
  ]));
  state.failReplyOn = 12;
  const res = await cli('pr', 'reply', '7', '--batch', manifest);
  assert.strictEqual(res.status, 1);
  assert.match(res.stderr, /#2 FAILED posting the reply/);
  assert.match(res.stderr, /do NOT re-run the whole batch/);
  assert.match(res.stderr, /#1 thread 11 comment 2 \(status fixed\)/);
  assert.strictEqual(state.writes.filter((w) => w.method === 'POST').length, 2, 'stops at the failure');
  assert.ok(!state.requests.some((r) => r.includes('/threads/13/comments')), 'nothing after the failure');
}));

test('pr reply --batch (CLI): a positional threadId, --body-file or --comment next to --batch is refused', () => withFake(async ({ cli, state, file }) => {
  file('ok.md', 'Fine.');
  const manifest = file('m.json', JSON.stringify([{ thread: 11, bodyFile: 'ok.md' }]));
  const positional = await cli('pr', 'reply', '7', '11', '--batch', manifest);
  assert.strictEqual(positional.status, 1);
  assert.match(positional.stderr, /takes no <threadId>/);
  const bodyFile = await cli('pr', 'reply', '7', '--batch', manifest, '--body-file', 'ok.md');
  assert.strictEqual(bodyFile.status, 1);
  assert.match(bodyFile.stderr, /--body-file does not apply to pr reply --batch/);
  assert.deepStrictEqual(state.requests, []);
}));

// pr edit-comment --append

test('pr edit-comment --append (CLI): keeps the original text and adds the new one after a blank line', () => withFake(async ({ cli, state, file }) => {
  const add = file('add.md', 'Update: fixed in the last commit.\n');
  const dry = await cli('pr', 'edit-comment', '7', '11', '--body-file', add, '--append', '--dry-run');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Would append to comment 1 in thread 11/);
  assert.match(dry.stdout, /Original finding\.\n\nSecond paragraph\.\n\nUpdate: fixed in the last commit\./);
  assert.deepStrictEqual(state.writes, []);

  const res = await cli('pr', 'edit-comment', '7', '11', '--body-file', add, '--append');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.threads[11].comments[0].content,
    'Original finding.\n\nSecond paragraph.\n\nUpdate: fixed in the last commit.\n');
  assert.match(res.stdout, /Comment 1 in thread 11 appended to\./);
  assert.deepStrictEqual(state.writes.map((w) => w.method), ['PATCH']);
}));

test('pr edit-comment --append (CLI): --comment picks the comment; a missing comment or another PR\'s thread writes nothing', () => withFake(async ({ cli, state, file }) => {
  state.threads[12].comments.push({ id: 2, parentCommentId: 1, content: 'my reply', commentType: 'text' });
  const add = file('add.md', 'more');
  const res = await cli('pr', 'edit-comment', '7', '12', '--body-file', add, '--append', '--comment', '2');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.threads[12].comments[1].content, 'my reply\n\nmore');
  assert.strictEqual(state.threads[12].comments[0].content, 'PR-level note');

  const writes = state.writes.length;
  const noComment = await cli('pr', 'edit-comment', '7', '12', '--body-file', add, '--append', '--comment', '9');
  assert.strictEqual(noComment.status, 1);
  assert.match(noComment.stderr, /Comment 9 is not in thread 12/);
  const otherPr = await cli('pr', 'edit-comment', '7', '99', '--body-file', add, '--append');
  assert.strictEqual(otherPr.status, 1);
  assert.match(otherPr.stderr, /Thread 99 is not on PR #7/);
  assert.strictEqual(state.writes.length, writes);
}));

test('pr edit-comment without --append still replaces the comment', () => withFake(async ({ cli, state, file }) => {
  const body = file('new.md', 'Replaced.');
  const res = await cli('pr', 'edit-comment', '7', '11', '--body-file', body);
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.threads[11].comments[0].content, 'Replaced.');
}));

test('unknown flags still abort the new commands before any request', () => withFake(async ({ cli, state, file }) => {
  const add = file('add.md', 'x');
  const typo = await cli('pr', 'edit-comment', '7', '11', '--body-file', add, '--apend');
  assert.strictEqual(typo.status, 1);
  assert.match(typo.stderr, /Unknown flag\(s\) — nothing was run:\n {2}--apend {3}did you mean --append\?/);
  const yes = await cli('pr', 'thread-status', '7', '11', 'fixed', '--yess');
  assert.strictEqual(yes.status, 1);
  assert.match(yes.stderr, /--yess {3}did you mean --yes\?/);
  const batch = await cli('pr', 'reply', '7', '--batch', 'm.json', '--dryrun');
  assert.strictEqual(batch.status, 1);
  assert.match(batch.stderr, /--dryrun {3}did you mean --dry-run\?/);
  const json = await cli('pr', 'thread-status', '7', '11', 'fixed', '--json');
  assert.strictEqual(json.status, 1);
  assert.match(json.stderr, /--json is not supported by "pr thread-status"/);
  assert.deepStrictEqual(state.requests, []);
}));
