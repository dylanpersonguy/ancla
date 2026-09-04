/**
 * Where bundles live, and how one gets built from what is on disk.
 *
 * Kept apart from packages/bundle so that package stays free of any assumption
 * about a data directory: it takes two archives and two snapshots and returns
 * bytes, which is exactly what an outside verifier needs it to do.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BUNDLE_VERSION,
  type BuiltBundle,
  type BundleManifest,
  bundleDir,
  buildBundle,
  readChanges,
  type LinePolicy,
  readManifest,
  writeBundle,
} from '../../bundle/src/bundle.ts';
import { CANON_VERSION } from '../../canonicalize/src/canonical.ts';
import { sourceRoot } from '../../ingest/src/manifest.ts';
import { OBSERVATORIO } from '../../ingest/src/observatorio.ts';
import type { Source } from '../../ingest/src/source.ts';
import { schemaFor } from './schemas.ts';
import { type ArchiveRef, archives, loadOrBuild } from './store.ts';

export function bundlesRoot(source: Source): string {
  return join(sourceRoot(source), 'bundles');
}

export function dirFor(
  source: Source,
  period: string,
  from: string,
  to: string,
  canonVersion: string = CANON_VERSION,
  bundleVersion: string = BUNDLE_VERSION,
): string {
  return bundleDir(sourceRoot(source), period, from, to, canonVersion, bundleVersion);
}

/** The two copies to compare: the newest pair unless stamps are named. */
export async function pickPair(
  period: string,
  source: Source,
  fromStamp?: string,
  toStamp?: string,
): Promise<[ArchiveRef, ArchiveRef]> {
  const refs = await archives(period, source);
  if (refs.length < 2 && !(fromStamp && toStamp)) {
    throw new Error(
      `${period}: ${refs.length} version stored. A bundle compares two, and the second ` +
        'appears when the publisher rewrites the period.',
    );
  }
  const find = (stamp: string): ArchiveRef => {
    const hit = refs.find((r) => r.stamp === stamp);
    if (!hit) throw new Error(`no copy of ${period} stamped ${stamp}`);
    return hit;
  };
  const from = fromStamp ? find(fromStamp) : (refs[refs.length - 2] as ArchiveRef);
  const to = toStamp ? find(toStamp) : (refs[refs.length - 1] as ArchiveRef);
  if (from.stamp === to.stamp) throw new Error('a bundle compares two different copies');
  if (from.stamp > to.stamp) throw new Error('the earlier copy must come first');
  return [from, to];
}

export async function buildFor(
  period: string,
  source: Source = OBSERVATORIO,
  opts: { fromStamp?: string; toStamp?: string; maxDetail?: number; log?: (s: string) => void } = {},
): Promise<{ bundle: BuiltBundle; dir: string; from: ArchiveRef; to: ArchiveRef }> {
  const [from, to] = await pickPair(period, source, opts.fromStamp, opts.toStamp);
  const schema = schemaFor(source.id);
  const [fromSnap, toSnap] = [await loadOrBuild(from, source), await loadOrBuild(to, source)];
  const bundle = buildBundle(
    { snapshot: fromSnap, archive: await readFile(from.path), ref: from },
    { snapshot: toSnap, archive: await readFile(to.path), ref: to },
    { schema, maxDetail: opts.maxDetail, linePolicy: opts.linePolicy, onProgress: opts.log },
  );
  return {
    bundle,
    dir: dirFor(
      source, period, from.stamp, to.stamp,
      bundle.manifest.canonVersion, bundle.manifest.bundleVersion,
    ),
    from,
    to,
  };
}

export async function persist(dir: string, b: BuiltBundle): Promise<string> {
  return writeBundle(dir, b);
}

export type StoredBundle = { dir: string; period: string; pair: string; manifest: BundleManifest };

export async function listBundles(source: Source = OBSERVATORIO): Promise<StoredBundle[]> {
  const root = bundlesRoot(source);
  let periods: string[];
  try {
    periods = (await readdir(root)).sort();
  } catch {
    return [];
  }
  const out: StoredBundle[] = [];
  for (const period of periods) {
    let pairs: string[];
    try {
      pairs = (await readdir(join(root, period))).sort();
    } catch {
      continue;
    }
    for (const pair of pairs) {
      const dir = join(root, period, pair);
      try {
        out.push({ dir, period, pair, manifest: await readManifest(dir) });
      } catch {
        /* a partial write, or something else entirely. Not a bundle. */
      }
    }
  }
  return out;
}

export async function loadBundle(dir: string): Promise<{ manifest: BundleManifest; changes: Buffer }> {
  return { manifest: await readManifest(dir), changes: await readChanges(dir) };
}

/**
 * Find the archives a manifest names, so a bundle can be re-derived from source.
 * Returns null when either copy is not on this machine, which is the honest
 * answer for someone verifying a bundle they were handed.
 */
export async function archivesForManifest(
  m: BundleManifest,
  source: Source = OBSERVATORIO,
): Promise<{ from: Buffer; to: Buffer } | null> {
  const refs = await archives(m.period, source);
  const from = refs.find((r) => r.file === m.from.file);
  const to = refs.find((r) => r.file === m.to.file);
  if (!from || !to) return null;
  return { from: await readFile(from.path), to: await readFile(to.path) };
}
