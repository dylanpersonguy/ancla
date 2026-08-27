/**
 * Competition screens: how many suppliers actually showed up, how often the
 * institution skipped competition entirely, and how concentrated the money is.
 *
 * The single-bidder rate is the primary red flag in the OECD and World Bank
 * procurement integrity literature, and it is the one number here that a
 * non-specialist reads correctly on sight. Everything else in this file exists
 * to stop that number from being read out of context.
 *
 * Three measurement decisions are baked in, each checked against December 2025:
 *
 * 1. A bidder is a distinct cedula_proveedor, not a distinct offer. One supplier
 *    can file several offers on one tender. Counting offers put December 2025 at
 *    38.4% single-bidder; counting suppliers puts it at 43.1%. The supplier count
 *    is the one that answers "did anyone compete".
 *
 * 2. A competition exception is a row with a non-empty des_excepcion. The
 *    cod_excepcion column carries two unrelated code families: legal exception
 *    codes (C0000115 and friends, always paired with a description) and bare
 *    numeric codes with no description at all. Counting any non-empty
 *    cod_excepcion puts December 2025 at 31.3%; counting described exceptions
 *    puts it at 18.7%, which is the defensible figure. The undescribed codes are
 *    reported separately rather than dropped in silence.
 *
 *    Then there is the trap underneath that one, and it is the reason this file
 *    reports two exception rates. Costa Rica replaced the Ley de Contratación
 *    Administrativa with the Ley General de Contratación Pública 9986 on
 *    2022-12-01, and the two laws draw the line in different places. Under the
 *    old law a small-value purchase, "contratación directa por escasa cuantía",
 *    was recorded as a competition exception. Under the new one it is not.
 *
 *    Measured on the index across both eras:
 *
 *      raw exception rate            82.4% before, 20.6% after
 *      excluding escasa cuantía      22.1% before, 20.6% after
 *
 *    The first pair is a headline about a government cutting its use of
 *    competition exceptions by three quarters. It is false. Nothing changed
 *    except which purchases the statute calls an exception. The second pair is
 *    the comparable series and it says the behaviour barely moved.
 *
 *    So: rate is the raw figure, rateExcludingLowValue is the one to put in a
 *    time series or a cross-era comparison, and a window spanning 2022-12-01
 *    carries a warning saying which is which.
 *
 * 3. The deserted rate has a denominator problem. A tender still in "En recepción
 *    de ofertas" has not failed to attract bidders, it has not finished. Both the
 *    all-published rate and the resolved-only rate are reported.
 */

import { query } from '../../core/src/db.ts';
import { type Hhi, hhi, wilson } from './stats.ts';
import { type Db, type Window, LATEST_AWARD_LINES, dateExpr, missingInputs, windowPredicate } from './sql.ts';

/** cartel_stat values that mean the procedure reached an award. */
export const AWARDED_STATUS = [
  'Contrato',
  'Adjudicado',
  'Adjudicación',
  'Acto Final en Firme',
  // Pre-2024 wording for the same thing. The unclassified bucket found this one:
  // 20,890 tenders spanning 2011 to 2023 were sitting outside every denominator.
  'Adjudicación en firme',
  'Finiquitado',
] as const;

/**
 * cartel_stat values that mean the procedure ended without an award.
 *
 * "Desierto" is the institution declaring the tender deserted; "Infructuoso" is
 * no admissible bid arriving. Different administrative acts, same outcome. Some
 * archives publish them as separate values and some publish the single string
 * "Desierto/Infructuoso", so all three appear here.
 *
 * That collapsed value cost this module a wrong number before it was caught: an
 * exact-match list of ['Desierto','Infructuoso'] reported a deserted rate of
 * 0.0% over 26,174 resolved tenders while 1,539 of them were sitting under the
 * combined label. It read like a clean result and it was a classification bug.
 * Hence classifyStatus below, which matches on content, and the unclassified
 * bucket, which makes any future value show itself instead of quietly landing
 * in "still in progress".
 */
export const NO_AWARD_STATUS = ['Desierto', 'Infructuoso', 'Desierto/Infructuoso'] as const;

/** Annulled after the fact. Neither a success nor a failure to attract bidders. */
export const ANNULLED_STATUS = ['Sin efecto', 'Nulidad absoluta'] as const;

