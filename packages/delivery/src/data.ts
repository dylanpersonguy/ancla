/**
 * Everything the delivery layer reads, in one place.
 *
 * Three stores sit behind the API and they fail independently, so each one is
 * wrapped rather than assumed:
 *
 *   the SQLite index      built by the ingest. May be absent or half-populated
 *                         while a load is running, so every read tolerates both.
 *   the snapshots         gzipped canonical reductions on disk. Loading one costs
 *                         about a second and half a gigabyte, so exactly one stays
 *                         cached and the rest are read on demand.
 *   the watch reports     JSON written by the daily job. These are the change feed.
 *
 * Nothing here throws for "not built yet". A missing store returns empty and the
 * API says so in the response, because a public site that 500s on its first day is
 * worse than a public site that says the index is still loading.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { openDb, indexPath, type Db } from '../../core/src/db.ts';
import { leafFor, readSnapshot, type Snapshot } from '../../canonicalize/src/snapshot.ts';
import { proof as merkleProof } from '../../merkle/src/index.ts';
import type { Change, ChangeKind } from '../../differ/src/index.ts';
import type { WatchReport } from '../../cli/src/watch.ts';
import { archives, months, snapshotPath } from '../../cli/src/store.ts';
import { dataRoot } from '../../ingest/src/manifest.ts';

export type { Db };

// ---------------------------------------------------------------------------
// The index
// ---------------------------------------------------------------------------

let dbHandle: Db | null = null;
let dbTried = false;

/**
 * The read-only index handle, or null when there is nothing to read.
 *
 * Held open for the process lifetime. SQLite in WAL mode lets the ingest keep
 * writing while this reader is attached, which is the whole point: the site stays
 * up during a load.
 */
export function index(): Db | null {
  if (dbTried) return dbHandle;
  dbTried = true;
  const path = indexPath();
  if (!existsSync(path)) return (dbHandle = null);
  try {
    dbHandle = openDb(path, { readonly: true });
    // A file can exist with no tables in it if the ingest was interrupted early.
    dbHandle.prepare('SELECT 1 FROM tender LIMIT 1').get();
  } catch {
    dbHandle = null;
  }
  return dbHandle;
}

/** Force a re-open. Tests point ANCLA_INDEX at a fixture and need the handle dropped. */
export function resetIndex(): void {
  try {
    dbHandle?.close();
  } catch {
    /* already closed */
  }
  dbHandle = null;
  dbTried = false;
}

/** Query the index, returning [] rather than throwing when it is absent or mid-load. */
export function rows<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
  const db = index();
  if (!db) return [];
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } catch {
    return [];
  }
}

export function row<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): T | undefined {
  return rows<T>(sql, params)[0];
}

