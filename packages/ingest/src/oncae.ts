/**
 * ONCAE Honduras — bulk archive source.
 *
 * The Oficina Normativa de Contratación y Adquisiciones del Estado publishes
 * HonduCompras as OCDS, one ZIP of CSVs per dataset per year, at a derivable
 * path. Yearly rather than monthly, which is the first source here that is not
 * monthly and the reason `granularity` exists.
 *
 * Three datasets, kept apart because they are three registries:
 *   HC1  the procurement record itself, 2005 onward
 *   CE   catálogo electrónico, the convenio marco orders, 2014 onward
 *   DDC  difusión directa de contratos, 2010–2019, discontinued
 *
 * Verified 2026-09-02:
 *   - HEAD is truthful. 2004 and 2099 both 404, so the walk can trust it and
 *     does not need the ranged-GET fallback.
 *   - HC1_datos_2023.zip fetched twice, byte-identical, and it unzips to OCDS
 *     CSVs. That is the property the method needs.
 *   - The catalogue at /datosabiertos/data.json is stale twice over: it stops at
 *     2024 when 2025 and 2026 both exist, and its downloadURLs point at
 *     http://200.13.162.79/ which no longer answers. Derive paths from the
 *     hostname that works; do not follow the catalogue.
 *
 * The certificate expired on 2026-07-05 and nobody has renewed it. See
 * `unverifiedTls` in source.ts for what that costs and why it is declared
 * rather than worked around.
 */

import {
  type HeadResult,
  type Period,
  type Source,
  currentYear,
  yearClosesAt,
  yearRange,
} from './source.ts';

export const BASE_URL = 'https://datosabiertos.oncae.gob.hn/datosabiertos';

export type Dataset = 'HC1' | 'CE' | 'DDC';

export function archiveUrl(period: Period, dataset: Dataset = 'HC1'): string {
  return `${BASE_URL}/${dataset}/${dataset}_datos_${period}.zip`;
}

/**
 * Two ONCAE hosts stopped renewing on the same day, so this is a broken job
 * rather than one lapsed certificate, and waiting it out is not a plan.
 */
const UNVERIFIED_TLS = {
  reason:
    'certificate expired 2026-07-05 and is still being served; honducompras.gob.hn lapsed the same day',
  observed: '2026-09-02',
} as const;

function make(dataset: Dataset, first: Period, label: string): Source {
  return {
    id: `hn-oncae-${dataset.toLowerCase()}`,
    country: 'HN',
    label,
    granularity: 'year',
    firstPeriod: first,
    extension: 'zip',
    unverifiedTls: UNVERIFIED_TLS,
    periodRange: yearRange,
    currentPeriod: currentYear,
    url: (period) => archiveUrl(period, dataset),
    head: async (period, signal): Promise<HeadResult> => {
      const res = await fetch(archiveUrl(period, dataset), { method: 'HEAD', signal });
      const len = res.headers.get('content-length');
      return {
        period,
        exists: res.ok,
        status: res.status,
        lastModified: res.headers.get('last-modified'),
        contentLength: len ? Number(len) : null,
      };
    },
    closesAt: (period) => yearClosesAt(period),
  };
}

export const ONCAE_HC1: Source = make('HC1', '2005', 'ONCAE HonduCompras — procurement record');
export const ONCAE_CE: Source = make('CE', '2014', 'ONCAE — catálogo electrónico');
export const ONCAE_DDC: Source = make('DDC', '2010', 'ONCAE — difusión directa (2010–2019)');
