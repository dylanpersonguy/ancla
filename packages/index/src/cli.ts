#!/usr/bin/env node
/**
 * ancla index: load, resolve, stats.
 *
 *   node packages/index/src/cli.ts load [--from YYYYMM] [--to YYYYMM] [--force] [-v]
 *   node packages/index/src/cli.ts resolve [--show N]
 *   node packages/index/src/cli.ts stats
 *
 * Archives are read from $HOME/ancla-data/archives (override with ANCLA_DATA).
 * The index is written to $HOME/ancla-data/index.sqlite (override with
 * ANCLA_INDEX), which is the same path every other package opens.
 */

import { indexPath, query, queryOne } from '../../core/src/db.ts';
import { archivesRoot, latestArchives, loadRange, openIndex } from './load.ts';
import { type Actor, groupSuppliers, resolve, serialCollisions } from './resolve.ts';
import { SPECS } from './spec.ts';

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '-v' || a === '--verbose') out.verbose = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else if (a === '--show') out.show = argv[++i];
  }
  return out;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

function load(args: Record<string, string | boolean>): void {
  const from = args.from as string | undefined;
  const to = args.to as string | undefined;
  const refs = latestArchives({ from, to });
  if (refs.length === 0) {
    process.stdout.write(`No archives under ${archivesRoot()}\n`);
    process.stdout.write('Run: node packages/ingest/src/cli.ts mirror\n');
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Index:    ${indexPath()}\n`);
  process.stdout.write(`Archives: ${refs.length} months (${refs[0].month}..${refs[refs.length - 1].month})\n\n`);

  const db = openIndex();
  const started = Date.now();
  const total = loadRange(db, {
    from,
    to,
    force: Boolean(args.force),
    onProgress: (line) => process.stdout.write(`${line}\n`),
    onTable: args.verbose ? (line) => process.stdout.write(`${line}\n`) : undefined,
  });

  const elapsed = (Date.now() - started) / 1000;
  process.stdout.write(`\nloaded ${total.loaded}  already had ${total.skipped}  in ${elapsed.toFixed(0)}s\n\n`);
  if (total.loaded === 0) {
    db.close();
    return;
  }

  process.stdout.write('Rows read from CSV and applied to the index:\n\n');
  process.stdout.write(`  ${'table'.padEnd(14)}${'read'.padStart(12)}${'applied'.padStart(12)}\n`);
  for (const spec of SPECS) {
    const r = total.read[spec.table] ?? 0;
    const a = total.applied[spec.table] ?? 0;
    process.stdout.write(`  ${spec.table.padEnd(14)}${num(r).padStart(12)}${num(a).padStart(12)}\n`);
  }
  // read counts CSV rows; applied counts writes that landed. A row that was
  // already held under a LATER source_month is refused by the upsert guard and
  // shows up as the gap, which only happens when months arrive out of order.
  // Deduplication across months is visible in `stats`, not here.
  process.stdout.write(`\n  rows dropped for a blank key: ${num(total.noKey)}\n`);
  db.close();
}

function resolveCmd(args: Record<string, string | boolean>): void {
  const db = openIndex();
  const stats = resolve(db);
  process.stdout.write(`Actors seen:          ${num(stats.actors)}\n`);
  process.stdout.write(`Entities:             ${num(stats.entities)}\n`);
  process.stdout.write(`  supplier            ${num(stats.suppliers)}\n`);
  process.stdout.write(`  group               ${num(stats.groups)} covering ${num(stats.groupedCedulas)} cedulas\n`);
  process.stdout.write(`  consortium          ${num(stats.consortia)}\n`);
  process.stdout.write(`Memberships:          ${num(stats.members)}\n\n`);
  process.stdout.write('Merges refused, on purpose:\n');
  process.stdout.write(`  same name, different registry serial   ${num(stats.rejectedNameCollisions)}\n`);
  process.stdout.write(`  same registry serial, different name   ${num(stats.rejectedSerialCollisions)}\n`);

  const show = Number(args.show ?? 0);
  if (show > 0) {
    const actors = query<{ cedula: string; nombre: string | null }>(
      db,
      'SELECT cedula_proveedor AS cedula, nombre FROM supplier',
    ).map((r) => ({ cedula: r.cedula, nombre: r.nombre }) as Actor);
    const { groups, rejected } = groupSuppliers(actors);
    process.stdout.write('\nMerged:\n');
    for (const g of groups.slice(0, show)) {
      process.stdout.write(`  ${g.entityId}  ${g.members.map((m) => m.cedula).join(' + ')}  ${g.canonicalName}\n`);
    }
    process.stdout.write('\nRefused (same name, different serial):\n');
    for (const r of rejected.slice(0, show)) {
      process.stdout.write(`  ${r.key}  ${r.cedulas.join(' vs ')}\n`);
    }
    process.stdout.write('\nRefused (same serial, different name):\n');
    for (const r of serialCollisions(actors).slice(0, show)) {
      process.stdout.write(`  ${r.key}  ${r.names.join('  vs  ')}\n`);
    }
  }
  db.close();
}

function stats(): void {
  const db = openIndex();
  const archives = query<{ source_month: string; archive_stamp: string }>(
    db,
    'SELECT source_month, archive_stamp FROM loaded_archive ORDER BY source_month, archive_stamp',
  );
  const months = [...new Set(archives.map((a) => a.source_month))].sort();

  process.stdout.write(`Index:    ${indexPath()}\n`);
  process.stdout.write(`Archives: ${num(archives.length)} versions\n`);
  if (months.length === 0) {
    process.stdout.write('\nNothing loaded yet. Run: node packages/index/src/cli.ts load\n');
    db.close();
    return;
  }
  process.stdout.write(`Months:   ${months.length} (${months[0]}..${months[months.length - 1]})\n`);

  // Gaps matter more than the span. A missing month is a hole every longitudinal
  // question falls into without saying so.
  const gaps: string[] = [];
  for (let y = Number(months[0].slice(0, 4)), m = Number(months[0].slice(4)); ; ) {
    const key = `${y}${String(m).padStart(2, '0')}`;
    if (key > months[months.length - 1]) break;
    if (!months.includes(key)) gaps.push(key);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  process.stdout.write(`Gaps:     ${gaps.length ? gaps.join(', ') : 'none'}\n\n`);

  process.stdout.write(`  ${'table'.padEnd(14)}${'rows'.padStart(14)}\n`);
  for (const spec of SPECS) {
    const c = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${spec.table}`);
    process.stdout.write(`  ${spec.table.padEnd(14)}${num(c?.n ?? 0).padStart(14)}\n`);
  }
  for (const t of ['entity', 'entity_member']) {
    const c = queryOne<{ n: number }>(db, `SELECT COUNT(*) AS n FROM ${t}`);
    process.stdout.write(`  ${t.padEnd(14)}${num(c?.n ?? 0).padStart(14)}\n`);
  }

  const kinds = query<{ kind: string; n: number }>(
    db,
    'SELECT kind, COUNT(*) AS n FROM entity GROUP BY kind ORDER BY kind',
  );
  if (kinds.length) {
    process.stdout.write('\nEntities by kind:\n');
    for (const k of kinds) process.stdout.write(`  ${k.kind.padEnd(12)}${num(k.n).padStart(10)}\n`);
  }

  process.stdout.write('\nDate coverage, from the records themselves:\n');
  const spans: [string, string, string][] = [
    ['tender publication', 'tender', 'fecha_publicacion'],
    ['tender opening', 'tender', 'fechah_apertura'],
    ['award firm', 'stage_dates', 'adjudicacion_firme'],
    ['contract notified', 'contract', 'fecha_notificacion'],
    ['first payment req', 'stage_dates', 'fecha_1ra_sol_pago'],
    ['payment resolved', 'stage_dates', 'fecha_resul_pago'],
    ['appeal filed', 'appeal', 'fecha_presentacion'],
  ];
  for (const [label, table, col] of spans) {
    const r = queryOne<{ lo: string | null; hi: string | null; n: number }>(
      db,
      `SELECT MIN(${col}) AS lo, MAX(${col}) AS hi, COUNT(${col}) AS n FROM ${table}`,
    );
    const lo = r?.lo ?? 'none';
    const hi = r?.hi ?? 'none';
    process.stdout.write(`  ${label.padEnd(20)}${lo} .. ${hi}   n=${num(r?.n ?? 0)}\n`);
  }

  // The reason the index exists, as one measurement done twice.
  //
  // Publication lives in DetalleCarteles and notification lives in Contratos,
  // and the two events are usually months apart, so inside a single archive only
  // the procedures that closed within their own month are joinable at all. That
  // is not a small sample of the truth, it is a biased one: everything slow is
  // missing by construction.
  const duration =
    'SELECT CAST(julianday(c.fecha_notificacion) - julianday(t.fecha_publicacion) AS INTEGER)' +
    ' AS days FROM contract c JOIN tender t ON t.nro_sicop = c.nro_sicop' +
    ' WHERE c.fecha_notificacion IS NOT NULL AND t.fecha_publicacion IS NOT NULL';
  const newest = months[months.length - 1];

  const line = (label: string, where: string) => {
    const src = `SELECT days FROM (${duration} ${where}) WHERE days >= 0`;
    const span = queryOne<{ n: number; hi: number | null }>(
      db,
      `SELECT COUNT(*) AS n, MAX(days) AS hi FROM (${src})`,
    );
    if (!span || span.n === 0) {
      process.stdout.write(`  ${label.padEnd(22)}nothing joinable\n`);
      return;
    }
    // Ordering inside a subquery is not a promise SQLite makes, so each
    // percentile is its own ordered query rather than an offset into one result.
    const at = (k: number) =>
      queryOne<{ days: number }>(db, `${src} ORDER BY days LIMIT 1 OFFSET ?`, [
        Math.floor((span.n - 1) * k),
      ])?.days;
    process.stdout.write(
      `  ${label.padEnd(22)}n=${num(span.n).padStart(9)}  median ${at(0.5)}d` +
        `  p90 ${at(0.9)}d  max ${span.hi}d\n`,
    );
  };

  process.stdout.write('\nPublication to contract notification, the same query two ways:\n');
  line(
    `${newest} alone`,
    `AND c.source_month = '${newest}' AND t.source_month = '${newest}'`,
  );
  line('every month stitched', '');

  const crossing = queryOne<{ cross: number; total: number }>(
    db,
    `SELECT SUM(CASE WHEN c.source_month <> t.source_month THEN 1 ELSE 0 END) AS cross,
            COUNT(*) AS total
     FROM contract c JOIN tender t ON t.nro_sicop = c.nro_sicop`,
  );
  if (crossing && crossing.total > 0) {
    process.stdout.write(
      `  ${num(crossing.cross)} of ${num(crossing.total)} contract-to-tender links` +
        ' cross a month boundary, and exist only here.\n',
    );
  }

  // Said plainly, because a reader will otherwise assume stitching fixed
  // everything. FechaPorEtapas rows are frozen in the month the procedure was
  // published: every row's PUBLICACION falls inside its own source_month, and
  // the source never comes back to fill in a later award or payment. Durations
  // read out of that one table stay censored no matter how many months are held.
  const lagged = queryOne<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM stage_dates WHERE publicacion IS NOT NULL
     AND SUBSTR(publicacion, 1, 4) || SUBSTR(publicacion, 6, 2) <> source_month`,
  );
  process.stdout.write(
    `\nstage_dates rows published outside their own archive month: ${num(lagged?.n ?? 0)}.\n` +
      'Stage dates are a snapshot taken at publication, so durations taken from\n' +
      'stage_dates alone stay censored. Join across tables for the real answer.\n',
  );
  db.close();
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

switch (cmd) {
  case 'load':
    load(args);
    break;
  case 'resolve':
    resolveCmd(args);
    break;
  case 'stats':
    stats();
    break;
  default:
    process.stdout.write(
      'ancla index\n\n' +
        '  load [--from M] [--to M]    fold monthly archives into the index\n' +
        '       [--force] [-v]         --force reloads archives already recorded\n' +
        '  resolve [--show N]          rebuild entity and entity_member\n' +
        '  stats                       rows per table, months held, date coverage\n\n' +
        `Archives: ${archivesRoot()}\n` +
        `Index:    ${indexPath()}\n`,
    );
    process.exitCode = cmd ? 1 : 0;
}
