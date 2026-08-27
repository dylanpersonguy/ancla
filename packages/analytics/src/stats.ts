/**
 * Statistics shared by every screen.
 *
 * Two rules run through this file.
 *
 * First: every function returns its sample size. A median with no n cannot be
 * argued with, and everything here ends up in a public claim about a government.
 *
 * Second: nothing here uses mean or standard deviation on money. Procurement
 * prices are heavy tailed and the tail is often a unit-of-measure error rather
 * than a real price, so one bad row moves a mean and barely moves a median.
 * See prices.ts for what happens when that discipline is dropped.
 */

/** A distribution summarised the way it should be reported: with its n. */
export interface Summary {
  n: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  p75: number | null;
  p90: number | null;
  max: number | null;
  /** Median absolute deviation, scaled so it is comparable to a standard deviation. */
  mad: number | null;
  iqr: number | null;
}

/** Sorted ascending copy with non-finite values dropped. Callers get the count they lost. */
export function clean(values: readonly number[]): { sorted: number[]; dropped: number } {
  const sorted: number[] = [];
  let dropped = 0;
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) sorted.push(v);
    else dropped++;
  }
  sorted.sort((a, b) => a - b);
  return { sorted, dropped };
}

/**
 * Quantile by linear interpolation between order statistics (the R type-7 /
 * numpy default). Named so the definition is checkable: quantile definitions
 * differ by a few percent and that is enough to change a published number.
 */
export function quantileSorted(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (p <= 0) return sorted[0];
  if (p >= 1) return sorted[sorted.length - 1];
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function quantile(values: readonly number[], p: number): number | null {
  return quantileSorted(clean(values).sorted, p);
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/**
 * Median absolute deviation, times 1.4826 so that for normal data it lands on
 * the same scale as a standard deviation. Returns 0 when more than half the
 * values are identical, which is common with catalogue prices and is why the
 * outlier rules in prices.ts need a fallback.
 */
export function mad(values: readonly number[]): number | null {
  const { sorted } = clean(values);
  if (sorted.length === 0) return null;
  const m = quantileSorted(sorted, 0.5) as number;
  const devs = sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b);
  return (quantileSorted(devs, 0.5) as number) * 1.4826;
}

export function summarize(values: readonly number[]): Summary {
  const { sorted } = clean(values);
  const n = sorted.length;
  if (n === 0) {
    return { n: 0, min: null, p25: null, median: null, p75: null, p90: null, max: null, mad: null, iqr: null };
  }
  const p25 = quantileSorted(sorted, 0.25) as number;
  const p75 = quantileSorted(sorted, 0.75) as number;
  return {
    n,
    min: sorted[0],
    p25,
    median: quantileSorted(sorted, 0.5),
    p75,
    p90: quantileSorted(sorted, 0.9),
    max: sorted[n - 1],
    mad: mad(sorted),
    iqr: p75 - p25,
  };
}

/**
 * Herfindahl-Hirschman index on 0..10000, the scale competition authorities use.
 * Below 1500 is unconcentrated, 1500 to 2500 moderate, above 2500 concentrated.
 * Negative and zero shares are dropped: an award of zero value carries no share.
 */
export interface Hhi {
  /** Number of distinct holders that contributed a positive share. */
  n: number;
  hhi: number | null;
  total: number;
  /** Share of the largest holder, 0..1. */
  topShare: number | null;
  /** Effective number of equal-sized competitors, 10000 / hhi. Easier to explain. */
  effectiveCompetitors: number | null;
}

export function hhi(values: readonly number[]): Hhi {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const total = positive.reduce((a, b) => a + b, 0);
  if (positive.length === 0 || total <= 0) {
    return { n: 0, hhi: null, total: 0, topShare: null, effectiveCompetitors: null };
  }
  let sum = 0;
  let top = 0;
  for (const v of positive) {
    const share = v / total;
    sum += share * share;
    if (share > top) top = share;
  }
  const index = sum * 10_000;
  return {
    n: positive.length,
    hhi: index,
    total,
    topShare: top,
    effectiveCompetitors: index > 0 ? 10_000 / index : null,
  };
}

/**
 * Evenness of a split on 0..1, from the normalised HHI. 1 means every holder has
 * an identical share, 0 means one holder has everything. Used by the rotation
 * screen, where an unusually even split of wins across a fixed group is the
 * pattern of interest. Undefined for a single holder, which is reported as 0
 * because one supplier winning everything is not rotation.
 */
export function evenness(
  values: readonly number[],
  /**
   * Number of slots the total could have been spread across. Defaults to the
   * count of positive values. Pass the full group size when zeros are meaningful:
   * a three-member group where one member never wins is not an even split, but
   * dropping the zero would make it look like one.
   */
  slots?: number,
): { n: number; evenness: number | null } {
  const positive = values.filter((v) => Number.isFinite(v) && v > 0);
  const k = Math.max(slots ?? positive.length, positive.length);
  if (positive.length === 0) return { n: 0, evenness: null };
  if (k <= 1) return { n: positive.length, evenness: 0 };
  const total = positive.reduce((a, b) => a + b, 0);
  let sum = 0;
  for (const v of positive) sum += (v / total) ** 2;
  // sum runs from 1/k (perfectly even) to 1 (all in one). Map to 1..0.
  return { n: positive.length, evenness: (1 - sum) / (1 - 1 / k) };
}

/** Coefficient of variation. Only meaningful for strictly positive data. */
export function coefficientOfVariation(values: readonly number[]): { n: number; cv: number | null; mean: number | null } {
  const { sorted } = clean(values);
  const n = sorted.length;
  if (n < 2) return { n, cv: null, mean: n === 1 ? sorted[0] : null };
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  if (mean === 0) return { n, cv: null, mean: 0 };
  const variance = sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { n, cv: Math.sqrt(variance) / Math.abs(mean), mean };
}

/**
 * log(n!) accumulated exactly rather than approximated.
 *
 * Stirling's series was the first attempt here and it failed a hand-checked
 * test: it is off by about 1e-13 at n=4, which is enough to make a small
 * binomial p-value visibly wrong. Summing logarithms is exact to double
 * rounding, and the table is built once and reused.
 */
const LOG_FACTORIAL: number[] = [0, 0];

function logFactorial(n: number): number {
  if (n < 2) return 0;
  for (let i = LOG_FACTORIAL.length; i <= n; i++) {
    LOG_FACTORIAL[i] = LOG_FACTORIAL[i - 1] + Math.log(i);
  }
  return LOG_FACTORIAL[n];
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * One-sided binomial tail, P(X >= k) for X ~ Binomial(n, p).
 *
 * The consistent-losing screen needs this. Supplier A losing to supplier B
 * four times out of four is not evidence of anything: a fair coin does that
 * one time in sixteen. Attaching the tail probability is what stops a screen
 * from becoming an accusation built on small numbers.
 */
export function binomialTailGE(k: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (k <= 0) return 1;
  if (k > n) return 0;
  // Sum the smaller side for numerical sanity, then complement if needed.
  let total = 0;
  for (let i = k; i <= n; i++) {
    total += Math.exp(logChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, Math.max(0, total));
}

/**
 * Bonferroni adjustment. Every pairwise screen tests thousands of pairs, so an
 * unadjusted p-value of 0.001 is expected to appear by chance several times per
 * run. Reporting the adjusted value is the difference between a screen and a
 * false accusation.
 */
export function bonferroni(p: number, tests: number): number {
  return Math.min(1, p * Math.max(1, tests));
}

/** Share as a 0..1 rate, with the counts kept so it can be checked. */
export interface Rate {
  numerator: number;
  denominator: number;
  rate: number | null;
}

export function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null };
}

/**
 * Wilson score interval for a proportion. A single-bidder rate of 100% from two
 * tenders and one from two thousand are not the same claim, and the interval is
 * the cheapest way to keep them apart in the output.
 */
export function wilson(numerator: number, denominator: number, z = 1.96): { low: number; high: number } | null {
  if (denominator <= 0) return null;
  const phat = numerator / denominator;
  const z2 = z * z;
  const denom = 1 + z2 / denominator;
  const centre = phat + z2 / (2 * denominator);
  const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * denominator)) / denominator);
  return { low: Math.max(0, (centre - spread) / denom), high: Math.min(1, (centre + spread) / denom) };
}

