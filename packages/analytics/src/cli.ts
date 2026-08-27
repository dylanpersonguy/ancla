#!/usr/bin/env node
/**
 * ancla analytics.
 *
 *   node packages/analytics/src/cli.ts competition  [--institution CED] [--from D] [--to D] [--month YYYYMM]
 *   node packages/analytics/src/cli.ts duration     [--grain procedure|line] [--stage KEY]
 *   node packages/analytics/src/cli.ts prices       [--code CODIGO] [--currency CRC] [--min-sample N] [--limit N]
 *   node packages/analytics/src/cli.ts collusion    [--screen rotation|losing|spread|single] [--min-tenders N]
 *   node packages/analytics/src/cli.ts supplier     --supplier CEDULA
 *   node packages/analytics/src/cli.ts institution  --institution CEDULA [--all-peers]
 *   node packages/analytics/src/cli.ts rank         --metric single_bidder_rate [--min-sample N]
 *
 * Every subcommand takes --json for the full structure, and --db PATH to point
 * at an index other than the default. Index path defaults to $ANCLA_INDEX, then
 * $ANCLA_DATA/index.sqlite, then ~/ancla-data/index.sqlite.
 *
 * The index is populated separately. When it is missing or a table is empty the
 * commands say so and exit cleanly rather than printing zeros that read like
 * measurements.
 */

import { existsSync } from 'node:fs';
import { type Db, openDb, indexPath } from '../../core/src/db.ts';
import { competitionReport } from './competition.ts';
import { STAGES, durationReport } from './duration.ts';
import { benchmarkProduct, scanPrices } from './prices.ts';
import { bidRotation, bidSpread, collusionReport, consistentLosing, singleBidderConcentration } from './collusion.ts';
import { supplierProfile } from './supplier.ts';
import { METRIC_KEYS, benchmarkInstitution, rankInstitutions } from './institution.ts';
import { bullets, days as fmtDays, heading, money, num, pct, ratio, subheading, table, truncate, wrap } from './format.ts';

interface Args {
  command: string;
  json: boolean;
  db?: string;
  from?: string;
  to?: string;
  month?: string;
  bidMonth?: string;
  institution?: string;
  supplier?: string;
  code?: string;
  currency?: string;
  grain?: 'procedure' | 'line';
  stage?: string;
  screen?: string;
  metric?: string;
  minSample?: number;
  minTenders?: number;
  limit?: number;
  allPeers: boolean;
  source?: 'award' | 'bid';
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { command: argv[0] ?? '', json: false, allPeers: false, help: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--json': out.json = true; break;
      case '--all-peers': out.allPeers = true; break;
      case '-h': case '--help': out.help = true; break;
      case '--db': out.db = argv[++i]; break;
      case '--from': out.from = argv[++i]; break;
      case '--to': out.to = argv[++i]; break;
      case '--month': out.month = argv[++i]; break;
      case '--bid-month': out.bidMonth = argv[++i]; break;
      case '--institution': out.institution = argv[++i]; break;
      case '--supplier': out.supplier = argv[++i]; break;
      case '--code': out.code = argv[++i]; break;
      case '--currency': out.currency = argv[++i]; break;
      case '--grain': out.grain = argv[++i] === 'line' ? 'line' : 'procedure'; break;
      case '--stage': out.stage = argv[++i]; break;
      case '--screen': out.screen = argv[++i]; break;
      case '--metric': out.metric = argv[++i]; break;
      case '--source': out.source = argv[++i] === 'bid' ? 'bid' : 'award'; break;
      case '--min-sample': out.minSample = Number(argv[++i]); break;
      case '--min-tenders': out.minTenders = Number(argv[++i]); break;
      case '--limit': out.limit = Number(argv[++i]); break;
      default:
        if (a.startsWith('-')) throw new Error(`unknown flag ${a}`);
    }
  }
  return out;
}

function write(s: string): void {
  process.stdout.write(s);
}

function emitJson(value: unknown): void {
  write(`${JSON.stringify(value, (_k, v) => (v instanceof Set ? [...v] : v), 2)}\n`);
}

