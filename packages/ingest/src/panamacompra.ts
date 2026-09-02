/**
 * PanamaCompra en Cifras — bulk archive source.
 *
 * The Dirección General de Contrataciones Públicas republishes PanamaCompra as
 * OCDS, and its v2 portal exposes one pre-built archive per month per format at
 * a derivable path. No auth, no session, no scraping.
 *
 * Two streams are published. `panamacompra_v3` is the procurement record and is
 * the one that matters; `panamacompra_v2_tienda_virtual` is the catalogue store
 * and is mirrored separately rather than merged, because they are different
 * registries that happen to share a portal.
 *
 * Verified 2026-09-02:
 *   - GET /api/v1/files lists only the last four months, but any month back to
 *     at least 2023-09 fetches on the derived path. The listing is a homepage
 *     widget, not the index of what exists, so we walk the range like Costa Rica
 *     does and record what 404s.
 *   - The CSV archive is a ZIP of per-table OCDS CSVs with fixed inner
 *     timestamps. Fetched twice, byte-identical both times, so hashing the
 *     download is meaningful. This is the property the whole method needs and
 *     it is the one thing to re-check if the mirror starts reporting daily
 *     rewrites.
 *   - Last-Modified and ETag are both served.
 *
 * Do not use the /sha/ endpoint. See `officialDigest` in source.ts.
 */

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  type HeadResult,
  type Period,
  type Source,
  compactStamp,
  currentMonth,
  headOrRange,
  monthClosesAt,
  monthRange,
} from './source.ts';

export const BASE_URL = 'https://v2.panamacompraencifras.gob.pa/api/v1';

/**
 * The portal serves its leaf certificate without the RapidSSL intermediate, so
 * Node rejects the handshake that curl accepts. See the PEM's own header.
 */
export const EXTRA_CA = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'certs',
  'rapidssl-tls-rsa-ca-g1.pem',
);

/**
 * The portal serves 2023-09 and 404s 2023-06, so the boundary is somewhere in
 * that quarter. Starting the walk in January costs six HEADs and records the
 * real edge in the manifest instead of asserting one we did not measure.
 */
export const FIRST_PERIOD: Period = '202301';

export type Stream = 'panamacompra_v3' | 'panamacompra_v2_tienda_virtual';

/** `202608` -> `2026/08`, which is how the path is segmented. */
function pathFor(period: Period): string {
  return `${period.slice(0, 4)}/${period.slice(4, 6)}`;
}

export function archiveUrl(period: Period, stream: Stream = 'panamacompra_v3'): string {
  return `${BASE_URL}/file/${stream}/csv/${pathFor(period)}`;
}

function make(stream: Stream, label: string): Source {
  return {
    id: stream === 'panamacompra_v3' ? 'pa-panamacompra' : 'pa-tienda-virtual',
    country: 'PA',
    label,
    granularity: 'month',
    firstPeriod: FIRST_PERIOD,
    extension: 'zip',
    extraCa: EXTRA_CA,
    periodRange: monthRange,
    currentPeriod: currentMonth,
    url: (period) => archiveUrl(period, stream),
    head: (period, signal): Promise<HeadResult> =>
      headOrRange(period, archiveUrl(period, stream), signal),
    closesAt: (period) => monthClosesAt(period),
  };
}

export const PANAMACOMPRA: Source = make('panamacompra_v3', 'PanamaCompra en Cifras — procurement');

export const TIENDA_VIRTUAL: Source = make(
  'panamacompra_v2_tienda_virtual',
  'PanamaCompra en Cifras — tienda virtual',
);

export { compactStamp };
