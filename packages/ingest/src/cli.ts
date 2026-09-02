#!/usr/bin/env node
/**
 * ancla ingest — survey, mirror, status.
 *
 *   node packages/ingest/src/cli.ts survey [--source cr|pa]
 *   node packages/ingest/src/cli.ts mirror [--source cr|pa] [--from P] [--to P] [-c N] [--force]
 *   node packages/ingest/src/cli.ts status [--source cr|pa]
 *
 * Data root defaults to $HOME/ancla-data. Override with ANCLA_DATA.
 */

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as manifest from './manifest.ts';
import { dataRootSize, mirrorAll } from './mirror.ts';
import type { Period, Source } from './source.ts';
import { SOURCES, resolveSource } from './sources.ts';

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

function gb(bytes: number): string {
  return `${(bytes / 1_073_741_824).toFixed(2)} GB`;
}

/**
 * A period whose Last-Modified lands after its own close was rewritten late.
 * The publisher decides where that line sits, since a daily refresh and a
 * quarterly one settle very differently.
 */
function rewrittenAfterClose(source: Source, period: Period, lastModified: string | null): boolean {
  if (!lastModified) return false;
  const lm = new Date(lastModified);
  if (Number.isNaN(lm.getTime())) return false;
  return lm.getTime() > source.closesAt(period);
}

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--from') out.from = argv[++i] as string;
    else if (a === '--to') out.to = argv[++i] as string;
    else if (a === '-s' || a === '--source') out.source = argv[++i] as string;
    else if (a === '-c' || a === '--concurrency') out.concurrency = argv[++i] as string;
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

