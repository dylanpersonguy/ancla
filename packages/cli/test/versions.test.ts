/**
 * What we hold, and the honest answer about what we do not.
 *
 * The classification is the part that has to be right. Overstating it — calling
 * an outside file "the previous version" because it looks plausible — would be
 * worse than having no recovery story at all, because it would be believed.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

let root = '';
before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ancla-versions-'));
  process.env.ANCLA_DATA = root;
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const { buildSnapshot, writeSnapshot } = await import('../../canonicalize/src/snapshot.ts');
const { buildZip } = await import('../../index/test/zipwrite.ts');
const { CANON_VERSION } = await import('../../canonicalize/src/canonical.ts');
const { archives, snapshotPath } = await import('../src/store.ts');
const { snapshotPath: snapshotPathFor } = await import('../src/store.ts');
const {
  capturesFor,
  recoveryInventory,
  servedAfterClose,
  stampToDate,
  testCandidate,
} = await import('../src/versions.ts');

function zip(monto: string) {
  return buildZip([
    { name: 'Contratos.csv', data: `NRO_CONTRATO;SECUENCIA;MONTO\r\nC1;00;${monto}` },
  ]);
}

/** Put an archive on disk the way the mirror would, and canonicalise it. */
async function store(period: string, stamp: string, data: Buffer) {
  const { createHash } = await import('node:crypto');
  const sha = createHash('sha256').update(data).digest('hex');
  const dir = join(root, 'archives', period);
  await mkdir(dir, { recursive: true });
  const file = `${stamp}-${sha.slice(0, 12)}.zip`;
  await writeFile(join(dir, file), data);
  const refs = await archives(period);
  const ref = refs.find((r) => r.file === file);
  assert.ok(ref);
  await writeSnapshot(snapshotPath(ref), buildSnapshot(period, data));
  return { sha, file, snapshot: buildSnapshot(period, data) };
}

test('a stamp reads back as the instant the publisher wrote it', () => {
  assert.equal(stampToDate('20260831T130427Z')?.toISOString(), '2026-08-31T13:04:27.000Z');
  assert.equal(stampToDate('nonsense'), null);
});

test('close is the end of the period plus the publisher settling window', async () => {
  const { OBSERVATORIO } = await import('../../ingest/src/observatorio.ts');
  // 2026-01 ends on 2026-02-01; a copy written on the 15th of January is the
  // ordinary daily refresh, not a rewrite.
  assert.equal(servedAfterClose(OBSERVATORIO, '202601', '20260115T000000Z'), false);
  assert.equal(servedAfterClose(OBSERVATORIO, '202601', '20260910T000000Z'), true);
});

test('a period with one pre-close copy has never been rewritten', async () => {
  await store('202601', '20260115T000000Z', zip('100'));
  const inv = await recoveryInventory();
  assert.equal(inv.find((r) => r.period === '202601')?.status, 'neverRewritten');
});

test('a period with one post-close copy is unrecoverable, and says which day', async () => {
  await store('202602', '20260910T000000Z', zip('200'));
  const r = (await recoveryInventory()).find((x) => x.period === '202602');
  assert.equal(r?.status, 'currentOnly');
  assert.equal(r?.servedDay, '2026-09-10');
  assert.match(r?.note ?? '', /cannot be produced/);
});

test('a period with two copies is diffable now', async () => {
  await store('202603', '20260301T000000Z', zip('300'));
  await store('202603', '20260915T000000Z', zip('301'));
  const r = (await recoveryInventory()).find((x) => x.period === '202603');
  assert.equal(r?.status, 'diffable');
  assert.equal(r?.held, 2);
});

test('a root on chain with no copy here makes candidates testable', async () => {
  const inv = await recoveryInventory(undefined, [
    { ns: null, period: '202602', id: 'deadbeefdead', root: 'a'.repeat(64),
      canonVersion: CANON_VERSION, recordCount: 1, archiveSha256: 'd'.repeat(64), stamp: null },
  ]);
  const r = inv.find((x) => x.period === '202602');
  assert.equal(r?.status, 'priorAnchored');
  assert.deepEqual(r?.orphanRoots, ['a'.repeat(64)]);
});

test('a capture reports whether its own root is the one committed', async () => {
  const held = await store('202604', '20260415T000000Z', zip('400'));
  const anchored = [
    { ns: null, period: '202604', id: held.sha.slice(0, 12), root: held.snapshot.merkleRoot,
      canonVersion: CANON_VERSION, recordCount: 1, archiveSha256: held.sha, stamp: null },
  ];
  const [c] = await capturesFor('202604', undefined, anchored);
  assert.equal(c?.anchoredRoot, held.snapshot.merkleRoot);
  assert.equal(c?.anchorMatches, true);
});

test('a commitment under our key that does not match the file is flagged, not ignored', async () => {
  const held = await store('202605', '20260515T000000Z', zip('500'));
  const [c] = await capturesFor('202605', undefined, [
    { ns: null, period: '202605', id: held.sha.slice(0, 12), root: 'f'.repeat(64),
      canonVersion: CANON_VERSION, recordCount: 1, archiveSha256: held.sha, stamp: null },
  ]);
  assert.equal(c?.anchorMatches, false);
});

test('an outside copy reproducing a committed root is the prior version', async () => {
  const candidate = zip('999');
  const snap = buildSnapshot('202602', candidate);
  const path = join(root, 'candidate.zip');
  await writeFile(path, candidate);

  const r = await testCandidate(path, '202602', undefined, [
    { ns: null, period: '202602', id: '0'.repeat(12), root: snap.merkleRoot,
      canonVersion: CANON_VERSION, recordCount: 1, archiveSha256: '0'.repeat(64), stamp: null },
  ]);
  assert.equal(r.verdict, 'exactHistoricalVersion');
  assert.equal(r.matchedRoot, snap.merkleRoot);
});

