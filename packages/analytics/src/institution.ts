/**
 * Peer benchmarking for one institution. The pre-audit self-check.
 *
 * A procurement office wants to know where it sits before someone else tells it.
 * That is the product: four numbers, each next to the same number for comparable
 * institutions, with a percentile so the answer is "you are in the worst decile
 * on exception usage" rather than "your exception usage is 24%", which means
 * nothing without a reference.
 *
 * Two rules keep this from being unfair.
 *
 * A peer is an institution with comparable volume. Comparing a ministry running
 * two thousand tenders a year to a municipality running forty produces a ranking
 * that measures size, not conduct. The default band is half to double the
 * subject's tender count.
 *
 * A metric with too small a sample is not ranked. It returns null and says why.
 * Publishing "worst in the country on single-bidder rate" off six tenders is
 * exactly how a credible project stops being credible.
 */

import { query } from '../../core/src/db.ts';
import { percentileRank, summarize } from './stats.ts';
import {
  type CompetitionOptions,
  type InstitutionCompetition,
  competitionByInstitution,
} from './competition.ts';
import { type InstitutionDuration, durationByInstitution } from './duration.ts';
import { type Db, type Window, missingInputs } from './sql.ts';

export interface BenchmarkOptions extends Window {
  /** Peers must have between this multiple of the subject's volume and its inverse. */
  volumeBand?: number;
  /** Minimum peers before a percentile is reported at all. */
  minPeers?: number;
  /** Minimum observations behind a metric before it is ranked. */
  minSample?: number;
  /** Ignore the volume band and rank against every institution. */
  allPeers?: boolean;
}

export interface Metric {
  key: string;
  label: string;
  /** true when a lower value is the better outcome. */
  lowerIsBetter: boolean;
  value: number | null;
  /** Observations behind the subject's value. */
  n: number;
  /** Percentile of the subject inside the peer set, 0..1. */
  percentile: number | null;
  /** Percentile expressed so that 1.0 is always the good end. */
  standing: number | null;
  peerN: number;
  peerMedian: number | null;
  peerP25: number | null;
  peerP75: number | null;
  /** Set when the metric could not be ranked, with the reason. */
  suppressed: string | null;
}

export interface InstitutionBenchmark {
  window: BenchmarkOptions;
  missing: string[];
  cedulaInstitucion: string;
  nombre: string | null;
  tendersPublished: number;
  peerSelection: {
    rule: string;
    band: [number, number] | null;
    peers: number;
    /** Institutions in scope before the volume band was applied. */
    candidates: number;
  };
  metrics: Metric[];
  notes: string[];
}

interface Row {
  cedula: string;
  nombre: string | null;
  tendersPublished: number;
  singleBidderRate: number | null;
  singleBidderN: number;
  exceptionRate: number | null;
  exceptionN: number;
  desertedRate: number | null;
  desertedN: number;
  publicationToAwardDays: number | null;
  publicationToAwardN: number;
  awardToPaymentDays: number | null;
  awardToPaymentN: number;
}

function assemble(
  competition: readonly InstitutionCompetition[],
  durations: readonly InstitutionDuration[],
): Map<string, Row> {
  const durationByCedula = new Map(durations.map((d) => [d.cedulaInstitucion, d]));
  const out = new Map<string, Row>();
  for (const c of competition) {
    const d = durationByCedula.get(c.cedulaInstitucion);
    out.set(c.cedulaInstitucion, {
      cedula: c.cedulaInstitucion,
      nombre: c.nombre,
      tendersPublished: c.tendersPublished,
      singleBidderRate: c.singleBidderRate,
      singleBidderN: c.tendersWithBids,
      // The substantive rate, not the raw one. Small-value direct contracting was
      // an exception under the pre-2022 law and is not under the current one, so
      // ranking on the raw rate ranks institutions by how much of their history
      // predates Ley 9986. See competition.ts for the numbers behind that.
      exceptionRate: c.substantiveExceptionRate,
      exceptionN: c.tendersPublished,
      desertedRate: c.desertedRateOfResolved,
      // The deserted denominator is resolved tenders, recovered from the rate.
      desertedN: c.desertedRateOfResolved !== null && c.desertedRateOfResolved > 0
        ? Math.round(c.noAward / c.desertedRateOfResolved)
        : c.noAward,
      publicationToAwardDays: d?.publicationToAward.median ?? null,
      publicationToAwardN: d?.publicationToAward.n ?? 0,
      awardToPaymentDays: d?.awardToPayment.median ?? null,
      awardToPaymentN: d?.awardToPayment.n ?? 0,
    });
  }
  return out;
}

