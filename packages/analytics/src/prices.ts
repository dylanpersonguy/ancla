/**
 * Unit price benchmarking by codigo_producto.
 *
 * This module is written defensively because the naive version of it produces a
 * headline that is completely false. Run min-to-max on a product code in this
 * data and you get spreads in the millions. The real example: 5,182,119x on one
 * code. That is not corruption. It is a unit-of-measure artifact.
 *
 * The reason is structural. The archives publish cantidad and precio_unitario
 * but never publish what the unit is. One buyer records 1,000 gloves at 200
 * colones each, another records 1 box of 1,000 gloves at 200,000 colones each.
 * Same purchase, same product code, a 1,000x apparent price difference. A
 * procurement code is a catalogue classification, not a SKU, so codes also cover
 * families of goods at genuinely different price points.
 *
 * The rules that follow from that:
 *
 *   one currency at a time     mixing CRC and USD on a code multiplies every
 *                              price by roughly 500 at random
 *   a minimum sample           a median of three purchases is an anecdote
 *   median and MAD or IQR      never mean and stddev; one bad row moves a mean
 *   the interquartile range    not min to max, which is a report on the two
 *                              worst rows in the file
 *   an explicit heterogeneity  when the middle half of purchases spans more than
 *   flag                       an order of magnitude, the code is not one product
 *                              and no comparison from it is usable
 *
 * A code that fails the heterogeneity test returns usable:false and no outliers.
 * Refusing to answer is a valid output here. A defensible number beats a
 * shocking one, and on this dataset the shocking ones are nearly all artifacts.
 */

import { query } from '../../core/src/db.ts';
import { type Summary, mad, quantileSorted, summarize } from './stats.ts';
import { type Db, type Window, LATEST_AWARD_LINES, dateExpr, missingInputs } from './sql.ts';

export type PriceSource = 'award' | 'bid';

export interface PriceOptions extends Window {
  /** Which table to price from. Awards are what was actually paid for. */
  source?: PriceSource;
  /** Single currency. Default CRC, the majority currency in this data. */
  currency?: string;
  /** Below this, no statistics are produced at all. */
  minSample?: number;
  /** p75/p25 above this marks the code heterogeneous and unusable. */
  maxIqrRatio?: number;
  /** max/min above this marks the code unusable regardless of the IQR. */
  maxSpreadRatio?: number;
  /**
   * Share of rows at quantity 1 above which a widely dispersed code is treated
   * as lump-sum rather than unit-priced. See the lump-sum guard below.
   */
  lumpSumQuantityShare?: number;
  /**
   * A purchase must be at least this many times the median before it is listed,
   * on top of clearing the statistical fence. Statistical significance is not
   * practical significance: on a tight code the fence can sit 15% above the
   * median, and a 15% price difference between two suppliers is a Tuesday.
   */
  minRatioToMedian?: number;
}

export const PRICE_DEFAULTS = {
  source: 'award' as PriceSource,
  currency: 'CRC',
  minSample: 10,
  /**
   * The middle half of purchases spanning more than 10x means the code covers
   * more than one thing, or more than one unit of measure. Either way a
   * per-purchase comparison against the median is not defensible.
   */
  maxIqrRatio: 10,
  /**
   * Even with a tight middle, a 1000x full range is the unit-of-measure
   * signature. Ten-fold quantity packaging steps compound quickly.
   */
  maxSpreadRatio: 1000,
  /**
   * Half again the median. Below this a gap is ordinary supplier variation and
   * listing it buries the purchases that are actually worth a look.
   */
  minRatioToMedian: 1.5,
  /**
   * Four purchases in five at quantity 1. Combined with wide dispersion this is
   * the signature of a lump-sum contract rather than a unit rate.
   */
  lumpSumQuantityShare: 0.8,
};

export type Dispersion = 'tight' | 'moderate' | 'wide' | 'extreme';

export interface PricePoint {
  nroSicop: string;
  nroLinea: string;
  cedulaProveedor: string | null;
  cedulaInstitucion: string | null;
  codigoProducto: string;
  cantidad: number;
  unitPrice: number;
  moneda: string;
  fecha: string | null;
}

/**
 * Which dispersion measure the outlier fence was built from.
 *
 *   mad        the usual case: 0.6745*(x - median)/MAD, cutoff 3.5
 *   mean-ad    MAD is zero because over half the purchases sit at one catalogue
 *              price. Iglewicz and Hoaglin's own fallback substitutes the mean
 *              absolute deviation scaled by 1.253314
 *   identical  every purchase is at the same price, so there is nothing to flag
 */
