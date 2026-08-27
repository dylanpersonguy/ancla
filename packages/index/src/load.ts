/**
 * Fold the monthly archives into one history.
 *
 * The Observatorio publishes a separate zip per month, and every event row sits
 * in the month it happened. A tender published in January and contracted in
 * September is two rows in two files, and inside either file alone the pair does
 * not exist. So a single archive can only measure the procedures that opened and
 * closed inside their own month, which is not a sample of procurement, it is the
 * fast tail of it.
 *
 * Measured on the twelve 2024 archives, joining Contratos to DetalleCarteles on
 * NRO_SICOP:
 *
 *   202412 alone            n=652     median 12d  max 28d
 *   the same query stitched n=32,647  median 34d  max 356d
 *
 * 26,738 of those 32,795 links cross a month boundary and exist nowhere else.
 * That gap is what this loader is for.
 *
 * Three properties matter more than speed.
 *
 *   Resumable   Each archive version is recorded in loaded_archive when it
 *               commits. A rerun skips what is already in. Nothing else is
 *               needed: there is no partial state to reconcile.
 *   Atomic      One transaction per archive. A crash rolls the whole archive
 *               back rather than leaving a month half-stitched, which is the
 *               only failure that would be invisible afterwards.
 *   Bounded     Rows stream out of a generator and only tables in the schema
 *               are ever inflated, so peak memory is one zip plus one CSV.
 *
 * Order independence is the fourth property and the subtle one. The registry
 * tables collide heavily across months, because Proveedores, Instituciones and
 * FuncionariosInhibicion are republished whole every single month: 2024 reads
 * 532,935 supplier rows and holds 50,195. Whichever row comes from the later
 * source_month wins, enforced in the upsert itself rather than by loading in
 * order, so loading 202412 before 202401 gives the same database.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { detectDelimiter, parseCsv } from '../../canonicalize/src/canonical.ts';
import { listEntries, readEntry, tableNameOf } from '../../canonicalize/src/zip.ts';
import { type Db, openDb, parseDate, parseNum } from '../../core/src/db.ts';
import { dataRoot } from '../../ingest/src/manifest.ts';
import { SPECS, type TableSpec } from './spec.ts';

export type ArchiveRef = {
  /** YYYYMM. */
  month: string;
  /** Publication stamp from the filename, e.g. 20240920T175819Z. */
  stamp: string;
  path: string;
  bytes: number;
};

export type LoadResult = {
  month: string;
  stamp: string;
  sha256: string;
  /** True when this exact archive version was already in loaded_archive. */
  skipped: boolean;
  /** Rows read out of the CSV, per index table. */
  read: Record<string, number>;
  /** Rows the upsert actually wrote or refreshed, per index table. */
  applied: Record<string, number>;
  /** Rows dropped because their first key column was blank. */
  noKey: number;
  /** CSVs the spec expects that this archive does not carry at all. */
  missing: string[];
  elapsedMs: number;
};

export function archivesRoot(): string {
  return join(dataRoot(), 'archives');
}

/** Mirrored filenames are `<stamp>-<shortsha>.zip`. */
const ARCHIVE_RE = /^(\d{8}T\d{6}Z)-([0-9a-f]+)\.zip$/;

/**
 * Every stored version of one month, oldest first.
 *
 * More than one entry means the Observatorio rewrote a closed month after we
 * had already mirrored it, which is the event this project exists to catch.
 */
export function archiveVersions(month: string, root = archivesRoot()): ArchiveRef[] {
  const dir = join(root, month);
  if (!existsSync(dir)) return [];
  const out: ArchiveRef[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.zip')) continue;
    const m = ARCHIVE_RE.exec(name);
    // An unrecognized name still loads: the filename becomes its own version
    // label so the archive is never silently ignored.
    const stamp = m ? m[1] : name.slice(0, -4);
    const path = join(dir, name);
    out.push({ month, stamp, path, bytes: statSync(path).size });
  }
  return out.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
}

export function listMonths(root = archivesRoot()): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((d) => /^\d{6}$/.test(d))
    .sort();
}

/**
 * The version of each month to load: the newest we hold.
 *
 * An earlier version is still on disk and still anchored. It is the differ's
 * subject, not the index's; the index answers "what does the record say now".
 */
export function latestArchives(
  opts: { from?: string; to?: string; root?: string } = {},
): ArchiveRef[] {
  const root = opts.root ?? archivesRoot();
  const out: ArchiveRef[] = [];
  for (const month of listMonths(root)) {
    if (opts.from && month < opts.from) continue;
    if (opts.to && month > opts.to) continue;
    const versions = archiveVersions(month, root);
    if (versions.length) out.push(versions[versions.length - 1]);
  }
  return out;
}

