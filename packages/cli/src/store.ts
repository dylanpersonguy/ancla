/** Where snapshots live, and how to find the archives they came from. */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { dataRoot } from '../../ingest/src/manifest.ts';
import { buildSnapshot, readSnapshot, type Snapshot } from '../../canonicalize/src/snapshot.ts';

export type ArchiveRef = { month: string; file: string; path: string; stamp: string };

export async function months(): Promise<string[]> {
  try {
    return (await readdir(join(dataRoot(), 'archives'))).filter((m) => /^\d{6}$/.test(m)).sort();
  } catch {
    return [];
  }
}

/** Every stored version of a month, oldest first. More than one means a rewrite. */
export async function archives(month: string): Promise<ArchiveRef[]> {
  const dir = join(dataRoot(), 'archives', month);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.zip'))
    .sort()
    .map((f) => ({ month, file: f, path: join(dir, f), stamp: f.split('-')[0] }));
}

export function snapshotPath(ref: ArchiveRef): string {
  return join(dataRoot(), 'snapshots', ref.month, `${basename(ref.file, '.zip')}.snap.gz`);
}

export async function loadOrBuild(ref: ArchiveRef): Promise<Snapshot> {
  const p = snapshotPath(ref);
  try {
    return await readSnapshot(p);
  } catch {
    return buildSnapshot(ref.month, await readFile(ref.path));
  }
}
