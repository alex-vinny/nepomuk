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
    comments: [{ content: '**Crítico** — índice ausente\nmais texto' }] },
  { id: 2, status: 'fixed', threadContext: { filePath: '/Src/App/Page.tsx', rightFileStart: { line: 99 } },
    comments: [{ content: 'outro achado' }] },
  { id: 3, status: 'active', threadContext: { filePath: '/Src/App/Other.tsx', rightFileStart: { line: 42 } },
    comments: [{ content: 'arquivo diferente' }] },
  { id: 4, isDeleted: true, threadContext: { filePath: '/Src/App/Page.tsx', rightFileStart: { line: 42 } },
    comments: [{ content: 'apagado' }] },
  { id: 5, status: 'active', comments: [{ content: 'PR-level' }] },
] };

test('threadsAnchoredAt: finds the thread already on that file and line', () => {
  const hits = threadsAnchoredAt(THREADS, '/Src/App/Page.tsx', 42);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, 1);
  assert.strictEqual(hits[0].firstLine, '**Crítico** — índice ausente');
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
  assert.strictEqual(projectFromAreaPath('Kanban EL\\Digital\\Squad 4'), 'Kanban EL');
  assert.strictEqual(projectFromAreaPath('EVUP\\CORP'), 'EVUP');
  assert.strictEqual(projectFromAreaPath('EVUP'), 'EVUP');
  assert.strictEqual(projectFromAreaPath('Kanban EL/Digital'), 'Kanban EL');
});

test('projectFromAreaPath: returns null rather than guessing a default', () => {
  assert.strictEqual(projectFromAreaPath(''), null);
  assert.strictEqual(projectFromAreaPath(null), null);
});

test('azureUrl: spaces in project and repo become %20', () => {
  assert.strictEqual(
    azureUrl({ org: 'contoso', project: 'VOE.IT - Espaco Laser', kind: 'pr', repo: 'EVUP - ELOS', id: 22838 }),
    'https://dev.azure.com/contoso/VOE.IT%20-%20Espaco%20Laser/_git/EVUP%20-%20ELOS/pullrequest/22838'
  );
  assert.strictEqual(
    azureUrl({ org: 'contoso', project: 'Kanban EL', kind: 'wi', id: 67209 }),
    'https://dev.azure.com/contoso/Kanban%20EL/_workitems/edit/67209'
  );
});

test('azureUrl: refuses to build a URL without a project', () => {
  assert.throws(() => azureUrl({ org: 'contoso', kind: 'wi', id: 1 }), /project is required/);
  assert.throws(() => azureUrl({ org: 'contoso', project: 'P', kind: 'pr', id: 1 }), /repo is required/);
});

test('prLinkLine: link title is the same URL lowercased', () => {
  const line = prLinkLine({
    org: 'contoso', project: 'ELOS', repo: 'ELOS-SVC-KANBAN', prId: 22838,
    title: 'Ajusta ordenação do chat', wiId: 67209,
  });
  assert.strictEqual(
    line,
    '[Pull Request 22838](https://dev.azure.com/contoso/ELOS/_git/ELOS-SVC-KANBAN/pullrequest/22838 '
    + '"https://dev.azure.com/contoso/elos/_git/elos-svc-kanban/pullrequest/22838"): '
    + '[ELOS-SVC-KANBAN][PBI 67209] Ajusta ordenação do chat'
  );
});

test('prLinkLine: no work item means no empty [PBI] tag', () => {
  const line = prLinkLine({ org: 'c', project: 'P', repo: 'R', prId: 1, title: 'T' });
  assert.ok(line.includes('[R] T'));
  assert.ok(!line.includes('PBI'));
});