const METRIC_SPECS: {
  key: string;
  label: string;
  lowerIsBetter: boolean;
  value: (r: Row) => number | null;
  n: (r: Row) => number;
}[] = [
  {
    key: 'single_bidder_rate',
    label: 'single-bidder rate',
    lowerIsBetter: true,
    value: (r) => r.singleBidderRate,
    n: (r) => r.singleBidderN,
  },
  {
    key: 'exception_rate',
    label: 'exception rate, excluding low-value',
    lowerIsBetter: true,
    value: (r) => r.exceptionRate,
    n: (r) => r.exceptionN,
  },
  {
    key: 'deserted_rate',
    label: 'deserted or unsuccessful rate',
    lowerIsBetter: true,
    value: (r) => r.desertedRate,
    n: (r) => r.desertedN,
  },
  {
    key: 'publication_to_award_days',
    label: 'median days, publication to award',
    lowerIsBetter: true,
    value: (r) => r.publicationToAwardDays,
    n: (r) => r.publicationToAwardN,
  },
  {
    key: 'award_to_payment_days',
    label: 'median days, award to payment',
    lowerIsBetter: true,
    value: (r) => r.awardToPaymentDays,
    n: (r) => r.awardToPaymentN,
  },
];

export function benchmarkInstitution(
  db: Db,
  cedula: string,
  opts: BenchmarkOptions = {},
): InstitutionBenchmark {
  const band = opts.volumeBand ?? 2;
  const minPeers = opts.minPeers ?? 5;
  const minSample = opts.minSample ?? 20;
  const missing = missingInputs(db, ['tender']);

  const compOpts: CompetitionOptions & { minTenders?: number } = {
    from: opts.from,
    to: opts.to,
    month: opts.month,
    // Rank against every institution with any volume; the band filters below.
    minTenders: 1,
  };
  const competition = missing.length ? [] : competitionByInstitution(db, compOpts);
  const durations = missing.length
    ? []
    : durationByInstitution(db, { from: opts.from, to: opts.to, month: opts.month, minCompleted: 10 });

  const rows = assemble(competition, durations);
  const subject = rows.get(cedula);

  const nameRow = query<{ nombre: string }>(db, 'SELECT nombre FROM institution WHERE cedula = ?', [cedula])[0];
  const nombre = subject?.nombre ?? nameRow?.nombre ?? null;

  if (!subject) {
    return {
      window: opts,
      missing,
      cedulaInstitucion: cedula,
      nombre,
      tendersPublished: 0,
      peerSelection: { rule: 'none', band: null, peers: 0, candidates: rows.size },
      metrics: [],
      notes: [`no tenders found for ${cedula} in this window`],
    };
  }

  const volume = subject.tendersPublished;
  const lower = Math.max(1, Math.floor(volume / band));
  const upper = Math.ceil(volume * band);
  const allPeers = opts.allPeers ?? false;
  let peers = [...rows.values()].filter((r) => r.cedula !== cedula);
  const candidates = peers.length;
  if (!allPeers) {
    const banded = peers.filter((r) => r.tendersPublished >= lower && r.tendersPublished <= upper);
    // Falling back to everyone is better than reporting a percentile over three
    // institutions, as long as the output says which rule was used.
    if (banded.length >= minPeers) peers = banded;
  }
  const bandApplied = !allPeers && peers.length !== candidates;

  const metrics: Metric[] = METRIC_SPECS.map((spec) => {
    const value = spec.value(subject);
    const n = spec.n(subject);
    const peerValues = peers
      .filter((p) => spec.n(p) >= minSample)
      .map((p) => spec.value(p))
      .filter((v): v is number => v !== null);

    const base: Metric = {
      key: spec.key,
      label: spec.label,
      lowerIsBetter: spec.lowerIsBetter,
      value,
      n,
      percentile: null,
      standing: null,
      peerN: peerValues.length,
      peerMedian: summarize(peerValues).median,
      peerP25: summarize(peerValues).p25,
      peerP75: summarize(peerValues).p75,
      suppressed: null,
    };

    if (value === null) {
      return { ...base, suppressed: 'no value for this institution in the window' };
    }
    if (n < minSample) {
      return { ...base, suppressed: `only ${n} observations, below the minimum of ${minSample}` };
    }
    if (peerValues.length < minPeers) {
      return { ...base, suppressed: `only ${peerValues.length} comparable peers, below the minimum of ${minPeers}` };
    }
    const pr = percentileRank(value, peerValues);
    const standing = pr.percentile === null ? null : spec.lowerIsBetter ? 1 - pr.percentile : pr.percentile;
    return { ...base, percentile: pr.percentile, standing };
  });

  return {
    window: opts,
    missing,
    cedulaInstitucion: cedula,
    nombre,
    tendersPublished: volume,
    peerSelection: {
      rule: allPeers ? 'all institutions' : bandApplied ? `volume band ${lower} to ${upper} tenders` : 'all institutions (volume band left too few peers)',
      band: bandApplied ? [lower, upper] : null,
      peers: peers.length,
      candidates,
    },
    metrics,
    notes: [
      'standing runs 0 to 1 where 1 is the good end, so the metrics read the same direction',
      'the exception rate here excludes small-value direct contracting, which the pre-2022 law counted as an exception and the current one does not',
      `peers need at least ${minSample} observations on a metric before they count toward its percentile`,
      'payment speed is censored: institutions with unfinished procedures look faster than they are, see the duration report',
      'a good standing here is not a clean bill of health; it means the institution looks like its peers',
    ],
  };
}

