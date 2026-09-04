/**
 * An evidence bundle: what actually changed between two published copies of one
 * period, at the level of a row and a field.
 *
 * A Merkle root proves that a file changed. It cannot say what it said before,
 * and it cannot say which contract moved. Anyone auditing a republication needs
 * the second thing, and needs to be able to rebuild it themselves rather than
 * take our word for the summary. So a bundle is:
 *
 *   manifest.json      identity of both versions, counts, and two digests
 *   changes.jsonl.gz   one line per changed row, with old and new values
 *
 * The bundle digest is what goes on chain. It is taken over the manifest with
 * `builtAt` and the digest itself excluded, so two machines that hold the same
 * two archives produce the same digest — which is the only reason publishing it
 * is worth anything.
 *
 * The chain still stores no procurement data. It stores a commitment to this
 * bundle, the same way it stores a commitment to an archive.
 */

import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { findRows } from '../../canonicalize/src/identity.ts';
import type { Schema } from '../../canonicalize/src/schema.ts';
import type { Snapshot } from '../../canonicalize/src/snapshot.ts';
import { listEntries, readEntry, tableNameOf } from '../../canonicalize/src/zip.ts';
import { type Change, type ChangeKind, type SchemaChange, diff } from '../../differ/src/index.ts';

/**
 * Moved to 2 on 2026-09-03, when a bundle gained the right to leave a whole class
 * of change out of the file and had to start saying so in its own digest.
 *
 * ancla-bundle-1 bundles stay verifiable under ancla-bundle-1: `digestInputV1`
 * below is frozen and dispatched on the manifest's own version, for the same
 * reason a released canonicaliser is never edited.
 */
export const BUNDLE_VERSION = 'ancla-bundle-2';

export const ALL_KINDS: ChangeKind[] = [
  'added',
  'recordedAmendment',
  'silentRevision',
  'reformatted',
  'removed',
];

/**
 * Which classes of change are written out as lines at all.
 *
 * Distinct from the detail budget below, and the difference matters. The budget
 * drops *values* from a line that is still there; a line policy drops the line.
 * Both are recorded in the manifest and both are inside the digest, because a
 * bundle that quietly contains less than it appears to is worse than no bundle.
 *
 * `counts` always covers every change regardless of policy, so nothing is hidden:
 * the manifest still says 246,692 records were added, it just does not enumerate
 * them. Their evidence is the archive, and the archive is kept.
 */
export type LinePolicy = { kinds: ChangeKind[] };

export const FULL_LINES: LinePolicy = { kinds: ALL_KINDS };

/**
 * Everything except plain additions.
 *
 * For the open month, which grows by a quarter of a million rows a day. Writing
 * every one of those out spends gigabytes a year to record that August grew
 * during August, and buries the fifteen hundred rows that were quietly edited or
 * withdrawn — which is the only part anyone will ever ask about.
 */
export const REVISIONS_ONLY: LinePolicy = {
  kinds: ['recordedAmendment', 'silentRevision', 'reformatted', 'removed'],
};

/**
 * Which rows get their values written out, when there are more changes than a
 * bundle should carry.
 *
 * A rewritten closed month moves tens of rows and every one of them fits. The
 * daily append to an open month adds a quarter of a million, and writing every
 * field of every one of those produces a gigabyte to say "the month grew". So
 * detail is spent in the order the changes are worth reading, and the manifest
 * records both the policy and what it dropped. Nothing is silently omitted.
 */
export const DETAIL_ORDER: ChangeKind[] = [
  'silentRevision',
  'removed',
  'reformatted',
  'recordedAmendment',
  'added',
];

export const DEFAULT_MAX_DETAIL = 200_000;

/**
 * The budget for "write out everything", as a real number.
 *
 * Not Infinity: the budget goes into the manifest, the manifest goes through
 * JSON, and `JSON.stringify(Infinity)` is `null`. A bundle built with an infinite
 * budget would therefore fail its own digest check the moment it was read back
 * off disk — the one failure that makes the whole artifact worthless.
 */
export const UNLIMITED_DETAIL = Number.MAX_SAFE_INTEGER;

export type FieldChange = { field: string; before: string | null; after: string | null };

export type BundleLine = {
  kind: ChangeKind;
  table: string;
  id: string;
  beforeHash: { byteHash: string; valueHash: string } | null;
  afterHash: { byteHash: string; valueHash: string } | null;
  /** Full row, for a change where one side does not exist. */
  before?: Record<string, string>;
  after?: Record<string, string>;
  /** Only the fields that differ, for a row that exists on both sides. */
  fields?: FieldChange[];
  /** True when the detail budget was spent before this row. Hashes still stand. */
  valuesOmitted?: true;
};

