/**
 * The public API. node:http, no framework, no dependencies.
 *
 * Design rules, in the order they matter:
 *
 *   1. Never 500 because a store is not built yet. The ingest, the snapshots and
 *      the chain each fail independently, and a public site has to keep answering
 *      while any one of them is missing. Endpoints say what they could not read.
 *   2. Read only. Nothing here writes to disk or to the chain. That is what makes
 *      it safe to put in front of the internet with no auth.
 *   3. Every user-facing string comes from the catalogue in i18n.ts, so the same
 *      response in Spanish and English differ only in the strings.
 *
 * Routes (GET unless stated):
 *
 *   /health                        service and store status
 *   /i18n/:lang                    the message catalogue the web app renders with
 *   /months                        months mirrored, and how many versions of each
 *   /stats                         index and feed totals for the landing page
 *   /anchors                       every anchored day read off the chain
 *   /anchors/:day                  the roots anchored on one day
 *   /reports                       the daily watch runs
 *   /changes                       the classified change feed
 *   /tenders/:nroSicop             one procedure, with bids, awards and contracts
 *   /suppliers/:cedula             one supplier's participation
 *   /institutions/:cedula          one institution's procedures
 *   /proof/:month/:table/:id       the Merkle proof the verifier consumes
 *   /versions[/:period]            every copy held, and whether it is anchored
 *   /bundles[/:period]             published row-level diffs
 *   /bundles/:period/:pair         one bundle's manifest
 *   /bundles/:period/:pair/fields  which fields moved, and how
 *   /bundles/:period/:pair/changes a page of that bundle's changed rows
 *   /recovery                      what can still be recovered, and what cannot
 *   /ocds/:month                   an OCDS 1.1 release package
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { chainSnapshot, anchorAddress, anchorNode } from './chain.ts';
import {
  bundleChanges,
  bundleFields,
  bundleManifest,
  bundleSummaries,
  captures,
  count,
  feed,
  index,
  monthVersions,
  proofFor,
  recovery,
  reportSummaries,
  rows,
  storedMonths,
  type FeedItem,
} from './data.ts';
import {
  DEFAULT_LANG,
  CATALOGUE,
  isLang,
  kindLabel,
  type Lang,
  type MessageKey,
  pickLang,
  t,
  tableLabel,
} from './i18n.ts';
import { packageForMonth, tenderByNumber, loadRelease, buildRelease } from './ocds.ts';
import { IndexResolver, keyDates, type SubjectResolver } from './resolve.ts';

const MONTH_RE = /^\d{6}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  lang: Lang;
  segments: string[];
  /** Per-request, so one request's joins are memoised and the next starts clean. */
  resolver: SubjectResolver;
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function cors(res: ServerResponse): void {
  // The whole API is public read-only data, so any origin may read it. Credentials
  // are never accepted, which is why the wildcard is safe here.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type, accept-language');
  res.setHeader('access-control-max-age', '86400');
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': status === 200 ? 'public, max-age=30' : 'no-store',
  });
  res.end(text);
}

function fail(
  ctx: Ctx,
  status: number,
  code: string,
  key: MessageKey,
  params: Record<string, string | number> = {},
): void {
  sendJson(ctx.res, status, { error: { code, message: t(key, ctx.lang, params) } });
}

