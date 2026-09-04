/**
 * A bundle has to survive the things real archives do, and it has to produce the
 * same bytes on two machines. Everything below is one of those two claims.
 *
 * The fixtures are built as real ZIPs rather than hand-made snapshots, because
 * the whole chain — zip layout, delimiter, header order, row identity, field
 * extraction — is what has to agree between the two copies. A test that starts
 * from a snapshot skips the half of the system most likely to be wrong.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSnapshot } from '../../canonicalize/src/snapshot.ts';
import { buildZip } from '../../index/test/zipwrite.ts';
import {
  BUNDLE_VERSION,
  type BundleLine,
  DETAIL_ORDER,
  FULL_LINES,
  REVISIONS_ONLY,
  UNLIMITED_DETAIL,
  buildBundle,
  bundleDigest,
  detailBudget,
  digestInput,
  digestInputV1,
  digestInputV2,
  parseChanges,
  serializeLine,
} from '../src/bundle.ts';
import { verifyAgainstArchives, verifyBundle } from '../src/verify.ts';

const REF = { source: 'cr-observatorio', stamp: '20260101T000000Z', file: 'a.zip' };
const REF2 = { source: 'cr-observatorio', stamp: '20260201T000000Z', file: 'b.zip' };

/** One Contratos table, semicolon-delimited, as the Observatorio publishes it. */
function contratos(rows: string[][], header = ['NRO_CONTRATO', 'SECUENCIA', 'MONTO', 'ESTADO']) {
  return buildZip([
    { name: 'Contratos.csv', data: [header, ...rows].map((r) => r.join(';')).join('\r\n') },
  ]);
}

function bundleOf(a: Buffer, b: Buffer, opts: { maxDetail?: number } = {}) {
  return buildBundle(
    { snapshot: buildSnapshot('202601', a), archive: a, ref: REF },
    { snapshot: buildSnapshot('202601', b), archive: b, ref: REF2 },
    opts,
  );
}

function lines(a: Buffer, b: Buffer, opts: { maxDetail?: number } = {}): BundleLine[] {
  return parseChanges(bundleOf(a, b, opts).changes);
}

test('a changed field is reported with its old and new value', () => {
  const before = contratos([['C1', '00', '1000', 'A']]);
  const after = contratos([['C1', '00', '2000', 'A']]);
  const [line, ...rest] = lines(before, after);
  assert.equal(rest.length, 0);
  assert.equal(line.kind, 'silentRevision');
  assert.deepEqual(line.fields, [{ field: 'MONTO', before: '1000', after: '2000' }]);
});

test('only the fields that moved are reported, not the whole row', () => {
  const before = contratos([['C1', '00', '1000', 'A']]);
  const after = contratos([['C1', '00', '1000', 'B']]);
  const [line] = lines(before, after);
  assert.deepEqual(line.fields?.map((f) => f.field), ['ESTADO']);
});

test('a reprinted number is reformatting and carries no field change', () => {
  // 1.000 and 1 are the same price. Reporting this as a revision is the failure
  // mode the two-hash design exists to prevent, and the bundle must inherit it.
  const before = contratos([['C1', '00', '1.000', 'A']]);
  const after = contratos([['C1', '00', '1.0', 'A']]);
  const [line] = lines(before, after);
  assert.equal(line.kind, 'reformatted');
  assert.deepEqual(line.fields, [{ field: 'MONTO', before: '1.000', after: '1.0' }]);
});

test('a removed row keeps its full contents, because nothing else will', () => {
  const before = contratos([['C1', '00', '1000', 'A'], ['C2', '00', '5', 'A']]);
  const after = contratos([['C1', '00', '1000', 'A']]);
  const [line] = lines(before, after);
  assert.equal(line.kind, 'removed');
  assert.deepEqual(line.before, { NRO_CONTRATO: 'C2', SECUENCIA: '00', MONTO: '5', ESTADO: 'A' });
  assert.equal(line.after, undefined);
});

test('an added row carries the row that appeared', () => {
  const before = contratos([['C1', '00', '1000', 'A']]);
  const after = contratos([['C1', '00', '1000', 'A'], ['C9', '00', '7', 'B']]);
  const [line] = lines(before, after);
  assert.equal(line.kind, 'added');
  assert.equal(line.after?.NRO_CONTRATO, 'C9');
});