function windowLine(a: Args): string {
  const parts: string[] = [];
  if (a.month) parts.push(`source month ${a.month}`);
  if (a.bidMonth) parts.push(`bids from archive ${a.bidMonth}`);
  if (a.from) parts.push(`from ${a.from}`);
  if (a.to) parts.push(`to ${a.to}`);
  if (a.institution) parts.push(`institution ${a.institution}`);
  return parts.length ? parts.join(', ') : 'all loaded data';
}

// ---------------------------------------------------------------------------

function cmdCompetition(db: Db, a: Args): void {
  const report = competitionReport(db, {
    from: a.from,
    to: a.to,
    month: a.month,
    institution: a.institution,
    currency: a.currency,
    bidMonth: a.bidMonth,
  });
  if (a.json) return emitJson(report);

  write(heading('Competition'));
  write(`  window: ${windowLine(a)}\n`);
  if (report.missing.length) {
    write(bullets([`no rows in ${report.missing.join(', ')}; nothing below is a measurement`]));
    return;
  }

  const sb = report.singleBidder;
  write(subheading('Single-bidder rate'));
  write(
    `  ${num(sb.singleBidder)} of ${num(sb.tendersWithBids)} tenders that received bids had exactly one bidder: ${pct(sb.rate)}\n`,
  );
  if (sb.ci95) write(`  95% interval ${pct(sb.ci95.low)} to ${pct(sb.ci95.high)}\n`);
  // With only --bid-month the published total is the whole index and the "no bids"
  // difference between the two is meaningless, so it is not printed.
  if (!a.bidMonth || a.month || a.from || a.to || a.institution) {
    write(
      `  ${num(report.tendersPublished)} tenders published, ${num(report.tendersWithoutBidRows)} with no bid rows at all\n`,
    );
  }
  if (report.bidsWithoutTenderRow > 0) {
    write(
      `  ${num(report.bidsWithoutTenderRow)} tenders have bids but no tender row and are ` +
        `${report.bidsWithoutTenderRowExcluded ? 'excluded here, because a tender-side filter cannot be applied to them' : 'included above'}\n`,
    );
  }

  write(subheading('Bidders per tender'));
  write(
    table(
      [
        { header: 'bidders', get: (r) => r.label, align: 'right' },
        { header: 'tenders', get: (r) => num(r.tenders), align: 'right' },
        { header: 'share', get: (r) => pct(r.share), align: 'right' },
      ],
      report.bidderDistribution,
    ),
  );
  write('  a bidder is a distinct cedula_proveedor, not a distinct offer\n');
  if (a.month && !a.bidMonth) {
    write(
      '  --month scopes to the tenders that archive published and counts every bid on them from\n' +
        '  any archive, so these tenders are still accumulating bids. --bid-month scopes to the bids\n' +
        "  that archive published, which is what a single month's Ofertas.csv holds.\n",
    );
  }

  const e = report.exceptions;
  write(subheading('Competition exceptions'));
  write(`  ${num(e.withException)} of ${num(e.tendersPublished)} published tenders cited an exception: ${pct(e.rate)}\n`);
  write(
    `  excluding small-value direct contracting: ${num(e.substantive)} tenders, ${pct(e.rateExcludingLowValue)}` +
      ' <- the figure to compare across time\n',
  );
  if (e.undescribedCodes > 0) {
    write(
      `  ${num(e.undescribedCodes)} further tenders carry a cod_excepcion with no description; that is a different\n` +
        '  code family and counting it would inflate the rate\n',
    );
  }
  write(bullets(e.warnings));
  write(
    table(
      [
        { header: 'reason', get: (r) => truncate(r.description, 58) },
        { header: 'kind', get: (r) => (r.family === 'low-value-threshold' ? 'low-value' : 'substantive') },
        { header: 'tenders', get: (r) => num(r.tenders), align: 'right' },
        { header: 'share', get: (r) => pct(r.share), align: 'right' },
      ],
      e.byReason.slice(0, a.limit ?? 12),
    ),
  );

  const d = report.deserted;
  write(subheading('Deserted and unsuccessful'));
  write(`  ${num(d.noAward)} ended with no award: ${pct(d.rateOfResolved)} of the ${num(d.awarded + d.noAward)} resolved tenders\n`);
  write(`  the same figure over all ${num(d.tendersPublished)} published tenders is ${pct(d.rateOfPublished)}\n`);
  write(`  ${num(d.inProgress)} are still in progress and cannot be classified yet\n`);
  if (d.unclassified > 0) {
    write(
      bullets([
        `${num(d.unclassified)} tenders carry a status this build does not recognise ` +
          `(${d.unclassifiedStatuses.slice(0, 5).join(', ')}); they are outside every rate above`,
      ]),
    );
  }
  write(
    table(
      [
        { header: 'cartel_stat', get: (r) => truncate(r.status, 40) },
        { header: 'counted as', get: (r) => r.class },
        { header: 'tenders', get: (r) => num(r.tenders), align: 'right' },
      ],
      d.byStatus.slice(0, a.limit ?? 20),
    ),
  );

  const c = report.concentration;
  write(subheading(`Award concentration (${c.currency})`));
  if (c.hhi === null) {
    write(`  no awarded value in ${c.currency} in this window\n`);
  } else {
    write(`  HHI ${num(c.hhi)} across ${num(c.n)} suppliers, ${money(c.total, c.currency)} awarded\n`);
    write(`  top supplier holds ${pct(c.topShare)}; effective competitors ${num(c.effectiveCompetitors, 1)}\n`);
    write(`  ${num(c.excludedOtherCurrency)} award lines excluded as another currency, ${num(c.excludedNoAmount)} for a missing amount\n`);
    if (c.awardsWithoutTenderRow > 0) {
      write(
        `  ${num(c.awardsWithoutTenderRow)} award lines sit on tenders with no tender row and are ` +
          `${c.awardsWithoutTenderRowExcluded ? 'excluded here' : 'included above'}\n`,
      );
    }
    write('  superseded award acts are dropped; only the latest act on each line counts\n');
    write(
      table(
        [
          { header: 'supplier', get: (r) => r.cedulaProveedor },
          { header: 'awarded', get: (r) => money(r.value, c.currency), align: 'right' },
          { header: 'share', get: (r) => pct(r.share), align: 'right' },
          { header: 'lines', get: (r) => num(r.lines), align: 'right' },
        ],
        c.top,
      ),
    );
  }
  write('\n  HHI below 1500 is unconcentrated, 1500 to 2500 moderate, above 2500 concentrated.\n');
  write('  Mixed-currency totals are not converted; the index does not store an exchange rate.\n');
}

