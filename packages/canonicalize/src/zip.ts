/**
 * Minimal ZIP reader built on node:zlib. No dependencies.
 *
 * Ancla must produce byte-identical output years from now. A zip library is one
 * more thing that can change its behaviour under us, so we parse the container
 * ourselves: it is a well-specified format and this is about 120 lines.
 *
 * Supports stored (method 0) and deflate (method 8), which is everything the
 * Observatorio emits.
 */

import { inflateRawSync } from 'node:zlib';

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;

export type ZipEntry = {
  /** Path as stored. May be flat ("Ofertas.csv") or nested ("202401/Ofertas.csv"). */
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  localHeaderOffset: number;
};

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 0xffff - 22);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw new Error('not a zip: no end-of-central-directory record');
}

export function listEntries(buf: Buffer): ZipEntry[] {
  const eocd = findEocd(buf);
  let count = buf.readUInt16LE(eocd + 10);
  let cenOffset = buf.readUInt32LE(eocd + 16);

  // ZIP64: the 32-bit fields saturate and the real values live in a separate record.
  if (cenOffset === 0xffffffff || count === 0xffff) {
    const locator = eocd - 20;
    if (locator >= 0 && buf.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR_SIG) {
      const z64 = Number(buf.readBigUInt64LE(locator + 8));
      if (buf.readUInt32LE(z64) === ZIP64_EOCD_SIG) {
        count = Number(buf.readBigUInt64LE(z64 + 32));
        cenOffset = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }

  const entries: ZipEntry[] = [];
  let p = cenOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) break;
    const method = buf.readUInt16LE(p + 10);
    let compressedSize = buf.readUInt32LE(p + 20);
    let uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (
      uncompressedSize === 0xffffffff ||
      compressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = buf.readUInt16LE(e);
        const size = buf.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompressedSize === 0xffffffff) {
            uncompressedSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (compressedSize === 0xffffffff) {
            compressedSize = Number(buf.readBigUInt64LE(q));
            q += 8;
          }
          if (localHeaderOffset === 0xffffffff) {
            localHeaderOffset = Number(buf.readBigUInt64LE(q));
          }
          break;
        }
        e += 4 + size;
      }
    }

    entries.push({ name, compressedSize, uncompressedSize, method, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export function readEntry(buf: Buffer, entry: ZipEntry): Buffer {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new Error(`bad local header for ${entry.name}`);
  }
  const nameLen = buf.readUInt16LE(lh + 26);
  const extraLen = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return inflateRawSync(raw);
  throw new Error(`unsupported compression method ${entry.method} for ${entry.name}`);
}

/**
 * Table name from a zip path, ignoring any directory prefix.
 *
 * The 2024-09-20 republication nested its CSVs under "YYYYMM/". Every other
 * archive stores them flat. Both must canonicalize identically, because the
 * container layout is not part of the record.
 */
export function tableNameOf(entryName: string): string | null {
  const base = entryName.split('/').pop() ?? '';
  if (!base.toLowerCase().endsWith('.csv')) return null;
  return base.slice(0, -4);
}
