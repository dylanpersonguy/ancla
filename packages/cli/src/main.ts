#!/usr/bin/env node
/**
 * ancla — public evidence layer for Costa Rican procurement records.
 *
 *   ancla survey                    what the source holds, and what it has rewritten
 *   ancla mirror [--from M --to M]  fetch archives; resumable, never overwrites
 *   ancla status                    what we hold, and what changed since we started
 *   ancla snapshot [month...]       canonicalize archives into Merkle-rooted snapshots
 *   ancla diff <month>              compare a month's two most recent versions
 *   ancla anchor [--broadcast]      commit today's roots to DecentralChain
 *   ancla prove <month> <table> <id>  Merkle proof for one record
 *   ancla node                      chain reachability check
 */

import { readFile } from 'node:fs/promises';
import { dataRoot, sourceRoot } from '../../ingest/src/manifest.ts';
import { buildSnapshot, leafFor, writeSnapshot } from '../../canonicalize/src/snapshot.ts';
import { proof, root as merkleRoot, verify as merkleVerify } from '../../merkle/src/index.ts';
import { diff, summarize } from '../../differ/src/index.ts';
import {
  type AnchoredDiff, type AnchoredVersion, type Capture as ChainCapture, type DiffCommitment,
  balance, broadcast, generateKey, groupVersionEntries, height, keyExists, keyPath, loadKeys,
  MAINNET_CHAIN_ID, anchorAddress, planAnchor, planAnchorBatched, planCaptures, readAllEntries,
  readRoot, signAnchor, version,
} from '../../anchor/src/index.ts';
import { UNLIMITED_DETAIL } from '../../bundle/src/bundle.ts';
import { verificationText, verifyAgainstArchives, verifyBundle } from '../../bundle/src/verify.ts';
import {
  archivesForManifest, buildFor, dirFor, listBundles, loadBundle, persist,
} from './bundles.ts';
import {
  type Capture, allCaptures, anchorNs as nsFor, capturesFor, forSource, recoveryInventory,
  testCandidate,
} from './versions.ts';
import { allSnapshotHeaders, archives, loadOrBuild, months, snapshotPath } from './store.ts';
import { resolveSource } from '../../ingest/src/sources.ts';
import type { Source } from '../../ingest/src/source.ts';
import { schemaFor } from './schemas.ts';
import { type RecordHistory, recordHistory } from './history.ts';
import { reportText, runWatch, writeReport } from './watch.ts';

const out = (s = '') => process.stdout.write(`${s}\n`);

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--broadcast') flags.broadcast = true;
    else if (a === '--json') flags.json = true;
    else if (a === '--full') flags.full = true;
    else if (a === '--versions') flags.versions = true;
    else if (a === '--offline') flags.offline = true;
    else if (a === '--bundle-all') flags['bundle-all'] = true;
    else if (a === '--new-canon') flags['new-canon'] = true;
    else if (a === '--yes') flags.yes = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--all') flags.all = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

/** `undefined` rather than `null`, because that is what the anchor plans take. */
function anchorNs(source: Source): string | undefined {
  return nsFor(source) ?? undefined;
}

async function cmdSnapshot(targets: string[], source: Source): Promise<void> {
  const list = targets.length ? targets : await months(source);
  out(`${source.label}\nsnapshotting ${list.length} period(s) into ${sourceRoot(source)}/snapshots`);
  let built = 0;
  let skipped = 0;
  for (const month of list) {
    for (const ref of await archives(month, source)) {
      const p = snapshotPath(ref, source);
      try {
        await readFile(p);
        skipped++;
        continue;
      } catch {
        /* not built yet */
      }
      const snap = buildSnapshot(month, await readFile(ref.path), schemaFor(ref.source));
      await writeSnapshot(p, snap);
      built++;
      out(`  ${month}  ${ref.stamp}  ${snap.recordCount.toLocaleString()} records  ${snap.merkleRoot.slice(0, 16)}`);
    }
  }
  out(`\nbuilt ${built}, already present ${skipped}`);
}

