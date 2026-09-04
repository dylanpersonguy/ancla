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
import { readFile } from 'node:fs/promises';
import type { Source } from '../../ingest/src/source.ts';
import {
  FULL_LINES,
  type LinePolicy,
  REVISIONS_ONLY,
  buildBundle,
} from '../../bundle/src/bundle.ts';
import { dirFor, persist } from './bundles.ts';
import { schemaFor } from './schemas.ts';
import { archives, loadOrBuild, snapshotPath } from './store.ts';

export type WatchFinding = {
  month: string;
  closedMonth: boolean;
  previousStamp: string;
  currentStamp: string;
  diff: DiffResult;
  /** Set when a row-level evidence bundle was written for this rewrite. */
  bundle?: { dir: string; bundleDigest: string; changesSha256: string; valuesOmitted: number };
};

export type WatchReport = {
  /** Which publisher this run checked. Absent on reports written before 2026-09-04. */
  source?: string;
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
export function rewrittenAfterClose(
  source: Source,
  period: string,
  currentStamp: string,
): boolean {
  const written = stampToDate(currentStamp);
  return written ? written.getTime() > source.closesAt(period) : false;
}

/**
 * Should this rewrite get a full row-level bundle written to disk?
 *
 * A closed month always does: that is the event this project exists to document,
 * it is rare, and it is small. The open month's daily append is a different
 * animal — a quarter of a million new rows, 25 MB compressed, every single day —
 * and writing that as evidence would spend nine gigabytes a year to record that
 * August grew during August. The counts still go in the report either way, and
 * `--bundle-all` overrides this for anyone who wants the lot.
 */
/**
 * How much of a rewrite to write out.
 *
 * A closed month gets everything: it is the event this project exists to
 * document, it is rare, and it is small. The open month's daily update is a
 * different animal — a quarter of a million rows appear because the month is
 * filling up, which is not news — so its bundle carries the revisions, the
 * withdrawals and the reprints and leaves the additions counted but unlisted.
 *
 * That is a real omission and the manifest says so, inside the digest. It costs
 * roughly a gigabyte a year instead of nine, and it stops the fifteen hundred
 * rows anyone would actually ask about from being buried under a quarter of a
 * million that nobody will.
 */
export function policyFor(
  f: Omit<WatchFinding, 'bundle'>,
  full = false,
): LinePolicy {
  return full || f.closedMonth ? FULL_LINES : REVISIONS_ONLY;
}

export async function runWatch(
  opts: {
    from?: string;
    to?: string;
    concurrency?: number;
    source?: Source;
    /** List every added row too, not just revisions, on an open month. */
    bundleAll?: boolean;
    log?: (s: string) => void;
  } = {},
): Promise<WatchReport> {
  const now = new Date();
  const log = opts.log ?? (() => {});
  const source = opts.source ?? OBSERVATORIO;
  const list = source.periodRange(
    opts.from ?? source.firstPeriod,
    opts.to ?? source.currentPeriod(now),
  );

  const before = new Map<string, number>();
  for (const month of list) before.set(month, (await archives(month, source)).length);

  log(`checking ${list.length} months upstream`);
  const updated: string[] = [];
  for (const month of list) {
    // schemaFor throws for a source with no table keys, which is the honest
    // failure: its archives can be mirrored and hashed, but canonicalising them
    // with another country's keys would invent identities and make every later
    // comparison meaningless.
    const outcome = await mirrorPeriod(source, month, {
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
    const refs = await archives(month, source);
    // A first-ever copy is a baseline, not a change.
    if (refs.length < 2 || (before.get(month) ?? 0) === 0) continue;

    const prev = refs[refs.length - 2];
    const cur = refs[refs.length - 1];
    const prevSnap = await loadOrBuild(prev, source);
    const curSnap = buildSnapshot(month, await readFile(cur.path), schemaFor(source.id));
    await writeSnapshot(snapshotPath(cur, source), curSnap);

    const d = diff(prevSnap, curSnap, { limit: 200 });
    const finding: WatchFinding = {
      month,
      closedMonth: rewrittenAfterClose(source, month, cur.stamp),
      previousStamp: prev.stamp,
      currentStamp: cur.stamp,
      diff: d,
    };

    // Every rewrite is bundled. What differs is how much of it is written out,
    // which policyFor decides and the manifest records inside its own digest.
    {
      try {
        const built = buildBundle(
          { snapshot: prevSnap, archive: await readFile(prev.path), ref: prev },
          { snapshot: curSnap, archive: await readFile(cur.path), ref: cur },
          {
            schema: schemaFor(source.id),
            linePolicy: policyFor(finding, opts.bundleAll ?? false),
          },
        );
        const dir = await persist(
          dirFor(
            source, month, prev.stamp, cur.stamp,
            built.manifest.canonVersion, built.manifest.bundleVersion,
          ),
          built,
        );
        finding.bundle = {
          dir,
          bundleDigest: built.manifest.bundleDigest,
          changesSha256: built.manifest.changesSha256,
          valuesOmitted: built.manifest.valuesOmitted,
        };
        log(`  ${month} bundle ${built.manifest.bundleDigest.slice(0, 16)} -> ${dir}`);
      } catch (err) {
        // A bundle that fails to build must not lose the finding: the counts and
        // both roots are the part that cannot be reconstructed later.
        log(`  ${month} bundle FAILED: ${(err as Error).message}`);
      }
    }

    findings.push(finding);
  }

  return {
    source: source.id,
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
    if (f.bundle) {
      lines.push(`  bundle ${f.bundle.bundleDigest}`);
      lines.push(`    ${f.bundle.dir}`);
      lines.push(`    anchor it with: ancla anchor --versions --month ${f.month} --broadcast`);
    }
  }
  return lines.join('\n');
}

/**
 * One report per source per day.
 *
 * The name used to be `watch-<day>.json` with no source in it, and the daily job
 * runs every publisher in turn against the same data root. So the second run of
 * the day overwrote the first: on 2026-09-03 Costa Rica found 1,110 silent
 * revisions and 834 removals at 15:30, and Panama's quiet run at 19:32 replaced
 * that file with `findings: []`. The change feed read empty for the same reason,
 * and the findings themselves were gone.
 *
 * Costa Rica keeps the unsuffixed name because three reports already exist under
 * it and the reader globs for them; every other publisher carries its id.
 */
export async function writeReport(r: WatchReport, source?: Source): Promise<string> {
  const dir = join(dataRoot(), 'reports');
  await mkdir(dir, { recursive: true });
  const suffix = !source || source.id === 'cr-observatorio' ? '' : `-${source.id}`;
  const path = join(dir, `watch-${r.ranAt.slice(0, 10)}${suffix}.json`);
  await writeFile(path, JSON.stringify(r, null, 2), 'utf8');
  return path;
}
