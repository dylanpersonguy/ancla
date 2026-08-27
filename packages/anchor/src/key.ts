/**
 * Anchor account key handling.
 *
 * The seed is generated on this machine, written to a 0600 file outside the repo,
 * and never printed. Only the address and public key are ever shown. A mainnet
 * seed that passes through a terminal, a chat log, or a screen share is a
 * compromised seed, and for this project the anchor account is the whole
 * credibility argument: whoever holds it can write roots.
 */

import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { address, privateKey, publicKey, randomSeed } from '@decentralchain/ts-lib-crypto';

/** DecentralChain network bytes, derived from real addresses on each chain. */
export const MAINNET_CHAIN_ID = '?';
export const TESTNET_CHAIN_ID = '!';

export function keyPath(): string {
  const root = process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data');
  return process.env.ANCLA_KEY_FILE ?? join(root, 'anchor.key');
}

export type AnchorIdentity = { address: string; publicKey: string; chainId: string };

export function identityFromSeed(seed: string, chainId = MAINNET_CHAIN_ID): AnchorIdentity {
  return { address: address(seed, chainId), publicKey: publicKey(seed), chainId };
}

export async function keyExists(): Promise<boolean> {
  try {
    await stat(keyPath());
    return true;
  } catch {
    return false;
  }
}

/** Generate and persist a new anchor seed. Returns the public identity only. */
export async function generateKey(chainId = MAINNET_CHAIN_ID): Promise<AnchorIdentity> {
  const seed = randomSeed();
  const p = keyPath();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, `${seed}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(p, 0o600);
  return identityFromSeed(seed, chainId);
}

/**
 * Read the seed for signing. ANCLA_SEED wins so an operator can keep the key in a
 * secret manager rather than on disk.
 */
export async function loadSeed(): Promise<string> {
  const fromEnv = process.env.ANCLA_SEED;
  if (fromEnv?.trim()) return fromEnv.trim();
  try {
    return (await readFile(keyPath(), 'utf8')).trim();
  } catch {
    throw new Error(
      `no anchor key. run "ancla keygen", or set ANCLA_SEED. expected at ${keyPath()}`,
    );
  }
}

export async function loadKeys(chainId = MAINNET_CHAIN_ID) {
  const seed = await loadSeed();
  return {
    seed,
    privateKey: privateKey(seed),
    publicKey: publicKey(seed),
    address: address(seed, chainId),
  };
}
