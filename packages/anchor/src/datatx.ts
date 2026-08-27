/**
 * DataTransaction (type 12) version 1, legacy binary serialization.
 *
 * Written against node-scala's own DataTxSerializer rather than a library,
 * because @decentralchain/transactions cannot be imported under Node's ESM
 * resolver: @decentralchain/protobuf-serialization@2.0.0 imports
 * 'protobufjs/minimal' with no file extension. That bug is worth fixing upstream,
 * but anchoring should not depend on it either way.
 *
 * V1 uses this format. V2 and above switch to protobuf, which buys us nothing
 * here and adds a dependency we would have to keep working for years.
 *
 *   type(1)=12 | version(1)=1 | senderPublicKey(32) | entryCount(int16 BE)
 *   entry* = keyLen(int16 BE) | key(utf8) | valueType(1) | value
 *            valueType: 0 integer(int64 BE), 1 boolean(1), 2 binary(len+bytes),
 *                       3 string(int16 len + utf8)
 *   timestamp(int64 BE) | fee(int64 BE)
 */

import { base58Decode, signBytes } from '@decentralchain/ts-lib-crypto';

export const TX_TYPE_DATA = 12;
export const FEE_UNIT = 100_000;
/** Node limits: 100 entries, 150 KB. See node-scala Terms.scala and DataTransaction. */
export const MAX_ENTRIES = 100;
export const MAX_BYTES = 150 * 1024;

export type DataEntry =
  | { key: string; type: 'string'; value: string }
  | { key: string; type: 'integer'; value: bigint | number }
  | { key: string; type: 'boolean'; value: boolean }
  | { key: string; type: 'binary'; value: Buffer };

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}

function int64(n: bigint | number): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(n));
  return b;
}

function serializeEntry(e: DataEntry): Buffer {
  const key = Buffer.from(e.key, 'utf8');
  const head = Buffer.concat([int16(key.length), key]);
  switch (e.type) {
    case 'integer':
      return Buffer.concat([head, Buffer.from([0]), int64(e.value)]);
    case 'boolean':
      return Buffer.concat([head, Buffer.from([1]), Buffer.from([e.value ? 1 : 0])]);
    case 'binary':
      return Buffer.concat([head, Buffer.from([2]), int16(e.value.length), e.value]);
    case 'string': {
      const v = Buffer.from(e.value, 'utf8');
      return Buffer.concat([head, Buffer.from([3]), int16(v.length), v]);
    }
  }
}

export function bodyBytes(
  senderPublicKey: string,
  entries: DataEntry[],
  timestamp: number,
  fee: number,
): Buffer {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`too many entries: ${entries.length} > ${MAX_ENTRIES}`);
  }
  const pk = Buffer.from(base58Decode(senderPublicKey));
  if (pk.length !== 32) throw new Error(`sender public key must be 32 bytes, got ${pk.length}`);
  const body = Buffer.concat([
    Buffer.from([TX_TYPE_DATA, 1]),
    pk,
    int16(entries.length),
    ...entries.map(serializeEntry),
    int64(timestamp),
    int64(fee),
  ]);
  if (body.length > MAX_BYTES) {
    throw new Error(`transaction too large: ${body.length} > ${MAX_BYTES} bytes`);
  }
  return body;
}

/** Minimum fee: one unit per started kilobyte, never less than one unit. */
export function minimumFee(bodyLength: number): number {
  return Math.max(1, Math.ceil(bodyLength / 1024)) * FEE_UNIT;
}

export type SignedDataTx = {
  type: number;
  version: number;
  senderPublicKey: string;
  data: { key: string; type: string; value: string | number | boolean }[];
  timestamp: number;
  fee: number;
  proofs: string[];
};

export function signDataTx(
  privateKey: string,
  senderPublicKey: string,
  entries: DataEntry[],
  timestamp: number,
  feeOverride?: number,
): SignedDataTx {
  const provisional = bodyBytes(senderPublicKey, entries, timestamp, FEE_UNIT);
  const fee = feeOverride ?? minimumFee(provisional.length);
  const body = bodyBytes(senderPublicKey, entries, timestamp, fee);
  const signature = signBytes({ privateKey }, new Uint8Array(body));
  return {
    type: TX_TYPE_DATA,
    version: 1,
    senderPublicKey,
    data: entries.map((e) => ({
      key: e.key,
      type: e.type,
      value:
        e.type === 'binary' ? `base64:${(e.value as Buffer).toString('base64')}`
        : e.type === 'integer' ? Number(e.value)
        : (e.value as string | boolean),
    })),
    timestamp,
    fee,
    proofs: [signature as unknown as string],
  };
}
