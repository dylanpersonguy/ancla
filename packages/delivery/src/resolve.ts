/**
 * Who a changed record belongs to.
 *
 * The differ speaks in (table, id). A supplier watching their own bids, or a
 * journalist filtering by ministry, needs that turned into actors: which
 * procedure, which institution, which suppliers, which product codes. That
 * translation is the join between the canonical layer and the index.
 *
 * Two levels, because the index may not be built yet:
 *
 *   StaticResolver  reads only the record id. Most Observatorio tables key on
 *                   NRO_SICOP first, so the procedure number is free. No database.
 *   IndexResolver   adds the institution, the bidders and the product codes by
 *                   querying the index, and falls back to static when a lookup
 *                   returns nothing.
 *
 * Content-addressed ids (sha256:...) carry no key, so they resolve to nothing.
 * That is correct rather than a gap: for those tables the row itself is the
 * identity and there is no key to read.
 */

import { rows } from './data.ts';

export type Subject = {
  /** Procedure number, the spine everything else hangs off. */
  nroSicop: string | null;
  /** Institution cédula. */
  institution: string | null;
  /** Supplier cédulas touched by this record. */
  suppliers: string[];
  /** Product codes touched by this record. */
  products: string[];
};

export const EMPTY_SUBJECT: Subject = {
  nroSicop: null,
  institution: null,
  suppliers: [],
  products: [],
};

/**
 * Tables whose composite key starts with NRO_SICOP. Kept as an explicit list
 * rather than derived, because getting this wrong attributes a change to the
 * wrong procedure and that is worse than attributing it to none.
 */
const SICOP_FIRST = new Set([
  'AdjudicacionesFirme',
  'DetalleCarteles',
  'DetalleLineaCartel',
  'FechaPorEtapas',
  'Garantias',
  'InvitacionProcedimiento',
  'LineasAdjudicadas',
  'LineasContratadas',
  'LineasOfertadas',
  'LineasRecibidas',
  'Ofertas',
  'OrdenPedido',
  'ProcedimientoADM',
  'ProcedimientoAdjudicacion',
  'ReajustePrecios',
  'Recepciones',
  'Remates',
  'SistemaEvaluacionOfertas',
  'Sistemas',
]);

export function isContentAddressed(id: string): boolean {
  return id.startsWith('sha256:');
}

export interface SubjectResolver {
  resolve(table: string, id: string): Subject;
}

/** Key parsing only. Always available, never wrong about what it does not know. */
export class StaticResolver implements SubjectResolver {
  resolve(table: string, id: string): Subject {
    if (isContentAddressed(id)) return { ...EMPTY_SUBJECT };
    const parts = id.split('|');
    if (SICOP_FIRST.has(table)) {
      return { ...EMPTY_SUBJECT, nroSicop: parts[0] || null };
    }
    if (table === 'Proveedores') {
      return { ...EMPTY_SUBJECT, suppliers: parts[0] ? [parts[0]] : [] };
    }
    if (table === 'InstitucionesRegistradas') {
      return { ...EMPTY_SUBJECT, institution: parts[0] || null };
    }
    if (table === 'SancionProveedores') {
      return {
        ...EMPTY_SUBJECT,
        suppliers: parts[0] ? [parts[0]] : [],
        institution: parts[1] || null,
        products: parts[3] ? [parts[3]] : [],
      };
    }
    if (table === 'FuncionariosInhibicion') {
      return { ...EMPTY_SUBJECT, institution: parts[0] || null };
    }
    return { ...EMPTY_SUBJECT };
  }
}

const uniq = (xs: (string | null | undefined)[]): string[] =>
  [...new Set(xs.filter((x): x is string => typeof x === 'string' && x !== ''))];

/** Adds the joins the index can answer. Degrades to StaticResolver when it cannot. */
export class IndexResolver implements SubjectResolver {
  private readonly base = new StaticResolver();
  /** Per-instance memo. One report can carry thousands of changes on one procedure. */
  private readonly memo = new Map<string, Subject>();

  resolve(table: string, id: string): Subject {
    const cacheKey = `${table}\x00${id}`;
    const hit = this.memo.get(cacheKey);
    if (hit) return hit;
    const out = this.compute(table, id);
    this.memo.set(cacheKey, out);
    return out;
  }