/** cartel_stat values that mean the procedure is still running. */
export const IN_PROGRESS_STATUS = [
  'Publicado',
  'En recepción de ofertas',
  'En apertura',
  'En evaluación',
  'Objetado',
  'Apelación o Revocación',
] as const;

export type StatusClass = 'awarded' | 'noAward' | 'annulled' | 'inProgress' | 'unclassified';

/**
 * Bucket a cartel_stat value. Exact matches first, then a content match on the
 * two words that carry the meaning, then unclassified. Unclassified is a real
 * outcome here, not a default: it gets its own count and its values are printed,
 * so a status the Observatorio adds next month cannot silently change a rate.
 */
export function classifyStatus(raw: string | null | undefined): StatusClass {
  const s = (raw ?? '').trim();
  if (!s) return 'unclassified';
  if ((AWARDED_STATUS as readonly string[]).includes(s)) return 'awarded';
  if ((NO_AWARD_STATUS as readonly string[]).includes(s)) return 'noAward';
  if ((ANNULLED_STATUS as readonly string[]).includes(s)) return 'annulled';
  if ((IN_PROGRESS_STATUS as readonly string[]).includes(s)) return 'inProgress';
  const lower = s.toLowerCase();
  if (lower.includes('desierto') || lower.includes('infructuoso')) return 'noAward';
  return 'unclassified';
}

/**
 * The date Ley 9986 took effect. Exception counts before and after are not the
 * same measurement, so anything crossing this date needs the low-value split.
 */
export const LGCP_EFFECTIVE = '2022-12-01';

export type ExceptionFamily = 'low-value-threshold' | 'substantive';

/**
 * Small-value direct contracting versus a substantive exception.
 *
 * "Escasa cuantía" is a spending threshold, not a reason to skip competition:
 * the purchase is too small for a full procedure. Every other reason on the list
 * is a claim that competition was impossible or inappropriate, which is the
 * thing worth measuring. The match is on the phrase because the article and
 * regulation numbers cited alongside it change between the two laws and their
 * successive reglamentos, and there are 98 distinct description strings in the
 * index carrying only a handful of distinct meanings.
 */
export function exceptionFamily(description: string | null | undefined): ExceptionFamily {
  return /escasa\s+cuant/i.test(description ?? '') ? 'low-value-threshold' : 'substantive';
}

export interface CompetitionOptions extends Window {
  /** Cap on the bidder-count histogram before values roll into an N+ bucket. */
  maxBidderBucket?: number;
  /** Currency for the concentration index. Mixed-currency HHI is meaningless. */
  currency?: string;
  /**
   * Scope the bidder counts by the archive that published the BIDS, rather than
   * by the archive that published the tender.
   *
   * These give different answers and both are correct, so the choice has to be
   * made out loud. December 2025 measured either way:
   *
   *   month: '202512'      1,291 tenders with bids, 44.2% single-bidder
   *                        the tenders that archive published, plus every bid on
   *                        them from any archive
   *   bidMonth: '202512'   1,662 tenders with bids, 43.1% single-bidder
   *                        the bids that archive published, on tenders from any
   *                        archive
   *
   * The second is what a single month's Ofertas.csv contains and is the figure a
   * monthly report should quote. The first answers "how much competition did the
   * tenders opened this month attract", which is a longitudinal question and is
   * still accumulating bids.
   */
  bidMonth?: string;
}

export interface BidderCount {
  nroSicop: string;
  cedulaInstitucion: string | null;
  bidders: number;
  offers: number;
}

/** True when the caller constrained anything that lives on the tender row. */
function hasTenderFilter(opts: CompetitionOptions): boolean {
  return Boolean(opts.from || opts.to || opts.month || opts.institution);
}

/**
 * Tenders whose bids exist but whose tender row does not.
 *
 * 11.9% of the distinct tender IDs in the bid table have no matching row in the
 * tender table: 30,800 of 258,420 across the loaded index. The bids were
 * published, the DetalleCarteles row was not. Joining tender to bid therefore
 * throws away one tender in eight, silently, and that showed up as a
 * single-bidder denominator of 1,042 where the December 2025 archive holds
 * 1,662. Whichever way a caller scopes, this number gets reported.
 */
