import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { detectDelimiter, parseCsv } from '../../canonicalize/src/canonical.ts';
import { listEntries, readEntry, tableNameOf } from '../../canonicalize/src/zip.ts';
import { query, queryOne } from '../../core/src/db.ts';
import { type ArchiveRef, latestArchives, loadArchive, openIndex } from '../src/load.ts';
import { resolve } from '../src/resolve.ts';

/**
 * The loader against real mirrored archives.
 *
 * Synthetic zips cover the shapes we know about. This covers the ones we do not:
 * every column rename, encoding slip and broken row the Observatorio has shipped
 * since 2010 is in these files, and none of it is in a fixture.
 *
 * Skipped when no mirror is present, so the suite still runs on a clean checkout.
 */

const refs = latestArchives();
const recent = refs.slice(-2);
const opts = { skip: recent.length >= 1 ? false : 'no mirrored archive; run: ancla mirror' };

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function db() {
  const dir = mkdtempSync(join(tmpdir(), 'ancla-real-'));
  temps.push(dir);
  return openIndex(join(dir, 'index.sqlite'));
}

/** One published CSV back out of the archive, for comparing against the index. */
function publishedRows(ref: ArchiveRef, table: string): { header: string[]; rows: string[][] } {
  const buf = readFileSync(ref.path);
  const entry = listEntries(buf).find((e) => tableNameOf(e.name) === table);
  if (!entry || entry.uncompressedSize === 0) return { header: [], rows: [] };
  const csv = readEntry(buf, entry);
  const it = parseCsv(csv, detectDelimiter(csv));
  const first = it.next();
  if (first.done) return { header: [], rows: [] };
  return {
    header: first.value.map((h) => h.replace(/^﻿/, '').trim().toUpperCase()),
    rows: [...it],
  };
}

test('a real archive loads with provenance on every row', opts, () => {
  const ref = recent[recent.length - 1];
  const d = db();
  const r = loadArchive(d, ref);

  assert.equal(r.skipped, false);
  assert.ok(r.read.tender > 0, 'the month should contain tenders');
  assert.ok(r.read.bid > 0, 'the month should contain bids');
  assert.match(r.sha256, /^[0-9a-f]{64}$/);

  const stray = queryOne<{ n: number }>(
    d,
    'SELECT COUNT(*) AS n FROM tender WHERE source_month <> ? OR archive_stamp <> ?',
    [ref.month, ref.stamp],
  );
  assert.equal(stray?.n, 0, 'every row must carry the archive it came from');
});

test('every date in a real archive lands as ISO or null, never as raw text', opts, () => {
  const ref = recent[recent.length - 1];
  const d = db();
  loadArchive(d, ref);

  const checks: [string, string][] = [
    ['tender', 'fecha_publicacion'],
    ['tender', 'fechah_apertura'],
    ['contract', 'fecha_notificacion'],
    ['stage_dates', 'publicacion'],
    ['stage_dates', 'adjudicacion_firme'],
    ['appeal', 'fecha_presentacion'],
    ['supplier', 'fecha_constitucion'],
    ['inhibition', 'fecha_inicio'],
  ];
  for (const [table, col] of checks) {
    const bad = queryOne<{ n: number }>(
      d,
      `SELECT COUNT(*) AS n FROM ${table}
       WHERE ${col} IS NOT NULL AND ${col} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`,
    );
    assert.equal(bad?.n, 0, `${table}.${col} should be ISO or null`);
  }
});

test('a real published amount reaches the index unchanged', opts, () => {
  const ref = recent[recent.length - 1];
  const d = db();
  loadArchive(d, ref);

  const { header, rows } = publishedRows(ref, 'DetalleCarteles');
  const sicopAt = header.indexOf('NRO_SICOP');
  const montoAt = header.indexOf('MONTO_EST');
  assert.ok(sicopAt >= 0 && montoAt >= 0);

  // Trailing zeros are the whole point: an amount like 6780000 becomes 678 under
  // any normalizer that strips them, and nothing downstream would notice.
  let checked = 0;
  for (const row of rows) {
    const raw = (row[montoAt] ?? '').trim();
    if (!/^\d{5,}0{3}(\.0+)?$/.test(raw)) continue;
    const got = queryOne<{ monto_est: number }>(
      d,
      'SELECT monto_est FROM tender WHERE nro_sicop = ?',
      [(row[sicopAt] ?? '').trim()],
    );
    assert.equal(got?.monto_est, Number(raw), `MONTO_EST ${raw} should survive intact`);
    if (++checked >= 20) break;
  }
  assert.ok(checked > 0, 'the month should contain at least one round amount');
});