// ---------------------------------------------------------------------------

function cmdDuration(db: Db, a: Args): void {
  const report = durationReport(db, {
    from: a.from,
    to: a.to,
    month: a.month,
    institution: a.institution,
    grain: a.grain,
    stages: a.stage ? [a.stage] : undefined,
  });
  if (a.json) return emitJson(report);

  write(heading('Stage durations'));
  write(`  window: ${windowLine(a)}\n`);
  write(`  observation date ${report.asOf} (from ${report.asOfSource}), grain ${a.grain ?? 'procedure'}\n`);
  if (report.missing.length) {
    write(bullets([`no rows in ${report.missing.join(', ')}; nothing below is a measurement`]));
    return;
  }
  if (report.stages.length === 0) {
    write(bullets([`no stage matched ${a.stage}; known stages are ${STAGES.map((s) => s.key).join(', ')}`]));
    return;
  }

  write(
    table(
      [
        { header: 'stage', get: (s) => s.label },
        { header: 'n done', get: (s) => num(s.completed), align: 'right' },
        { header: 'median', get: (s) => fmtDays(s.days.median), align: 'right' },
        { header: 'p75', get: (s) => fmtDays(s.days.p75), align: 'right' },
        { header: 'p90', get: (s) => fmtDays(s.days.p90), align: 'right' },
        { header: 'unfinished', get: (s) => num(s.censored), align: 'right' },
        { header: 'censored', get: (s) => pct(s.censoringRate), align: 'right' },
        { header: 'K-M median', get: (s) => (s.kaplanMeier.reached ? fmtDays(s.kaplanMeier.median) : 'not reached'), align: 'right' },
      ],
      report.stages,
    ),
  );

  for (const s of report.stages) {
    write(subheading(s.label));
    write(
      `  examined ${num(s.n)}: ${num(s.completed)} completed, ${num(s.censored)} still running, ` +
        `${num(s.notStarted)} never entered the stage, ${num(s.negative)} with an impossible date order\n`,
    );
    if (s.censored > 0) {
      write(
        `  the ${num(s.censored)} unfinished cases have already run a median of ${fmtDays(s.censoredElapsed.median)} ` +
          `(p90 ${fmtDays(s.censoredElapsed.p90)}) and are still open\n`,
      );
    }
    if (s.note) write(`  note: ${s.note}\n`);
    write(bullets(s.warnings));
  }

  write('\n');
  write(
    wrap(
      'Completed-only percentiles describe the procedures that finished. Where the censored share is high they ' +
        'describe the fast ones and nothing else. The Kaplan-Meier column uses the unfinished cases properly and ' +
        'refuses to give a median when the survival curve never crosses 50%, which is the honest answer rather ' +
        'than a missing one.',
    ),
  );
}

