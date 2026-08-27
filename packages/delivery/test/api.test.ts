/**
 * The API, exercised over real HTTP.
 *
 * The server is started on an ephemeral port and every assertion goes through
 * fetch, because the things that break in an HTTP layer are status codes, headers
 * and encoding, and none of those are visible when a handler is called directly.
 */

import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApiServer } from '../src/api.ts';
import { leafFor } from '../../canonicalize/src/snapshot.ts';
import { verify as merkleVerify } from '../../merkle/src/index.ts';
import { ANCHOR_ADDRESS, ANCHOR_DAY, MONTH, makeFixture, type Fixture } from './fixture.ts';

let fixture: Fixture;
let base: string;
let server: ReturnType<typeof createApiServer>;

before(async () => {
  fixture = await makeFixture();
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await fixture.close();
});

async function get(path: string, init: RequestInit = {}) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { res, body: body as Record<string, unknown> };
}

test('GET /health reports every store separately', async () => {
  const { res, body } = await get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.stores, { index: 'ready', snapshots: 1, chain: 'reachable' });
  assert.equal((body.chain as Record<string, unknown>).address, ANCHOR_ADDRESS);
  assert.equal((body.chain as Record<string, unknown>).latest, ANCHOR_DAY);
});

test('responses are in Spanish by default and switch on ?lang', async () => {
  const es = await get('/tenders/does-not-exist');
  assert.equal(es.res.status, 404);
  assert.match(String((es.body.error as Record<string, string>).message), /No se encontró/);
  const en = await get('/tenders/does-not-exist?lang=en');
  assert.match(String((en.body.error as Record<string, string>).message), /Not found/);
});

test('Accept-Language is honoured when no query parameter is given', async () => {
  const { body } = await get('/health', { headers: { 'accept-language': 'en-US,en;q=0.9' } });
  assert.equal(body.lang, 'en');
});

