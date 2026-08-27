import assert from 'node:assert/strict';
import { test } from 'node:test';
import { benchmarkProduct, magnitudeSpread, outlierFence, scanPrices } from '../src/prices.ts';
import { emptyDb, insertAward, insertTender } from './fixture.ts';

/** Award n lines on one product code at the given prices. */
function awardPrices(
  db: Db,
  codigo: string,
  prices: readonly number[],
  opts: { moneda?: string; cantidad?: number; tender?: string } = {},
): void {
  const tender = opts.tender ?? 'T1';
  if (!seen.has(tender)) {
    insertTender(db, { nroSicop: tender });
    seen.add(tender);
  }
  prices.forEach((precio, i) => {
    insertAward(db, {
      nroSicop: tender,
      nroOferta: `O-${codigo}-${opts.moneda ?? 'CRC'}-${i}`,
      nroLinea: `${codigo}-${opts.moneda ?? 'CRC'}-${i}`,
      nroActo: '1',
      codigo,
      cantidad: opts.cantidad ?? 1,
      precio,
      proveedor: `S${i}`,
      moneda: opts.moneda ?? 'CRC',
    });
  });
}

type Db = ReturnType<typeof emptyDb>;
let seen = new Set<string>();

function freshDb(): Db {
  seen = new Set();
  return emptyDb();
}

test('a clean product code produces exact median and quartile figures', () => {
  const db = freshDb();
  // 11 values, median 600, p25 = 400, p75 = 800.
  awardPrices(db, 'CLEAN', [300, 350, 400, 450, 500, 600, 700, 750, 800, 850, 900]);

  const b = benchmarkProduct(db, 'CLEAN');
  assert.equal(b.n, 11);
  assert.equal(b.usable, true);
  assert.equal(b.stats?.median, 600);
  assert.equal(b.stats?.p25, 425);
  assert.equal(b.stats?.p75, 775);
  assert.equal(b.stats?.iqr, 350);
  assert.equal(b.iqrRatio, 775 / 425);
  assert.equal(b.dispersion, 'moderate');
  assert.equal(b.outliers.length, 0);
  db.close();
});

test('the 5,182,119x case is refused, not reported as a finding', () => {
  // This is the number a naive implementation produces on this data. It is a
  // unit-of-measure artifact: the same code priced per item and per pallet.
  // Refusing to answer is the correct output.
  const db = freshDb();
  const perItem = Array.from({ length: 20 }, (_, i) => 10 + i);
  const perPallet = Array.from({ length: 20 }, (_, i) => 1_000_000 + i * 1000);
  awardPrices(db, 'MIXED', [...perItem, ...perPallet]);

  const b = benchmarkProduct(db, 'MIXED');
  assert.equal(b.n, 40);
  assert.equal(b.usable, false);
  assert.equal(b.outliers.length, 0);
  assert.ok(b.reason);
  assert.ok((b.spreadRatio as number) > 1000);
  // The statistics are still returned so a human can see why it was refused.
  assert.ok(b.stats);
  assert.ok((b.iqrRatio as number) > 10);
  db.close();
});

test('an extreme single row cannot drive the benchmark, unlike a mean', () => {
  const db = freshDb();
  const prices = [...Array.from({ length: 30 }, () => 1000), 5_182_119_000];
  awardPrices(db, 'ONEBAD', prices);

  const b = benchmarkProduct(db, 'ONEBAD');
  // Median survives; a mean here would be about 167 million.
  assert.equal(b.stats?.median, 1000);
  const mean = prices.reduce((a, x) => a + x, 0) / prices.length;
  assert.ok(mean > 100_000_000, 'the mean really is that badly broken');
  // The spread guard fires anyway, because one row that extreme means the code
  // is not trustworthy even though the middle is tight.
  assert.equal(b.usable, false);
  assert.ok((b.reason as string).includes('full range'));
  db.close();
});

