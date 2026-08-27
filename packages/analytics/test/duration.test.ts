import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STAGES, durationByInstitution, durationReport, stageDuration } from '../src/duration.ts';
import { emptyDb, insertInstitution, insertStage, insertTender } from './fixture.ts';

const PUB_TO_AWARD = STAGES.find((s) => s.key === 'publication_to_award') as (typeof STAGES)[number];
const AWARD_TO_PAYMENT = STAGES.find((s) => s.key === 'award_to_payment') as (typeof STAGES)[number];

test('completed durations are exact and carry their n', () => {
  const db = emptyDb();
  // Four procedures awarded 10, 20, 30 and 40 days after publication.
  const gaps = [10, 20, 30, 40];
  gaps.forEach((g, i) => {
    insertStage(db, {
      nroSicop: `T${i}`,
      publicacion: '2025-01-01',
      adjudicacionFirme: new Date(Date.UTC(2025, 0, 1 + g)).toISOString().slice(0, 10),
    });
  });

  const s = stageDuration(db, PUB_TO_AWARD, { asOf: '2025-06-01' });
  assert.equal(s.completed, 4);
  assert.equal(s.censored, 0);
  assert.equal(s.days.n, 4);
  assert.equal(s.days.median, 25);
  assert.equal(s.days.min, 10);
  assert.equal(s.days.max, 40);
  assert.equal(s.censoringRate, 0);
  db.close();
});

test('right-censored records are excluded and counted, never treated as fast', () => {
  // The headline case. Four awards at 10, 20, 30, 40 days. Six procedures
  // published the same day and still not awarded 200 days later.
  //
  // Wrong answer: median 25 days, reported without qualification.
  // Right answer: median 25 days over 4 of 10, with 6 unfinished at 200+ days,
  // and every one of those six has already run longer than the median.
  const db = emptyDb();
  [10, 20, 30, 40].forEach((g, i) => {
    insertStage(db, {
      nroSicop: `DONE${i}`,
      publicacion: '2025-01-01',
      adjudicacionFirme: new Date(Date.UTC(2025, 0, 1 + g)).toISOString().slice(0, 10),
    });
  });
  for (let i = 0; i < 6; i++) {
    insertStage(db, { nroSicop: `OPEN${i}`, publicacion: '2025-01-01', adjudicacionFirme: null });
  }

  const s = stageDuration(db, PUB_TO_AWARD, { asOf: '2025-07-20' });
  assert.equal(s.n, 10);
  assert.equal(s.completed, 4);
  assert.equal(s.censored, 6);
  assert.equal(s.notStarted, 0);
  assert.equal(s.negative, 0);
  assert.equal(s.censoringRate, 0.6);
  assert.equal(s.days.median, 25);
  assert.equal(s.days.n, 4);
  // 2025-01-01 to 2025-07-20 is 200 days.
  assert.equal(s.censoredElapsed.median, 200);
  assert.equal(s.censoredPastMedian, 6);
  // Kaplan-Meier keeps the unfinished cases in the risk set, so it cannot
  // conclude a median from four events out of ten.
  assert.equal(s.kaplanMeier.reached, false);
  assert.equal(s.kaplanMeier.median, null);
  assert.equal(s.kaplanMeier.censored, 6);

  const censoringWarning = s.warnings.find((w) => w.includes('have not finished'));
  assert.ok(censoringWarning, `expected a censoring warning, got ${JSON.stringify(s.warnings)}`);
  assert.ok(s.warnings.some((w) => w.includes('already run longer than the reported median')));
  db.close();
});

test('a procedure that never entered the stage is not a censored duration', () => {
  // No award date at all and no start date either: nothing to measure from.
  // Counting these as censored would inflate the unfinished count.
  const db = emptyDb();
  insertStage(db, { nroSicop: 'T1', publicacion: '2025-01-01', adjudicacionFirme: '2025-01-11' });
  insertStage(db, { nroSicop: 'T2', publicacion: '2025-01-01', adjudicacionFirme: null });
  insertStage(db, { nroSicop: 'T3', publicacion: null, adjudicacionFirme: null });

  const s = stageDuration(db, PUB_TO_AWARD, { asOf: '2025-02-01' });
  assert.equal(s.completed, 1);
  assert.equal(s.censored, 1);
  assert.equal(s.notStarted, 1);
  db.close();
});

test('an end date before the start date is excluded and reported', () => {
  const db = emptyDb();
  insertStage(db, { nroSicop: 'OK', publicacion: '2025-01-01', adjudicacionFirme: '2025-01-11' });
  insertStage(db, { nroSicop: 'BAD', publicacion: '2025-03-01', adjudicacionFirme: '2025-02-01' });

  const s = stageDuration(db, PUB_TO_AWARD, { asOf: '2025-06-01' });
  assert.equal(s.completed, 1);
  assert.equal(s.negative, 1);
  assert.equal(s.days.median, 10);
  assert.ok(s.warnings.some((w) => w.includes('end date before the start date')));
  db.close();
});

