'use strict';

// Same-level parent/child guard, `wi relink` / `wi unlink`, and the Content-Type of `raw`.
// Pure helpers first, then the CLI end to end against a fake Azure on an ephemeral port.
// No real Azure, no PAT. Run: node --test   (from the azure-connector dir)

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { backlogLevels, hierarchyConflict, conflictMessage } = require('../lib/hierarchy');
const { linksTo, pickLink, buildReplaceLinkOps, linkName } = require('../lib/relations');
const { rawContentType } = require('../index.js');

// ── fixtures ────────────────────────────────────────────────────────────────

const BACKLOG = {
  portfolioBacklogs: [
    { name: 'Epics', rank: 4, workItemTypes: [{ name: 'Epic' }] },
    { name: 'Features', rank: 3, workItemTypes: [{ name: 'Feature' }] },
  ],
  requirementBacklog: { name: 'Backlog items', rank: 2, workItemTypes: [{ name: 'Product Backlog Item' }, { name: 'Support Request' }] },
  taskBacklog: { name: 'Tasks', rank: 1, workItemTypes: [{ name: 'Task' }, { name: 'Review Task' }] },
  bugsBehavior: 'asRequirements',
};

const WI = (id) => `https://fake/acme/_apis/wit/workItems/${id}`;

// ── pure: levels and conflicts ──────────────────────────────────────────────

test('backlogLevels: every backlog type gets its level; bug types join the level bugsBehavior names', () => {
  const levels = backlogLevels(BACKLOG, ['Bug']);
  assert.deepStrictEqual(levels.get('feature'), { level: 'Features', rank: 3 });
  assert.deepStrictEqual(levels.get('product backlog item'), { level: 'Backlog items', rank: 2 });
  assert.deepStrictEqual(levels.get('review task'), { level: 'Tasks', rank: 1 });
  assert.deepStrictEqual(levels.get('bug'), { level: 'Backlog items', rank: 2, viaBugsBehavior: 'asRequirements' });

  assert.strictEqual(backlogLevels({ ...BACKLOG, bugsBehavior: 'asTasks' }, ['Bug']).get('bug').level, 'Tasks');
  assert.strictEqual(backlogLevels({ ...BACKLOG, bugsBehavior: 'off' }, ['Bug']).get('bug'), undefined, 'bugs off the backlogs');
  assert.strictEqual(backlogLevels(undefined).size, 0);
});

test('hierarchyConflict: same level is a conflict; across levels or off the backlogs is not', () => {
  const levels = backlogLevels(BACKLOG, ['Bug']);
  const c = (parentType, childType) => hierarchyConflict({ parentLevels: levels, parentType, childType });

  assert.deepStrictEqual(c('Product Backlog Item', 'Bug'), { level: 'Backlog items', viaBugsBehavior: 'asRequirements' });
  assert.deepStrictEqual(c('Task', 'Review Task'), { level: 'Tasks', viaBugsBehavior: null });
  assert.deepStrictEqual(c('Feature', 'Feature'), { level: 'Features', viaBugsBehavior: null });
  assert.strictEqual(c('Feature', 'Bug'), null);
  assert.strictEqual(c('Bug', 'Task'), null);
  assert.strictEqual(c('product backlog item', 'TASK'), null, 'type names compare case-insensitively');
  assert.strictEqual(c('Product Backlog Item', 'Test Case'), null, 'a type on no backlog cannot break one');

  const off = backlogLevels({ ...BACKLOG, bugsBehavior: 'off' }, ['Bug']);
  assert.strictEqual(hierarchyConflict({ parentLevels: off, parentType: 'Product Backlog Item', childType: 'Bug' }), null);
});

