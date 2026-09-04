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
import { archives, months, snapshotsFor } from '../../cli/src/store.ts';
import { listBundles, loadBundle } from '../../cli/src/bundles.ts';
import { hasSchema } from '../../cli/src/schemas.ts';
import type { Source } from '../../ingest/src/source.ts';
import { SOURCES } from '../../ingest/src/sources.ts';
import { allCaptures, capturesFor, recoveryInventory } from '../../cli/src/versions.ts';
import type { BundleLine, BundleManifest } from '../../bundle/src/bundle.ts';
import { parseChanges } from '../../bundle/src/bundle.ts';
import {
  type BundleSummary,
  classifyMovement,
  decimalDelta,
  hasNumericMove,
  summarizeBundle,
} from '../../bundle/src/summary.ts';
import { dataRoot } from '../../ingest/src/manifest.ts';
import { chainSnapshot } from './chain.ts';

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
  // Current rules first, then any older canonicalisation still on disk. A site
  // pointed at a data directory that predates a canonicaliser bump should serve
  // the proofs it can rather than go blank: those proofs check against the roots
  // anchored under those same rules, and every response names its version.
  let snapshot: Snapshot | null = null;
  for (const { path } of await snapshotsFor(ref)) {
    try {
      snapshot = await readSnapshot(path);
      break;
    } catch {
      /* unreadable under these rules; try the next */
    }
  }
  // The archive is mirrored but not yet canonicalized. Building it here would
  // block the event loop for minutes, so report absence instead.
  if (!snapshot) return null;
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
      // `watch-<day>.json` is Costa Rica; `watch-<day>-<source>.json` is anyone
      // else. Both are reports and both belong in the feed.
      .filter((f) => /^watch-\d{4}-\d{2}-\d{2}(-[a-z0-9-]+)?\.json$/.test(f))
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

// ---------------------------------------------------------------------------
// Captures, bundles and what cannot be recovered
// ---------------------------------------------------------------------------

/**
 * The version surface. The rest of the API answers "what does the record say";
 * these answer "which copy of the record, and what did the copy before it say".
 *
 * Everything here reads the same files the CLI writes, so the site is a view of
 * the evidence and never a second source of it. A reader who does not trust the
 * site can run the same commands and get the same bytes.
 */
/**
 * Every publisher whose archives can become records.
 *
 * A source with no canonicalisation schema is deliberately absent: its archives
 * are mirrored and hashed, but they cannot be turned into rows, so there is
 * nothing for a version browser to show beyond a file size. Honduras is in that
 * state and showing it as if it were Costa Rica would be a claim we cannot back.
 */
export function anchoredSources(): Source[] {
  return SOURCES.filter((s) => hasSchema(s.id));
}

/**
 * Captures across every anchored publisher, not just the first one.
 *
 * This used to default to Costa Rica everywhere, which meant Panamá ran the whole
 * pipeline daily — mirrored, canonicalised, 37 roots on chain — and appeared
 * nowhere on the site that exists to show it. Each capture already carries its
 * `source`, so the API returns them all and the page filters.
 */
export async function captures(period?: string) {
  const chain = await chainSnapshot();
  const out = [];
  for (const source of anchoredSources()) {
    out.push(
      ...(period
        ? await capturesFor(period, source, chain.versions)
        : await allCaptures(source, chain.versions)),
    );
  }
  return out;
}

export async function recovery() {
  const chain = await chainSnapshot();
  const out = [];
  for (const source of anchoredSources()) {
    out.push(...(await recoveryInventory(source, chain.versions)));
  }
  return out;
}

export type BundleSummary = {
  source: string;
  period: string;
  pair: string;
  from: BundleManifest['from'];
  to: BundleManifest['to'];
  counts: BundleManifest['counts'];
  changeCount: number;
  valuesOmitted: number;
  bundleDigest: string;
  changesSha256: string;
  canonVersion: string;
  bundleVersion: string;
  builtAt: string;
};

function summarise(period: string, pair: string, m: BundleManifest): BundleSummary {
  return {
    source: m.source,
    period,
    pair,
    from: m.from,
    to: m.to,
    counts: m.counts,
    changeCount: m.changeCount,
    valuesOmitted: m.valuesOmitted,
    bundleDigest: m.bundleDigest,
    changesSha256: m.changesSha256,
    canonVersion: m.canonVersion,
    bundleVersion: m.bundleVersion,
    builtAt: m.builtAt,
  };
}

async function allStoredBundles() {
  const out = [];
  for (const source of anchoredSources()) out.push(...(await listBundles(source)));
  return out;
}

