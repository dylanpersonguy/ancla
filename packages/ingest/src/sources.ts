/**
 * The publishers this mirror knows how to read.
 *
 * A country appears here only once its bulk archives have been checked by hand:
 * derivable URL, a whole period per file, and bytes that stay identical between
 * two fetches. Guatemala publishes usable archives but returns 403 to
 * everything that is not a browser; El Salvador and Nicaragua publish nothing
 * that can be mirrored at all, and no adapter can change that.
 */

import { OBSERVATORIO } from './observatorio.ts';
import { ONCAE_CE, ONCAE_DDC, ONCAE_HC1 } from './oncae.ts';
import { PANAMACOMPRA, TIENDA_VIRTUAL } from './panamacompra.ts';
import type { Source } from './source.ts';

export const SOURCES: Source[] = [
  OBSERVATORIO,
  PANAMACOMPRA,
  TIENDA_VIRTUAL,
  ONCAE_HC1,
  ONCAE_CE,
  ONCAE_DDC,
];

export const DEFAULT_SOURCE = OBSERVATORIO;

/** Short aliases, so the common case is `--source pa` rather than the full id. */
const ALIASES: Record<string, string> = {
  cr: 'cr-observatorio',
  pa: 'pa-panamacompra',
  'pa-tienda': 'pa-tienda-virtual',
  hn: 'hn-oncae-hc1',
  'hn-ce': 'hn-oncae-ce',
  'hn-ddc': 'hn-oncae-ddc',
};

export function resolveSource(name?: string): Source {
  if (!name) return DEFAULT_SOURCE;
  const id = ALIASES[name] ?? name;
  const found = SOURCES.find((s) => s.id === id);
  if (!found) {
    const known = SOURCES.map((s) => s.id).join(', ');
    throw new Error(`unknown source "${name}". Known: ${known}, or aliases ${Object.keys(ALIASES).join(', ')}`);
  }
  return found;
}
