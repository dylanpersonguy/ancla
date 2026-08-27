import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bidderCounts,
  classifyStatus,
  competitionByInstitution,
  competitionReport,
  concentration,
  desertedRate,
  exceptionFamily,
  exceptionUsage,
} from '../src/competition.ts';
import {
  emptyDb,
  insertAward,
  insertBid,
  insertInstitution,
  insertTender,
  tenderWithBidders,
} from './fixture.ts';

test('a bidder is a distinct supplier, not a distinct offer', () => {
  // The measurement decision that separates 38.4% from 43.1% on December 2025.
  // One supplier filing two offers is still one bidder.
  const db = emptyDb();
  insertTender(db, { nroSicop: 'T1' });
  insertBid(db, { nroSicop: 'T1', nroOferta: 'O1', proveedor: 'S1' });
  insertBid(db, { nroSicop: 'T1', nroOferta: 'O2', proveedor: 'S1' });

  const counts = bidderCounts(db);
  assert.equal(counts.length, 1);
  assert.equal(counts[0].bidders, 1);
  assert.equal(counts[0].offers, 2);

  const report = competitionReport(db);
  assert.equal(report.singleBidder.singleBidder, 1);
  assert.equal(report.singleBidder.rate, 1);
  db.close();
});

test('single-bidder rate and distribution are exact on a hand-built set', () => {
  const db = emptyDb();
  // 10 tenders with bids: 4 have one bidder, 3 have two, 1 has three, 2 have five.
  const shape = [1, 1, 1, 1, 2, 2, 2, 3, 5, 5];
  shape.forEach((n, i) => {
    tenderWithBidders(db, {
      nroSicop: `T${i}`,
      bidders: Array.from({ length: n }, (_, k) => `S${k}`),
      winner: 'S0',
    });
  });

  const report = competitionReport(db);
  assert.equal(report.singleBidder.tendersWithBids, 10);
  assert.equal(report.singleBidder.singleBidder, 4);
  assert.equal(report.singleBidder.rate, 0.4);

  const dist = Object.fromEntries(report.bidderDistribution.map((b) => [b.label, b.tenders]));
  assert.deepEqual(dist, { '1': 4, '2': 3, '3': 1, '4+': 2 });
  const shares = Object.fromEntries(report.bidderDistribution.map((b) => [b.label, b.share]));
  assert.equal(shares['1'], 0.4);
  assert.equal(shares['4+'], 0.2);
  db.close();
});

test('tenders with no bid rows are counted separately, not as single-bidder', () => {
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'T1', bidders: ['S1'], winner: 'S1' });
  insertTender(db, { nroSicop: 'T2', estado: 'En recepción de ofertas' });

  const report = competitionReport(db);
  assert.equal(report.tendersPublished, 2);
  assert.equal(report.singleBidder.tendersWithBids, 1);
  assert.equal(report.tendersWithoutBidRows, 1);
  assert.equal(report.singleBidder.rate, 1);
  db.close();
});

test('the exception rate counts described exceptions only', () => {
  // Reproduces the December 2025 shape in miniature. Numeric cod_excepcion
  // values with no description belong to a different code family; counting them
  // moved the real figure from 18.7% to 31.3%.
  const db = emptyDb();
  for (let i = 0; i < 6; i++) insertTender(db, { nroSicop: `P${i}` });
  insertTender(db, {
    nroSicop: 'E1',
    codExcepcion: 'C0000115',
    desExcepcion: 'Reparaciones indeterminadas (Inciso j del artículo 3 LGCP 9986)',
  });
  insertTender(db, { nroSicop: 'E2', codExcepcion: 'C0000108', desExcepcion: 'Proveedor único (Inciso c del artículo 3 LGCP 9986)' });
  insertTender(db, { nroSicop: 'N1', codExcepcion: '4768', desExcepcion: null });
  insertTender(db, { nroSicop: 'N2', codExcepcion: '1561', desExcepcion: '' });

  const e = exceptionUsage(db);
  assert.equal(e.tendersPublished, 10);
  assert.equal(e.withException, 2);
  assert.equal(e.rate, 0.2);
  assert.equal(e.undescribedCodes, 2);
  assert.equal(e.byReason.length, 2);
  assert.equal(e.byReason[0].tenders, 1);
  db.close();
});

