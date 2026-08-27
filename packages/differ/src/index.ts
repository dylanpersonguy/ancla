/**
 * Compare two snapshots of the same month and classify what moved.
 *
 * The classification is the product. Anyone can notice that a file changed; the
 * useful question is which of these it was:
 *
 *   added             a record that was not there before
 *   recordedAmendment a new revision of an existing contract, declared as such by
 *                     SICOP itself via SECUENCIA. Legitimate and expected.
 *   silentRevision    an existing record whose values changed with no amendment
 *                     recorded. This is the finding.
 *   reformatted       byte-level change only. Numbers reprinted, volatile fields
 *                     touched. Not a value change and must not be reported as one.
 *   removed           a record that is no longer published
 *
 * Keeping reformatted separate from silentRevision is what stops this from being
 * another project that cries tampering at 1.000 becoming 1.
 */

import type { CanonRecord } from '../../canonicalize/src/canonical.ts';
import type { Snapshot, TableStat } from '../../canonicalize/src/snapshot.ts';

export type ChangeKind =
  | 'added'
  | 'recordedAmendment'
  | 'silentRevision'
  | 'reformatted'
  | 'removed';

export type Change = {
  kind: ChangeKind;
  table: string;
  id: string;
  before?: { byteHash: string; valueHash: string };
  after?: { byteHash: string; valueHash: string };
};

export type SchemaChange = {
  table: string;
  before: string | null;
  after: string | null;
};

export type DiffResult = {
  month: string;
  from: { archiveSha256: string; merkleRoot: string; recordCount: number };
  to: { archiveSha256: string; merkleRoot: string; recordCount: number };
  counts: Record<ChangeKind, number>;
  schemaChanges: SchemaChange[];
  changes: Change[];
  /** True when the canonicalizer version differs, making the comparison unsound. */
  canonVersionMismatch: boolean;
};

function index(records: CanonRecord[]): Map<string, CanonRecord> {
  const m = new Map<string, CanonRecord>();
  for (const r of records) m.set(`${r.table}\x00${r.id}`, r);
  return m;
}

/**
 * Contracts carry their own revision counter. A key of NRO_CONTRATO|SECUENCIA
 * means an amendment arrives as a new record rather than an edit, so an addition
 * whose contract number is already present is a declared amendment, not a
 * surprise.
 */
function amendmentIndex(records: CanonRecord[]): Set<string> {
  const contracts = new Set<string>();
  for (const r of records) {
    if (r.table !== 'Contratos') continue;
    const nro = r.id.split('|')[0];
    if (nro) contracts.add(nro);
  }
  return contracts;
}

function schemaMap(tables: TableStat[]): Map<string, string> {
  return new Map(tables.map((t) => [t.table, t.schema]));
}

export function diff(from: Snapshot, to: Snapshot, opts: { limit?: number } = {}): DiffResult {
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  const a = index(from.records);
  const b = index(to.records);
  const priorContracts = amendmentIndex(from.records);

  const counts: Record<ChangeKind, number> = {
    added: 0,
    recordedAmendment: 0,
    silentRevision: 0,
    reformatted: 0,
    removed: 0,
  };
  const changes: Change[] = [];
  const push = (c: Change) => {
    counts[c.kind]++;
    if (changes.length < limit) changes.push(c);
  };

  for (const [k, next] of b) {
    const prev = a.get(k);
    if (!prev) {
      const isAmendment =
        next.table === 'Contratos' && priorContracts.has(next.id.split('|')[0] ?? '');
      push({
        kind: isAmendment ? 'recordedAmendment' : 'added',
        table: next.table,
        id: next.id,
        after: { byteHash: next.byteHash, valueHash: next.valueHash },
      });
      continue;
    }
    if (prev.byteHash === next.byteHash) continue;
    push({
      kind: prev.valueHash === next.valueHash ? 'reformatted' : 'silentRevision',
      table: next.table,
      id: next.id,
      before: { byteHash: prev.byteHash, valueHash: prev.valueHash },
      after: { byteHash: next.byteHash, valueHash: next.valueHash },
    });
  }

  for (const [k, prev] of a) {
    if (b.has(k)) continue;
    push({
      kind: 'removed',
      table: prev.table,
      id: prev.id,
      before: { byteHash: prev.byteHash, valueHash: prev.valueHash },
    });
  }

  const sa = schemaMap(from.tables);
  const sb = schemaMap(to.tables);
  const schemaChanges: SchemaChange[] = [];
  for (const table of new Set([...sa.keys(), ...sb.keys()])) {
    const before = sa.get(table) ?? null;
    const after = sb.get(table) ?? null;
    if (before !== after) schemaChanges.push({ table, before, after });
  }

  return {
    month: to.month,
    from: {
      archiveSha256: from.archiveSha256,
      merkleRoot: from.merkleRoot,
      recordCount: from.recordCount,
    },
    to: {
      archiveSha256: to.archiveSha256,
      merkleRoot: to.merkleRoot,
      recordCount: to.recordCount,
    },
    counts,
    schemaChanges,
    changes,
    canonVersionMismatch: from.canonVersion !== to.canonVersion,
  };
}

export function summarize(d: DiffResult): string {
  const c = d.counts;
  const lines = [
    `month ${d.month}`,
    `  records ${d.from.recordCount.toLocaleString()} -> ${d.to.recordCount.toLocaleString()}`,
    `  added              ${c.added.toLocaleString()}`,
    `  recorded amendment ${c.recordedAmendment.toLocaleString()}`,
    `  SILENT REVISION    ${c.silentRevision.toLocaleString()}`,
    `  reformatted only   ${c.reformatted.toLocaleString()}`,
    `  removed            ${c.removed.toLocaleString()}`,
  ];
  if (d.schemaChanges.length) {
    lines.push(`  schema changed in ${d.schemaChanges.length} table(s):`);
    for (const s of d.schemaChanges) {
      lines.push(`    ${s.table}: ${s.before ?? '(absent)'} -> ${s.after ?? '(absent)'}`);
    }
  }
  if (d.canonVersionMismatch) {
    lines.push('  WARNING: canonicalizer versions differ; this comparison is not sound');
  }
  return lines.join('\n');
}
