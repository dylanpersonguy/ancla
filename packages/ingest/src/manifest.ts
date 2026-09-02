/**
 * The manifest is append-only and is itself the first evidence artifact.
 *
 * Before any canonicalization happens, the manifest already answers a question
 * nobody can answer today: "what did the publisher serve for period P, and when
 * did it change?" Each line is one observation. Lines are never rewritten.
 *
 * One manifest per source. Costa Rica's stays where it has always been so the
 * 189 archives already on disk keep resolving; every later source gets its own
 * directory under `sources/`.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Period, Source } from './source.ts';

export type Observation = {
  /** Source id, so two publishers never share a line's meaning. */
  source: string;
  /** `YYYYMM` or `YYYY`, per the source's granularity. */
  period: Period;
  /** When we looked. ISO 8601 UTC. */
  observedAt: string;
  /** Raw HTTP Last-Modified as served. Null when the period does not exist. */
  lastModified: string | null;
  contentLength: number | null;
  /** SHA-256 of the archive bytes. Null unless we downloaded it this run. */
  sha256: string | null;
  /** Path relative to the source root. Null when nothing was stored. */
  path: string | null;
  status: 'stored' | 'unchanged' | 'missing' | 'error';
  /**
   * False when the archive arrived over a connection we could not authenticate.
   * Written on every line so the caveat travels with the bytes: anything that
   * later reads this manifest can tell a verified archive from one that is only
   * probably from the publisher.
   */
  tlsVerified: boolean;
  /** Populated only when status is 'error'. */
  error?: string;
};

/** Lines written before the manifest carried a source or used `period`. */
type LegacyObservation = Omit<Observation, 'source' | 'period' | 'tlsVerified'> & {
  tlsVerified?: boolean;
  month?: string;
  period?: string;
  source?: string;
};

export function dataRoot(): string {
  return process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data');
}

export function sourceRoot(source: Source): string {
  return source.legacyRoot ? dataRoot() : join(dataRoot(), 'sources', source.id);
}

export function manifestPath(source: Source): string {
  return join(sourceRoot(source), 'manifest.jsonl');
}

export function archivesRoot(source: Source): string {
  return join(sourceRoot(source), 'archives');
}

export async function append(source: Source, entry: Observation): Promise<void> {
  const p = manifestPath(source);
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Legacy lines carry `month` and no `source`; they are all Costa Rica. */
function normalize(raw: LegacyObservation, source: Source): Observation {
  const { month, ...rest } = raw;
  return {
    ...rest,
    source: raw.source ?? source.id,
    period: raw.period ?? month ?? '',
    // Costa Rica and Panama were both mirrored before this field existed, and
    // both over a chain that verifies, so absent means true rather than unknown.
    // The first source that could not be authenticated is also the first whose
    // lines carry it explicitly.
    tlsVerified: raw.tlsVerified ?? true,
  } as Observation;
}

export async function readAll(source: Source): Promise<Observation[]> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(source), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => normalize(JSON.parse(l) as LegacyObservation, source));
}

/**
 * Every distinct version we hold per period, in observation order.
 *
 * A period with more than one entry has been rewritten since we started
 * watching. That is the signal the whole project exists to capture.
 */
export async function versionsByPeriod(source: Source): Promise<Map<Period, Observation[]>> {
  const byPeriod = new Map<Period, Observation[]>();
  const seen = new Set<string>();
  for (const o of await readAll(source)) {
    if (o.status !== 'stored' || !o.sha256) continue;
    const key = `${o.period}:${o.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byPeriod.get(o.period) ?? [];
    list.push(o);
    byPeriod.set(o.period, list);
  }
  return byPeriod;
}