test('conflictMessage: names both items, the level, why, and both ways out', () => {
  const msg = conflictMessage({
    parent: { id: 12, type: 'Product Backlog Item' },
    child: { type: 'Bug' },
    conflict: { level: 'Backlog items', viaBugsBehavior: 'asRequirements' },
  });
  assert.match(msg, /the new Bug a child of #12 \(Product Backlog Item\)/);
  assert.match(msg, /"Backlog items" backlog level \(bugs are managed as requirements on this team\)/);
  assert.match(msg, /Related/);
  assert.match(msg, /--allow-same-level/);
});

// ── pure: picking and replacing a link ──────────────────────────────────────

const RELS = [
  { rel: 'System.LinkTypes.Related', url: WI(7) },
  { rel: 'ArtifactLink', url: 'vstfs:///Git/PullRequestId/a%2Fb%2F99' },
  { rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(12) },
  { rel: 'System.LinkTypes.Related', url: WI(12) },
];

test('linksTo: only work item links to that target, with their index in relations', () => {
  assert.deepStrictEqual(linksTo(RELS, 12).map((l) => [l.index, linkName(l.rel)]), [[2, 'parent'], [3, 'related']]);
  assert.deepStrictEqual(linksTo(RELS, 99), [], 'a PR artifact link is not a work item link');
  assert.deepStrictEqual(linksTo(undefined, 1), []);
});

test('pickLink: the only link, or the one --type names; ambiguity and absence are refused', () => {
  assert.strictEqual(pickLink(linksTo(RELS, 7), { id: 1, targetId: 7 }).index, 0);
  assert.strictEqual(pickLink(linksTo(RELS, 12), { id: 1, targetId: 12, type: 'parent' }).index, 2);
  assert.throws(() => pickLink(linksTo(RELS, 12), { id: 1, targetId: 12 }), /#1 has 2 links to #12 \(parent, related\) — pass --type/);
  assert.throws(() => pickLink(linksTo(RELS, 7), { id: 1, targetId: 7, type: 'child' }), /#1 has no child link to #7 \(it has: related\)/);
  assert.throws(() => pickLink([], { id: 1, targetId: 5 }), /#1 has no link to #5/);
});

test('buildReplaceLinkOps: revision and link are tested before the remove; relink adds the new type to the same url', () => {
  const link = { index: 2, rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(12) };
  const unlink = buildReplaceLinkOps({ rev: 4, link });
  assert.deepStrictEqual(unlink, [
    { op: 'test', path: '/rev', value: 4 },
    { op: 'test', path: '/relations/2/rel', value: 'System.LinkTypes.Hierarchy-Reverse' },
    { op: 'test', path: '/relations/2/url', value: WI(12) },
    { op: 'remove', path: '/relations/2' },
  ]);
  const relink = buildReplaceLinkOps({ rev: 4, link, newRel: 'System.LinkTypes.Related', comment: 'was parent' });
  assert.deepStrictEqual(relink.slice(0, 4), unlink);
  assert.deepStrictEqual(relink[4], {
    op: 'add', path: '/relations/-',
    value: { rel: 'System.LinkTypes.Related', url: WI(12), attributes: { comment: 'was parent' } },
  });
});

// ── pure: raw Content-Type ──────────────────────────────────────────────────

test('rawContentType: work item create/update is json-patch; everything else stays json; --content-type wins', () => {
  assert.strictEqual(rawContentType('PATCH', 'https://x/acme/P/_apis/wit/workitems/42?api-version=7.1'), 'application/json-patch+json');
  assert.strictEqual(rawContentType('patch', 'https://x/acme/_apis/wit/workItems/42'), 'application/json-patch+json');
  assert.strictEqual(rawContentType('POST', 'https://x/acme/P/_apis/wit/workitems/$Bug?api-version=7.1'), 'application/json-patch+json');
  assert.strictEqual(rawContentType('POST', 'https://x/acme/P/_apis/wit/workItems/42/comments?api-version=7.1-preview.3'), 'application/json');
  assert.strictEqual(rawContentType('POST', 'https://x/acme/P/_apis/wit/workitemsbatch?api-version=7.1'), 'application/json');
  assert.strictEqual(rawContentType('GET', 'https://x/acme/P/_apis/wit/workitems/42'), 'application/json');
  assert.strictEqual(rawContentType('PATCH', 'https://x/acme/P/_apis/git/repositories/R'), 'application/json');
  assert.strictEqual(rawContentType('PATCH', 'https://x/acme/P/_apis/git/repositories/R', 'text/plain'), 'text/plain');
});

// ── CLI end to end against a fake Azure ─────────────────────────────────────

function fakeAzure({ bugsBehavior = 'asRequirements' } = {}) {
  const items = {
    12: { type: 'Product Backlog Item', relations: [{ rel: 'System.LinkTypes.Hierarchy-Forward', url: WI(20) }] },
    13: { type: 'Feature', relations: [] },
    20: { type: 'Bug', relations: [{ rel: 'System.LinkTypes.Related', url: WI(7) }, { rel: 'System.LinkTypes.Hierarchy-Reverse', url: WI(12) }] },
    21: { type: 'Bug', relations: [] },
    22: { type: 'Bug', relations: [{ rel: 'System.LinkTypes.Related', url: WI(12) }] },
    23: { type: 'Bug', stale: true, relations: [{ rel: 'System.LinkTypes.Related', url: WI(13) }] },
    30: { type: 'Review Task', relations: [] },
  };
  const state = { requests: [], writes: [], rev: {} };
  const view = (id) => ({
    id: Number(id), rev: state.rev[id] || 4, url: WI(id),
    fields: { 'System.WorkItemType': items[id].type, 'System.TeamProject': 'P', 'System.Title': `item ${id}` },
    relations: items[id].relations,
  });
  const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const handler = (req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const [url] = req.url.split('?');
      state.requests.push(`${req.method} ${url}`);
      let m;
      if (req.method === 'GET' && /^\/acme\/P(\/[^/]+)?\/_apis\/work\/backlogconfiguration$/.test(url)) {
        return json(res, 200, { ...BACKLOG, bugsBehavior });
      }
      if (req.method === 'GET' && url === '/acme/P/_apis/wit/workitemtypecategories/Microsoft.BugCategory') {
        return json(res, 200, { referenceName: 'Microsoft.BugCategory', workItemTypes: [{ name: 'Bug' }] });
      }
      if (req.method === 'GET' && (m = /^\/acme(?:\/P)?\/_apis\/wit\/workItems\/(\d+)$/i.exec(url)) && items[m[1]]) {
        return json(res, 200, view(m[1]));
      }
      if (req.method === 'PATCH' && (m = /^\/acme(?:\/P)?\/_apis\/wit\/workItems\/(\d+)$/i.exec(url)) && items[m[1]]) {
        const ops = JSON.parse(raw || '[]');
        state.writes.push({ method: 'PATCH', id: Number(m[1]), contentType: req.headers['content-type'], ops });
        // A `stale` item was edited by someone else between our read and this PATCH.
        const live = (state.rev[m[1]] || 4) + (items[m[1]].stale ? 1 : 0);
        const revTest = ops.find((o) => o.op === 'test' && o.path === '/rev');
        if (revTest && revTest.value !== live) return json(res, 400, { message: 'fake: test operation failed for /rev' });
        state.rev[m[1]] = (state.rev[m[1]] || 4) + 1;
        return json(res, 200, view(m[1]));
      }
      if (req.method === 'POST' && (m = /^\/acme\/P\/_apis\/wit\/workitems\/\$(.+)$/i.exec(url))) {
        state.writes.push({ method: 'POST', type: decodeURIComponent(m[1]), contentType: req.headers['content-type'], ops: JSON.parse(raw || '[]') });
        return json(res, 200, { id: 99 });
      }
      return json(res, 404, { message: `fake: no route for ${req.method} ${url}` });
    });
  };
  return { state, handler };
}

function runCli(base, args, dir) {
  const env = { ...process.env, AZURE_CONFIG_FILE: path.join(dir, 'none.json'), AZURE_PAT: 'dummy', AZURE_ORG: 'acme',
    AZURE_PROJECT: 'P', AZURE_BASE_URL: base, AZURE_MAX_RETRIES: '0' };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js'), ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

function withFake(opts, fn) {
  return async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'azc-hierarchy-'));
    const fake = fakeAzure(opts);
    const server = http.createServer(fake.handler);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      await fn({ cli: (...args) => runCli(base, args, dir), state: fake.state });
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('wi create --parent: a Bug under a Product Backlog Item is refused, preview included, nothing created', withFake({}, async ({ cli, state }) => {
  for (const extra of [[], ['--yes']]) {
    const res = await cli('wi', 'create', '--project', 'P', '--type', 'Bug', '--title', 'T', '--parent', '12', ...extra);
    assert.strictEqual(res.status, 1);
    assert.match(res.stderr, /Refusing to make the new Bug a child of #12 \(Product Backlog Item\): both are on the "Backlog items" backlog level/);
    assert.doesNotMatch(res.stdout, /DRY RUN/);
  }
  assert.strictEqual(state.writes.length, 0);
}));

test('wi create --parent: a Bug under a Feature passes; the preview shows the parent type', withFake({}, async ({ cli, state }) => {
  const dry = await cli('wi', 'create', '--project', 'P', '--type', 'Bug', '--title', 'T', '--parent', '13');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /parent {5}: #13 \(Feature\)/);
  assert.strictEqual(state.writes.length, 0);

  const yes = await cli('wi', 'create', '--project', 'P', '--type', 'Bug', '--title', 'T', '--parent', '13', '--yes');
  assert.strictEqual(yes.status, 0, yes.stderr);
  assert.strictEqual(state.writes.length, 1);
  assert.strictEqual(state.writes[0].contentType, 'application/json-patch+json');
}));

test('wi create --parent: --allow-same-level creates it without reading the backlog configuration', withFake({}, async ({ cli, state }) => {
  const res = await cli('wi', 'create', '--project', 'P', '--type', 'Bug', '--title', 'T', '--parent', '12', '--allow-same-level', '--yes');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.writes.length, 1);
  assert.ok(!state.requests.some((r) => r.includes('backlogconfiguration')));
}));

test('wi create --parent: with bugs off the backlogs, a Bug under a PBI is allowed', withFake({ bugsBehavior: 'off' }, async ({ cli, state }) => {
  const res = await cli('wi', 'create', '--project', 'P', '--type', 'Bug', '--title', 'T', '--parent', '12');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.ok(!state.requests.some((r) => r.includes('BugCategory')), 'no need for the bug category when bugs are off');
}));

test('wi create --parent --team: the named team\'s backlog configuration is read', withFake({}, async ({ cli, state }) => {
  const res = await cli('wi', 'create', '--project', 'P', '--type', 'Bug', '--title', 'T', '--parent', '12', '--team', 'Squad A');
  assert.strictEqual(res.status, 1);
  assert.ok(state.requests.includes('GET /acme/P/Squad%20A/_apis/work/backlogconfiguration'), state.requests.join('\n'));
}));

test('wi create-task: a Task under a Task-level item is refused; under a PBI it previews', withFake({}, async ({ cli, state }) => {
  const bad = await cli('wi', 'create-task', 'https://dev.azure.com/acme/P/_workitems/edit/30', 'T1');
  assert.strictEqual(bad.status, 1);
  assert.match(bad.stderr, /Refusing to make the new Task a child of #30 \(Review Task\): both are on the "Tasks" backlog level/);

  const ok = await cli('wi', 'create-task', 'https://dev.azure.com/acme/P/_workitems/edit/12', 'T1');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /DRY RUN/);
  assert.strictEqual(state.writes.length, 0);
}));

test('wi add-link --type parent: same level refused, related passes, child checked from the other side', withFake({}, async ({ cli, state }) => {
  const parent = await cli('wi', 'add-link', '21', '12', '--type', 'parent', '--yes');
  assert.strictEqual(parent.status, 1);
  assert.match(parent.stderr, /Refusing to make #21 \(Bug\) a child of #12 \(Product Backlog Item\)/);

  const child = await cli('wi', 'add-link', '12', '21', '--type', 'child', '--yes');
  assert.strictEqual(child.status, 1);
  assert.match(child.stderr, /Refusing to make #21 \(Bug\) a child of #12 \(Product Backlog Item\)/);
  assert.strictEqual(state.writes.length, 0);

  const related = await cli('wi', 'add-link', '21', '12', '--yes');
  assert.strictEqual(related.status, 0, related.stderr);
  assert.strictEqual(state.writes.length, 1);

  const underFeature = await cli('wi', 'add-link', '21', '13', '--type', 'parent');
  assert.strictEqual(underFeature.status, 0, underFeature.stderr);
  assert.match(underFeature.stdout, /DRY RUN/);
}));

test('wi relink: parent → related previews, then writes one json-patch PATCH pinned to the revision', withFake({}, async ({ cli, state }) => {
  const dry = await cli('wi', 'relink', '20', '12', '--to', 'related');
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /#20 --parent--> #12 {2}becomes {2}--related-->/);
  assert.strictEqual(state.writes.length, 0);

  const yes = await cli('wi', 'relink', '20', '12', '--to', 'related', '--comment', 'same level', '--yes');
  assert.strictEqual(yes.status, 0, yes.stderr);
  assert.match(yes.stdout, /Relinked #20 --related--> #12 \(was parent\)\./);
  assert.strictEqual(state.writes.length, 1);
  const w = state.writes[0];
  assert.strictEqual(w.contentType, 'application/json-patch+json');
  assert.deepStrictEqual(w.ops.map((o) => `${o.op} ${o.path}`), ['test /rev', 'test /relations/1/rel', 'test /relations/1/url', 'remove /relations/1', 'add /relations/-']);
  assert.strictEqual(w.ops[0].value, 4);
  assert.deepStrictEqual(w.ops[4].value, { rel: 'System.LinkTypes.Related', url: WI(12), attributes: { comment: 'same level' } });
}));

test('wi relink: to a same-level parent is refused, so is a second parent; already of that type is a no-op', withFake({}, async ({ cli, state }) => {
  const sameLevel = await cli('wi', 'relink', '22', '12', '--to', 'parent', '--yes');
  assert.strictEqual(sameLevel.status, 1);
  assert.match(sameLevel.stderr, /Refusing to make #22 \(Bug\) a child of #12 \(Product Backlog Item\)/);

  const allowed = await cli('wi', 'relink', '22', '12', '--to', 'parent', '--allow-same-level');
  assert.strictEqual(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /DRY RUN/);

  const toParent = await cli('wi', 'relink', '20', '7', '--to', 'parent', '--yes');
  assert.strictEqual(toParent.status, 1);
  assert.match(toParent.stderr, /already has parent #12/);

  const same = await cli('wi', 'relink', '20', '7', '--to', 'related', '--yes');
  assert.strictEqual(same.status, 0, same.stderr);
  assert.match(same.stdout, /already has a related link to #7 — nothing to do/);
  assert.strictEqual(state.writes.length, 0);

  const missingTo = await cli('wi', 'relink', '20', '12');
  assert.strictEqual(missingTo.status, 1);
  assert.match(missingTo.stderr, /Missing --to/);
}));

test('wi unlink: removes the one link, refuses an absent one, and a stale revision writes nothing', withFake({}, async ({ cli, state }) => {
  const absent = await cli('wi', 'unlink', '20', '13', '--yes');
  assert.strictEqual(absent.status, 1);
  assert.match(absent.stderr, /#20 has no link to #13/);

  const ok = await cli('wi', 'unlink', '20', '7', '--yes');
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Unlinked #20 from #7 \(was related\)\./);
  assert.deepStrictEqual(state.writes[0].ops.map((o) => o.op), ['test', 'test', 'test', 'remove']);

  const withTo = await cli('wi', 'unlink', '20', '7', '--to', 'related');
  assert.strictEqual(withTo.status, 1);
  assert.match(withTo.stderr, /--to is for wi relink/);

  const before = state.rev[23];
  const stale = await cli('wi', 'unlink', '23', '13', '--yes');
  assert.strictEqual(stale.status, 1);
  assert.match(stale.stderr, /test operation failed for \/rev/);
  assert.match(stale.stderr, /Nothing was changed on #23: the PATCH is all-or-nothing/);
  assert.strictEqual(state.rev[23], before, 'the fake applied nothing');
}));

test('raw PATCH on a work item goes out as json-patch+json', withFake({}, async ({ cli, state }) => {
  const res = await cli('raw', 'PATCH', 'P/_apis/wit/workitems/21', '[{"op":"add","path":"/fields/System.Title","value":"x"}]');
  assert.strictEqual(res.status, 0, res.stderr);
  assert.strictEqual(state.writes[0].contentType, 'application/json-patch+json');
}));