test('status classification covers both eras and flags anything it does not know', () => {
  // "Adjudicación en firme" is the pre-2024 wording for a final award and covers
  // 20,890 tenders in the real index. An exact-match list built from one recent
  // month left every one of them outside the denominator.
  assert.equal(classifyStatus('Adjudicación en firme'), 'awarded');
  assert.equal(classifyStatus('Acto Final en Firme'), 'awarded');
  assert.equal(classifyStatus('Contrato'), 'awarded');
  // Some archives split these and some publish the combined string.
  assert.equal(classifyStatus('Desierto'), 'noAward');
  assert.equal(classifyStatus('Infructuoso'), 'noAward');
  assert.equal(classifyStatus('Desierto/Infructuoso'), 'noAward');
  assert.equal(classifyStatus('Sin efecto'), 'annulled');
  assert.equal(classifyStatus('En evaluación'), 'inProgress');
  // A value nobody has seen before must surface, not default into a bucket.
  assert.equal(classifyStatus('Algo Nuevo'), 'unclassified');
  assert.equal(classifyStatus(''), 'unclassified');
  assert.equal(classifyStatus(null), 'unclassified');
});

test('an unknown status stays out of every denominator and is named', () => {
  const db = emptyDb();
  for (let i = 0; i < 6; i++) insertTender(db, { nroSicop: `A${i}`, estado: 'Contrato' });
  insertTender(db, { nroSicop: 'D1', estado: 'Desierto/Infructuoso' });
  insertTender(db, { nroSicop: 'Z1', estado: 'Estado Inventado' });

  const d = desertedRate(db);
  assert.equal(d.awarded, 6);
  assert.equal(d.noAward, 1);
  assert.equal(d.unclassified, 1);
  assert.deepEqual(d.unclassifiedStatuses, ['Estado Inventado']);
  // 1 of 7 resolved, not 1 of 8: the unknown one is excluded, not assumed.
  assert.equal(d.rateOfResolved, 1 / 7);
  db.close();
});

test('deserted rate reports a resolved denominator and an all-published one', () => {
  const db = emptyDb();
  // 5 awarded, 2 no-award, 1 annulled, 4 still open.
  for (let i = 0; i < 5; i++) insertTender(db, { nroSicop: `A${i}`, estado: 'Contrato' });
  insertTender(db, { nroSicop: 'D1', estado: 'Desierto' });
  insertTender(db, { nroSicop: 'D2', estado: 'Infructuoso' });
  insertTender(db, { nroSicop: 'X1', estado: 'Sin efecto' });
  for (let i = 0; i < 4; i++) insertTender(db, { nroSicop: `O${i}`, estado: 'En recepción de ofertas' });

  const d = desertedRate(db);
  assert.equal(d.tendersPublished, 12);
  assert.equal(d.awarded, 5);
  assert.equal(d.noAward, 2);
  assert.equal(d.annulled, 1);
  assert.equal(d.inProgress, 4);
  assert.equal(d.rateOfResolved, 2 / 7);
  assert.equal(d.rateOfPublished, 2 / 12);
  db.close();
});

