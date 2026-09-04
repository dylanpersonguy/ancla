/**
 * Mirror a source's archives, never overwriting.
 *
 * Archives are stored as archives/<period>/<lastModified>-<sha256 prefix>.<ext>.
 * That naming does three jobs at once: re-running is idempotent, a rewritten
 * period lands beside its predecessor instead of clobbering it, and the
 * directory listing for a period IS its revision history.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as manifest from './manifest.ts';
import { type Period, type Source, compactStamp } from './source.ts';

const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1500;

export type MirrorOptions = {
  concurrency: number;
  /** Re-download even when we already hold this exact Last-Modified. */
  force: boolean;
  onProgress?: (line: string) => void;
};

function archiveDir(source: Source, period: Period): string {
  return join(manifest.archivesRoot(source), period);
}

/** Have we already stored a copy carrying this Last-Modified stamp? */
async function existingForStamp(
  source: Source,
  period: Period,
  stamp: string,
): Promise<string | null> {
  try {
    const files = await readdir(archiveDir(source, period));
    return files.find((f) => f.startsWith(`${stamp}-`)) ?? null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Stream to disk, hashing as bytes pass. Never buffers a whole archive. */
async function downloadHashed(
  url: string,
  destination: string,
): Promise<{ sha256: string; bytes: number }> {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const hash = createHash('sha256');
  let bytes = 0;
  const tap = new Transform({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      bytes += chunk.length;
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), tap, createWriteStream(destination));
  return { sha256: hash.digest('hex'), bytes };
}

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === MAX_ATTEMPTS) break;
      const wait = RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw new Error(`${label} failed after ${MAX_ATTEMPTS} attempts: ${String(lastError)}`);
}

/**
 * Move a downloaded file into place, and refuse to replace anything already there.
 *
 * `rename` would overwrite, which is the one thing this store must never do. The
 * name carries the publisher's Last-Modified and the first twelve hex of the
 * content hash, so a collision means we already hold these exact bytes under this
 * exact stamp — but "the name says it is the same file" is not the same claim as
 * "the file was not replaced", and only one of the two is enforceable. `link`
 * fails with EEXIST rather than clobbering, so the copy stored first is the copy
 * that stays, and --force cannot quietly rewrite history.
 *
 * Returns true when this call is what put the file there.
 */
async function placeOnce(tmp: string, dest: string): Promise<boolean> {
  try {
    await link(tmp, dest);
    await unlink(tmp);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    await rm(tmp, { force: true });
    return false;
  }
}

export type PeriodOutcome = manifest.Observation;

export async function mirrorPeriod(
  source: Source,
  period: Period,
  opts: MirrorOptions,
): Promise<PeriodOutcome> {
  const observedAt = new Date().toISOString();
  const log = opts.onProgress ?? (() => {});
  const base = { source: source.id, period, observedAt, tlsVerified: !source.unverifiedTls };

  let h: Awaited<ReturnType<Source['head']>>;
  try {
    h = await withRetry(`HEAD ${period}`, () => source.head(period));
  } catch (err) {
    const entry: PeriodOutcome = {
      ...base,
      lastModified: null,
      contentLength: null,
      sha256: null,
      path: null,
      status: 'error',
      error: String(err),
    };
    await manifest.append(source, entry);
    log(`  ${period}  error   ${String(err).slice(0, 60)}`);
    return entry;
  }

  if (!h.exists) {
    const entry: PeriodOutcome = {
      ...base,
      lastModified: null,
      contentLength: null,
      sha256: null,
      path: null,
      status: 'missing',
    };
    await manifest.append(source, entry);
    log(`  ${period}  missing (HTTP ${h.status})`);
    return entry;
  }

  const stamp = compactStamp(h.lastModified);

  if (!opts.force) {
    const have = await existingForStamp(source, period, stamp);
    if (have) {
      const entry: PeriodOutcome = {
        ...base,
        lastModified: h.lastModified,
        contentLength: h.contentLength,
        sha256: null,
        path: join('archives', period, have),
        status: 'unchanged',
      };
      await manifest.append(source, entry);
      log(`  ${period}  unchanged`);
      return entry;
    }
  }

  const dir = archiveDir(source, period);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${stamp}-${process.pid}`);

  try {
    const { sha256, bytes } = await withRetry(`GET ${period}`, () =>
      downloadHashed(source.url(period), tmp),
    );
    const name = `${stamp}-${sha256.slice(0, 12)}.${source.extension}`;
    const placed = await placeOnce(tmp, join(dir, name));

    const entry: PeriodOutcome = {
      ...base,
      lastModified: h.lastModified,
      contentLength: bytes,
      sha256,
      path: join('archives', period, name),
      status: placed ? 'stored' : 'unchanged',
    };
    await manifest.append(source, entry);
    const mb = (bytes / 1_048_576).toFixed(1);
    log(
      placed
        ? `  ${period}  stored  ${mb} MB  ${sha256.slice(0, 12)}`
        : `  ${period}  already held  ${sha256.slice(0, 12)}`,
    );
    return entry;
  } catch (err) {
    await rm(tmp, { force: true });
    const entry: PeriodOutcome = {
      ...base,
      lastModified: h.lastModified,
      contentLength: h.contentLength,
      sha256: null,
      path: null,
      status: 'error',
      error: String(err),
    };
    await manifest.append(source, entry);
    log(`  ${period}  error   ${String(err).slice(0, 60)}`);
    return entry;
  }
}

/** Bounded worker pool. Be a polite guest on someone else's storage. */
export async function mirrorAll(
  source: Source,
  periods: Period[],
  opts: MirrorOptions,
): Promise<PeriodOutcome[]> {
  const results: PeriodOutcome[] = new Array(periods.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, periods.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= periods.length) return;
      results[i] = await mirrorPeriod(source, periods[i] as Period, opts);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function dataRootSize(source: Source): Promise<number> {
  const root = manifest.archivesRoot(source);
  let total = 0;
  let periods: string[];
  try {
    periods = await readdir(root);
  } catch {
    return 0;
  }
  for (const p of periods) {
    let files: string[];
    try {
      files = await readdir(join(root, p));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        total += (await stat(join(root, p, f))).size;
      } catch {
        /* raced with a rename; skip */
      }
    }
  }
  return total;
}
