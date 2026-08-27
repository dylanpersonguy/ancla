import assert from 'node:assert/strict';
import { test } from 'node:test';
import { METRIC_KEYS, benchmarkInstitution, rankInstitutions } from '../src/institution.ts';
import { emptyDb, insertInstitution, insertStage, tenderWithBidders } from './fixture.ts';

/**
 * Build an institution with a known single-bidder rate and exception rate.
 * Every tender is decided so the deserted denominator is unambiguous.
 */
function buildInstitution(
  db: ReturnType<typeof emptyDb>,
  cedula: string,
  opts: { tenders: number; singleBidder: number; exceptions?: number },
): void {
  insertInstitution(db, cedula, `Institución ${cedula}`);
  for (let i = 0; i < opts.tenders; i++) {
    const solo = i < opts.singleBidder;
    tenderWithBidders(db, {
      nroSicop: `${cedula}-T${i}`,
      institucion: cedula,
      bidders: solo ? [`${cedula}-S0`] : [`${cedula}-S0`, `${cedula}-S1`],
      winner: `${cedula}-S0`,
      estado: 'Contrato',
    });
    if (i < (opts.exceptions ?? 0)) {
      db.prepare('UPDATE tender SET cod_excepcion = ?, des_excepcion = ? WHERE nro_sicop = ?').run(
        'C0000108',
        'Proveedor único (Inciso c del artículo 3 LGCP 9986)',
        `${cedula}-T${i}`,
      );
    }
  }
}

test('metrics are computed against peers and a standing is reported', () => {
  const db = emptyDb();
  // The subject is worse than every peer: 80% single-bidder against 20%.
  buildInstitution(db, 'SUBJ', { tenders: 50, singleBidder: 40, exceptions: 5 });
  for (let p = 0; p < 8; p++) {
    buildInstitution(db, `PEER${p}`, { tenders: 50, singleBidder: 10, exceptions: 5 });
  }

  const b = benchmarkInstitution(db, 'SUBJ', { minSample: 20, minPeers: 5 });
  const sb = b.metrics.find((m) => m.key === 'single_bidder_rate');
  assert.ok(sb);
  assert.equal(sb.value, 0.8);
  assert.equal(sb.n, 50);
  assert.equal(sb.peerN, 8);
  assert.equal(sb.peerMedian, 0.2);
  // Highest value in the peer set, and lower is better, so standing is 0.
  assert.equal(sb.percentile, 1);
  assert.equal(sb.standing, 0);
  assert.equal(sb.suppressed, null);

  const exc = b.metrics.find((m) => m.key === 'exception_rate');
  assert.equal(exc?.value, 0.1);
  // Identical to every peer, so the tie-as-half rule puts it in the middle.
  assert.equal(exc?.percentile, 0.5);
  db.close();
});

test('a metric with too small a sample is suppressed instead of ranked', () => {
  const db = emptyDb();
  // Six tenders is not enough to publish a rate against anybody.
  buildInstitution(db, 'TINY', { tenders: 6, singleBidder: 6 });
  for (let p = 0; p < 8; p++) buildInstitution(db, `PEER${p}`, { tenders: 50, singleBidder: 10 });

  const b = benchmarkInstitution(db, 'TINY', { minSample: 20, minPeers: 5, allPeers: true });
  const sb = b.metrics.find((m) => m.key === 'single_bidder_rate');
  assert.equal(sb?.value, 1);
  assert.equal(sb?.n, 6);
  assert.equal(sb?.percentile, null);
  assert.equal(sb?.standing, null);
  assert.ok((sb?.suppressed as string).includes('below the minimum'));
  db.close();
});

test('peers are chosen by comparable volume', () => {
  const db = emptyDb();
  buildInstitution(db, 'SUBJ', { tenders: 40, singleBidder: 20 });
  // Five in band (20 to 80 tenders) and three far outside it.
  for (let p = 0; p < 5; p++) buildInstitution(db, `NEAR${p}`, { tenders: 45, singleBidder: 10 });
  for (let p = 0; p < 3; p++) buildInstitution(db, `FAR${p}`, { tenders: 400, singleBidder: 10 });

  const b = benchmarkInstitution(db, 'SUBJ', { minSample: 20, minPeers: 5 });
  assert.deepEqual(b.peerSelection.band, [20, 80]);
  assert.equal(b.peerSelection.peers, 5);
  assert.equal(b.peerSelection.candidates, 8);

  const everyone = benchmarkInstitution(db, 'SUBJ', { minSample: 20, minPeers: 5, allPeers: true });
  assert.equal(everyone.peerSelection.peers, 8);
  assert.equal(everyone.peerSelection.band, null);
  db.close();
});

