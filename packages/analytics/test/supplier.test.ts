import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supplierAppeals, supplierProfile } from '../src/supplier.ts';
import {
  emptyDb,
  insertAppeal,
  insertBid,
  insertInstitution,
  insertSanction,
  insertSupplier,
  insertTender,
  tenderWithBidders,
} from './fixture.ts';

test('win rate counts decided tenders only', () => {
  const db = emptyDb();
  // Six decided: two won, four lost. Three more bid on but never decided.
  for (let i = 0; i < 2; i++) {
    tenderWithBidders(db, { nroSicop: `W${i}`, bidders: ['SME', 'SR'], winner: 'SME', estado: 'Contrato' });
  }
  for (let i = 0; i < 4; i++) {
    tenderWithBidders(db, { nroSicop: `L${i}`, bidders: ['SME', 'SR'], winner: 'SR', estado: 'Contrato' });
  }
  for (let i = 0; i < 3; i++) {
    tenderWithBidders(db, { nroSicop: `U${i}`, bidders: ['SME', 'SR'], winner: null, estado: 'En evaluación' });
  }

  const p = supplierProfile(db, 'SME');
  assert.equal(p.overall.decided, 6);
  assert.equal(p.overall.won, 2);
  assert.equal(p.overall.rate, 1 / 3);
  assert.equal(p.overall.undecided, 3);
  db.close();
});

test('several offers on one tender are one appearance, not several', () => {
  const db = emptyDb();
  insertTender(db, { nroSicop: 'T1', estado: 'Contrato' });
  insertBid(db, { nroSicop: 'T1', nroOferta: 'O1', proveedor: 'SME' });
  insertBid(db, { nroSicop: 'T1', nroOferta: 'O2', proveedor: 'SME' });
  db.prepare(
    `INSERT INTO award_line (nro_sicop, nro_oferta, nro_linea, nro_acto, cedula_proveedor,
                             codigo_producto, cantidad, precio_unitario, moneda, source_month)
     VALUES ('T1','O1','1','1','SME','PROD-A',1,100,'CRC','202512')`,
  ).run();

  const p = supplierProfile(db, 'SME');
  assert.equal(p.overall.decided, 1);
  assert.equal(p.overall.won, 1);
  db.close();
});

test('who took the work is counted per tender with its evidence', () => {
  const db = emptyDb();
  for (let i = 0; i < 3; i++) {
    tenderWithBidders(db, { nroSicop: `A${i}`, bidders: ['SME', 'SRIVAL'], winner: 'SRIVAL', estado: 'Contrato' });
  }
  tenderWithBidders(db, { nroSicop: 'B0', bidders: ['SME', 'SOTHER'], winner: 'SOTHER', estado: 'Contrato' });
  insertSupplier(db, 'SRIVAL', 'Rival S.A.');

  const p = supplierProfile(db, 'SME');
  assert.equal(p.beatenBy.length, 2);
  assert.equal(p.beatenBy[0].cedulaProveedor, 'SRIVAL');
  assert.equal(p.beatenBy[0].times, 3);
  assert.equal(p.beatenBy[0].nombre, 'Rival S.A.');
  assert.deepEqual(p.beatenBy[0].nroSicop, ['A0', 'A1', 'A2']);
  db.close();
});

test('the price gap against a rival is a median over shared lines in one currency', () => {
  const db = emptyDb();
  // The subject bids 20% above the rival every time.
  for (let i = 0; i < 4; i++) {
    tenderWithBidders(db, {
      nroSicop: `G${i}`,
      bidders: ['SME', 'SRIVAL'],
      winner: 'SRIVAL',
      prices: { SME: 1200, SRIVAL: 1000 },
      estado: 'Contrato',
    });
  }
  const p = supplierProfile(db, 'SME');
  assert.equal(p.beatenBy[0].gapLines, 4);
  assert.ok(Math.abs((p.beatenBy[0].medianGapPct as number) - 20) < 1e-9);
  db.close();
});

test('a rival sanction is surfaced as a flag with its dates, not as a conclusion', () => {
  const db = emptyDb();
  for (let i = 0; i < 3; i++) {
    tenderWithBidders(db, { nroSicop: `S${i}`, bidders: ['SME', 'SBAD'], winner: 'SBAD', estado: 'Contrato' });
  }
  insertSanction(db, 'SBAD', 'Apercibimiento', '2026-03-01', '2027-03-01');

  const p = supplierProfile(db, 'SME');
  const rival = p.beatenBy.find((b) => b.cedulaProveedor === 'SBAD');
  assert.ok(rival);
  assert.equal(rival.sanctioned, true);
  assert.equal(rival.sanctions[0].inicio, '2026-03-01');
  // The note that stops a reader joining the two facts into a claim.
  assert.ok(p.notes.some((n) => n.includes('may postdate the tenders')));
  db.close();
});

