/**
 * Synthetic in-memory databases with answers worked out by hand.
 *
 * Every test in this package asserts an exact value against a database it built
 * itself, so a failing assertion means the code is wrong rather than that the
 * data moved. The real index is not touched: it is being written by a separate
 * process and may be empty, partial, or mid-write at any moment.
 */

import { type Db, openDb } from '../../core/src/db.ts';

export function emptyDb(): Db {
  return openDb(':memory:');
}

export interface TenderSpec {
  nroSicop: string;
  institucion?: string;
  fecha?: string;
  estado?: string;
  codExcepcion?: string | null;
  desExcepcion?: string | null;
  montoEst?: number | null;
  month?: string;
}

export function insertTender(db: Db, t: TenderSpec): void {
  db.prepare(
    `INSERT INTO tender (nro_sicop, nro_procedimiento, cedula_institucion, fecha_publicacion,
                         tipo_procedimiento, cartel_stat, monto_est, cod_excepcion, des_excepcion,
                         source_month, archive_stamp)
     VALUES (?, ?, ?, ?, 'LICITACIÓN MENOR', ?, ?, ?, ?, ?, '2025-12-31T13:04:22Z')`,
  ).run(
    t.nroSicop,
    `P-${t.nroSicop}`,
    t.institucion ?? 'INST1',
    t.fecha ?? '2025-12-01',
    t.estado ?? 'Adjudicado',
    t.montoEst ?? null,
    t.codExcepcion ?? null,
    t.desExcepcion ?? null,
    t.month ?? '202512',
  );
}

export interface BidSpec {
  nroSicop: string;
  nroOferta: string;
  proveedor: string;
  month?: string;
}

export function insertBid(db: Db, b: BidSpec): void {
  db.prepare(
    `INSERT INTO bid (nro_sicop, nro_oferta, cedula_proveedor, fecha_presenta, tipo_oferta,
                      source_month, archive_stamp)
     VALUES (?, ?, ?, '2025-12-02', 'Individual', ?, '2025-12-31T13:04:22Z')`,
  ).run(b.nroSicop, b.nroOferta, b.proveedor, b.month ?? '202512');
}

export interface LineSpec {
  nroSicop: string;
  nroOferta: string;
  nroLinea: string;
  codigo: string;
  cantidad: number;
  precio: number;
  moneda?: string;
  month?: string;
}

export function insertBidLine(db: Db, l: LineSpec): void {
  db.prepare(
    `INSERT INTO bid_line (nro_sicop, nro_oferta, nro_linea, codigo_producto, cantidad,
                           precio_unitario, moneda, source_month)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(l.nroSicop, l.nroOferta, l.nroLinea, l.codigo, l.cantidad, l.precio, l.moneda ?? 'CRC', l.month ?? '202512');
}

export interface AwardSpec extends LineSpec {
  proveedor: string;
  nroActo?: string;
}

export function insertAward(db: Db, a: AwardSpec): void {
  db.prepare(
    `INSERT INTO award_line (nro_sicop, nro_oferta, nro_linea, nro_acto, cedula_proveedor,
                             codigo_producto, cantidad, precio_unitario, moneda, source_month)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.nroSicop,
    a.nroOferta,
    a.nroLinea,
    a.nroActo ?? '1',
    a.proveedor,
    a.codigo,
    a.cantidad,
    a.precio,
    a.moneda ?? 'CRC',
    a.month ?? '202512',
  );
}

export interface StageSpec {
  nroSicop: string;
  linea?: string;
  publicacion?: string | null;
  adjudicacionFirme?: string | null;
  elaboracionContrato?: string | null;
  primeraSolPago?: string | null;
  resulPago?: string | null;
  month?: string;
}

export function insertStage(db: Db, s: StageSpec): void {
  db.prepare(
    `INSERT INTO stage_dates (nro_sicop, cartel_seq, partida, linea, nro_procedimiento,
                              publicacion, adjudicacion_firme, fecha_elaboracion_contrato,
                              fecha_1ra_sol_pago, fecha_resul_pago, source_month)
     VALUES (?, '00', '1', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    s.nroSicop,
    s.linea ?? '1',
    `P-${s.nroSicop}`,
    s.publicacion ?? null,
    s.adjudicacionFirme ?? null,
    s.elaboracionContrato ?? null,
    s.primeraSolPago ?? null,
    s.resulPago ?? null,
    s.month ?? '202512',
  );
}

export function insertInstitution(db: Db, cedula: string, nombre: string): void {
  db.prepare(
    "INSERT INTO institution (cedula, nombre, zona_geo, source_month) VALUES (?, ?, 'San José', '202512')",
  ).run(cedula, nombre);
}

export function insertSupplier(db: Db, cedula: string, nombre: string): void {
  db.prepare(
    "INSERT INTO supplier (cedula_proveedor, nombre, tipo, tamano, source_month) VALUES (?, ?, 'Jurídica', 'PYME', '202512')",
  ).run(cedula, nombre);
}

export function insertSanction(db: Db, cedula: string, tipo: string, inicio: string, fin: string): void {
  db.prepare(
    `INSERT INTO sanction (cedula_proveedor, cedula_institucion, no_resolucion, tipo_sancion,
                           inicio_sancion, final_sancion, estado, source_month)
     VALUES (?, 'INST1', 'R-1', ?, ?, ?, 'Vigente', '202512')`,
  ).run(cedula, tipo, inicio, fin);
}

export function insertAppeal(db: Db, nro: string, cedula: string, nroSicop: string, resultado: string): void {
  db.prepare(
    `INSERT INTO appeal (nro_recurso, linea_objetada, cedula_proveedor, nro_sicop, tipo_recurso,
                         resultado, fecha_presentacion, recurso_stat, source_month)
     VALUES (?, '1', ?, ?, 'Revocatoria', ?, '2025-12-11', 'Resuelto', '202512')`,
  ).run(nro, cedula, nroSicop, resultado);
}

/**
 * A tender with a fixed bidder list, one winner, and optional per-supplier
 * prices on line 1. The building block for the competition and collusion tests.
 */
export function tenderWithBidders(
  db: Db,
  opts: {
    nroSicop: string;
    institucion?: string;
    fecha?: string;
    estado?: string;
    bidders: string[];
    winner?: string | null;
    prices?: Record<string, number>;
    codigo?: string;
    cantidad?: number;
    moneda?: string;
  },
): void {
  insertTender(db, {
    nroSicop: opts.nroSicop,
    institucion: opts.institucion,
    fecha: opts.fecha,
    estado: opts.estado,
  });
  const codigo = opts.codigo ?? 'PROD-A';
  const cantidad = opts.cantidad ?? 1;
  opts.bidders.forEach((supplier, i) => {
    const nroOferta = `${opts.nroSicop}-O${i}`;
    insertBid(db, { nroSicop: opts.nroSicop, nroOferta, proveedor: supplier });
    const price = opts.prices?.[supplier];
    if (price !== undefined) {
      insertBidLine(db, {
        nroSicop: opts.nroSicop,
        nroOferta,
        nroLinea: '1',
        codigo,
        cantidad,
        precio: price,
        moneda: opts.moneda,
      });
    }
    if (opts.winner === supplier) {
      insertAward(db, {
        nroSicop: opts.nroSicop,
        nroOferta,
        nroLinea: '1',
        codigo,
        cantidad,
        precio: price ?? 100,
        proveedor: supplier,
        moneda: opts.moneda,
      });
    }
  });
}

/**
 * Deterministic pseudo-random generator. Random data tests must reproduce
 * exactly or a flaky failure gets dismissed as flakiness instead of read.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // xorshift32
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}
