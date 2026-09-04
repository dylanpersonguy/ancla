/**
 * Every capture we hold, and an honest answer about the ones we do not.
 *
 * Two questions, and they must not be confused with each other.
 *
 *   versions   what copies of each period are on disk, what each one hashes to,
 *              and whether that hash has been committed to the chain.
 *
 *   recovery   for a period the publisher rewrote after it closed, can the
 *              earlier contents still be produced. Usually the answer is no, and
 *              saying so plainly is the point. A Merkle root is a commitment, not
 *              an archive: it can refuse a forgery, it cannot reveal the rows.
 *
 * Anything that claims to recover the previous contents from a root alone is
 * comparing a hash against one it generated itself.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { AnchoredVersion } from '../../anchor/src/index.ts';
import { CANON_VERSION } from '../../canonicalize/src/canonical.ts';
import { buildSnapshot, readSnapshotHeader } from '../../canonicalize/src/snapshot.ts';
import { OBSERVATORIO } from '../../ingest/src/observatorio.ts';
import type { Source } from '../../ingest/src/source.ts';
import { schemaFor } from './schemas.ts';
import { type ArchiveRef, archives, months, snapshotsFor } from './store.ts';

/**
 * The key prefix a publisher's commitments carry on the shared anchor account.
 *
 * Costa Rica anchors unprefixed because its roots were already on chain under
 * those names before there was a second country. Everything else carries its
 * country code. Defined here rather than in main.ts because every reader of the
 * account has to apply the same filter: one address holds every publisher's
 * commitments, so "the roots for period 202405" is an ambiguous question until
 * the namespace is part of it.
 */
export function anchorNs(source: Source): string | null {
  return source.id === 'cr-observatorio' ? null : source.country.toLowerCase();
}

/**
 * The commitments belonging to one publisher.
 *
 * Skipping this filter is not a cosmetic error. Costa Rica and Panama both
 * publish a period called 202405, and comparing one country's held copy against
 * the other's root reports a root on chain that no copy here reproduces — which
 * reads as "the chain commits to an earlier version we lost". That is the exact
 * overclaim this project cannot make, and it would send someone hunting for a
 * file that never existed.
 */
export function forSource(anchored: AnchoredVersion[], source: Source): AnchoredVersion[] {
  const ns = anchorNs(source);
  return anchored.filter((a) => (a.ns ?? null) === ns);
}

export type Capture = {
  source: string;
  period: string;
  stamp: string;
  file: string;
  path: string;
  bytes: number;
  /** Null until the archive has been canonicalised. */
  archiveSha256: string | null;
  merkleRoot: string | null;
  recordCount: number | null;
  canonVersion: string | null;
  /** True when this copy was served after its own period had closed. */
  afterClose: boolean;
  /** True when the only snapshot held predates the current canonicaliser. */
  staleCanon: boolean;
  /** Set when this exact capture has its own commitment on chain. */
  anchoredRoot: string | null;
  anchorMatches: boolean | null;
};

/** `20260831T130427Z` -> Date. The inverse of compactStamp. */
export function stampToDate(stamp: string): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp);
  if (!m) return null;
  return new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])),
  );
}

export function servedAfterClose(source: Source, period: string, stamp: string): boolean {
  const d = stampToDate(stamp);
  return d ? d.getTime() > source.closesAt(period) : false;
}