test('product and institution breakdowns carry their own win rates', () => {
  const db = emptyDb();
  insertInstitution(db, 'INSTA', 'Ministerio A');
  insertInstitution(db, 'INSTB', 'Ministerio B');
  // Wins everything at A, loses everything at B, on two different codes.
  for (let i = 0; i < 3; i++) {
    tenderWithBidders(db, {
      nroSicop: `A${i}`,
      institucion: 'INSTA',
      bidders: ['SME', 'SR'],
      winner: 'SME',
      prices: { SME: 100, SR: 200 },
      codigo: 'CODE-A',
      estado: 'Contrato',
    });
  }
  for (let i = 0; i < 4; i++) {
    tenderWithBidders(db, {
      nroSicop: `B${i}`,
      institucion: 'INSTB',
      bidders: ['SME', 'SR'],
      winner: 'SR',
      prices: { SME: 300, SR: 200 },
      codigo: 'CODE-B',
      estado: 'Contrato',
    });
  }

  const p = supplierProfile(db, 'SME');
  const a = p.institutions.find((i) => i.cedulaInstitucion === 'INSTA');
  const b = p.institutions.find((i) => i.cedulaInstitucion === 'INSTB');
  assert.equal(a?.won, 3);
  assert.equal(a?.winRate, 1);
  assert.equal(a?.nombre, 'Ministerio A');
  assert.equal(b?.won, 0);
  assert.equal(b?.winRate, 0);

  const codeA = p.products.find((x) => x.codigoProducto === 'CODE-A');
  const codeB = p.products.find((x) => x.codigoProducto === 'CODE-B');
  assert.equal(codeA?.bidTenders, 3);
  assert.equal(codeA?.winRate, 1);
  assert.equal(codeB?.bidTenders, 4);
  assert.equal(codeB?.winRate, 0);
  db.close();
});

test('win rate is split by period', () => {
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'N1', fecha: '2025-11-05', bidders: ['SME'], winner: 'SME', estado: 'Contrato' });
  tenderWithBidders(db, { nroSicop: 'D1', fecha: '2025-12-05', bidders: ['SME', 'SR'], winner: 'SR', estado: 'Contrato' });
  tenderWithBidders(db, { nroSicop: 'D2', fecha: '2025-12-09', bidders: ['SME', 'SR'], winner: 'SR', estado: 'Contrato' });

  const p = supplierProfile(db, 'SME');
  assert.deepEqual(
    p.byPeriod.map((r) => [r.period, r.decided, r.won]),
    [
      ['2025-11', 1, 1],
      ['2025-12', 2, 0],
    ],
  );
  db.close();
});

test('appeal outcomes are grouped and the success rate excludes undecided ones', () => {
  const db = emptyDb();
  insertTender(db, { nroSicop: 'T1' });
  insertAppeal(db, 'R1', 'SME', 'T1', 'Con lugar');
  insertAppeal(db, 'R2', 'SME', 'T1', 'Parcialmente con lugar');
  insertAppeal(db, 'R3', 'SME', 'T1', 'Sin lugar');
  insertAppeal(db, 'R4', 'SME', 'T1', 'Rechaza de plano');
  insertAppeal(db, 'R5', 'SME', 'T1', ' ');

  const a = supplierAppeals(db, 'SME');
  assert.equal(a.filed, 5);
  assert.equal(a.decided, 4);
  assert.equal(a.successRate, 0.5);
  const undecided = a.byResult.find((r) => r.resultado === '(undecided)');
  assert.equal(undecided?.appeals, 1);
  db.close();
});

test('an unknown supplier returns an empty profile rather than throwing', () => {
  const db = emptyDb();
  tenderWithBidders(db, { nroSicop: 'T1', bidders: ['SOMEONE'], winner: 'SOMEONE', estado: 'Contrato' });
  const p = supplierProfile(db, 'NOBODY');
  assert.equal(p.identity.cedulaProveedor, 'NOBODY');
  assert.equal(p.identity.nombre, null);
  assert.equal(p.overall.decided, 0);
  assert.equal(p.overall.rate, null);
  assert.equal(p.beatenBy.length, 0);
  db.close();
});