export type VersionRef = {
  source: string;
  period: string;
  /** Publisher Last-Modified, compacted. The moment this copy was served. */
  stamp: string;
  file: string;
  archiveSha256: string;
  merkleRoot: string;
  recordCount: number;
};

export type BundleManifest = {
  bundleVersion: string;
  canonVersion: string;
  source: string;
  period: string;
  from: VersionRef;
  to: VersionRef;
  counts: Record<ChangeKind, number>;
  schemaChanges: SchemaChange[];
  /** Lines actually written. Not the number of changes: see linePolicy. */
  changeCount: number;
  /** Which classes of change are written as lines. */
  linePolicy: LinePolicy;
  /** Changes the line policy left out entirely. Still counted in `counts`. */
  omittedByPolicy: number;
  detailPolicy: { maxDetail: number; order: ChangeKind[] };
  valuesOmitted: number;
  changesSha256: string;
  bundleDigest: string;
  /** Deliberately outside the digest: when it was built is not what it says. */
  builtAt: string;
  /** True when the two copies were canonicalised under different rules. */
  canonVersionMismatch: boolean;
};

/**
 * The bytes the bundle digest is taken over.
 *
 * Written as an explicit ordered array rather than JSON.stringify of the object,
 * because object key order is a property of how the object was built and this has
 * to survive being rebuilt by someone else's code in five years.
 */
type DigestBody = Omit<BundleManifest, 'bundleDigest' | 'builtAt'>;

const versionTuple = (r: VersionRef) => [
  r.source, r.period, r.stamp, r.file, r.archiveSha256, r.merkleRoot, String(r.recordCount),
];

/**
 * The ancla-bundle-1 digest. Frozen.
 *
 * Two commitments were written under it and they have to stay checkable, so this
 * function is never edited — the same rule the canonicaliser lives under. It is
 * reached only by dispatch on a manifest's own `bundleVersion`.
 */
export function digestInputV1(m: DigestBody): string {
  return JSON.stringify([
    m.bundleVersion,
    m.canonVersion,
    m.source,
    m.period,
    versionTuple(m.from),
    versionTuple(m.to),
    DETAIL_ORDER.map((k) => [k, m.counts[k]]),
    m.schemaChanges.map((s) => [s.table, s.before, s.after]),
    m.changeCount,
    [m.detailPolicy.maxDetail, m.detailPolicy.order],
    m.valuesOmitted,
    m.changesSha256,
    m.canonVersionMismatch,
  ]);
}

/** ancla-bundle-2: the same, plus what the line policy left out. */
export function digestInputV2(m: DigestBody): string {
  return JSON.stringify([
    m.bundleVersion,
    m.canonVersion,
    m.source,
    m.period,
    versionTuple(m.from),
    versionTuple(m.to),
    DETAIL_ORDER.map((k) => [k, m.counts[k]]),
    m.schemaChanges.map((s) => [s.table, s.before, s.after]),
    m.changeCount,
    // Ordered by ALL_KINDS rather than as given, so two builds that chose the
    // same set in a different order still agree.
    ALL_KINDS.filter((k) => m.linePolicy.kinds.includes(k)),
    m.omittedByPolicy,
    [m.detailPolicy.maxDetail, m.detailPolicy.order],
    m.valuesOmitted,
    m.changesSha256,
    m.canonVersionMismatch,
  ]);
}

export function digestInput(m: DigestBody): string {
  return m.bundleVersion === 'ancla-bundle-1' ? digestInputV1(m) : digestInputV2(m);
}

export function bundleDigest(m: DigestBody): string {
  return createHash('sha256').update(digestInput(m), 'utf8').digest('hex');
}

/** One JSON object per line, keys in a fixed order, newline terminated. */
export function serializeLine(l: BundleLine): string {
  const o: Record<string, unknown> = {
    kind: l.kind,
    table: l.table,
    id: l.id,
    beforeHash: l.beforeHash,
    afterHash: l.afterHash,
  };
  if (l.before) o.before = sortedFields(l.before);
  if (l.after) o.after = sortedFields(l.after);
  if (l.fields) o.fields = l.fields;
  if (l.valuesOmitted) o.valuesOmitted = true;
  return `${JSON.stringify(o)}\n`;
}

function sortedFields(f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(f).sort()) out[k] = f[k] as string;
  return out;
}

export function fieldDiff(
  before: Record<string, string> | null,
  after: Record<string, string> | null,
): FieldChange[] {
  const names = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: FieldChange[] = [];
  for (const field of names) {
    const b = before?.[field] ?? null;
    const a = after?.[field] ?? null;
    if (b !== a) out.push({ field, before: b, after: a });
  }
  return out.sort((x, y) => (x.field < y.field ? -1 : x.field > y.field ? 1 : 0));
}