test('CORS is open for reads and preflight is answered', async () => {
  const { res } = await get('/health');
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const pre = await fetch(`${base}/changes`, { method: 'OPTIONS' });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

test('writes are refused with 405, unknown paths with 404', async () => {
  const post = await fetch(`${base}/changes`, { method: 'POST' });
  assert.equal(post.status, 405);
  const missing = await get('/nope');
  assert.equal(missing.res.status, 404);
});

test('GET /anchors lists the anchored days read off the node', async () => {
  const { res, body } = await get('/anchors');
  assert.equal(res.status, 200);
  assert.equal(body.reachable, true);
  const days = body.days as { day: string; months: { month: string; root: string }[] }[];
  assert.equal(days.length, 1);
  assert.equal(days[0].day, ANCHOR_DAY);
  assert.equal(days[0].months[0].root, fixture.snapshot.merkleRoot);
});

test('GET /anchors/:day validates the day and 404s on an unanchored one', async () => {
  const good = await get(`/anchors/${ANCHOR_DAY}`);
  assert.equal(good.res.status, 200);
  const bad = await get('/anchors/not-a-day');
  assert.equal(bad.res.status, 400);
  assert.equal((bad.body.error as Record<string, string>).code, 'bad_day');
  const absent = await get('/anchors/1999-01-01');
  assert.equal(absent.res.status, 404);
});

test('GET /changes returns the classified feed with labels', async () => {
  const { res, body } = await get('/changes');
  assert.equal(res.status, 200);
  const meta = body.meta as Record<string, unknown>;
  assert.equal(meta.total, 5);
  assert.deepEqual(meta.byKind, {
    silentRevision: 1,
    recordedAmendment: 1,
    added: 1,
    reformatted: 1,
    removed: 1,
  });
  const changes = body.changes as Record<string, unknown>[];
  const silent = changes.find((c) => c.kind === 'silentRevision')!;
  assert.equal(silent.tableLabel, 'Cartel');
  assert.equal(silent.kindLabel, 'Revisión silenciosa');
  assert.equal(silent.closedMonth, true);
  assert.equal(silent.nroSicop, '20260100001');
  assert.deepEqual(silent.institution, {
    cedula: '4000042138',
    nombre: 'CAJA COSTARRICENSE DE SEGURO SOCIAL',
  });
  assert.match(String(silent.proof), /^\/proof\/202601\/DetalleCarteles\//);
});

test('GET /changes filters by kind, month, date, institution and tender', async () => {
  const byKind = await get('/changes?kind=silentRevision');
  assert.equal((byKind.body.meta as Record<string, number>).total, 1);

  const byMonth = await get(`/changes?month=${MONTH}`);
  assert.equal((byMonth.body.meta as Record<string, number>).total, 5);

  const otherMonth = await get('/changes?month=209901');
  assert.equal((otherMonth.body.meta as Record<string, number>).total, 0);

  const byDate = await get('/changes?date=2026-01-02');
  assert.equal((byDate.body.meta as Record<string, number>).total, 5);

  const byInstitution = await get('/changes?institution=4000042138');
  const total = (byInstitution.body.meta as Record<string, number>).total;
  assert.ok(total >= 1, 'the institution filter must resolve through the index');

  const byTender = await get('/changes?tender=20260100001');
  assert.ok((byTender.body.meta as Record<string, number>).total >= 3);

  const badMonth = await get('/changes?month=2026');
  assert.equal(badMonth.res.status, 400);
});

test('GET /changes pages', async () => {
  const first = await get('/changes?limit=2&offset=0');
  const second = await get('/changes?limit=2&offset=2');
  assert.equal((first.body.changes as unknown[]).length, 2);
  assert.equal((second.body.changes as unknown[]).length, 2);
  assert.notDeepEqual(first.body.changes, second.body.changes);
});

test('GET /tenders/:nroSicop returns the procedure and its OCDS release', async () => {
  const { res, body } = await get('/tenders/20260100001');
  assert.equal(res.status, 200);
  assert.equal((body.tender as Record<string, string>).nro_procedimiento, '2026LR-000001-0000900001');
  assert.equal((body.institution as Record<string, string>).nombre, 'CAJA COSTARRICENSE DE SEGURO SOCIAL');
  assert.equal((body.bids as unknown[]).length, 2);
  assert.equal((body.contracts as unknown[]).length, 2);
  assert.equal((body.appeals as unknown[]).length, 1);
  assert.equal((body.keyDates as Record<string, string>).fechaApertura, '2026-01-20');
  assert.match(String((body.ocds as Record<string, string>).ocid), /^ocds-anclacr-20260100001$/);
  assert.equal((body.labels as Record<string, string>).institution, 'Institución');
});

test('GET /suppliers/:cedula returns participation, and 404s on an unknown one', async () => {
  const { res, body } = await get('/suppliers/3101999888');
  assert.equal(res.status, 200);
  assert.equal(body.nombre, 'DISTRIBUIDORA EJEMPLO SOCIEDAD ANONIMA');
  assert.deepEqual(body.counts, { bids: 1, awards: 1, contracts: 2, appeals: 0, sanctions: 0 });
  const missing = await get('/suppliers/0000000000');
  assert.equal(missing.res.status, 404);
});

test('GET /institutions/:cedula lists that institution procedures', async () => {
  const { res, body } = await get('/institutions/4000042138');
  assert.equal(res.status, 200);
  assert.equal((body.tenders as unknown[]).length, 2);
  assert.equal((body.counts as Record<string, number>).contracts, 2);
});

test('GET /proof returns a proof that reproduces the anchored root', async () => {
  const record = fixture.snapshot.records.find((r) => r.table === 'DetalleCarteles')!;
  const { res, body } = await get(
    `/proof/${MONTH}/DetalleCarteles/${encodeURIComponent(record.id)}`,
  );
  assert.equal(res.status, 200);
  assert.equal(body.byteHash, record.byteHash);
  assert.equal(body.merkleRoot, fixture.snapshot.merkleRoot);
  assert.equal(body.leafCount, fixture.snapshot.recordCount);
  assert.equal(body.anchoredDay, ANCHOR_DAY);
  assert.equal(body.anchoredRoot, fixture.snapshot.merkleRoot);
  assert.equal(body.canonVersion, 'ancla-canon-1');

  const ok = merkleVerify(
    leafFor(record),
    body.proof as { hash: string; side: 'left' | 'right' }[],
    String(body.merkleRoot),
  );
  assert.ok(ok, 'the published audit path must recompute the published root');
  assert.ok((body.notes as string[]).some((n) => /no prueba que el registro sea correcto/i.test(n)));
});

test('GET /proof handles ids containing a pipe and 404s cleanly', async () => {
  const record = fixture.snapshot.records.find((r) => r.table === 'Contratos')!;
  const found = await get(`/proof/${MONTH}/Contratos/${encodeURIComponent(record.id)}`);
  assert.equal(found.res.status, 200);
  assert.equal(found.body.id, record.id);

  const noRecord = await get(`/proof/${MONTH}/Contratos/NOPE`);
  assert.equal(noRecord.res.status, 404);
  assert.equal((noRecord.body.error as Record<string, string>).code, 'no_record');

  const noSnapshot = await get('/proof/209901/Contratos/NOPE');
  assert.equal(noSnapshot.res.status, 404);
  assert.equal((noSnapshot.body.error as Record<string, string>).code, 'no_snapshot');

  const badMonth = await get('/proof/xx/Contratos/NOPE');
  assert.equal(badMonth.res.status, 400);
});

test('GET /ocds/:month returns a release package with paging links', async () => {
  const { res, body } = await get(`/ocds/${MONTH}?limit=1`);
  assert.equal(res.status, 200);
  assert.equal(body.version, '1.1');
  assert.equal((body.releases as unknown[]).length, 1);
  const links = body.links as Record<string, unknown>;
  assert.equal(links.total, 2);
  assert.equal(links.next, '/ocds/202601?limit=1&offset=1');

  const bad = await get('/ocds/2026');
  assert.equal(bad.res.status, 400);
});

test('GET /months and /stats describe what is held', async () => {
  const months = await get('/months');
  assert.equal((months.body.months as { month: string }[])[0].month, MONTH);

  const stats = await get('/stats');
  assert.equal((stats.body.index as Record<string, unknown>).available, true);
  assert.equal((stats.body.index as Record<string, number>).tenders, 2);
  assert.equal((stats.body.changes as Record<string, number>).total, 5);
  assert.equal((stats.body.anchors as Record<string, number>).days, 1);
});

test('GET /i18n serves the catalogue the web app renders with', async () => {
  const es = await get('/i18n/es');
  assert.equal(es.body.lang, 'es');
  assert.equal((es.body.messages as Record<string, string>)['kind.silentRevision'], 'Revisión silenciosa');
  const en = await get('/i18n/en');
  assert.equal((en.body.messages as Record<string, string>)['kind.silentRevision'], 'Silent revision');
});

test('GET /reports lists the daily runs', async () => {
  const { body } = await get('/reports');
  const reports = body.reports as { day: string; changes: number }[];
  assert.equal(reports.length, 1);
  assert.equal(reports[0].day, '2026-01-02');
  assert.equal(reports[0].changes, 5);
});

test('the root path documents the endpoints', async () => {
  const { res, body } = await get('/');
  assert.equal(res.status, 200);
  const endpoints = body.endpoints as string[];
  for (const e of ['/health', '/changes', '/proof', '/ocds', '/anchors']) {
    assert.ok(endpoints.includes(e), `${e} should be listed`);
  }
});
