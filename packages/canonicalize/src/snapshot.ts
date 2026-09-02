/**
 * A snapshot is the canonical form of one archive version: every record reduced
 * to (table, id, byteHash, valueHash), sorted, plus the Merkle root over them.
 *
 * Snapshots are what the differ compares and what the anchor commits to. They are
 * written gzipped alongside the archive they came from, so a month directory holds
 * both the raw evidence and its canonical reduction.
 */

import { createGunzip, createGzip, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { leafHash, root } from '../../merkle/src/index.ts';
import { CANON_VERSION, type CanonRecord, canonicalizeTable, } from './canonical.ts';
import type { Schema } from './schema.ts';
import { listEntries, readEntry, tableNameOf } from './zip.ts';

export type TableStat = {
  table: string;
  rows: number;
  records: number;
  schema: string;
  contentAddressed: boolean;
  duplicateKeys: number;
};

export type Snapshot = {
  canonVersion: string;
  month: string;
  /** SHA-256 of the archive these records came from. */
  archiveSha256: string;
  merkleRoot: string;
  recordCount: number;
  tables: TableStat[];
  records: CanonRecord[];
};

/** Sort order is part of the commitment, so it is defined here and nowhere else. */
export function sortRecords(records: CanonRecord[]): CanonRecord[] {
  return records.sort((a, b) =>
    a.table < b.table ? -1
    : a.table > b.table ? 1
    : a.id < b.id ? -1
    : a.id > b.id ? 1
    : 0,
  );
}

export function leafFor(r: CanonRecord): Buffer {
  return leafHash(`${r.table}\x00${r.id}\x00${r.byteHash}`);
}

/**
 * `schema` names the publisher's table keys. Omitted means Costa Rica, which is
 * the only caller that predates a second source.
 */
export function buildSnapshot(month: string, archive: Buffer, schema?: Schema): Snapshot {
  const archiveSha256 = createHash('sha256').update(archive).digest('hex');
  const entries = listEntries(archive);
  const records: CanonRecord[] = [];
  const tables: TableStat[] = [];

  for (const entry of entries) {
    const table = tableNameOf(entry.name);
    if (!table) continue;
    const res = canonicalizeTable(table, readEntry(archive, entry), schema);
    tables.push({
      table,
      rows: res.rowCount,
      records: res.records.length,
      schema: res.schema,
      contentAddressed: res.contentAddressed,
      duplicateKeys: res.duplicateKeys,
    });
    for (const r of res.records) records.push(r);
  }

  tables.sort((a, b) => (a.table < b.table ? -1 : 1));
  sortRecords(records);

  return {
    canonVersion: CANON_VERSION,
    month,
    archiveSha256,
    merkleRoot: root(records.map(leafFor)).toString('hex'),
    recordCount: records.length,
    tables,
    records,
  };
}

/** Header line then one TSV line per record, gzipped. Streamed: never one big string. */
export async function writeSnapshot(path: string, snap: Snapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = JSON.stringify({
    canonVersion: snap.canonVersion,
    month: snap.month,
    archiveSha256: snap.archiveSha256,
    merkleRoot: snap.merkleRoot,
    recordCount: snap.recordCount,
    tables: snap.tables,
  });
  async function* lines() {
    yield `${header}\n`;
    for (const r of snap.records) {
      yield `${r.table}\t${r.id}\t${r.byteHash}\t${r.valueHash}\n`;
    }
  }
  await pipeline(Readable.from(lines()), createGzip(), createWriteStream(path));
}

/**
 * Read only the header line of a snapshot.
 *
 * Anchoring needs the root, the month and the record count, not the records.
 * Fully decompressing every snapshot to get four fields would mean unpacking
 * gigabytes, so stop the gunzip stream as soon as the first newline arrives.
 */
export async function readSnapshotHeader(path: string): Promise<Omit<Snapshot, 'records'>> {
  const gunzip = createGunzip();
  const source = createReadStream(path);
  source.pipe(gunzip);
  let buf = '';
  try {
    for await (const chunk of gunzip) {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl >= 0) return JSON.parse(buf.slice(0, nl));
    }
  } finally {
    source.destroy();
    gunzip.destroy();
  }
  throw new Error(`no header line in ${path}`);
}

export async function readSnapshot(path: string): Promise<Snapshot> {
  const raw = gunzipSync(await readFile(path)).toString('utf8');
  const nl = raw.indexOf('\n');
  const head = JSON.parse(raw.slice(0, nl));
  const records: CanonRecord[] = [];
  let i = nl + 1;
  while (i < raw.length) {
    const end = raw.indexOf('\n', i);
    if (end < 0) break;
    const line = raw.slice(i, end);
    i = end + 1;
    if (!line) continue;
    const [table, id, byteHash, valueHash] = line.split('\t');
    records.push({ table, id, byteHash, valueHash });
  }
  return { ...head, records };
}