async function cmdDiff(month: string, source: Source): Promise<void> {
  if (!month) throw new Error('usage: ancla diff <YYYYMM>');
  const refs = await archives(month, source);
  if (refs.length < 2) {
    out(`${month}: only ${refs.length} version stored. Nothing to compare yet.`);
    out('A second version appears when the source rewrites this month.');
    return;
  }
  const from = await loadOrBuild(refs[refs.length - 2], source);
  const to = await loadOrBuild(refs[refs.length - 1], source);
  out(summarize(diff(from, to, { limit: 50 })));
}

async function cmdKeygen(flags: Record<string, string | boolean>): Promise<void> {
  if ((await keyExists()) && !flags.force) {
    out(`an anchor key already exists at ${keyPath()}`);
    out('refusing to overwrite. pass --force only if you are certain.');
    process.exitCode = 1;
    return;
  }
  const id = await generateKey(MAINNET_CHAIN_ID);
  out('anchor account created.');
  out('');
  out(`  address    ${id.address}`);
  out(`  publicKey  ${id.publicKey}`);
  out(`  network    mainnet (chain id "${id.chainId}")`);
  out(`  seed file  ${keyPath()}  (mode 0600)`);
  out('');
  out('The seed is on disk and was deliberately not printed. Back it up out of band.');
  out('Whoever holds it can write roots, so it is the credibility of this system.');
  out('');
  out('Next: fund the address with DCC for fees, then run "ancla anchor --broadcast".');
}

async function cmdAnchor(flags: Record<string, string | boolean>, source: Source): Promise<void> {
  const day = (flags.day as string) ?? new Date().toISOString().slice(0, 10);

  // --all anchors every snapshotted month. That needs more entries than one
  // transaction holds, so it batches. Everything else anchors a single month.
  if (flags.all) return cmdAnchorAll(day, flags, source);

  const list = flags.month ? [flags.month as string] : (await months(source)).slice(-1);
  const snaps = [];
  for (const m of list) {
    const refs = await archives(m, source);
    if (refs.length) snaps.push(await loadOrBuild(refs[refs.length - 1], source));
  }
  if (!snaps.length) {
    out('nothing mirrored to anchor. run: ancla mirror');
    return;
  }
  const plan = planAnchor(day, snaps, anchorNs(source));
  out(`anchor plan for ${day}   (${await version()}, height ${(await height()).toLocaleString()})`);
  for (const r of plan.roots) {
    out(`  ${r.month}  ${r.root}  ${r.recordCount.toLocaleString()} records`);
  }
  out(`  ${plan.entries.length} data entries`);

  if (!flags.broadcast) {
    out('');
    out('dry run. nothing was sent.');
    out('to broadcast: ancla keygen, fund the address, then rerun with --broadcast');
    return;
  }

  const keys = await loadKeys(MAINNET_CHAIN_ID);
  const tx = signAnchor(plan, keys.privateKey, keys.publicKey, Date.now());
  const bal = await balance(keys.address);
  out('');
  out(`  sender  ${keys.address}`);
  out(`  balance ${(bal / 1e8).toFixed(8)} DCC`);
  out(`  fee     ${(tx.fee / 1e8).toFixed(8)} DCC`);
  if (bal < tx.fee) {
    out('');
    out(`insufficient balance. fund ${keys.address} with at least ${(tx.fee / 1e8).toFixed(8)} DCC.`);
    process.exitCode = 1;
    return;
  }
  const res = await broadcast(tx);
  out('');
  out(`broadcast ${res.id}`);
  out(`verify:   ancla node   (or read root_${day}_${plan.roots[0].month} on ${keys.address})`);
}

