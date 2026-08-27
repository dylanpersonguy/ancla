/**
 * Turn snapshots into an anchor transaction.
 *
 * One entry pair per anchored day: the Merkle root, and a meta string carrying
 * the canonicalizer version, record count, and the SHA-256 of the archive the
 * records came from. Batching many days into one transaction is possible because
 * a DataTransaction holds up to 100 entries, so anchoring the whole national
 * procurement record costs one transaction a day.
 *
 * On salting: the plan called for salted hashes. We do not salt, and the reason
 * should be stated rather than quietly dropped. The verifier needs the salt to
 * check anything, so the salt has to be published alongside the root, which makes
 * it useless against the attack it was meant to stop. The underlying records are
 * already public open data. Salting here would be ceremony, not protection.
 */

import type { Snapshot } from '../../canonicalize/src/snapshot.ts';
import { type DataEntry, MAX_ENTRIES, type SignedDataTx, signDataTx } from './datatx.ts';

export type AnchorPlan = {
  day: string;
  entries: DataEntry[];
  roots: { day: string; root: string; month: string; recordCount: number }[];
};

export function metaString(snap: Snapshot): string {
  return `${snap.canonVersion}|${snap.recordCount}|${snap.archiveSha256}`;
}

export function planAnchor(day: string, snapshots: Snapshot[]): AnchorPlan {
  if (snapshots.length === 0) throw new Error('nothing to anchor');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');

  // One root over all snapshots taken today, keyed by month so each stays checkable.
  const entries: DataEntry[] = [];
  const roots: AnchorPlan['roots'] = [];
  for (const s of snapshots) {
    entries.push({ key: `root_${day}_${s.month}`, type: 'string', value: s.merkleRoot });
    entries.push({ key: `meta_${day}_${s.month}`, type: 'string', value: metaString(s) });
    roots.push({ day, root: s.merkleRoot, month: s.month, recordCount: s.recordCount });
  }
  entries.push({ key: 'latest', type: 'string', value: day });
  return { day, entries, roots };
}

/**
 * Split a set of snapshots across transactions that each fit the node's limits.
 *
 * A DataTransaction holds at most 100 entries and 150 KB. Each month costs two
 * entries (root and meta), so a full historical backfill of 189 months needs four
 * transactions rather than one. The "latest" marker goes on the final batch so it
 * is only set once the whole set has landed.
 */
export function planAnchorBatched(
  day: string,
  snapshots: Snapshot[],
  maxEntries = MAX_ENTRIES,
): AnchorPlan[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  const perBatch = Math.floor((maxEntries - 1) / 2);
  if (perBatch < 1) throw new Error('maxEntries too small to hold one month');

  const batches: AnchorPlan[] = [];
  for (let i = 0; i < snapshots.length; i += perBatch) {
    const chunk = snapshots.slice(i, i + perBatch);
    const isLast = i + perBatch >= snapshots.length;
    const entries: DataEntry[] = [];
    const roots: AnchorPlan['roots'] = [];
    for (const s of chunk) {
      entries.push({ key: `root_${day}_${s.month}`, type: 'string', value: s.merkleRoot });
      entries.push({ key: `meta_${day}_${s.month}`, type: 'string', value: metaString(s) });
      roots.push({ day, root: s.merkleRoot, month: s.month, recordCount: s.recordCount });
    }
    if (isLast) entries.push({ key: 'latest', type: 'string', value: day });
    batches.push({ day, entries, roots });
  }
  return batches;
}

export function signAnchor(
  plan: AnchorPlan,
  privateKey: string,
  publicKey: string,
  timestamp: number,
): SignedDataTx {
  return signDataTx(privateKey, publicKey, plan.entries, timestamp);
}

export * from './client.ts';
export * from './key.ts';
export * from './datatx.ts';