// ---------------------------------------------------------------------------

function cmdPrices(db: Db, a: Args): void {
  const opts = {
    from: a.from,
    to: a.to,
    month: a.month,
    institution: a.institution,
    currency: a.currency,
    minSample: a.minSample,
    source: a.source,
  };

  if (a.code) {
    const bench = benchmarkProduct(db, a.code, opts);
    if (a.json) return emitJson(bench);
    write(heading(`Product ${bench.codigoProducto}`));
    write(`  window: ${windowLine(a)}, currency ${bench.currency}, source ${bench.source}\n`);
    write(
      `  ${num(bench.n)} usable rows; excluded ${num(bench.excluded.otherCurrency)} other-currency, ` +
        `${num(bench.excluded.nonPositive)} non-positive, ${num(bench.excluded.missing)} missing\n`,
    );
    if (bench.stats) {
      const s = bench.stats;
      write(subheading('Unit price'));
      write(
        table(
          [
            { header: 'statistic', get: (r) => r.k },
            { header: 'value', get: (r) => r.v, align: 'right' },
          ],
          [
            { k: 'n', v: num(s.n) },
            { k: 'p25', v: money(s.p25) },
            { k: 'median', v: money(s.median) },
            { k: 'p75', v: money(s.p75) },
            { k: 'interquartile range', v: money(s.iqr) },
            { k: 'p75 / p25', v: ratio(bench.iqrRatio) },
            { k: 'MAD (scaled)', v: money(s.mad) },
            { k: 'dispersion', v: bench.dispersion ?? '-' },
            { k: 'populated decades', v: num(bench.magnitudeBuckets) },
          ],
        ),
      );
      write(`  full range ${money(s.min)} to ${money(s.max)} (${ratio(bench.spreadRatio)}), reported for completeness only\n`);
    }
    if (!bench.usable) {
      write(bullets([`not usable for comparison: ${bench.reason}`]));
      write(wrap(bench.caveat));
      return;
    }
    write(subheading(`Above the upper fence (${bench.outlierRule})`));
    write(
      table(
        [
          { header: 'tender', get: (o) => o.nroSicop },
          { header: 'line', get: (o) => o.nroLinea, align: 'right' },
          { header: 'supplier', get: (o) => o.cedulaProveedor ?? '-' },
          { header: 'unit price', get: (o) => money(o.unitPrice), align: 'right' },
          { header: 'x median', get: (o) => ratio(o.ratioToMedian), align: 'right' },
          { header: 'qty', get: (o) => num(o.cantidad, 2), align: 'right' },
          { header: 'excess', get: (o) => money(o.excessValue, bench.currency), align: 'right' },
        ],
        bench.outliers.slice(0, a.limit ?? 20),
      ),
    );
    write(wrap(bench.caveat));
    return;
  }

  const scan = scanPrices(db, { ...opts, limit: a.limit ?? 50 });
  if (a.json) return emitJson(scan);
  write(heading('Price outlier scan'));
  write(`  window: ${windowLine(a)}, currency ${scan.currency}, source ${scan.source}\n`);
  if (scan.missing.length) {
    write(bullets([`no rows in ${scan.missing.join(', ')}; nothing below is a measurement`]));
    return;
  }
  write(
    `  examined ${num(scan.codesExamined)} product codes, ${num(scan.codesUsable)} passed the homogeneity guards, ` +
      `${num(scan.codesRejected.length)} were rejected\n`,
  );
  write(subheading('Outliers, from usable codes only'));
  write(
    table(
      [
        { header: 'code', get: (o) => o.codigoProducto },
        { header: 'tender', get: (o) => o.nroSicop },
        { header: 'supplier', get: (o) => o.cedulaProveedor ?? '-' },
        { header: 'unit price', get: (o) => money(o.unitPrice), align: 'right' },
        { header: 'x median', get: (o) => ratio(o.ratioToMedian), align: 'right' },
        { header: 'excess', get: (o) => money(o.excessValue, scan.currency), align: 'right' },
      ],
      scan.outliers.slice(0, a.limit ?? 25),
    ),
  );
  write(subheading('Rejected codes'));
  write(
    table(
      [
        { header: 'code', get: (r) => r.codigoProducto },
        { header: 'n', get: (r) => num(r.n), align: 'right' },
        { header: 'reason', get: (r) => truncate(r.reason, 88) },
      ],
      scan.codesRejected.slice(0, a.limit ?? 15),
    ),
  );
  write(wrap(scan.caveat));
}

