/**
 * RFC 6962 Merkle tree (the Certificate Transparency construction).
 *
 * Leaves and internal nodes are domain-separated with a 0x00 / 0x01 prefix, so a
 * leaf digest can never be reinterpreted as an internal node. Odd nodes are
 * promoted unchanged rather than duplicated, which avoids the duplicate-leaf
 * collision that affects the Bitcoin-style tree (CVE-2012-2459).
 *
 * Leaves must be supplied already sorted. Sorting is the caller's job because the
 * sort order is part of what gets anchored.
 */

import { createHash } from 'node:crypto';

const LEAF = Buffer.from([0x00]);
const NODE = Buffer.from([0x01]);

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

export function leafHash(data: string | Buffer): Buffer {
  return sha256(LEAF, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
}

export function nodeHash(left: Buffer, right: Buffer): Buffer {
  return sha256(NODE, left, right);
}

/** Root of an empty tree is SHA-256 of the empty string, per RFC 6962. */
export const EMPTY_ROOT = createHash('sha256').update(Buffer.alloc(0)).digest();

export function buildLevels(leaves: Buffer[]): Buffer[][] {
  if (leaves.length === 0) return [[EMPTY_ROOT]];
  const levels: Buffer[][] = [leaves];
  let cur = leaves;
  while (cur.length > 1) {
    const next: Buffer[] = [];
    for (let i = 0; i < cur.length; i += 2) {
      next.push(i + 1 < cur.length ? nodeHash(cur[i], cur[i + 1]) : cur[i]);
    }
    levels.push(next);
    cur = next;
  }
  return levels;
}

export function root(leaves: Buffer[]): Buffer {
  const levels = buildLevels(leaves);
  return levels[levels.length - 1][0];
}

export type ProofStep = { hash: string; side: 'left' | 'right' };

/** Audit path for the leaf at `index`, bottom-up. */
export function proof(leaves: Buffer[], index: number): ProofStep[] {
  if (index < 0 || index >= leaves.length) throw new RangeError('leaf index out of range');
  const levels = buildLevels(leaves);
  const path: ProofStep[] = [];
  let i = index;
  for (let l = 0; l < levels.length - 1; l++) {
    const level = levels[l];
    const isRight = i % 2 === 1;
    const siblingIndex = isRight ? i - 1 : i + 1;
    if (siblingIndex < level.length) {
      path.push({
        hash: level[siblingIndex].toString('hex'),
        side: isRight ? 'left' : 'right',
      });
    }
    i = Math.floor(i / 2);
  }
  return path;
}

/** Recompute a root from a leaf and its audit path. Used by the verifier. */
export function verify(leaf: Buffer, path: ProofStep[], expectedRoot: string): boolean {
  let acc = leaf;
  for (const step of path) {
    const sib = Buffer.from(step.hash, 'hex');
    acc = step.side === 'left' ? nodeHash(sib, acc) : nodeHash(acc, sib);
  }
  return acc.toString('hex') === expectedRoot.toLowerCase();
}