export async function fileSha256(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

async function describe(
  ref: ArchiveRef,
  source: Source,
  anchored: Map<string, AnchoredVersion>,
): Promise<Capture> {
  const { size } = await stat(ref.path);
  // Prefer the current rules, but fall back to an older canonicalisation rather
  // than reporting a capture as unknown. A root anchored under ancla-canon-1 is
  // still a root, and hiding it would misread "we changed the rules" as "we lost
  // the capture". The version travels with the row so the difference is visible.
  let head: Awaited<ReturnType<typeof readSnapshotHeader>> | null = null;
  for (const { path } of await snapshotsFor(ref, source)) {
    try {
      head = await readSnapshotHeader(path);
      break;
    } catch {
      /* unreadable under these rules; try the next */
    }
  }
  const archiveSha256 = head?.archiveSha256 ?? null;
  // The canon version is part of the identity: one archive canonicalised under
  // two sets of rules has two roots, and matching on the archive alone would
  // report the v1 commitment as if it attested the v2 root.
  const key =
    archiveSha256 && head
      ? `${ref.month}_${archiveSha256.slice(0, 12)}_${head.canonVersion}`
      : null;
  const hit = key ? anchored.get(key) : undefined;
  return {
    source: ref.source,
    period: ref.month,
    stamp: ref.stamp,
    file: ref.file,
    path: ref.path,
    bytes: size,
    archiveSha256,
    merkleRoot: head?.merkleRoot ?? null,
    recordCount: head?.recordCount ?? null,
    canonVersion: head?.canonVersion ?? null,
    afterClose: servedAfterClose(source, ref.month, ref.stamp),
    staleCanon: head ? head.canonVersion !== CANON_VERSION : false,
    anchoredRoot: hit?.root ?? null,
    anchorMatches: hit ? hit.root === head?.merkleRoot : null,
  };
}

export function anchorIndex(anchored: AnchoredVersion[]): Map<string, AnchoredVersion> {
  return new Map(anchored.map((a) => [`${a.period}_${a.id}_${a.canonVersion}`, a]));
}

export async function capturesFor(
  period: string,
  source: Source = OBSERVATORIO,
  anchored: AnchoredVersion[] = [],
): Promise<Capture[]> {
  const idx = anchorIndex(forSource(anchored, source));
  const out: Capture[] = [];
  for (const ref of await archives(period, source)) out.push(await describe(ref, source, idx));
  return out;
}

export async function allCaptures(
  source: Source = OBSERVATORIO,
  anchored: AnchoredVersion[] = [],
): Promise<Capture[]> {
  const idx = anchorIndex(forSource(anchored, source));
  const out: Capture[] = [];
  for (const period of await months(source)) {
    for (const ref of await archives(period, source)) out.push(await describe(ref, source, idx));
  }
  return out;
}

export type RecoveryStatus =
  /** Two or more copies held. The row-level diff can be produced right now. */
  | 'diffable'
  /** One copy, and the chain commits to a different one. Candidates are testable. */
  | 'priorAnchored'
  /** One copy, served after the period closed, nothing earlier anywhere. Gone. */
  | 'currentOnly'
  /** One copy, served while the period was still open. Nothing was rewritten. */
  | 'neverRewritten';

export type Recovery = {
  /** Which publisher this period belongs to. Two countries publish a 202405. */
  source: string;
  period: string;
  held: number;
  status: RecoveryStatus;
  /** Roots on chain for this period that no held copy reproduces. */
  orphanRoots: string[];
  /**
   * The day the publisher wrote the earliest copy we hold, YYYY-MM-DD.
   *
   * Reported because it is what makes the shape of the gap legible. 148 periods
   * whose only copy was written on 2022-12-06 is one bulk publication, not 148
   * separate mysteries, and a report that lists them one per line without that
   * grouping invites the reader to count them as 148 rewrites.
   */
  servedDay: string | null;
  note: string;
};

const NOTES: Record<RecoveryStatus, string> = {
  diffable: 'both versions held; run: ancla bundle <period>',
  priorAnchored:
    'the chain commits to a copy we do not hold. A candidate can be tested against that root, but the rows cannot be recovered from it.',
  currentOnly:
    'one copy, written after the period closed, and nothing earlier here or on chain. Whatever the publisher served before that day cannot be produced — not from a root, and not from us.',
  neverRewritten: 'one copy, served before the period closed. Nothing has been rewritten.',
};

export async function recoveryInventory(
  source: Source = OBSERVATORIO,
  anchored: AnchoredVersion[] = [],
): Promise<Recovery[]> {
  const mine = forSource(anchored, source);
  const caps = await allCaptures(source, mine);
  const byPeriod = new Map<string, Capture[]>();
  for (const c of caps) {
    const list = byPeriod.get(c.period);
    if (list) list.push(c);
    else byPeriod.set(c.period, [c]);
  }

  const anchoredByPeriod = new Map<string, AnchoredVersion[]>();
  for (const a of mine) {
    const list = anchoredByPeriod.get(a.period);
    if (list) list.push(a);
    else anchoredByPeriod.set(a.period, [a]);
  }

  const out: Recovery[] = [];
  for (const [period, list] of [...byPeriod.entries()].sort()) {
    const heldRoots = new Set(list.map((c) => c.merkleRoot).filter(Boolean) as string[]);
    // Only roots under the current rules count as orphans. A v1 root that no v2
    // snapshot reproduces is not a lost copy, it is the same copy read by older
    // rules, and calling it a gap would manufacture 191 of them.
    const orphanRoots = (anchoredByPeriod.get(period) ?? [])
      .filter((a) => a.canonVersion === CANON_VERSION && !heldRoots.has(a.root))
      .map((a) => a.root);

    const status: RecoveryStatus =
      list.length > 1 ? 'diffable'
      : orphanRoots.length ? 'priorAnchored'
      : list.some((c) => c.afterClose) ? 'currentOnly'
      : 'neverRewritten';

    const earliest = list.map((c) => stampToDate(c.stamp)).filter(Boolean) as Date[];
    earliest.sort((a, b) => a.getTime() - b.getTime());
    out.push({
      source: source.id,
      period,
      held: list.length,
      status,
      orphanRoots,
      servedDay: earliest[0]?.toISOString().slice(0, 10) ?? null,
      note: NOTES[status],
    });
  }
  return out;
}

export type CandidateVerdict =
  /** Reproduces a root on chain that we do not hold. This IS the prior version. */
  | 'exactHistoricalVersion'
  /** Reproduces a copy already on disk. Nothing new, and nothing wrong. */
  | 'copyOfHeldVersion'
  /** Reproduces nothing committed. Usable as a lead, never as the official prior. */
  | 'unattestedExternalCopy';

export type CandidateResult = {
  period: string;
  path: string;
  archiveSha256: string;
  merkleRoot: string;
  recordCount: number;
  canonVersion: string;
  verdict: CandidateVerdict;
  matchedRoot: string | null;
  note: string;
};

/**
 * Test a third-party copy against what the chain already commits to.
 *
 * A match is the only case where an outside file can be called the prior version,
 * and even then only because the root was committed before the file was offered.
 * Everything else is labelled as independently sourced and stays that way; a copy
 * that reproduces nothing is a lead for a journalist, not evidence.
 */
export async function testCandidate(
  path: string,
  period: string,
  source: Source = OBSERVATORIO,
  anchored: AnchoredVersion[] = [],
): Promise<CandidateResult> {
  const buf = await readFile(path);
  const snap = buildSnapshot(period, buf, schemaFor(source.id));
  const held = new Set(
    (await capturesFor(period, source)).map((c) => c.merkleRoot).filter(Boolean) as string[],
  );
  const onChain = forSource(anchored, source).filter((a) => a.period === period);
  const match = onChain.find((a) => a.root === snap.merkleRoot) ?? null;

  const verdict: CandidateVerdict =
    match && !held.has(snap.merkleRoot) ? 'exactHistoricalVersion'
    : held.has(snap.merkleRoot) ? 'copyOfHeldVersion'
    : 'unattestedExternalCopy';

  return {
    period,
    path,
    archiveSha256: snap.archiveSha256,
    merkleRoot: snap.merkleRoot,
    recordCount: snap.recordCount,
    canonVersion: snap.canonVersion,
    verdict,
    matchedRoot: match?.root ?? null,
    note: {
      exactHistoricalVersion:
        'reproduces a root committed to the chain before this file was offered. This is the prior version.',
      copyOfHeldVersion: 'identical to a copy already stored here.',
      unattestedExternalCopy:
        'reproduces no committed root. Independently sourced; it cannot be treated as the official prior version.',
    }[verdict],
  };
}