test('a real archive is not reloaded, and force reloads it without duplicating', opts, () => {
  const ref = recent[recent.length - 1];
  const d = db();
  loadArchive(d, ref);
  const before = queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n;

  assert.equal(loadArchive(d, ref).skipped, true);
  assert.equal(loadArchive(d, ref, { force: true }).skipped, false);

  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n, before);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM loaded_archive')?.n, 1);
});

test('two real months stitch instead of stacking', opts, () => {
  if (recent.length < 2) return; // a one month mirror has nothing to stitch
  const d = db();
  const a = loadArchive(d, recent[0]);
  const b = loadArchive(d, recent[1]);

  // The registries are republished whole every month. Rows must merge on their
  // key, not accumulate a copy per archive.
  for (const table of ['supplier', 'institution', 'inhibition']) {
    const read = (a.read[table] ?? 0) + (b.read[table] ?? 0);
    if (read === 0) continue;
    const held = queryOne<{ n: number }>(d, `SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0;
    assert.ok(held <= read, `${table}: ${held} held should not exceed ${read} read`);
    assert.ok(held > 0, `${table} should hold rows`);
  }

  const months = query<{ source_month: string }>(
    d,
    'SELECT DISTINCT source_month FROM loaded_archive ORDER BY source_month',
  ).map((r) => r.source_month);
  assert.deepEqual(months, [recent[0].month, recent[1].month]);
});

test('resolution on real data merges sparingly and covers every actor', opts, () => {
  const ref = recent[recent.length - 1];
  const d = db();
  loadArchive(d, ref);
  const stats = resolve(d);

  assert.ok(stats.actors > 0);
  assert.equal(stats.entities, stats.suppliers + stats.groups + stats.consortia);

  // Conservatism, as a number. If this ever climbs past a few percent, the merge
  // rule has stopped being evidence and started being a guess.
  const mergedShare = stats.groupedCedulas / stats.actors;
  assert.ok(mergedShare < 0.02, `merged ${(mergedShare * 100).toFixed(2)}% of actors`);

  // Every cedula that acted must resolve to exactly one owning actor.
  const orphans = queryOne<{ n: number }>(
    d,
    `SELECT COUNT(*) AS n FROM (SELECT DISTINCT cedula_proveedor AS c FROM bid
       WHERE cedula_proveedor IS NOT NULL AND cedula_proveedor <> '')
     WHERE c NOT IN (SELECT m.cedula_proveedor FROM entity_member m
       JOIN entity e USING (entity_id) WHERE e.kind <> 'consortium')`,
  );
  assert.equal(orphans?.n, 0, 'every bidder should resolve to an owning actor');

  const doubled = query<{ c: string }>(
    d,
    `SELECT m.cedula_proveedor AS c FROM entity_member m JOIN entity e USING (entity_id)
     WHERE e.kind <> 'consortium' GROUP BY m.cedula_proveedor HAVING COUNT(*) > 1`,
  );
  assert.deepEqual(doubled, [], 'no cedula may have two owning actors');

  // Every merge carries a reason that names the members it merged.
  for (const g of query<{ evidence: string; member_count: number }>(
    d,
    "SELECT evidence, member_count FROM entity WHERE kind = 'group'",
  )) {
    const ev = JSON.parse(g.evidence);
    assert.equal(ev.rule, 'shared-registry-serial-and-name');
    assert.equal(ev.members.length, g.member_count);
    assert.equal(new Set(ev.members.map((m: { cedula: string }) => m.cedula.slice(4))).size, 1);
  }
});

test('the loader never inflates the archive table it does not need', opts, () => {
  const ref = recent[recent.length - 1];
  const buf = readFileSync(ref.path);
  const invitations = listEntries(buf).find(
    (e) => tableNameOf(e.name) === 'InvitacionProcedimiento',
  );
  if (!invitations) return;
  // It reaches 447 MB uncompressed in 202211 and holds nothing the schema keeps.
  const d = db();
  const before = process.memoryUsage().heapUsed;
  loadArchive(d, ref);
  const grew = process.memoryUsage().heapUsed - before;
  assert.ok(
    grew < invitations.uncompressedSize,
    `heap grew ${grew} bytes against a ${invitations.uncompressedSize} byte table`,
  );
});