// ---------------------------------------------------------------------------

function cmdCollusion(db: Db, a: Args): void {
  const opts = {
    from: a.from,
    to: a.to,
    month: a.month,
    institution: a.institution,
    minTenders: a.minTenders,
    limit: a.limit,
  };
  const only = a.screen;
  const report =
    only === 'rotation'
      ? { rotation: bidRotation(db, opts) }
      : only === 'losing'
        ? { consistentLosing: consistentLosing(db, opts) }
        : only === 'spread'
          ? { bidSpread: bidSpread(db, opts) }
          : only === 'single'
            ? { singleBidderConcentration: singleBidderConcentration(db, opts) }
            : collusionReport(db, opts);
  if (a.json) return emitJson(report);

  write(heading('Bid-pattern screens'));
  write(`  window: ${windowLine(a)}\n\n`);
  write(
    wrap(
      'These are screens, not findings. A high score means the pattern is unusual enough that a person should ' +
        'open the listed tenders. Concentrated markets, product specialisation and shared supplier price lists all ' +
        'produce every pattern below with no agreement between anyone.',
    ),
  );

  const r = (report as { rotation?: ReturnType<typeof bidRotation> }).rotation;
  if (r) {
    write(subheading(`${r.screen}: ${r.hits.length} of ${num(r.testsPerformed)} bidder groups`));
    write(
      table(
        [
          { header: 'suppliers', get: (h) => h.group.join(', ') },
          { header: 'tenders', get: (h) => num(h.coBidTenders), align: 'right' },
          { header: 'decided', get: (h) => num(h.decidedTenders), align: 'right' },
          { header: 'winners', get: (h) => num(h.distinctWinners), align: 'right' },
          { header: 'evenness', get: (h) => num(h.evenness, 2), align: 'right' },
          { header: 'score', get: (h) => num(h.score, 2), align: 'right' },
          { header: 'example tenders', get: (h) => h.nroSicop.slice(0, 3).join(' ') },
        ],
        r.hits,
      ),
    );
    write(bullets(r.notes, '-'));
  }

  const cl = (report as { consistentLosing?: ReturnType<typeof consistentLosing> }).consistentLosing;
  if (cl) {
    write(subheading(`${cl.screen}: ${cl.hits.length} of ${num(cl.testsPerformed)} pairs tested`));
    write(
      table(
        [
          { header: 'loser', get: (h) => h.loser },
          { header: 'winner', get: (h) => h.winner },
          { header: 'meetings', get: (h) => num(h.encounters), align: 'right' },
          { header: 'losses', get: (h) => num(h.winnerWins), align: 'right' },
          { header: 'p', get: (h) => h.pValue.toExponential(1), align: 'right' },
          { header: 'p adj', get: (h) => h.pValueAdjusted.toExponential(1), align: 'right' },
          { header: 'example tenders', get: (h) => h.nroSicop.slice(0, 3).join(' ') },
        ],
        cl.hits,
      ),
    );
    write(bullets(cl.notes, '-'));
  }

  const bs = (report as { bidSpread?: ReturnType<typeof bidSpread> }).bidSpread;
  if (bs) {
    write(subheading(`${bs.screen}: ${bs.hits.length} of ${num(bs.testsPerformed)} pairs, ${num(bs.population)} comparable lines`));
    write(
      table(
        [
          { header: 'winner', get: (h) => h.winner },
          { header: 'loser', get: (h) => h.loser },
          { header: 'lines', get: (h) => num(h.lines), align: 'right' },
          { header: 'median gap', get: (h) => `${h.medianGapPct.toFixed(1)}%`, align: 'right' },
          { header: 'cv', get: (h) => num(h.cv, 3), align: 'right' },
          { header: 'score', get: (h) => num(h.score, 2), align: 'right' },
          { header: 'example tenders', get: (h) => h.nroSicop.slice(0, 3).join(' ') },
        ],
        bs.hits,
      ),
    );
    write(bullets(bs.notes, '-'));
  }

  const sc = (report as { singleBidderConcentration?: ReturnType<typeof singleBidderConcentration> })
    .singleBidderConcentration;
  if (sc) {
    write(subheading(`${sc.screen}: ${sc.hits.length} of ${num(sc.testsPerformed)} supplier-institution pairs`));
    write(
      table(
        [
          { header: 'supplier', get: (h) => h.cedulaProveedor },
          { header: 'institution', get: (h) => truncate(h.institucion ?? h.cedulaInstitucion, 38) },
          { header: 'sole bids', get: (h) => num(h.soleBidTenders), align: 'right' },
          { header: 'won', get: (h) => num(h.soleBidWins), align: 'right' },
          { header: 'of inst.', get: (h) => pct(h.shareOfInstitutionSingleBidder), align: 'right' },
          { header: 'of supp.', get: (h) => pct(h.shareOfSupplierTenders), align: 'right' },
          { header: 'score', get: (h) => num(h.score, 2), align: 'right' },
        ],
        sc.hits,
      ),
    );
    write(bullets(sc.notes, '-'));
  }
}

