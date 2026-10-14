'use strict';

// Unit tests for work item → work item links. No Azure, no PAT.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { resolveLinkType, relationTargetId, findExistingLink, buildAddLinkOps, addLink } = require('../lib/relations');

test('resolveLinkType: defaults to related and maps every accepted name', () => {
  assert.strictEqual(resolveLinkType(undefined), 'System.LinkTypes.Related');
  assert.strictEqual(resolveLinkType('Related'), 'System.LinkTypes.Related');
  assert.strictEqual(resolveLinkType('parent'), 'System.LinkTypes.Hierarchy-Reverse');
  assert.strictEqual(resolveLinkType('child'), 'System.LinkTypes.Hierarchy-Forward');
  assert.strictEqual(resolveLinkType('predecessor'), 'System.LinkTypes.Dependency-Reverse');
  assert.strictEqual(resolveLinkType('successor'), 'System.LinkTypes.Dependency-Forward');
  assert.strictEqual(resolveLinkType('duplicate'), 'System.LinkTypes.Duplicate-Forward');
  assert.strictEqual(resolveLinkType('duplicate-of'), 'System.LinkTypes.Duplicate-Reverse');
});

test('resolveLinkType: unknown name lists the accepted ones', () => {
  assert.throws(() => resolveLinkType('relates'), /Unknown link type "relates".*related, parent, child/);
});

test('relationTargetId: reads the id at the end of a relation url, project segment or not', () => {
  assert.strictEqual(relationTargetId('https://dev.azure.com/org/_apis/wit/workItems/67781'), 67781);
  assert.strictEqual(relationTargetId('https://dev.azure.com/org/6f1c-guid/_apis/wit/workItems/42/'), 42);
  assert.strictEqual(relationTargetId('vstfs:///Git/PullRequestId/x%2Fy%2F12'), null);
  assert.strictEqual(relationTargetId(undefined), null);
});

test('findExistingLink: matches type AND target, not either alone', () => {
  const rels = [
    { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'https://x/_apis/wit/workItems/67484' },
    { rel: 'System.LinkTypes.Related', url: 'https://x/guid/_apis/wit/workItems/67781' },
  ];
  assert.ok(findExistingLink(rels, 'System.LinkTypes.Related', 67781));
  assert.strictEqual(findExistingLink(rels, 'System.LinkTypes.Related', 67484), null);
  assert.strictEqual(findExistingLink(rels, 'System.LinkTypes.Hierarchy-Forward', 67781), null);
  assert.strictEqual(findExistingLink(undefined, 'System.LinkTypes.Related', 1), null);
});

test('buildAddLinkOps: one add op, comment only when given', () => {
  const ops = buildAddLinkOps({ base: 'https://dev.azure.com/org', rel: 'System.LinkTypes.Related', targetId: 7 });
  assert.deepStrictEqual(ops, [{
    op: 'add', path: '/relations/-',
    value: { rel: 'System.LinkTypes.Related', url: 'https://dev.azure.com/org/_apis/wit/workItems/7' },
  }]);
  const withComment = buildAddLinkOps({ base: 'b', rel: 'r', targetId: 1, comment: 'gêmeo' });
  assert.deepStrictEqual(withComment[0].value.attributes, { comment: 'gêmeo' });
});

test('addLink: refuses a self link before any call', async () => {
  await assert.rejects(() => addLink({ config: {}, id: 5, targetId: 5, type: 'related' }), /cannot be linked to itself/);
});