export function orphanBidTenders(db: Db, opts: CompetitionOptions = {}): number {
  const clauses = ['t.nro_sicop IS NULL'];
  const params: unknown[] = [];
  if (opts.bidMonth) {
    clauses.push('b.source_month = ?');
    params.push(opts.bidMonth);
  }
  return (
    query<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT b.nro_sicop) AS n
         FROM bid b
         LEFT JOIN tender t ON t.nro_sicop = b.nro_sicop
        WHERE ${clauses.join(' AND ')}`,
      params,
    )[0]?.n ?? 0
  );
}

/**
 * One row per tender that received at least one bid.
 *
 * With no tender-side filter the query drives from bid and keeps tenders that
 * have no tender row, because their bids are real and excluding them
 * understates competition by whatever share the gap happens to be. With a
 * tender-side filter those rows cannot be tested against it and are excluded;
 * competitionReport reports how many that was.
 */
export function bidderCounts(db: Db, opts: CompetitionOptions = {}): BidderCount[] {
  const w = windowPredicate(db, 'tender', 'fecha_publicacion', opts, {
    institutionCol: 'cedula_institucion',
    alias: 't',
  });
  const filtered = hasTenderFilter(opts);
  const clauses = [filtered ? w.sql : '1=1'];
  const params = filtered ? [...w.params] : [];
  if (opts.bidMonth) {
    clauses.push('b.source_month = ?');
    params.push(opts.bidMonth);
  }
  return query<BidderCount>(
    db,
    `SELECT b.nro_sicop           AS nroSicop,
            t.cedula_institucion  AS cedulaInstitucion,
            COUNT(DISTINCT b.cedula_proveedor) AS bidders,
            COUNT(DISTINCT b.nro_oferta)       AS offers
       FROM bid b
       ${filtered ? 'JOIN' : 'LEFT JOIN'} tender t ON t.nro_sicop = b.nro_sicop
      WHERE ${clauses.join(' AND ')}
        AND b.cedula_proveedor IS NOT NULL
        AND trim(b.cedula_proveedor) <> ''
      GROUP BY b.nro_sicop
      HAVING bidders > 0`,
    params,
  );
}

export interface BidderDistributionBucket {
  /** Number of distinct suppliers, or the floor of the N+ bucket. */
  bidders: number;
  label: string;
  tenders: number;
  share: number;
}

export interface SingleBidder {
  /** Tenders that received at least one bid. The only honest denominator. */
  tendersWithBids: number;
  singleBidder: number;
  rate: number | null;
  /** 95% Wilson interval, so a rate from 12 tenders is not read like one from 12,000. */
  ci95: { low: number; high: number } | null;
}

export interface ExceptionUsage {
  tendersPublished: number;
  withException: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  /** Small-value direct contracting. Only an "exception" under the pre-2022 law. */
  lowValueThreshold: number;
  /** Everything else: a claim that competition was impossible or inappropriate. */
  substantive: number;
  /** The comparable series. Use this one across time or across the 2022 boundary. */
  rateExcludingLowValue: number | null;
  ci95ExcludingLowValue: { low: number; high: number } | null;
  byReason: {
    code: string | null;
    description: string;
    family: ExceptionFamily;
    tenders: number;
    share: number;
  }[];
  /**
   * Rows with a cod_excepcion but no des_excepcion. A different code family,
   * excluded from the rate above. Reported so nobody has to rediscover it.
   */
  undescribedCodes: number;
  /** Tenders published either side of the 2022 legal change, within the window. */
  regime: { beforeLgcp: number; fromLgcp: number };
  warnings: string[];
}

export interface DesertedRate {
  tendersPublished: number;
  awarded: number;
  noAward: number;
  annulled: number;
  inProgress: number;
  /** Statuses this module does not recognise. Kept out of every denominator. */
  unclassified: number;
  unclassifiedStatuses: string[];
  /** noAward over everything published, including tenders still open. */
  rateOfPublished: number | null;
  /** noAward over awarded + noAward. The figure to quote. */
  rateOfResolved: number | null;
  byStatus: { status: string; class: StatusClass; tenders: number }[];
}

export interface Concentration extends Hhi {
  currency: string;
  /** Award lines skipped because they were in another currency. */
  excludedOtherCurrency: number;
  /** Award lines skipped for a missing or non-positive amount. */
  excludedNoAmount: number;
  /**
   * Award lines whose tender has no row in the tender table. Included unless a
   * tender-side filter is active, in which case they could not be tested.
   */
  awardsWithoutTenderRow: number;
  awardsWithoutTenderRowExcluded: boolean;
  top: { cedulaProveedor: string; value: number; share: number; lines: number }[];
}

export interface CompetitionReport {
  window: CompetitionOptions;
  /** Tables the screen needed that had no rows. Non-empty means read nothing below. */
  missing: string[];
  tendersPublished: number;
  singleBidder: SingleBidder;
  bidderDistribution: BidderDistributionBucket[];
  /** Published tenders with no bid rows at all. Not the same as single-bidder. */
  tendersWithoutBidRows: number;
  /**
   * Tenders that have bids but no tender row. Included in the single-bidder rate
   * unless a tender-side filter is active, in which case they could not be tested
   * against it and were excluded.
   */
  bidsWithoutTenderRow: number;
  bidsWithoutTenderRowExcluded: boolean;
  exceptions: ExceptionUsage;
  deserted: DesertedRate;
  concentration: Concentration;
}

export function bidderDistribution(
  counts: readonly BidderCount[],
  maxBucket = 4,
): BidderDistributionBucket[] {
  const total = counts.length;
  const buckets = new Map<number, number>();
  for (const c of counts) {
    const k = Math.min(c.bidders, maxBucket);
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  const out: BidderDistributionBucket[] = [];
  for (let k = 1; k <= maxBucket; k++) {
    const tenders = buckets.get(k) ?? 0;
    out.push({
      bidders: k,
      label: k === maxBucket ? `${k}+` : String(k),
      tenders,
      share: total > 0 ? tenders / total : 0,
    });
  }
  return out;
}

export function singleBidderRate(counts: readonly BidderCount[]): SingleBidder {
  const tendersWithBids = counts.length;
  const single = counts.filter((c) => c.bidders === 1).length;
  return {
    tendersWithBids,
    singleBidder: single,
    rate: tendersWithBids > 0 ? single / tendersWithBids : null,
    ci95: wilson(single, tendersWithBids),
  };
}

export function exceptionUsage(db: Db, opts: CompetitionOptions = {}): ExceptionUsage {
  const w = windowPredicate(db, 'tender', 'fecha_publicacion', opts, {
    institutionCol: 'cedula_institucion',
    alias: 't',
  });
  const total =
    query<{ c: number }>(db, `SELECT COUNT(*) AS c FROM tender t WHERE ${w.sql}`, w.params)[0]?.c ?? 0;

  const rows = query<{ code: string | null; description: string; tenders: number }>(
    db,
    `SELECT t.cod_excepcion AS code,
            trim(t.des_excepcion) AS description,
            COUNT(*) AS tenders
       FROM tender t
      WHERE ${w.sql}
        AND t.des_excepcion IS NOT NULL
        AND trim(t.des_excepcion) <> ''
      GROUP BY t.cod_excepcion, trim(t.des_excepcion)
      ORDER BY tenders DESC, description ASC`,
    w.params,
  );

  const undescribed =
    query<{ c: number }>(
      db,
      `SELECT COUNT(*) AS c
         FROM tender t
        WHERE ${w.sql}
          AND t.cod_excepcion IS NOT NULL AND trim(t.cod_excepcion) <> ''
          AND (t.des_excepcion IS NULL OR trim(t.des_excepcion) = '')`,
      w.params,
    )[0]?.c ?? 0;

  const pubExpr = dateExpr(db, 'tender', 'fecha_publicacion', 't');
  const regime = query<{ beforeLgcp: number; fromLgcp: number }>(
    db,
    `SELECT SUM(CASE WHEN ${pubExpr} < ? THEN 1 ELSE 0 END) AS beforeLgcp,
            SUM(CASE WHEN ${pubExpr} >= ? THEN 1 ELSE 0 END) AS fromLgcp
       FROM tender t
      WHERE ${w.sql}`,
    [LGCP_EFFECTIVE, LGCP_EFFECTIVE, ...w.params],
  )[0] ?? { beforeLgcp: 0, fromLgcp: 0 };

  const byReason = rows.map((r) => ({
    code: r.code,
    description: r.description,
    family: exceptionFamily(r.description),
    tenders: r.tenders,
    share: total > 0 ? r.tenders / total : 0,
  }));

  const withException = rows.reduce((a, r) => a + r.tenders, 0);
  const lowValueThreshold = byReason
    .filter((r) => r.family === 'low-value-threshold')
    .reduce((a, r) => a + r.tenders, 0);
  const substantive = withException - lowValueThreshold;

  const warnings: string[] = [];
  if ((regime.beforeLgcp ?? 0) > 0 && (regime.fromLgcp ?? 0) > 0) {
    warnings.push(
      `this window spans ${LGCP_EFFECTIVE}, when Ley 9986 stopped classifying small-value direct ` +
        'contracting as a competition exception; the raw rate is not comparable across that date, ' +
        'use rateExcludingLowValue',
    );
  }
  if (lowValueThreshold > 0) {
    warnings.push(
      `${lowValueThreshold.toLocaleString('en-US')} of the ${withException.toLocaleString('en-US')} ` +
        'exceptions are small-value direct contracting, which is a spending threshold rather than a ' +
        'reason competition was impossible',
    );
  }

  return {
    tendersPublished: total,
    withException,
    rate: total > 0 ? withException / total : null,
    ci95: wilson(withException, total),
    lowValueThreshold,
    substantive,
    rateExcludingLowValue: total > 0 ? substantive / total : null,
    ci95ExcludingLowValue: wilson(substantive, total),
    byReason,
    undescribedCodes: undescribed,
    regime: { beforeLgcp: regime.beforeLgcp ?? 0, fromLgcp: regime.fromLgcp ?? 0 },
    warnings,
  };
}

export function desertedRate(db: Db, opts: CompetitionOptions = {}): DesertedRate {
  const w = windowPredicate(db, 'tender', 'fecha_publicacion', opts, {
    institutionCol: 'cedula_institucion',
    alias: 't',
  });
  const rows = query<{ status: string | null; tenders: number }>(
    db,
    `SELECT trim(COALESCE(t.cartel_stat,'')) AS status, COUNT(*) AS tenders
       FROM tender t
      WHERE ${w.sql}
      GROUP BY status
      ORDER BY tenders DESC`,
    w.params,
  );

  const totals: Record<StatusClass, number> = {
    awarded: 0,
    noAward: 0,
    annulled: 0,
    inProgress: 0,
    unclassified: 0,
  };
  const byStatus: { status: string; class: StatusClass; tenders: number }[] = [];
  const unclassifiedStatuses: string[] = [];
  for (const r of rows) {
    const s = r.status ?? '';
    const klass = classifyStatus(s);
    byStatus.push({ status: s || '(blank)', class: klass, tenders: r.tenders });
    totals[klass] += r.tenders;
    if (klass === 'unclassified') unclassifiedStatuses.push(s || '(blank)');
  }
  const published =
    totals.awarded + totals.noAward + totals.annulled + totals.inProgress + totals.unclassified;
  const resolved = totals.awarded + totals.noAward;
  return {
    tendersPublished: published,
    awarded: totals.awarded,
    noAward: totals.noAward,
    annulled: totals.annulled,
    inProgress: totals.inProgress,
    unclassified: totals.unclassified,
    unclassifiedStatuses,
    rateOfPublished: published > 0 ? totals.noAward / published : null,
    rateOfResolved: resolved > 0 ? totals.noAward / resolved : null,
    byStatus,
  };
}

/**
 * Concentration of awarded value across suppliers, in one currency.
 *
 * The archives carry an exchange rate per line but the index schema does not
 * store it, so converting here would mean inventing a rate. Instead the screen
 * runs on one currency and says how much it left out. In December 2025 that is
 * about 22% of bid lines sitting in USD and EUR, which is too much to ignore
 * and too much to guess at.
 */
export function concentration(db: Db, opts: CompetitionOptions = {}): Concentration {
  const currency = opts.currency ?? 'CRC';
  const pubExpr = dateExpr(db, 'tender', 'fecha_publicacion', 't');
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
    clauses.push('a.source_month = ?');
    params.push(opts.month);
  }
  if (opts.institution) {
    clauses.push('t.cedula_institucion = ?');
    params.push(opts.institution);
  }
  const where = clauses.join(' AND ');
  // Same gap as the bid table: 16.1% of award lines and 15.1% of awarded value
  // sit on tenders with no tender row. Only a tender-side filter forces them out.
  const needsTender = Boolean(opts.from || opts.to || opts.institution);
  const join = needsTender ? 'JOIN' : 'LEFT JOIN';
  const orphans =
    query<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n
         FROM ${LATEST_AWARD_LINES} a
         LEFT JOIN tender t ON t.nro_sicop = a.nro_sicop
        WHERE t.nro_sicop IS NULL AND a.moneda = ?${opts.month ? ' AND a.source_month = ?' : ''}`,
      opts.month ? [currency, opts.month] : [currency],
    )[0]?.n ?? 0;

  const rows = query<{ cedulaProveedor: string; value: number; lines: number }>(
    db,
    `SELECT a.cedula_proveedor AS cedulaProveedor,
            SUM(a.cantidad * a.precio_unitario) AS value,
            COUNT(*) AS lines
       FROM ${LATEST_AWARD_LINES} a
       ${join} tender t ON t.nro_sicop = a.nro_sicop
      WHERE ${where}
        AND a.moneda = ?
        AND a.cantidad IS NOT NULL AND a.precio_unitario IS NOT NULL
        AND a.cantidad > 0 AND a.precio_unitario > 0
        AND a.cedula_proveedor IS NOT NULL AND trim(a.cedula_proveedor) <> ''
      GROUP BY a.cedula_proveedor`,
    [...params, currency],
  );

  const excluded = query<{ other: number; noAmount: number }>(
    db,
    `SELECT SUM(CASE WHEN a.moneda IS NOT ? THEN 1 ELSE 0 END) AS other,
            SUM(CASE WHEN a.moneda IS ? AND (a.cantidad IS NULL OR a.precio_unitario IS NULL
                       OR a.cantidad <= 0 OR a.precio_unitario <= 0) THEN 1 ELSE 0 END) AS noAmount
       FROM ${LATEST_AWARD_LINES} a
       ${join} tender t ON t.nro_sicop = a.nro_sicop
      WHERE ${where}`,
    [currency, currency, ...params],
  )[0] ?? { other: 0, noAmount: 0 };

  const index = hhi(rows.map((r) => r.value));
  const total = index.total;
  const top = [...rows]
    .sort((a, b) => b.value - a.value)
    .slice(0, 10)
    .map((r) => ({
      cedulaProveedor: r.cedulaProveedor,
      value: r.value,
      share: total > 0 ? r.value / total : 0,
      lines: r.lines,
    }));

  return {
    ...index,
    currency,
    excludedOtherCurrency: excluded.other ?? 0,
    excludedNoAmount: excluded.noAmount ?? 0,
    awardsWithoutTenderRow: orphans,
    awardsWithoutTenderRowExcluded: needsTender,
    top,
  };
}

