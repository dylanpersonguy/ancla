/**
 * Observatorio de Compra Pública — bulk archive source.
 *
 * The Observatorio republishes SICOP (Hacienda) and SIAC (Contraloría) as monthly
 * ZIP archives of semicolon-delimited CSVs, on public Azure blob storage. No auth,
 * no session, no scraping. Refreshed daily around 13:00 UTC.
 *
 * Do not scrape sicop.go.cr directly. Its open-data module is a stateful WebLogic
 * JSP that returns 403 to a plain fetch and 500 with a browser user-agent.
 *
 * Verified 2026-08-26. See ANCLA_PLAN.md appendix A to re-verify.
 *
 * The period helpers now live in source.ts, shared with every other publisher,
 * and are re-exported here so existing callers and tests keep their imports.
 */

import {
  type HeadResult,
  type Period,
  type Source,
  compactStamp,
  currentMonth,
  monthClosesAt,
  monthRange,
} from './source.ts';

export const BASE_URL =
  'https://dlsaobservatorioprod.blob.core.windows.net/fs-synapse-observatorio-produccion/Zip';

/** Observatorio states coverage from 2010. Earlier months 404; we record that. */
export const FIRST_MONTH = '201001';

export type Month = Period;

export function archiveUrl(month: Month): string {
  return `${BASE_URL}/${month}.zip`;
}

/**
 * HEAD one archive. Cheap: no body transferred. This is how we detect that a
 * closed month has been rewritten — its Last-Modified moves after month end.
 */
export async function head(month: Month, signal?: AbortSignal): Promise<HeadResult> {
  const res = await fetch(archiveUrl(month), { method: 'HEAD', signal });
  const len = res.headers.get('content-length');
  return {
    period: month,
    exists: res.ok,
    status: res.status,
    lastModified: res.headers.get('last-modified'),
    contentLength: len ? Number(len) : null,
  };
}

export const OBSERVATORIO: Source = {
  id: 'cr-observatorio',
  country: 'CR',
  label: 'Observatorio de Compra Pública (SICOP + SIAC)',
  granularity: 'month',
  firstPeriod: FIRST_MONTH,
  extension: 'zip',
  // 189 archives already sit directly under the data root. See source.ts.
  legacyRoot: true,
  periodRange: monthRange,
  currentPeriod: currentMonth,
  url: archiveUrl,
  head,
  closesAt: (period) => monthClosesAt(period),
};

export { compactStamp, currentMonth, monthRange };
export type { HeadResult };
