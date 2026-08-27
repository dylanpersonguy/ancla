#!/usr/bin/env node
/**
 * ancla ingest — survey, mirror, status.
 *
 *   node packages/ingest/src/cli.ts survey
 *   node packages/ingest/src/cli.ts mirror [--from YYYYMM] [--to YYYYMM] [-c N] [--force]
 *   node packages/ingest/src/cli.ts status
 *
 * Data root defaults to $HOME/ancla-data. Override with ANCLA_DATA.
 */

import * as manifest from './manifest.ts';
import { dataRootSize, mirrorAll } from './mirror.ts';
import { FIRST_MONTH, type Month, currentMonth, head, monthRange } from './observatorio.ts';

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function gb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/**
 * A month whose Last-Modified lands well after its own month end was rewritten
 * after close. The daily refresh normally touches a month for the last time on
 * its final day, so anything past a two-day grace is a post-close revision.
 */
function rewrittenAfterClose(month: Month, lastModified: string | null): boolean {
  if (!lastModified) return false;
  const lm = new Date(lastModified);
  if (Number.isNaN(lm.getTime())) return false;
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(4, 6));
  const graceEnd = Date.UTC(y, m, 1) + 2 * 86_400_000; // first of next month + 2d
  return lm.getTime() > graceEnd;
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '-c' || a === '--concurrency') out.concurrency = argv[++i];
  }
  return out;
}

async function survey(): Promise<void> {
  const months = monthRange(FIRST_MONTH, currentMonth(new Date()));
  process.stdout.write(`Surveying ${months.length} months (HEAD only, no bodies)\n\n`);

  const results = await pool(months, 6, (m) => head(m).catch(() => null));

  let bytes = 0;
  let present = 0;
  /** month -> the calendar day its archive was last touched, when after close */
  const lateByDay = new Map<string, { month: Month; bytes: number }[]>();

  for (const r of results) {
    if (!r?.exists) continue;
    present++;
    bytes += r.contentLength ?? 0;
    if (!rewrittenAfterClose(r.month, r.lastModified)) continue;
    const day = new Date(r.lastModified as string).toISOString().slice(0, 10);
    const list = lateByDay.get(day) ?? [];
    list.push({ month: r.month, bytes: r.contentLength ?? 0 });
    lateByDay.set(day, list);
  }

  const first = results.find((r) => r?.exists)?.month ?? 'none';
  process.stdout.write(`Present:        ${present} / ${months.length} months\n`);
  process.stdout.write(`Earliest:       ${first}\n`);
  process.stdout.write(`Total download: ${gb(bytes)}\n\n`);

  /**
   * Group post-close writes by the day they happened. A republication event is a
   * batch of closed months all rewritten together. This separates the one-off
   * migration that created the archive from genuine later revisions, without
   * hardcoding a cutoff date: the migration is simply the largest, oldest event.
   */
  const events = [...lateByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (events.length === 0) {
    process.stdout.write('No archive was written after its own month closed.\n');
  } else {
    process.stdout.write(`Republication events (${events.length}). Each is a batch of closed\n`);
    process.stdout.write('months rewritten on one day, long after they should have been final:\n\n');
    for (const [day, list] of events) {
      const sorted = list.map((x) => x.month).sort();
      const span = sorted.length === 1 ? sorted[0] : `${sorted[0]}..${sorted[sorted.length - 1]}`;
      const size = list.reduce((s, x) => s + x.bytes, 0);
      process.stdout.write(
        `  ${day}  ${String(list.length).padStart(3)} months  ${span.padEnd(18)} ${mb(size)}\n`,
      );
    }
    process.stdout.write(
      '\nThe oldest and largest event is the initial load that built the archive.\n' +
        'The later ones are the finding: closed months revised with no public record\n' +
        'of what changed.\n',
    );
  }
  process.stdout.write(`\nData root: ${manifest.dataRoot()}\n`);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

async function mirror(args: Record<string, string | boolean>): Promise<void> {
  const from = (args.from as string) ?? FIRST_MONTH;
  const to = (args.to as string) ?? currentMonth(new Date());
  const concurrency = Number(args.concurrency ?? 4);
  const months = monthRange(from, to);

  process.stdout.write(`Mirroring ${months.length} months (${from} to ${to})\n`);
  process.stdout.write(`Data root: ${manifest.dataRoot()}\n`);
  process.stdout.write(`Concurrency: ${concurrency}\n\n`);

  const started = Date.now();
  const results = await mirrorAll(months, {
    concurrency,
    force: Boolean(args.force),
    onProgress: (line) => process.stdout.write(`${line}\n`),
  });

  const counts = { stored: 0, unchanged: 0, missing: 0, error: 0 };
  for (const r of results) counts[r.status]++;
  const elapsed = ((Date.now() - started) / 1000).toFixed(0);

  process.stdout.write(
    `\nstored ${counts.stored}  unchanged ${counts.unchanged}  ` +
      `missing ${counts.missing}  error ${counts.error}  in ${elapsed}s\n`,
  );
  process.stdout.write(`On disk: ${gb(await dataRootSize())}\n`);
  if (counts.error > 0) process.exitCode = 1;
}

async function status(): Promise<void> {
  const entries = await manifest.readAll();
  if (entries.length === 0) {
    process.stdout.write(`No manifest yet at ${manifest.manifestPath()}\n`);
    process.stdout.write('Run: node packages/ingest/src/cli.ts mirror\n');
    return;
  }
  const versions = await manifest.versionsByMonth();
  const multi = [...versions.entries()].filter(([, v]) => v.length > 1);

  process.stdout.write(`Manifest:    ${manifest.manifestPath()}\n`);
  process.stdout.write(`Observations: ${entries.length}\n`);
  process.stdout.write(`Months held:  ${versions.size}\n`);
  process.stdout.write(`On disk:      ${gb(await dataRootSize())}\n\n`);

  if (multi.length === 0) {
    process.stdout.write(
      'No month has changed since we started watching. Expected on a fresh mirror:\n' +
        'the baseline exists from today forward, not backward.\n',
    );
    return;
  }
  process.stdout.write(`Months rewritten since we started watching (${multi.length}):\n\n`);
  for (const [month, vs] of multi) {
    process.stdout.write(`  ${month}  ${vs.length} versions\n`);
    for (const v of vs) {
      process.stdout.write(`    ${v.lastModified}  ${v.sha256?.slice(0, 12)}  ${mb(v.contentLength ?? 0)}\n`);
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (cmd) {
  case 'survey':
    await survey();
    break;
  case 'mirror':
    await mirror(args);
    break;
  case 'status':
    await status();
    break;
  default:
    process.stdout.write(
      'ancla ingest\n\n' +
        '  survey                          HEAD every month; size + rewrite report\n' +
        '  mirror [--from M] [--to M]      download everything new or changed\n' +
        '         [-c N] [--force]\n' +
        '  status                          what we hold, and what has changed\n\n' +
        `Data root: ${manifest.dataRoot()} (override with ANCLA_DATA)\n`,
    );
    process.exitCode = cmd ? 1 : 0;
}