  private compute(table: string, id: string): Subject {
    const s = { ...this.base.resolve(table, id) };
    const parts = id.split('|');

    // Contracts key on NRO_CONTRATO|SECUENCIA, so the procedure has to be looked up.
    if (table === 'Contratos' && parts.length >= 1 && !isContentAddressed(id)) {
      const r = rows<{ nro_sicop: string; cedula_institucion: string; cedula_proveedor: string }>(
        'SELECT nro_sicop, cedula_institucion, cedula_proveedor FROM contract WHERE nro_contrato = ? LIMIT 1',
        [parts[0]],
      )[0];
      if (r) {
        s.nroSicop = r.nro_sicop || s.nroSicop;
        s.institution = r.cedula_institucion || s.institution;
        s.suppliers = uniq([...s.suppliers, r.cedula_proveedor]);
      }
    }

    // Appeals key on NRO_RECURSO|LINEA_OBJETADA.
    if (table === 'RecursosObjecion' && !isContentAddressed(id)) {
      const r = rows<{ nro_sicop: string; cedula_proveedor: string }>(
        'SELECT nro_sicop, cedula_proveedor FROM appeal WHERE nro_recurso = ? LIMIT 1',
        [parts[0]],
      )[0];
      if (r) {
        s.nroSicop = r.nro_sicop || s.nroSicop;
        s.suppliers = uniq([...s.suppliers, r.cedula_proveedor]);
      }
    }

    if (!s.nroSicop) return s;

    if (!s.institution) {
      const r = rows<{ cedula_institucion: string }>(
        'SELECT cedula_institucion FROM tender WHERE nro_sicop = ? LIMIT 1',
        [s.nroSicop],
      )[0];
      if (r?.cedula_institucion) s.institution = r.cedula_institucion;
    }

    // Bidders and awardees on the procedure. A supplier subscription has to fire on
    // a change to the cartel they bid on, not only on their own bid row.
    const bidders = rows<{ cedula_proveedor: string }>(
      'SELECT DISTINCT cedula_proveedor FROM bid WHERE nro_sicop = ?',
      [s.nroSicop],
    ).map((r) => r.cedula_proveedor);
    const awardees = rows<{ cedula_proveedor: string }>(
      'SELECT DISTINCT cedula_proveedor FROM award_line WHERE nro_sicop = ?',
      [s.nroSicop],
    ).map((r) => r.cedula_proveedor);
    s.suppliers = uniq([...s.suppliers, ...bidders, ...awardees]);

    const offered = rows<{ codigo_producto: string }>(
      'SELECT DISTINCT codigo_producto FROM bid_line WHERE nro_sicop = ?',
      [s.nroSicop],
    ).map((r) => r.codigo_producto);
    const awarded = rows<{ codigo_producto: string }>(
      'SELECT DISTINCT codigo_producto FROM award_line WHERE nro_sicop = ?',
      [s.nroSicop],
    ).map((r) => r.codigo_producto);
    s.products = uniq([...s.products, ...offered, ...awarded]);

    return s;
  }
}

/** Key dates of a procedure, used for deadlines and for the tender view. */
export type KeyDates = {
  nroSicop: string;
  fechaPublicacion: string | null;
  fechaApertura: string | null;
  adjudicacionFirme: string | null;
  fechaNotificacion: string | null;
};

export function keyDates(nroSicop: string): KeyDates | null {
  const t = rows<{ fecha_publicacion: string | null; fechah_apertura: string | null }>(
    'SELECT fecha_publicacion, fechah_apertura FROM tender WHERE nro_sicop = ? LIMIT 1',
    [nroSicop],
  )[0];
  const st = rows<{
    publicacion: string | null;
    fecha_apertura: string | null;
    adjudicacion_firme: string | null;
    fecha_notificacion: string | null;
  }>(
    'SELECT publicacion, fecha_apertura, adjudicacion_firme, fecha_notificacion FROM stage_dates WHERE nro_sicop = ? LIMIT 1',
    [nroSicop],
  )[0];
  if (!t && !st) return null;
  return {
    nroSicop,
    fechaPublicacion: t?.fecha_publicacion ?? st?.publicacion ?? null,
    fechaApertura: t?.fechah_apertura ?? st?.fecha_apertura ?? null,
    adjudicacionFirme: st?.adjudicacion_firme ?? null,
    fechaNotificacion: st?.fecha_notificacion ?? null,
  };
}
