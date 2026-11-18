'use strict';

// Unit tests for --mention on work-item comments. No network, no PAT.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { parseMentionSpecs, mentionAnchor, applyMentions, mentionedIds, resolveMentions } = require('../lib/mentions');
const { markdownToHtml } = require('../lib/workitem');

const ID_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ID_B = '11111111-2222-3333-4444-555555555555';

test('parseMentionSpecs: comma list, trimmed, deduplicated; absent flag is no mention', () => {
  assert.deepStrictEqual(parseMentionSpecs(' creator , someone@example.com,creator '), ['creator', 'someone@example.com']);
  assert.deepStrictEqual(parseMentionSpecs(undefined), []);
});

test('parseMentionSpecs: flag without value or with only commas is refused', () => {
  assert.throws(() => parseMentionSpecs(true), /needs a value/);
  assert.throws(() => parseMentionSpecs(' , '), /empty/);
});

test('mentionAnchor: the exact markup Azure turns into a notification', () => {
  assert.strictEqual(
    mentionAnchor({ id: ID_A, displayName: 'Ana Souza' }),
    `<a href="#" data-vss-mention="version:2.0,${ID_A}">@Ana Souza</a>`);
});

test('mentionAnchor: display name is escaped; a non-guid id is refused', () => {
  assert.match(mentionAnchor({ id: ID_A, displayName: 'A <b>' }), />@A &lt;b&gt;<\/a>$/);
  assert.throws(() => mentionAnchor({ id: 'not-a-guid', displayName: 'X' }), /Invalid identity id/);
});

test('applyMentions: paragraph on top of the converted body; no mentions leaves the body untouched', () => {
  const body = markdownToHtml('**Pedido** ao N3');
  const html = applyMentions(body, [{ id: ID_A, displayName: 'Ana' }, { id: ID_B, displayName: 'Bruno' }]);
  assert.ok(html.startsWith(`<p><a href="#" data-vss-mention="version:2.0,${ID_A}">@Ana</a> <a href="#" data-vss-mention="version:2.0,${ID_B}">@Bruno</a></p>\n`));
  assert.ok(html.endsWith(body));
  assert.strictEqual(applyMentions(body, []), body);
});

test('mentionedIds: reads back the ids from stored comment html (case-insensitive)', () => {
  const html = `<p><a href="#" data-vss-mention="version:2.0,${ID_A.toUpperCase()}">@Ana</a></p><p>x</p>`;
  assert.deepStrictEqual(mentionedIds(html), [ID_A]);
  assert.deepStrictEqual(mentionedIds('<p>@Ana typed by hand</p>'), []);
});

const fields = {
  'System.CreatedBy': { id: ID_A, displayName: 'Ana' },
};

test('resolveMentions: creator comes from the item; email from the identity search', async () => {
  let fetched = 0;
  const res = await resolveMentions(['creator', 'bruno@example.com'], {
    fetchFields: async () => { fetched++; return fields; },
    searchIdentities: async (term) => (term === 'bruno@example.com'
      ? [{ id: ID_B, providerDisplayName: 'Bruno', isActive: true }] : []),
  });
  assert.deepStrictEqual(res.map((m) => [m.id, m.displayName, m.source]),
    [[ID_A, 'Ana', 'creator'], [ID_B, 'Bruno', 'bruno@example.com']]);
  assert.strictEqual(fetched, 1);
});

test('resolveMentions: unassigned item refuses assignee', async () => {
  await assert.rejects(resolveMentions(['assignee'], { fetchFields: async () => fields, searchIdentities: async () => [] }),
    /no System.AssignedTo/);
});

test('resolveMentions: no match, or more than one active match, is refused', async () => {
  await assert.rejects(resolveMentions(['ghost'], { fetchFields: async () => fields, searchIdentities: async () => [] }),
    /no active identity/);
  const two = [{ id: ID_A, providerDisplayName: 'Ana A', isActive: true }, { id: ID_B, providerDisplayName: 'Ana B', isActive: true }];
  await assert.rejects(resolveMentions(['Ana'], { fetchFields: async () => fields, searchIdentities: async () => two }),
    /matches 2 identities/);
});

test('resolveMentions: inactive identities are ignored; same person twice is mentioned once', async () => {
  const res = await resolveMentions(['creator', 'ana@example.com'], {
    fetchFields: async () => fields,
    searchIdentities: async () => [
      { id: ID_B, providerDisplayName: 'Old Ana', isActive: false },
      { id: ID_A, providerDisplayName: 'Ana', isActive: true },
    ],
  });
  assert.deepStrictEqual(res.map((m) => m.id), [ID_A]);
});