// ---------------------------------------------------------------------------

function cmdSupplier(db: Db, a: Args): void {
  if (!a.supplier) throw new Error('supplier requires --supplier CEDULA');
  const p = supplierProfile(db, a.supplier, {
    from: a.from,
    to: a.to,
    month: a.month,
    institution: a.institution,
    limit: a.limit,
  });
  if (a.json) return emitJson(p);

  write(heading(`Supplier ${p.identity.cedulaProveedor}`));
  write(`  ${p.identity.nombre ?? '(name not in the supplier table)'}\n`);
  write(
    `  ${[p.identity.tipo, p.identity.tamano, p.identity.zonaGeo].filter(Boolean).join(' | ') || '(no profile fields)'}\n`,
  );
  write(`  window: ${windowLine(a)}\n`);
  if (p.missing.length) {
    write(bullets([`no rows in ${p.missing.join(', ')}; nothing below is a measurement`]));
    return;
  }

  write(subheading('Win rate'));
  write(`  ${num(p.overall.won)} wins from ${num(p.overall.decided)} decided tenders: ${pct(p.overall.rate)}\n`);
  if (p.overall.ci95) write(`  95% interval ${pct(p.overall.ci95.low)} to ${pct(p.overall.ci95.high)}\n`);
  write(`  ${num(p.overall.undecided)} tenders bid on are still undecided and are not in that denominator\n`);
  write(
    table(
      [
        { header: 'period', get: (r) => r.period },
        { header: 'decided', get: (r) => num(r.decided), align: 'right' },
        { header: 'won', get: (r) => num(r.won), align: 'right' },
        { header: 'win rate', get: (r) => pct(r.rate), align: 'right' },
        { header: 'undecided', get: (r) => num(r.undecided), align: 'right' },
      ],
      p.byPeriod,
    ),
  );

  write(subheading('Who took the work'));
  write(
    table(
      [
        { header: 'winner', get: (r) => r.cedulaProveedor },
        { header: 'name', get: (r) => truncate(r.nombre, 34) },
        { header: 'times', get: (r) => num(r.times), align: 'right' },
        { header: 'median gap', get: (r) => (r.medianGapPct === null ? '-' : `${r.medianGapPct.toFixed(1)}%`), align: 'right' },
        { header: 'lines', get: (r) => num(r.gapLines), align: 'right' },
        { header: 'sanctioned', get: (r) => (r.sanctioned ? 'yes' : '') },
      ],
      p.beatenBy,
    ),
  );
  write('  median gap is how far above the rival this supplier priced, on lines both quoted in the same currency\n');

  write(subheading('Product codes'));
  write(
    table(
      [
        { header: 'code', get: (r) => r.codigoProducto },
        { header: 'bid on', get: (r) => num(r.bidTenders), align: 'right' },
        { header: 'won', get: (r) => num(r.wonTenders), align: 'right' },
        { header: 'win rate', get: (r) => pct(r.winRate), align: 'right' },
      ],
      p.products,
    ),
  );

  write(subheading('Institutions'));
  write(
    table(
      [
        { header: 'institution', get: (r) => r.cedulaInstitucion },
        { header: 'name', get: (r) => truncate(r.nombre, 40) },
        { header: 'decided', get: (r) => num(r.decided), align: 'right' },
        { header: 'won', get: (r) => num(r.won), align: 'right' },
        { header: 'win rate', get: (r) => pct(r.winRate), align: 'right' },
      ],
      p.institutions,
    ),
  );

  write(subheading('Appeals filed'));
  write(`  ${num(p.appeals.filed)} filed, ${num(p.appeals.decided)} decided, ${pct(p.appeals.successRate)} upheld in whole or part\n`);
  write(
    table(
      [
        { header: 'result', get: (r) => r.resultado },
        { header: 'appeals', get: (r) => num(r.appeals), align: 'right' },
      ],
      p.appeals.byResult,
    ),
  );
  write('  across the whole register roughly 30% of decided appeals succeed; compare against that, not against zero\n');

  if (p.ownSanctions.length > 0) {
    write(subheading('Sanctions on this supplier'));
    write(
      table(
        [
          { header: 'type', get: (r) => truncate(r.tipo, 40) },
          { header: 'from', get: (r) => r.inicio ?? '-' },
          { header: 'to', get: (r) => r.final ?? '-' },
          { header: 'state', get: (r) => r.estado ?? '-' },
        ],
        p.ownSanctions,
      ),
    );
  }
  write('\n');
  write(bullets(p.notes, '-'));
}

