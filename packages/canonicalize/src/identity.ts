/**
 * How a row gets its name, defined once.
 *
 * A row-level diff is only meaningful if two copies of the archive agree on which
 * rows are the same row. That rule used to live inside canonicalizeTable, where
 * nothing else could reach it, so anything that needed to look a record up again —
 * the record history, an evidence bundle — reimplemented a subset of it. Every
 * such reimplementation dropped the content-addressed case, which is 50 to 80% of
 * three tables. Looking up `sha256:...#2` returned nothing and the caller reported
 * "not in this copy", which is a false removal.
 *
 * So the rule is here, one `assignId` used by the canonicalizer and by every
 * reader. If it is wrong it is wrong everywhere at once, which is the only kind of
 * wrong that gets noticed.
 */

import { createHash } from 'node:crypto';
import { cleanHeader, detectDelimiter, parseCsv } from './csv.ts';
import { type Schema, type TableDef, tableDef } from './schema.ts';

/**
 * Bumped from ancla-canon-1 on 2026-09-03, when the CSV reader stopped
 * desynchronising on the publisher's unescaped inch marks. See parseCsv.
 *
 * The version had to move with the rule. Every root anchored before that day was
 * produced under v1 and stays verifiable under v1: the archives are unchanged and
 * v1 is reproducible from this history. What a v1 root does not do is describe
 * the same set of records a v2 root describes, because v1 merged rows that v2
 * keeps apart. Every commitment carries its canon version in `vmeta` precisely so
 * a reader is never left guessing which rules produced a root.
 */
export const CANON_VERSION = 'ancla-canon-2';

export const FS = '\x1f'; // between a field name and its value
export const RS = '\x1e'; // between fields
export const NUL = '\x00';

export function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

export function encode(table: string, id: string, pairs: [string, string][]): string {
  const body = pairs
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}${FS}${v}`)
    .join(RS);
  return `${CANON_VERSION}${NUL}${table}${NUL}${id}${NUL}${body}`;
}

/** Fingerprint of a table's column set, so a schema change is visible as itself. */
export function schemaFingerprint(table: string, header: string[]): string {
  return sha256(`${CANON_VERSION}${NUL}schema${NUL}${table}${NUL}${header.join(RS)}`).slice(0, 16);
}

export type RowIdentity = {
  id: string;
  pairs: [string, string][];
  /** True when identity came from the row's own content, not a declared key. */
  contentAddressed: boolean;
};

/**
 * Stateful id assignment for one table in one archive.
 *
 * Stateful because two of the rules are: an id may only be used once, and literal
 * duplicate rows are distinguished by how many times they have already appeared.
 * Both are answers about the rows seen so far, so the assigner must be created per
 * table per archive and fed every row in file order.
 */
export function idAssigner(table: string, header: string[], schema?: Schema) {
  const def: TableDef | null = tableDef(table, schema);
  const keyCols = (def?.key ?? []).filter((k) => header.includes(k));
  const usable = keyCols.length === (def?.key.length ?? 0) && keyCols.length > 0;
  const keyIdx = keyCols.map((k) => header.indexOf(k));

  const seen = new Set<string>();
  const occurrences = new Map<string, number>();
  let duplicateKeys = 0;

  return {
    usable,
    get duplicateKeys() {
      return duplicateKeys;
    },
    /** True once the whole table has been read, if any row was content-addressed. */
    get contentAddressed() {
      return !usable || duplicateKeys > 0;
    },
    assign(row: string[]): RowIdentity {
      const pairs: [string, string][] = [];
      for (let i = 0; i < header.length; i++) pairs.push([header[i] as string, row[i] ?? '']);

      let id = '';
      if (usable) {
        const parts = keyIdx.map((i) => (row[i] ?? '').trim());
        if (!parts.every((p) => p === '')) id = parts.join('|');
      }

      if (id === '' || seen.has(id)) {
        if (id !== '') duplicateKeys++;
        // Content addressing: identity is the row itself. Three tables emit literal
        // duplicate rows, so an occurrence index keeps them individually addressable
        // and lets the differ notice when the number of copies changes. Identical
        // rows are interchangeable, so this stays stable regardless of row order.
        const digest = sha256(encode(table, '', pairs)).slice(0, 32);
        const n = occurrences.get(digest) ?? 0;
        occurrences.set(digest, n + 1);
        const addressed = `sha256:${digest}#${n}`;
        seen.add(addressed);
        return { id: addressed, pairs, contentAddressed: true };
      }
      seen.add(id);
      return { id, pairs, contentAddressed: false };
    },
  };
}

export type TableReader = {
  header: string[];
  schema: string;
  rows: Generator<RowIdentity>;
};

/**
 * Read one table's rows with their canonical ids. Returns null for an empty file,
 * which is a real state: some months ship a table with a header and nothing under it.
 */
export function readTable(table: string, buf: Buffer, schema?: Schema): TableReader | null {
  const it = parseCsv(buf, detectDelimiter(buf));
  const first = it.next();
  if (first.done) return null;
  const header = cleanHeader(first.value);
  const assigner = idAssigner(table, header, schema);
  function* rows(): Generator<RowIdentity> {
    for (const row of it) yield assigner.assign(row);
  }
  return { header, schema: schemaFingerprint(table, header), rows: rows() };
}

/**
 * Pull the full field map for a named set of rows, in one pass over the table.
 *
 * The alternative — scan the table once per record — is what the record history
 * used to do, and it is a minute of work per record on a 300 MB table. A bundle
 * asks about thousands of rows at once, so it has to be one pass.
 */
export function findRows(
  table: string,
  buf: Buffer,
  ids: Set<string>,
  schema?: Schema,
): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  if (!ids.size) return out;
  const reader = readTable(table, buf, schema);
  if (!reader) return out;
  for (const { id, pairs } of reader.rows) {
    if (!ids.has(id) || out.has(id)) continue;
    const fields: Record<string, string> = {};
    for (const [k, v] of pairs) fields[k] = v;
    out.set(id, fields);
    if (out.size === ids.size) break;
  }
  return out;
}