async function cmdAnchorAll(
  day: string,
  flags: Record<string, string | boolean>,
  source: Source,
): Promise<void> {
  const heads = await allSnapshotHeaders(source);
  if (!heads.length) {
    out('no snapshots. run: ancla snapshot');
    return;
  }
  const batches = planAnchorBatched(day, heads as never, undefined, anchorNs(source));
  const records = heads.reduce((s, h) => s + h.recordCount, 0);
  const entries = batches.reduce((s, b) => s + b.entries.length, 0);

  out(`historical backfill for ${day}`);
  out(`  months      ${heads.length}  (${heads[0].month} to ${heads[heads.length - 1].month})`);
  out(`  records     ${records.toLocaleString()}`);
  out(`  entries     ${entries}  across ${batches.length} transactions`);
  batches.forEach((b, i) =>
    out(`    batch ${i + 1}  ${String(b.roots.length).padStart(3)} months  ${b.entries.length} entries`),
  );

  if (!flags.broadcast) {
    out('');
    out('dry run. nothing was sent.');
    out('to broadcast: rerun with --broadcast');
    return;
  }

  const keys = await loadKeys(MAINNET_CHAIN_ID);
  const bal = await balance(keys.address);
  const signed = batches.map((b, i) => signAnchor(b, keys.privateKey, keys.publicKey, Date.now() + i));
  const totalFee = signed.reduce((s, t) => s + t.fee, 0);
  out('');
  out(`  sender  ${keys.address}`);
  out(`  balance ${(bal / 1e8).toFixed(8)} DCC`);
  out(`  fee     ${(totalFee / 1e8).toFixed(8)} DCC total`);
  if (bal < totalFee) {
    out(`insufficient balance. need ${(totalFee / 1e8).toFixed(8)} DCC.`);
    process.exitCode = 1;
    return;
  }
  out('');
  for (let i = 0; i < signed.length; i++) {
    const res = await broadcast(signed[i]);
    out(`  batch ${i + 1}/${signed.length}  ${res.id}`);
  }
  out('');
  out(`${heads.length} monthly roots anchored on ${day}`);
}

async function cmdProve(
  month: string,
  table: string,
  id: string,
  source: Source,
  day?: string,
): Promise<void> {
  if (!month || !table || !id) throw new Error('usage: ancla prove <YYYYMM> <Table> <id>');
  const refs = await archives(month, source);
  if (!refs.length) throw new Error(`no archive stored for ${month}`);
  const snap = await loadOrBuild(refs[refs.length - 1], source);
  const idx = snap.records.findIndex((r) => r.table === table && r.id === id);
  if (idx < 0) throw new Error(`record not found in ${month}: ${table} ${id}`);
  const leaves = snap.records.map(leafFor);
  const path = proof(leaves, idx);
  const rec = snap.records[idx];
  const ok = merkleVerify(leaves[idx], path, snap.merkleRoot);
  out(
    JSON.stringify(
      {
        month,
        anchoredDay: day ?? null,
        table,
        id,
        byteHash: rec.byteHash,
        leafIndex: idx,
        leafCount: leaves.length,
        merkleRoot: snap.merkleRoot,
        archiveSha256: snap.archiveSha256,
        canonVersion: snap.canonVersion,
        proof: path,
        verifiesLocally: ok,
      },
      null,
      2,
    ),
  );
}

/** Trim a value for display without hiding that it was trimmed. */
function short(v: string | null): string {
  if (v === null) return '(absent)';
  if (v === '') return '(empty)';
  return v.length > 58 ? `${v.slice(0, 55)}…` : v;
}

function historyText(h: RecordHistory): string {
  const lines: string[] = [];
  lines.push(`${h.table}  ${h.id}   ${h.month}`);
  lines.push('');
  lines.push(`${h.versions.length} cop${h.versions.length === 1 ? 'y' : 'ies'} held:`);
  for (const v of h.versions) {
    const state = v.present ? `leaf ${v.leafIndex} of ${v.leafCount}` : 'not in this copy';
    const proven = v.present ? (v.verifiesLocally ? 'proof ok' : 'PROOF FAILED') : '';
    lines.push(`  ${v.stamp}  ${state.padEnd(24)} ${proven}`);
    if (v.present) lines.push(`    root ${v.merkleRoot}`);
  }

  if (!h.transitions.length) {
    lines.push('');
    lines.push('Never changed across the copies held.');
    return lines.join('\n');
  }

  for (const t of h.transitions) {
    lines.push('');
    lines.push(`${t.from} -> ${t.to}   ${t.kind.toUpperCase()}`);
    if (t.kind === 'silentRevision') {
      lines.push('  changed with no amendment recorded by the publisher.');
    }
    for (const f of t.fields) {
      lines.push(`    ${f.field}`);
      lines.push(`      before  ${short(f.before)}`);
      lines.push(`      after   ${short(f.after)}`);
    }
    if (!t.fields.length) lines.push('    (no field differs; the encoding changed)');
  }
  return lines.join('\n');
}

