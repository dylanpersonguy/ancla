/**
 * DecentralChain node client. Read-only by default.
 *
 * The live mainnet node is mainnet-node.decentralchain.io. Note that
 * api.decentralchain.io, which still appears in older docs and code, no longer
 * resolves.
 */

import type { SignedDataTx } from './datatx.ts';

export const DEFAULT_NODE = 'https://mainnet-node.decentralchain.io';

/**
 * The account the roots are written to. Public by design: the whole point is that
 * anyone can read it without asking us. Override with ANCLA_ANCHOR_ADDRESS when
 * running against a test account.
 */
export const DEFAULT_ANCHOR_ADDRESS = '3DTwG5ZydbJDuLdEmwfgDEH3NuwDrgwQFtF';

export function anchorAddress(): string {
  return process.env.ANCLA_ANCHOR_ADDRESS ?? DEFAULT_ANCHOR_ADDRESS;
}

export function nodeUrl(): string {
  return process.env.ANCLA_NODE ?? DEFAULT_NODE;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function height(node = nodeUrl()): Promise<number> {
  return (await getJson<{ height: number }>(`${node}/blocks/height`)).height;
}

export async function version(node = nodeUrl()): Promise<string> {
  return (await getJson<{ version: string }>(`${node}/node/version`)).version;
}

export type DataRecord = { key: string; type: string; value: string | number | boolean };

/** One data entry from an account, or null when the key has never been written. */
export async function readEntry(
  address: string,
  key: string,
  node = nodeUrl(),
): Promise<DataRecord | null> {
  const res = await fetch(`${node}/addresses/data/${address}/${encodeURIComponent(key)}`, {
    headers: { accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`reading ${key} -> HTTP ${res.status}`);
  return (await res.json()) as DataRecord;
}

export async function readRoot(
  address: string,
  day: string,
  node = nodeUrl(),
): Promise<{ root: string; meta: string | null } | null> {
  const root = await readEntry(address, `root_${day}`, node);
  if (!root) return null;
  const meta = await readEntry(address, `meta_${day}`, node);
  return { root: String(root.value), meta: meta ? String(meta.value) : null };
}

/** Every data entry on an account. The node returns the whole set in one call. */
export async function readAllEntries(address: string, node = nodeUrl()): Promise<DataRecord[]> {
  return getJson<DataRecord[]>(`${node}/addresses/data/${address}`);
}

export async function balance(addr: string, node = nodeUrl()): Promise<number> {
  const r = await getJson<{ balance: number }>(`${node}/addresses/balance/${addr}`);
  return r.balance;
}

export async function broadcast(tx: SignedDataTx, node = nodeUrl()): Promise<{ id: string }> {
  const res = await fetch(`${node}/transactions/broadcast`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tx),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`broadcast rejected (HTTP ${res.status}): ${text.slice(0, 400)}`);
  return JSON.parse(text) as { id: string };
}
