import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalizeTable } from '../../canonicalize/src/canonical.ts';
import { buildSnapshot, sortRecords, type Snapshot } from '../../canonicalize/src/snapshot.ts';
import { listEntries, readEntry, tableNameOf } from '../../canonicalize/src/zip.ts';
import { diff } from '../src/index.ts';

/**
 * End-to-end against a real Observatorio archive.
 *
 * The differ's real job is comparing two versions of the same month, and no month
 * has been rewritten since we started watching. Rather than wait, we take a real
 * archive, change exactly one published value, and assert the differ reports
 * exactly that. This is the closest thing to a live finding we can construct.
 *
 * Skipped when no mirror is present, so the suite still runs on a clean checkout.
 */

const root = join(process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data'), 'archives');

function anyArchive(): { month: string; buf: Buffer } | null {
  if (!existsSync(root)) return null;
  for (const month of readdirSync(root).sort().reverse()) {
    const dir = join(root, month);
    const zips = readdirSync(dir).filter((f) => f.endsWith('.zip'));
    if (zips.length) return { month, buf: readFileSync(join(dir, zips[zips.length - 1])) };
  }
  return null;
}

const archive = anyArchive();
const opts = { skip: archive ? false : 'no mirrored archive; run: ancla mirror' };

test('a single changed value in a real archive is reported as one silent revision', opts, () => {
  const { month, buf } = archive!;
  const base = buildSnapshot(month, buf);

  // Find a table with a numeric column we can nudge by a real amount.
  const target = 'DetalleLineaCartel';
  const entry = listEntries(buf).find((e) => tableNameOf(e.name) === target);
  assert.ok(entry, `${target} should be present in every archive`);
  const csv = readEntry(buf, entry!).toString('utf8');

  const lines = csv.split('\r\n');
  const header = lines[0].split(';');
  const col = header.indexOf('PRECIO_UNITARIO_ESTIMADO');
  assert.ok(col >= 0, 'PRECIO_UNITARIO_ESTIMADO should exist');

  // Change one estimated unit price on the first data row that has one.
  let touched = -1;
  for (let i = 1; i < lines.length && touched < 0; i++) {
    const cells = lines[i].split(';');
    if (cells.length !== header.length || !/^\d+(\.\d+)?$/.test(cells[col])) continue;
    cells[col] = `${Number(cells[col]) + 1000}`;
    lines[i] = cells.join(';');
    touched = i;
  }
  assert.ok(touched > 0, 'should have found a numeric price to change');

  const mutated = canonicalizeTable(target, Buffer.from(lines.join('\r\n'), 'utf8'));
  const after: Snapshot = {
    ...base,
    records: sortRecords([
      ...base.records.filter((r) => r.table !== target),
      ...mutated.records,
    ]),
  };

  const d = diff(base, after, { limit: 10 });
  assert.equal(d.counts.silentRevision, 1, 'exactly one record should differ');
  assert.equal(d.counts.added, 0);
  assert.equal(d.counts.removed, 0);
  assert.equal(d.counts.reformatted, 0);
  assert.equal(d.changes[0].table, target);
});

test('reprinting a real number changes nothing the differ should report', opts, () => {
  const { month, buf } = archive!;
  const base = buildSnapshot(month, buf);

  const target = 'DetalleLineaCartel';
  const entry = listEntries(buf).find((e) => tableNameOf(e.name) === target)!;
  const csv = readEntry(buf, entry).toString('utf8');
  const lines = csv.split('\r\n');
  const header = lines[0].split(';');
  const col = header.indexOf('PRECIO_UNITARIO_ESTIMADO');

  // 1500.000000 -> 1500. Same value, different bytes. Must not be a revision.
  let touched = 0;
  for (let i = 1; i < lines.length && touched < 5; i++) {
    const cells = lines[i].split(';');
    if (cells.length !== header.length || !/^\d+\.\d+$/.test(cells[col])) continue;
    const trimmed = String(Number(cells[col]));
    if (trimmed === cells[col]) continue;
    cells[col] = trimmed;
    lines[i] = cells.join(';');
    touched++;
  }
  assert.ok(touched > 0, 'should have found numbers to reprint');

  const mutated = canonicalizeTable(target, Buffer.from(lines.join('\r\n'), 'utf8'));
  const after: Snapshot = {
    ...base,
    records: sortRecords([...base.records.filter((r) => r.table !== target), ...mutated.records]),
  };

  const d = diff(base, after, { limit: 10 });
  assert.equal(d.counts.silentRevision, 0, 'reformatting must not read as a value change');
  assert.equal(d.counts.reformatted, touched);
});

test('an unchanged real archive diffs to nothing', opts, () => {
  const { month, buf } = archive!;
  const d = diff(buildSnapshot(month, buf), buildSnapshot(month, buf));
  assert.deepEqual(d.counts, {
    added: 0, recordedAmendment: 0, silentRevision: 0, reformatted: 0, removed: 0,
  });
});
