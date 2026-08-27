/**
 * Terminal table rendering. No colour, no box drawing: the output gets pasted
 * into issues and emails, where escape codes turn into noise.
 *
 * Every formatter here returns a dash for a missing value rather than 0. A rate
 * that could not be computed and a rate of zero are different facts and the
 * output must not merge them.
 */

export type Align = 'left' | 'right';

export interface Column<T> {
  header: string;
  get: (row: T) => string;
  align?: Align;
}

/** Visible width, counting a combining mark as zero. Good enough for Latin text. */
function width(s: string): number {
  return [...s.normalize('NFC')].length;
}

function pad(s: string, to: number, align: Align): string {
  const gap = Math.max(0, to - width(s));
  return align === 'right' ? ' '.repeat(gap) + s : s + ' '.repeat(gap);
}

export function table<T>(columns: readonly Column<T>[], rows: readonly T[]): string {
  if (rows.length === 0) return '  (none)\n';
  const cells = rows.map((r) => columns.map((c) => c.get(r) ?? ''));
  const widths = columns.map((c, i) =>
    Math.max(width(c.header), ...cells.map((row) => width(row[i]))),
  );
  const line = (values: string[]) =>
    `  ${values.map((v, i) => pad(v, widths[i], columns[i].align ?? 'left')).join('  ')}`.trimEnd();
  const out: string[] = [];
  out.push(line(columns.map((c) => c.header)));
  out.push(`  ${widths.map((w) => '-'.repeat(w)).join('  ')}`);
  for (const row of cells) out.push(line(row));
  return `${out.join('\n')}\n`;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return `${(v * 100).toFixed(digits)}%`;
}

export function num(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/** Compact money. Full precision is available in --json; this is for reading. */
export function money(v: number | null | undefined, currency = ''): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  const abs = Math.abs(v);
  const suffix = currency ? ` ${currency}` : '';
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B${suffix}`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M${suffix}`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}k${suffix}`;
  return `${v.toFixed(2)}${suffix}`;
}

export function days(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  return `${Math.round(v)}d`;
}

export function ratio(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '-';
  if (v >= 10_000) return `${v.toExponential(2)}x`;
  return `${v.toFixed(1)}x`;
}

export function truncate(s: string | null | undefined, to: number): string {
  const v = (s ?? '').trim();
  if (v.length <= to) return v || '-';
  return `${v.slice(0, to - 1)}…`;
}

export function heading(title: string): string {
  return `\n${title}\n${'='.repeat(width(title))}\n`;
}

export function subheading(title: string): string {
  return `\n${title}\n${'-'.repeat(width(title))}\n`;
}

/** Warnings and caveats, indented so they read as attached to the number above. */
export function bullets(lines: readonly string[], marker = '!'): string {
  if (lines.length === 0) return '';
  return `${lines.map((l) => `  ${marker} ${l}`).join('\n')}\n`;
}

/** Wrap prose to a width so a long disclaimer does not run off a terminal. */
export function wrap(text: string, to = 92, indent = '  '): string {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const w of words) {
    if (current && width(current) + 1 + width(w) > to - indent.length) {
      lines.push(current);
      current = w;
    } else {
      current = current ? `${current} ${w}` : w;
    }
  }
  if (current) lines.push(current);
  return `${lines.map((l) => indent + l).join('\n')}\n`;
}
