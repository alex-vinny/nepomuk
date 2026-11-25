'use strict';

// Unit tests for the review guardrails and reference-line helpers.
// No network, no PAT. Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');

const { checkExpectedHead, latestHeadCommit, threadsAnchoredAt } = require('../lib/pr');
const { projectFromAreaPath, azureUrl, prLinkLine, wiLinkLine } = require('../lib/links');
const { classifyFieldValue, parseRuleValidationErrors } = require('../lib/workitem');

// ── checkExpectedHead ────────────────────────────────────────────────────────
test('checkExpectedHead: exact match passes', () => {
  const r = checkExpectedHead('e7ce42687f0a1b2c3d4e5f60718293a4b5c6d7e8', 'e7ce42687f0a1b2c3d4e5f60718293a4b5c6d7e8');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.reason, 'match');
});

test('checkExpectedHead: a short sha matches by prefix, which is how shas get quoted', () => {
  assert.strictEqual(checkExpectedHead('e7ce42687f0a1b2c3d4e5f60718293a4b5c6d7e8', 'e7ce426').ok, true);
  assert.strictEqual(checkExpectedHead('E7CE42687F0A1B2C3D4E5F60718293A4B5C6D7E8', 'e7ce426').ok, true);
});

test('checkExpectedHead: a head that moved is rejected — the real failure this guards', () => {
  // b31b63dc89 -> b552f9d7f9 -> e7ce42687f during one review.
  const r = checkExpectedHead('e7ce42687f0a1b2c3d4e5f60718293a4b5c6d7e8', 'b31b63dc89');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'moved');
  assert.strictEqual(r.expected, 'b31b63dc89');
});

test('checkExpectedHead: no expectation is not a failure', () => {
  assert.strictEqual(checkExpectedHead('abc1234', null).ok, true);
  assert.strictEqual(checkExpectedHead('abc1234', '').reason, 'no-expectation');
});

test('checkExpectedHead: a malformed sha is rejected rather than silently passing', () => {
  assert.strictEqual(checkExpectedHead('abc1234def', 'not-a-sha').reason, 'malformed');
  assert.strictEqual(checkExpectedHead('abc1234def', 'abc').reason, 'malformed'); // too short
});

test('checkExpectedHead: an unknown current head never counts as a match', () => {
  assert.strictEqual(checkExpectedHead(null, 'b31b63dc89').ok, false);
  assert.strictEqual(checkExpectedHead(null, 'b31b63dc89').reason, 'unknown-head');
});

test('latestHeadCommit: takes the source side of the last iteration', () => {
  const its = { value: [
    { id: 1, sourceRefCommit: { commitId: 'aaa' } },
    { id: 2, sourceRefCommit: { commitId: 'bbb' } },
  ] };
  assert.strictEqual(latestHeadCommit(its), 'bbb');
  assert.strictEqual(latestHeadCommit({ value: [] }), null);
  assert.strictEqual(latestHeadCommit(null), null);
});

// ── threadsAnchoredAt ────────────────────────────────────────────────────────
const THREADS = { value: [
  { id: 1, status: 'active', threadContext: { filePath: '/Src/App/Page.tsx', rightFileStart: { line: 42 } },
    comments: [{ content: '**Critical** — missing index\nmore text' }] },
  { id: 2, status: 'fixed', threadContext: { filePath: '/Src/App/Page.tsx', rightFileStart: { line: 99 } },
    comments: [{ content: 'another finding' }] },
  { id: 3, status: 'active', threadContext: { filePath: '/Src/App/Other.tsx', rightFileStart: { line: 42 } },
    comments: [{ content: 'a different file' }] },
  { id: 4, isDeleted: true, threadContext: { filePath: '/Src/App/Page.tsx', rightFileStart: { line: 42 } },
    comments: [{ content: 'deleted' }] },
  { id: 5, status: 'active', comments: [{ content: 'PR-level' }] },
] };

test('threadsAnchoredAt: finds the thread already on that file and line', () => {
  const hits = threadsAnchoredAt(THREADS, '/Src/App/Page.tsx', 42);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, 1);
  assert.strictEqual(hits[0].firstLine, '**Critical** — missing index');
});