async function cmdHistory(
  month: string,
  table: string,
  id: string,
  source: Source,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!month || !table || !id) throw new Error('usage: ancla history <YYYYMM> <Table> <id>');
  const h = await recordHistory(month, table, id, source);
  out(flags.json ? JSON.stringify(h, null, 2) : historyText(h));
}

async function cmdWatch(flags: Record<string, string | boolean>, source: Source): Promise<void> {
  const r = await runWatch({
    source,
    from: flags.from as string | undefined,
    to: flags.to as string | undefined,
    bundleAll: Boolean(flags['bundle-all']),
    log: (s) => out(s),
  });
  out('');
  out(reportText(r));
  out('');
  out(`report written to ${await writeReport(r, source)}`);
  // Exit 2 signals "a closed month was rewritten with real changes", so a cron
  // wrapper can page someone without parsing prose.
  const material = r.findings.some(
    (f) => f.closedMonth && f.diff.counts.silentRevision + f.diff.counts.removed > 0,
  );
  if (material) process.exitCode = 2;
}

async function cmdNode(): Promise<void> {
  out(`height  ${(await height()).toLocaleString()}`);
  out(`version ${await version()}`);
  const addr = process.env.ANCLA_ANCHOR_ADDRESS;
  if (addr) {
    const day = new Date().toISOString().slice(0, 10);
    out(`root for ${day}: ${JSON.stringify(await readRoot(addr, day))}`);
  }
}

/**
 * Read the account's commitments, or say plainly that we could not.
 *
 * Every command that reports on anchoring works offline too: a node outage must
 * not turn "we hold two copies" into an error. It degrades to "anchor state
 * unknown", which is different from "not anchored" and is labelled as such.
 */
async function anchoredVersions(
  flags: Record<string, string | boolean>,
): Promise<{
  versions: AnchoredVersion[];
  diffs: AnchoredDiff[];
  reachable: boolean;
  error?: string;
}> {
  const empty = { versions: [], diffs: [] };
  if (flags.offline) return { ...empty, reachable: false, error: 'offline' };
  try {
    return { ...groupVersionEntries(await readAllEntries(anchorAddress())), reachable: true };
  } catch (err) {
    return { ...empty, reachable: false, error: (err as Error).message };
  }
}

function captureLine(c: Capture, chainKnown: boolean): string {
  const root = c.merkleRoot ? c.merkleRoot.slice(0, 16) : 'not canonicalised';
  const anchored =
    !chainKnown ? 'anchor unknown'
    : c.anchoredRoot === null ? 'NOT ANCHORED'
    : c.anchorMatches ? 'anchored'
    : 'ANCHOR MISMATCH';
  const size = `${(c.bytes / 1_048_576).toFixed(1)} MB`;
  return `  ${c.stamp}  ${size.padStart(9)}  ${root.padEnd(18)} ${
    (c.recordCount?.toLocaleString() ?? '-').padStart(11)
  }  ${anchored}${c.afterClose ? '   (served after close)' : ''}`;
}

async function cmdVersions(
  period: string | undefined,
  source: Source,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const chain = await anchoredVersions(flags);
  const caps = period
    ? await capturesFor(period, source, chain.versions)
    : await allCaptures(source, chain.versions);
  if (flags.json) {
    out(JSON.stringify({ source: source.id, chain, captures: caps }, null, 2));
    return;
  }

  out(source.label);
  out(chain.reachable
    ? `chain ${anchorAddress()}  ${chain.versions.length} capture commitment(s)`
    : `chain unreachable (${chain.error}); anchor state is unknown, not absent`);
  out('');

  const byPeriod = new Map<string, Capture[]>();
  for (const c of caps) {
    const list = byPeriod.get(c.period);
    if (list) list.push(c);
    else byPeriod.set(c.period, [c]);
  }
  let multi = 0;
  for (const [p, list] of [...byPeriod.entries()].sort()) {
    if (list.length > 1) multi++;
    if (!period && list.length < 2) continue; // the full listing is about rewrites
    out(`${p}   ${list.length} cop${list.length === 1 ? 'y' : 'ies'}`);
    for (const c of list) out(captureLine(c, chain.reachable));
  }
  out('');
  out(`${caps.length.toLocaleString()} captures across ${byPeriod.size} periods; ${multi} period(s) hold more than one.`);
  if (!period && multi === 0) out('Pass a period to list its single copy.');
}

