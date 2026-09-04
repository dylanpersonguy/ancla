/**
 * A bundle over two real published copies of the same month.
 *
 * The unit tests build four-row archives, which is where a comparison bug hides.
 * This runs the real thing: two 40 MB ZIPs the Observatorio actually served, five
 * days apart, 1.4 million records against 1.65 million. It asserts the property
 * the whole design rests on — that a second worker holding the same two files
 * produces the same digest — and it asserts it on files nobody wrote for a test.
 *
 * Skipped when no such pair is mirrored, so a clean checkout still runs green.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildSnapshot } from '../../canonicalize/src/snapshot.ts';
import { buildBundle, parseChanges } from '../src/bundle.ts';
import { verifyAgainstArchives, verifyBundle } from '../src/verify.ts';

const root = join(process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data'), 'archives');

/** The most recent period the publisher rewrote while we were watching. */
function rewrittenPair(): { period: string; files: string[] } | null {
  if (!existsSync(root)) return null;
  for (const period of readdirSync(root).sort().reverse()) {
    const zips = readdirSync(join(root, period))
      .filter((f) => f.endsWith('.zip'))
      .sort();
    if (zips.length >= 2) return { period, files: zips.slice(-2) };
  }
  return null;
}

const pair = rewrittenPair();
const opts = {
  skip: pair ? false : 'no period holds two copies; nothing has been rewritten here yet',
  // Two full canonicalisations of a 40 MB archive, twice over for the rebuild.
  timeout: 600_000,
};

test('two real copies of one month produce a bundle that rebuilds byte for byte', opts, () => {
  const { period, files } = pair as { period: string; files: string[] };
  const a = readFileSync(join(root, period, files[0] as string));
  const b = readFileSync(join(root, period, files[1] as string));

  const ref = (file: string) => ({
    source: 'cr-observatorio',
    stamp: file.split('-')[0] as string,
    file,
  });
  const built = buildBundle(
    { snapshot: buildSnapshot(period, a), archive: a, ref: ref(files[0] as string) },
    { snapshot: buildSnapshot(period, b), archive: b, ref: ref(files[1] as string) },
  );

  const self = verifyBundle(built.manifest, built.changes);
  assert.ok(self.ok, JSON.stringify(self.checks.filter((c) => !c.ok)));

  const rebuilt = verifyAgainstArchives(built.manifest, built.changes, a, b);
  assert.ok(rebuilt.ok, JSON.stringify(rebuilt.checks.filter((c) => !c.ok)));

  const lines = parseChanges(built.changes);
  assert.equal(lines.length, built.manifest.changeCount);

  // Every line that kept its values must actually carry some, or the bundle is
  // reporting a change it cannot show.
  for (const l of lines) {
    if (l.valuesOmitted) continue;
    if (l.kind === 'removed') assert.ok(l.before, `removed ${l.table} ${l.id} has no row`);
    if (l.kind === 'added' || l.kind === 'recordedAmendment') {
      assert.ok(l.after, `added ${l.table} ${l.id} has no row`);
    }
    if (l.kind === 'silentRevision') {
      assert.ok(l.fields?.length, `silent revision ${l.table} ${l.id} names no field`);
    }
  }
});

test('a real silent revision names a field and both of its values', opts, () => {
  const { period, files } = pair as { period: string; files: string[] };
  const a = readFileSync(join(root, period, files[0] as string));
  const b = readFileSync(join(root, period, files[1] as string));
  const ref = (file: string) => ({
    source: 'cr-observatorio',
    stamp: file.split('-')[0] as string,
    file,
  });
  const built = buildBundle(
    { snapshot: buildSnapshot(period, a), archive: a, ref: ref(files[0] as string) },
    { snapshot: buildSnapshot(period, b), archive: b, ref: ref(files[1] as string) },
  );

  const revisions = parseChanges(built.changes).filter(
    (l) => l.kind === 'silentRevision' && !l.valuesOmitted,
  );
  if (!revisions.length) return; // legitimate: nothing was quietly edited
  for (const r of revisions.slice(0, 200)) {
    assert.ok(r.fields && r.fields.length > 0);
    for (const f of r.fields) {
      assert.notEqual(f.before, f.after, `${r.table} ${r.id} ${f.field} listed but identical`);
    }
  }
});
