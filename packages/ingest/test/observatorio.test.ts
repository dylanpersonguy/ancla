import assert from 'node:assert/strict';
import { test } from 'node:test';
import { archiveUrl, compactStamp, currentMonth, monthRange } from '../src/observatorio.ts';

test('monthRange crosses year boundaries', () => {
  assert.deepEqual(monthRange('202411', '202502'), ['202411', '202412', '202501', '202502']);
});

test('monthRange is inclusive at both ends', () => {
  assert.deepEqual(monthRange('202608', '202608'), ['202608']);
});

test('monthRange returns empty when reversed', () => {
  assert.deepEqual(monthRange('202608', '202607'), []);
});

test('monthRange covers the full known archive span', () => {
  const r = monthRange('201012', '202608');
  assert.equal(r.length, 189);
  assert.equal(r[0], '201012');
  assert.equal(r.at(-1), '202608');
});

test('archiveUrl matches the verified Observatorio path', () => {
  assert.equal(
    archiveUrl('202608'),
    'https://dlsaobservatorioprod.blob.core.windows.net/' +
      'fs-synapse-observatorio-produccion/Zip/202608.zip',
  );
});

test('compactStamp is stable, sortable, and filesystem-safe', () => {
  // Archive filenames depend on this. A change here orphans every stored archive.
  assert.equal(compactStamp('Wed, 26 Aug 2026 13:06:36 GMT'), '20260826T130636Z');
  assert.equal(compactStamp('Mon, 10 Aug 2026 21:18:53 GMT'), '20260810T211853Z');
  assert.match(compactStamp('Wed, 26 Aug 2026 13:06:36 GMT'), /^[0-9TZ]+$/);
});

test('compactStamp sorts chronologically as a string', () => {
  const a = compactStamp('Fri, 31 Jul 2026 13:04:22 GMT');
  const b = compactStamp('Mon, 10 Aug 2026 21:18:53 GMT');
  assert.ok(a < b, 'month-close copy must sort before its later rewrite');
});

test('compactStamp degrades rather than throwing', () => {
  assert.equal(compactStamp(null), 'unknown');
  assert.equal(compactStamp('not a date'), 'unknown');
});

test('currentMonth uses UTC, not local time', () => {
  // 2026-01-01T00:30Z is still December in UTC-6 (Costa Rica). Must be 202601.
  assert.equal(currentMonth(new Date('2026-01-01T00:30:00Z')), '202601');
  assert.equal(currentMonth(new Date('2026-08-26T23:59:59Z')), '202608');
});
