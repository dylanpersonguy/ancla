/**
 * Mirror the Observatorio archives, never overwriting.
 *
 * Archives are stored as archives/<month>/<lastModified>-<sha256 prefix>.zip.
 * That naming does three jobs at once: re-running is idempotent, a rewritten
 * month lands beside its predecessor instead of clobbering it, and the directory
 * listing for a month IS its revision history.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as manifest from './manifest.ts';
import { type Month, archiveUrl, compactStamp, head } from './observatorio.ts';

const MAX_ATTEMPTS = 4;
const RETRY_BASE_MS = 1500;

export type MirrorOptions = {
  concurrency: number;
  /** Re-download even when we already hold this exact Last-Modified. */
  force: boolean;
  onProgress?: (line: string) => void;
};

function archiveDir(month: Month): string {
  return join(manifest.dataRoot(), 'archives', month);
}

/** Have we already stored a copy carrying this Last-Modified stamp? */
async function existingForStamp(month: Month, stamp: string): Promise<string | null> {
  try {
    const files = await readdir(archiveDir(month));
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

export type MonthOutcome = manifest.Observation;

export async function mirrorMonth(month: Month, opts: MirrorOptions): Promise<MonthOutcome> {
  const observedAt = new Date().toISOString();
  const log = opts.onProgress ?? (() => {});

  let h: Awaited<ReturnType<typeof head>>;
  try {
    h = await withRetry(`HEAD ${month}`, () => head(month));
  } catch (err) {
    const entry: MonthOutcome = {
      month,
      observedAt,
      lastModified: null,
      contentLength: null,
      sha256: null,
      path: null,
      status: 'error',
      error: String(err),
    };
    await manifest.append(entry);
    log(`  ${month}  error   ${String(err).slice(0, 60)}`);
    return entry;
  }

  if (!h.exists) {
    const entry: MonthOutcome = {
      month,
      observedAt,
      lastModified: null,
      contentLength: null,
      sha256: null,
      path: null,
      status: 'missing',
    };
    await manifest.append(entry);
    log(`  ${month}  missing (HTTP ${h.status})`);
    return entry;
  }

  const stamp = compactStamp(h.lastModified);

  if (!opts.force) {
    const have = await existingForStamp(month, stamp);
    if (have) {
      const entry: MonthOutcome = {
        month,
        observedAt,
        lastModified: h.lastModified,
        contentLength: h.contentLength,
        sha256: null,
        path: join('archives', month, have),
        status: 'unchanged',
      };
      await manifest.append(entry);
      log(`  ${month}  unchanged`);
      return entry;
    }
  }

  const dir = archiveDir(month);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${stamp}-${process.pid}`);

  try {
    const { sha256, bytes } = await withRetry(`GET ${month}`, () =>
      downloadHashed(archiveUrl(month), tmp),
    );
    const name = `${stamp}-${sha256.slice(0, 12)}.zip`;
    await rename(tmp, join(dir, name));

    const entry: MonthOutcome = {
      month,
      observedAt,
      lastModified: h.lastModified,
      contentLength: bytes,
      sha256,
      path: join('archives', month, name),
      status: 'stored',
    };
    await manifest.append(entry);
    const mb = (bytes / 1_048_576).toFixed(1);
    log(`  ${month}  stored  ${mb} MB  ${sha256.slice(0, 12)}`);
    return entry;
  } catch (err) {
    await rm(tmp, { force: true });
    const entry: MonthOutcome = {
      month,
      observedAt,
      lastModified: h.lastModified,
      contentLength: h.contentLength,
      sha256: null,
      path: null,
      status: 'error',
      error: String(err),
    };
    await manifest.append(entry);
    log(`  ${month}  error   ${String(err).slice(0, 60)}`);
    return entry;
  }
}

/** Bounded worker pool. Be a polite guest on someone else's blob storage. */
export async function mirrorAll(months: Month[], opts: MirrorOptions): Promise<MonthOutcome[]> {
  const results: MonthOutcome[] = new Array(months.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(opts.concurrency, months.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= months.length) return;
      results[i] = await mirrorMonth(months[i], opts);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function dataRootSize(): Promise<number> {
  const root = join(manifest.dataRoot(), 'archives');
  let total = 0;
  let months: string[];
  try {
    months = await readdir(root);
  } catch {
    return 0;
  }
  for (const m of months) {
    let files: string[];
    try {
      files = await readdir(join(root, m));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        total += (await stat(join(root, m, f))).size;
      } catch {
        /* raced with a rename; skip */
      }
    }
  }
  return total;
}