test('a new sequence of an existing contract is a declared amendment', () => {
  const before = contratos([['C1', '00', '1000', 'A']]);
  const after = contratos([['C1', '00', '1000', 'A'], ['C1', '01', '1200', 'A']]);
  const [line] = lines(before, after);
  assert.equal(line.kind, 'recordedAmendment');
  assert.equal(line.after?.SECUENCIA, '01');
});

test('reordering rows is not a change', () => {
  const before = contratos([['C1', '00', '1', 'A'], ['C2', '00', '2', 'A']]);
  const after = contratos([['C2', '00', '2', 'A'], ['C1', '00', '1', 'A']]);
  assert.deepEqual(lines(before, after), []);
});

test('an empty value and an absent column are different answers', () => {
  const before = contratos([['C1', '00', '', 'A']]);
  const after = buildZip([
    { name: 'Contratos.csv', data: 'NRO_CONTRATO;SECUENCIA;ESTADO\r\nC1;00;A' },
  ]);
  const [line] = lines(before, after);
  assert.equal(line.kind, 'silentRevision');
  assert.deepEqual(line.fields, [{ field: 'MONTO', before: '', after: null }]);
});

test('a schema change is recorded as itself, not as a wave of edits', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos(
    [['C1', '00', '1', 'A', 'x']],
    ['NRO_CONTRATO', 'SECUENCIA', 'MONTO', 'ESTADO', 'NUEVO'],
  );
  const { manifest } = bundleOf(before, after);
  assert.equal(manifest.schemaChanges.length, 1);
  assert.equal(manifest.schemaChanges[0]?.table, 'Contratos');
});

test('a duplicate row appearing twice more is visible as two additions', () => {
  // Garantias and friends emit literal duplicates. Identity is the row plus an
  // occurrence index, so the number of copies is itself observable.
  const rows = [['C1', '00', '1', 'A'], ['C1', '00', '1', 'A']];
  const before = contratos(rows);
  const after = contratos([...rows, ['C1', '00', '1', 'A'], ['C1', '00', '1', 'A']]);
  const out = lines(before, after);
  assert.equal(out.length, 2);
  assert.ok(out.every((l) => l.kind === 'added'));
});

test('the same two archives produce the same bytes and the same digest', () => {
  const a = contratos([['C1', '00', '1', 'A'], ['C2', '00', '2', 'B']]);
  const b = contratos([['C1', '00', '9', 'A'], ['C3', '00', '3', 'C']]);
  const first = bundleOf(a, b);
  const second = bundleOf(a, b);
  assert.equal(first.manifest.changesSha256, second.manifest.changesSha256);
  assert.equal(first.manifest.bundleDigest, second.manifest.bundleDigest);
  assert.ok(first.changes.equals(second.changes));
});

test('when it was built is not part of what it says', () => {
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A']]);
  const { manifest } = bundleOf(a, b);
  const { bundleDigest: stated, builtAt: _ignored, ...body } = manifest;
  assert.equal(bundleDigest({ ...body }), stated);
  assert.equal(bundleDigest({ ...body }), bundleDigest({ ...body }));
});

test('changes are ordered by table then id, whatever order the rows arrived in', () => {
  const before = contratos([['C3', '00', '1', 'A'], ['C1', '00', '1', 'A']]);
  const after = contratos([['C3', '00', '2', 'A'], ['C1', '00', '2', 'A']]);
  const ids = lines(before, after).map((l) => l.id);
  assert.deepEqual(ids, [...ids].sort());
});

test('a detail budget drops values, never rows, and says how many', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos(
    Array.from({ length: 12 }, (_, i) => [`C${i}`, '00', '1', 'A']),
  );
  const { manifest, changes } = bundleOf(before, after, { maxDetail: 3 });
  const out = parseChanges(changes);
  assert.equal(out.length, manifest.changeCount);
  assert.equal(out.filter((l) => l.valuesOmitted).length, manifest.valuesOmitted);
  assert.ok(manifest.valuesOmitted > 0);
  // Every row is still individually addressable by hash, budget or not.
  assert.ok(out.every((l) => l.beforeHash !== null || l.afterHash !== null));
});

