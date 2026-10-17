'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { buildRerunPayload } = require('../lib/build');

// Azure refuses to queue a string template parameter set to '' ("The 'modulos' parameter is not
// a valid String."), so blank ones are left out and fall back to the pipeline default.
test('buildRerunPayload: drops blank template parameters, keeps the rest', () => {
  const p = buildRerunPayload({
    definition: { id: 1 },
    sourceBranch: 'refs/heads/x',
    templateParameters: { modulos: '', shard: '', fixtureDiaria: 'true', maxFalhas: '-1', todos: 'False' },
  });
  assert.deepStrictEqual(p.templateParameters, { fixtureDiaria: 'true', maxFalhas: '-1', todos: 'False' });
});

test('buildRerunPayload: only blank template parameters → omitted', () => {
  const p = buildRerunPayload({ definition: { id: 1 }, sourceBranch: 'refs/heads/x', templateParameters: { a: '' } });
  assert.strictEqual('templateParameters' in p, false);
});