async function cmdRecover(
  source: Source,
  flags: Record<string, string | boolean>,
): Promise<void> {
  const chain = await anchoredVersions(flags);

  if (flags.candidate) {
    const period = flags.period as string;
    if (!period) throw new Error('usage: ancla recover --candidate <file> --period <YYYYMM>');
    const r = await testCandidate(flags.candidate as string, period, source, chain.versions);
    if (flags.json) return out(JSON.stringify(r, null, 2));
    out(`candidate for ${period}`);
    out(`  file        ${r.path}`);
    out(`  sha256      ${r.archiveSha256}`);
    out(`  merkle root ${r.merkleRoot}`);
    out(`  records     ${r.recordCount.toLocaleString()}`);
    out('');
    out(`  ${r.verdict}`);
    out(`  ${r.note}`);
    if (!chain.reachable) out('  (chain unreachable: only local copies were compared)');
    return;
  }

  const inv = await recoveryInventory(source, chain.versions);
  if (flags.json) return out(JSON.stringify({ chain, inventory: inv }, null, 2));

  const groups = new Map<string, typeof inv>();
  for (const r of inv) {
    const list = groups.get(r.status);
    if (list) list.push(r);
    else groups.set(r.status, [r]);
  }
  out(source.label);
  out('What can still be recovered, and what cannot.');
  out('');
  for (const status of ['diffable', 'priorAnchored', 'currentOnly', 'neverRewritten'] as const) {
    const list = groups.get(status) ?? [];
    if (!list.length) continue;
    out(`${status}  (${list.length})`);
    out(`  ${list[0]?.note}`);
    if (status === 'diffable' || status === 'priorAnchored') {
      for (const r of list) {
        out(`    ${r.period}  ${r.held} held${r.orphanRoots.length ? `  ${r.orphanRoots.length} root(s) on chain with no copy here` : ''}`);
      }
    } else if (status === 'currentOnly') {
      // By the day the publisher wrote them, because that is the unit these
      // arrived in. One bulk load in December 2022 accounts for most of them.
      const byDay = new Map<string, string[]>();
      for (const r of list) {
        const d = r.servedDay ?? 'unknown';
        const at = byDay.get(d);
        if (at) at.push(r.period);
        else byDay.set(d, [r.period]);
      }
      for (const [day, periods] of [...byDay.entries()].sort()) {
        const sorted = periods.sort();
        out(`    ${day}   ${String(periods.length).padStart(3)} period(s)   ${sorted[0]} - ${sorted[sorted.length - 1]}`);
      }
    }
    out('');
  }
  if (!chain.reachable) {
    out('The chain was not reachable, so "currentOnly" here may be "priorAnchored".');
    out('Rerun without --offline once the node answers.');
  }
}

async function cmdBundle(
  period: string,
  source: Source,
  flags: Record<string, string | boolean>,
): Promise<void> {
  if (!period) throw new Error('usage: ancla bundle <YYYYMM> [--from stamp] [--to stamp]');
  const { bundle, dir, from, to } = await buildFor(period, source, {
    fromStamp: flags.from as string | undefined,
    toStamp: flags.to as string | undefined,
    maxDetail: flags.full ? UNLIMITED_DETAIL : undefined,
    log: flags.json ? undefined : (l) => out(l),
  });
  await persist(dir, bundle);
  const m = bundle.manifest;
  if (flags.json) return out(JSON.stringify(m, null, 2));

  out('');
  out(`${period}  ${from.stamp} -> ${to.stamp}`);
  out(`  records        ${m.from.recordCount.toLocaleString()} -> ${m.to.recordCount.toLocaleString()}`);
  for (const k of ['added', 'recordedAmendment', 'silentRevision', 'reformatted', 'removed'] as const) {
    out(`  ${k.padEnd(18)} ${m.counts[k].toLocaleString()}`);
  }
  if (m.valuesOmitted) {
    out(`  ${m.valuesOmitted.toLocaleString()} rows carry hashes only (detail budget ${m.detailPolicy.maxDetail.toLocaleString()}; rerun with --full)`);
  }
  out('');
  out(`  bundle digest  ${m.bundleDigest}`);
  out(`  changes sha256 ${m.changesSha256}`);
  out(`  written to     ${dir}`);
  out('');
  out(`anchor it:  ancla anchor --versions --month ${period} --broadcast`);
  out(`check it:   ancla verify-bundle ${period}`);
}

