/**
 * Commit one capture, and one diff, rather than one day.
 *
 * The daily plan in index.ts writes `root_<day>_<period>` for whatever copy of a
 * period we hold when it runs. That is enough to prove the record changed, and it
 * has one hole: it is addressed by the day the job ran. A copy that arrives and is
 * replaced between two runs is never committed to, and a day the job misses takes
 * that copy's root with it. Both are recoverable off-chain and neither is
 * provable afterwards, which is the wrong way round.
 *
 * So each capture also gets a key of its own, derived from the bytes rather than
 * from the calendar:
 *
 *   ver_<period>_<sha12>    the Merkle root of that exact copy
 *   vmeta_<period>_<sha12>  canon version, record count, full archive hash, stamp
 *
 * The key is a function of the archive's own SHA-256, so anchoring the same
 * capture twice writes the same key with the same value, and the contract's
 * refusal to overwrite makes that a no-op rather than a rewrite. Two different
 * copies can never collide onto one key without a SHA-256 collision.
 *
 * A published diff gets the same treatment, keyed by the pair it compares:
 *
 *   diff_<period>_<fromSha12>_<toSha12>   the bundle digest
 *   dmeta_<period>_<fromSha12>_<toSha12>  bundle version and the five counts
 *
 * The chain still holds no procurement data. It holds a commitment to a bundle
 * whose bytes anyone can rebuild from the two archives.
 */

import type { DataEntry } from './datatx.ts';
import { MAX_ENTRIES } from './datatx.ts';
import { type AnchorPlan, nsPrefix } from './index.ts';

/** How much of an archive's SHA-256 names it. Matches the mirror's filenames. */
export const ID_LEN = 12;

export function captureId(archiveSha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new Error(`not a sha256: ${archiveSha256}`);
  }
  return archiveSha256.slice(0, ID_LEN);
}

export type Capture = {
  period: string;
  /** Publisher Last-Modified, compacted. */
  stamp: string;
  archiveSha256: string;
  merkleRoot: string;
  recordCount: number;
  canonVersion: string;
};

export type DiffCommitment = {
  period: string;
  /** The rules the two snapshots behind this bundle were built under. */
  canonVersion: string;
  fromSha256: string;
  toSha256: string;
  bundleDigest: string;
  bundleVersion: string;
  changesSha256: string;
  counts: { added: number; recordedAmendment: number; silentRevision: number; reformatted: number; removed: number };
};

/**
 * The canonicaliser marker a key carries, or '' for the first version.
 *
 * One archive has one set of bytes and therefore one key — until the rules for
 * reading those bytes change, at which point it has two roots and needs two.
 * Without this the second root cannot be committed at all: the key would already
 * exist, the contract would refuse to overwrite it (correctly), and the anchor
 * step would skip the capture forever. We would hold the current canonicalisation
 * of 191 archives and be unable to prove any of it.
 *
 * ancla-canon-1 is unsuffixed because 228 commitments were written under those
 * names before there was a second version, and renaming them would orphan every
 * one. Everything after carries its number.
 */
export function canonSuffix(canonVersion: string): string {
  const m = /^ancla-canon-(\d+)$/.exec(canonVersion);
  if (!m) throw new Error(`unrecognised canonicaliser version: ${canonVersion}`);
  return m[1] === '1' ? '' : `_c${m[1]}`;
}

export function versionKey(c: Capture, ns?: string): string {
  return `ver_${nsPrefix(ns)}${c.period}_${captureId(c.archiveSha256)}${canonSuffix(c.canonVersion)}`;
}

export function versionMetaKey(c: Capture, ns?: string): string {
  return `vmeta_${nsPrefix(ns)}${c.period}_${captureId(c.archiveSha256)}${canonSuffix(c.canonVersion)}`;
}

export function versionMeta(c: Capture): string {
  return `${c.canonVersion}|${c.recordCount}|${c.archiveSha256}|${c.stamp}`;
}

/**
 * The bundle-format marker, alongside the canonicaliser one.
 *
 * Both for the same reason: a rebuild of the same two archives under new rules
 * produces a different digest, and without a distinct key it lands on one the
 * contract will not overwrite — so the newer reading could never be committed at
 * all. First version of each is unsuffixed, because commitments exist under those
 * names.
 */
