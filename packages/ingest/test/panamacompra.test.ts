import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PANAMACOMPRA, TIENDA_VIRTUAL, archiveUrl } from '../src/panamacompra.ts';
import { monthClosesAt } from '../src/source.ts';

test('archiveUrl segments the period as the portal expects', () => {
  // Verified against the live API on 2026-09-02. The path is year/month, not
  // YYYYMM: the portal 404s the joined form.
  assert.equal(
    archiveUrl('202607'),
    'https://v2.panamacompraencifras.gob.pa/api/v1/file/panamacompra_v3/csv/2026/07',
  );
  assert.equal(
    archiveUrl('202512'),
    'https://v2.panamacompraencifras.gob.pa/api/v1/file/panamacompra_v3/csv/2025/12',
  );
});

test('the tienda virtual stream is a separate registry, not a merge', () => {
  assert.equal(
    archiveUrl('202607', 'panamacompra_v2_tienda_virtual'),
    'https://v2.panamacompraencifras.gob.pa/api/v1/file/panamacompra_v2_tienda_virtual/csv/2026/07',
  );
  assert.notEqual(PANAMACOMPRA.id, TIENDA_VIRTUAL.id);
});

test('Panama is monthly and stores zips', () => {
  assert.equal(PANAMACOMPRA.granularity, 'month');
  assert.equal(PANAMACOMPRA.extension, 'zip');
  assert.equal(PANAMACOMPRA.country, 'PA');
});

test('Panama does not claim an official digest', () => {
  // The portal's /sha/ endpoint returns a value matching none of the artifacts
  // it serves. Implementing officialDigest against it would mark every month a
  // mismatch. See source.ts.
  assert.equal(PANAMACOMPRA.officialDigest, undefined);
});

test('periodRange walks past the listing window', () => {
  // /api/v1/files lists only the last four months; the mirror must not inherit
  // that bound or it would silently stop backfilling.
  const r = PANAMACOMPRA.periodRange('202309', '202609');
  assert.equal(r.length, 37);
  assert.equal(r[0], '202309');
  assert.equal(r.at(-1), '202609');
});

test('a month closes after its own end plus a settling grace', () => {
  const close = monthClosesAt('202607');
  assert.ok(new Date('2026-07-31T23:59:00Z').getTime() < close, 'still open on its last day');
  assert.ok(new Date('2026-08-01T12:00:00Z').getTime() < close, 'grace covers the next-day run');
  assert.ok(new Date('2026-08-10T00:00:00Z').getTime() > close, 'ten days later is a rewrite');
});
