/**
 * Minimal ZIP writer, for tests only.
 *
 * packages/canonicalize/src/zip.ts reads archives; nothing in Ancla writes one.
 * Testing the loader against real archives alone would leave the awkward cases
 * untested, because the awkward cases are exactly the ones the mirror happens
 * not to contain this month. So the tests build their own containers: flat and
 * nested layouts, stored and deflated entries, and entries that are deliberately
 * unreadable.
 */

import { crc32, deflateRawSync } from 'node:zlib';

export type ZipInput = {
  name: string;
  /** Raw bytes. A string is encoded as UTF-8. */
  data: Buffer | string;
  /** 0 stored, 8 deflate. Defaults to deflate. */
  method?: number;
  /**
   * Replace the entry payload with these bytes after the header is written.
   * Used to build an entry that throws when inflated.
   */
  corrupt?: Buffer;
};

const LOCAL_SIG = 0x04034b50;
const CEN_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

export function buildZip(entries: ZipInput[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const method = e.method ?? 8;
    let payload = method === 0 ? raw : deflateRawSync(raw);
    if (e.corrupt) payload = e.corrupt;
    const name = Buffer.from(e.name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc32(raw), 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);

    parts.push(local, name, payload);
    central.push(cen, name);
    offset += local.length + name.length + payload.length;
  }

  const body = Buffer.concat(parts);
  const dir = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(dir.length, 12);
  eocd.writeUInt32LE(body.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([body, dir, eocd]);
}

/** CRLF line endings, which is what the Observatorio publishes. */
export function csv(rows: (string | number)[][], delim = ';'): string {
  return `${rows.map((r) => r.join(delim)).join('\r\n')}\r\n`;
}