test('threadsAnchoredAt: path casing and leading slash do not hide a duplicate', () => {
  assert.strictEqual(threadsAnchoredAt(THREADS, 'src/app/page.tsx', 42).length, 1);
  assert.strictEqual(threadsAnchoredAt(THREADS, 'Src\\App\\Page.tsx', 42).length, 1);
});

test('threadsAnchoredAt: a deleted thread is not a duplicate', () => {
  assert.ok(!threadsAnchoredAt(THREADS, '/Src/App/Page.tsx', 42).some((t) => t.id === 4));
});

test('threadsAnchoredAt: a different line or file is not a duplicate', () => {
  assert.strictEqual(threadsAnchoredAt(THREADS, '/Src/App/Page.tsx', 43).length, 0);
  assert.strictEqual(threadsAnchoredAt(THREADS, '/Src/App/Nope.tsx', 42).length, 0);
});

test('threadsAnchoredAt: a null line matches only file-level threads', () => {
  assert.strictEqual(threadsAnchoredAt(THREADS, '/Src/App/Page.tsx', null).length, 0);
  assert.strictEqual(threadsAnchoredAt(THREADS, '', 42).length, 0);
});

// ── links ────────────────────────────────────────────────────────────────────
test('projectFromAreaPath: the root segment is the project name', () => {
  assert.strictEqual(projectFromAreaPath('Contoso Labs\\Digital\\Squad 4'), 'Contoso Labs');
  assert.strictEqual(projectFromAreaPath('Platform\\CORP'), 'Platform');
  assert.strictEqual(projectFromAreaPath('Platform'), 'Platform');
  assert.strictEqual(projectFromAreaPath('Contoso Labs/Digital'), 'Contoso Labs');
});

test('projectFromAreaPath: returns null rather than guessing a default', () => {
  assert.strictEqual(projectFromAreaPath(''), null);
  assert.strictEqual(projectFromAreaPath(null), null);
});

test('azureUrl: spaces in project and repo become %20', () => {
  assert.strictEqual(
    azureUrl({ org: 'contoso', project: 'Contoso Labs', kind: 'pr', repo: 'Web App', id: 22838 }),
    'https://dev.azure.com/contoso/Contoso%20Labs/_git/Web%20App/pullrequest/22838'
  );
  assert.strictEqual(
    azureUrl({ org: 'contoso', project: 'Contoso Labs', kind: 'wi', id: 67209 }),
    'https://dev.azure.com/contoso/Contoso%20Labs/_workitems/edit/67209'
  );
});

test('azureUrl: refuses to build a URL without a project', () => {
  assert.throws(() => azureUrl({ org: 'contoso', kind: 'wi', id: 1 }), /project is required/);
  assert.throws(() => azureUrl({ org: 'contoso', project: 'P', kind: 'pr', id: 1 }), /repo is required/);
});

test('prLinkLine: link title is the same URL lowercased', () => {
  const line = prLinkLine({
    org: 'contoso', project: 'Platform', repo: 'svc-kanban', prId: 22838,
    title: 'Fix chat ordering', wiId: 67209,
  });
  assert.strictEqual(
    line,
    '[Pull Request 22838](https://dev.azure.com/contoso/Platform/_git/svc-kanban/pullrequest/22838 '
    + '"https://dev.azure.com/contoso/platform/_git/svc-kanban/pullrequest/22838"): '
    + '[svc-kanban][PBI 67209] Fix chat ordering'
  );
});

test('prLinkLine: no work item means no empty [PBI] tag', () => {
  const line = prLinkLine({ org: 'c', project: 'P', repo: 'R', prId: 1, title: 'T' });
  assert.ok(line.includes('[R] T'));
  assert.ok(!line.includes('PBI'));
});

test('wiLinkLine: mirrors the PR shape with the type in place of the repo', () => {
  const line = wiLinkLine({ org: 'c', project: 'Contoso Labs', wiId: 67209, title: 'Chat is slow', type: 'Bug' });
  assert.ok(line.startsWith('[Work Item 67209](https://dev.azure.com/c/Contoso%20Labs/_workitems/edit/67209 '));
  assert.ok(line.endsWith('): [Bug] Chat is slow'));
});

