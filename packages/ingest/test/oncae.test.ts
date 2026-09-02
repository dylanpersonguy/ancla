import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ONCAE_CE, ONCAE_DDC, ONCAE_HC1, archiveUrl } from '../src/oncae.ts';
import { yearClosesAt, yearRange } from '../src/source.ts';

test('archiveUrl names the dataset twice, as the portal does', () => {
  assert.equal(
    archiveUrl('2024'),
    'https://datosabiertos.oncae.gob.hn/datosabiertos/HC1/HC1_datos_2024.zip',
  );
  assert.equal(
    archiveUrl('2019', 'DDC'),
    'https://datosabiertos.oncae.gob.hn/datosabiertos/DDC/DDC_datos_2019.zip',
  );
});

test('Honduras is yearly, which is why granularity exists', () => {
  assert.equal(ONCAE_HC1.granularity, 'year');
  assert.equal(ONCAE_HC1.country, 'HN');
  assert.notEqual(ONCAE_HC1.id, ONCAE_CE.id);
  assert.notEqual(ONCAE_CE.id, ONCAE_DDC.id);
});

test('every ONCAE dataset is flagged unverifiable', () => {
  // The expiry is the host's, not the dataset's, so missing it on one of the
  // three would let that one mirror silently over an unauthenticated channel.
  for (const s of [ONCAE_HC1, ONCAE_CE, ONCAE_DDC]) {
    assert.ok(s.unverifiedTls, `${s.id} must declare its TLS status`);
    assert.match(s.unverifiedTls?.reason ?? '', /expired/);
  }
});

test('yearRange is inclusive and ordered', () => {
  assert.deepEqual(yearRange('2005', '2008'), ['2005', '2006', '2007', '2008']);
  assert.deepEqual(yearRange('2024', '2024'), ['2024']);
  assert.deepEqual(yearRange('2024', '2023'), []);
});

test('a year gets a month of grace, not two days', () => {
  // An annual file grows all year and is routinely topped up in January.
  const close = yearClosesAt('2024');
  assert.ok(new Date('2024-12-31T23:59:00Z').getTime() < close, 'open on its last day');
  assert.ok(new Date('2025-01-20T00:00:00Z').getTime() < close, 'January top-up is not a rewrite');
  assert.ok(new Date('2025-03-01T00:00:00Z').getTime() > close, 'March is a rewrite');
});
