/**
 * Reading the anchors back off DecentralChain.
 *
 * The anchor account holds one pair of data entries per anchored day and month:
 * root_YYYY-MM-DD_YYYYMM and meta_YYYY-MM-DD_YYYYMM, plus a "latest" pointer. The
 * node exposes the whole account in one request, so listing anchors is one call
 * rather than a probe per day.
 *
 * Everything here is cached and every failure is soft. A public node having a bad
 * minute must not take the site down, and the honest response to "we could not
 * reach the chain" is to say so, not to serve a blank page.
 */

import { DEFAULT_ANCHOR_ADDRESS, DEFAULT_NODE, nodeUrl } from '../../anchor/src/client.ts';
import {
  type AnchoredDiff,
  type AnchoredVersion,
  groupVersionEntries,
} from '../../anchor/src/versions.ts';

/** The account that has been anchoring since the first transaction. */
export { DEFAULT_ANCHOR_ADDRESS };

export function anchorAddress(): string {
  return process.env.ANCLA_ANCHOR_ADDRESS ?? DEFAULT_ANCHOR_ADDRESS;
}

export function anchorNode(): string {
  return nodeUrl();
}

export type AnchorEntry = {
  day: string;
  month: string;
  root: string;
  canonVersion: string | null;
  recordCount: number | null;
  archiveSha256: string | null;
};

export type AnchorDay = {
  day: string;
  months: AnchorEntry[];
};

export type ChainSnapshot = {
  address: string;
  node: string;
  reachable: boolean;
  /** Null when the node did not answer. */
  height: number | null;
  /** The day the anchor job last wrote, as the account itself records it. */
  latest: string | null;
  days: AnchorDay[];
  /**
   * Commitments addressed by the bytes they describe rather than by the day the
   * job ran: one per capture, one per published diff. See anchor/versions.ts.
   */
  versions: AnchoredVersion[];
  diffs: AnchoredDiff[];
  error?: string;
  fetchedAt: string;
};

type Entry = { key: string; type: string; value: string | number | boolean };

const TTL_MS = 60_000;
let cache: { at: number; value: ChainSnapshot } | null = null;

async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** meta is "canonVersion|recordCount|archiveSha256". Anything else parses to nulls. */
export function parseMeta(meta: string | undefined): Pick<
  AnchorEntry,
  'canonVersion' | 'recordCount' | 'archiveSha256'
> {
  const parts = (meta ?? '').split('|');
  const n = Number(parts[1]);
  return {
    canonVersion: parts[0] || null,
    recordCount: Number.isFinite(n) && parts.length > 1 ? n : null,
    archiveSha256: parts[2] || null,
  };
}

/** Group the account's data entries into anchored days, newest first. */
export function groupEntries(entries: Entry[]): { latest: string | null; days: AnchorDay[] } {
  const metas = new Map<string, string>();
  let latest: string | null = null;
  for (const e of entries) {
    if (e.key === 'latest') latest = String(e.value);
    else if (e.key.startsWith('meta_')) metas.set(e.key.slice(5), String(e.value));
  }
  const byDay = new Map<string, AnchorEntry[]>();
  for (const e of entries) {
    if (!e.key.startsWith('root_')) continue;
    const suffix = e.key.slice(5);
    const sep = suffix.lastIndexOf('_');
    if (sep < 0) continue;
    const day = suffix.slice(0, sep);
    const month = suffix.slice(sep + 1);
    const entry: AnchorEntry = {
      day,
      month,
      root: String(e.value),
      ...parseMeta(metas.get(suffix)),
    };
    const list = byDay.get(day);
    if (list) list.push(entry);
    else byDay.set(day, [entry]);
  }
  const days = [...byDay.entries()]
    .map(([day, months]) => ({ day, months: months.sort((a, b) => (a.month < b.month ? -1 : 1)) }))
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  return { latest, days };
}

export async function chainSnapshot(force = false): Promise<ChainSnapshot> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const address = anchorAddress();
  const node = anchorNode();
  const base: ChainSnapshot = {
    address,
    node,
    reachable: false,
    height: null,
    latest: null,
    days: [],
    versions: [],
    diffs: [],
    fetchedAt: new Date().toISOString(),
  };
  try {
    const [entries, h] = await Promise.all([
      getJson<Entry[]>(`${node}/addresses/data/${address}`, 8000),
      getJson<{ height: number }>(`${node}/blocks/height`, 8000).catch(() => ({ height: 0 })),
    ]);
    const { latest, days } = groupEntries(entries);
    const { versions, diffs } = groupVersionEntries(entries);
    const value: ChainSnapshot = {
      ...base,
      reachable: true,
      height: h.height || null,
      latest,
      days,
      versions,
      diffs,
    };
    cache = { at: Date.now(), value };
    return value;
  } catch (err) {
    const value = { ...base, error: (err as Error).message };
    // Cached too, so a node outage does not turn into a request storm.
    cache = { at: Date.now(), value };
    return value;
  }
}

export function dropChainCache(): void {
  cache = null;
}

export const NODE_FOR_BROWSER = DEFAULT_NODE;
