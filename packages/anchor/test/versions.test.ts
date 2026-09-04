/**
 * Capture keys are a function of the bytes, and that is load bearing.
 *
 * The contract refuses to overwrite an existing key. Combined with a key derived
 * from the archive's own hash, that makes an anchored capture permanent: the same
 * copy always lands on the same key with the same value, and two different copies
 * cannot collide onto one key without a SHA-256 collision. Every test here is
 * about one of those two halves.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_ENTRIES } from '../src/datatx.ts';
import {
  type Capture,
  type DiffCommitment,
  canonSuffix,
  captureId,
  diffKey,
  diffMeta,
  groupVersionEntries,
  planCaptures,
  versionKey,
  versionMeta,
} from '../src/versions.ts';

const sha = (c: string) => c.repeat(64).slice(0, 64);

function capture(over: Partial<Capture> = {}): Capture {
  return {
    period: '202512',
    stamp: '20250630T130435Z',
    archiveSha256: sha('0f4f37495713'),
    merkleRoot: sha('a'),
    recordCount: 301_189,
    canonVersion: 'ancla-canon-1',
    ...over,
  };
}

function commitment(over: Partial<DiffCommitment> = {}): DiffCommitment {
  return {
    period: '202608',
    canonVersion: 'ancla-canon-1',
    fromSha256: sha('7'),
    toSha256: sha('2'),
    bundleDigest: sha('d'),
    bundleVersion: 'ancla-bundle-1',
    changesSha256: sha('c'),
    counts: { added: 1, recordedAmendment: 2, silentRevision: 3, reformatted: 4, removed: 5 },
    ...over,
  };
}

test('a capture key is derived from the archive hash, not from the day', () => {
  const c = capture();
  assert.equal(versionKey(c), `ver_202512_${c.archiveSha256.slice(0, 12)}`);
  // Same capture, different run day, same key. That is the entire point.
  assert.equal(versionKey(c), versionKey({ ...c, stamp: '20991231T000000Z' }));
});

test('two different copies of a period get two different keys', () => {
  const a = capture({ archiveSha256: sha('1') });
  const b = capture({ archiveSha256: sha('2') });
  assert.notEqual(versionKey(a), versionKey(b));
});

test('a country prefix separates publishers on one account', () => {
  assert.match(versionKey(capture(), 'pa'), /^ver_pa_202512_/);
  assert.equal(versionKey(capture()), versionKey(capture(), undefined));
});

test('an id must be a real digest, so a truncated hash cannot become a key', () => {
  assert.throws(() => captureId('abc'), /not a sha256/);
  assert.throws(() => captureId(sha('a').toUpperCase()), /not a sha256/);
});

test('the meta line carries the full hash, so twelve hex is only an address', () => {
  const c = capture();
  assert.equal(versionMeta(c), `ancla-canon-1|301189|${c.archiveSha256}|20250630T130435Z`);
});

test('the diff meta counts are positional and stay in one order', () => {
  assert.equal(diffMeta(commitment()), `ancla-bundle-1|1,2,3,4,5|${sha('c')}`);
});

test('anchoring the same capture twice produces the same entry', () => {
  const [first] = planCaptures('2026-09-03', [capture()]);
  const [second] = planCaptures('2026-09-04', [capture()]);
  assert.deepEqual(first?.entries, second?.entries);
});

test('a plan refuses to carry one key twice', () => {
  assert.throws(() => planCaptures('2026-09-03', [capture(), capture()]), /duplicate key/);
});

test('a plan splits across transactions rather than exceeding the entry limit', () => {
  const many = Array.from({ length: 120 }, (_, i) =>
    capture({ archiveSha256: sha(String(i % 10)).slice(0, 64), period: `2025${String(i).padStart(2, '0')}` }),
  );
  // Distinct hashes, so no duplicate-key rejection.
  const unique = many.map((c, i) => ({ ...c, archiveSha256: i.toString(16).padStart(64, '0') }));
  const plans = planCaptures('2026-09-03', unique);
  assert.ok(plans.length > 1);
  assert.ok(plans.every((p) => p.entries.length <= MAX_ENTRIES));
  assert.equal(plans.reduce((n, p) => n + p.entries.length, 0), unique.length * 2);
});

test('nothing to anchor is an error, not an empty transaction', () => {
  assert.throws(() => planCaptures('2026-09-03', [], []), /nothing to anchor/);
});

test('a day still has to be a day, even though no key uses it', () => {
  assert.throws(() => planCaptures('03-09-2026', [capture()]), /must be YYYY-MM-DD/);
});

test('captures and diffs read back out of the account entries they produced', () => {
  const c = capture();
  const d = commitment();
  const [plan] = planCaptures('2026-09-03', [c], [d]);
  const entries = (plan as { entries: { key: string; value: string }[] }).entries.map((e) => ({
    key: e.key,
    value: e.value,
  }));
  const { versions, diffs } = groupVersionEntries(entries);

  assert.equal(versions.length, 1);
  assert.equal(versions[0]?.root, c.merkleRoot);
  assert.equal(versions[0]?.archiveSha256, c.archiveSha256);
  assert.equal(versions[0]?.recordCount, 301_189);
  assert.equal(versions[0]?.stamp, c.stamp);

  assert.equal(diffs.length, 1);
  assert.equal(diffs[0]?.bundleDigest, d.bundleDigest);
  assert.deepEqual(diffs[0]?.counts, d.counts);
  assert.equal(diffs[0]?.changesSha256, d.changesSha256);
});

test('a prefixed key reads back with its namespace intact', () => {
  const [plan] = planCaptures('2026-09-03', [capture()], [commitment()], 'pa');
  const { versions, diffs } = groupVersionEntries(
    (plan as { entries: { key: string; value: string }[] }).entries,
  );
  assert.equal(versions[0]?.ns, 'pa');
  assert.equal(versions[0]?.period, '202512');
  assert.equal(diffs[0]?.ns, 'pa');
});

test('a diff key names both copies, so it cannot be reused for another pair', () => {
  const d = commitment();
  const other = commitment({ toSha256: sha('9') });
  assert.notEqual(diffKey(d), diffKey(other));
  assert.match(diffKey(d), /^diff_202608_[0-9a-f]{12}_[0-9a-f]{12}$/);
  // A later canonicaliser is a different reading of the same two files, so it
  // gets its own key rather than colliding with one the contract will not replace.
  assert.match(
    diffKey({ ...d, canonVersion: 'ancla-canon-2' }),
    /^diff_202608_[0-9a-f]{12}_[0-9a-f]{12}_c2$/,
  );
});

test('an unparseable meta line degrades to nulls rather than to wrong numbers', () => {
  const { versions, diffs } = groupVersionEntries([
    { key: 'ver_202512_0f4f37495713', value: 'root' },
    { key: 'vmeta_202512_0f4f37495713', value: 'garbage' },
    { key: 'diff_202608_aaaaaaaaaaaa_bbbbbbbbbbbb', value: 'digest' },
    { key: 'dmeta_202608_aaaaaaaaaaaa_bbbbbbbbbbbb', value: 'x|not,numbers|y' },
  ]);
  assert.equal(versions[0]?.recordCount, null);
  assert.equal(versions[0]?.root, 'root');
  assert.equal(diffs[0]?.counts, null);
  assert.equal(diffs[0]?.bundleDigest, 'digest');
});

test('the daily root keys are left alone by the capture reader', () => {
  const { versions, diffs } = groupVersionEntries([
    { key: 'root_2026-08-27_202512', value: 'r' },
    { key: 'meta_2026-08-27_202512', value: 'm' },
    { key: 'latest', value: '2026-08-27' },
  ]);
  assert.deepEqual(versions, []);
  assert.deepEqual(diffs, []);
});

test('a second canonicaliser gets its own key for the same archive', () => {
  // Without this the v2 root of an already-committed archive can never be
  // written: the key exists, the contract refuses to overwrite it, and the
  // anchor step skips the capture forever.
  const v1 = capture({ canonVersion: 'ancla-canon-1' });
  const v2 = capture({ canonVersion: 'ancla-canon-2' });
  assert.equal(versionKey(v1), 'ver_202512_0f4f37495713');
  assert.equal(versionKey(v2), 'ver_202512_0f4f37495713_c2');
  assert.notEqual(versionKey(v1), versionKey(v2));

  const [plan] = planCaptures('2026-09-03', [v1, v2]);
  assert.equal((plan as { entries: unknown[] }).entries.length, 4);
});

test('an unsuffixed key reads back as the first canonicaliser', () => {
  const { versions } = groupVersionEntries([
    { key: 'ver_202512_0f4f37495713', value: 'r1' },
    { key: 'ver_202512_0f4f37495713_c2', value: 'r2' },
  ]);
  assert.equal(versions.length, 2);
  const byVersion = Object.fromEntries(versions.map((v) => [v.canonVersion, v.root]));
  assert.deepEqual(byVersion, { 'ancla-canon-1': 'r1', 'ancla-canon-2': 'r2' });
  assert.ok(versions.every((v) => v.period === '202512' && v.id === '0f4f37495713'));
});

test('a canon marker is refused for a version the code does not know', () => {
  assert.throws(() => canonSuffix('ancla-canon-next'), /unrecognised/);
});