async function survey(source: Source, args: Record<string, string | boolean>): Promise<void> {
  const from = (args.from as string) ?? source.firstPeriod;
  const to = (args.to as string) ?? source.currentPeriod(new Date());
  const periods = source.periodRange(from, to);
  process.stdout.write(`${source.label}\n`);
  process.stdout.write(`Surveying ${periods.length} periods (HEAD only, no bodies)\n\n`);

  const results = await pool(periods, 6, (p) => source.head(p).catch(() => null));

  let bytes = 0;
  let present = 0;
  /** day -> the periods whose archive was last touched then, when after close */
  const lateByDay = new Map<string, { period: Period; bytes: number }[]>();

  for (const r of results) {
    if (!r?.exists) continue;
    present++;
    bytes += r.contentLength ?? 0;
    if (!rewrittenAfterClose(source, r.period, r.lastModified)) continue;
    const day = new Date(r.lastModified as string).toISOString().slice(0, 10);
    const list = lateByDay.get(day) ?? [];
    list.push({ period: r.period, bytes: r.contentLength ?? 0 });
    lateByDay.set(day, list);
  }

  const first = results.find((r) => r?.exists)?.period ?? 'none';
  process.stdout.write(`Present:        ${present} / ${periods.length} periods\n`);
  process.stdout.write(`Earliest:       ${first}\n`);
  process.stdout.write(`Total download: ${gb(bytes)}\n\n`);

  /**
   * Group post-close writes by the day they happened. A republication event is a
   * batch of closed periods all rewritten together. This separates the one-off
   * migration that created the archive from genuine later revisions, without
   * hardcoding a cutoff date: the migration is simply the largest, oldest event.
   */
  const events = [...lateByDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  if (events.length === 0) {
    process.stdout.write('No archive was written after its own period closed.\n');
  } else {
    process.stdout.write(`Republication events (${events.length}). Each is a batch of closed\n`);
    process.stdout.write('periods rewritten on one day, long after they should have been final:\n\n');
    for (const [day, list] of events) {
      const sorted = list.map((x) => x.period).sort();
      const span = sorted.length === 1 ? sorted[0] : `${sorted[0]}..${sorted[sorted.length - 1]}`;
      const size = list.reduce((s, x) => s + x.bytes, 0);
      process.stdout.write(
        `  ${day}  ${String(list.length).padStart(3)} periods  ${String(span).padEnd(18)} ${mb(size)}\n`,
      );
    }
    process.stdout.write(
      '\nThe oldest and largest event is usually the initial load that built the\n' +
        'archive. The later ones are the finding: closed periods revised with no\n' +
        'public record of what changed.\n',
    );
  }
  process.stdout.write(`\nSource root: ${manifest.sourceRoot(source)}\n`);
}

async function mirror(source: Source, args: Record<string, string | boolean>): Promise<void> {
  const from = (args.from as string) ?? source.firstPeriod;
  const to = (args.to as string) ?? source.currentPeriod(new Date());
  const concurrency = Number(args.concurrency ?? 4);
  const periods = source.periodRange(from, to);

  process.stdout.write(`${source.label}\n`);
  process.stdout.write(`Mirroring ${periods.length} periods (${from} to ${to})\n`);
  process.stdout.write(`Source root: ${manifest.sourceRoot(source)}\n`);
  process.stdout.write(`Concurrency: ${concurrency}\n\n`);

  const started = Date.now();
  const results = await mirrorAll(source, periods, {
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
  process.stdout.write(`On disk: ${gb(await dataRootSize(source))}\n`);
  if (counts.error > 0) process.exitCode = 1;
}

async function status(source: Source): Promise<void> {
  const entries = await manifest.readAll(source);
  if (entries.length === 0) {
    process.stdout.write(`No manifest yet at ${manifest.manifestPath(source)}\n`);
    process.stdout.write(`Run: node packages/ingest/src/cli.ts mirror --source ${source.id}\n`);
    return;
  }
  const versions = await manifest.versionsByPeriod(source);
  const multi = [...versions.entries()].filter(([, v]) => v.length > 1);

  process.stdout.write(`Source:       ${source.label}\n`);
  process.stdout.write(`Manifest:     ${manifest.manifestPath(source)}\n`);
  process.stdout.write(`Observations: ${entries.length}\n`);
  process.stdout.write(`Periods held: ${versions.size}\n`);
  process.stdout.write(`On disk:      ${gb(await dataRootSize(source))}\n\n`);

  if (multi.length === 0) {
    process.stdout.write(
      'No period has changed since we started watching. Expected on a fresh\n' +
        'mirror: the baseline exists from today forward, not backward.\n',
    );
    return;
  }
  process.stdout.write(`Periods rewritten since we started watching (${multi.length}):\n\n`);
  for (const [period, vs] of multi) {
    process.stdout.write(`  ${period}  ${vs.length} versions\n`);
    for (const v of vs) {
      process.stdout.write(
        `    ${v.lastModified}  ${v.sha256?.slice(0, 12)}  ${mb(v.contentLength ?? 0)}\n`,
      );
    }
  }
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

function usage(): void {
  process.stdout.write(
    'ancla ingest\n\n' +
      '  survey [--source S]             HEAD every period; size + rewrite report\n' +
      '  mirror [--source S]             download everything new or changed\n' +
      '         [--from P] [--to P] [-c N] [--force]\n' +
      '  status [--source S]             what we hold, and what has changed\n\n' +
      'Sources:\n' +
      SOURCES.map((s) => `  ${s.id.padEnd(20)} ${s.country}  ${s.label}\n`).join('') +
      `\nData root: ${manifest.dataRoot()} (override with ANCLA_DATA)\n`,
  );
}

/**
 * NODE_EXTRA_CA_CERTS is read once at startup, so a source that needs an extra
 * intermediate cannot install it from inside a running process. Re-exec once
 * with it set rather than making every caller remember an env var, and leave a
 * sentinel so a failure to apply it cannot become a fork bomb.
 */
function reexecWithCa(source: Source): boolean {
  if (!source.extraCa || process.env.ANCLA_CA_APPLIED) return false;
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: source.extraCa, ANCLA_CA_APPLIED: '1' },
  });
  process.exitCode = r.status ?? 1;
  return true;
}

try {
  const source = resolveSource(args.source as string | undefined);
  if (!reexecWithCa(source)) {
  switch (cmd) {
    case 'survey':
      await survey(source, args);
      break;
    case 'mirror':
      await mirror(source, args);
      break;
    case 'status':
      await status(source);
      break;
    default:
      usage();
      process.exitCode = cmd ? 1 : 0;
  }
  }
} catch (err) {
  process.stderr.write(`${String(err instanceof Error ? err.message : err)}\n`);
  process.exitCode = 1;
}
