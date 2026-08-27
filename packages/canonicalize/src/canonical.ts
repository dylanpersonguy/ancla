/**
 * Deterministic canonicalization of Observatorio records.
 *
 * CANON_VERSION is part of every anchor. If the rules below ever change, the
 * version must change with them, and old anchors stay verifiable under the old
 * version. Never mutate a released version: doing so silently invalidates every
 * anchor that came before, which is the one failure this project cannot survive.
 *
 * Each record yields two digests.
 *
 *   byteHash   every field exactly as published. Any change at all moves it,
 *              including pure reformatting. This is what gets anchored.
 *   valueHash  volatile fields dropped and numbers normalized, so 1.000 and 1
 *              agree. This is what the differ uses to separate a reformatting
 *              from a real edit.
 *
 * Both matter. The byte hash is the evidence; the value hash is the judgement.
 */

import { createHash } from 'node:crypto';
import { type TableDef, tableDef } from './schema.ts';

export const CANON_VERSION = 'ancla-canon-1';

const FS = '\x1f'; // between a field name and its value
const RS = '\x1e'; // between fields
const NUL = '\x00';

/** Parse CSV from a Buffer without materializing the whole file as a string. */
export function* parseCsv(buf: Buffer, delim: number): Generator<string[]> {
  const QUOTE = 0x22;
  const CR = 0x0d;
  const LF = 0x0a;
  let row: string[] = [];
  let start = 0;
  let i = 0;
  let inQuotes = false;
  let sawQuote = false;

  const pushField = (end: number) => {
    let s = buf.toString('utf8', start, end);
    if (sawQuote) {
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
      s = s.replace(/""/g, '"');
    }
    row.push(s);
    sawQuote = false;
  };

  while (i < buf.length) {
    const c = buf[i];
    if (inQuotes) {
      if (c === QUOTE) {
        if (buf[i + 1] === QUOTE) i++;
        else inQuotes = false;
      }
      i++;
      continue;
    }
    if (c === QUOTE) {
      inQuotes = true;
      sawQuote = true;
      i++;
      continue;
    }
    if (c === delim) {
      pushField(i);
      i++;
      start = i;
      continue;
    }
    if (c === LF || c === CR) {
      pushField(i);
      if (c === CR && buf[i + 1] === LF) i++;
      i++;
      start = i;
      if (row.length > 1 || row[0] !== '') yield row;
      row = [];
      continue;
    }
    i++;
  }
  if (start < buf.length || row.length > 0) {
    pushField(buf.length);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

/** Sniff ';' vs ',' from the header. SancionProveedores is the only comma table. */
export function detectDelimiter(buf: Buffer): number {
  const end = Math.min(buf.length, 4096);
  let semi = 0;
  let comma = 0;
  for (let i = 0; i < end; i++) {
    const c = buf[i];
    if (c === 0x0a) break;
    if (c === 0x3b) semi++;
    else if (c === 0x2c) comma++;
  }
  return comma > semi ? 0x2c : 0x3b;
}

/**
 * Canonical numeric form, or null when the value is not a number.
 *
 * Deliberately hand-written rather than using parseFloat: float64 cannot
 * represent these decimals exactly, and a comparison built on it reports
 * differences that are not there.
 */
export function canonicalNumber(raw: string): string | null {
  const s = raw.trim().replace(',', '.');
  if (s === '' || !/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  let neg = s.startsWith('-');
  let body = s.replace(/^[+-]/, '');
  let [int = '', frac = ''] = body.split('.');
  int = int.replace(/^0+/, '');
  frac = frac.replace(/0+$/, '');
  if (int === '') int = '0';
  if (int === '0' && frac === '') neg = false; // no negative zero
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export type CanonRecord = {
  table: string;
  /** Stable identity across snapshots. */
  id: string;
  byteHash: string;
  valueHash: string;
};

function encode(table: string, id: string, pairs: [string, string][]): string {
  const body = pairs
    .slice()
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}${FS}${v}`)
    .join(RS);
  return `${CANON_VERSION}${NUL}${table}${NUL}${id}${NUL}${body}`;
}

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Fingerprint of a table's column set, so a schema change is visible as itself. */
export function schemaFingerprint(table: string, header: string[]): string {
  return sha256(`${CANON_VERSION}${NUL}schema${NUL}${table}${NUL}${header.join(RS)}`).slice(0, 16);
}

export type CanonTableResult = {
  table: string;
  header: string[];
  schema: string;
  records: CanonRecord[];
  /** True when the declared key was not unique and the whole row is the identity. */
  contentAddressed: boolean;
  rowCount: number;
  duplicateKeys: number;
};

export function canonicalizeTable(table: string, buf: Buffer): CanonTableResult {
  const delim = detectDelimiter(buf);
  const it = parseCsv(buf, delim);
  const first = it.next();
  if (first.done) {
    return {
      table,
      header: [],
      schema: schemaFingerprint(table, []),
      records: [],
      contentAddressed: false,
      rowCount: 0,
      duplicateKeys: 0,
    };
  }
  const header = first.value.map((h) => h.trim().replace(/^﻿/, ''));
  const def: TableDef | null = tableDef(table);
  const keyCols = (def?.key ?? []).filter((k) => header.includes(k));
  const usable = keyCols.length === (def?.key.length ?? 0) && keyCols.length > 0;
  const volatile = new Set(def?.volatile ?? []);

  const records: CanonRecord[] = [];
  const seen = new Set<string>();
  /** Occurrence counter for content-addressed rows, so literal duplicates stay distinct. */
  const occurrences = new Map<string, number>();
  let duplicateKeys = 0;
  let rowCount = 0;

  for (const row of it) {
    rowCount++;
    const pairs: [string, string][] = [];
    for (let i = 0; i < header.length; i++) pairs.push([header[i], row[i] ?? '']);

    let id: string;
    if (usable) {
      const parts = keyCols.map((k) => (row[header.indexOf(k)] ?? '').trim());
      id = parts.join('|');
      if (parts.every((p) => p === '')) id = '';
    } else {
      id = '';
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
      id = `sha256:${digest}#${n}`;
    }
    seen.add(id);

    const valuePairs: [string, string][] = pairs
      .filter(([k]) => !volatile.has(k))
      .map(([k, v]) => [k, canonicalNumber(v) ?? v.trim()]);

    records.push({
      table,
      id,
      byteHash: sha256(encode(table, id, pairs)),
      valueHash: sha256(encode(table, id, valuePairs)),
    });
  }

  return {
    table,
    header,
    schema: schemaFingerprint(table, header),
    records,
    contentAddressed: !usable || duplicateKeys > 0,
    rowCount,
    duplicateKeys,
  };
}
