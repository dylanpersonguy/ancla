import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  binomialTailGE,
  bonferroni,
  coefficientOfVariation,
  evenness,
  hhi,
  kaplanMeierMedian,
  mad,
  median,
  percentileRank,
  quantile,
  summarize,
  wilson,
} from '../src/stats.ts';

test('median of an odd sample is the middle value', () => {
  assert.equal(median([3, 1, 2]), 2);
});

test('median of an even sample interpolates', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('quantile follows the type-7 definition', () => {
  // 1..5, p=0.25: h = 4*0.25 = 1, exactly the second order statistic.
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  // 1..4, p=0.25: h = 3*0.25 = 0.75, three quarters between 1 and 2.
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 3.7);
});

test('quantile of an empty sample is null, not zero', () => {
  assert.equal(quantile([], 0.5), null);
  assert.equal(median([]), null);
});

test('summarize reports n and drops non-finite values', () => {
  const s = summarize([1, 2, Number.NaN, 3, Number.POSITIVE_INFINITY]);
  assert.equal(s.n, 3);
  assert.equal(s.median, 2);
  assert.equal(s.min, 1);
  assert.equal(s.max, 3);
});

test('mad is scaled to standard-deviation units', () => {
  // Deviations from the median of 3 are 2,1,0,1,2; their median is 1.
  assert.equal(mad([1, 2, 3, 4, 5]), 1.4826);
});

test('mad is zero when over half the values are identical', () => {
  // This is why prices.ts needs a Tukey fallback.
  assert.equal(mad([5, 5, 5, 5, 9]), 0);
});

test('hhi of a monopoly is 10000 and of four equal holders is 2500', () => {
  assert.equal(hhi([100]).hhi, 10_000);
  const four = hhi([25, 25, 25, 25]);
  assert.equal(four.hhi, 2500);
  assert.equal(four.n, 4);
  assert.equal(four.effectiveCompetitors, 4);
  assert.equal(four.topShare, 0.25);
});

test('hhi ignores zero and negative values and reports an empty sample as null', () => {
  assert.equal(hhi([0, -5]).hhi, null);
  assert.equal(hhi([]).n, 0);
});

test('evenness is 1 for a perfectly even split and 0 for a monopoly', () => {
  assert.equal(evenness([5, 5, 5]).evenness, 1);
  assert.equal(evenness([5]).evenness, 0);
  // Two winners out of a three-member group is not a fully even rotation.
  const partial = evenness([4, 4, 0], 3).evenness as number;
  assert.ok(partial > 0.7 && partial < 0.8, `expected ~0.75, got ${partial}`);
});

test('binomial tail matches hand-computed values', () => {
  // A fair coin: 5 heads in 5 is 1/32.
  assert.ok(Math.abs(binomialTailGE(5, 5, 0.5) - 1 / 32) < 1e-12);
  // 4 or more heads in 4 is 1/16.
  assert.ok(Math.abs(binomialTailGE(4, 4, 0.5) - 1 / 16) < 1e-12);
  // 3 or more in 4 is (4+1)/16.
  assert.ok(Math.abs(binomialTailGE(3, 4, 0.5) - 5 / 16) < 1e-12);
  // Zero or more is certain.
  assert.equal(binomialTailGE(0, 10, 0.5), 1);
});

test('bonferroni multiplies by the number of tests and caps at 1', () => {
  assert.equal(bonferroni(0.01, 10), 0.1);
  assert.equal(bonferroni(0.5, 100), 1);
  assert.equal(bonferroni(0.02, 0), 0.02);
});

test('a five-loss streak is not significant once thousands of pairs are tested', () => {
  // The reason the consistent-losing screen adjusts. Raw p is 0.031.
  const raw = binomialTailGE(5, 5, 0.5);
  assert.ok(raw < 0.05);
  assert.equal(bonferroni(raw, 2000), 1);
});

test('wilson interval narrows with sample size', () => {
  const small = wilson(2, 2) as { low: number; high: number };
  const large = wilson(2000, 2000) as { low: number; high: number };
  assert.ok(small.low < 0.4, `expected a wide interval, got ${small.low}`);
  assert.ok(large.low > 0.99);
  assert.equal(wilson(1, 0), null);
});

test('percentile rank counts ties as half', () => {
  assert.deepEqual(percentileRank(5, [1, 2, 3, 4]), { n: 4, percentile: 1 });
  assert.deepEqual(percentileRank(0, [1, 2, 3, 4]), { n: 4, percentile: 0 });
  assert.deepEqual(percentileRank(2, [1, 2, 3, 4]), { n: 4, percentile: 0.375 });
  assert.equal(percentileRank(1, []).percentile, null);
});

test('coefficient of variation is zero for identical values', () => {
  assert.equal(coefficientOfVariation([5, 5, 5, 5]).cv, 0);
  assert.equal(coefficientOfVariation([5]).cv, null);
});

test('kaplan-meier equals the plain median when nothing is censored', () => {
  const obs = [10, 20, 30, 40, 50].map((t) => ({ time: t, completed: true }));
  const km = kaplanMeierMedian(obs);
  assert.equal(km.median, 30);
  assert.equal(km.reached, true);
  assert.equal(km.censored, 0);
});

test('kaplan-meier refuses a median when most cases are still running', () => {
  // Two finished at 10 and 20; eight still open at 35 days and counting.
  // Survival falls to 0.9 then 0.8 and never reaches 0.5, so there is no median.
  const km = kaplanMeierMedian([
    { time: 10, completed: true },
    { time: 20, completed: true },
    ...Array.from({ length: 8 }, () => ({ time: 35, completed: false })),
  ]);
  assert.equal(km.reached, false);
  assert.equal(km.median, null);
  assert.equal(km.events, 2);
  assert.equal(km.censored, 8);
});

test('kaplan-meier drops censored cases out of the risk set at their own time', () => {
  // Eight cases already dropped out at day 5, so by day 10 only two remain at
  // risk and one of them finishes. Survival is 0.5 and the median is 10.
  // This is correct and it is also fragile: the estimate rests on two cases.
  const km = kaplanMeierMedian([
    { time: 10, completed: true },
    { time: 20, completed: true },
    ...Array.from({ length: 8 }, () => ({ time: 5, completed: false })),
  ]);
  assert.equal(km.median, 10);
  assert.equal(km.reached, true);
});

test('kaplan-meier median exceeds the completed-only median under censoring', () => {
  // Four finished at 10,20,30,40. Six still running at 35 days.
  // Completed-only median is 25. K-M cannot fall to 0.5 that early because the
  // six unfinished cases stay in the risk set.
  const completed = [10, 20, 30, 40].map((t) => ({ time: t, completed: true }));
  const censored = Array.from({ length: 6 }, () => ({ time: 35, completed: false }));
  const km = kaplanMeierMedian([...completed, ...censored]);
  const plain = median([10, 20, 30, 40]) as number;
  assert.equal(plain, 25);
  assert.ok(km.median === null || km.median > plain, `K-M median ${km.median} should exceed ${plain}`);
});