const NEEDS_BEFORE: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'removed', 'silentRevision', 'reformatted',
]);
const NEEDS_AFTER: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'added', 'recordedAmendment', 'silentRevision', 'reformatted',
]);

/** Decide which changes get their values written, without reordering the output. */
export function detailBudget(changes: Change[], maxDetail: number): Set<Change> {
  if (changes.length <= maxDetail) return new Set(changes);
  const chosen = new Set<Change>();
  for (const kind of DETAIL_ORDER) {
    for (const c of changes) {
      if (c.kind !== kind || chosen.size >= maxDetail) continue;
      chosen.add(c);
    }
    if (chosen.size >= maxDetail) break;
  }
  return chosen;
}

/**
 * Locate each table inside the archive without decompressing any of it.
 *
 * Reading them all up front is the obvious version and it holds every table of
 * both archives in memory at once — the better part of two gigabytes for one
 * month, to look at the handful of tables that actually changed. The reader
 * returns null for a table the archive does not carry, which is a real state:
 * the set of tables is not constant across the mirror.
 */
function tableReader(archive: Buffer): (table: string) => Buffer | null {
  const entries = new Map<string, ReturnType<typeof listEntries>[number]>();
  for (const e of listEntries(archive)) {
    const t = tableNameOf(e.name);
    if (t && !entries.has(t)) entries.set(t, e);
  }
  return (table) => {
    const e = entries.get(table);
    return e ? readEntry(archive, e) : null;
  };
}

export type BuildOptions = {
  schema?: Schema;
  maxDetail?: number;
  /** Which classes of change to write as lines. Defaults to all of them. */
  linePolicy?: LinePolicy;
  onProgress?: (line: string) => void;
};

export type BuiltBundle = {
  manifest: BundleManifest;
  /** Uncompressed JSONL. Hashing this, not the gzip, is what makes it portable. */
  changes: Buffer;
};

/**
 * Build the bundle for one republication.
 *
 * Both archives are read table by table so only one table's rows are resident at
 * a time. The diff itself is over the snapshots, which are hash indexes and cheap.
 */
