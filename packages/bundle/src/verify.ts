/**
 * Check a bundle without trusting whoever produced it.
 *
 * Two levels, because they answer different questions.
 *
 *   verifyBundle          the bundle is internally consistent: the changes file
 *                         is the one the manifest names, the counts match the
 *                         lines, and the digest is the digest of this manifest.
 *                         Needs nothing but the bundle.
 *
 *   verifyAgainstArchives the bundle is what these two archives actually produce.
 *                         Needs the archives, and is the check that matters: the
 *                         first level only proves the publisher was self-consistent.
 *
 * Both return a list of checks rather than a boolean, because "it failed" is not
 * a useful thing to hand a journalist.
 */

import { createHash } from 'node:crypto';
import type { Schema } from '../../canonicalize/src/schema.ts';
import { buildSnapshot } from '../../canonicalize/src/snapshot.ts';
import type { ChangeKind } from '../../differ/src/index.ts';
import {
  ALL_KINDS,
  BUNDLE_VERSION,
  type BundleManifest,
  bundleDigest,
  buildBundle,
  parseChanges,
} from './bundle.ts';

export type Check = { name: string; ok: boolean; detail: string };
export type Verification = { ok: boolean; checks: Check[] };

function done(checks: Check[]): Verification {
  return { ok: checks.every((c) => c.ok), checks };
}