// ---------------------------------------------------------------------------

function cmdInstitution(db: Db, a: Args): void {
  if (!a.institution) throw new Error('institution requires --institution CEDULA');
  const b = benchmarkInstitution(db, a.institution, {
    from: a.from,
    to: a.to,
    month: a.month,
    minSample: a.minSample,
    allPeers: a.allPeers,
  });
  if (a.json) return emitJson(b);

  write(heading(`Institution ${b.cedulaInstitucion}`));
  write(`  ${b.nombre ?? '(name not in the institution table)'}\n`);
  // Deliberately not windowLine: --institution scopes the subject, and the peer
  // set has to stay national or the percentile means nothing.
  const span = [a.month && `source month ${a.month}`, a.from && `from ${a.from}`, a.to && `to ${a.to}`]
    .filter(Boolean)
    .join(', ');
  write(`  window: ${span || 'all loaded data'}; peers are drawn from every institution in it\n`);
  write(`  ${num(b.tendersPublished)} tenders published\n`);
  write(`  peers: ${num(b.peerSelection.peers)} of ${num(b.peerSelection.candidates)} institutions, by ${b.peerSelection.rule}\n`);
  if (b.missing.length) {
    write(bullets([`no rows in ${b.missing.join(', ')}; nothing below is a measurement`]));
    return;
  }

  write(
    table(
      [
        { header: 'metric', get: (m) => m.label },
        {
          header: 'value',
          get: (m) => (m.value === null ? '-' : m.key.endsWith('_days') ? fmtDays(m.value) : pct(m.value)),
          align: 'right',
        },
        { header: 'n', get: (m) => num(m.n), align: 'right' },
        {
          header: 'peer median',
          get: (m) => (m.peerMedian === null ? '-' : m.key.endsWith('_days') ? fmtDays(m.peerMedian) : pct(m.peerMedian)),
          align: 'right',
        },
        { header: 'peers', get: (m) => num(m.peerN), align: 'right' },
        { header: 'standing', get: (m) => (m.standing === null ? '-' : pct(m.standing, 0)), align: 'right' },
      ],
      b.metrics,
    ),
  );

  const suppressed = b.metrics.filter((m) => m.suppressed);
  if (suppressed.length) {
    write(subheading('Not ranked'));
    write(bullets(suppressed.map((m) => `${m.label}: ${m.suppressed}`)));
  }
  write('\n');
  write(bullets(b.notes, '-'));
}

