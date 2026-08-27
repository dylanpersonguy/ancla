import assert from 'node:assert/strict';
import { test } from 'node:test';
import { leafFor } from '../../../packages/canonicalize/src/snapshot.ts';
import { proof, root } from '../../../packages/merkle/src/index.ts';

/**
 * The verifier page reimplements leaf and node hashing in browser JS against Web
 * Crypto. If that drifts from the Node implementation, every published proof
 * silently stops verifying. These helpers are copied verbatim from
 * apps/verifier/index.html and must stay that way.
 */
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const bytes = (h: string) => new Uint8Array(h.match(/../g)!.map((x) => Number.parseInt(x, 16)));

async function sha256(...parts: Uint8Array[]) {
  let n = 0;
  for (const p of parts) n += p.length;
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    all.set(p, o);
    o += p.length;
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all));
}
const leafHashWeb = (s: string) => sha256(new Uint8Array([0]), new TextEncoder().encode(s));
const nodeHashWeb = (l: Uint8Array, r: Uint8Array) => sha256(new Uint8Array([1]), l, r);

async function recomputeWeb(p: {
  table: string;
  id: string;
  byteHash: string;
  proof: { hash: string; side: string }[];
}) {
  const NUL = String.fromCharCode(0);
  let acc = await leafHashWeb(p.table + NUL + p.id + NUL + p.byteHash);
  for (const step of p.proof) {
    const sib = bytes(step.hash);
    acc = step.side === 'left' ? await nodeHashWeb(sib, acc) : await nodeHashWeb(acc, sib);
  }
  return hex(acc);
}

const records = Array.from({ length: 37 }, (_, i) => ({
  table: i % 3 === 0 ? 'Contratos' : 'Ofertas',
  id: `REC-${i}|0`,
  byteHash: 'ab'.repeat(32),
  valueHash: 'cd'.repeat(32),
}));

test('browser leaf hashing matches the Node implementation', async () => {
  const r = records[0];
  const web = hex(await leafHashWeb(`${r.table}\x00${r.id}\x00${r.byteHash}`));
  assert.equal(web, leafFor(r).toString('hex'));
});

test('browser proof recomputation reproduces the Node root, every leaf', async () => {
  const leaves = records.map(leafFor);
  const expected = root(leaves).toString('hex');
  for (let i = 0; i < records.length; i++) {
    const p = { ...records[i], proof: proof(leaves, i) };
    assert.equal(await recomputeWeb(p), expected, `leaf ${i} must reproduce the root`);
  }
});

test('browser recomputation rejects a tampered record hash', async () => {
  const leaves = records.map(leafFor);
  const expected = root(leaves).toString('hex');
  const p = { ...records[5], byteHash: 'ff'.repeat(32), proof: proof(leaves, 5) };
  assert.notEqual(await recomputeWeb(p), expected);
});