test('a partially completed procedure is censored, not completed', () => {
  // Two lines, one awarded and one not. The procedure is not finished, so
  // taking the awarded line's date as the procedure duration would understate it.
  const db = emptyDb();
  insertStage(db, { nroSicop: 'T1', linea: '1', publicacion: '2025-01-01', adjudicacionFirme: '2025-01-11' });
  insertStage(db, { nroSicop: 'T1', linea: '2', publicacion: '2025-01-01', adjudicacionFirme: null });

  const asProcedure = stageDuration(db, PUB_TO_AWARD, { grain: 'procedure', asOf: '2025-02-01' });
  assert.equal(asProcedure.n, 1);
  assert.equal(asProcedure.completed, 0);
  assert.equal(asProcedure.censored, 1);

  // At line grain the finished line does count, and the unfinished one is censored.
  const asLine = stageDuration(db, PUB_TO_AWARD, { grain: 'line', asOf: '2025-02-01' });
  assert.equal(asLine.n, 2);
  assert.equal(asLine.completed, 1);
  assert.equal(asLine.censored, 1);
  db.close();
});

test('procedure grain spans the whole procedure, not one line', () => {
  const db = emptyDb();
  insertStage(db, { nroSicop: 'T1', linea: '1', publicacion: '2025-01-01', adjudicacionFirme: '2025-01-11' });
  insertStage(db, { nroSicop: 'T1', linea: '2', publicacion: '2025-01-05', adjudicacionFirme: '2025-02-01' });

  const s = stageDuration(db, PUB_TO_AWARD, { grain: 'procedure', asOf: '2025-06-01' });
  assert.equal(s.completed, 1);
  // Earliest publication 2025-01-01 to latest award 2025-02-01 is 31 days.
  assert.equal(s.days.median, 31);
  db.close();
});

test('line grain weights a many-line tender by its line count', () => {
  // Stated so the choice of default is visible. One 5-line tender awarded fast
  // outvotes five single-line tenders awarded slowly, at line grain.
  const db = emptyDb();
  for (let i = 0; i < 5; i++) {
    insertStage(db, { nroSicop: 'FAST', linea: String(i), publicacion: '2025-01-01', adjudicacionFirme: '2025-01-03' });
  }
  for (let i = 0; i < 4; i++) {
    insertStage(db, { nroSicop: `SLOW${i}`, publicacion: '2025-01-01', adjudicacionFirme: '2025-03-01' });
  }

  const byLine = stageDuration(db, PUB_TO_AWARD, { grain: 'line', asOf: '2025-06-01' });
  assert.equal(byLine.completed, 9);
  assert.equal(byLine.days.median, 2);

  const byProcedure = stageDuration(db, PUB_TO_AWARD, { grain: 'procedure', asOf: '2025-06-01' });
  assert.equal(byProcedure.completed, 5);
  assert.equal(byProcedure.days.median, 59);
  db.close();
});

test('an all-censored stage produces no median and says so', () => {
  // Matches the real archives, where fecha_resul_pago is empty for every row of
  // a single month. The right output is a refusal, not a zero.
  const db = emptyDb();
  for (let i = 0; i < 20; i++) {
    insertStage(db, {
      nroSicop: `T${i}`,
      publicacion: '2025-01-01',
      adjudicacionFirme: '2025-02-01',
      resulPago: null,
    });
  }
  const s = stageDuration(db, AWARD_TO_PAYMENT, { asOf: '2025-12-01' });
  assert.equal(s.completed, 0);
  assert.equal(s.censored, 20);
  assert.equal(s.days.median, null);
  assert.equal(s.censoringRate, 1);
  assert.ok(s.warnings.some((w) => w.includes('no completed observations')));
  db.close();
});

test('the observation date comes from the newest loaded archive', () => {
  const db = emptyDb();
  db.prepare(
    `INSERT INTO loaded_archive (source_month, archive_stamp, sha256, loaded_at)
     VALUES ('202512', '2025-12-31T13:04:22Z', 'abc', '2026-01-02')`,
  ).run();
  insertStage(db, { nroSicop: 'T1', publicacion: '2025-12-01', adjudicacionFirme: null });

  const report = durationReport(db);
  assert.equal(report.asOf, '2025-12-31');
  assert.equal(report.asOfSource, 'loaded_archive');
  const stage = report.stages.find((s) => s.key === 'publication_to_award');
  assert.ok(stage);
  assert.equal(stage.censoredElapsed.median, 30);
  db.close();
});

test('an empty stage table reports missing input rather than a report', () => {
  const db = emptyDb();
  const report = durationReport(db);
  assert.deepEqual(report.missing, ['stage_dates']);
  assert.equal(report.stages.length, 0);
  db.close();
});

test('per-institution medians are suppressed below the minimum completed count', () => {
  const db = emptyDb();
  insertInstitution(db, 'INST1', 'Ministerio A');
  for (let i = 0; i < 12; i++) {
    insertTender(db, { nroSicop: `T${i}`, institucion: 'INST1' });
    insertStage(db, { nroSicop: `T${i}`, publicacion: '2025-01-01', adjudicacionFirme: '2025-01-21' });
  }
  const withEnough = durationByInstitution(db, { minCompleted: 10 });
  assert.equal(withEnough.length, 1);
  assert.equal(withEnough[0].publicationToAward.n, 12);
  assert.equal(withEnough[0].publicationToAward.median, 20);

  const tooStrict = durationByInstitution(db, { minCompleted: 20 });
  assert.equal(tooStrict[0].publicationToAward.n, 12);
  assert.equal(tooStrict[0].publicationToAward.median, null);
  db.close();
});
