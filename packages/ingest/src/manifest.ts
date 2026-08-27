/**
 * The manifest is append-only and is itself the first evidence artifact.
 *
 * Before any canonicalization happens, the manifest already answers a question
 * nobody can answer today: "what did the Observatorio publish for month M, and
 * when did it change?" Each line is one observation. Lines are never rewritten.
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Month } from './observatorio.ts';

export type Observation = {
  /** YYYYMM of the archive observed. */
  month: Month;
  /** When we looked. ISO 8601 UTC. */
  observedAt: string;
  /** Raw HTTP Last-Modified as served. Null when the month does not exist. */
  lastModified: string | null;
  contentLength: number | null;
  /** SHA-256 of the archive bytes. Null unless we downloaded it this run. */
  sha256: string | null;
  /** Path relative to the data root. Null when nothing was stored. */
  path: string | null;
  status: 'stored' | 'unchanged' | 'missing' | 'error';
  /** Populated only when status is 'error'. */
  error?: string;
};

export function dataRoot(): string {
  return process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data');
}

export function manifestPath(): string {
  return join(dataRoot(), 'manifest.jsonl');
}

export async function append(entry: Observation): Promise<void> {
  const p = manifestPath();
  await mkdir(dirname(p), { recursive: true });
  await appendFile(p, `${JSON.stringify(entry)}\n`, 'utf8');
}

export async function readAll(): Promise<Observation[]> {
  let raw: string;
  try {
    raw = await readFile(manifestPath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Observation);
}

/**
 * Every distinct version we hold per month, in observation order.
 *
 * A month with more than one entry has been rewritten since we started
 * watching. That is the signal the whole project exists to capture.
 */
export async function versionsByMonth(): Promise<Map<Month, Observation[]>> {
  const byMonth = new Map<Month, Observation[]>();
  const seen = new Set<string>();
  for (const o of await readAll()) {
    if (o.status !== 'stored' || !o.sha256) continue;
    const key = `${o.month}:${o.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = byMonth.get(o.month) ?? [];
    list.push(o);
    byMonth.set(o.month, list);
  }
  return byMonth;
}