test('small-value direct contracting is separated from substantive exceptions', () => {
  // The measurement that stops a false headline. Ley 9986 stopped counting
  // small-value purchases as competition exceptions on 2022-12-01. On the real
  // index the raw rate reads 82.4% before and 20.6% after, which looks like a
  // government cutting exceptions by three quarters. Excluding small-value
  // purchases it is 22.1% before and 20.6% after. Nothing changed but the law.
  assert.equal(exceptionFamily('Contratación directa por escasa cuantía (art.2 inc. h) LCA'), 'low-value-threshold');
  assert.equal(exceptionFamily('Contratación directa por escasa cuantia (art. 116)'), 'low-value-threshold');
  assert.equal(exceptionFamily('Proveedor único (Inciso c del artículo 3 LGCP 9986)'), 'substantive');
  assert.equal(exceptionFamily(null), 'substantive');

  const db = emptyDb();
  for (let i = 0; i < 4; i++) insertTender(db, { nroSicop: `P${i}`, fecha: '2021-06-01' });
  for (let i = 0; i < 6; i++) {
    insertTender(db, {
      nroSicop: `L${i}`,
      fecha: '2021-06-01',
      codExcepcion: 'X1',
      desExcepcion: 'Contratación directa por escasa cuantía (art.2 inc. h) LCA y art. 144 RLCA',
    });
  }
  for (let i = 0; i < 2; i++) {
    insertTender(db, {
      nroSicop: `S${i}`,
      fecha: '2021-06-01',
      codExcepcion: 'C0000108',
      desExcepcion: 'Proveedor único (Inciso c del artículo 3 LGCP 9986)',
    });
  }

  const e = exceptionUsage(db);
  assert.equal(e.tendersPublished, 12);
  assert.equal(e.withException, 8);
  assert.equal(e.rate, 8 / 12);
  assert.equal(e.lowValueThreshold, 6);
  assert.equal(e.substantive, 2);
  assert.equal(e.rateExcludingLowValue, 2 / 12);
  assert.equal(e.regime.beforeLgcp, 12);
  assert.equal(e.regime.fromLgcp, 0);
  // One era only, so no cross-boundary warning; just the composition note.
  assert.equal(e.warnings.filter((w) => w.includes('spans')).length, 0);
  assert.ok(e.warnings.some((w) => w.includes('small-value direct contracting')));
  db.close();
});

test('a window spanning the 2022 legal change carries a comparability warning', () => {
  const db = emptyDb();
  insertTender(db, {
    nroSicop: 'OLD',
    fecha: '2021-06-01',
    codExcepcion: 'X1',
    desExcepcion: 'Contratación directa por escasa cuantía (art. 116)',
  });
  insertTender(db, {
    nroSicop: 'NEW',
    fecha: '2024-06-01',
    codExcepcion: 'C0000108',
    desExcepcion: 'Proveedor único (Inciso c del artículo 3 LGCP 9986)',
  });

  const e = exceptionUsage(db);
  assert.equal(e.regime.beforeLgcp, 1);
  assert.equal(e.regime.fromLgcp, 1);
  assert.ok(e.warnings.some((w) => w.includes('2022-12-01')));

  // Confined to one era, the warning goes away.
  const post = exceptionUsage(db, { from: '2023-01-01' });
  assert.equal(post.regime.beforeLgcp, 0);
  assert.equal(post.warnings.filter((w) => w.includes('2022-12-01')).length, 0);
  db.close();
});

test('per-institution exception rates are reported raw and excluding low-value', () => {
  const db = emptyDb();
  insertInstitution(db, 'INSTA', 'Ministerio A');
  for (let i = 0; i < 10; i++) {
    insertTender(db, {
      nroSicop: `T${i}`,
      institucion: 'INSTA',
      desExcepcion:
        i < 5
          ? 'Contratación directa por escasa cuantía (art.2 inc. h) LCA'
          : i < 7
            ? 'Proveedor único (Inciso c del artículo 3 LGCP 9986)'
            : null,
      codExcepcion: i < 7 ? 'C1' : null,
    });
  }
  const rows = competitionByInstitution(db, { minTenders: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].exceptionTenders, 7);
  assert.equal(rows[0].exceptionRate, 0.7);
  assert.equal(rows[0].substantiveExceptions, 2);
  assert.equal(rows[0].substantiveExceptionRate, 0.2);
  db.close();
});

test('concentration is computed in one currency and reports what it excluded', () => {
  const db = emptyDb();
  insertTender(db, { nroSicop: 'T1' });
  // Four suppliers with equal awarded value in CRC: HHI is exactly 2500.
  for (let i = 0; i < 4; i++) {
    insertAward(db, {
      nroSicop: 'T1',
      nroOferta: `O${i}`,
      nroLinea: String(i),
      nroActo: '1',
      codigo: 'PROD-A',
      cantidad: 10,
      precio: 100,
      proveedor: `S${i}`,
      moneda: 'CRC',
    });
  }
  // A USD line that would swamp the index if it were naively added in.
  insertAward(db, {
    nroSicop: 'T1',
    nroOferta: 'OU',
    nroLinea: '99',
    nroActo: '1',
    codigo: 'PROD-A',
    cantidad: 10,
    precio: 100,
    proveedor: 'SUSD',
    moneda: 'USD',
  });

  const c = concentration(db, { currency: 'CRC' });
  assert.equal(c.n, 4);
  assert.equal(c.hhi, 2500);
  assert.equal(c.total, 4000);
  assert.equal(c.topShare, 0.25);
  assert.equal(c.excludedOtherCurrency, 1);
  db.close();
});

