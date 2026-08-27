/**
 * Stage durations, with the censoring made explicit.
 *
 * This is the module most likely to produce a wrong public number, so the
 * failure mode is worth stating plainly. In the December 2025 archive, 100% of
 * FechaPorEtapas rows have a publication date, 14.7% have an award date, 0.4%
 * have a first payment request, and 0% have a payment result. A procedure whose
 * payment date has not arrived is not a fast procedure. It is an unfinished one.
 *
 * Take the median of "award to payment" over whatever rows happen to have both
 * dates and you have measured the subset that finished quickly, then called it
 * the typical case. The bias runs one way and it is large.
 *
 * So every stage here reports four counts before it reports a number:
 *
 *   completed   both dates present, end not before start. The stats use these.
 *   censored    start present, end missing. Still running at the observation date.
 *   notStarted  start missing. The stage was never entered; not a duration at all.
 *   negative    end before start. A data error, excluded and counted, never clipped.
 *
 * The completed-only median is reported alongside a Kaplan-Meier median, which
 * uses the censored cases properly. When more than half the population has not
 * finished, Kaplan-Meier correctly refuses to give a median instead of inventing
 * one, and that refusal is the honest answer.
 */

import { query } from '../../core/src/db.ts';
import { type Summary, kaplanMeierMedian, summarize } from './stats.ts';
import { type Db, type Window, asOfDate, days, dateExpr, missingInputs } from './sql.ts';

/** Column pairs on stage_dates that make up a stage. */
export interface StageDefinition {
  key: string;
  label: string;
  start: string;
  end: string;
  note?: string;
}

export const STAGES: StageDefinition[] = [
  {
    key: 'publication_to_award',
    label: 'publication to award',
    start: 'publicacion',
    end: 'adjudicacion_firme',
  },
  {
    key: 'award_to_contract',
    label: 'award to contract',
    start: 'adjudicacion_firme',
    end: 'fecha_elaboracion_contrato',
  },
  {
    key: 'award_to_payment',
    label: 'award to payment result',
    start: 'adjudicacion_firme',
    end: 'fecha_resul_pago',
    note: 'fecha_resul_pago is the last stage recorded and is the sparsest column in the table',
  },
  {
    key: 'award_to_first_payment_request',
    label: 'award to first payment request',
    start: 'adjudicacion_firme',
    end: 'fecha_1ra_sol_pago',
    note: 'a request, not a payment; reported because fecha_resul_pago is usually absent',
  },
  {
    key: 'contract_to_payment',
    label: 'contract to payment result',
    start: 'fecha_elaboracion_contrato',
    end: 'fecha_resul_pago',
  },
];

export type Grain = 'procedure' | 'line';

export interface DurationOptions extends Window {
  /**
   * 'procedure' gives one observation per nro_sicop. 'line' uses the table's own
   * grain, which weights a 500-line tender 500 times. Procedure is the default
   * because duration claims are made about procedures.
   */
  grain?: Grain;
  /** Observation date for censoring. Defaults to the newest archive loaded. */
  asOf?: string;
  /** Stage keys to compute. Defaults to all of STAGES. */
  stages?: string[];
}

export interface StageDuration {
  key: string;
  label: string;
  grain: Grain;
  note?: string;
  /** Observations examined, the sum of the four disposition counts. */
  n: number;
  completed: number;
  censored: number;
  notStarted: number;
  negative: number;
  /**
   * censored / (completed + censored). Above 0.5 the completed-only median is
   * describing a minority and should not be quoted on its own.
   */
  censoringRate: number | null;
  /** Days elapsed so far for the unfinished cases. Their lower bound. */
  censoredElapsed: Summary;
  /** How many unfinished cases have already run longer than the reported median. */
  censoredPastMedian: number;
  /** Completed cases only. Reported with the counts above, never alone. */
  days: Summary;
  kaplanMeier: { n: number; events: number; censored: number; median: number | null; reached: boolean };
  /** Plain-language warnings a reader has to see next to the number. */
  warnings: string[];
}

export interface DurationReport {
  window: DurationOptions;
  asOf: string;
  asOfSource: string;
  missing: string[];
  stages: StageDuration[];
}

interface RawObservation {
  id: string;
  start: string | null;
  end: string | null;
}

/**
 * Pull start and end dates for one stage.
 *
 * At procedure grain the start is the earliest date across the procedure's lines
 * and the end is the latest, so the duration covers the whole procedure. A
 * procedure counts as completed only when every line that started has also
 * ended: partial completion is still an unfinished procedure, and rolling it in
 * as complete is exactly the bias this module exists to avoid.
 */