function num(v: string | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

function institutionName(cedula: string | null): string | null {
  if (!cedula) return null;
  return (
    rows<{ nombre: string }>('SELECT nombre FROM institution WHERE cedula = ? LIMIT 1', [cedula])[0]
      ?.nombre ?? null
  );
}

function supplierName(cedula: string | null): string | null {
  if (!cedula) return null;
  return (
    rows<{ nombre: string }>(
      'SELECT nombre FROM supplier WHERE cedula_proveedor = ? LIMIT 1',
      [cedula],
    )[0]?.nombre ?? null
  );
}

function shapeChange(item: FeedItem, ctx: Ctx) {
  const subject = ctx.resolver.resolve(item.table, item.id);
  return {
    detectedAt: item.detectedAt,
    month: item.month,
    closedMonth: item.closedMonth,
    previousStamp: item.previousStamp,
    currentStamp: item.currentStamp,
    kind: item.kind,
    kindLabel: kindLabel(item.kind, ctx.lang),
    kindDescription: t(`kind.${item.kind}.desc` as MessageKey, ctx.lang),
    table: item.table,
    tableLabel: tableLabel(item.table, ctx.lang),
    id: item.id,
    nroSicop: subject.nroSicop,
    institution:
      subject.institution ?
        { cedula: subject.institution, nombre: institutionName(subject.institution) }
      : null,
    before: item.before ?? null,
    after: item.after ?? null,
    proof: `/proof/${item.month}/${encodeURIComponent(item.table)}/${encodeURIComponent(item.id)}`,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function health(ctx: Ctx): Promise<void> {
  const hasIndex = index() !== null;
  const months = await storedMonths();
  const chain = await chainSnapshot();
  sendJson(ctx.res, 200, {
    status: hasIndex && chain.reachable ? 'ok' : 'degraded',
    statusLabel: t(hasIndex && chain.reachable ? 'status.ok' : 'status.degraded', ctx.lang),
    lang: ctx.lang,
    stores: {
      index: hasIndex ? 'ready' : 'missing',
      snapshots: months.length,
      chain: chain.reachable ? 'reachable' : 'unreachable',
    },
    chain: { address: chain.address, node: chain.node, height: chain.height, latest: chain.latest },
    time: new Date().toISOString(),
  });
}

function i18nRoute(ctx: Ctx): void {
  const requested = ctx.segments[1];
  const lang = isLang(requested) ? requested : ctx.lang;
  sendJson(ctx.res, 200, {
    lang,
    default: DEFAULT_LANG,
    languages: Object.keys(CATALOGUE),
    messages: CATALOGUE[lang],
  });
}

async function monthsRoute(ctx: Ctx): Promise<void> {
  const list = await storedMonths();
  const out = [];
  for (const m of list) {
    const versions = await monthVersions(m);
    out.push({ month: m, versions: versions.length, stamps: versions.map((v) => v.stamp) });
  }
  sendJson(ctx.res, 200, { months: out, total: out.length });
}

async function stats(ctx: Ctx): Promise<void> {
  const hasIndex = index() !== null;
  const items = await feed();
  const byKind: Record<string, number> = {};
  for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
  const chain = await chainSnapshot();
  sendJson(ctx.res, 200, {
    index: {
      available: hasIndex,
      note: hasIndex ? null : t('error.noIndex', ctx.lang),
      tenders: hasIndex ? count('tender') : 0,
      contracts: hasIndex ? count('contract') : 0,
      suppliers: hasIndex ? count('supplier') : 0,
      institutions: hasIndex ? count('institution') : 0,
      appeals: hasIndex ? count('appeal') : 0,
    },
    archives: { months: (await storedMonths()).length },
    changes: { total: items.length, byKind },
    anchors: {
      days: chain.days.length,
      latest: chain.latest,
      address: chain.address,
      reachable: chain.reachable,
    },
  });
}

async function anchors(ctx: Ctx): Promise<void> {
  const chain = await chainSnapshot();
  const day = ctx.segments[1];
  if (!day) {
    sendJson(ctx.res, 200, {
      address: chain.address,
      node: chain.node,
      reachable: chain.reachable,
      height: chain.height,
      latest: chain.latest,
      error: chain.error ?? null,
      days: chain.days,
    });
    return;
  }
  if (!DAY_RE.test(day)) return fail(ctx, 400, 'bad_day', 'error.badDay');
  const found = chain.days.find((d) => d.day === day);
  if (!found) {
    return fail(ctx, 404, 'no_anchor', 'error.notFound', { what: `anchor ${day}` });
  }
  sendJson(ctx.res, 200, { address: chain.address, node: chain.node, ...found });
}

async function reports(ctx: Ctx): Promise<void> {
  sendJson(ctx.res, 200, { reports: await reportSummaries() });
}

async function changes(ctx: Ctx): Promise<void> {
  const q = ctx.url.searchParams;
  const limit = Math.min(Math.max(num(q.get('limit'), 100), 1), 1000);
  const offset = Math.max(num(q.get('offset'), 0), 0);
  const date = q.get('date');
  const month = q.get('month');
  const kind = q.get('kind');
  const table = q.get('table');
  const institution = q.get('institution');
  const nroSicop = q.get('tender');

  if (month && !MONTH_RE.test(month)) return fail(ctx, 400, 'bad_month', 'error.badMonth');
  if (date && !DAY_RE.test(date)) return fail(ctx, 400, 'bad_day', 'error.badDay');

  let items = await feed();
  if (date) items = items.filter((i) => i.detectedAt.slice(0, 10) === date);
  if (month) items = items.filter((i) => i.month === month);
  if (kind) items = items.filter((i) => i.kind === kind);
  if (table) items = items.filter((i) => i.table === table);
  if (institution || nroSicop) {
    items = items.filter((i) => {
      const s = ctx.resolver.resolve(i.table, i.id);
      if (institution && s.institution !== institution) return false;
      if (nroSicop && s.nroSicop !== nroSicop) return false;
      return true;
    });
  }

  const page = items.slice(offset, offset + limit);
  const byKind: Record<string, number> = {};
  for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;

  sendJson(ctx.res, 200, {
    meta: {
      total: items.length,
      limit,
      offset,
      byKind,
      indexAvailable: index() !== null,
      // Without the index there is nothing to join a record to an institution, so
      // the filter is honest about returning nothing rather than silently ignoring.
      institutionFilterUsable: index() !== null,
    },
    changes: page.map((i) => shapeChange(i, ctx)),
  });
}

function tender(ctx: Ctx): void {
  const nro = ctx.segments[1];
  if (!nro) return fail(ctx, 400, 'bad_request', 'error.badRequest', { why: 'nroSicop' });
  if (!index()) return fail(ctx, 503, 'no_index', 'error.noIndex');
  const tn = tenderByNumber(nro);
  if (!tn) return fail(ctx, 404, 'not_found', 'error.notFound', { what: nro });

  const input = loadRelease(tn);
  const appeals = rows(
    'SELECT nro_recurso, linea_objetada, cedula_proveedor, tipo_recurso, resultado, causa_resultado, fecha_presentacion, recurso_stat FROM appeal WHERE nro_sicop = ?',
    [nro],
  );
  sendJson(ctx.res, 200, {
    nroSicop: nro,
    labels: {
      nroSicop: t('field.nroSicop', ctx.lang),
      institution: t('field.institution', ctx.lang),
      published: t('field.published', ctx.lang),
      opening: t('field.opening', ctx.lang),
      procedureType: t('field.procedureType', ctx.lang),
      modality: t('field.modality', ctx.lang),
      status: t('field.status', ctx.lang),
      estimatedAmount: t('field.estimatedAmount', ctx.lang),
      bids: t('field.bids', ctx.lang),
      awards: t('field.awards', ctx.lang),
      contracts: t('field.contracts', ctx.lang),
      appeals: t('field.appeals', ctx.lang),
    },
    tender: tn,
    institution:
      tn.cedula_institucion ?
        { cedula: tn.cedula_institucion, nombre: institutionName(tn.cedula_institucion) }
      : null,
    keyDates: keyDates(nro),
    bids: input.bids,
    bidLines: input.bidLines,
    awardLines: input.awardLines,
    contracts: input.contracts,
    suppliers: input.suppliers,
    appeals,
    ocds: buildRelease(input, ctx.lang),
    proof: `/proof/${tn.source_month}/DetalleCarteles/${encodeURIComponent(nro)}`,
  });
}

function supplier(ctx: Ctx): void {
  const cedula = ctx.segments[1];
  if (!cedula) return fail(ctx, 400, 'bad_request', 'error.badRequest', { why: 'cedula' });
  if (!index()) return fail(ctx, 503, 'no_index', 'error.noIndex');
  const record = rows(
    'SELECT cedula_proveedor, nombre, tipo, tamano, zona_geo, fecha_constitucion FROM supplier WHERE cedula_proveedor = ? LIMIT 1',
    [cedula],
  )[0];
  const bids = rows(
    'SELECT nro_sicop, nro_oferta, fecha_presenta, tipo_oferta, id_consorcio FROM bid WHERE cedula_proveedor = ? ORDER BY fecha_presenta DESC LIMIT 500',
    [cedula],
  );
  const awards = rows(
    'SELECT nro_sicop, nro_acto, nro_linea, codigo_producto, cantidad, precio_unitario, moneda FROM award_line WHERE cedula_proveedor = ? ORDER BY nro_sicop DESC LIMIT 500',
    [cedula],
  );
  const contracts = rows(
    'SELECT nro_contrato, secuencia, nro_sicop, cedula_institucion, tipo_contrato, tipo_modificacion, fecha_notificacion, moneda FROM contract WHERE cedula_proveedor = ? ORDER BY fecha_notificacion DESC LIMIT 500',
    [cedula],
  );
  const appeals = rows(
    'SELECT nro_recurso, nro_sicop, tipo_recurso, resultado, fecha_presentacion FROM appeal WHERE cedula_proveedor = ? ORDER BY fecha_presentacion DESC LIMIT 200',
    [cedula],
  );
  const sanctions = rows(
    'SELECT cedula_institucion, no_resolucion, tipo_sancion, descr_sancion, inicio_sancion, final_sancion, estado FROM sanction WHERE cedula_proveedor = ?',
    [cedula],
  );
  if (!record && !bids.length && !awards.length && !contracts.length) {
    return fail(ctx, 404, 'not_found', 'error.notFound', { what: cedula });
  }
  sendJson(ctx.res, 200, {
    cedula,
    nombre: (record as { nombre?: string })?.nombre ?? supplierName(cedula),
    supplier: record ?? null,
    counts: {
      bids: bids.length,
      awards: awards.length,
      contracts: contracts.length,
      appeals: appeals.length,
      sanctions: sanctions.length,
    },
    bids,
    awards,
    contracts,
    appeals,
    sanctions,
  });
}

function institution(ctx: Ctx): void {
  const cedula = ctx.segments[1];
  if (!cedula) return fail(ctx, 400, 'bad_request', 'error.badRequest', { why: 'cedula' });
  if (!index()) return fail(ctx, 503, 'no_index', 'error.noIndex');
  const record = rows(
    'SELECT cedula, nombre, zona_geo, fecha_ingreso FROM institution WHERE cedula = ? LIMIT 1',
    [cedula],
  )[0];
  const tenders = rows(
    'SELECT nro_sicop, nro_procedimiento, fecha_publicacion, tipo_procedimiento, cartel_stat, monto_est, source_month FROM tender WHERE cedula_institucion = ? ORDER BY fecha_publicacion DESC LIMIT 500',
    [cedula],
  );
  const contracts = rows<{ n: number }>(
    'SELECT COUNT(*) AS n FROM contract WHERE cedula_institucion = ?',
    [cedula],
  )[0];
  if (!record && !tenders.length) {
    return fail(ctx, 404, 'not_found', 'error.notFound', { what: cedula });
  }
  sendJson(ctx.res, 200, {
    cedula,
    nombre: (record as { nombre?: string })?.nombre ?? null,
    institution: record ?? null,
    counts: { tenders: tenders.length, contracts: contracts?.n ?? 0 },
    tenders,
  });
}

async function proof(ctx: Ctx): Promise<void> {
  const [, month, table, ...rest] = ctx.segments;
  const id = rest.map((s) => decodeURIComponent(s)).join('/');
  if (!month || !MONTH_RE.test(month)) return fail(ctx, 400, 'bad_month', 'error.badMonth');
  if (!table || !id) {
    return fail(ctx, 400, 'bad_request', 'error.badRequest', { why: 'table/id' });
  }
  const day = ctx.url.searchParams.get('day');
  const doc = await proofFor(month, decodeURIComponent(table), id, day);
  if (!doc) {
    // Distinguish "we hold no snapshot" from "we hold one and the record is absent",
    // because those mean very different things to someone checking a record.
    const held = (await storedMonths()).includes(month);
    return held ?
        fail(ctx, 404, 'no_record', 'error.noRecord', { table, id, month })
      : fail(ctx, 404, 'no_snapshot', 'error.noSnapshot', { month });
  }
  // Attach the anchored root for the day when one is on chain, so the page can
  // compare without a second round trip.
  const chain = await chainSnapshot();
  const anchored =
    chain.days
      .flatMap((d) => d.months.map((m) => ({ ...m, day: d.day })))
      .filter((m) => m.month === month && m.root === doc.merkleRoot)
      .sort((a, b) => (a.day < b.day ? -1 : 1))[0] ?? null;
  sendJson(ctx.res, 200, {
    ...doc,
    anchoredDay: doc.anchoredDay ?? anchored?.day ?? null,
    anchoredRoot: anchored?.root ?? null,
    anchorAddress: chain.address,
    anchorNode: chain.node,
    notes: [t('note.provesWhat', ctx.lang), t('note.forwardOnly', ctx.lang)],
  });
}

function ocds(ctx: Ctx): void {
  const month = ctx.segments[1];
  if (!month || !MONTH_RE.test(month)) return fail(ctx, 400, 'bad_month', 'error.badMonth');
  if (!index()) return fail(ctx, 503, 'no_index', 'error.noIndex');
  const q = ctx.url.searchParams;
  const built = packageForMonth(month, {
    lang: ctx.lang,
    limit: num(q.get('limit'), 100),
    offset: num(q.get('offset'), 0),
    uri: `${ctx.url.origin}${ctx.url.pathname}${ctx.url.search}`,
  });
  sendJson(ctx.res, 200, {
    ...built.package,
    // Paging lives beside the package rather than inside it, so the object under
    // "packages" stays a valid OCDS release package with no extra members.
    links: {
      total: built.total,
      limit: built.limit,
      offset: built.offset,
      next:
        built.offset + built.limit < built.total ?
          `/ocds/${month}?limit=${built.limit}&offset=${built.offset + built.limit}`
        : null,
    },
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

type Handler = (ctx: Ctx) => void | Promise<void>;

const ROUTES: Record<string, Handler> = {
  health,
  i18n: i18nRoute,
  months: monthsRoute,
  stats,
  anchors,
  reports,
  changes,
  tenders: tender,
  suppliers: supplier,
  institutions: institution,
  proof,
  versions,
  bundles,
  recovery: recoveryRoute,
  ocds,
};


// ---------------------------------------------------------------------------
// Versions, bundles and recovery
// ---------------------------------------------------------------------------

/**
 * A bundle directory name: two archive stamps joined by a double underscore, and
 * for anything past the first canonicaliser, the version that built it.
 */
const PAIR_RE = /^\d{8}T\d{6}Z__\d{8}T\d{6}Z(__ancla-canon-\d+)?$/;

async function versions(ctx: Ctx): Promise<void> {
  const period = ctx.segments[1];
  if (period && !MONTH_RE.test(period)) return fail(ctx, 400, 'bad_month', 'error.badMonth');
  const chain = await chainSnapshot();
  const list = await captures(period);
  if (period && !list.length) {
    return fail(ctx, 404, 'no_month', 'error.notFound', { what: period });
  }
  sendJson(ctx.res, 200, {
    anchor: { address: chain.address, node: chain.node, reachable: chain.reachable },
    // Absence of a commitment and inability to read the chain are different
    // answers, and a page that renders them the same way is lying by omission.
    anchorStateKnown: chain.reachable,
    // `path` is dropped: it is where the file sits on our disk, which is not the
    // reader's business and is the kind of thing that ends up in a bug report.
    captures: list.map(({ path: _path, ...rest }) => rest),
  });
}

async function bundles(ctx: Ctx): Promise<void> {
  const [, period, pair, tail] = ctx.segments;
  if (period && !MONTH_RE.test(period)) return fail(ctx, 400, 'bad_month', 'error.badMonth');

  if (!pair) {
    sendJson(ctx.res, 200, { bundles: await bundleSummaries(period) });
    return;
  }
  if (!PAIR_RE.test(pair)) return fail(ctx, 400, 'bad_pair', 'error.notFound', { what: pair });

  if (!tail) {
    const m = await bundleManifest(period as string, pair);
    if (!m) return fail(ctx, 404, 'no_bundle', 'error.notFound', { what: `${period}/${pair}` });
    const chain = await chainSnapshot();
    const onChain =
      chain.diffs.find(
        (d) =>
          d.period === m.period &&
          d.canonVersion === m.canonVersion &&
          d.fromId === m.from.archiveSha256.slice(0, 12) &&
          d.toId === m.to.archiveSha256.slice(0, 12),
      ) ?? null;
    sendJson(ctx.res, 200, {
      manifest: m,
      onChain,
      digestMatches: onChain ? onChain.bundleDigest === m.bundleDigest : null,
      anchorStateKnown: chain.reachable,
    });
    return;
  }

  if (tail === 'fields') {
    const summary = await bundleFields(period as string, pair);
    if (!summary) return fail(ctx, 404, 'no_bundle', 'error.notFound', { what: `${period}/${pair}` });
    sendJson(ctx.res, 200, { period, pair, ...summary });
    return;
  }

  if (tail !== 'changes') {
    return fail(ctx, 404, 'not_found', 'error.notFound', { what: tail });
  }
  const q = ctx.url.searchParams;
  const page = await bundleChanges(period as string, pair, {
    limit: num(q.get('limit'), 100),
    offset: num(q.get('offset'), 0),
    kind: q.get('kind'),
    table: q.get('table'),
    field: q.get('field'),
    numeric: q.get('numeric') === '1',
    readable: q.get('readable') === '1',
  });
  if (!page) return fail(ctx, 404, 'no_bundle', 'error.notFound', { what: `${period}/${pair}` });
  sendJson(ctx.res, 200, { period, pair, ...page });
}

async function recoveryRoute(ctx: Ctx): Promise<void> {
  const chain = await chainSnapshot();
  sendJson(ctx.res, 200, {
    anchorStateKnown: chain.reachable,
    // Stated in the payload because the classification depends on it: without the
    // chain, "nothing earlier exists" is really "nothing earlier is on this disk".
    caveat: chain.reachable ? null : 'chain unreachable; currentOnly may be priorAnchored',
    inventory: await recovery(),
  });
}

/**
 * A request handler that returns false when nothing matched, so the same routes can
 * be mounted standalone or under /api next to a static site.
 */
export function createRouter(prefix = ''): (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> {
  const normalized = prefix.replace(/\/$/, '');
  return async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    let path = url.pathname;
    if (normalized) {
      if (!path.startsWith(`${normalized}/`) && path !== normalized) return false;
      path = path.slice(normalized.length) || '/';
    }
    const segments = path.split('/').filter(Boolean);
    const head = segments[0] ?? '';
    const handler = ROUTES[head];
    if (!handler) return false;

    cors(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204).end();
      return true;
    }

    const lang = pickLang(url.searchParams.get('lang'), req.headers['accept-language'] ?? null);
    const ctx: Ctx = { req, res, url, lang, segments, resolver: new IndexResolver() };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fail(ctx, 405, 'method_not_allowed', 'error.method');
      return true;
    }
    try {
      await handler(ctx);
    } catch (err) {
      process.stderr.write(`api error on ${path}: ${(err as Error).stack}\n`);
      if (!res.headersSent) fail(ctx, 500, 'internal', 'error.internal');
      else res.end();
    }
    return true;
  };
}

function indexPage(res: ServerResponse, lang: Lang, prefix: string): void {
  sendJson(res, 200, {
    name: t('app.name', lang),
    tagline: t('app.tagline', lang),
    description: t('app.description', lang),
    anchor: { address: anchorAddress(), node: anchorNode() },
    endpoints: Object.keys(ROUTES)
      .sort()
      .map((k) => `${prefix}/${k}`),
    languages: Object.keys(CATALOGUE),
    defaultLanguage: DEFAULT_LANG,
  });
}

/** Standalone API server. `serve.ts` mounts the same router under /api instead. */
export function createApiServer(prefix = '') {
  const route = createRouter(prefix);
  return createServer(async (req, res) => {
    if (await route(req, res)) return;
    cors(res);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const lang = pickLang(url.searchParams.get('lang'), req.headers['accept-language'] ?? null);
    if (url.pathname === '/' || url.pathname === prefix || url.pathname === `${prefix}/`) {
      indexPage(res, lang, prefix);
      return;
    }
    sendJson(res, 404, {
      error: { code: 'not_found', message: t('error.notFound', lang, { what: url.pathname }) },
    });
  });
}

export { indexPage };

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.ANCLA_API_PORT ?? 8787);
  createApiServer().listen(port, () => {
    process.stdout.write(`ancla api on http://localhost:${port}\n`);
    process.stdout.write(`anchor ${anchorAddress()} via ${anchorNode()}\n`);
  });
}