// ── classifyFieldValue ───────────────────────────────────────────────────────
test('classifyFieldValue: empty, whitespace and empty HTML are all empty', () => {
  assert.strictEqual(classifyFieldValue(null), 'empty');
  assert.strictEqual(classifyFieldValue(''), 'empty');
  assert.strictEqual(classifyFieldValue('   '), 'empty');
  assert.strictEqual(classifyFieldValue('<div><br></div>'), 'empty');
  assert.strictEqual(classifyFieldValue('&nbsp;'), 'empty');
});

test('classifyFieldValue: a lone dot is a placeholder, not an answer', () => {
  // Three fields passed an audit as "filled" holding exactly this.
  assert.strictEqual(classifyFieldValue('.'), 'placeholder');
  assert.strictEqual(classifyFieldValue('<div>.</div>'), 'placeholder');
  assert.strictEqual(classifyFieldValue('-'), 'placeholder');
  assert.strictEqual(classifyFieldValue('N/A'), 'placeholder');
  assert.strictEqual(classifyFieldValue('TBD'), 'placeholder');
});

test('classifyFieldValue: real content is filled', () => {
  assert.strictEqual(classifyFieldValue('Fixed in source code'), 'filled');
  assert.strictEqual(classifyFieldValue('<p>Missing index on PhoneNumber_1</p>'), 'filled');
  assert.strictEqual(classifyFieldValue(0), 'filled');
});

// ── parseRuleValidationErrors ────────────────────────────────────────────────
test('parseRuleValidationErrors: pulls the field reference name out of a TF401320', () => {
  const msg = 'HTTP 400 Bad Request\n{"message":"TF401320: Rule Error for field '
    + 'Custom.6a5d4f97-b13c-4241-b9ae-c559695f6ce2. Error code: Required, HasValues."}';
  const { referenceNames } = parseRuleValidationErrors(msg);
  assert.ok(referenceNames.includes('Custom.6a5d4f97-b13c-4241-b9ae-c559695f6ce2'));
});

test('parseRuleValidationErrors: recognises Microsoft.VSTS scheduling fields', () => {
  const msg = 'TF401320: Rule Error for field Microsoft.VSTS.Scheduling.CompletedWork. Error code: Required';
  const { referenceNames } = parseRuleValidationErrors(msg);
  assert.ok(referenceNames.includes('Microsoft.VSTS.Scheduling.CompletedWork'));
});

test('parseRuleValidationErrors: finds nothing rather than inventing a field', () => {
  const { referenceNames, labels } = parseRuleValidationErrors('HTTP 500 Internal Server Error');
  assert.deepStrictEqual(referenceNames, []);
  assert.deepStrictEqual(labels, []);
});

// ── verify (wi set-field --verify) ───────────────────────────────────────────
const {
  findLostFacts, findForbiddenMarkup, looksHistoryCut, verifyFieldWrite, HISTORY_TEXT_LIMIT,
  findGeneratedBlockProblems, findPersonalData, GENERATED_BLOCK,
} = require('../lib/verify');

test('findLostFacts: a dropped number is caught — the failure that happened 3x', () => {
  const before = 'O SolicitarPagamento2 duplicou e cancelou 1 ficha de 2 vendas.';
  const after = 'O SolicitarPagamento2 duplicou e cancelou a ficha das vendas.';
  const lost = findLostFacts(before, after);
  assert.deepStrictEqual(lost.numbers, ['1', '2']);
});

test('findLostFacts: a dropped !id / #id reference is caught', () => {
  const lost = findLostFacts('Fixed in !22838, see #64100.', 'Fixed in the PR cited.');
  assert.deepStrictEqual(lost.references, ['!22838', '#64100']);
});

test('findLostFacts: a dropped link is caught', () => {
  const lost = findLostFacts('Ver https://dev.azure.com/x/y para detalhe.', 'Ver a documentacao.');
  assert.deepStrictEqual(lost.links, ['https://dev.azure.com/x/y']);
});

test('findLostFacts: losing one of several identical numbers still counts', () => {
  const lost = findLostFacts('tried 3 times, waited 3s, failed 3x', 'tried 3 times, failed 3x');
  assert.deepStrictEqual(lost.numbers, ['3']);
});