/**
 * Percentile rank of a value inside a peer set, 0..1, counting ties as half.
 * Returns null for an empty peer set rather than a misleading 0.5.
 */
export function percentileRank(value: number, peers: readonly number[]): { n: number; percentile: number | null } {
  const usable = peers.filter((v) => Number.isFinite(v));
  if (usable.length === 0) return { n: 0, percentile: null };
  let below = 0;
  let equal = 0;
  for (const p of usable) {
    if (p < value) below++;
    else if (p === value) equal++;
  }
  return { n: usable.length, percentile: (below + equal / 2) / usable.length };
}

/**
 * Kaplan-Meier median for right-censored durations.
 *
 * Used by duration.ts as a second opinion on the completed-only median. Given
 * observed durations and a flag for whether each one ended or is still running,
 * this estimates the median without throwing the unfinished cases away. When
 * more than half the population is still running the median genuinely does not
 * exist yet, and that is reported as reached:false rather than as a number.
 */
export function kaplanMeierMedian(
  observations: readonly { time: number; completed: boolean }[],
): { n: number; events: number; censored: number; median: number | null; reached: boolean } {
  const usable = observations.filter((o) => Number.isFinite(o.time) && o.time >= 0);
  const events = usable.filter((o) => o.completed).length;
  const censored = usable.length - events;
  if (usable.length === 0) return { n: 0, events: 0, censored: 0, median: null, reached: false };

  // Ties: process events before censorings at the same time, the standard convention.
  const ordered = [...usable].sort((a, b) => a.time - b.time || Number(a.completed) - Number(b.completed));
  const times = [...new Set(ordered.filter((o) => o.completed).map((o) => o.time))].sort((a, b) => a - b);

  let survival = 1;
  for (const t of times) {
    const atRisk = ordered.filter((o) => o.time >= t).length;
    const died = ordered.filter((o) => o.completed && o.time === t).length;
    if (atRisk === 0) break;
    survival *= 1 - died / atRisk;
    if (survival <= 0.5) {
      return { n: usable.length, events, censored, median: t, reached: true };
    }
  }
  return { n: usable.length, events, censored, median: null, reached: false };
}