/** Full ranking table, for the "who are the outliers nationally" question. */
export interface RankingRow {
  cedulaInstitucion: string;
  nombre: string | null;
  tendersPublished: number;
  value: number | null;
  n: number;
}

export function rankInstitutions(
  db: Db,
  metricKey: string,
  opts: BenchmarkOptions = {},
): { metric: string; label: string; lowerIsBetter: boolean; minSample: number; rows: RankingRow[] } {
  const spec = METRIC_SPECS.find((m) => m.key === metricKey);
  if (!spec) throw new Error(`unknown metric ${metricKey}; expected one of ${METRIC_SPECS.map((m) => m.key).join(', ')}`);
  const minSample = opts.minSample ?? 20;
  const competition = competitionByInstitution(db, {
    from: opts.from,
    to: opts.to,
    month: opts.month,
    minTenders: 1,
  });
  const durations = durationByInstitution(db, {
    from: opts.from,
    to: opts.to,
    month: opts.month,
    minCompleted: 10,
  });
  const rows = [...assemble(competition, durations).values()]
    .filter((r) => spec.n(r) >= minSample && spec.value(r) !== null)
    .map((r) => ({
      cedulaInstitucion: r.cedula,
      nombre: r.nombre,
      tendersPublished: r.tendersPublished,
      value: spec.value(r),
      n: spec.n(r),
    }))
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return { metric: spec.key, label: spec.label, lowerIsBetter: spec.lowerIsBetter, minSample, rows };
}

export const METRIC_KEYS = METRIC_SPECS.map((m) => m.key);
