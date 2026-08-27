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
 */

export const BASE_URL =
  'https://dlsaobservatorioprod.blob.core.windows.net/fs-synapse-observatorio-produccion/Zip';

/** Observatorio states coverage from 2010. Earlier months 404; we record that. */
export const FIRST_MONTH = '201001';

export type Month = string; // YYYYMM

export function archiveUrl(month: Month): string {
  return `${BASE_URL}/${month}.zip`;
}

/** Every month from `from` through `to`, inclusive. */
export function monthRange(from: Month, to: Month): Month[] {
  const out: Month[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(4, 6));
  const yEnd = Number(to.slice(0, 4));
  const mEnd = Number(to.slice(4, 6));
  while (y < yEnd || (y === yEnd && m <= mEnd)) {
    out.push(`${y}${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function currentMonth(now: Date): Month {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type HeadResult = {
  month: Month;
  exists: boolean;
  status: number;
  lastModified: string | null;
  contentLength: number | null;
};

/**
 * HEAD one archive. Cheap: no body transferred. This is how we detect that a
 * closed month has been rewritten — its Last-Modified moves after month end.
 */
export async function head(month: Month, signal?: AbortSignal): Promise<HeadResult> {
  const res = await fetch(archiveUrl(month), { method: 'HEAD', signal });
  const len = res.headers.get('content-length');
  return {
    month,
    exists: res.ok,
    status: res.status,
    lastModified: res.headers.get('last-modified'),
    contentLength: len ? Number(len) : null,
  };
}

/**
 * HTTP date -> compact UTC stamp used in archive filenames: 20260826T130636Z.
 * Sortable, filesystem-safe, and lossless for second resolution.
 */
export function compactStamp(httpDate: string | null): string {
  if (!httpDate) return 'unknown';
  const d = new Date(httpDate);
  if (Number.isNaN(d.getTime())) return 'unknown';
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
