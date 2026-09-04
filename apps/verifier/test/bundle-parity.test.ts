/**
 * The standalone verifier computes the bundle digest the way Node does.
 *
 * The page is deliberately one self-contained file with no imports, so a reader
 * can save it and run it offline against a public node. The cost of that is a
 * third copy of the digest rule. This test does not re-type it: it slices the
 * real source out of index.html and evaluates it, so editing the page and
 * forgetting the packages — or the reverse — fails here rather than in a
 * journalist's browser six months later.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { diffKey } from '../../../packages/anchor/src/versions.ts';
import {
  BUNDLE_VERSION,
  type BundleManifest,
  bundleDigest,
  digestInput,
} from '../../../packages/bundle/src/bundle.ts';
import { CANON_VERSION } from '../../../packages/canonicalize/src/canonical.ts';

const PAGE = new URL('../index.html', import.meta.url);

/** Pull the digest helpers out of the page and make them callable. */
async function extractFromPage() {
  const html = await readFile(PAGE, 'utf8');
  const start = html.indexOf('const DETAIL_ORDER = [');
  const end = html.indexOf('async function chainValue');
  assert.ok(start > 0 && end > start, 'the page no longer contains the digest helpers');
  const source = html.slice(start, end);

  const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const sha256 = async (...parts: Uint8Array[]) => {
    const h = createHash('sha256');
    for (const p of parts) h.update(p);
    return new Uint8Array(h.digest());
  };
  const make = new Function(
    'hex',
    'sha256',
    `${source}\nreturn { DETAIL_ORDER, digestInput, digestInputV1, digestInputV2, bundleDigest, canonSuffix, bundleSuffix, diffChainKey };`,
  );
  return make(hex, sha256) as {
    DETAIL_ORDER: string[];
    digestInput: (m: unknown) => string;
    bundleDigest: (m: unknown) => Promise<string>;
    canonSuffix: (v: string) => string;
    bundleSuffix: (v: string) => string;
    digestInputV1: (m: unknown) => string;
    digestInputV2: (m: unknown) => string;
    diffChainKey: (m: unknown) => string;
  };
}

function manifest(): BundleManifest {
  const body: Omit<BundleManifest, 'bundleDigest' | 'builtAt'> = {
    bundleVersion: BUNDLE_VERSION,
    canonVersion: CANON_VERSION,
    source: 'cr-observatorio',
    period: '202608',
    from: {
      source: 'cr-observatorio',
      period: '202608',
      stamp: '20260826T130636Z',
      file: '20260826T130636Z-7cc3a068c019.zip',
      archiveSha256: '7c'.repeat(32),
      merkleRoot: '00'.repeat(32),
      recordCount: 1_398_867,
    },
    to: {
      source: 'cr-observatorio',
      period: '202608',
      stamp: '20260831T130427Z',
      file: '20260831T130427Z-2a8f44f57e6b.zip',
      archiveSha256: '2a'.repeat(32),
      merkleRoot: '77'.repeat(32),
      recordCount: 1_652_192,
    },
    counts: {
      added: 261_243,
      recordedAmendment: 24,
      silentRevision: 7_577,
      reformatted: 1_905,
      removed: 7_942,
    },
    schemaChanges: [],
    changeCount: 278_691,
    linePolicy: { kinds: ['added', 'recordedAmendment', 'silentRevision', 'reformatted', 'removed'] },
    omittedByPolicy: 0,
    detailPolicy: {
      maxDetail: 200_000,
      order: ['silentRevision', 'removed', 'reformatted', 'recordedAmendment', 'added'],
    },
    valuesOmitted: 78_691,
    changesSha256: 'ee'.repeat(32),
    canonVersionMismatch: false,
  };
  return { ...body, bundleDigest: bundleDigest(body), builtAt: '2026-09-03T00:00:00.000Z' };
}

test('the page digest input is the Node digest input, character for character', async () => {
  const page = await extractFromPage();
  assert.equal(page.digestInput(manifest()), digestInput(manifest()));
});

test('the page reproduces the digest a bundle states', async () => {
  const page = await extractFromPage();
  const m = manifest();
  assert.equal(await page.bundleDigest(m), m.bundleDigest);
});

test('the page rejects a manifest whose counts were edited after publication', async () => {
  const page = await extractFromPage();
  const m = manifest();
  const tampered = { ...m, counts: { ...m.counts, silentRevision: 0 } };
  assert.notEqual(await page.bundleDigest(tampered), m.bundleDigest);
});

test('the page reads the commitment under the rules the bundle was built with', async () => {
  const page = await extractFromPage();
  const m = manifest();
  assert.equal(page.canonSuffix('ancla-canon-1'), '');
  assert.equal(page.canonSuffix('ancla-canon-2'), '_c2');
  assert.equal(
    page.diffChainKey({ ...m, canonVersion: 'ancla-canon-2' }),
    diffKey({
      period: m.period,
      canonVersion: 'ancla-canon-2',
      fromSha256: m.from.archiveSha256,
      toSha256: m.to.archiveSha256,
      bundleDigest: m.bundleDigest,
      bundleVersion: m.bundleVersion,
      changesSha256: m.changesSha256,
      counts: m.counts,
    }),
  );
});

test('the page keeps the frozen bundle-1 digest reachable', async () => {
  const page = await extractFromPage();
  const m = manifest();
  const v1 = { ...m, bundleVersion: 'ancla-bundle-1' };
  assert.equal(page.digestInput(v1), page.digestInputV1(v1));
  assert.notEqual(page.digestInputV1(v1), page.digestInputV2(v1));
  assert.equal(page.digestInput(m), page.digestInputV2(m));
  assert.equal(page.bundleSuffix('ancla-bundle-1'), '');
  assert.equal(page.bundleSuffix('ancla-bundle-2'), '_b2');
});