export function competitionReport(db: Db, opts: CompetitionOptions = {}): CompetitionReport {
  const missing = missingInputs(db, ['tender', 'bid']);
  const blocked = missing.includes('tender') || missing.includes('bid');
  const counts = blocked ? [] : bidderCounts(db, opts);
  const deserted = desertedRate(db, opts);
  const exceptions = exceptionUsage(db, opts);
  const orphans = blocked ? 0 : orphanBidTenders(db, opts);
  const filtered = hasTenderFilter(opts);
  // With orphans in the count, "tenders with bids" can exceed the published total,
  // so the no-bids figure is only meaningful against the joined subset.
  const joined = filtered ? counts.length : Math.max(0, counts.length - orphans);
  return {
    window: opts,
    missing,
    tendersPublished: deserted.tendersPublished,
    singleBidder: singleBidderRate(counts),
    bidderDistribution: bidderDistribution(counts, opts.maxBidderBucket ?? 4),
    tendersWithoutBidRows: Math.max(0, deserted.tendersPublished - joined),
    bidsWithoutTenderRow: orphans,
    bidsWithoutTenderRowExcluded: filtered,
    exceptions,
    deserted,
    concentration: concentration(db, opts),
  };
}

/**
 * Per-institution table, for ranking. Institutions below minTenders are dropped
 * rather than ranked: a 100% single-bidder rate from three tenders is noise, and
 * publishing it next to a real one invites the wrong comparison.
 */
