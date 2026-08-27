import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SCREEN_DISCLAIMER,
  bidRotation,
  bidSpread,
  collusionReport,
  consistentLosing,
  singleBidderConcentration,
} from '../src/collusion.ts';
import { emptyDb, seededRandom, tenderWithBidders } from './fixture.ts';

test('every screen carries the indicator disclaimer', () => {
  const db = emptyDb();
  const report = collusionReport(db);
  for (const screen of [report.rotation, report.consistentLosing, report.bidSpread, report.singleBidderConcentration]) {
    assert.equal(screen.disclaimer, SCREEN_DISCLAIMER);
  }
  assert.ok(SCREEN_DISCLAIMER.includes('indicator, not a finding'));
  db.close();
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

test('a planted rotation fires and returns its tender ids', () => {
  const db = emptyDb();
  // Three suppliers, always the same three bidding, winner cycling A B C A B C.
  const group = ['SA', 'SB', 'SC'];
  const winners = ['SA', 'SB', 'SC', 'SA', 'SB', 'SC'];
  winners.forEach((winner, i) => {
    tenderWithBidders(db, { nroSicop: `R${i}`, bidders: group, winner, estado: 'Contrato' });
  });

  const r = bidRotation(db, { minTenders: 4 });
  assert.equal(r.hits.length, 1);
  const hit = r.hits[0];
  assert.deepEqual(hit.group, ['SA', 'SB', 'SC']);
  assert.equal(hit.coBidTenders, 6);
  assert.equal(hit.decidedTenders, 6);
  assert.equal(hit.distinctWinners, 3);
  assert.equal(hit.evenness, 1);
  // None of the three ever bid without the other two.
  assert.equal(hit.exclusivity, 1);
  // Six co-bids against a minimum of four means saturation 6/8.
  assert.equal(hit.score, 0.75);
  assert.deepEqual(hit.nroSicop, ['R0', 'R1', 'R2', 'R3', 'R4', 'R5']);
  db.close();
});

test('a pair of suppliers who happen to meet often is not a rotation ring', () => {
  // Every false positive on simulated random data was a pair. Two suppliers
  // landing on the same four tenders is a normal week in a small market.
  const db = emptyDb();
  for (let i = 0; i < 8; i++) {
    tenderWithBidders(db, {
      nroSicop: `P${i}`,
      bidders: ['SA', 'SB'],
      winner: i % 2 === 0 ? 'SA' : 'SB',
      estado: 'Contrato',
    });
  }
  assert.equal(bidRotation(db, { minTenders: 4 }).hits.length, 0);
  // Lowering the floor is possible, but it has to be an explicit choice.
  assert.equal(bidRotation(db, { minTenders: 4, minGroupSize: 2 }).hits.length, 1);
  db.close();
});

test('a group whose members also bid apart constantly does not score', () => {
  // Same three suppliers on six tenders, but each also bids alone elsewhere
  // twenty times. They are active in one market, not appearing only together.
  const db = emptyDb();
  for (let i = 0; i < 6; i++) {
    tenderWithBidders(db, {
      nroSicop: `T${i}`,
      bidders: ['SA', 'SB', 'SC'],
      winner: ['SA', 'SB', 'SC'][i % 3],
      estado: 'Contrato',
    });
  }
  for (const s of ['SA', 'SB', 'SC']) {
    for (let i = 0; i < 20; i++) {
      tenderWithBidders(db, { nroSicop: `${s}-solo${i}`, bidders: [s], winner: s, estado: 'Contrato' });
    }
  }
  const r = bidRotation(db, { minTenders: 4 });
  assert.equal(r.hits.length, 0);
  db.close();
});

test('one supplier winning every time is not rotation', () => {
  const db = emptyDb();
  for (let i = 0; i < 8; i++) {
    tenderWithBidders(db, { nroSicop: `D${i}`, bidders: ['SA', 'SB', 'SC'], winner: 'SA', estado: 'Contrato' });
  }
  const r = bidRotation(db, { minTenders: 4 });
  assert.equal(r.hits.length, 0);
  db.close();
});

test('rotation needs an identical bidder set, not an overlapping one', () => {
  const db = emptyDb();
  // The same two suppliers appear together but a third rotates in and out, so
  // the full bidder set differs on every tender.
  const sets = [
    ['SA', 'SB', 'SC'],
    ['SA', 'SB', 'SD'],
    ['SA', 'SB', 'SE'],
    ['SA', 'SB', 'SF'],
    ['SA', 'SB', 'SG'],
  ];
  sets.forEach((bidders, i) => {
    tenderWithBidders(db, { nroSicop: `O${i}`, bidders, winner: i % 2 === 0 ? 'SA' : 'SB', estado: 'Contrato' });
  });
  const r = bidRotation(db, { minTenders: 4 });
  assert.equal(r.hits.length, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Consistent losing
// ---------------------------------------------------------------------------

test('a planted losing streak is reported with its p-value and evidence', () => {
  const db = emptyDb();
  for (let i = 0; i < 10; i++) {
    tenderWithBidders(db, { nroSicop: `L${i}`, bidders: ['SWIN', 'SLOSE'], winner: 'SWIN', estado: 'Contrato' });
  }
  const r = consistentLosing(db, { minTenders: 5 });
  assert.equal(r.hits.length, 1);
  const hit = r.hits[0];
  assert.equal(hit.winner, 'SWIN');
  assert.equal(hit.loser, 'SLOSE');
  assert.equal(hit.encounters, 10);
  assert.equal(hit.winnerWins, 10);
  assert.equal(hit.lossRate, 1);
  // Ten from ten on a fair coin is 1/1024.
  assert.ok(Math.abs(hit.pValue - 1 / 1024) < 1e-12);
  // Only one pair was tested, so the adjustment does not change it.
  assert.equal(r.testsPerformed, 1);
  assert.equal(hit.pValueAdjusted, hit.pValue);
  assert.equal(hit.nroSicop.length, 10);
  db.close();
});

test('a short streak does not clear the significance bar', () => {
  const db = emptyDb();
  // Five from five is p = 0.031, which survives one test but is not much.
  for (let i = 0; i < 5; i++) {
    tenderWithBidders(db, { nroSicop: `S${i}`, bidders: ['SWIN', 'SLOSE'], winner: 'SWIN', estado: 'Contrato' });
  }
  const lenient = consistentLosing(db, { minTenders: 5, alpha: 0.05 });
  assert.equal(lenient.hits.length, 1);
  assert.ok(Math.abs(lenient.hits[0].pValue - 1 / 32) < 1e-12);

  // Under a stricter cutoff it drops out, which is the point of having one.
  const strict = consistentLosing(db, { minTenders: 5, alpha: 0.01 });
  assert.equal(strict.hits.length, 0);
  db.close();
});

test('an even head-to-head record is not reported', () => {
  const db = emptyDb();
  for (let i = 0; i < 10; i++) {
    tenderWithBidders(db, {
      nroSicop: `E${i}`,
      bidders: ['SA', 'SB'],
      winner: i % 2 === 0 ? 'SA' : 'SB',
      estado: 'Contrato',
    });
  }
  const r = consistentLosing(db, { minTenders: 5 });
  assert.equal(r.hits.length, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Bid spread
// ---------------------------------------------------------------------------

test('a fixed percentage gap is reported with a near-zero coefficient of variation', () => {
  const db = emptyDb();
  // The loser is always exactly 10% above the winner, on ten unrelated tenders.
  for (let i = 0; i < 10; i++) {
    const win = 1000 + i * 137;
    tenderWithBidders(db, {
      nroSicop: `G${i}`,
      bidders: ['SWIN', 'SLOSE'],
      winner: 'SWIN',
      prices: { SWIN: win, SLOSE: win * 1.1 },
      estado: 'Contrato',
    });
  }
  const r = bidSpread(db);
  assert.equal(r.hits.length, 1);
  const hit = r.hits[0];
  assert.equal(hit.winner, 'SWIN');
  assert.equal(hit.loser, 'SLOSE');
  assert.equal(hit.lines, 10);
  assert.ok(Math.abs(hit.medianGapPct - 10) < 1e-6);
  assert.ok((hit.cv as number) < 1e-9, `expected a near-zero cv, got ${hit.cv}`);
  assert.equal(hit.score, 1);
  assert.equal(hit.nroSicop.length, 10);
  db.close();
});

test('a stable gap over only a handful of lines is discounted, not headlined', () => {
  const db = emptyDb();
  for (let i = 0; i < 5; i++) {
    const win = 1000 + i * 137;
    tenderWithBidders(db, {
      nroSicop: `H${i}`,
      bidders: ['SWIN', 'SLOSE'],
      winner: 'SWIN',
      prices: { SWIN: win, SLOSE: win * 1.1 },
      estado: 'Contrato',
    });
  }
  const r = bidSpread(db);
  assert.equal(r.hits.length, 1);
  // Perfect stability, but only five tenders: saturation halves the score.
  assert.equal(r.hits[0].score, 0.5);
  db.close();
});

test('a variable gap does not score', () => {
  const db = emptyDb();
  const multipliers = [1.02, 1.4, 1.09, 1.85, 1.15, 1.6];
  multipliers.forEach((m, i) => {
    tenderWithBidders(db, {
      nroSicop: `V${i}`,
      bidders: ['SWIN', 'SLOSE'],
      winner: 'SWIN',
      prices: { SWIN: 1000, SLOSE: 1000 * m },
      estado: 'Contrato',
    });
  });
  const r = bidSpread(db, { minTenders: 4 });
  assert.equal(r.hits.length, 0);
  db.close();
});

test('bids in different currencies are never compared', () => {
  const db = emptyDb();
  for (let i = 0; i < 6; i++) {
    // Same product code, but the loser quoted USD. The ratio would be an
    // exchange rate, not a bid gap.
    tenderWithBidders(db, {
      nroSicop: `C${i}`,
      bidders: ['SWIN'],
      winner: 'SWIN',
      prices: { SWIN: 1000 },
      moneda: 'CRC',
      estado: 'Contrato',
    });
    db.prepare(
      `INSERT INTO bid (nro_sicop, nro_oferta, cedula_proveedor, tipo_oferta, source_month, archive_stamp)
       VALUES (?, ?, 'SLOSE', 'Individual', '202512', 'x')`,
    ).run(`C${i}`, `C${i}-USD`);
    db.prepare(
      `INSERT INTO bid_line (nro_sicop, nro_oferta, nro_linea, codigo_producto, cantidad,
                             precio_unitario, moneda, source_month)
       VALUES (?, ?, '1', 'PROD-A', 1, 1100, 'USD', '202512')`,
    ).run(`C${i}`, `C${i}-USD`);
  }
  const r = bidSpread(db, { minTenders: 4 });
  assert.equal(r.hits.length, 0);
  assert.equal(r.population, 0);
  db.close();
});

// ---------------------------------------------------------------------------
// Single-bidder concentration
// ---------------------------------------------------------------------------

test('a supplier holding an institution uncontested is reported with both shares', () => {
  const db = emptyDb();
  for (let i = 0; i < 5; i++) {
    tenderWithBidders(db, {
      nroSicop: `U${i}`,
      institucion: 'INSTX',
      bidders: ['SOLO'],
      winner: 'SOLO',
      estado: 'Contrato',
    });
  }
  // One contested tender at the same institution, to make the shares non-trivial.
  tenderWithBidders(db, {
    nroSicop: 'U9',
    institucion: 'INSTX',
    bidders: ['SOLO', 'SOTHER'],
    winner: 'SOTHER',
    estado: 'Contrato',
  });

  const r = singleBidderConcentration(db, { minTenders: 3 });
  const hit = r.hits.find((h) => h.cedulaProveedor === 'SOLO');
  assert.ok(hit);
  assert.equal(hit.soleBidTenders, 5);
  assert.equal(hit.soleBidWins, 5);
  assert.equal(hit.institutionSingleBidderTenders, 5);
  assert.equal(hit.shareOfInstitutionSingleBidder, 1);
  assert.equal(hit.supplierTendersAtInstitution, 6);
  assert.equal(hit.shareOfSupplierTenders, 5 / 6);
  assert.equal(hit.nroSicop.length, 5);
  // SOTHER only ever bid on a contested tender, so it is not in the output.
  assert.equal(r.hits.some((h) => h.cedulaProveedor === 'SOTHER'), false);
  db.close();
});

// ---------------------------------------------------------------------------
// The one that matters most: no screen fires on noise
// ---------------------------------------------------------------------------

test('no screen fires on random bidding', () => {
  // 400 tenders, 60 suppliers, 20 institutions, bidders drawn at random and the
  // winner drawn at random from among them, prices drawn independently.
  //
  // A screen that fires here is worthless: every hit it produced on real data
  // would be indistinguishable from chance. The seed is fixed so a failure is a
  // real failure and not something to rerun until it passes.
  const db = emptyDb();
  const rand = seededRandom(20251231);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
  const suppliers = Array.from({ length: 60 }, (_, i) => `S${i}`);
  const institutions = Array.from({ length: 20 }, (_, i) => `I${i}`);

  for (let t = 0; t < 400; t++) {
    const count = 1 + Math.floor(rand() * 4);
    const bidders = [...new Set(Array.from({ length: count }, () => pick(suppliers)))];
    const winner = pick(bidders);
    const prices: Record<string, number> = {};
    for (const b of bidders) prices[b] = 500 + Math.floor(rand() * 2000);
    tenderWithBidders(db, {
      nroSicop: `N${t}`,
      institucion: pick(institutions),
      bidders,
      winner,
      prices,
      estado: 'Contrato',
    });
  }

  const report = collusionReport(db);
  assert.equal(report.rotation.hits.length, 0, 'rotation fired on random data');
  assert.equal(report.consistentLosing.hits.length, 0, 'consistent losing fired on random data');
  assert.equal(report.bidSpread.hits.length, 0, 'bid spread fired on random data');
  assert.equal(
    report.singleBidderConcentration.hits.length,
    0,
    'single-bidder concentration fired on random data',
  );
  // The screens really did run; they just found nothing.
  assert.ok(report.rotation.population > 300);
  assert.ok(report.consistentLosing.population > 100);
  db.close();
});

test('the inferential screens stay silent on a concentrated random market', () => {
  // Harder than the last test and closer to reality. Fifteen suppliers and five
  // institutions, still bidding at random. In a market this thin, coincidental
  // repeat groupings and lopsided head-to-head records happen constantly, and
  // an unguarded screen produces a shortlist of them.
  //
  // Ten seeds were checked while tuning; the three inferential screens returned
  // nothing on every one. Two of them are checked here.
  for (const seed of [1, 42, 5150]) {
    const db = emptyDb();
    const rand = seededRandom(seed);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)];
    const suppliers = Array.from({ length: 15 }, (_, i) => `S${i}`);
    const institutions = Array.from({ length: 5 }, (_, i) => `I${i}`);
    for (let t = 0; t < 400; t++) {
      const count = 1 + Math.floor(rand() * 4);
      const bidders = [...new Set(Array.from({ length: count }, () => pick(suppliers)))];
      const winner = pick(bidders);
      const prices: Record<string, number> = {};
      for (const b of bidders) prices[b] = 500 + Math.floor(rand() * 2000);
      tenderWithBidders(db, {
        nroSicop: `N${t}`,
        institucion: pick(institutions),
        bidders,
        winner,
        prices,
        estado: 'Contrato',
      });
    }
    const report = collusionReport(db);
    assert.equal(report.rotation.hits.length, 0, `rotation fired on seed ${seed}`);
    assert.equal(report.consistentLosing.hits.length, 0, `consistent losing fired on seed ${seed}`);
    assert.equal(report.bidSpread.hits.length, 0, `bid spread fired on seed ${seed}`);

    // And the honest part. The single-bidder screen does fire here, because in
    // this market competition genuinely is thin. It is a descriptive screen: it
    // reports where nobody else showed up, and takes no view on why. Anyone
    // reading its output as evidence of an agreement is misreading it.
    assert.ok(
      report.singleBidderConcentration.hits.length > 0,
      `the descriptive screen should report thin competition on seed ${seed}`,
    );
  }
});

test('an empty database returns empty screens rather than throwing', () => {
  const db = emptyDb();
  const report = collusionReport(db);
  assert.deepEqual(report.missing.sort(), ['bid', 'tender']);
  assert.equal(report.rotation.hits.length, 0);
  assert.equal(report.bidSpread.hits.length, 0);
  db.close();
});
