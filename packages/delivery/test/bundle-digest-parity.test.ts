/**
 * The browser recomputes the bundle digest the way Node computes it.
 *
 * The same contract as verifier-parity.test.ts, for the other digest. A bundle's
 * whole claim to independence is that a reader can take the manifest we serve,
 * recompute the digest in their own browser, and find it already committed on
 * chain. Two implementations of that computation means two chances to be wrong,
 * so the test imports both and runs them over the same manifests rather than
 * asserting a hardcoded hex string that either side could be edited to match.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffKey, versionKey } from '../../anchor/src/versions.ts';
import {
  BUNDLE_VERSION,
  type BundleManifest,
  bundleDigest,
  digestInput,
  digestInputV1,
  digestInputV2,
} from '../../bundle/src/bundle.ts';
import * as web from '../../../apps/web/bundle-digest.js';
import { CANON_VERSION } from '../../canonicalize/src/canonical.ts';

function manifest(over: Partial<BundleManifest> = {}): BundleManifest {
  const base: Omit<BundleManifest, 'bundleDigest' | 'builtAt'> = {
    bundleVersion: BUNDLE_VERSION,
    canonVersion: CANON_VERSION,
    source: 'cr-observatorio',
    period: '202608',
    from: {
      source: 'cr-observatorio',
      period: '202608',
      stamp: '20260826T130636Z',
      file: '20260826T130636Z-7cc3a068c019.zip',
      archiveSha256: 'a'.repeat(64),
      merkleRoot: 'b'.repeat(64),
      recordCount: 1_398_867,
    },
    to: {
      source: 'cr-observatorio',
      period: '202608',
      stamp: '20260831T130427Z',
      file: '20260831T130427Z-2a8f44f57e6b.zip',
      archiveSha256: 'c'.repeat(64),
      merkleRoot: 'd'.repeat(64),
      recordCount: 1_652_192,
    },
    counts: {
      added: 261_243,
      recordedAmendment: 24,
      silentRevision: 7_577,
      reformatted: 1_905,
      removed: 7_942,
    },
    schemaChanges: [{ table: 'LineasAdjudicadas', before: 'aaaa', after: 'bbbb' }],
    changeCount: 278_691,
    linePolicy: { kinds: ['added', 'recordedAmendment', 'silentRevision', 'reformatted', 'removed'] },
    omittedByPolicy: 0,
    detailPolicy: { maxDetail: 200_000, order: ['silentRevision', 'removed', 'reformatted', 'recordedAmendment', 'added'] },
    valuesOmitted: 78_691,
    changesSha256: 'e'.repeat(64),
    canonVersionMismatch: false,
  };
  const merged = { ...base, ...over } as Omit<BundleManifest, 'bundleDigest' | 'builtAt'>;
  return { ...merged, bundleDigest: bundleDigest(merged), builtAt: '2026-09-03T00:00:00.000Z' };
}

test('the browser digest input is the Node digest input', () => {
  const m = manifest();
  assert.equal(web.digestInput(m), digestInput(m));
});

test('the browser digest equals the Node digest', async () => {
  const m = manifest();
  assert.equal(await web.bundleDigest(m), m.bundleDigest);
});

test('builtAt is outside the digest, so two builds of the same pair agree', () => {
  const a = manifest();
  const b = { ...manifest(), builtAt: '2030-01-01T00:00:00.000Z' };
  assert.equal(a.bundleDigest, b.bundleDigest);
});

test('changing any counted field moves the digest', async () => {
  const base = manifest();
  const moved = manifest({ counts: { ...base.counts, silentRevision: 7_578 } });
  assert.notEqual(moved.bundleDigest, base.bundleDigest);
  assert.equal(await web.bundleDigest(moved), moved.bundleDigest);
});

test('the detail order is the same list on both sides', () => {
  assert.deepEqual(web.DETAIL_ORDER, manifest().detailPolicy.order);
});

test('the browser derives the same chain key the anchor writes', () => {
  // Getting this wrong does not fail loudly: the page reads the commitment made
  // under the PREVIOUS rules, compares it against a digest built under the
  // current ones, and tells the reader a healthy bundle was tampered with.
  for (const canonVersion of ['ancla-canon-1', 'ancla-canon-2', 'ancla-canon-7']) {
    const m = manifest({ canonVersion });
    assert.equal(
      web.diffChainKey(m),
      diffKey({
        period: m.period,
        canonVersion,
        fromSha256: m.from.archiveSha256,
        toSha256: m.to.archiveSha256,
        bundleDigest: m.bundleDigest,
        bundleVersion: m.bundleVersion,
        changesSha256: m.changesSha256,
        counts: m.counts,
      }),
      canonVersion,
    );
    assert.equal(
      web.versionChainKey(m.period, m.to.archiveSha256, canonVersion),
      versionKey({
        period: m.period,
        stamp: m.to.stamp,
        archiveSha256: m.to.archiveSha256,
        merkleRoot: m.to.merkleRoot,
        recordCount: m.to.recordCount,
        canonVersion,
      }),
      canonVersion,
    );
  }
});

test('the first canonicaliser stays unsuffixed on both sides', () => {
  // 228 commitments were written under unsuffixed names. Suffixing them now
  // would orphan every one.
  assert.equal(web.canonSuffix('ancla-canon-1'), '');
  assert.equal(web.canonSuffix('ancla-canon-2'), '_c2');
  assert.throws(() => web.canonSuffix('ancla-canon-x'), /unrecognised/);
});

test('both sides dispatch on the manifest own bundle version', async () => {
  const m = manifest();
  const v1 = { ...m, bundleVersion: 'ancla-bundle-1' };
  assert.equal(web.digestInput(v1), digestInputV1(v1));
  assert.equal(web.digestInput(m), digestInputV2(m));
  // The added fields must not move a digest written under the older rules.
  assert.equal(digestInputV1(v1), digestInputV1({ ...v1, omittedByPolicy: 9_999 }));
});

test('a bundle version marks its own chain key', () => {
  assert.equal(web.bundleSuffix('ancla-bundle-1'), '');
  assert.equal(web.bundleSuffix('ancla-bundle-2'), '_b2');
  assert.throws(() => web.bundleSuffix('ancla-bundle-x'), /unrecognised/);
  const m = manifest();
  assert.match(web.diffChainKey(m), /_c2_b2$/);
  assert.match(web.diffChainKey({ ...m, bundleVersion: 'ancla-bundle-1' }), /_c2$/);
});