function sha256(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

export function verifyBundle(manifest: BundleManifest, changes: Buffer): Verification {
  const checks: Check[] = [];

  // An older bundle is not a broken one. Its digest is checked under its own
  // rules below, which is the whole reason those rules are frozen.
  const known = manifest.bundleVersion === BUNDLE_VERSION || manifest.bundleVersion === 'ancla-bundle-1';
  checks.push({
    name: 'bundle version',
    ok: known,
    detail: known
      ? `${manifest.bundleVersion}${
          manifest.bundleVersion === BUNDLE_VERSION ? '' : ` (older than this build, still valid)`
        }`
      : `${manifest.bundleVersion} is not a version this build can check`,
  });

  const actual = sha256(changes);
  checks.push({
    name: 'changes digest',
    ok: actual === manifest.changesSha256,
    detail: actual === manifest.changesSha256 ? actual : `${actual} != ${manifest.changesSha256}`,
  });

  const { bundleDigest: claimed, builtAt: _builtAt, ...body } = manifest;
  const recomputed = bundleDigest(body);
  checks.push({
    name: 'bundle digest',
    ok: recomputed === claimed,
    detail: recomputed === claimed ? recomputed : `${recomputed} != ${claimed}`,
  });

  let lines: ReturnType<typeof parseChanges>;
  try {
    lines = parseChanges(changes);
  } catch (err) {
    checks.push({ name: 'changes parse', ok: false, detail: String(err) });
    return done(checks);
  }

  checks.push({
    name: 'change count',
    ok: lines.length === manifest.changeCount,
    detail: `${lines.length} lines, manifest says ${manifest.changeCount}`,
  });

  const counted: Record<string, number> = {};
  let omitted = 0;
  for (const l of lines) {
    counted[l.kind] = (counted[l.kind] ?? 0) + 1;
    if (l.valuesOmitted) omitted++;
  }
  // A bundle-1 manifest has no line policy: every kind was written.
  const policy = manifest.linePolicy?.kinds ?? ALL_KINDS;
  const kept = new Set(policy);

  // Lines only have to match the counts for kinds the policy actually writes.
  const mismatched = (Object.keys(manifest.counts) as ChangeKind[]).filter((k) =>
    kept.has(k) ? (counted[k] ?? 0) !== manifest.counts[k] : (counted[k] ?? 0) !== 0,
  );
  checks.push({
    name: 'counts by kind',
    ok: mismatched.length === 0,
    detail: mismatched.length
      ? mismatched
          .map((k) =>
            kept.has(k)
              ? `${k}: ${counted[k] ?? 0} != ${manifest.counts[k]}`
              : `${k}: excluded by policy but ${counted[k]} line(s) present`,
          )
          .join(', ')
      : (Object.keys(manifest.counts) as ChangeKind[])
          .map((k) => `${k} ${manifest.counts[k]}${kept.has(k) ? '' : ' (not listed)'}`)
          .join(', '),
  });

  // The arithmetic that makes the omission honest: what the file holds plus what
  // the policy dropped must be every change the diff found.
  const total = (Object.keys(manifest.counts) as ChangeKind[]).reduce(
    (n, k) => n + manifest.counts[k],
    0,
  );
  const byPolicy = manifest.omittedByPolicy ?? 0;
  checks.push({
    name: 'policy arithmetic',
    ok: manifest.changeCount + byPolicy === total,
    detail: `${manifest.changeCount} written + ${byPolicy} omitted by policy = ${
      manifest.changeCount + byPolicy
    }, and the diff found ${total}`,
  });
  checks.push({
    name: 'values omitted',
    ok: omitted === manifest.valuesOmitted,
    detail: `${omitted} lines carry hashes only, manifest says ${manifest.valuesOmitted}`,
  });

  return done(checks);
}

/**
 * Rebuild the bundle from the two archives it names and compare.
 *
 * This is the reproducibility claim, stated as an executable check: two
 * independent workers holding the same bytes must produce the same digest.
 */
export function verifyAgainstArchives(
  manifest: BundleManifest,
  changes: Buffer,
  fromArchive: Buffer,
  toArchive: Buffer,
  schema?: Schema,
): Verification {
  const checks: Check[] = [];

  const fromSha = sha256(fromArchive);
  const toSha = sha256(toArchive);
  checks.push({
    name: 'earlier archive',
    ok: fromSha === manifest.from.archiveSha256,
    detail: fromSha === manifest.from.archiveSha256 ? fromSha : `${fromSha} != ${manifest.from.archiveSha256}`,
  });
  checks.push({
    name: 'later archive',
    ok: toSha === manifest.to.archiveSha256,
    detail: toSha === manifest.to.archiveSha256 ? toSha : `${toSha} != ${manifest.to.archiveSha256}`,
  });
  if (!checks.every((c) => c.ok)) return done(checks);

  const fromSnap = buildSnapshot(manifest.from.period, fromArchive, schema);
  const toSnap = buildSnapshot(manifest.to.period, toArchive, schema);
  checks.push({
    name: 'earlier root',
    ok: fromSnap.merkleRoot === manifest.from.merkleRoot,
    detail: `${fromSnap.merkleRoot}${
      fromSnap.merkleRoot === manifest.from.merkleRoot ? '' : ` != ${manifest.from.merkleRoot}`
    }`,
  });
  checks.push({
    name: 'later root',
    ok: toSnap.merkleRoot === manifest.to.merkleRoot,
    detail: `${toSnap.merkleRoot}${
      toSnap.merkleRoot === manifest.to.merkleRoot ? '' : ` != ${manifest.to.merkleRoot}`
    }`,
  });

  const rebuilt = buildBundle(
    { snapshot: fromSnap, archive: fromArchive, ref: manifest.from },
    { snapshot: toSnap, archive: toArchive, ref: manifest.to },
    {
      schema,
      maxDetail: manifest.detailPolicy.maxDetail,
      linePolicy: manifest.linePolicy ?? { kinds: ALL_KINDS },
    },
  );
  checks.push({
    name: 'rebuilt changes',
    ok: rebuilt.manifest.changesSha256 === manifest.changesSha256,
    detail:
      rebuilt.manifest.changesSha256 === manifest.changesSha256
        ? 'byte for byte'
        : `${rebuilt.manifest.changesSha256} != ${manifest.changesSha256}`,
  });
  checks.push({
    name: 'rebuilt digest',
    ok: rebuilt.manifest.bundleDigest === manifest.bundleDigest,
    detail:
      rebuilt.manifest.bundleDigest === manifest.bundleDigest
        ? rebuilt.manifest.bundleDigest
        : `${rebuilt.manifest.bundleDigest} != ${manifest.bundleDigest}`,
  });
  checks.push({
    name: 'published changes match rebuild',
    ok: sha256(changes) === rebuilt.manifest.changesSha256,
    detail: sha256(changes) === rebuilt.manifest.changesSha256 ? 'identical' : 'differ',
  });

  return done(checks);
}

export function verificationText(v: Verification): string {
  const lines = v.checks.map((c) => `  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.name.padEnd(28)} ${c.detail}`);
  lines.push('', v.ok ? 'All checks passed.' : 'VERIFICATION FAILED.');
  return lines.join('\n');
}