test('wiLinkLine: mirrors the PR shape with the type in place of the repo', () => {
  const line = wiLinkLine({ org: 'c', project: 'Kanban EL', wiId: 67209, title: 'Chat lento', type: 'Bug' });
  assert.ok(line.startsWith('[Work Item 67209](https://dev.azure.com/c/Kanban%20EL/_workitems/edit/67209 '));
  assert.ok(line.endsWith('): [Bug] Chat lento'));
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
  assert.strictEqual(classifyFieldValue('Correção em Código Fonte'), 'filled');
  assert.strictEqual(classifyFieldValue('<p>Índice ausente em PhoneNumber_1</p>'), 'filled');
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
  findLostFacts, findForbiddenMarkup, looksTruncated, verifyFieldWrite, TRUNCATION_BYTES,
} = require('../lib/verify');

test('findLostFacts: a dropped number is caught — the failure that happened 3x', () => {
  const before = 'O SolicitarPagamento2 duplicou e cancelou 1 ficha de 2 vendas.';
  const after = 'O SolicitarPagamento2 duplicou e cancelou a ficha das vendas.';
  const lost = findLostFacts(before, after);
  assert.deepStrictEqual(lost.numbers, ['1', '2']);
});

test('findLostFacts: a dropped !id / #id reference is caught', () => {
  const lost = findLostFacts('Corrigido em !22838, ver #65631.', 'Corrigido no PR citado.');
  assert.deepStrictEqual(lost.references, ['!22838', '#65631']);
});

test('findLostFacts: a dropped link is caught', () => {
  const lost = findLostFacts('Ver https://dev.azure.com/x/y para detalhe.', 'Ver a documentacao.');
  assert.deepStrictEqual(lost.links, ['https://dev.azure.com/x/y']);
});

test('findLostFacts: losing one of several identical numbers still counts', () => {
  const lost = findLostFacts('tentou 3 vezes, esperou 3s, falhou 3x', 'tentou 3 vezes, falhou 3x');
  assert.deepStrictEqual(lost.numbers, ['3']);
});

test('findLostFacts: a pure markup change loses nothing', () => {
  const lost = findLostFacts('<p>Erro <b>500</b> em !22838</p>', 'Erro 500 em !22838');
  assert.deepStrictEqual(lost, {});
});

test('findLostFacts: added facts are not a loss', () => {
  assert.deepStrictEqual(findLostFacts('Erro 500', 'Erro 500 em !22838, 3 vezes'), {});
});

test('findForbiddenMarkup: catches what the work-item form will not render', () => {
  const names = (t) => findForbiddenMarkup(t).map((f) => f.name);
  assert.ok(names('<p style="color:red">x</p>').includes('inline style attribute'));
  assert.ok(names('<table><tr><td>a</td></tr></table>').includes('table'));
  assert.ok(names('## Causa raiz').includes('raw markdown heading'));
  assert.ok(names('isto e **importante**').includes('raw markdown bold'));
  assert.ok(names('- primeiro item').includes('raw markdown bullet'));
  assert.ok(names('```sql\nSELECT 1\n```').includes('markdown code fence'));
  assert.ok(names('corrigido ✅').includes('emoji'));
});

test('findForbiddenMarkup: clean HTML passes', () => {
  assert.deepStrictEqual(findForbiddenMarkup('<p>Causa: <strong>indice ausente</strong></p><ul><li>a</li></ul>'), []);
});

test('findForbiddenMarkup: every rule carries a remedy, not just a rejection', () => {
  for (const f of findForbiddenMarkup('## h\n- x\n**b**\n```\n')) {
    assert.ok(f.fix && f.fix.length > 5, `${f.name} has no fix text`);
  }
});

test('looksTruncated: exactly 8192 bytes is the truncation signature', () => {
  assert.strictEqual(looksTruncated('a'.repeat(TRUNCATION_BYTES)), true);
  assert.strictEqual(looksTruncated('a'.repeat(TRUNCATION_BYTES - 1)), false);
  assert.strictEqual(looksTruncated('a'.repeat(TRUNCATION_BYTES + 1)), false);
  // Byte length, not character length — accents must not fool it.
  assert.strictEqual(looksTruncated('é'.repeat(TRUNCATION_BYTES / 2)), true);
});

test('verifyFieldWrite: a truncated baseline skips fact-loss instead of inventing losses', () => {
  const before = 'x'.repeat(TRUNCATION_BYTES - 5) + ' !999';
  assert.strictEqual(Buffer.byteLength(before), TRUNCATION_BYTES);
  const v = verifyFieldWrite({ before, after: 'totally different' });
  assert.strictEqual(v.truncatedBaseline, true);
  assert.deepStrictEqual(v.lost, {});
  assert.strictEqual(v.ok, false);
});

test('verifyFieldWrite: clean rewrite is ok', () => {
  const v = verifyFieldWrite({
    before: '<p>Erro 500 em !22838</p>',
    after: '<p>Erro <strong>500</strong> observado em !22838.</p>',
  });
  assert.strictEqual(v.ok, true);
});
