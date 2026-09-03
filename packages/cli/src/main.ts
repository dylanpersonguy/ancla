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
  balance, broadcast, generateKey, height, keyExists, keyPath, loadKeys,
  MAINNET_CHAIN_ID, planAnchor, planAnchorBatched, readRoot, signAnchor, version,
} from '../../anchor/src/index.ts';
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
    else if (a === '--yes') flags.yes = true;
    else if (a === '--force') flags.force = true;
    else if (a === '--all') flags.all = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

/**
 * Costa Rica anchors unprefixed because two of its roots are already on chain
 * under those names and the site reads `latest` to show when the record was last
 * sealed. Every later country carries its code, on the same address, so there is
 * one identity to publish and protect rather than one per country.
 */
function anchorNs(source: Source): string | undefined {
  return source.id === 'cr-observatorio' ? undefined : source.country.toLowerCase();
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
    log: (s) => out(s),
  });
  out('');
  out(reportText(r));
  out('');
  out(`report written to ${await writeReport(r)}`);
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
      await cmdAnchor(flags, source);
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
          '  watch [--from M] [--to M]     the daily job: refetch, diff, report\n  prove <YYYYMM> <Table> <id>   Merkle proof for one record\n         [--day YYYY-MM-DD]     stamp the anchored day into the proof',
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