test('the budget is spent on revisions before additions', () => {
  const changes = [
    { kind: 'added' as const, table: 'T', id: 'a' },
    { kind: 'silentRevision' as const, table: 'T', id: 'b' },
    { kind: 'added' as const, table: 'T', id: 'c' },
  ];
  const chosen = detailBudget(changes, 1);
  assert.equal(chosen.size, 1);
  assert.equal([...chosen][0]?.id, 'b');
});

test('a bundle verifies against itself', () => {
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A']]);
  const { manifest, changes } = bundleOf(a, b);
  const v = verifyBundle(manifest, changes);
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test('an edited count is caught by the digest', () => {
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A']]);
  const { manifest, changes } = bundleOf(a, b);
  const tampered = { ...manifest, counts: { ...manifest.counts, silentRevision: 99 } };
  const v = verifyBundle(tampered, changes);
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => c.name === 'bundle digest' && !c.ok));
});

test('an edited changes file is caught even when the manifest still adds up', () => {
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A']]);
  const { manifest, changes } = bundleOf(a, b);
  const swapped = Buffer.from(changes.toString('utf8').replace('"2000"', '"3000"').replace('2', '8'));
  const v = verifyBundle(manifest, swapped);
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => c.name === 'changes digest' && !c.ok));
});

test('rebuilding from the two archives reproduces the bundle exactly', () => {
  const a = contratos([['C1', '00', '1', 'A'], ['C2', '00', '2', 'A']]);
  const b = contratos([['C1', '00', '5', 'A'], ['C3', '00', '3', 'A']]);
  const { manifest, changes } = bundleOf(a, b);
  const v = verifyAgainstArchives(manifest, changes, a, b);
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
});

test('a substituted archive is refused before anything is compared', () => {
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A']]);
  const other = contratos([['C1', '00', '3', 'A']]);
  const { manifest, changes } = bundleOf(a, b);
  const v = verifyAgainstArchives(manifest, changes, other, b);
  assert.equal(v.ok, false);
  assert.equal(v.checks.find((c) => c.name === 'earlier archive')?.ok, false);
});

test('a line round-trips through its own serialization', () => {
  const line: BundleLine = {
    kind: 'silentRevision',
    table: 'Contratos',
    id: 'C1|00',
    beforeHash: { byteHash: 'a', valueHash: 'b' },
    afterHash: { byteHash: 'c', valueHash: 'd' },
    fields: [{ field: 'MONTO', before: '1', after: '2' }],
  };
  assert.deepEqual(JSON.parse(serializeLine(line)), line);
});

test('the bundle version is pinned', () => {
  // Same contract as CANON_VERSION: changing the rules without changing this
  // invalidates every digest published before, silently.
  assert.equal(BUNDLE_VERSION, 'ancla-bundle-2');
});

test('a line policy drops the lines but never the counts', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos([
    ['C1', '00', '2', 'A'],
    ['C7', '00', '7', 'B'],
    ['C8', '00', '8', 'B'],
  ]);
  const { manifest, changes } = bundleOf(before, after, { linePolicy: REVISIONS_ONLY });
  const lines = parseChanges(changes);

  // The additions are still counted. They are simply not enumerated: their
  // evidence is the archive, and the archive is kept.
  assert.equal(manifest.counts.added, 2);
  assert.equal(lines.filter((l) => l.kind === 'added').length, 0);
  assert.equal(manifest.omittedByPolicy, 2);
  assert.equal(manifest.changeCount, lines.length);
  assert.equal(manifest.counts.silentRevision, 1);
  assert.equal(lines.filter((l) => l.kind === 'silentRevision').length, 1);
});

test('what was written plus what the policy dropped is every change', () => {
  const before = contratos([['C1', '00', '1', 'A'], ['C2', '00', '2', 'A']]);
  const after = contratos([['C1', '00', '9', 'A'], ['C3', '00', '3', 'A']]);
  for (const linePolicy of [FULL_LINES, REVISIONS_ONLY]) {
    const { manifest } = bundleOf(before, after, { linePolicy });
    const total = Object.values(manifest.counts).reduce((a, b) => a + b, 0);
    assert.equal(manifest.changeCount + manifest.omittedByPolicy, total, linePolicy.kinds.join());
  }
});

test('a bundle that omits a class of change still verifies', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos([['C1', '00', '2', 'A'], ['C9', '00', '9', 'B']]);
  const { manifest, changes } = bundleOf(before, after, { linePolicy: REVISIONS_ONLY });
  const v = verifyBundle(manifest, changes);
  assert.ok(v.ok, JSON.stringify(v.checks.filter((c) => !c.ok)));
  assert.ok(v.checks.some((c) => c.name === 'policy arithmetic' && c.ok));
});

