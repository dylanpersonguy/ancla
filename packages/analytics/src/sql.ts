/**
 * Query helpers shared by the screens.
 *
 * The date handling here exists because of a specific past failure in this
 * project: a normalisation routine turned 6780000 into 678 and produced 40,845
 * discrepancies that did not exist. The lesson taken from it is that silent
 * string surgery on source values is where the damage happens, so this file
 * inspects what is actually stored before it writes a predicate, and reports
 * what it decided instead of assuming.
 *
 * The Observatorio publishes dates as "2025-12-22 14:27:08.0000000" in some
 * tables and as "22/12/2025" in others, and the indexer may or may not have
 * normalised them by the time a query runs.
 */

import type { Db } from '../../core/src/db.ts';
import { query, queryOne } from '../../core/src/db.ts';

export type { Db };

/** How a date column is physically stored. */
export type DateShape = 'iso' | 'dmy' | 'empty' | 'unknown';

export interface DateColumn {
  shape: DateShape;
  /** Values sampled to reach that conclusion. Kept so the choice is auditable. */
  sampled: number;
}

const SHAPE_CACHE = new WeakMap<object, Map<string, DateColumn>>();

/**
 * Decide how a date column is stored, by looking at up to 200 stored values.
 *
 * A column of mixed shapes returns 'unknown', and dateExpr then accepts both
 * shapes and yields NULL for anything else. Rows in an unrecognised format are
 * counted as missing rather than coerced into a wrong date. Losing rows loudly
 * beats keeping them wrongly.
 */
export function dateColumn(db: Db, table: string, column: string): DateColumn {
  let perDb = SHAPE_CACHE.get(db as unknown as object);
  if (!perDb) {
    perDb = new Map();
    SHAPE_CACHE.set(db as unknown as object, perDb);
  }
  const key = `${table}.${column}`;
  const hit = perDb.get(key);
  if (hit) return hit;

  let rows: { v: string }[] = [];
  try {
    rows = query<{ v: string }>(
      db,
      `SELECT ${column} AS v FROM ${table} WHERE ${column} IS NOT NULL AND trim(${column}) <> '' LIMIT 200`,
    );
  } catch {
    rows = [];
  }

  let iso = 0;
  let dmy = 0;
  for (const r of rows) {
    const s = String(r.v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) iso++;
    else if (/^\d{2}[-/]\d{2}[-/]\d{4}/.test(s)) dmy++;
  }

  let shape: DateShape;
  if (rows.length === 0) shape = 'empty';
  else if (iso > 0 && dmy === 0) shape = 'iso';
  else if (dmy > 0 && iso === 0) shape = 'dmy';
  else shape = 'unknown';

  const out: DateColumn = { shape, sampled: rows.length };
  perDb.set(key, out);
  return out;
}

/**
 * SQL expression yielding YYYY-MM-DD for a date column, or NULL when the stored
 * value does not match a shape we recognise. The alias is applied when building
 * the expression rather than patched in afterwards, so a column name that also
 * appears inside a pattern cannot be rewritten by accident.
 */
export function dateExpr(db: Db, table: string, column: string, alias = ''): string {
  const col = alias ? `${alias}.${column}` : column;
  const isoExpr = `CASE WHEN ${col} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*' THEN substr(${col},1,10) END`;
  const dmyExpr =
    `CASE WHEN ${col} GLOB '[0-9][0-9][-/][0-9][0-9][-/][0-9][0-9][0-9][0-9]*'` +
    ` THEN substr(${col},7,4)||'-'||substr(${col},4,2)||'-'||substr(${col},1,2) END`;
  switch (dateColumn(db, table, column).shape) {
    case 'iso':
    case 'empty':
      return isoExpr;
    case 'dmy':
      return dmyExpr;
    default:
      return `COALESCE(${isoExpr}, ${dmyExpr})`;
  }
}

/** Common window options. Dates are inclusive ISO YYYY-MM-DD. */
export interface Window {
  from?: string;
  to?: string;
  /** source_month as YYYYMM, matching the archive the row came from. */
  month?: string;
  /** cedula_institucion. */
  institution?: string;
}

export interface Predicate {
  sql: string;
  params: unknown[];
}