export type OutlierRule = 'mad' | 'mean-ad' | 'identical';

export interface PriceOutlier extends PricePoint {
  /** unitPrice / median. Above 1 means paid more than the middle of the market. */
  ratioToMedian: number;
  /** Modified z-score. The Iglewicz-Hoaglin statistic, cutoff 3.5. */
  modifiedZ: number;
  /** Extra spent against the median unit price, in the benchmark currency. */
  excessValue: number;
  rule: OutlierRule;
}

export interface PriceBenchmark {
  codigoProducto: string;
  currency: string;
  source: PriceSource;
  /** Rows that made it into the statistics. */
  n: number;
  /** Rows dropped, with the reason, so the sample is reconstructible. */
  excluded: { otherCurrency: number; nonPositive: number; missing: number };
  /** null below minSample. */
  stats: Summary | null;
  /** p75/p25. The dispersion measure to quote; scale free and outlier resistant. */
  iqrRatio: number | null;
  /** max/min. Reported for completeness, never as a headline. */
  spreadRatio: number | null;
  /** IQR / (p75 + p25). Quartile coefficient of dispersion, 0..1. */
  quartileDispersion: number | null;
  dispersion: Dispersion | null;
  /**
   * false means: not enough rows, or the code is too heterogeneous to compare
   * within. No outlier from an unusable code should ever be published.
   */
  usable: boolean;
  reason: string | null;
  /** How many distinct powers of ten hold at least 5% of the sample. 3+ is multimodal. */
  magnitudeBuckets: number;
  /** Decades from the lowest populated power of ten to the highest. 2+ is two markets. */
  magnitudeSpan: number;
  /** Share of rows bought at quantity 1. High plus wide dispersion means lump sum. */
  quantityOneShare: number;
  outliers: PriceOutlier[];
  outlierRule: OutlierRule | null;
  /** Wording a reader can paste, already hedged. */
  caveat: string;
}

const UNIT_CAVEAT =
  'codigo_producto is a catalogue classification and the source data never publishes the unit of measure, ' +
  'so a price gap on a single code can be packaging, or a lump-sum contract total, rather than price';

