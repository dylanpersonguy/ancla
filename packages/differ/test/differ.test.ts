import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CanonRecord } from '../../canonicalize/src/canonical.ts';
import type { Snapshot } from '../../canonicalize/src/snapshot.ts';
import { diff } from '../src/index.ts';

function rec(table: string, id: string, byteHash: string, valueHash = byteHash): CanonRecord {
  return { table, id, byteHash, valueHash };
}

function snap(records: CanonRecord[], over: Partial<Snapshot> = {}): Snapshot {
  return {
    canonVersion: 'ancla-canon-1',
    month: '202607',
    archiveSha256: 'aa',
    merkleRoot: 'bb',
    recordCount: records.length,
    tables: [...new Set(records.map((r) => r.table))].map((t) => ({
      table: t,
      rows: 0,
      records: 0,
      schema: 'sch0',
      contentAddressed: false,
      duplicateKeys: 0,
    })),
    records,
    ...over,
  };
}

test('identical snapshots produce no changes', () => {
  const s = snap([rec('Contratos', 'C1|0', 'h1'), rec('Ofertas', 'O1|1', 'h2')]);
  const d = diff(s, snap([...s.records]));
  assert.deepEqual(d.counts, {
    added: 0, recordedAmendment: 0, silentRevision: 0, reformatted: 0, removed: 0,
  });
});

test('a value change is a silent revision', () => {
  const before = snap([rec('Contratos', 'C1|0', 'h1', 'v1')]);
  const after = snap([rec('Contratos', 'C1|0', 'h2', 'v2')]);
  const d = diff(before, after);
  assert.equal(d.counts.silentRevision, 1);
  assert.equal(d.counts.reformatted, 0);
  assert.equal(d.changes[0].kind, 'silentRevision');
});

test('a byte change with the same value is reformatting, not a revision', () => {
  // 1.000 reprinted as 1. The whole point of the two-hash design.
  const before = snap([rec('Contratos', 'C1|0', 'bytesA', 'sameValue')]);
  const after = snap([rec('Contratos', 'C1|0', 'bytesB', 'sameValue')]);
  const d = diff(before, after);
  assert.equal(d.counts.reformatted, 1);
  assert.equal(d.counts.silentRevision, 0);
});

test('a new contract is an addition', () => {
  const d = diff(snap([]), snap([rec('Contratos', 'C9|0', 'h')]));
  assert.equal(d.counts.added, 1);
  assert.equal(d.counts.recordedAmendment, 0);
});

test('a new SECUENCIA on a known contract is a recorded amendment', () => {
  const before = snap([rec('Contratos', 'C1|0', 'h1')]);
  const after = snap([rec('Contratos', 'C1|0', 'h1'), rec('Contratos', 'C1|1', 'h2')]);
  const d = diff(before, after);
  assert.equal(d.counts.recordedAmendment, 1);
  assert.equal(d.counts.added, 0);
});

test('a dropped record is a removal', () => {
  const d = diff(snap([rec('Ofertas', 'O1|1', 'h')]), snap([]));
  assert.equal(d.counts.removed, 1);
});

test('the same id in different tables does not collide', () => {
  const before = snap([rec('Ofertas', 'X', 'h1'), rec('Contratos', 'X', 'h2')]);
  const after = snap([rec('Ofertas', 'X', 'h1'), rec('Contratos', 'X', 'CHANGED')]);
  const d = diff(before, after);
  assert.equal(d.counts.silentRevision, 1);
  assert.equal(d.changes[0].table, 'Contratos');
});

test('schema changes are reported separately from record changes', () => {
  const before = snap([rec('Ofertas', 'O1', 'h')]);
  const after = snap([rec('Ofertas', 'O1', 'h')]);
  after.tables[0].schema = 'sch-NEW';
  const d = diff(before, after);
  assert.equal(d.schemaChanges.length, 1);
  assert.equal(d.schemaChanges[0].table, 'Ofertas');
  assert.equal(d.counts.silentRevision, 0);
});

test('a canonicalizer version mismatch is flagged, not silently compared', () => {
  const before = snap([rec('Ofertas', 'O1', 'h')], { canonVersion: 'ancla-canon-0' });
  const d = diff(before, snap([rec('Ofertas', 'O1', 'h')]));
  assert.ok(d.canonVersionMismatch);
});

test('counts stay complete when the change list is capped', () => {
  const before = snap(Array.from({ length: 100 }, (_, i) => rec('Ofertas', `O${i}`, 'a', 'a')));
  const after = snap(Array.from({ length: 100 }, (_, i) => rec('Ofertas', `O${i}`, 'b', 'b')));
  const d = diff(before, after, { limit: 5 });
  assert.equal(d.changes.length, 5);
  assert.equal(d.counts.silentRevision, 100);
});