export interface InstitutionCompetition {
  cedulaInstitucion: string;
  nombre: string | null;
  tendersPublished: number;
  tendersWithBids: number;
  singleBidder: number;
  singleBidderRate: number | null;
  /** All described exceptions, small-value direct contracting included. */
  exceptionTenders: number;
  exceptionRate: number | null;
  /** Excluding small-value direct contracting. The rate to compare across time. */
  substantiveExceptions: number;
  substantiveExceptionRate: number | null;
  noAward: number;
  desertedRateOfResolved: number | null;
}

export function competitionByInstitution(
  db: Db,
  opts: CompetitionOptions & { minTenders?: number } = {},
): InstitutionCompetition[] {
  const minTenders = opts.minTenders ?? 20;
  const w = windowPredicate(db, 'tender', 'fecha_publicacion', opts, {
    institutionCol: 'cedula_institucion',
    alias: 't',
  });
  const awarded = AWARDED_STATUS.map(() => '?').join(',');
  const noAward = NO_AWARD_STATUS.map(() => '?').join(',');
  // The LIKE arm mirrors the content match in classifyStatus, so a combined or
  // reworded value cannot land this table and desertedRate on different answers.
  const noAwardSql =
    `(trim(COALESCE(s.cartel_stat,'')) IN (${noAward})` +
    " OR lower(COALESCE(s.cartel_stat,'')) LIKE '%desierto%'" +
    " OR lower(COALESCE(s.cartel_stat,'')) LIKE '%infructuoso%')";
  const resolvedSql = `(trim(COALESCE(s.cartel_stat,'')) IN (${awarded}) OR ${noAwardSql})`;

  const rows = query<InstitutionCompetition & { resolved: number }>(
    db,
    `WITH scoped AS (
        SELECT t.nro_sicop, t.cedula_institucion, t.cartel_stat, t.des_excepcion
          FROM tender t
         WHERE ${w.sql}
     ), bids AS (
        SELECT s.nro_sicop, s.cedula_institucion,
               COUNT(DISTINCT b.cedula_proveedor) AS bidders
          FROM scoped s
          JOIN bid b ON b.nro_sicop = s.nro_sicop
         WHERE b.cedula_proveedor IS NOT NULL AND trim(b.cedula_proveedor) <> ''
         GROUP BY s.nro_sicop
     )
     SELECT s.cedula_institucion AS cedulaInstitucion,
            i.nombre             AS nombre,
            COUNT(*)             AS tendersPublished,
            SUM(CASE WHEN b.bidders IS NOT NULL THEN 1 ELSE 0 END) AS tendersWithBids,
            SUM(CASE WHEN b.bidders = 1 THEN 1 ELSE 0 END)         AS singleBidder,
            SUM(CASE WHEN s.des_excepcion IS NOT NULL AND trim(s.des_excepcion) <> ''
                     THEN 1 ELSE 0 END)                            AS exceptionTenders,
            SUM(CASE WHEN s.des_excepcion IS NOT NULL
                      AND trim(s.des_excepcion) <> ''
                      AND lower(s.des_excepcion) NOT LIKE '%escasa cuant%'
                     THEN 1 ELSE 0 END)                            AS substantiveExceptions,
            SUM(CASE WHEN ${noAwardSql} THEN 1 ELSE 0 END)                 AS noAward,
            SUM(CASE WHEN ${resolvedSql} THEN 1 ELSE 0 END)                 AS resolved
       FROM scoped s
       LEFT JOIN bids b       ON b.nro_sicop = s.nro_sicop
       LEFT JOIN institution i ON i.cedula = s.cedula_institucion
      GROUP BY s.cedula_institucion
      HAVING tendersPublished >= ?
      ORDER BY tendersPublished DESC`,
    [...w.params, ...NO_AWARD_STATUS, ...AWARDED_STATUS, ...NO_AWARD_STATUS, minTenders],
  );

  return rows.map((r) => ({
    cedulaInstitucion: r.cedulaInstitucion,
    nombre: r.nombre,
    tendersPublished: r.tendersPublished,
    tendersWithBids: r.tendersWithBids,
    singleBidder: r.singleBidder,
    singleBidderRate: r.tendersWithBids > 0 ? r.singleBidder / r.tendersWithBids : null,
    exceptionTenders: r.exceptionTenders,
    exceptionRate: r.tendersPublished > 0 ? r.exceptionTenders / r.tendersPublished : null,
    substantiveExceptions: r.substantiveExceptions,
    substantiveExceptionRate:
      r.tendersPublished > 0 ? r.substantiveExceptions / r.tendersPublished : null,
    noAward: r.noAward,
    desertedRateOfResolved: r.resolved > 0 ? r.noAward / r.resolved : null,
  }));
}