/**
 * Unique indexes the index schema does not declare.
 *
 * sanction and inhibition have no primary key, and both are cumulative
 * registries republished in full every month. Without a unique key, 189 months
 * of FuncionariosInhibicion alone would insert tens of millions of copies of the
 * same few thousand officials. The key columns match the ones canonicalize
 * already treats as identity for these tables.
 *
 * COALESCE is not decoration. SQLite treats NULLs as distinct inside a unique
 * index, so a null CODIGO_PRODUCTO would defeat the constraint on exactly the
 * rows most likely to repeat.
 */
export const EXTRA_DDL = `
CREATE UNIQUE INDEX IF NOT EXISTS ux_sanction_key ON sanction(
  COALESCE(cedula_proveedor,''), COALESCE(cedula_institucion,''),
  COALESCE(no_resolucion,''), COALESCE(codigo_producto,''));
CREATE UNIQUE INDEX IF NOT EXISTS ux_inhibition_key ON inhibition(
  COALESCE(ced_institucion,''), COALESCE(ced_funcionario,''), COALESCE(fecha_inicio,''));
CREATE INDEX IF NOT EXISTS ix_supplier_nombre ON supplier(nombre);
`;

/** Open the index and apply the additions this package needs. */
export function openIndex(path?: string): Db {
  const db = openDb(path);
  db.exec(EXTRA_DDL);
  return db;
}

/**
 * Proveedores.FECHA_CONSTITUCION and both SancionProveedores date columns are
 * published as DDMMYYYY with no separators, which parseDate does not accept.
 * Day-first is measured, not assumed: across the mirror the first pair reaches
 * 31 and the second never exceeds 12.
 */
export function parseDate8(raw: string | null | undefined): string | null {
  const iso = parseDate(raw);
  if (iso) return iso;
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec((raw ?? '').trim());
  if (!m) return null;
  const day = Number(m[1]);
  const mon = Number(m[2]);
  if (day < 1 || day > 31 || mon < 1 || mon > 12) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function upsertSql(spec: TableSpec): string {
  const cols = spec.columns.map((c) => c.col);
  const all = [...cols, 'source_month', ...(spec.stamp ? ['archive_stamp'] : [])];
  const target = spec.coalesceKey
    ? spec.key.map((k) => `COALESCE(${k},'')`).join(', ')
    : spec.key.join(', ');
  const set = all
    .filter((c) => !spec.key.includes(c))
    .map((c) => `${c}=excluded.${c}`)
    .join(', ');
  return (
    `INSERT INTO ${spec.table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')}) ` +
    `ON CONFLICT(${target}) DO UPDATE SET ${set} ` +
    // The guard is what makes load order irrelevant. An older archive may
    // restate a row it no longer owns; it must not win.
    `WHERE excluded.source_month >= ${spec.table}.source_month`
  );
}

/** Header name to position, upper-cased because the source mixes both cases. */
function headerIndex(header: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < header.length; i++) {
    const name = header[i].replace(/^﻿/, '').trim().toUpperCase();
    if (name && !map.has(name)) map.set(name, i);
  }
  return map;
}

function alreadyLoaded(db: Db, month: string, stamp: string): boolean {
  const row = db
    .prepare('SELECT 1 AS ok FROM loaded_archive WHERE source_month = ? AND archive_stamp = ?')
    .get(month, stamp);
  return row !== undefined;
}

export type LoadOptions = {
  force?: boolean;
  /** One line per archive. */
  onProgress?: (line: string) => void;
  /** One line per table that had rows. Off by default; it is 11 lines a month. */
  onTable?: (line: string) => void;
};