test('a genuinely overpriced purchase inside a homogeneous code is flagged', () => {
  const db = freshDb();
  // Twenty purchases around 1000, one at 3000. A 3x gap, not a 3000x one.
  awardPrices(db, 'REAL', [
    950, 960, 970, 980, 990, 1000, 1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100,
    1110, 1120, 1130, 3000,
  ]);

  const b = benchmarkProduct(db, 'REAL');
  assert.equal(b.usable, true);
  assert.equal(b.outliers.length, 1);
  assert.equal(b.outliers[0].unitPrice, 3000);
  assert.equal(b.outliers[0].rule, 'mad');
  assert.ok(b.outliers[0].ratioToMedian > 2.8 && b.outliers[0].ratioToMedian < 3);
  // Evidence: the tender the outlier came from is on the row.
  assert.equal(b.outliers[0].nroSicop, 'T1');
  db.close();
});

test('a zero MAD falls back to the mean absolute deviation, not to a collapsed fence', () => {
  // Sixteen purchases at the catalogue price of 500 make the MAD exactly zero.
  // A Tukey IQR fence is also zero-width here and would flag 505 and 510, which
  // is a screen that fires on everything. The mean-absolute-deviation fallback
  // leaves them alone and keeps the one purchase that is actually out of line.
  const db = freshDb();
  awardPrices(db, 'FLAT', [...Array.from({ length: 16 }, () => 500), 505, 510, 900]);

  const b = benchmarkProduct(db, 'FLAT');
  assert.equal(b.stats?.mad, 0);
  assert.equal(b.stats?.iqr, 0);
  assert.equal(b.usable, true);
  assert.equal(b.outlierRule, 'mean-ad');
  assert.equal(b.outliers.length, 1);
  assert.equal(b.outliers[0].unitPrice, 900);
  assert.ok(b.outliers[0].modifiedZ > 3.5);
  db.close();
});

test('a code where every purchase is at one price has no outlier to find', () => {
  const db = freshDb();
  awardPrices(db, 'SAME', Array.from({ length: 20 }, () => 750));
  const b = benchmarkProduct(db, 'SAME');
  assert.equal(b.usable, true);
  assert.equal(b.outlierRule, 'identical');
  assert.equal(b.outliers.length, 0);
  db.close();
});

test('a purchase past the statistical fence but close to the median is not listed', () => {
  // A tight code makes the fence sit only a little above the median. Clearing it
  // by 20% is ordinary supplier variation, not something to put in front of an
  // auditor, so a practical floor sits on top of the statistical one.
  const db = freshDb();
  // Twenty-one purchases in a tight band around 1000, plus one at 1200 and one
  // at 1900. The fence lands at about 1047, so both clear it statistically.
  awardPrices(db, 'TIGHT', [...Array.from({ length: 21 }, (_, i) => 990 + i), 1200, 1900]);

  const b = benchmarkProduct(db, 'TIGHT');
  assert.equal(b.usable, true);
  assert.equal(b.outlierRule, 'mad');
  assert.equal(b.outliers.length, 1);
  assert.equal(b.outliers[0].unitPrice, 1900);

  // Lowering the floor brings the 1200 back, but only on an explicit request.
  const loose = benchmarkProduct(db, 'TIGHT', { minRatioToMedian: 1 });
  assert.deepEqual(loose.outliers.map((o) => o.unitPrice).sort((x, y) => x - y), [1200, 1900]);
  db.close();
});

test('the fence helper agrees with the module on which rule applies', () => {
  assert.equal(outlierFence([1, 2, 3, 4, 5]).rule, 'mad');
  assert.equal(outlierFence([5, 5, 5, 5, 5, 9]).rule, 'mean-ad');
  assert.equal(outlierFence([7, 7, 7]).rule, 'identical');
  assert.equal(outlierFence([]).fence, null);
});

