/**
 * What a mirrorable procurement source has to provide.
 *
 * Ancla started against one publisher and the mirror imported it directly. A
 * second country makes that seam explicit rather than adding a branch: a source
 * is anything that publishes a whole period as one file, at a URL we can derive,
 * with bytes that do not change unless the publisher rewrote them.
 *
 * That last property is the whole method and it is not free — see the note on
 * `officialDigest`. A publisher that rebuilds its archive per request produces a
 * new hash every time we look, which would report a republication every day and
 * prove nothing.
 */

/** `YYYYMM` for a monthly source, `YYYY` for a yearly one. Sorts chronologically. */
export type Period = string;

export type HeadResult = {
  period: Period;
  exists: boolean;
  status: number;
  lastModified: string | null;
  contentLength: number | null;
};

export type Source = {
  /** Stable id. Namespaces the data root, so renaming one orphans its archives. */
  id: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
  label: string;
  granularity: 'month' | 'year';
  /** Earliest period the publisher serves. Anything before this 404s. */
  firstPeriod: Period;
  /** Extension of the stored artifact, without the dot. */
  extension: string;
  /**
   * True only for the Costa Rican mirror, which predates multi-source support
   * and holds 189 archives directly under the data root. Moving 11 GB to gain
   * path symmetry would be a migration with no reader-visible upside.
   */
  legacyRoot?: boolean;
  /**
   * Absolute path to a PEM this publisher's TLS chain needs but does not send.
   *
   * Some portals serve only their leaf certificate. curl papers over that by
   * chasing the certificate's AIA pointer; Node does not, so the fetch fails
   * outright. Supplying the missing intermediate keeps verification on, which
   * disabling it would not.
   */
  extraCa?: string;
  /**
   * Set only when the publisher's certificate cannot be validated at all and we
   * have decided the mirror is still worth having.
   *
   * This is not the same defect as `extraCa`, which is a chain we can complete
   * and then verify properly. Here there is nothing to complete: the connection
   * is unauthenticated, so the archive is what *someone* served us. The mirror
   * still refuses to run without an explicit flag, every observation records
   * `tlsVerified: false`, and anything built on those bytes inherits the
   * caveat. Anchoring a forgery would be worse than having no mirror, and the
   * only defence against that is saying so in the data.
   */
  unverifiedTls?: { reason: string; observed: string };
  periodRange(from: Period, to: Period): Period[];
  currentPeriod(now: Date): Period;
  url(period: Period): string;
  head(period: Period, signal?: AbortSignal): Promise<HeadResult>;
  /**
   * Epoch ms after which a write to this period is a post-close revision.
   * Includes the publisher's normal settling window, so a late daily refresh is
   * not reported as a rewrite.
   */
  closesAt(period: Period): number;
  /**
   * The digest the publisher states for this period, when it publishes one we
   * have verified against the bytes it serves.
   *
   * Deliberately absent on both current sources. Panama exposes a `/sha/`
   * endpoint that looks like exactly this and is not: on 2026-07 it returned
   * 1eddbc66…, which matches neither the ZIP nor its JSON or XLSX siblings, nor
   * any file inside them. Wiring it up would have compared our hash against an
   * unrelated number and called every month a mismatch. Implement this only
   * after checking the value against the artifact, not after reading a doc.
   */
  officialDigest?(period: Period, signal?: AbortSignal): Promise<string | null>;
};

/** Every month from `from` through `to`, inclusive. */
export function monthRange(from: Period, to: Period): Period[] {
  const out: Period[] = [];
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

export function currentMonth(now: Date): Period {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * First instant after a month has closed and settled.
 *
 * The publisher's daily job normally touches a month for the last time on its
 * final day; the grace absorbs a run that lands a little into the next month.
 */
export function monthClosesAt(period: Period, graceDays = 2): number {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(4, 6));
  return Date.UTC(y, m, 1) + graceDays * 86_400_000;
}

/** Every year from `from` through `to`, inclusive. */
export function yearRange(from: Period, to: Period): Period[] {
  const out: Period[] = [];
  for (let y = Number(from); y <= Number(to); y++) out.push(String(y));
  return out;
}

export function currentYear(now: Date): Period {
  return String(now.getUTCFullYear());
}

/**
 * First instant after a year has closed and settled.
 *
 * The grace is a month rather than the two days a monthly archive gets. An
 * annual file legitimately keeps growing all year, and publishers routinely top
 * December up in January; calling that a rewrite would flag every year once.
 */
export function yearClosesAt(period: Period, graceDays = 31): number {
  return Date.UTC(Number(period) + 1, 0, 1) + graceDays * 86_400_000;
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

/**
 * A HEAD that falls back to a ranged GET.
 *
 * Not every publisher answers HEAD: some CDNs and API gateways return 405 or an
 * empty 200 with no length. A one-byte Range request gets the same headers for
 * nearly the same cost, so a source that dislikes HEAD still costs no download.
 */
export async function headOrRange(
  period: Period,
  url: string,
  signal?: AbortSignal,
): Promise<HeadResult> {
  const read = (res: Response): HeadResult => {
    const len = res.headers.get('content-range')?.match(/\/(\d+)$/)?.[1] ?? res.headers.get('content-length');
    return {
      period,
      exists: res.ok,
      status: res.status,
      lastModified: res.headers.get('last-modified'),
      contentLength: len ? Number(len) : null,
    };
  };

  const h = await fetch(url, { method: 'HEAD', signal });
  if (h.ok && h.headers.get('content-length')) return read(h);
  if (h.status === 404) return read(h);

  const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, signal });
  // Cancel the body so a publisher that ignores Range does not stream the file.
  await r.body?.cancel();
  return read(r);
}