export function buildBundle(
  from: { snapshot: Snapshot; archive: Buffer; ref: Pick<VersionRef, 'source' | 'stamp' | 'file'> },
  to: { snapshot: Snapshot; archive: Buffer; ref: Pick<VersionRef, 'source' | 'stamp' | 'file'> },
  opts: BuildOptions = {},
): BuiltBundle {
  const maxDetail = opts.maxDetail ?? DEFAULT_MAX_DETAIL;
  if (!Number.isSafeInteger(maxDetail) || maxDetail < 0) {
    throw new Error(`maxDetail must be a non-negative safe integer, got ${maxDetail}`);
  }
  const linePolicy = opts.linePolicy ?? FULL_LINES;
  const keep = new Set(linePolicy.kinds);
  for (const k of linePolicy.kinds) {
    if (!ALL_KINDS.includes(k)) throw new Error(`unknown change kind in line policy: ${k}`);
  }
  const log = opts.onProgress ?? (() => {});
  const d = diff(from.snapshot, to.snapshot);

  // Counts stay complete; only the lines are filtered. A reader is told how many
  // records were added even when the bundle does not list them one by one.
  const written = d.changes.filter((c) => keep.has(c.kind));
  const omittedByPolicy = d.changes.length - written.length;

  const detailed = detailBudget(written, maxDetail);
  const byTable = new Map<string, Change[]>();
  for (const c of written) {
    const list = byTable.get(c.table);
    if (list) list.push(c);
    else byTable.set(c.table, [c]);
  }

  const beforeTable = tableReader(from.archive);
  const afterTable = tableReader(to.archive);

  const parts: string[] = [];
  let valuesOmitted = 0;

  for (const table of [...byTable.keys()].sort()) {
    const changes = (byTable.get(table) as Change[]).slice().sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const wantBefore = new Set<string>();
    const wantAfter = new Set<string>();
    for (const c of changes) {
      if (!detailed.has(c)) continue;
      if (NEEDS_BEFORE.has(c.kind)) wantBefore.add(c.id);
      if (NEEDS_AFTER.has(c.kind)) wantAfter.add(c.id);
    }

    // Scoped so each table's decompressed bytes are collectable before the next.
    const beforeRows = (() => {
      const buf = wantBefore.size ? beforeTable(table) : null;
      return buf ? findRows(table, buf, wantBefore, opts.schema) : new Map();
    })();
    const afterRows = (() => {
      const buf = wantAfter.size ? afterTable(table) : null;
      return buf ? findRows(table, buf, wantAfter, opts.schema) : new Map();
    })();
    log(`  ${table.padEnd(28)} ${changes.length.toLocaleString().padStart(9)} changes`);

    for (const c of changes) {
      const line: BundleLine = {
        kind: c.kind,
        table,
        id: c.id,
        beforeHash: c.before ?? null,
        afterHash: c.after ?? null,
      };
      if (!detailed.has(c)) {
        line.valuesOmitted = true;
        valuesOmitted++;
        parts.push(serializeLine(line));
        continue;
      }
      const b = beforeRows.get(c.id) ?? null;
      const a = afterRows.get(c.id) ?? null;
      if (c.kind === 'removed') {
        if (b) line.before = b;
      } else if (c.kind === 'added' || c.kind === 'recordedAmendment') {
        if (a) line.after = a;
      } else {
        line.fields = fieldDiff(b, a);
      }
      parts.push(serializeLine(line));
    }
  }

  const changes = Buffer.from(parts.join(''), 'utf8');
  const changesSha256 = createHash('sha256').update(changes).digest('hex');

  const body: Omit<BundleManifest, 'bundleDigest' | 'builtAt'> = {
    bundleVersion: BUNDLE_VERSION,
    canonVersion: to.snapshot.canonVersion,
    source: to.ref.source,
    period: to.snapshot.month,
    from: {
      source: from.ref.source,
      period: from.snapshot.month,
      stamp: from.ref.stamp,
      file: from.ref.file,
      archiveSha256: from.snapshot.archiveSha256,
      merkleRoot: from.snapshot.merkleRoot,
      recordCount: from.snapshot.recordCount,
    },
    to: {
      source: to.ref.source,
      period: to.snapshot.month,
      stamp: to.ref.stamp,
      file: to.ref.file,
      archiveSha256: to.snapshot.archiveSha256,
      merkleRoot: to.snapshot.merkleRoot,
      recordCount: to.snapshot.recordCount,
    },
    counts: d.counts,
    schemaChanges: d.schemaChanges,
    changeCount: written.length,
    linePolicy: { kinds: ALL_KINDS.filter((k) => keep.has(k)) },
    omittedByPolicy,
    detailPolicy: { maxDetail, order: DETAIL_ORDER },
    valuesOmitted,
    changesSha256,
    canonVersionMismatch: d.canonVersionMismatch,
  };

  return {
    manifest: { ...body, bundleDigest: bundleDigest(body), builtAt: new Date().toISOString() },
    changes,
  };
}

/**
 * `bundles/<period>/<fromStamp>__<toStamp>__<canonVersion>` under the source root.
 *
 * The canonicaliser is in the path for the same reason it is in the snapshot
 * name: rebuilding a bundle under new rules must not destroy the one whose digest
 * is already committed on chain. Both readings of the same two archives are true,
 * they are true about different record sets, and a reader checking the older
 * commitment needs the older bundle to still be there.
 *
 * ancla-canon-1 bundles were written to the unsuffixed path before this existed,
 * so that path is still read.
 */
export function bundleDir(
  root: string,
  period: string,
  fromStamp: string,
  toStamp: string,
  canonVersion: string,
  bundleVersion: string = BUNDLE_VERSION,
): string {
  const pair = `${fromStamp}__${toStamp}`;
  const parts = [pair];
  if (canonVersion !== 'ancla-canon-1') parts.push(canonVersion);
  if (bundleVersion !== 'ancla-bundle-1') parts.push(bundleVersion);
  return join(root, 'bundles', period, parts.join('__'));
}

export async function writeBundle(dir: string, b: BuiltBundle): Promise<string> {
  await mkdir(dir, { recursive: true });
  await pipeline(
    Readable.from([b.changes]),
    createGzip({ level: 9 }),
    createWriteStream(join(dir, 'changes.jsonl.gz')),
  );
  await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(b.manifest, null, 2)}\n`, 'utf8');
  return dir;
}

export async function readManifest(dir: string): Promise<BundleManifest> {
  return JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
}

export async function readChanges(dir: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  const source = createReadStream(join(dir, 'changes.jsonl.gz'));
  // Piping does not forward a read error, and an unhandled 'error' on the source
  // takes the process down past whatever try/catch the caller wrapped this in.
  source.on('error', (err) => gunzip.destroy(err));
  source.pipe(gunzip);
  for await (const c of gunzip) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function parseChanges(buf: Buffer): BundleLine[] {
  return buf
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}