async function cmdVerifyBundle(
  target: string,
  source: Source,
  flags: Record<string, string | boolean>,
): Promise<void> {
  let dir = target;
  if (/^\d{4}(\d{2})?$/.test(target ?? '')) {
    const found = (await listBundles(source)).filter((b) => b.period === target);
    if (!found.length) throw new Error(`no bundle stored for ${target}. run: ancla bundle ${target}`);
    dir = (found[found.length - 1] as (typeof found)[number]).dir;
  }
  if (!dir) throw new Error('usage: ancla verify-bundle <YYYYMM|directory>');

  const { manifest, changes } = await loadBundle(dir);
  const own = verifyBundle(manifest, changes);
  const archivesFound = await archivesForManifest(manifest, source);
  const against = archivesFound
    ? verifyAgainstArchives(manifest, changes, archivesFound.from, archivesFound.to, schemaFor(source.id))
    : null;

  const chain = await anchoredVersions(flags);
  const onChain = chain.diffs.find(
    (d) =>
      (d.ns ?? null) === (nsFor(source) ?? null) &&
      d.canonVersion === manifest.canonVersion &&
      d.period === manifest.period &&
      d.fromId === manifest.from.archiveSha256.slice(0, 12) &&
      d.toId === manifest.to.archiveSha256.slice(0, 12),
  );

  if (flags.json) {
    return out(JSON.stringify({ dir, manifest, own, against, onChain: onChain ?? null }, null, 2));
  }

  out(`bundle ${dir}`);
  out(`  ${manifest.period}  ${manifest.from.stamp} -> ${manifest.to.stamp}  (${manifest.canonVersion}, ${manifest.bundleVersion})`);
  out('');
  out('self-consistency');
  out(verificationText(own));
  out('');
  if (against) {
    out('rebuilt from the archives it names');
    out(verificationText(against));
  } else {
    out('rebuilt from the archives it names');
    out('  skipped: neither archive is on this machine.');
    out(`  need ${manifest.from.file} and ${manifest.to.file} under archives/${manifest.period}/`);
  }
  out('');
  out('committed on chain');
  if (!chain.reachable) out(`  unknown: ${chain.error}`);
  else if (!onChain) out('  no commitment found for this pair of copies.');
  else {
    const ok = onChain.bundleDigest === manifest.bundleDigest;
    out(`  ${ok ? 'ok  ' : 'FAIL'}  digest on chain  ${onChain.bundleDigest}`);
    if (!ok) out(`        bundle says      ${manifest.bundleDigest}`);
  }
}

/**
 * Commit every capture we hold, and every bundle we have published, under keys
 * derived from their own bytes rather than from the day the job ran.
 *
 * Already-committed keys are dropped from the plan rather than resent: the
 * contract refuses to overwrite, so resending would spend a fee to be rejected.
 * That refusal is the property being relied on, not a nuisance being worked
 * around — see contracts/ancla.ride.
 */
