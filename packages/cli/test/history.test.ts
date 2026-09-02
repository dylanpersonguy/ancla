import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify, fieldDiff } from '../src/history.ts';

const v = (o: Partial<Parameters<typeof classify>[0]>) =>
  ({ present: true, byteHash: 'b', valueHash: 'v', ...o }) as Parameters<typeof classify>[0];

test('a value change with no recorded amendment is a silent revision', () => {
  assert.equal(classify(v({ valueHash: 'v1' }), v({ valueHash: 'v2' })), 'silentRevision');
});

test('same value, different bytes, is reformatting rather than a change', () => {
  // Quoting and trailing-space churn must not be reported as a revision, or the
  // signal drowns: 1,905 rows reformatted in one August copy alone.
  assert.equal(classify(v({ byteHash: 'b1' }), v({ byteHash: 'b2' })), 'reformatted');
});

test('appearing and disappearing are distinct from changing', () => {
  assert.equal(classify(v({ present: false }), v({})), 'added');
  assert.equal(classify(v({}), v({ present: false })), 'removed');
});

test('an identical record produces no transition', () => {
  assert.equal(classify(v({}), v({})), 'unchanged');
});

test('fieldDiff reports only what differs, and names absence', () => {
  const before = { NRO: '1', FECHA_NOTIFICACION: '', MONTO: '100' };
  const after = { NRO: '1', FECHA_NOTIFICACION: '2026-08-27', MONTO: '100' };
  assert.deepEqual(fieldDiff(before, after), [
    { field: 'FECHA_NOTIFICACION', before: '', after: '2026-08-27' },
  ]);
});

test('a field present in one copy and missing in the other is a difference', () => {
  // A column added or dropped between copies is a schema change the reader has
  // to see; treating a missing key as equal to an empty value would hide it.
  assert.deepEqual(fieldDiff({ A: 'x' }, { A: 'x', B: 'y' }), [
    { field: 'B', before: null, after: 'y' },
  ]);
});

test('a removed record diffs its fields against nothing', () => {
  assert.deepEqual(fieldDiff({ A: 'x' }, null), [{ field: 'A', before: 'x', after: null }]);
});