export function bundleSuffix(bundleVersion: string): string {
  const m = /^ancla-bundle-(\d+)$/.exec(bundleVersion);
  if (!m) throw new Error(`unrecognised bundle version: ${bundleVersion}`);
  return m[1] === '1' ? '' : `_b${m[1]}`;
}

function diffSuffix(d: DiffCommitment): string {
  return `${canonSuffix(d.canonVersion)}${bundleSuffix(d.bundleVersion)}`;
}

export function diffKey(d: DiffCommitment, ns?: string): string {
  return `diff_${nsPrefix(ns)}${d.period}_${captureId(d.fromSha256)}_${captureId(d.toSha256)}${diffSuffix(d)}`;
}

export function diffMetaKey(d: DiffCommitment, ns?: string): string {
  return `dmeta_${nsPrefix(ns)}${d.period}_${captureId(d.fromSha256)}_${captureId(d.toSha256)}${diffSuffix(d)}`;
}

/** Counts in a fixed order, so a reader never has to guess which number is which. */
export function diffMeta(d: DiffCommitment): string {
  const c = d.counts;
  return [
    d.bundleVersion,
    `${c.added},${c.recordedAmendment},${c.silentRevision},${c.reformatted},${c.removed}`,
    d.changesSha256,
  ].join('|');
}

function entriesFor(captures: Capture[], diffs: DiffCommitment[], ns?: string): DataEntry[] {
  const entries: DataEntry[] = [];
  for (const c of captures) {
    entries.push({ key: versionKey(c, ns), type: 'string', value: c.merkleRoot });
    entries.push({ key: versionMetaKey(c, ns), type: 'string', value: versionMeta(c) });
  }
  for (const d of diffs) {
    entries.push({ key: diffKey(d, ns), type: 'string', value: d.bundleDigest });
    entries.push({ key: diffMetaKey(d, ns), type: 'string', value: diffMeta(d) });
  }
  return entries;
}

/**
 * One or more transactions committing every capture and diff given.
 *
 * `day` is carried for display and for the plan shape the signer expects. It is
 * deliberately not part of any key: that is the whole point of this module.
 */
export function planCaptures(
  day: string,
  captures: Capture[],
  diffs: DiffCommitment[] = [],
  ns?: string,
  maxEntries = MAX_ENTRIES,
): AnchorPlan[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('day must be YYYY-MM-DD');
  if (ns && !/^[a-z]{2}$/.test(ns)) throw new Error('namespace must be a two-letter country code');
  const all = entriesFor(captures, diffs, ns);
  if (!all.length) throw new Error('nothing to anchor');

  const seen = new Set<string>();
  for (const e of all) {
    if (seen.has(e.key)) throw new Error(`duplicate key in one plan: ${e.key}`);
    seen.add(e.key);
  }

  const plans: AnchorPlan[] = [];
  for (let i = 0; i < all.length; i += maxEntries) {
    const chunk = all.slice(i, i + maxEntries);
    plans.push({
      day,
      kind: 'version',
      entries: chunk,
      roots: captures
        .filter((c) => chunk.some((e) => e.key === versionKey(c, ns)))
        .map((c) => ({ day, root: c.merkleRoot, month: c.period, recordCount: c.recordCount })),
    });
  }
  return plans;
}

export type AnchoredVersion = {
  ns: string | null;
  period: string;
  id: string;
  /** Read off the key, so an unsuffixed legacy key reports ancla-canon-1. */
  canonVersion: string;
  root: string;
  recordCount: number | null;
  archiveSha256: string | null;
  stamp: string | null;
};

export type AnchoredDiff = {
  ns: string | null;
  period: string;
  fromId: string;
  toId: string;
  canonVersion: string;
  /** Read off the key; an unsuffixed legacy key reports ancla-bundle-1. */
  bundleVersion: string;
  changesSha256: string | null;
  counts: DiffCommitment['counts'] | null;
};

type Entry = { key: string; value: string | number | boolean };

/**
 * Split `ver_202512_0f4f37495713` and `ver_pa_202512_0f4f37495713` the same way.
 *
 * A period never contains an underscore and neither does a hex id, so counting
 * from the right is unambiguous and stays that way if a third key shape appears.
 */
