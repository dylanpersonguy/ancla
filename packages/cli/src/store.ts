/** Where snapshots live, and how to find the archives they came from. */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CANON_VERSION } from '../../canonicalize/src/canonical.ts';
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

/**
 * Where a snapshot lives, per canonicaliser version.
 *
 * Snapshots used to be named for the archive alone, which was fine while there
 * was one set of rules. It stops being fine the moment the rules change:
 * re-snapshotting under ancla-canon-2 would overwrite the v1 file, and the v1
 * roots already committed on chain would no longer be reproducible from anything
 * on this disk. The archive is the evidence and it is untouched either way, but
 * "you can rebuild it from the ZIP in twenty minutes" is a much weaker offer than
 * "it is right here".
 *
 * The legacy unsuffixed path is still read, so nothing already built is orphaned.
 */
export function snapshotPath(
  ref: ArchiveRef,
  source: Source = OBSERVATORIO,
  canonVersion: string = CANON_VERSION,
): string {
  const ext = `.${source.extension}`;
  const dir = join(sourceRoot(source), 'snapshots', ref.month);
  const base = basename(ref.file, ext);
  return join(dir, `${base}.${canonVersion}.snap.gz`);
}

/** The pre-versioning path. Read-only: nothing writes here any more. */
export function legacySnapshotPath(ref: ArchiveRef, source: Source = OBSERVATORIO): string {
  const ext = `.${source.extension}`;
  return join(sourceRoot(source), 'snapshots', ref.month, `${basename(ref.file, ext)}.snap.gz`);
}

/**
 * Every snapshot held for an archive, newest rules first.
 *
 * More than one means the archive has been canonicalised under more than one set
 * of rules, which is a normal state after a version bump and is what keeps an
 * older anchored root checkable.
 */
export async function snapshotsFor(
  ref: ArchiveRef,
  source: Source = OBSERVATORIO,
): Promise<{ path: string; canonVersion: string }[]> {
  const out: { path: string; canonVersion: string }[] = [];
  const current = snapshotPath(ref, source);
  const legacy = legacySnapshotPath(ref, source);
  for (const [path, version] of [
    [current, CANON_VERSION],
    [legacy, 'ancla-canon-1'],
  ] as const) {
    try {
      await stat(path);
      out.push({ path, canonVersion: version });
    } catch {
      /* not built under these rules */
    }
  }
  return out;
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
  // Only a snapshot built under the current rules is usable for a comparison. A
  // v1 file on disk is kept for checking v1 roots, not for feeding today's differ.
  try {
    return await readSnapshot(snapshotPath(ref, source));
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
