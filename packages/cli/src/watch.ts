/**
 * The daily job.
 *
 * Ancla's whole claim is forward-only: it can prove a published record changed,
 * but only from the moment it starts watching. That makes the daily run the
 * product, not a maintenance chore. Every day it does not run is a day of history
 * that cannot be recovered.
 *
 * One pass:
 *   1. HEAD every month upstream. Cheap: no bodies.
 *   2. Anything whose Last-Modified moved since we last stored it, download.
 *      Archives are never overwritten, so a rewrite lands beside its predecessor.
 *   3. Canonicalize the new version and diff it against the one before.
 *   4. Report. A rewrite of a closed month with value changes is the finding.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { buildSnapshot, writeSnapshot } from '../../canonicalize/src/snapshot.ts';
import { type DiffResult, diff, summarize } from '../../differ/src/index.ts';
import { dataRoot } from '../../ingest/src/manifest.ts';
import { mirrorPeriod } from '../../ingest/src/mirror.ts';
import {
  FIRST_MONTH,
  OBSERVATORIO,
  currentMonth,
  monthRange,
} from '../../ingest/src/observatorio.ts';
import { monthClosesAt } from '../../ingest/src/source.ts';
import { readFile } from 'node:fs/promises';
import { archives, loadOrBuild, snapshotPath } from './store.ts';

export type WatchFinding = {
  month: string;
  closedMonth: boolean;
  previousStamp: string;
  currentStamp: string;
  diff: DiffResult;
};

export type WatchReport = {
  ranAt: string;
  monthsChecked: number;
  monthsUpdated: string[];
  findings: WatchFinding[];
};

/** A month is closed once its own calendar month has ended. */
/** `20260831T130427Z` -> Date. The inverse of compactStamp. */
function stampToDate(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
}

/**
 * Did this copy land after its month was final?
 *
 * The question is about the archive's own write time, not about today. An
 * earlier version asked whether the month had ended by the time the check ran,
 * which is a different question with the same answer most of the time and the
 * wrong answer exactly when it matters. On 2026-09-02 it read a copy written
 * 2026-08-31T13:04Z — eleven hours before August closed, the ordinary last
 * daily refresh — and reported August as a rewritten closed month with 261,243
 * records "added". A check that cries wolf is ignored on the day it is right.
 *
 * monthClosesAt is imported rather than restated. Two definitions of "closed"
 * living in two files is what produced the false positive.
 */
export function rewrittenAfterClose(month: string, currentStamp: string): boolean {
  const written = stampToDate(currentStamp);
  return written ? written.getTime() > monthClosesAt(month) : false;
}

export async function runWatch(
  opts: { from?: string; to?: string; concurrency?: number; log?: (s: string) => void } = {},
): Promise<WatchReport> {
  const now = new Date();
  const log = opts.log ?? (() => {});
  const list = monthRange(opts.from ?? FIRST_MONTH, opts.to ?? currentMonth(now));

  const before = new Map<string, number>();
  for (const month of list) before.set(month, (await archives(month)).length);

  log(`checking ${list.length} months upstream`);
  const updated: string[] = [];
  for (const month of list) {
    // Costa Rica only, and not by oversight: everything below this line —
    // store.ts, buildSnapshot, diff — reads SICOP's archive layout and CSV
    // schema. Mirroring is multi-source; the evidence chain built on top of it
    // is not, and pointing this at Panama would produce snapshots of nothing.
    const outcome = await mirrorPeriod(OBSERVATORIO, month, {
      concurrency: 1,
      force: false,
      onProgress: () => {},
    });
    if (outcome.status === 'stored') {
      updated.push(month);
      log(`  ${month} updated`);
    }
  }

  const findings: WatchFinding[] = [];
  for (const month of updated) {
    const refs = await archives(month);
    // A first-ever copy is a baseline, not a change.
    if (refs.length < 2 || (before.get(month) ?? 0) === 0) continue;

    const prev = refs[refs.length - 2];
    const cur = refs[refs.length - 1];
    const prevSnap = await loadOrBuild(prev);
    const curSnap = buildSnapshot(month, await readFile(cur.path));
    await writeSnapshot(snapshotPath(cur), curSnap);

    const d = diff(prevSnap, curSnap, { limit: 200 });
    findings.push({
      month,
      closedMonth: rewrittenAfterClose(month, cur.stamp),
      previousStamp: prev.stamp,
      currentStamp: cur.stamp,
      diff: d,
    });
  }

  return {
    ranAt: now.toISOString(),
    monthsChecked: list.length,
    monthsUpdated: updated,
    findings,
  };
}

export function reportText(r: WatchReport): string {
  const lines = [`ancla watch  ${r.ranAt}`, `  months checked ${r.monthsChecked}`,
    `  archives updated ${r.monthsUpdated.length}${r.monthsUpdated.length ? `: ${r.monthsUpdated.join(', ')}` : ''}`];

  if (!r.findings.length) {
    lines.push('', 'No month was rewritten. Nothing to report.');
    return lines.join('\n');
  }

  for (const f of r.findings) {
    const c = f.diff.counts;
    const substantive = c.silentRevision + c.removed;
    lines.push('', `${f.month}  ${f.previousStamp} -> ${f.currentStamp}`);
    lines.push(f.closedMonth
      ? '  CLOSED MONTH REWRITTEN. This archive should have been final.'
      : '  current month, routine daily update');
    lines.push(summarize(f.diff).split('\n').slice(1).join('\n'));
    if (f.closedMonth && substantive > 0) {
      lines.push(`  >> ${substantive.toLocaleString()} records changed or removed in a closed month.`);
    }
  }
  return lines.join('\n');
}

export async function writeReport(r: WatchReport): Promise<string> {
  const dir = join(dataRoot(), 'reports');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `watch-${r.ranAt.slice(0, 10)}.json`);
  await writeFile(path, JSON.stringify(r, null, 2), 'utf8');
  return path;
}