/** Take a trailing `_c<N>` off a key, returning the version it names. */
function takeCanon(parts: string[]): string {
  const last = parts[parts.length - 1] ?? '';
  const m = /^c(\d+)$/.exec(last);
  if (!m) return 'ancla-canon-1';
  parts.pop();
  return `ancla-canon-${m[1]}`;
}

/** Take a trailing `_b<N>` off a key. Runs before takeCanon: c comes first. */
function takeBundle(parts: string[]): string {
  const last = parts[parts.length - 1] ?? '';
  const m = /^b(\d+)$/.exec(last);
  if (!m) return 'ancla-bundle-1';
  parts.pop();
  return `ancla-bundle-${m[1]}`;
}

function splitVersionKey(
  suffix: string,
): { ns: string | null; period: string; id: string; canonVersion: string } | null {
  const parts = suffix.split('_');
  if (parts.length < 2) return null;
  const canonVersion = takeCanon(parts);
  if (parts.length < 2) return null;
  const id = parts.pop() as string;
  const period = parts.pop() as string;
  return { ns: parts.length ? parts.join('_') : null, period, id, canonVersion };
}

function splitDiffKey(suffix: string): {
  ns: string | null;
  period: string;
  fromId: string;
  toId: string;
  canonVersion: string;
  bundleVersion: string;
} | null {
  const parts = suffix.split('_');
  if (parts.length < 3) return null;
  const bundleVersion = takeBundle(parts);
  const canonVersion = takeCanon(parts);
  if (parts.length < 3) return null;
  const toId = parts.pop() as string;
  const fromId = parts.pop() as string;
  const period = parts.pop() as string;
  return {
    ns: parts.length ? parts.join('_') : null,
    period, fromId, toId, canonVersion, bundleVersion,
  };
}

function parseVersionMeta(
  meta: string | undefined,
): Pick<AnchoredVersion, 'recordCount' | 'archiveSha256' | 'stamp'> {
  const p = (meta ?? '').split('|');
  const n = Number(p[1]);
  return {
    recordCount: Number.isFinite(n) && p.length > 1 ? n : null,
    archiveSha256: p[2] || null,
    stamp: p[3] || null,
  };
}

function parseDiffMeta(
  meta: string | undefined,
): Pick<AnchoredDiff, 'changesSha256' | 'counts'> {
  const p = (meta ?? '').split('|');
  const nums = (p[1] ?? '').split(',').map(Number);
  const ok = nums.length === 5 && nums.every((n) => Number.isFinite(n));
  return {
    changesSha256: p[2] || null,
    counts: ok
      ? {
          added: nums[0] as number,
          recordedAmendment: nums[1] as number,
          silentRevision: nums[2] as number,
          reformatted: nums[3] as number,
          removed: nums[4] as number,
        }
      : null,
  };
}

/** Pull the capture and diff commitments out of an account's data entries. */
export function groupVersionEntries(entries: Entry[]): {
  versions: AnchoredVersion[];
  diffs: AnchoredDiff[];
} {
  const vmeta = new Map<string, string>();
  const dmeta = new Map<string, string>();
  for (const e of entries) {
    if (e.key.startsWith('vmeta_')) vmeta.set(e.key.slice(6), String(e.value));
    else if (e.key.startsWith('dmeta_')) dmeta.set(e.key.slice(6), String(e.value));
  }

  const versions: AnchoredVersion[] = [];
  const diffs: AnchoredDiff[] = [];
  for (const e of entries) {
    if (e.key.startsWith('ver_')) {
      const suffix = e.key.slice(4);
      const k = splitVersionKey(suffix);
      if (!k) continue;
      versions.push({ ...k, root: String(e.value), ...parseVersionMeta(vmeta.get(suffix)) });
    } else if (e.key.startsWith('diff_')) {
      const suffix = e.key.slice(5);
      const k = splitDiffKey(suffix);
      if (!k) continue;
      diffs.push({ ...k, bundleDigest: String(e.value), ...parseDiffMeta(dmeta.get(suffix)) });
    }
  }
  const byPeriod = (a: { period: string }, b: { period: string }) =>
    a.period < b.period ? -1 : a.period > b.period ? 1 : 0;
  return { versions: versions.sort(byPeriod), diffs: diffs.sort(byPeriod) };
}
