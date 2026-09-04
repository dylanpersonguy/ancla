/**
 * The bundle digest, recomputed in the browser.
 *
 * Same contract as hash.js: this has to stay byte-identical to `digestInput` in
 * packages/bundle/src/bundle.ts, and a test imports both and compares them
 * against the same manifest rather than re-typing either. If they drift, a page
 * shows "the digest on chain does not match" for a bundle that is perfectly
 * fine, which is worse than showing nothing at all.
 *
 * Why this matters more than it looks: it is what lets a reader check a bundle
 * without trusting the site. The manifest arrives from our API, the committed
 * digest is read straight off a public node, and this function is what connects
 * the two. If our API alters a single count, the digest it produces stops
 * matching the one the chain has held since the day the bundle was published.
 */

import { hex, sha256 } from "./hash.js";

const versionTuple = (r) => [
  r.source,
  r.period,
  r.stamp,
  r.file,
  r.archiveSha256,
  r.merkleRoot,
  String(r.recordCount),
];

/** Fixed order. Never derived from Object.keys, in either implementation. */
export const DETAIL_ORDER = [
  "silentRevision",
  "removed",
  "reformatted",
  "recordedAmendment",
  "added",
];

/** Every class of change, in the order the digest lists them. */
export const ALL_KINDS = [
  "added",
  "recordedAmendment",
  "silentRevision",
  "reformatted",
  "removed",
];

/**
 * The ancla-bundle-1 digest. Frozen, and reached only by dispatch on a
 * manifest's own version — two commitments were written under it and a reader
 * checking one of those has to get the same answer they would have got that day.
 */
export function digestInputV1(m) {
  return JSON.stringify([
    m.bundleVersion,
    m.canonVersion,
    m.source,
    m.period,
    versionTuple(m.from),
    versionTuple(m.to),
    DETAIL_ORDER.map((k) => [k, m.counts[k]]),
    m.schemaChanges.map((s) => [s.table, s.before, s.after]),
    m.changeCount,
    [m.detailPolicy.maxDetail, m.detailPolicy.order],
    m.valuesOmitted,
    m.changesSha256,
    m.canonVersionMismatch,
  ]);
}

/** ancla-bundle-2: the same, plus which classes of change were left unlisted. */
export function digestInputV2(m) {
  return JSON.stringify([
    m.bundleVersion,
    m.canonVersion,
    m.source,
    m.period,
    versionTuple(m.from),
    versionTuple(m.to),
    DETAIL_ORDER.map((k) => [k, m.counts[k]]),
    m.schemaChanges.map((s) => [s.table, s.before, s.after]),
    m.changeCount,
    ALL_KINDS.filter((k) => m.linePolicy.kinds.includes(k)),
    m.omittedByPolicy,
    [m.detailPolicy.maxDetail, m.detailPolicy.order],
    m.valuesOmitted,
    m.changesSha256,
    m.canonVersionMismatch,
  ]);
}

export function digestInput(m) {
  return m.bundleVersion === "ancla-bundle-1" ? digestInputV1(m) : digestInputV2(m);
}

export async function bundleDigest(m) {
  return hex(await sha256(new TextEncoder().encode(digestInput(m))));
}

/**
 * The chain key a bundle's commitment lives under.
 *
 * The canonicaliser is part of it. Leaving it off reads the commitment made under
 * the *previous* rules and compares it against a digest built under the current
 * ones, which never matches — so the page tells a reader the bundle was tampered
 * with when nothing is wrong. A verifier that cries wolf is worse than no
 * verifier, so this derivation is pinned by a test against the Node one.
 */
export function canonSuffix(canonVersion) {
  const m = /^ancla-canon-(\d+)$/.exec(canonVersion ?? "");
  if (!m) throw new Error(`unrecognised canonicaliser version: ${canonVersion}`);
  return m[1] === "1" ? "" : `_c${m[1]}`;
}

export function bundleSuffix(bundleVersion) {
  const m = /^ancla-bundle-(\d+)$/.exec(bundleVersion ?? "");
  if (!m) throw new Error(`unrecognised bundle version: ${bundleVersion}`);
  return m[1] === "1" ? "" : `_b${m[1]}`;
}

export function diffChainKey(m) {
  const from = m.from.archiveSha256.slice(0, 12);
  const to = m.to.archiveSha256.slice(0, 12);
  return `diff_${m.period}_${from}_${to}${canonSuffix(m.canonVersion)}${bundleSuffix(m.bundleVersion)}`;
}

export function versionChainKey(period, archiveSha256, canonVersion) {
  return `ver_${period}_${archiveSha256.slice(0, 12)}${canonSuffix(canonVersion)}`;
}

/** SHA-256 of arbitrary bytes, for checking a downloaded changes file. */
export async function digestBytes(u8) {
  return hex(await sha256(u8));
}