export function count(table: string): number {
  const r = row<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export type LoadedSnapshot = {
  month: string;
  stamp: string;
  snapshot: Snapshot;
  /** Leaf digests in anchored order. Held because a proof needs the whole tree. */
  leaves: Buffer[];
  /** table\x00id -> leaf index. */
  positions: Map<string, number>;
};

let cached: LoadedSnapshot | null = null;

/** The newest stored snapshot for a month, or null when nothing is mirrored. */
export async function loadMonth(month: string): Promise<LoadedSnapshot | null> {
  if (cached?.month === month) return cached;
  const refs = await archives(month);
  if (!refs.length) return null;
  const ref = refs[refs.length - 1];
  let snapshot: Snapshot;
  try {
    snapshot = await readSnapshot(snapshotPath(ref));
  } catch {
    // The archive is mirrored but not yet canonicalized. Building it here would
    // block the event loop for minutes, so report absence instead.
    return null;
  }
  const leaves = snapshot.records.map(leafFor);
  const positions = new Map<string, number>();
  for (let i = 0; i < snapshot.records.length; i++) {
    const r = snapshot.records[i];
    positions.set(`${r.table}\x00${r.id}`, i);
  }
  cached = { month, stamp: ref.stamp, snapshot, leaves, positions };
  return cached;
}

export function dropSnapshotCache(): void {
  cached = null;
}

export type ProofDocument = {
  month: string;
  anchoredDay: string | null;
  table: string;
  id: string;
  byteHash: string;
  leafIndex: number;
  leafCount: number;
  merkleRoot: string;
  archiveSha256: string;
  canonVersion: string;
  archiveStamp: string;
  proof: { hash: string; side: 'left' | 'right' }[];
};

/**
 * The proof document the verifier consumes. Field names match what `ancla prove`
 * prints, so a proof from the CLI and a proof from the API are the same object and
 * the page has one code path.
 */
export async function proofFor(
  month: string,
  table: string,
  id: string,
  anchoredDay: string | null,
): Promise<ProofDocument | null> {
  const loaded = await loadMonth(month);
  if (!loaded) return null;
  const idx = loaded.positions.get(`${table}\x00${id}`);
  if (idx === undefined) return null;
  const rec = loaded.snapshot.records[idx];
  return {
    month,
    anchoredDay,
    table,
    id,
    byteHash: rec.byteHash,
    leafIndex: idx,
    leafCount: loaded.leaves.length,
    merkleRoot: loaded.snapshot.merkleRoot,
    archiveSha256: loaded.snapshot.archiveSha256,
    canonVersion: loaded.snapshot.canonVersion,
    archiveStamp: loaded.stamp,
    proof: merkleProof(loaded.leaves, idx),
  };
}

/** Months with at least one mirrored archive. */
export async function storedMonths(): Promise<string[]> {
  return months();
}

/** Every stored version of a month, oldest first. More than one means a rewrite. */
export async function monthVersions(month: string): Promise<{ stamp: string; file: string }[]> {
  return (await archives(month)).map((a) => ({ stamp: a.stamp, file: a.file }));
}

// ---------------------------------------------------------------------------
// Watch reports, flattened into a change feed
// ---------------------------------------------------------------------------

export type FeedItem = Change & {
  /** When the daily job noticed. This is the timestamp a deadline is counted from. */
  detectedAt: string;
  month: string;
  closedMonth: boolean;
  previousStamp: string;
  currentStamp: string;
};

export function reportsDir(): string {
  return join(dataRoot(), 'reports');
}

export async function listReports(): Promise<string[]> {
  try {
    return (await readdir(reportsDir()))
      .filter((f) => /^watch-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
  } catch {
    return [];
  }
}

export async function readReport(file: string): Promise<WatchReport | null> {
  try {
    return JSON.parse(await readFile(join(reportsDir(), file), 'utf8')) as WatchReport;
  } catch {
    return null;
  }
}

/** Flatten a report into feed items. Exported so the alert engine reuses it. */
export function flatten(report: WatchReport): FeedItem[] {
  const out: FeedItem[] = [];
  for (const f of report.findings) {
    for (const c of f.diff.changes) {
      out.push({
        ...c,
        detectedAt: report.ranAt,
        month: f.month,
        closedMonth: f.closedMonth,
        previousStamp: f.previousStamp,
        currentStamp: f.currentStamp,
      });
    }
  }
  return out;
}

let feedCache: { at: number; items: FeedItem[] } | null = null;
const FEED_TTL_MS = 30_000;

/**
 * Every change across every stored report, newest detection first.
 *
 * Cached briefly. The daily job writes one file a day, so a stale feed is stale by
 * seconds at worst, and re-reading every report on every request would make the
 * public feed the slowest endpoint on the site.
 */
export async function feed(): Promise<FeedItem[]> {
  if (feedCache && Date.now() - feedCache.at < FEED_TTL_MS) return feedCache.items;
  const items: FeedItem[] = [];
  for (const file of await listReports()) {
    const r = await readReport(file);
    if (r) items.push(...flatten(r));
  }
  items.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0));
  feedCache = { at: Date.now(), items };
  return items;
}

export function dropFeedCache(): void {
  feedCache = null;
}

export type FeedFilter = {
  /** Detection date, YYYY-MM-DD. */
  date?: string;
  /** Archive month, YYYYMM. */
  month?: string;
  kind?: ChangeKind;
  table?: string;
  /** Institution cédula. Requires the index to resolve; ignored when absent. */
  institution?: string;
  nroSicop?: string;
};

/** Reports the daily job has written, newest first, with a count of what each found. */
export async function reportSummaries(): Promise<
  { day: string; ranAt: string; monthsChecked: number; monthsUpdated: string[]; changes: number }[]
> {
  const out = [];
  for (const file of await listReports()) {
    const r = await readReport(file);
    if (!r) continue;
    out.push({
      day: file.slice(6, 16),
      ranAt: r.ranAt,
      monthsChecked: r.monthsChecked,
      monthsUpdated: r.monthsUpdated,
      changes: r.findings.reduce((n, f) => n + f.diff.changes.length, 0),
    });
  }
  return out.reverse();
}