test('a re-issued award act is counted once, not twice', () => {
  // The award primary key includes nro_acto, so re-issuing an award duplicates
  // the line at full value. On the real index this overstated total awarded
  // value in colones by 33%. Every money path reads the deduplicated view.
  const db = emptyDb();
  insertTender(db, { nroSicop: 'T1' });
  const line = {
    nroSicop: 'T1',
    nroOferta: 'O1',
    nroLinea: '1',
    codigo: 'PROD-A',
    cantidad: 10,
    precio: 100,
    proveedor: 'S1',
    moneda: 'CRC',
  };
  insertAward(db, { ...line, nroActo: '9999' });
  // Re-issued at a corrected price. Note the act numbers: as text, '10001'
  // sorts before '9999', so the ordering has to be numeric.
  insertAward(db, { ...line, nroActo: '10001', precio: 150 });
  insertAward(db, {
    ...line,
    nroOferta: 'O2',
    nroLinea: '2',
    proveedor: 'S2',
    precio: 150,
    nroActo: '5',
  });

  const c = concentration(db, { currency: 'CRC' });
  // Two suppliers at 1,500 each, not 1,000 + 1,500 + 1,500.
  assert.equal(c.total, 3000);
  assert.equal(c.n, 2);
  assert.equal(c.hhi, 5000);
  const s1 = c.top.find((t) => t.cedulaProveedor === 'S1');
  assert.equal(s1?.value, 1500);
  assert.equal(s1?.lines, 1);
  db.close();
});

test('per-institution competition drops institutions below the volume floor', () => {
  const db = emptyDb();
  insertInstitution(db, 'BIG', 'Ministerio Grande');
  insertInstitution(db, 'SMALL', 'Municipalidad Pequeña');
  for (let i = 0; i < 6; i++) {
    tenderWithBidders(db, { nroSicop: `B${i}`, institucion: 'BIG', bidders: i < 3 ? ['S1'] : ['S1', 'S2'], winner: 'S1', estado: 'Contrato' });
  }
  tenderWithBidders(db, { nroSicop: 'M1', institucion: 'SMALL', bidders: ['S9'], winner: 'S9', estado: 'Contrato' });

  const all = competitionByInstitution(db, { minTenders: 1 });
  assert.equal(all.length, 2);
  const big = all.find((r) => r.cedulaInstitucion === 'BIG');
  assert.ok(big);
  assert.equal(big.tendersPublished, 6);
  assert.equal(big.tendersWithBids, 6);
  assert.equal(big.singleBidder, 3);
  assert.equal(big.singleBidderRate, 0.5);
  assert.equal(big.nombre, 'Ministerio Grande');

  const floored = competitionByInstitution(db, { minTenders: 5 });
  assert.equal(floored.length, 1);
  assert.equal(floored[0].cedulaInstitucion, 'BIG');
  db.close();
});

test('bids on a tender with no tender row still count', () => {
  // 11.9% of the tender IDs in the real bid table have no DetalleCarteles row.
  // An inner join drops them, which turned a December 2025 denominator of 1,662
  // into 1,042 and moved the single-bidder rate by two points.
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'KNOWN', bidders: ['S1', 'S2'], winner: 'S1' });
  insertBid(db, { nroSicop: 'ORPHAN', nroOferta: 'O1', proveedor: 'S3' });

  const report = competitionReport(db);
  assert.equal(report.singleBidder.tendersWithBids, 2);
  assert.equal(report.singleBidder.singleBidder, 1);
  assert.equal(report.bidsWithoutTenderRow, 1);
  assert.equal(report.bidsWithoutTenderRowExcluded, false);
  db.close();
});

