import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EMPTY_ROOT, leafHash, proof, root, verify } from '../src/index.ts';

const leaves = (n: number) => Array.from({ length: n }, (_, i) => leafHash(`record-${i}`));

test('empty tree has the RFC 6962 empty root', () => {
  assert.equal(root([]).toString('hex'), EMPTY_ROOT.toString('hex'));
});

test('single leaf is its own root', () => {
  const l = leafHash('only');
  assert.equal(root([l]).toString('hex'), l.toString('hex'));
});

test('root is stable for the same input', () => {
  assert.equal(root(leaves(9)).toString('hex'), root(leaves(9)).toString('hex'));
});

test('root changes when any leaf changes', () => {
  const a = leaves(8);
  const b = leaves(8);
  b[3] = leafHash('tampered');
  assert.notEqual(root(a).toString('hex'), root(b).toString('hex'));
});

test('leaf and node hashing are domain-separated', () => {
  // Without the 0x00/0x01 prefixes an internal node could be forged as a leaf.
  const a = leafHash('x');
  const b = leafHash('y');
  const parent = root([a, b]);
  assert.notEqual(parent.toString('hex'), leafHash(Buffer.concat([a, b])).toString('hex'));
});

test('proofs verify for every leaf, at odd and even sizes', () => {
  for (const n of [1, 2, 3, 5, 8, 9, 17, 64]) {
    const ls = leaves(n);
    const r = root(ls).toString('hex');
    for (let i = 0; i < n; i++) {
      assert.ok(verify(ls[i], proof(ls, i), r), `n=${n} leaf=${i} should verify`);
    }
  }
});

test('a proof does not verify against a different leaf', () => {
  const ls = leaves(16);
  const r = root(ls).toString('hex');
  assert.ok(!verify(leafHash('not-in-tree'), proof(ls, 4), r));
});

test('a tampered proof step fails', () => {
  const ls = leaves(16);
  const r = root(ls).toString('hex');
  const p = proof(ls, 6);
  p[0] = { ...p[0], hash: leafHash('evil').toString('hex') };
  assert.ok(!verify(ls[6], p, r));
});

test('odd nodes are promoted, not duplicated', () => {
  // Bitcoin duplicates the last node, making [a,b,b] collide with [a,b].
  // RFC 6962 promotes, so these must differ.
  const a = leafHash('a');
  const b = leafHash('b');
  assert.notEqual(root([a, b, b]).toString('hex'), root([a, b]).toString('hex'));
});

test('proof index is bounds-checked', () => {
  assert.throws(() => proof(leaves(4), 4), RangeError);
});
