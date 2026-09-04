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
 *
 * Row identity — which row is "the same row" in a later copy — lives in
 * identity.ts, because readers other than this one need the identical rule.
 */

import { cleanHeader, detectDelimiter, parseCsv } from './csv.ts';
import {
  CANON_VERSION,
  encode,
  idAssigner,
  schemaFingerprint,
  sha256,
} from './identity.ts';
import { type Schema, type TableDef, tableDef } from './schema.ts';

export { CANON_VERSION, schemaFingerprint };
export { detectDelimiter, parseCsv };

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
  const body = s.replace(/^[+-]/, '');
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

export function canonicalizeTable(
  table: string,
  buf: Buffer,
  schema?: Schema,
): CanonTableResult {
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
  const header = cleanHeader(first.value);
  const def: TableDef | null = tableDef(table, schema);
  const volatile = new Set(def?.volatile ?? []);
  const assigner = idAssigner(table, header, schema);

  const records: CanonRecord[] = [];
  let rowCount = 0;

  for (const row of it) {
    rowCount++;
    const { id, pairs } = assigner.assign(row);

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
    contentAddressed: assigner.contentAddressed,
    rowCount,
    duplicateKeys: assigner.duplicateKeys,
  };
}
