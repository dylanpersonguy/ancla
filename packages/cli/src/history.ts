/**
 * Every version of one record, and the proof for each.
 *
 * `prove` answers "is this record in the anchored root", but only for the copy
 * we hold now. That proves the present. The question this project exists to
 * answer is about the past: what did this row say before it was changed, and
 * can that be shown to someone who does not trust us.
 *
 * Values are read out of the archives on demand rather than kept in snapshots.
 * A snapshot is a hash index and stays small; the ZIPs are already the source of
 * truth and copying their contents into a second store would double the disk to
 * answer a question that is asked about one record at a time.
 */

import { readFile } from 'node:fs/promises';
import type { CanonRecord } from '../../canonicalize/src/canonical.ts';
import { findRows } from '../../canonicalize/src/identity.ts';
import type { Schema } from '../../canonicalize/src/schema.ts';
import { leafFor } from '../../canonicalize/src/snapshot.ts';
import { listEntries, readEntry, tableNameOf } from '../../canonicalize/src/zip.ts';
import { proof, verify as merkleVerify } from '../../merkle/src/index.ts';
import { OBSERVATORIO } from '../../ingest/src/observatorio.ts';
import type { Source } from '../../ingest/src/source.ts';
import { type ArchiveRef, archives, loadOrBuild } from './store.ts';
import { schemaFor } from './schemas.ts';

export type FieldChange = { field: string; before: string | null; after: string | null };

export type RecordVersion = {
  /** Archive Last-Modified, the moment the publisher served this copy. */
  stamp: string;
  archiveSha256: string;
  /** False when the record is absent from this copy: added later, or removed. */
  present: boolean;
  byteHash: string | null;
  valueHash: string | null;
  fields: Record<string, string> | null;
  merkleRoot: string;
  leafIndex: number | null;
  leafCount: number;
  proof: string[];
  /** Recomputed here, so a corrupted snapshot cannot quietly claim membership. */
  verifiesLocally: boolean;
};

export type RecordTransition = {
  from: string;
  to: string;
  kind: 'added' | 'removed' | 'silentRevision' | 'reformatted' | 'unchanged';
  fields: FieldChange[];
};

export type RecordHistory = {
  month: string;
  table: string;
  id: string;
  versions: RecordVersion[];
  transitions: RecordTransition[];
};

/**
 * The row's fields, keyed by column, from one archive.
 *
 * Identity comes from `findRows`, which is the same rule the canonicalizer used
 * to name the row in the first place. An earlier version rebuilt the id here from
 * the declared key alone, so any content-addressed row — `sha256:...#2`, which is
 * most of three tables — was unfindable and reported as absent from a copy that
 * contained it.
 */
export function rowFields(
  archive: Buffer,
  table: string,
  id: string,
  schema?: Schema,
): Record<string, string> | null {
  const entry = listEntries(archive).find((e) => tableNameOf(e.name) === table);
  if (!entry) return null;
  return findRows(table, readEntry(archive, entry), new Set([id]), schema).get(id) ?? null;
}

export function classify(
  before: RecordVersion,
  after: RecordVersion,
): RecordTransition['kind'] {
  if (!before.present && after.present) return 'added';
  if (before.present && !after.present) return 'removed';
  if (before.valueHash !== after.valueHash) return 'silentRevision';
  if (before.byteHash !== after.byteHash) return 'reformatted';
  return 'unchanged';
}

export function fieldDiff(
  before: Record<string, string> | null,
  after: Record<string, string> | null,
): FieldChange[] {
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: FieldChange[] = [];
  for (const field of names) {
    const b = before?.[field] ?? null;
    const a = after?.[field] ?? null;
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out.sort((x, y) => x.field.localeCompare(y.field));
}

async function versionOf(
  ref: ArchiveRef,
  table: string,
  id: string,
  source: Source,
): Promise<RecordVersion> {
  const snap = await loadOrBuild(ref, source);
  const idx = snap.records.findIndex((r: CanonRecord) => r.table === table && r.id === id);
  const leaves = snap.records.map(leafFor);
  const rec = idx >= 0 ? snap.records[idx] : null;
  const path = idx >= 0 ? proof(leaves, idx) : [];
  return {
    stamp: ref.stamp,
    archiveSha256: snap.archiveSha256,
    present: idx >= 0,
    byteHash: rec?.byteHash ?? null,
    valueHash: rec?.valueHash ?? null,
    // Only opened when the record is actually in this copy: parsing a 300 MB
    // table to learn nothing is the difference between a usable answer and a
    // minute of waiting per version.
    fields: idx >= 0 ? rowFields(await readFile(ref.path), table, id, schemaFor(ref.source)) : null,
    merkleRoot: snap.merkleRoot,
    leafIndex: idx >= 0 ? idx : null,
    leafCount: leaves.length,
    proof: path,
    verifiesLocally: idx >= 0 ? merkleVerify(leaves[idx] as Buffer, path, snap.merkleRoot) : false,
  };
}

export async function recordHistory(
  month: string,
  table: string,
  id: string,
  source: Source = OBSERVATORIO,
): Promise<RecordHistory> {
  const refs = await archives(month, source);
  if (!refs.length) throw new Error(`no archive stored for ${month}`);

  const versions: RecordVersion[] = [];
  for (const ref of refs) versions.push(await versionOf(ref, table, id, source));

  if (!versions.some((v) => v.present)) {
    throw new Error(`record not found in any copy of ${month}: ${table} ${id}`);
  }

  const transitions: RecordTransition[] = [];
  for (let i = 1; i < versions.length; i++) {
    const before = versions[i - 1] as RecordVersion;
    const after = versions[i] as RecordVersion;
    const kind = classify(before, after);
    if (kind === 'unchanged') continue;
    transitions.push({
      from: before.stamp,
      to: after.stamp,
      kind,
      fields: fieldDiff(before.fields, after.fields),
    });
  }
  return { month, table, id, versions, transitions };
}