/** Load one archive version. Returns without touching the database if already in. */
export function loadArchive(db: Db, ref: ArchiveRef, opts: LoadOptions = {}): LoadResult {
  const started = Date.now();
  const empty: LoadResult = {
    month: ref.month,
    stamp: ref.stamp,
    sha256: '',
    skipped: true,
    read: {},
    applied: {},
    noKey: 0,
    missing: [],
    elapsedMs: 0,
  };
  if (!opts.force && alreadyLoaded(db, ref.month, ref.stamp)) return empty;

  const buf = readFileSync(ref.path);
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const entries = listEntries(buf);
  const byTable = new Map<string, (typeof entries)[number]>();
  for (const e of entries) {
    const name = tableNameOf(e.name);
    // A rewritten archive nests CSVs under YYYYMM/; tableNameOf flattens both
    // layouts, so the first entry for a name is the only one there is.
    if (name && !byTable.has(name)) byTable.set(name, e);
  }

  const read: Record<string, number> = {};
  const applied: Record<string, number> = {};
  const missing: string[] = [];
  let noKey = 0;

  db.exec('BEGIN');
  try {
    for (const spec of SPECS) {
      read[spec.table] = 0;
      applied[spec.table] = 0;
      const entry = byTable.get(spec.csv);
      if (!entry) {
        missing.push(spec.csv);
        continue;
      }
      // Several months ship a zero-length CSV. Inflating one throws, and there
      // is nothing in it either way.
      if (entry.uncompressedSize === 0 || entry.compressedSize === 0) continue;

      const csv = readEntry(buf, entry);
      if (csv.length === 0) continue;
      const rows = parseCsv(csv, detectDelimiter(csv));
      const first = rows.next();
      if (first.done) continue;
      const idx = headerIndex(first.value);

      // Resolve each column to a position once per table, not once per row.
      const positions = spec.columns.map((c) => {
        const names = Array.isArray(c.csv) ? c.csv : [c.csv];
        for (const nm of names) {
          const at = idx.get(nm.toUpperCase());
          if (at !== undefined) return at;
        }
        return -1;
      });
      const kinds = spec.columns.map((c) => c.kind);
      const isKey = spec.columns.map((c) => spec.key.includes(c.col));
      const leadKey = spec.columns.findIndex((c) => c.col === spec.key[0]);

      const stmt = db.prepare(upsertSql(spec));
      const width = spec.columns.length + 1 + (spec.stamp ? 1 : 0);
      const values: (string | number | null)[] = new Array(width);

      for (const row of rows) {
        read[spec.table]++;
        let blankKey = false;
        for (let i = 0; i < positions.length; i++) {
          const at = positions[i];
          const raw = at < 0 ? '' : (row[at] ?? '').trim();
          let v: string | number | null;
          if (kinds[i] === 'date') v = parseDate(raw);
          else if (kinds[i] === 'date8') v = parseDate8(raw);
          else if (kinds[i] === 'num') v = parseNum(raw);
          else v = raw;
          if (isKey[i]) {
            // Key parts are never null: a null would make the unique index treat
            // every such row as distinct and reintroduce the duplicates.
            if (v === null) v = raw;
            if (i === leadKey && v === '') blankKey = true;
          }
          values[i] = v === '' && !isKey[i] ? null : v;
        }
        if (blankKey) {
          // No identity, so no way to restate or supersede it later. These are
          // trailing fragments of rows the source itself broke.
          noKey++;
          continue;
        }
        values[spec.columns.length] = ref.month;
        if (spec.stamp) values[spec.columns.length + 1] = ref.stamp;
        applied[spec.table] += stmt.run(...(values as never[])).changes;
      }
      if (read[spec.table] > 0) {
        opts.onTable?.(
          `  ${ref.month} ${spec.table.padEnd(12)} read ${read[spec.table]}` +
            ` applied ${applied[spec.table]}`,
        );
      }
    }

    db.prepare(
      'INSERT OR REPLACE INTO loaded_archive ' +
        '(source_month, archive_stamp, sha256, loaded_at, row_counts) VALUES (?, ?, ?, ?, ?)',
    ).run(ref.month, ref.stamp, sha256, new Date().toISOString(), JSON.stringify(applied));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return {
    month: ref.month,
    stamp: ref.stamp,
    sha256,
    skipped: false,
    read,
    applied,
    noKey,
    missing,
    elapsedMs: Date.now() - started,
  };
}

export type RangeResult = {
  results: LoadResult[];
  loaded: number;
  skipped: number;
  read: Record<string, number>;
  applied: Record<string, number>;
  noKey: number;
};

/** Load the latest version of every month in range. */
export function loadRange(
  db: Db,
  opts: LoadOptions & { from?: string; to?: string; root?: string } = {},
): RangeResult {
  const refs = latestArchives(opts);
  const total: RangeResult = {
    results: [],
    loaded: 0,
    skipped: 0,
    read: {},
    applied: {},
    noKey: 0,
  };
  for (const ref of refs) {
    const r = loadArchive(db, ref, opts);
    total.results.push(r);
    if (r.skipped) {
      total.skipped++;
      opts.onProgress?.(`${ref.month} ${ref.stamp}  already loaded`);
      continue;
    }
    total.loaded++;
    const rows = Object.values(r.applied).reduce((s, v) => s + v, 0);
    opts.onProgress?.(
      `${ref.month} ${ref.stamp}  ${rows} rows  ${(r.elapsedMs / 1000).toFixed(1)}s` +
        (r.missing.length ? `  missing: ${r.missing.join(',')}` : ''),
    );
    total.noKey += r.noKey;
    for (const [k, v] of Object.entries(r.read)) total.read[k] = (total.read[k] ?? 0) + v;
    for (const [k, v] of Object.entries(r.applied)) total.applied[k] = (total.applied[k] ?? 0) + v;
  }
  return total;
}