test('findLostFacts: a pure markup change loses nothing', () => {
  const lost = findLostFacts('<p>Error <b>500</b> in !22838</p>', 'Error 500 in !22838');
  assert.deepStrictEqual(lost, {});
});

test('findLostFacts: added facts are not a loss', () => {
  assert.deepStrictEqual(findLostFacts('Error 500', 'Error 500 in !22838, 3 times'), {});
});

test('findForbiddenMarkup: catches what the work-item form will not render', () => {
  const names = (t) => findForbiddenMarkup(t).map((f) => f.name);
  assert.ok(names('<p style="color:red">x</p>').includes('inline style attribute'));
  assert.ok(names('<table><tr><td>a</td></tr></table>').includes('table'));
  assert.ok(names('## Root cause').includes('raw markdown heading'));
  assert.ok(names('this is **important**').includes('raw markdown bold'));
  assert.ok(names('- first item').includes('raw markdown bullet'));
  assert.ok(names('```sql\nSELECT 1\n```').includes('markdown code fence'));
  assert.ok(names('fixed ✅').includes('emoji'));
  assert.ok(names('Cenários:\n1. envia\n2. recebe').includes('raw markdown numbered list'));
  assert.ok(names('usa `message.Body` agora').includes('raw markdown inline code'));
  assert.ok(names('ver [o PR](https://x/pr/1)').includes('raw markdown link'));
  assert.ok(names('Primeiro parágrafo.\n\nSegundo parágrafo.').includes('plain-text paragraphs'));
});

test('findForbiddenMarkup: the new markdown rules leave clean HTML alone', () => {
  const html = '<p>Primeiro.</p>\n\n<ol>\n<li>envia <code>message.Body</code></li>\n</ol>\n<p><a href="https://x/pr/1">PR</a></p>';
  assert.deepStrictEqual(findForbiddenMarkup(html), []);
  assert.deepStrictEqual(findForbiddenMarkup('```\nSELECT 1\n```').map((f) => f.name), ['markdown code fence']);
  assert.deepStrictEqual(findForbiddenMarkup('linha um\nlinha dois'), []);
});

test('findForbiddenMarkup: markdown inside a code span is an example, not markup', () => {
  assert.deepStrictEqual(findForbiddenMarkup('<ul>\n<li><code>**texto**</code> fica como está.</li>\n</ul>'), []);
  assert.deepStrictEqual(findForbiddenMarkup('<pre><code>- a\n1. b</code></pre>'), []);
  assert.deepStrictEqual(findForbiddenMarkup('<p><code>x</code> e **cru**</p>').map((f) => f.name), ['raw markdown bold']);
});

test('findForbiddenMarkup: plain-text fields skip every markdown rule', () => {
  assert.deepStrictEqual(findForbiddenMarkup('1. a\n\n`x` [l](u)', { html: false }), []);
});

test('findForbiddenMarkup: clean HTML passes', () => {
  assert.deepStrictEqual(findForbiddenMarkup('<p>Causa: <strong>indice ausente</strong></p><ul><li>a</li></ul>'), []);
});

test('findForbiddenMarkup: every rule carries a remedy, not just a rejection', () => {
  for (const f of findForbiddenMarkup('## h\n- x\n**b**\n```\n')) {
    assert.ok(f.fix && f.fix.length > 5, `${f.name} has no fix text`);
  }
});

test('looksHistoryCut: exactly 8192 characters is the history signature', () => {
  assert.strictEqual(looksHistoryCut('a'.repeat(HISTORY_TEXT_LIMIT)), true);
  assert.strictEqual(looksHistoryCut('a'.repeat(HISTORY_TEXT_LIMIT - 1)), false);
  assert.strictEqual(looksHistoryCut('a'.repeat(HISTORY_TEXT_LIMIT + 1)), false);
  // Characters, not bytes: the history cut an accented value at 8192 chars / 8411 bytes.
  assert.strictEqual(looksHistoryCut('é'.repeat(HISTORY_TEXT_LIMIT)), true);
  assert.strictEqual(looksHistoryCut('é'.repeat(HISTORY_TEXT_LIMIT / 2)), false);
});