test('a line the policy excluded is caught, not waved through', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos([['C1', '00', '2', 'A'], ['C9', '00', '9', 'B']]);
  const full = bundleOf(before, after, { linePolicy: FULL_LINES });
  const restricted = bundleOf(before, after, { linePolicy: REVISIONS_ONLY });
  // The restricted manifest against the full file: an addition is present that
  // the policy says was never written.
  const v = verifyBundle(restricted.manifest, full.changes);
  assert.equal(v.ok, false);
  assert.ok(v.checks.some((c) => c.name === 'counts by kind' && !c.ok));
});

test('the policy is inside the digest, so it cannot be restated afterwards', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos([['C1', '00', '2', 'A'], ['C9', '00', '9', 'B']]);
  const { manifest } = bundleOf(before, after, { linePolicy: REVISIONS_ONLY });
  const relabelled = { ...manifest, linePolicy: FULL_LINES };
  const { bundleDigest: _d, builtAt: _b, ...body } = relabelled;
  assert.notEqual(bundleDigest(body), manifest.bundleDigest);
});

test('the policy order does not change the digest', () => {
  const before = contratos([['C1', '00', '1', 'A']]);
  const after = contratos([['C1', '00', '2', 'A']]);
  const a = bundleOf(before, after, { linePolicy: { kinds: ['removed', 'silentRevision'] } });
  const b = bundleOf(before, after, { linePolicy: { kinds: ['silentRevision', 'removed'] } });
  assert.equal(a.manifest.bundleDigest, b.manifest.bundleDigest);
});

test('an ancla-bundle-1 digest still verifies under its own frozen rules', () => {
  // Two commitments were written under bundle-1 and must stay checkable.
  const v1 = {
    bundleVersion: 'ancla-bundle-1',
    canonVersion: 'ancla-canon-2',
    source: 'cr-observatorio',
    period: '202608',
    from: { source: 'cr-observatorio', period: '202608', stamp: 'a', file: 'a.zip', archiveSha256: 'a'.repeat(64), merkleRoot: 'b'.repeat(64), recordCount: 1 },
    to: { source: 'cr-observatorio', period: '202608', stamp: 'b', file: 'b.zip', archiveSha256: 'c'.repeat(64), merkleRoot: 'd'.repeat(64), recordCount: 2 },
    counts: { added: 1, recordedAmendment: 0, silentRevision: 0, reformatted: 0, removed: 0 },
    schemaChanges: [],
    changeCount: 1,
    linePolicy: FULL_LINES,
    omittedByPolicy: 0,
    detailPolicy: { maxDetail: 200_000, order: DETAIL_ORDER },
    valuesOmitted: 0,
    changesSha256: 'e'.repeat(64),
    canonVersionMismatch: false,
  } as const;
  // Dispatch on the manifest's own version: the bundle-1 digest ignores the
  // policy fields entirely, so adding them cannot move an old digest.
  assert.equal(digestInput(v1), digestInputV1(v1));
  assert.notEqual(digestInputV1(v1), digestInputV2(v1));
});

test('an unlimited budget is a number, because the manifest goes through JSON', () => {
  // Infinity stringifies to null, so a bundle built with one would fail its own
  // digest check the moment it was read back off disk.
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A'], ['C2', '00', '3', 'B']]);
  const { manifest } = bundleOf(a, b, { maxDetail: UNLIMITED_DETAIL });
  const roundTripped = JSON.parse(JSON.stringify(manifest));
  assert.deepEqual(roundTripped, manifest);
  assert.equal(manifest.valuesOmitted, 0);

  const { bundleDigest: stated, builtAt: _b, ...body } = roundTripped;
  assert.equal(bundleDigest(body), stated);
});

test('a budget that cannot survive a round trip is refused at build time', () => {
  const a = contratos([['C1', '00', '1', 'A']]);
  const b = contratos([['C1', '00', '2', 'A']]);
  assert.throws(() => bundleOf(a, b, { maxDetail: Number.POSITIVE_INFINITY }), /safe integer/);
  assert.throws(() => bundleOf(a, b, { maxDetail: -1 }), /non-negative/);
});
