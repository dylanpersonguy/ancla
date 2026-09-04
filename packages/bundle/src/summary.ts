/**
 * The shape of a republication, before any of the rows are read.
 *
 * A bundle for a rewritten month can hold thousands of changed rows, and a list
 * of thousands of rows is not an answer to anything. The first question anyone
 * asks is which *fields* moved: six thousand rows where a notification date was
 * filled in is a batch job, and twelve rows where an awarded amount moved is a
 * story. Both look identical in a flat list.
 *
 * Everything here is derived from the changes file, so it is not part of the
 * bundle digest and nothing had to change on chain to add it. Anyone holding the
 * bundle recomputes it and gets the same numbers.
 *
 * On what is deliberately NOT computed: there is no net total per field. Summing
 * PRECIO_UNITARIO across unrelated products produces a number that means nothing
 * and reads like it means everything. Counts of which way values moved are
 * honest at this altitude; the per-row delta is where the magnitude belongs.
 */

import { canonicalNumber } from '../../canonicalize/src/canonical.ts';
import type { BundleLine, FieldChange } from './bundle.ts';

export type Movement =
  /** Both sides are numbers and they differ as numbers. */
  | 'numeric'
  /**
   * Both sides are the same number, printed differently. 1.000 became 1.
   *
   * Kept apart from `numeric` for the same reason byteHash is kept apart from
   * valueHash: a field summary that counts 1,905 reprints as 1,905 amount
   * changes is the headline this project exists not to produce.
   */
  | 'reprint'
  /** Was empty or absent, now carries a value. */
  | 'filled'
  /** Carried a value, now empty or absent. */
  | 'cleared'
  /** Both sides are text and they differ. */
  | 'text';

const blank = (v: string | null) => v === null || v.trim() === '';

export function classifyMovement(before: string | null, after: string | null): Movement {
  if (blank(before) && !blank(after)) return 'filled';
  if (!blank(before) && blank(after)) return 'cleared';
  const a = canonicalNumber(before ?? '');
  const b = canonicalNumber(after ?? '');
  if (a === null || b === null) return 'text';
  return decimalDirection(before, after) === null ? 'reprint' : 'numeric';
}

/**
 * Compare two canonical decimals exactly.
 *
 * Not parseFloat. float64 cannot represent these decimals, and a comparison
 * built on it reports differences that are not there — the same mistake that
 * produced 40,845 phantom discrepancies during development. Scale both sides to
 * a common integer and let BigInt do it.
 */
function scaled(a: string, b: string): [bigint, bigint] | null {
  const na = canonicalNumber(a);
  const nb = canonicalNumber(b);
  if (na === null || nb === null) return null;
  const split = (s: string) => {
    const neg = s.startsWith('-');
    const [int = '0', frac = ''] = s.replace(/^-/, '').split('.');
    return { neg, int, frac };
  };
  const x = split(na);
  const y = split(nb);
  const width = Math.max(x.frac.length, y.frac.length);
  const build = (p: { neg: boolean; int: string; frac: string }) =>
    BigInt((p.neg ? '-' : '') + p.int + p.frac.padEnd(width, '0'));
  return [build(x), build(y)];
}

export function decimalDirection(before: string | null, after: string | null): 'up' | 'down' | null {
  const pair = before === null || after === null ? null : scaled(before, after);
  if (!pair) return null;
  const [a, b] = pair;
  return b > a ? 'up' : b < a ? 'down' : null;
}

/** The signed difference, as a decimal string. Null when either side is not a number. */
export function decimalDelta(before: string | null, after: string | null): string | null {
  const pair = before === null || after === null ? null : scaled(before, after);
  if (!pair) return null;
  const [a, b] = pair;
  const diff = b - a;
  const width = Math.max(
    (canonicalNumber(before) ?? '').split('.')[1]?.length ?? 0,
    (canonicalNumber(after) ?? '').split('.')[1]?.length ?? 0,
  );
  if (width === 0) return diff.toString();
  const neg = diff < 0n;
  const digits = (neg ? -diff : diff).toString().padStart(width + 1, '0');
  const int = digits.slice(0, -width);
  const frac = digits.slice(-width).replace(/0+$/, '');
  return `${neg ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

export type FieldStat = {
  table: string;
  field: string;
  changes: number;
  numeric: number;
  reprint: number;
  filled: number;
  cleared: number;
  text: number;
  /** Of the numeric moves, how many went each way. */
  up: number;
  down: number;
};

export type TableStat = {
  table: string;
  rows: number;
  byKind: Record<string, number>;
};

export type BundleSummary = {
  /** Rows whose values were written out. The rest carry hashes only. */
  detailed: number;
  fields: FieldStat[];
  tables: TableStat[];
};

function key(table: string, field: string) {
  return `${table}\x00${field}`;
}

/**
 * Fold the changes file into per-field and per-table counts.
 *
 * Only rows that carry values contribute to the field counts: a row dropped to
 * hashes by the detail budget has no fields to attribute, and counting it
 * anywhere would make the summary disagree with the list under it.
 */
export function summarizeBundle(lines: BundleLine[]): BundleSummary {
  const fields = new Map<string, FieldStat>();
  const tables = new Map<string, TableStat>();
  let detailed = 0;

  for (const line of lines) {
    const table = tables.get(line.table) ?? { table: line.table, rows: 0, byKind: {} };
    table.rows++;
    table.byKind[line.kind] = (table.byKind[line.kind] ?? 0) + 1;
    tables.set(line.table, table);

    if (line.valuesOmitted) continue;
    detailed++;
    if (!line.fields) continue;

    for (const f of line.fields as FieldChange[]) {
      const k = key(line.table, f.field);
      const stat =
        fields.get(k) ??
        {
          table: line.table, field: f.field, changes: 0,
          numeric: 0, reprint: 0, filled: 0, cleared: 0, text: 0, up: 0, down: 0,
        };
      stat.changes++;
      const movement = classifyMovement(f.before, f.after);
      stat[movement]++;
      if (movement === 'numeric') {
        const dir = decimalDirection(f.before, f.after);
        if (dir === 'up') stat.up++;
        else if (dir === 'down') stat.down++;
      }
      fields.set(k, stat);
    }
  }

  return {
    detailed,
    // Most-changed first: the shape of the event is the top of this list.
    fields: [...fields.values()].sort(
      (a, b) => b.changes - a.changes || (a.table < b.table ? -1 : a.table > b.table ? 1 : 0),
    ),
    tables: [...tables.values()].sort((a, b) => b.rows - a.rows),
  };
}

/** Does this row touch a field that moved as a number? Drives the numeric filter. */
export function hasNumericMove(line: BundleLine): boolean {
  return (line.fields ?? []).some((f) => classifyMovement(f.before, f.after) === 'numeric');
}