test('verifyFieldWrite: a live baseline of 8192 chars is whole and is compared', () => {
  const before = 'x'.repeat(HISTORY_TEXT_LIMIT - 5) + ' !999';
  const v = verifyFieldWrite({ before, after: 'totally different' });
  assert.strictEqual(v.truncatedBaseline, false);
  assert.deepStrictEqual(v.lost.references, ['!999']);
});

test('verifyFieldWrite: a history-cut --against baseline skips fact-loss instead of inventing losses', () => {
  const before = 'x'.repeat(HISTORY_TEXT_LIMIT - 5) + ' !999';
  const v = verifyFieldWrite({ before, after: 'totally different', baselineFromHistory: true });
  assert.strictEqual(v.truncatedBaseline, true);
  assert.deepStrictEqual(v.lost, {});
  assert.strictEqual(v.ok, false);
});

// ── generated block ([evup-refina]) ──────────────────────────────────────────
const blk = (body) => `<p>${GENERATED_BLOCK.start} por /evup-refina em 2026-11-25</p>${body}<p>${GENERATED_BLOCK.end}</p>`;
const names = (hits) => hits.map((h) => h.name);

test('findGeneratedBlockProblems: text written around an intact block passes', () => {
  const before = `<p>relato</p>${blk('<p>report</p>')}`;
  assert.deepStrictEqual(findGeneratedBlockProblems(before, `<p>relato novo</p>${blk('<p>report</p>')}`), []);
  assert.deepStrictEqual(findGeneratedBlockProblems('', '<p>sem bloco</p>'), []);
});

test('findGeneratedBlockProblems: dropped, broken, duplicated and reversed blocks are caught', () => {
  const before = blk('<p>r</p>');
  assert.deepStrictEqual(names(findGeneratedBlockProblems(before, '<p>reescrito</p>')), ['generated block dropped']);
  assert.deepStrictEqual(names(findGeneratedBlockProblems(before, `<p>${GENERATED_BLOCK.start}</p><p>r</p>`)), ['generated block broken']);
  assert.deepStrictEqual(names(findGeneratedBlockProblems(before, blk('a') + blk('b'))), ['generated block duplicated']);
  const reversed = `<p>${GENERATED_BLOCK.end}</p><p>r</p><p>${GENERATED_BLOCK.start}</p>`;
  assert.deepStrictEqual(names(findGeneratedBlockProblems(before, reversed)), ['generated block reversed']);
});

// ── personal data ────────────────────────────────────────────────────────────
test('findPersonalData: CPF, phone, bare 11 digits and e-mail are caught, by kind and count only', () => {
  const hits = findPersonalData('<p>CPF 123.456.789-00, tel (11) 98765-4321, cel 11987654321, mail fulano@exemplo.com.br</p>');
  assert.deepStrictEqual(hits, [
    { name: 'CPF', count: 1 },
    { name: 'phone number', count: 1 },
    { name: '11-digit number (CPF or mobile phone)', count: 1 },
    { name: 'e-mail address', count: 1 },
  ]);
  // The verdict never carries the matched text.
  assert.ok(!JSON.stringify(hits).includes('98765'));
});

test('findPersonalData: ids, versions, migrations, dates, GUIDs and links are not personal data', () => {
  const text = [
    '<p>Migration202611031214 sobe com svc-kanban 20261112.4-rc e elos 20261113.8-rc.</p>',
    '<p>Card 1688003, quadro 417, PR !25560, item #69444, em 16/11/2026 e 2026-11-25T14:00:00Z.</p>',
    '<p><img src="https://dev.azure.com/evuptec/930419c4-6662-46df-9c4d-ec0af4f66293/_apis/wit/attachments/d6ae946a-7fbc-4b0f-a0e1-ef0907f9093f?fileName=a.png"></p>',
    '<p>323.131 emblemas, 99,98% conformes, commit 7ed3de70.</p>',
  ].join('');
  assert.deepStrictEqual(findPersonalData(text), []);
});

test('verifyFieldWrite: clean rewrite is ok', () => {
  const v = verifyFieldWrite({
    before: '<p>Error 500 in !22838</p>',
    after: '<p>Error <strong>500</strong> seen in !22838.</p>',
  });
  assert.strictEqual(v.ok, true);
});