function cmdRank(db: Db, a: Args): void {
  const metric = a.metric ?? 'single_bidder_rate';
  const r = rankInstitutions(db, metric, { from: a.from, to: a.to, month: a.month, minSample: a.minSample });
  if (a.json) return emitJson(r);
  write(heading(`Ranking: ${r.label}`));
  write(`  window: ${windowLine(a)}, minimum ${r.minSample} observations per institution\n`);
  write(`  ${r.lowerIsBetter ? 'lower is better, so the top of this table is the worst end' : 'higher is better'}\n`);
  write(
    table(
      [
        { header: 'institution', get: (row) => truncate(row.nombre ?? row.cedulaInstitucion, 46) },
        { header: 'cedula', get: (row) => row.cedulaInstitucion },
        { header: 'value', get: (row) => (metric.endsWith('_days') ? fmtDays(row.value) : pct(row.value)), align: 'right' },
        { header: 'n', get: (row) => num(row.n), align: 'right' },
        { header: 'tenders', get: (row) => num(row.tendersPublished), align: 'right' },
      ],
      r.rows.slice(0, a.limit ?? 25),
    ),
  );
}

// ---------------------------------------------------------------------------

const USAGE = `ancla analytics

  competition   single-bidder rate, bidder distribution, exception usage, deserted rate, award concentration
  duration      stage durations with censoring reported, never hidden
  prices        unit price benchmarking by codigo_producto, with a homogeneity guard
  collusion     bid-pattern screens: rotation, consistent losing, bid spread, single-bidder concentration
  supplier      win/loss forensics for one supplier    (--supplier CEDULA)
  institution   peer benchmark for one institution     (--institution CEDULA)
  rank          national ranking on one metric         (--metric ${METRIC_KEYS.join('|')})

Common flags
  --json                    full structure instead of tables
  --db PATH                 index to read (default ${indexPath()})
  --from YYYY-MM-DD         publication date lower bound, inclusive
  --to YYYY-MM-DD           publication date upper bound, inclusive
  --month YYYYMM            restrict to tenders published in one source archive month
  --bid-month YYYYMM        competition: count bids from one source archive instead
  --institution CEDULA      restrict to one buyer
  --limit N                 rows per table

Command flags
  --grain procedure|line    duration: unit of observation (default procedure)
  --stage KEY               duration: one stage only (${STAGES.map((s) => s.key).join(', ')})
  --code CODIGO             prices: one product code instead of a scan
  --currency CRC            prices, competition: single currency, never mixed
  --source award|bid        prices: award lines (default) or bid lines
  --min-sample N            prices, institution, rank: minimum observations
  --min-tenders N           collusion: minimum repeats before a pattern is reported
  --screen NAME             collusion: rotation | losing | spread | single
  --metric KEY              rank: which metric to rank on
  --all-peers               institution: rank against every institution, not a volume band
`;

export function main(argv: string[]): number {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (!args.command || args.help) {
    write(USAGE);
    return args.command ? 0 : 2;
  }

  const path = args.db ?? indexPath();
  if (!existsSync(path)) {
    process.stderr.write(
      `No index at ${path}.\nThe analytics read an index built by the indexer; build it first, or pass --db PATH.\n`,
    );
    return 1;
  }

  let db: Db;
  try {
    db = openDb(path, { readonly: true });
  } catch (err) {
    process.stderr.write(`Could not open ${path}: ${(err as Error).message}\n`);
    return 1;
  }

  try {
    switch (args.command) {
      case 'competition': cmdCompetition(db, args); break;
      case 'duration': cmdDuration(db, args); break;
      case 'prices': cmdPrices(db, args); break;
      case 'collusion': cmdCollusion(db, args); break;
      case 'supplier': cmdSupplier(db, args); break;
      case 'institution': cmdInstitution(db, args); break;
      case 'rank': cmdRank(db, args); break;
      default:
        process.stderr.write(`unknown command ${args.command}\n\n${USAGE}`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  } finally {
    db.close();
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = main(process.argv.slice(2));
}