async function cmdAnchorVersions(
  day: string,
  flags: Record<string, string | boolean>,
  source: Source,
): Promise<void> {
  const ns = anchorNs(source);
  const chain = await anchoredVersions(flags);
  const known = new Set(
    forSource(chain.versions, source).map((v) => `${v.period}_${v.id}_${v.canonVersion}`),
  );

  const period = flags.month as string | undefined;
  const caps = (period ? await capturesFor(period, source) : await allCaptures(source)).filter(
    (c) => c.merkleRoot && c.archiveSha256,
  );
  const pending: ChainCapture[] = caps
    .filter(
      (c) => !known.has(`${c.period}_${(c.archiveSha256 as string).slice(0, 12)}_${c.canonVersion}`),
    )
    .map((c) => ({
      period: c.period,
      stamp: c.stamp,
      archiveSha256: c.archiveSha256 as string,
      merkleRoot: c.merkleRoot as string,
      recordCount: c.recordCount ?? 0,
      canonVersion: c.canonVersion ?? '',
    }));

  const anchoredDiffs = new Set(
    chain.diffs
      .filter((d) => (d.ns ?? null) === (ns ?? null))
      .map((d) => `${d.period}_${d.fromId}_${d.toId}_${d.canonVersion}`),
  );
  const bundles = (await listBundles(source)).filter((b) => !period || b.period === period);
  const pendingDiffs: DiffCommitment[] = bundles
    .filter((b) => {
      const k = `${b.manifest.period}_${b.manifest.from.archiveSha256.slice(0, 12)}_${b.manifest.to.archiveSha256.slice(0, 12)}_${b.manifest.canonVersion}`;
      return !anchoredDiffs.has(k);
    })
    .map((b) => ({
      period: b.manifest.period,
      canonVersion: b.manifest.canonVersion,
      fromSha256: b.manifest.from.archiveSha256,
      toSha256: b.manifest.to.archiveSha256,
      bundleDigest: b.manifest.bundleDigest,
      bundleVersion: b.manifest.bundleVersion,
      changesSha256: b.manifest.changesSha256,
      counts: b.manifest.counts,
    }));

  out(`capture anchor for ${day}   (${source.label})`);
  out(`  captures held        ${caps.length.toLocaleString()}`);
  out(`  already committed    ${(caps.length - pending.length).toLocaleString()}${chain.reachable ? '' : '  (chain unreachable; treating all as pending)'}`);
  out(`  to commit            ${pending.length.toLocaleString()} capture(s), ${pendingDiffs.length} bundle(s)`);

  if (!pending.length && !pendingDiffs.length) {
    out('');
    out('Nothing to do. Every capture and bundle held here is already on chain.');
    return;
  }
  if (!chain.reachable) {
    out('');
    out('Refusing to broadcast without reading the account first: every key would');
    out('collide with one already written and the fee would buy a rejection.');
    process.exitCode = 1;
    return;
  }

  // A canonicaliser bump must not re-anchor the whole history on the next cron
  // tick. The first commitment under a new set of rules is a judgement about
  // whether those rules are right, and it is irreversible once broadcast, so a
  // person makes it once and the schedule carries on afterwards.
  const canonOnChain = new Set(forSource(chain.versions, source).map((v) => v.canonVersion));
  const fresh = [...new Set(pending.map((c) => c.canonVersion))].filter(
    (v) => canonOnChain.size > 0 && !canonOnChain.has(v),
  );
  if (fresh.length && !flags['new-canon']) {
    out('');
    out(`${fresh.join(', ')} has no commitment on this account yet.`);
    out(`This would be the first, across ${pending.length.toLocaleString()} capture(s).`);
    out('');
    out('A canonicaliser bump changes every root, so this is a decision about whether');
    out('the new rules are right, not a routine anchor. Nothing already on chain is');
    out('affected either way: the older commitments stay, and stay true.');
    out('');
    out('When you have satisfied yourself, rerun with --new-canon --broadcast.');
    process.exitCode = 1;
    return;
  }

  const batches = planCaptures(day, pending, pendingDiffs, ns);
  batches.forEach((b, i) => out(`    batch ${i + 1}  ${b.entries.length} entries`));

  if (!flags.broadcast) {
    out('');
    out('dry run. nothing was sent.');
    out('to broadcast: rerun with --broadcast');
    return;
  }

  const keys = await loadKeys(MAINNET_CHAIN_ID);
  const signed = batches.map((b, i) => signAnchor(b, keys.privateKey, keys.publicKey, Date.now() + i));
  const totalFee = signed.reduce((sum, t) => sum + t.fee, 0);
  const bal = await balance(keys.address);
  out('');
  out(`  sender  ${keys.address}`);
  out(`  balance ${(bal / 1e8).toFixed(8)} DCC`);
  out(`  fee     ${(totalFee / 1e8).toFixed(8)} DCC total`);
  if (bal < totalFee) {
    out(`insufficient balance. need ${(totalFee / 1e8).toFixed(8)} DCC.`);
    process.exitCode = 1;
    return;
  }
  out('');
  for (let i = 0; i < signed.length; i++) {
    const res = await broadcast(signed[i] as (typeof signed)[number]);
    out(`  batch ${i + 1}/${signed.length}  ${res.id}`);
  }
  out('');
  out(`${pending.length} capture(s) and ${pendingDiffs.length} bundle(s) committed, keyed by their own bytes.`);
}