test('the volume band falls back to all institutions when it leaves too few peers', () => {
  const db = emptyDb();
  buildInstitution(db, 'SUBJ', { tenders: 40, singleBidder: 20 });
  for (let p = 0; p < 8; p++) buildInstitution(db, `FAR${p}`, { tenders: 400, singleBidder: 10 });

  const b = benchmarkInstitution(db, 'SUBJ', { minSample: 20, minPeers: 5 });
  assert.equal(b.peerSelection.peers, 8);
  assert.ok(b.peerSelection.rule.includes('left too few peers'));
  db.close();
});

test('an institution with no tenders in the window says so rather than scoring zero', () => {
  const db = emptyDb();
  buildInstitution(db, 'OTHER', { tenders: 30, singleBidder: 10 });
  const b = benchmarkInstitution(db, 'MISSING');
  assert.equal(b.tendersPublished, 0);
  assert.equal(b.metrics.length, 0);
  assert.ok(b.notes[0].includes('no tenders found'));
  db.close();
});

test('payment speed is ranked from completed cases only', () => {
  const db = emptyDb();
  buildInstitution(db, 'SUBJ', { tenders: 30, singleBidder: 5 });
  for (let p = 0; p < 6; p++) buildInstitution(db, `PEER${p}`, { tenders: 30, singleBidder: 5 });
  // The subject pays in 100 days on every completed case. Peers take 30.
  for (let i = 0; i < 30; i++) {
    insertStage(db, {
      nroSicop: `SUBJ-T${i}`,
      publicacion: '2025-01-01',
      adjudicacionFirme: '2025-02-01',
      resulPago: '2025-05-12',
    });
  }
  for (let p = 0; p < 6; p++) {
    for (let i = 0; i < 30; i++) {
      insertStage(db, {
        nroSicop: `PEER${p}-T${i}`,
        publicacion: '2025-01-01',
        adjudicacionFirme: '2025-02-01',
        resulPago: '2025-03-03',
      });
    }
  }

  const b = benchmarkInstitution(db, 'SUBJ', { minSample: 20, minPeers: 5, allPeers: true });
  const pay = b.metrics.find((m) => m.key === 'award_to_payment_days');
  assert.equal(pay?.value, 100);
  assert.equal(pay?.n, 30);
  assert.equal(pay?.peerMedian, 30);
  assert.equal(pay?.standing, 0);
  // The reader is told the number is censored before they quote it.
  assert.ok(b.notes.some((n) => n.includes('censored')));
  db.close();
});

test('ranking returns every institution over the sample floor, worst first', () => {
  const db = emptyDb();
  buildInstitution(db, 'WORST', { tenders: 40, singleBidder: 36 });
  buildInstitution(db, 'MIDDLE', { tenders: 40, singleBidder: 20 });
  buildInstitution(db, 'BEST', { tenders: 40, singleBidder: 4 });
  buildInstitution(db, 'TOOSMALL', { tenders: 5, singleBidder: 5 });

  const r = rankInstitutions(db, 'single_bidder_rate', { minSample: 20 });
  assert.deepEqual(
    r.rows.map((x) => x.cedulaInstitucion),
    ['WORST', 'MIDDLE', 'BEST'],
  );
  assert.equal(r.rows[0].value, 0.9);
  assert.equal(r.lowerIsBetter, true);
  db.close();
});

test('an unknown metric name is rejected with the list of valid ones', () => {
  const db = emptyDb();
  assert.throws(() => rankInstitutions(db, 'nonsense'), /unknown metric nonsense/);
  assert.ok(METRIC_KEYS.includes('single_bidder_rate'));
  assert.ok(METRIC_KEYS.includes('award_to_payment_days'));
  db.close();
});

test('an empty database reports missing input', () => {
  const db = emptyDb();
  const b = benchmarkInstitution(db, 'ANY');
  assert.deepEqual(b.missing, ['tender']);
  assert.equal(b.metrics.length, 0);
  db.close();
});