/**
 * Build a WHERE fragment for a window over a table's publication-style date.
 * Returns an always-true fragment when nothing is constrained, so callers can
 * always interpolate it.
 */
export function windowPredicate(
  db: Db,
  table: string,
  dateCol: string,
  w: Window,
  opts: { institutionCol?: string; alias?: string } = {},
): Predicate {
  const alias = opts.alias ? `${opts.alias}.` : '';
  const expr = dateExpr(db, table, dateCol, opts.alias ?? '');
  const clauses: string[] = ['1=1'];
  const params: unknown[] = [];
  if (w.from) {
    clauses.push(`${expr} >= ?`);
    params.push(w.from);
  }
  if (w.to) {
    clauses.push(`${expr} <= ?`);
    params.push(w.to);
  }
  if (w.month) {
    clauses.push(`${alias}source_month = ?`);
    params.push(w.month);
  }
  if (w.institution && opts.institutionCol) {
    clauses.push(`${alias}${opts.institutionCol} = ?`);
    params.push(w.institution);
  }
  return { sql: clauses.join(' AND '), params };
}

/** Row count, or 0 when the table does not exist. */
export function tableCount(db: Db, table: string): number {
  try {
    const r = queryOne<{ c: number }>(db, `SELECT COUNT(*) AS c FROM ${table}`);
    return r?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Which of the tables a screen needs are empty. Used to degrade instead of lying. */
export function missingInputs(db: Db, tables: readonly string[]): string[] {
  return tables.filter((t) => tableCount(db, t) === 0);
}

/**
 * The date the mirror was taken, used as the observation date for censoring.
 *
 * Preference order: the newest archive actually loaded, then the newest stage
 * date seen, then today. Anything derived from this is only as good as the
 * loaded archives, which is why duration.ts prints it.
 */
export function asOfDate(db: Db): { asOf: string; source: 'loaded_archive' | 'stage_dates' | 'today' } {
  try {
    const r = queryOne<{ v: string | null }>(db, 'SELECT MAX(archive_stamp) AS v FROM loaded_archive');
    const s = (r?.v ?? '').trim();
    const m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
    if (m) return { asOf: `${m[1]}-${m[2]}-${m[3]}`, source: 'loaded_archive' };
  } catch {
    // fall through
  }
  try {
    const expr = dateExpr(db, 'stage_dates', 'publicacion');
    const r = queryOne<{ v: string | null }>(db, `SELECT MAX(${expr}) AS v FROM stage_dates`);
    if (r?.v) return { asOf: r.v, source: 'stage_dates' };
  } catch {
    // fall through
  }
  return { asOf: new Date().toISOString().slice(0, 10), source: 'today' };
}

/**
 * award_line, reduced to the latest act per awarded line.
 *
 * An award can be re-issued. The table's primary key includes nro_acto, so a
 * line awarded once and then re-issued appears twice with the full amount on
 * both rows. 6,709 lines in the loaded index carry more than one act, and 609 of
 * those carry a different price on the second one.
 *
 * Summing the raw table overstates total awarded value in colones by 33%. That
 * is not a rounding problem, it is a wrong number, and it would have gone into
 * every concentration index and every price benchmark in this package.
 *
 * The cast to integer matters: nro_acto is stored as text and its length runs
 * from three digits to seven, so ordering it as a string picks the wrong act.
 * The text tiebreak covers the handful of rows where the cast yields 0.
 *
 * Use this in place of `award_line` anywhere money or prices are involved.
 * Counting distinct tenders or winners does not need it, since those are already
 * deduplicated by DISTINCT.
 */
export const LATEST_AWARD_LINES = `(
  SELECT nro_sicop, nro_oferta, nro_linea, nro_acto, cedula_proveedor, codigo_producto,
         cantidad, precio_unitario, moneda, source_month
    FROM (
      SELECT al.*,
             ROW_NUMBER() OVER (
               PARTITION BY al.nro_sicop, al.nro_oferta, al.nro_linea
               ORDER BY CAST(al.nro_acto AS INTEGER) DESC, al.nro_acto DESC
             ) AS ancla_rn
        FROM award_line al
    )
   WHERE ancla_rn = 1
)`;

/** Whole days between two ISO dates. Null when either side is missing. */
export function days(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null;
  const d = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
}
