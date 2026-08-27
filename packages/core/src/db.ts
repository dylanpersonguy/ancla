/**
 * Shared handle on the longitudinal index.
 *
 * node:sqlite ships with Node 24, so the index adds no dependency. It is marked
 * experimental upstream; the warning is suppressed here rather than in each
 * caller. If the API moves, this file is the only place that has to change.
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export function dataRoot(): string {
  return process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data');
}

export function indexPath(): string {
  return process.env.ANCLA_INDEX ?? join(dataRoot(), 'index.sqlite');
}

export const SCHEMA_PATH = join(HERE, 'schema.sql');

export type Db = InstanceType<typeof DatabaseSync>;

/** Open the index, creating and migrating it if needed. */
export function openDb(path = indexPath(), opts: { readonly?: boolean } = {}): Db {
  mkdirSync(dirname(path), { recursive: true });
  // Passing an explicit undefined for options throws, so branch instead.
  const db = opts.readonly ? new DatabaseSync(path, { readOnly: true }) : new DatabaseSync(path);
  if (!opts.readonly) db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return db;
}

/** Rows as plain objects. Thin wrapper so callers never touch statement lifecycle. */
export function query<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function queryOne<T = Record<string, unknown>>(
  db: Db,
  sql: string,
  params: unknown[] = [],
): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

/** Parse Observatorio dates, which arrive in several formats, to ISO or null. */
export function parseDate(raw: string | null | undefined): string | null {
  const s = (raw ?? '').trim();
  if (!s) return null;
  let m = /^(\d{2})[-/](\d{2})[-/](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/** Numbers may use a comma decimal separator. Returns null when not numeric. */
export function parseNum(raw: string | null | undefined): number | null {
  const s = (raw ?? '').trim().replace(',', '.');
  if (!s || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Whole days between two ISO dates, or null if either is missing or nonsensical. */
export function daysBetween(a: string | null, b: string | null): number | null {
  if (!a || !b) return null;
  const d = (Date.parse(b) - Date.parse(a)) / 86_400_000;
  return Number.isFinite(d) ? Math.round(d) : null;
}
