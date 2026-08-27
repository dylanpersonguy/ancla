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
import { mirrorMonth } from '../../ingest/src/mirror.ts';
import { FIRST_MONTH, currentMonth, monthRange } from '../../ingest/src/observatorio.ts';
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
function isClosed(month: string, now: Date): boolean {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  return Date.UTC(y, m, 1) <= now.getTime();
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
    const outcome = await mirrorMonth(month, {
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
      closedMonth: isClosed(month, now),
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
