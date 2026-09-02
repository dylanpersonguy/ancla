/** Where snapshots live, and how to find the archives they came from. */

import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  buildSnapshot,
  readSnapshot,
  readSnapshotHeader,
  type Snapshot,
} from '../../canonicalize/src/snapshot.ts';
import { archivesRoot, sourceRoot } from '../../ingest/src/manifest.ts';
import { OBSERVATORIO } from '../../ingest/src/observatorio.ts';
import type { Source } from '../../ingest/src/source.ts';
import { schemaFor } from './schemas.ts';

/**
 * A stored archive, carrying the publisher it came from.
 *
 * The source travels on the ref rather than beside it because everything
 * downstream — the snapshot path, the schema used to canonicalise it — is
 * decided by which publisher served the bytes. Passing it separately means a
 * caller can eventually pair a Panamanian archive with Costa Rican keys, and the
 * result would be records with invented identities rather than an error.
 */
export type ArchiveRef = {
  source: string;
  month: string;
  file: string;
  path: string;
  stamp: string;
};

/**
 * Source defaults to Costa Rica throughout this module. It was the only
 * publisher when these signatures were written, and defaulting keeps every
 * existing call site honest rather than quietly repointing it.
 */
export async function months(source: Source = OBSERVATORIO): Promise<string[]> {
  try {
    const dirs = await readdir(archivesRoot(source));
    const re = source.granularity === 'year' ? /^\d{4}$/ : /^\d{6}$/;
    return dirs.filter((m) => re.test(m)).sort();
  } catch {
    return [];
  }
}

/** Every stored version of a period, oldest first. More than one means a rewrite. */
export async function archives(
  month: string,
  source: Source = OBSERVATORIO,
): Promise<ArchiveRef[]> {
  const dir = join(archivesRoot(source), month);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith(`.${source.extension}`))
    .sort()
    .map((f) => ({
      source: source.id,
      month,
      file: f,
      path: join(dir, f),
      stamp: f.split('-')[0] as string,
    }));
}

export function snapshotPath(ref: ArchiveRef, source: Source = OBSERVATORIO): string {
  const ext = `.${source.extension}`;
  return join(sourceRoot(source), 'snapshots', ref.month, `${basename(ref.file, ext)}.snap.gz`);
}

/**
 * `source` only locates the snapshot file. The schema comes from ref.source, so
 * a caller that pairs one publisher's archive with another's keys gets a
 * mismatch it cannot silently canonicalise past.
 */
export async function loadOrBuild(
  ref: ArchiveRef,
  source: Source = OBSERVATORIO,
): Promise<Snapshot> {
  if (ref.source !== source.id) {
    throw new Error(`archive is from ${ref.source} but the store was asked for ${source.id}`);
  }
  const p = snapshotPath(ref, source);
  try {
    return await readSnapshot(p);
  } catch {
    return buildSnapshot(ref.month, await readFile(ref.path), schemaFor(ref.source));
  }
}

/**
 * Header-only view of the newest stored snapshot per period, for anchoring.
 * Reads four fields rather than unpacking gigabytes of records.
 */
export async function allSnapshotHeaders(
  source: Source = OBSERVATORIO,
): Promise<Omit<Snapshot, 'records'>[]> {
  const out: Omit<Snapshot, 'records'>[] = [];
  for (const month of await months(source)) {
    const refs = await archives(month, source);
    if (!refs.length) continue;
    try {
      out.push(await readSnapshotHeader(snapshotPath(refs[refs.length - 1] as ArchiveRef, source)));
    } catch {
      // Not snapshotted yet. Skip rather than silently anchoring a stale root.
    }
  }
  return out;
}
