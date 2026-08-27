/**
 * The hosted verifier hashes the same way Node does.
 *
 * apps/verifier/test/parity.test.ts pins the original page by re-typing its
 * helpers into the test. This one goes further and imports apps/web/hash.js
 * directly, so it checks the code the browser actually runs rather than a copy of
 * it. If someone edits hash.js, this fails; if someone edits packages/merkle, this
 * fails. That is the whole point: the two implementations are one contract, and a
 * silent divergence turns every published proof into a false negative.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { leafFor } from '../../canonicalize/src/snapshot.ts';
import { leafHash as nodeLeafHash, proof, root } from '../../merkle/src/index.ts';
import * as web from '../../../apps/web/hash.js';
import { fixtureRecords } from './fixture.ts';

const records = fixtureRecords();

test('the browser leaf hash equals the Node leaf hash', async () => {
  for (const r of records) {
    const inBrowser = web.hex(await web.leafHash(web.leafPreimage(r.table, r.id, r.byteHash)));
    assert.equal(inBrowser, leafFor(r).toString('hex'), `${r.table} ${r.id}`);
  }
});

test('the browser node hash equals the Node node hash', async () => {
  const left = nodeLeafHash('left');
  const right = nodeLeafHash('right');
  const inBrowser = web.hex(
    await web.nodeHash(new Uint8Array(left), new Uint8Array(right)),
  );
  const inNode = root([left, right]).toString('hex');
  assert.equal(inBrowser, inNode);
});

test('every leaf recomputes the Node root through the browser code path', async () => {
  const leaves = records.map(leafFor);
  const expected = root(leaves).toString('hex');
  for (let i = 0; i < records.length; i++) {
    const document = { ...records[i], proof: proof(leaves, i) };
    assert.equal(await web.recompute(document), expected, `leaf ${i}`);
  }
});

test('a tampered record hash fails to recompute the root', async () => {
  const leaves = records.map(leafFor);
  const expected = root(leaves).toString('hex');
  const tampered = { ...records[3], byteHash: 'ff'.repeat(32), proof: proof(leaves, 3) };
  assert.notEqual(await web.recompute(tampered), expected);
});

test('a tampered audit path step fails to recompute the root', async () => {
  const leaves = records.map(leafFor);
  const expected = root(leaves).toString('hex');
  const path = proof(leaves, 2);
  path[0] = { ...path[0], hash: 'ab'.repeat(32) };
  assert.notEqual(await web.recompute({ ...records[2], proof: path }), expected);
});

test('flipping a step side fails to recompute the root', async () => {
  const leaves = records.map(leafFor);
  const expected = root(leaves).toString('hex');
  const path = proof(leaves, 5);
  const flipped = path.map((s) => ({ ...s, side: s.side === 'left' ? 'right' : 'left' }));
  assert.notEqual(await web.recompute({ ...records[5], proof: flipped }), expected);
});

test('the page still states plainly what a passing check does not prove', async () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const page = await readFile(`${here}../../../apps/web/verify.html`, 'utf8');
  // The claim itself lives in the catalogue; the page has to actually render it.
  assert.match(page, /data-t="note\.provesWhat"/);
  assert.match(page, /data-t="note\.forwardOnly"/);
});