test('an outside copy matching nothing is a lead, never the official prior', async () => {
  const path = join(root, 'unattested.zip');
  await writeFile(path, zip('12345'));
  const r = await testCandidate(path, '202602', undefined, []);
  assert.equal(r.verdict, 'unattestedExternalCopy');
  assert.equal(r.matchedRoot, null);
  assert.match(r.note, /Independently sourced/);
});

test('an outside copy identical to one we hold says so instead of claiming a find', async () => {
  const data = zip('200');
  const path = join(root, 'copy-of-held.zip');
  await writeFile(path, data);
  const snap = buildSnapshot('202602', data);
  const r = await testCandidate(path, '202602', undefined, [
    { ns: null, period: '202602', id: '1'.repeat(12), root: snap.merkleRoot,
      canonVersion: CANON_VERSION, recordCount: 1, archiveSha256: '1'.repeat(64), stamp: null },
  ]);
  assert.equal(r.verdict, 'copyOfHeldVersion');
});

test('one publisher is never measured against another publisher roots', async () => {
  // Costa Rica and Panama publish a period called 202602 and share one anchor
  // account. Reading Panama's root as a Costa Rican commitment reports a root on
  // chain that no copy here reproduces, which reads as "an earlier version we
  // lost" and would send someone hunting for a file that never existed.
  const { PANAMACOMPRA } = await import('../../ingest/src/panamacompra.ts');
  const { anchorNs, forSource } = await import('../src/versions.ts');
  const { OBSERVATORIO } = await import('../../ingest/src/observatorio.ts');

  assert.equal(anchorNs(OBSERVATORIO), null);
  assert.equal(anchorNs(PANAMACOMPRA), 'pa');

  const panamanian = {
    ns: 'pa', period: '202602', id: 'aaaaaaaaaaaa', root: 'a'.repeat(64),
    canonVersion: CANON_VERSION, recordCount: 1, archiveSha256: 'a'.repeat(64), stamp: null,
  };
  assert.deepEqual(forSource([panamanian], OBSERVATORIO), []);
  assert.deepEqual(forSource([panamanian], PANAMACOMPRA), [panamanian]);

  const inv = await recoveryInventory(undefined, [panamanian]);
  const r = inv.find((x) => x.period === '202602');
  assert.equal(r?.status, 'currentOnly', 'a Panamanian root must not become a Costa Rican orphan');
  assert.deepEqual(r?.orphanRoots, []);
});

test('a snapshot is addressed by the rules that built it', async () => {
  // Re-snapshotting under new rules must not overwrite the file an already
  // anchored root was built from. The archive is the evidence either way, but
  // "rebuild it from the ZIP" is a much weaker offer than "it is right here".
  const { snapshotPath, legacySnapshotPath, snapshotsFor } = await import('../src/store.ts');
  const { archives } = await import('../src/store.ts');
  const [ref] = await archives('202601');
  assert.ok(ref);
  assert.ok(snapshotPath(ref).endsWith(`.${CANON_VERSION}.snap.gz`));
  assert.notEqual(snapshotPath(ref), legacySnapshotPath(ref));

  const held = await snapshotsFor(ref);
  assert.deepEqual(
    held.map((h) => h.canonVersion),
    [CANON_VERSION],
    'only the current canonicalisation was built in this fixture',
  );
});

test('a capture built under older rules reports them rather than going blank', async () => {
  // The migration state everyone is in the day after a bump: v1 snapshots on
  // disk, v1 roots on chain. Reporting "not canonicalised" would read as "we
  // lost it" for 191 archives that are sitting right there.
  const { writeSnapshot, buildSnapshot } = await import('../../canonicalize/src/snapshot.ts');
  const { legacySnapshotPath, archives } = await import('../src/store.ts');
  const { rm } = await import('node:fs/promises');

  const data = zip('7000');
  await store('202612', '20261215T000000Z', data);
  const [ref] = await archives('202612');
  assert.ok(ref);
  // Leave only a legacy-named snapshot, standing in for one built under v1.
  await writeSnapshot(legacySnapshotPath(ref), buildSnapshot('202612', data));
  await rm(snapshotPathFor(ref), { force: true });

  const [c] = await capturesFor('202612');
  assert.ok(c?.merkleRoot, 'the older snapshot must still be read');
  assert.equal(c?.staleCanon, false, 'this fixture writes current rules under the legacy name');
});

test('a bundle keeps one directory per canonicaliser', async () => {
  // Rebuilding under new rules must not destroy the bundle whose digest is
  // already committed. Both readings of the same two archives are true; they are
  // true about different record sets.
  const { bundleDir } = await import('../../bundle/src/bundle.ts');
  const d = (canon: string, bundle: string) =>
    bundleDir('/data', '202608', '20260826T130636Z', '20260831T130427Z', canon, bundle);
  const pair = '20260826T130636Z__20260831T130427Z';
  assert.ok(d('ancla-canon-1', 'ancla-bundle-1').endsWith(pair), 'the first of each keeps the original path');
  assert.ok(d('ancla-canon-2', 'ancla-bundle-1').endsWith(`${pair}__ancla-canon-2`));
  assert.ok(d('ancla-canon-2', 'ancla-bundle-2').endsWith(`${pair}__ancla-canon-2__ancla-bundle-2`));
  // Every combination is its own directory: two readings of the same two
  // archives are both true, and the older one has a commitment on chain.
  const all = ['ancla-canon-1', 'ancla-canon-2'].flatMap((c) =>
    ['ancla-bundle-1', 'ancla-bundle-2'].map((b) => d(c, b)),
  );
  assert.equal(new Set(all).size, 4);
});
