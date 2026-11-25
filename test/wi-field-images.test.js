'use strict';

// Local images in a long-form field (`wi set-field --attach-images`). Pure helpers only.
// Run: node --test   (from the azure-connector dir)

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  findLocalFieldImages, rewriteFieldImageSources, classifyFieldImage, listAttachmentsFromRelations, markdownToFieldHtml,
} = require('../lib/workitem');

const BASE = path.resolve('/tmp/body');

test('findLocalFieldImages: a relative src resolves against the body folder', () => {
  const refs = findLocalFieldImages('<p>a</p><img src="./shot.png" alt="x">', { baseDir: BASE });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref, './shot.png');
  assert.equal(refs[0].file, path.resolve(BASE, 'shot.png'));
});

test('findLocalFieldImages: urls with a scheme and protocol-relative ones are left out', () => {
  const html = '<img src="https://dev.azure.com/o/p/_apis/wit/attachments/x"><img src="data:image/png;base64,AA"><img src="//h/x.png">';
  assert.deepStrictEqual(findLocalFieldImages(html, { baseDir: BASE }), []);
});

test('findLocalFieldImages: a Windows drive path is local, not a scheme', () => {
  const refs = findLocalFieldImages('<img src="D:\\prints\\a.png"><img src="D:/prints/b.png">', { baseDir: BASE });
  assert.equal(refs.length, 2);
  assert.equal(refs[0].ref, 'D:\\prints\\a.png');
  assert.equal(refs[1].ref, 'D:/prints/b.png');
});

test('findLocalFieldImages: single quotes, entities and %-escapes are read as the file name', () => {
  const refs = findLocalFieldImages("<img alt='a' src='./Print%20QA&amp;1.png'>", { baseDir: BASE });
  assert.equal(refs[0].ref, './Print QA&1.png');
});

test('findLocalFieldImages: markdown converted by --from-markdown is found too', () => {
  const html = markdownToFieldHtml('Tela nova:\n\n![tela](./tela.png)');
  const refs = findLocalFieldImages(html, { baseDir: BASE });
  assert.equal(refs.length, 1);
  assert.equal(refs[0].file, path.resolve(BASE, 'tela.png'));
});

test('rewriteFieldImageSources: only the src value changes, every other byte stays', () => {
  const html = '<p>antes</p><img src="./a.png" alt="A"><p>meio</p><img alt="B" src="./b.png"><p>fim</p>';
  const refs = findLocalFieldImages(html, { baseDir: BASE });
  const out = rewriteFieldImageSources(html, refs, (r) => `https://h/${path.basename(r.file)}?fileName=${path.basename(r.file)}`);
  assert.equal(out, '<p>antes</p><img src="https://h/a.png?fileName=a.png" alt="A"><p>meio</p><img alt="B" src="https://h/b.png?fileName=b.png"><p>fim</p>');
});

test('rewriteFieldImageSources: the url is escaped inside the attribute', () => {
  const html = '<img src="./a.png">';
  const out = rewriteFieldImageSources(html, findLocalFieldImages(html, { baseDir: BASE }), () => 'https://h/x?a=1&b="2"');
  assert.equal(out, '<img src="https://h/x?a=1&amp;b=&quot;2&quot;">');
});

test('classifyFieldImage: a new name is uploaded', () => {
  assert.deepStrictEqual(classifyFieldImage({ name: 'a.png', size: 10, existing: [{ name: 'b.png', size: 10, url: 'u' }] }), { action: 'upload' });
});

test('classifyFieldImage: same name and size (or unknown size) is compared byte for byte, case-insensitive', () => {
  const existing = [{ name: 'A.PNG', size: 10, url: 'u1' }, { name: 'a.png', size: null, url: 'u2' }, { name: 'a.png', size: 99, url: 'u3' }];
  const v = classifyFieldImage({ name: 'a.png', size: 10, existing });
  assert.equal(v.action, 'compare');
  assert.deepStrictEqual(v.candidates.map((c) => c.url), ['u1', 'u2']);
});

test('classifyFieldImage: same name, different size is a conflict that names both sizes', () => {
  const v = classifyFieldImage({ name: 'a.png', size: 10, existing: [{ name: 'a.png', size: 20, url: 'u' }] });
  assert.equal(v.action, 'conflict');
  assert.match(v.message, /20 bytes; the file has 10/);
});

test('listAttachmentsFromRelations: carries the size Azure reports, null when absent', () => {
  const rel = [
    { rel: 'AttachedFile', url: 'u1', attributes: { name: 'a.png', resourceSize: 123 } },
    { rel: 'AttachedFile', url: 'u2', attributes: { name: 'b.png' } },
  ];
  assert.deepStrictEqual(listAttachmentsFromRelations(rel).map((a) => a.size), [123, null]);
});
