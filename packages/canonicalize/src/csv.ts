/**
 * CSV reading, split out of canonical.ts so the row-identity rules can import it
 * without importing canonicalization, and canonicalization can import identity.
 *
 * The parser is hand-written for one reason: it reads out of a Buffer and never
 * materializes a 300 MB table as a JavaScript string.
 */

/**
 * Parse CSV from a Buffer without materializing the whole file as a string.
 *
 * The quote rule is deliberately tolerant, and it has to be. The Observatorio
 * emits inch marks inside quoted fields without escaping them:
 *
 *     "GABINETE DE PARED ABATIBLE PARA RACK DE 19" (482,6 mm), COLOR NEGRO, …"
 *     "…AJUSTE DE ALTURA DEL RESPALDO DE 2.4", MECANISMO DE AJUSTE RÁPIDO…"
 *     "…ARTE "BÁRBARO" Y PRERROMÁNICO E ISLAM, AUTOR: LORENZO DE LA PLAZA…"
 *
 * That is malformed under RFC 4180, which requires `""`. A strict reader treats
 * the inch mark as the end of the field and then reads the rest of the line as
 * garbage — and because each stray quote inverts the in/out state, it stays
 * desynchronised until the next one flips it back, swallowing every row in
 * between into a single field. In 202608 that silently merged 3,820 rows of
 * Sistemas and 2,737 of DetalleLineaCartel, producing one field 730,185
 * characters long. Eight of nine sampled archives across 2015-2026 carry it.
 *
 * So a quote inside a quoted field closes it only when the next byte is the
 * delimiter, a line break, or the end of the file. Anything else is a literal
 * quote and the field continues. This is what Python's csv module and Excel do,
 * and it recovers every observed case exactly.
 */
export function* parseCsv(buf: Buffer, delim: number): Generator<string[]> {
  const QUOTE = 0x22;
  const CR = 0x0d;
  const LF = 0x0a;
  let row: string[] = [];
  let start = 0;
  let i = 0;
  let inQuotes = false;
  let sawQuote = false;

  const pushField = (end: number) => {
    let s = buf.toString('utf8', start, end);
    if (sawQuote) {
      if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
      s = s.replace(/""/g, '"');
    }
    row.push(s);
    sawQuote = false;
  };

  while (i < buf.length) {
    const c = buf[i];
    if (inQuotes) {
      if (c === QUOTE) {
        const next = buf[i + 1];
        if (next === QUOTE) {
          i++; // an escaped quote, per RFC 4180
        } else if (next === undefined || next === delim || next === CR || next === LF) {
          inQuotes = false; // the field really ends here
        }
        // Otherwise this is a literal quote inside the field, and the field
        // continues. See the note above on why that case has to be tolerated.
      }
      i++;
      continue;
    }
    if (c === QUOTE) {
      inQuotes = true;
      sawQuote = true;
      i++;
      continue;
    }
    if (c === delim) {
      pushField(i);
      i++;
      start = i;
      continue;
    }
    if (c === LF || c === CR) {
      pushField(i);
      if (c === CR && buf[i + 1] === LF) i++;
      i++;
      start = i;
      if (row.length > 1 || row[0] !== '') yield row;
      row = [];
      continue;
    }
    i++;
  }
  if (start < buf.length || row.length > 0) {
    pushField(buf.length);
    if (row.length > 1 || row[0] !== '') yield row;
  }
}

/** Sniff ';' vs ',' from the header. SancionProveedores is the only comma table. */
export function detectDelimiter(buf: Buffer): number {
  const end = Math.min(buf.length, 4096);
  let semi = 0;
  let comma = 0;
  for (let i = 0; i < end; i++) {
    const c = buf[i];
    if (c === 0x0a) break;
    if (c === 0x3b) semi++;
    else if (c === 0x2c) comma++;
  }
  return comma > semi ? 0x2c : 0x3b;
}

/** Strip the UTF-8 BOM and surrounding space from header cells. */
export function cleanHeader(cells: string[]): string[] {
  return cells.map((h) => h.trim().replace(/^﻿/, ''));
}