export async function bundleSummaries(period?: string): Promise<BundleSummary[]> {
  return (await allStoredBundles())
    .filter((b) => !period || b.period === period)
    .map((b) => summarise(b.period, b.pair, b.manifest));
}

export async function bundleManifest(
  period: string,
  pair: string,
): Promise<BundleManifest | null> {
  const hit = (await allStoredBundles()).find((b) => b.period === period && b.pair === pair);
  return hit ? hit.manifest : null;
}

/**
 * A page of a bundle's changes.
 *
 * Read from disk on each request rather than cached: a bundle is tens of
 * megabytes and there is no reason for a public read path to hold one resident.
 * Filtering happens after parsing because the file is JSONL, not an index — for
 * a closed-month rewrite that is a few thousand lines, and for the open month
 * the caller should be paging anyway.
 */
/**
 * One parsed bundle stays resident, the rest are read on demand.
 *
 * Parsing 278,691 JSON lines takes a couple of seconds, and a reader paging
 * through a bundle asks for the same one repeatedly. Same policy as the snapshot
 * cache above and for the same reason: cache exactly one, because two is a memory
 * budget nobody set.
 */
let bundleCache: { dir: string; lines: BundleLine[]; summary: BundleSummary } | null = null;

async function parsed(period: string, pair: string) {
  const hit = (await allStoredBundles()).find((b) => b.period === period && b.pair === pair);
  if (!hit) return null;
  if (bundleCache?.dir !== hit.dir) {
    const { changes } = await loadBundle(hit.dir);
    const lines = parseChanges(changes);
    bundleCache = { dir: hit.dir, lines, summary: summarizeBundle(lines) };
  }
  return { manifest: hit.manifest, ...bundleCache };
}

export function dropBundleCache(): void {
  bundleCache = null;
}

/**
 * Which fields moved, and how. This is the view that makes a bundle readable:
 * a flat list cannot distinguish six thousand rows of a date being filled in
 * from twelve rows where an amount changed.
 */
export async function bundleFields(
  period: string,
  pair: string,
): Promise<(BundleSummary & { changeCount: number; valuesOmitted: number }) | null> {
  const p = await parsed(period, pair);
  if (!p) return null;
  return { ...p.summary, changeCount: p.manifest.changeCount, valuesOmitted: p.manifest.valuesOmitted };
}

export type ChangeFilter = {
  limit?: number;
  offset?: number;
  kind?: string | null;
  table?: string | null;
  field?: string | null;
  /** Only rows where some field moved as a number. Reprints do not count. */
  numeric?: boolean;
  /**
   * Every row worth reading, unpaged: anything that carries values and is not a
   * plain addition.
   *
   * This is what the page actually consumes, and it exists so the page behaves
   * identically against a live API and against a static export. Filtering and
   * paging then happen in the browser over one payload, which removes a whole
   * class of divergence between the two. For 202608 it is 13,199 rows and 1.9 MB
   * over the wire, against 259,891 rows and 22 MB for the whole file — because a
   * new record's evidence is the archive, and we keep the archive.
   */
  readable?: boolean;
};

/** Attach how each field moved. Derived, so it stays outside the bundle digest. */
function withMovement(l: BundleLine): BundleLine {
  if (!l.fields) return l;
  return {
    ...l,
    fields: l.fields.map((f) => ({
      ...f,
      movement: classifyMovement(f.before, f.after),
      delta: decimalDelta(f.before, f.after),
    })),
  };
}

/**
 * A page of changes, with the per-field movement attached.
 *
 * The movement and the delta are computed here rather than stored, so they stay
 * outside the bundle digest and anyone can recompute them from the same file.
 */
export async function bundleChanges(
  period: string,
  pair: string,
  opts: ChangeFilter = {},
): Promise<{ total: number; matched: number; changes: BundleLine[] } | null> {
  const p = await parsed(period, pair);
  if (!p) return null;
  if (opts.readable) {
    const rows = p.lines.filter((l) => !l.valuesOmitted && l.kind !== 'added');
    return { total: p.lines.length, matched: rows.length, changes: rows.map(withMovement) };
  }
  const matched = p.lines.filter(
    (l) =>
      (!opts.kind || l.kind === opts.kind) &&
      (!opts.table || l.table === opts.table) &&
      (!opts.field || (l.fields ?? []).some((f) => f.field === opts.field)) &&
      (!opts.numeric || hasNumericMove(l)),
  );
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? 100), 1000);
  const page = matched.slice(offset, offset + limit).map(withMovement);
  return { total: p.lines.length, matched: matched.length, changes: page };
}