test('a sample below the minimum produces no statistics at all', () => {
  const db = freshDb();
  awardPrices(db, 'TINY', [100, 200, 300]);

  const b = benchmarkProduct(db, 'TINY');
  assert.equal(b.n, 3);
  assert.equal(b.usable, false);
  assert.equal(b.stats, null);
  assert.ok((b.reason as string).includes('below the minimum sample'));

  // Lowering the bar is allowed, but it is an explicit act by the caller.
  const loose = benchmarkProduct(db, 'TINY', { minSample: 3 });
  assert.equal(loose.stats?.median, 200);
  db.close();
});

test('currencies are never mixed', () => {
  const db = freshDb();
  // Same nominal numbers in CRC and USD. Mixed, the code would look bimodal.
  awardPrices(db, 'CUR', Array.from({ length: 12 }, (_, i) => 500 + i));
  awardPrices(db, 'CUR', Array.from({ length: 12 }, (_, i) => 500 + i), { moneda: 'USD' });

  const crc = benchmarkProduct(db, 'CUR', { currency: 'CRC' });
  assert.equal(crc.n, 12);
  assert.equal(crc.excluded.otherCurrency, 12);
  const usd = benchmarkProduct(db, 'CUR', { currency: 'USD' });
  assert.equal(usd.n, 12);
  assert.equal(usd.excluded.otherCurrency, 12);
  db.close();
});

test('excess value is the gap times the quantity, not the gap alone', () => {
  const db = freshDb();
  awardPrices(db, 'QTY', Array.from({ length: 20 }, () => 100).concat([100]), { cantidad: 1 });
  insertAward(db, {
    nroSicop: 'T1',
    nroOferta: 'BIG',
    nroLinea: 'BIG',
    nroActo: '1',
    codigo: 'QTY',
    cantidad: 500,
    precio: 300,
    proveedor: 'SBIG',
    moneda: 'CRC',
  });

  const b = benchmarkProduct(db, 'QTY');
  assert.equal(b.usable, true);
  assert.equal(b.outliers.length, 1);
  // (300 - 100) * 500
  assert.equal(b.outliers[0].excessValue, 100_000);
  db.close();
});

test('magnitude spread counts only decades holding a real share', () => {
  // One stray value in a lower decade is not enough to call a code multimodal.
  const many = Array.from({ length: 100 }, () => 100);
  assert.deepEqual(magnitudeSpread([...many, 5]), { populated: 1, span: 0 });
  // A genuine three-way split does count.
  const split = [
    ...Array.from({ length: 20 }, () => 5),
    ...Array.from({ length: 20 }, () => 50),
    ...Array.from({ length: 20 }, () => 500),
  ];
  assert.deepEqual(magnitudeSpread(split), { populated: 3, span: 2 });
  // Two populated decades side by side is an ordinary price band.
  assert.deepEqual(magnitudeSpread([800, 900, 950, 1100, 1200, 1300]), { populated: 2, span: 1 });
});

test('two populated price levels far apart are rejected even when the middle is tight', () => {
  // Taken from the real index: eleven awards around 79,000 colones and two
  // around 27 million on one code. The interquartile ratio is 1.3x, the full
  // range is 876x which is under the spread limit, and only two decades are
  // populated. Every guard on its own let it through and the sample was still
  // holding two different things. The distance between the levels is the tell.
  const db = freshDb();
  awardPrices(db, 'TWOLEVEL', [
    72_000, 74_000, 76_000, 78_000, 79_000, 79_500, 80_000, 85_000, 90_000, 92_000, 39_700,
    20_190_000, 34_810_000,
  ]);
  const b = benchmarkProduct(db, 'TWOLEVEL');
  assert.equal(b.magnitudeBuckets, 2);
  assert.equal(b.magnitudeSpan, 3);
  assert.equal(b.usable, false);
  assert.equal(b.outliers.length, 0);
  assert.ok((b.reason as string).includes('powers of ten apart'));
  db.close();
});