const { flags, positional } = parseArgs(process.argv.slice(3));
const cmd = process.argv[2];

try {
  const source = resolveSource(flags.source as string | undefined);
  switch (cmd) {
    case 'snapshot':
      await cmdSnapshot(positional, source);
      break;
    case 'diff':
      await cmdDiff(positional[0] as string, source);
      break;
    case 'keygen':
      await cmdKeygen(flags);
      break;
    case 'anchor':
      if (flags.versions) {
        await cmdAnchorVersions(
          (flags.day as string) ?? new Date().toISOString().slice(0, 10),
          flags,
          source,
        );
      } else {
        await cmdAnchor(flags, source);
      }
      break;
    case 'versions':
      await cmdVersions(positional[0] as string | undefined, source, flags);
      break;
    case 'recover':
      await cmdRecover(source, flags);
      break;
    case 'bundle':
      await cmdBundle(positional[0] as string, source, flags);
      break;
    case 'verify-bundle':
      await cmdVerifyBundle(positional[0] as string, source, flags);
      break;
    case 'history':
      await cmdHistory(
        positional[0] as string,
        positional[1] as string,
        positional[2] as string,
        source,
        flags,
      );
      break;
    case 'prove':
      await cmdProve(
        positional[0] as string,
        positional[1] as string,
        positional[2] as string,
        source,
        flags.day as string | undefined,
      );
      break;
    case 'watch':
      await cmdWatch(flags, source);
      break;
    case 'node':
      await cmdNode();
      break;
    default:
      out(
        [
          'ancla',
          '',
          '  survey                        what the source holds and has rewritten',
          '  history <YYYYMM> <Table> <id> every version of one record, with proofs',
          '  mirror [--from M] [--to M]    fetch archives; resumable, never overwrites',
          '  status                        what we hold and what has changed',
          '  snapshot [month...]           canonicalize into Merkle-rooted snapshots',
          '  diff <YYYYMM>                 compare a month’s two most recent versions',
          '  keygen                        create the anchor account (seed stays on disk)\n  anchor [--day D] [--month M]  commit roots to DecentralChain\n         [--all]                every snapshotted month, batched',
          '         [--broadcast]          without --broadcast this is a dry run',
          '         [--versions]           commit every capture and bundle, keyed by bytes\n         [--new-canon]          allow the first commitment under new canon rules',
          '  versions [YYYYMM]             every copy held, and whether it is anchored',
          '  bundle <YYYYMM>               row-level evidence bundle for a republication\n         [--from S] [--to S]    compare two named copies\n         [--full]               write values for every change, not just revisions',
          '  verify-bundle <YYYYMM|dir>    rebuild a bundle from the archives and check it',
          '  recover [--candidate F]       what can still be recovered, and what cannot\n          [--period YYYYMM]     test one outside copy against the anchored roots',
          '  watch [--from M] [--to M]     the daily job: refetch, diff, bundle, report\n         [--bundle-all]         list added rows too, not only revisions\n  prove <YYYYMM> <Table> <id>   Merkle proof for one record\n         [--day YYYY-MM-DD]     stamp the anchored day into the proof',
          '  node                          chain reachability check',
          '',
          `data root ${dataRoot()}   (override with ANCLA_DATA)`,
          'survey, mirror and status live in packages/ingest/src/cli.ts',
        ].join('\n'),
      );
      process.exitCode = cmd ? 1 : 0;
  }
} catch (err) {
  process.stderr.write(`${(err as Error).message}\n`);
  process.exitCode = 1;
}