function priceRows(db: Db, codigoProducto: string, opts: PriceOptions): {
  rows: PricePoint[];
  excluded: { otherCurrency: number; nonPositive: number; missing: number };
} {
  const source = opts.source ?? PRICE_DEFAULTS.source;
  const currency = opts.currency ?? PRICE_DEFAULTS.currency;
  // Money and prices always read the deduplicated award view. See sql.ts.
  const table = source === 'award' ? LATEST_AWARD_LINES : 'bid_line';
  const pubExpr = dateExpr(db, 'tender', 'fecha_publicacion', 't');

  const clauses = ['l.codigo_producto = ?'];
  const params: unknown[] = [codigoProducto];
  if (opts.from) {
    clauses.push(`${pubExpr} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`${pubExpr} <= ?`);
    params.push(opts.to);
  }
  if (opts.month) {
    clauses.push('l.source_month = ?');
    params.push(opts.month);
  }
  if (opts.institution) {
    clauses.push('t.cedula_institucion = ?');
    params.push(opts.institution);
  }
  const where = clauses.join(' AND ');

  // bid_line has no supplier column of its own; it comes through the offer.
  const supplierExpr =
    source === 'award' ? 'l.cedula_proveedor' : '(SELECT b.cedula_proveedor FROM bid b WHERE b.nro_sicop = l.nro_sicop AND b.nro_oferta = l.nro_oferta)';

  const rows = query<PricePoint>(
    db,
    `SELECT l.nro_sicop        AS nroSicop,
            l.nro_linea        AS nroLinea,
            ${supplierExpr}    AS cedulaProveedor,
            t.cedula_institucion AS cedulaInstitucion,
            l.codigo_producto  AS codigoProducto,
            l.cantidad         AS cantidad,
            l.precio_unitario  AS unitPrice,
            l.moneda           AS moneda,
            ${pubExpr}         AS fecha
       FROM ${table} l
       LEFT JOIN tender t ON t.nro_sicop = l.nro_sicop
      WHERE ${where}
        AND l.moneda = ?
        AND l.precio_unitario IS NOT NULL AND l.precio_unitario > 0
        AND l.cantidad IS NOT NULL AND l.cantidad > 0`,
    [...params, currency],
  );

  const counts = query<{ otherCurrency: number; nonPositive: number; missing: number }>(
    db,
    `SELECT SUM(CASE WHEN l.moneda IS NOT ? THEN 1 ELSE 0 END) AS otherCurrency,
            SUM(CASE WHEN l.moneda IS ? AND (l.precio_unitario <= 0 OR l.cantidad <= 0) THEN 1 ELSE 0 END) AS nonPositive,
            SUM(CASE WHEN l.moneda IS ? AND (l.precio_unitario IS NULL OR l.cantidad IS NULL) THEN 1 ELSE 0 END) AS missing
       FROM ${table} l
       LEFT JOIN tender t ON t.nro_sicop = l.nro_sicop
      WHERE ${where}`,
    [currency, currency, currency, ...params],
  )[0];

  return {
    rows,
    excluded: {
      otherCurrency: counts?.otherCurrency ?? 0,
      nonPositive: counts?.nonPositive ?? 0,
      missing: counts?.missing ?? 0,
    },
  };
}

/**
 * Where the sample's mass sits on a log10 scale.
 *
 * `populated` counts the powers of ten holding at least minShare of the
 * purchases. `span` is the distance from the lowest such decade to the highest.
 *
 * Both are needed and they catch different things. Two populated decades mean
 * nothing on their own, because a price band from 800 to 1,200 straddles a
 * decade boundary; that is span 1 and it is fine. Two populated decades three
 * apart is a different animal: on real data a works code sat with eleven
 * purchases around 79,000 colones and two around 27 million, which is a tight
 * interquartile ratio, a full range just under the spread limit, and two
 * populated decades. Every individual guard let it through and the price band
 * was still measuring two different things. The span catches it.
 */
export function magnitudeSpread(
  prices: readonly number[],
  minShare = 0.05,
): { populated: number; span: number } {
  if (prices.length === 0) return { populated: 0, span: 0 };
  const buckets = new Map<number, number>();
  for (const p of prices) {
    if (!(p > 0)) continue;
    const decade = Math.floor(Math.log10(p));
    buckets.set(decade, (buckets.get(decade) ?? 0) + 1);
  }
  const decades = [...buckets.entries()]
    .filter(([, count]) => count / prices.length >= minShare)
    .map(([decade]) => decade)
    .sort((a, b) => a - b);
  if (decades.length === 0) return { populated: 0, span: 0 };
  return { populated: decades.length, span: decades[decades.length - 1] - decades[0] };
}

function classify(iqrRatio: number | null): Dispersion | null {
  if (iqrRatio === null || !Number.isFinite(iqrRatio)) return null;
  if (iqrRatio <= 1.5) return 'tight';
  if (iqrRatio <= 3) return 'moderate';
  if (iqrRatio <= 10) return 'wide';
  return 'extreme';
}

export function benchmarkProduct(db: Db, codigoProducto: string, opts: PriceOptions = {}): PriceBenchmark {
  const source = opts.source ?? PRICE_DEFAULTS.source;
  const currency = opts.currency ?? PRICE_DEFAULTS.currency;
  const minSample = opts.minSample ?? PRICE_DEFAULTS.minSample;
  const maxIqrRatio = opts.maxIqrRatio ?? PRICE_DEFAULTS.maxIqrRatio;
  const maxSpreadRatio = opts.maxSpreadRatio ?? PRICE_DEFAULTS.maxSpreadRatio;
  const minRatioToMedian = opts.minRatioToMedian ?? PRICE_DEFAULTS.minRatioToMedian;
  const lumpSumShare = opts.lumpSumQuantityShare ?? PRICE_DEFAULTS.lumpSumQuantityShare;

  const { rows, excluded } = priceRows(db, codigoProducto, opts);
  const prices = rows.map((r) => r.unitPrice);
  const sorted = [...prices].sort((a, b) => a - b);
  const n = sorted.length;
  const magnitude = magnitudeSpread(sorted);

  const base: PriceBenchmark = {
    codigoProducto,
    currency,
    source,
    n,
    excluded,
    stats: null,
    iqrRatio: null,
    spreadRatio: null,
    quartileDispersion: null,
    dispersion: null,
    usable: false,
    reason: null,
    magnitudeBuckets: magnitude.populated,
    magnitudeSpan: magnitude.span,
    quantityOneShare: n > 0 ? rows.filter((r) => r.cantidad === 1).length / n : 0,
    outliers: [],
    outlierRule: null,
    caveat: UNIT_CAVEAT,
  };

  if (n < minSample) {
    return { ...base, reason: `only ${n} usable ${currency} rows, below the minimum sample of ${minSample}` };
  }

  const stats = summarize(sorted);
  const p25 = stats.p25 as number;
  const p75 = stats.p75 as number;
  const min = stats.min as number;
  const max = stats.max as number;
  const iqrRatio = p25 > 0 ? p75 / p25 : null;
  const spreadRatio = min > 0 ? max / min : null;
  const quartileDispersion = p75 + p25 > 0 ? (p75 - p25) / (p75 + p25) : null;
  const dispersion = classify(iqrRatio);

  const withStats: PriceBenchmark = {
    ...base,
    stats,
    iqrRatio,
    spreadRatio,
    quartileDispersion,
    dispersion,
  };

  if (iqrRatio !== null && iqrRatio > maxIqrRatio) {
    return {
      ...withStats,
      reason:
        `interquartile ratio ${iqrRatio.toFixed(1)}x exceeds ${maxIqrRatio}x: the middle half of purchases spans ` +
        'more than an order of magnitude, so this code is not one homogeneous product and no per-purchase comparison holds',
    };
  }
  if (spreadRatio !== null && spreadRatio > maxSpreadRatio) {
    return {
      ...withStats,
      reason:
        `full range ${spreadRatio.toExponential(2)}x exceeds ${maxSpreadRatio}x: the signature of mixed units of ` +
        'measure rather than a price difference',
    };
  }
  if (withStats.magnitudeBuckets >= 3) {
    return {
      ...withStats,
      reason:
        `prices cluster in ${withStats.magnitudeBuckets} separate powers of ten, which is a packaging or unit split ` +
        'rather than one market',
    };
  }
  if (withStats.magnitudeSpan >= 2) {
    return {
      ...withStats,
      reason:
        `the populated price levels sit ${withStats.magnitudeSpan} powers of ten apart, so the sample holds at ` +
        'least two different things under one code',
    };
  }
  /**
   * Lump-sum guard.
   *
   * Construction and service codes are recorded as one unit at the price of the
   * whole job, so precio_unitario is a contract total rather than a rate. On real
   * data this was the largest remaining source of false outliers: a works code
   * where every purchase is quantity 1 and prices run from 624 thousand to 365
   * million colones is measuring the size of the building, not the price of
   * anything. Quantity 1 on its own is fine, since plenty of codes are genuinely
   * one-per-purchase items; quantity 1 across the board plus a wide spread is not.
   */
  if (
    withStats.quantityOneShare >= lumpSumShare &&
    (dispersion === 'wide' || dispersion === 'extreme')
  ) {
    return {
      ...withStats,
      reason:
        `${(withStats.quantityOneShare * 100).toFixed(0)}% of purchases are a single unit and prices spread ` +
        `${iqrRatio === null ? '' : `${iqrRatio.toFixed(1)}x `}across the middle half: this reads as lump-sum ` +
        'contract totals rather than a unit rate, so comparing purchases compares job sizes',
    };
  }

  // Passed the guards. Now, and only now, look for individual outliers.
  const { fence, rule, z } = outlierFence(sorted);
  const outliers: PriceOutlier[] = [];
  const medianPrice = stats.median as number;

  if (fence !== null) {
    for (const r of rows) {
      // Both bars: past the statistical fence and materially above the median.
      if (r.unitPrice <= fence) continue;
      if (r.unitPrice < medianPrice * minRatioToMedian) continue;
      outliers.push({
        ...r,
        ratioToMedian: r.unitPrice / medianPrice,
        modifiedZ: z(r.unitPrice),
        excessValue: (r.unitPrice - medianPrice) * r.cantidad,
        rule,
      });
    }
    outliers.sort((a, b) => b.excessValue - a.excessValue);
  }

  return { ...withStats, usable: true, outliers, outlierRule: rule };
}

export interface PriceScanOptions extends PriceOptions {
  /** Product codes to examine, most-purchased first. */
  limit?: number;
  /** Cap on outliers kept per code. */
  perCode?: number;
}

export interface PriceScan {
  window: PriceScanOptions;
  missing: string[];
  currency: string;
  source: PriceSource;
  codesExamined: number;
  codesUsable: number;
  codesRejected: { codigoProducto: string; n: number; reason: string }[];
  outliers: PriceOutlier[];
  caveat: string;
}

/**
 * Scan the most-purchased product codes and return outliers only from codes that
 * survived the guards. Rejected codes are listed with their reason, because a
 * reader needs to know how much of the catalogue this method cannot speak to.
 * On real data the rejected list is long, and that is the finding.
 */
export function scanPrices(db: Db, opts: PriceScanOptions = {}): PriceScan {
  const source = opts.source ?? PRICE_DEFAULTS.source;
  const currency = opts.currency ?? PRICE_DEFAULTS.currency;
  const minSample = opts.minSample ?? PRICE_DEFAULTS.minSample;
  const limit = opts.limit ?? 50;
  const perCode = opts.perCode ?? 5;
  const sourceTable = source === 'award' ? 'award_line' : 'bid_line';
  const table = source === 'award' ? LATEST_AWARD_LINES : 'bid_line';
  const missing = missingInputs(db, [sourceTable]);
  if (missing.length) {
    return {
      window: opts,
      missing,
      currency,
      source,
      codesExamined: 0,
      codesUsable: 0,
      codesRejected: [],
      outliers: [],
      caveat: UNIT_CAVEAT,
    };
  }

  const clauses = ['l.codigo_producto IS NOT NULL', "trim(l.codigo_producto) <> ''", 'l.moneda = ?'];
  const params: unknown[] = [currency];
  if (opts.month) {
    clauses.push('l.source_month = ?');
    params.push(opts.month);
  }

  const codes = query<{ codigoProducto: string; n: number }>(
    db,
    `SELECT l.codigo_producto AS codigoProducto, COUNT(*) AS n
       FROM ${table} l
      WHERE ${clauses.join(' AND ')}
        AND l.precio_unitario > 0 AND l.cantidad > 0
      GROUP BY l.codigo_producto
      HAVING n >= ?
      ORDER BY n DESC
      LIMIT ?`,
    [...params, minSample, limit],
  );

  const rejected: { codigoProducto: string; n: number; reason: string }[] = [];
  const outliers: PriceOutlier[] = [];
  let usable = 0;

  for (const c of codes) {
    const bench = benchmarkProduct(db, c.codigoProducto, opts);
    if (!bench.usable) {
      rejected.push({ codigoProducto: c.codigoProducto, n: bench.n, reason: bench.reason ?? 'unknown' });
      continue;
    }
    usable++;
    outliers.push(...bench.outliers.slice(0, perCode));
  }
  outliers.sort((a, b) => b.excessValue - a.excessValue);

  return {
    window: opts,
    missing,
    currency,
    source,
    codesExamined: codes.length,
    codesUsable: usable,
    codesRejected: rejected,
    outliers,
    caveat: UNIT_CAVEAT,
  };
}

/**
 * Upper outlier fence and the score behind it. Exported so a caller can check
 * the rule without going through the database.
 *
 * The MAD path is the Iglewicz-Hoaglin modified z-score with the standard 3.5
 * cutoff. The mean-absolute-deviation path is the fallback those same authors
 * give for a zero MAD, which happens whenever more than half the purchases sit
 * at one catalogue price. Scaling by 1.253314 puts it on the MAD scale.
 *
 * A Tukey IQR fence was the first fallback written here and it was wrong: when
 * the MAD is zero the IQR is usually zero too, the fence collapses onto the
 * median, and every purchase one colon above the modal price becomes an
 * "outlier". That is a screen that fires on everything, which is a screen that
 * is worth nothing.
 */
export function outlierFence(prices: readonly number[]): {
  fence: number | null;
  rule: OutlierRule;
  z: (price: number) => number;
} {
  const sorted = [...prices].filter((p) => Number.isFinite(p)).sort((a, b) => a - b);
  if (sorted.length === 0) return { fence: null, rule: 'identical', z: () => 0 };
  const centre = quantileSorted(sorted, 0.5) as number;
  const madValue = mad(sorted) as number;
  if (madValue > 0) {
    return {
      fence: centre + (3.5 * madValue) / 0.6745,
      rule: 'mad',
      z: (price) => (0.6745 * (price - centre)) / madValue,
    };
  }
  const meanAd = sorted.reduce((a, v) => a + Math.abs(v - centre), 0) / sorted.length;
  if (meanAd > 0) {
    const scale = 1.253314 * meanAd;
    return {
      fence: centre + 3.5 * scale,
      rule: 'mean-ad',
      z: (price) => (price - centre) / scale,
    };
  }
  // Every purchase is at the same price. There is nothing to flag.
  return { fence: null, rule: 'identical', z: () => 0 };
}