test('a lump-sum code is rejected: comparing purchases compares job sizes', () => {
  // Construction and services are booked as one unit at the price of the whole
  // job, so precio_unitario is a contract total. Quantity 1 everywhere plus a
  // wide spread means the numbers measure project size, not price.
  const db = freshDb();
  awardPrices(
    db,
    'LUMP',
    [
      2_000_000, 3_500_000, 5_000_000, 8_000_000, 11_000_000, 15_000_000, 19_000_000, 24_000_000,
      31_000_000, 40_000_000, 52_000_000, 68_000_000,
    ],
    { cantidad: 1 },
  );
  const b = benchmarkProduct(db, 'LUMP');
  assert.equal(b.quantityOneShare, 1);
  assert.equal(b.dispersion, 'wide');
  assert.equal(b.usable, false);
  assert.ok((b.reason as string).includes('lump-sum'));

  // The same spread with real quantities is a unit rate and stays comparable.
  const db2 = freshDb();
  awardPrices(
    db2,
    'LUMP',
    [
      2_000_000, 3_500_000, 5_000_000, 8_000_000, 11_000_000, 15_000_000, 19_000_000, 24_000_000,
      31_000_000, 40_000_000, 52_000_000, 68_000_000,
    ],
    { cantidad: 25 },
  );
  const unitPriced = benchmarkProduct(db2, 'LUMP');
  assert.equal(unitPriced.quantityOneShare, 0);
  assert.equal(unitPriced.usable, true);
  db2.close();
  db.close();
});

test('a code split across three decades is rejected even when the range is modest', () => {
  const db = freshDb();
  awardPrices(db, 'DECADES', [
    ...Array.from({ length: 8 }, (_, i) => 5 + i * 0.1),
    ...Array.from({ length: 8 }, (_, i) => 50 + i),
    ...Array.from({ length: 8 }, (_, i) => 500 + i),
  ]);
  const b = benchmarkProduct(db, 'DECADES');
  assert.equal(b.usable, false);
  assert.equal(b.magnitudeBuckets, 3);
  db.close();
});

test('the scan publishes outliers only from codes that passed the guards', () => {
  const db = freshDb();
  awardPrices(db, 'GOOD', [
    950, 960, 970, 980, 990, 1000, 1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070, 1080, 1090, 1100,
    1110, 1120, 1130, 3000,
  ]);
  awardPrices(db, 'BAD', [
    ...Array.from({ length: 20 }, (_, i) => 10 + i),
    ...Array.from({ length: 20 }, (_, i) => 1_000_000 + i * 1000),
  ]);

  const scan = scanPrices(db);
  assert.equal(scan.codesExamined, 2);
  assert.equal(scan.codesUsable, 1);
  assert.equal(scan.codesRejected.length, 1);
  assert.equal(scan.codesRejected[0].codigoProducto, 'BAD');
  assert.equal(scan.outliers.length, 1);
  assert.equal(scan.outliers[0].codigoProducto, 'GOOD');
  assert.equal(scan.outliers[0].unitPrice, 3000);
  db.close();
});

test('a re-issued award act does not enter the price sample twice', () => {
  const db = freshDb();
  awardPrices(db, 'REISSUE', Array.from({ length: 12 }, () => 1000));
  // The same line re-issued at a corrected price. Only the later act counts.
  insertAward(db, {
    nroSicop: 'T1',
    nroOferta: 'O-REISSUE-CRC-0',
    nroLinea: 'REISSUE-CRC-0',
    nroActo: '2',
    codigo: 'REISSUE',
    cantidad: 1,
    precio: 4000,
    proveedor: 'S0',
    moneda: 'CRC',
  });

  const b = benchmarkProduct(db, 'REISSUE');
  // Twelve lines, not thirteen: the superseded 1000 on that line is gone.
  assert.equal(b.n, 12);
  assert.equal(b.usable, true);
  assert.equal(b.outliers.length, 1);
  assert.equal(b.outliers[0].unitPrice, 4000);
  db.close();
});

test('an empty award table reports missing input', () => {
  const db = freshDb();
  const scan = scanPrices(db);
  assert.deepEqual(scan.missing, ['award_line']);
  assert.equal(scan.outliers.length, 0);
  db.close();
});
