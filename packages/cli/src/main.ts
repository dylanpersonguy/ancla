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
import { dataRoot } from '../../ingest/src/manifest.ts';
import { buildSnapshot, leafFor, writeSnapshot } from '../../canonicalize/src/snapshot.ts';
import { proof, root as merkleRoot, verify as merkleVerify } from '../../merkle/src/index.ts';
import { diff, summarize } from '../../differ/src/index.ts';
import {
  balance, broadcast, generateKey, height, keyExists, keyPath, loadKeys,
  MAINNET_CHAIN_ID, planAnchor, readRoot, signAnchor, version,
} from '../../anchor/src/index.ts';
import { archives, loadOrBuild, months, snapshotPath } from './store.ts';
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
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else positional.push(a);
  }
  return { flags, positional };
}

async function cmdSnapshot(targets: string[]): Promise<void> {
  const list = targets.length ? targets : await months();
  out(`snapshotting ${list.length} month(s) into ${dataRoot()}/snapshots`);
  let built = 0;
  let skipped = 0;
  for (const month of list) {
    for (const ref of await archives(month)) {
      const p = snapshotPath(ref);
      try {
        await readFile(p);
        skipped++;
        continue;
      } catch {
        /* not built yet */
      }
      const snap = buildSnapshot(month, await readFile(ref.path));
      await writeSnapshot(p, snap);
      built++;
      out(`  ${month}  ${ref.stamp}  ${snap.recordCount.toLocaleString()} records  ${snap.merkleRoot.slice(0, 16)}`);
    }
  }
  out(`\nbuilt ${built}, already present ${skipped}`);
}

async function cmdDiff(month: string): Promise<void> {
  if (!month) throw new Error('usage: ancla diff <YYYYMM>');
  const refs = await archives(month);
  if (refs.length < 2) {
    out(`${month}: only ${refs.length} version stored. Nothing to compare yet.`);
    out('A second version appears when the source rewrites this month.');
    return;
  }
  const from = await loadOrBuild(refs[refs.length - 2]);
  const to = await loadOrBuild(refs[refs.length - 1]);
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

async function cmdAnchor(flags: Record<string, string | boolean>): Promise<void> {
  const day = (flags.day as string) ?? new Date().toISOString().slice(0, 10);
  const list = flags.month ? [flags.month as string] : (await months()).slice(-1);
  const snaps = [];
  for (const m of list) {
    const refs = await archives(m);
    if (refs.length) snaps.push(await loadOrBuild(refs[refs.length - 1]));
  }
  if (!snaps.length) {
    out('nothing mirrored to anchor. run: ancla mirror');
    return;
  }
  const plan = planAnchor(day, snaps);
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

async function cmdProve(month: string, table: string, id: string, day?: string): Promise<void> {
  if (!month || !table || !id) throw new Error('usage: ancla prove <YYYYMM> <Table> <id>');
  const refs = await archives(month);
  if (!refs.length) throw new Error(`no archive stored for ${month}`);
  const snap = await loadOrBuild(refs[refs.length - 1]);
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

async function cmdWatch(flags: Record<string, string | boolean>): Promise<void> {
  const r = await runWatch({
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
  switch (cmd) {
    case 'snapshot':
      await cmdSnapshot(positional);
      break;
    case 'diff':
      await cmdDiff(positional[0]);
      break;
    case 'keygen':
      await cmdKeygen(flags);
      break;
    case 'anchor':
      await cmdAnchor(flags);
      break;
    case 'prove':
      await cmdProve(positional[0], positional[1], positional[2], flags.day as string | undefined);
      break;
    case 'watch':
      await cmdWatch(flags);
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
          '  mirror [--from M] [--to M]    fetch archives; resumable, never overwrites',
          '  status                        what we hold and what has changed',
          '  snapshot [month...]           canonicalize into Merkle-rooted snapshots',
          '  diff <YYYYMM>                 compare a month’s two most recent versions',
          '  keygen                        create the anchor account (seed stays on disk)\n  anchor [--day D] [--month M]  commit roots to DecentralChain',
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