test('a tender-side filter excludes orphan bids and says it did', () => {
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'KNOWN', fecha: '2025-12-05', bidders: ['S1', 'S2'], winner: 'S1' });
  insertBid(db, { nroSicop: 'ORPHAN', nroOferta: 'O1', proveedor: 'S3' });

  // An orphan has no publication date, so it cannot be tested against a window.
  const report = competitionReport(db, { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(report.singleBidder.tendersWithBids, 1);
  assert.equal(report.bidsWithoutTenderRow, 1);
  assert.equal(report.bidsWithoutTenderRowExcluded, true);
  db.close();
});

test('bidMonth scopes by the archive that published the bids', () => {
  // The two scopes answer different questions and both are right. On the real
  // index December 2025 reads 44.2% single-bidder by tender month and 43.1% by
  // bid month; the published monthly figure is the second.
  const db = emptyDb();
  // A tender from an older archive that received a bid in the December archive.
  insertTender(db, { nroSicop: 'OLD', month: '202511', fecha: '2025-11-02' });
  insertBid(db, { nroSicop: 'OLD', nroOferta: 'O1', proveedor: 'S1', month: '202512' });
  // A December tender whose only bid arrived in a later archive.
  insertTender(db, { nroSicop: 'NEW', month: '202512', fecha: '2025-12-02' });
  insertBid(db, { nroSicop: 'NEW', nroOferta: 'O2', proveedor: 'S1', month: '202601' });
  insertBid(db, { nroSicop: 'NEW', nroOferta: 'O3', proveedor: 'S2', month: '202601' });

  const byTenderMonth = competitionReport(db, { month: '202512' });
  assert.equal(byTenderMonth.singleBidder.tendersWithBids, 1);
  assert.equal(byTenderMonth.singleBidder.singleBidder, 0);

  const byBidMonth = competitionReport(db, { bidMonth: '202512' });
  assert.equal(byBidMonth.singleBidder.tendersWithBids, 1);
  assert.equal(byBidMonth.singleBidder.singleBidder, 1);
  db.close();
});

test('a date window filters on the publication date', () => {
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'T1', fecha: '2025-11-15', bidders: ['S1'], winner: 'S1' });
  tenderWithBidders(db, { nroSicop: 'T2', fecha: '2025-12-15', bidders: ['S1', 'S2'], winner: 'S1' });

  const december = competitionReport(db, { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(december.singleBidder.tendersWithBids, 1);
  assert.equal(december.singleBidder.singleBidder, 0);
  db.close();
});

test('a timestamped publication date still falls inside an inclusive window', () => {
  // The Observatorio stores "2025-12-22 14:27:08.0000000". A naive string
  // comparison against "2025-12-22" would exclude it from its own day.
  const db = emptyDb();
  tenderWithBidders(db, {
    nroSicop: 'T1',
    fecha: '2025-12-22 14:27:08.0000000',
    bidders: ['S1'],
    winner: 'S1',
  });
  const same = competitionReport(db, { from: '2025-12-22', to: '2025-12-22' });
  assert.equal(same.singleBidder.tendersWithBids, 1);
  db.close();
});

test('day-first dates are read as day-first, not silently mangled', () => {
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'T1', fecha: '22/12/2025', bidders: ['S1'], winner: 'S1' });
  const inWindow = competitionReport(db, { from: '2025-12-01', to: '2025-12-31' });
  assert.equal(inWindow.singleBidder.tendersWithBids, 1);
  const outOfWindow = competitionReport(db, { from: '2025-01-01', to: '2025-01-31' });
  assert.equal(outOfWindow.singleBidder.tendersWithBids, 0);
  db.close();
});

test('an empty database reports missing inputs instead of zeros that look like measurements', () => {
  const db = emptyDb();
  const report = competitionReport(db);
  assert.deepEqual(report.missing.sort(), ['bid', 'tender']);
  assert.equal(report.singleBidder.rate, null);
  assert.equal(report.exceptions.rate, null);
  assert.equal(report.deserted.rateOfResolved, null);
  assert.equal(report.concentration.hhi, null);
  db.close();
});