function observations(db: Db, stage: StageDefinition, opts: DurationOptions): RawObservation[] {
  const grain = opts.grain ?? 'procedure';
  const startExpr = dateExpr(db, 'stage_dates', stage.start, 's');
  const endExpr = dateExpr(db, 'stage_dates', stage.end, 's');

  const clauses = ['1=1'];
  const params: unknown[] = [];
  const pubExpr = dateExpr(db, 'stage_dates', 'publicacion', 's');
  if (opts.from) {
    clauses.push(`${pubExpr} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`${pubExpr} <= ?`);
    params.push(opts.to);
  }
  if (opts.month) {
    clauses.push('s.source_month = ?');
    params.push(opts.month);
  }
  if (opts.institution) {
    clauses.push(
      'EXISTS (SELECT 1 FROM tender t WHERE t.nro_sicop = s.nro_sicop AND t.cedula_institucion = ?)',
    );
    params.push(opts.institution);
  }
  const where = clauses.join(' AND ');

  if (grain === 'line') {
    return query<RawObservation>(
      db,
      `SELECT s.nro_sicop || '|' || s.cartel_seq || '|' || s.partida || '|' || s.linea AS id,
              ${startExpr} AS start,
              ${endExpr}   AS end
         FROM stage_dates s
        WHERE ${where}`,
      params,
    );
  }

  // Procedure grain. linesStarted vs linesEnded decides completion.
  return query<RawObservation & { linesStarted: number; linesEnded: number }>(
    db,
    `SELECT s.nro_sicop AS id,
            MIN(${startExpr}) AS start,
            MAX(${endExpr})   AS end,
            SUM(CASE WHEN ${startExpr} IS NOT NULL THEN 1 ELSE 0 END) AS linesStarted,
            SUM(CASE WHEN ${endExpr}   IS NOT NULL THEN 1 ELSE 0 END) AS linesEnded
       FROM stage_dates s
      WHERE ${where}
      GROUP BY s.nro_sicop`,
    params,
  ).map((r) => ({
    id: r.id,
    start: r.start,
    // A procedure with some lines still open is censored, not completed.
    end: r.linesEnded > 0 && r.linesEnded === r.linesStarted ? r.end : null,
  }));
}

export function stageDuration(db: Db, stage: StageDefinition, opts: DurationOptions = {}): StageDuration {
  const grain = opts.grain ?? 'procedure';
  const asOf = opts.asOf ?? asOfDate(db).asOf;
  const rows = observations(db, stage, opts);

  const completedDays: number[] = [];
  const censoredDays: number[] = [];
  let notStarted = 0;
  let negative = 0;

  for (const r of rows) {
    if (!r.start) {
      notStarted++;
      continue;
    }
    if (!r.end) {
      const elapsed = days(r.start, asOf);
      // A start date in the future of the observation date is unusable, not zero.
      if (elapsed !== null && elapsed >= 0) censoredDays.push(elapsed);
      else negative++;
      continue;
    }
    const d = days(r.start, r.end);
    if (d === null) notStarted++;
    else if (d < 0) negative++;
    else completedDays.push(d);
  }

  const summary = summarize(completedDays);
  const censoredSummary = summarize(censoredDays);
  const completed = completedDays.length;
  const censored = censoredDays.length;
  const censoringRate = completed + censored > 0 ? censored / (completed + censored) : null;
  const med = summary.median;
  const censoredPastMedian = med === null ? 0 : censoredDays.filter((d) => d > med).length;

  const km = kaplanMeierMedian([
    ...completedDays.map((t) => ({ time: t, completed: true })),
    ...censoredDays.map((t) => ({ time: t, completed: false })),
  ]);

  const n = (v: number) => v.toLocaleString('en-US');
  const dayCount = (v: number) => `${n(v)} ${v === 1 ? 'day' : 'days'}`;
  const warnings: string[] = [];
  if (completed === 0) {
    warnings.push('no completed observations; nothing here is a duration statistic');
  } else if (completed < 30) {
    warnings.push(`only ${n(completed)} completed observations; treat the percentiles as indicative`);
  }
  if (censoringRate !== null && censoringRate >= 0.5) {
    warnings.push(
      `${(censoringRate * 100).toFixed(1)}% of started cases have not finished; the completed-only median describes a minority and runs fast`,
    );
  } else if (censoringRate !== null && censoringRate >= 0.2) {
    warnings.push(`${(censoringRate * 100).toFixed(1)}% of started cases have not finished; the median runs fast`);
  }
  if (censoredPastMedian > 0 && med !== null) {
    warnings.push(
      `${n(censoredPastMedian)} unfinished cases have already run longer than the reported median of ${dayCount(med)}`,
    );
  }
  if (negative > 0) {
    warnings.push(`${n(negative)} observations had an end date before the start date and were excluded`);
  }
  if (km.reached && med !== null && km.median !== null && km.median > med) {
    warnings.push(
      `Kaplan-Meier median is ${dayCount(km.median)} against a completed-only median of ${dayCount(med)}; quote the former`,
    );
  }
  if (!km.reached && censored > 0) {
    warnings.push('Kaplan-Meier survival never crossed 50%; the true median is beyond the observation window');
  }

  return {
    key: stage.key,
    label: stage.label,
    grain,
    note: stage.note,
    n: rows.length,
    completed,
    censored,
    notStarted,
    negative,
    censoringRate,
    censoredElapsed: censoredSummary,
    censoredPastMedian,
    days: summary,
    kaplanMeier: km,
    warnings,
  };
}

export function durationReport(db: Db, opts: DurationOptions = {}): DurationReport {
  const missing = missingInputs(db, ['stage_dates']);
  const stamp = asOfDate(db);
  const asOf = opts.asOf ?? stamp.asOf;
  const wanted = opts.stages?.length
    ? STAGES.filter((s) => opts.stages?.includes(s.key))
    : STAGES;
  return {
    window: opts,
    asOf,
    asOfSource: opts.asOf ? 'caller' : stamp.source,
    missing,
    stages: missing.length ? [] : wanted.map((s) => stageDuration(db, s, { ...opts, asOf })),
  };
}

/**
 * Median publication-to-award and award-to-payment per institution, for peer
 * ranking. Institutions with fewer than minCompleted completed cases return
 * null rather than a median: ranking an institution on four finished procedures
 * is how a benchmark turns into a smear.
 */
export interface InstitutionDuration {
  cedulaInstitucion: string;
  nombre: string | null;
  procedures: number;
  publicationToAward: { n: number; median: number | null; censored: number };
  awardToPayment: { n: number; median: number | null; censored: number };
}

export function durationByInstitution(
  db: Db,
  opts: DurationOptions & { minCompleted?: number } = {},
): InstitutionDuration[] {
  const minCompleted = opts.minCompleted ?? 10;
  const asOf = opts.asOf ?? asOfDate(db).asOf;
  const stages = STAGES.filter((s) => s.key === 'publication_to_award' || s.key === 'award_to_payment');

  const perInstitution = new Map<
    string,
    { nombre: string | null; procedures: Set<string>; byStage: Map<string, { done: number[]; censored: number }> }
  >();

  for (const stage of stages) {
    const startExpr = dateExpr(db, 'stage_dates', stage.start, 's');
    const endExpr = dateExpr(db, 'stage_dates', stage.end, 's');
    const pubExpr = dateExpr(db, 'stage_dates', 'publicacion', 's');
    const clauses = ['1=1'];
    const params: unknown[] = [];
    if (opts.from) {
      clauses.push(`${pubExpr} >= ?`);
      params.push(opts.from);
    }
    if (opts.to) {
      clauses.push(`${pubExpr} <= ?`);
      params.push(opts.to);
    }
    if (opts.month) {
      clauses.push('s.source_month = ?');
      params.push(opts.month);
    }

    const rows = query<{
      cedulaInstitucion: string;
      nombre: string | null;
      id: string;
      start: string | null;
      end: string | null;
      linesStarted: number;
      linesEnded: number;
    }>(
      db,
      `SELECT t.cedula_institucion AS cedulaInstitucion,
              i.nombre             AS nombre,
              s.nro_sicop          AS id,
              MIN(${startExpr})    AS start,
              MAX(${endExpr})      AS end,
              SUM(CASE WHEN ${startExpr} IS NOT NULL THEN 1 ELSE 0 END) AS linesStarted,
              SUM(CASE WHEN ${endExpr}   IS NOT NULL THEN 1 ELSE 0 END) AS linesEnded
         FROM stage_dates s
         JOIN tender t ON t.nro_sicop = s.nro_sicop
         LEFT JOIN institution i ON i.cedula = t.cedula_institucion
        WHERE ${clauses.join(' AND ')}
        GROUP BY s.nro_sicop`,
      params,
    );

    for (const r of rows) {
      if (!r.cedulaInstitucion) continue;
      let entry = perInstitution.get(r.cedulaInstitucion);
      if (!entry) {
        entry = { nombre: r.nombre, procedures: new Set(), byStage: new Map() };
        perInstitution.set(r.cedulaInstitucion, entry);
      }
      entry.procedures.add(r.id);
      let bucket = entry.byStage.get(stage.key);
      if (!bucket) {
        bucket = { done: [], censored: 0 };
        entry.byStage.set(stage.key, bucket);
      }
      if (!r.start) continue;
      const complete = r.linesEnded > 0 && r.linesEnded === r.linesStarted && r.end;
      if (complete) {
        const d = days(r.start, r.end);
        if (d !== null && d >= 0) bucket.done.push(d);
      } else {
        const elapsed = days(r.start, asOf);
        if (elapsed !== null && elapsed >= 0) bucket.censored++;
      }
    }
  }

  const out: InstitutionDuration[] = [];
  for (const [cedula, entry] of perInstitution) {
    const pick = (key: string) => {
      const b = entry.byStage.get(key) ?? { done: [], censored: 0 };
      const n = b.done.length;
      return {
        n,
        median: n >= minCompleted ? summarize(b.done).median : null,
        censored: b.censored,
      };
    };
    out.push({
      cedulaInstitucion: cedula,
      nombre: entry.nombre,
      procedures: entry.procedures.size,
      publicationToAward: pick('publication_to_award'),
      awardToPayment: pick('award_to_payment'),
    });
  }
  return out.sort((a, b) => b.procedures - a.procedures);
}
