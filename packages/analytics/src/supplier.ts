/**
 * Win/loss forensics for one supplier.
 *
 * Built for the supplier who thinks they are losing unfairly, which is the one
 * user of this data with a direct financial reason to check it. It answers: what
 * is my win rate, is it moving, who takes the work I lose, by how much, where do
 * I win and where do I never win.
 *
 * The definitions that matter:
 *
 *   bid       a row in bid for the tender. One supplier can file several offers
 *             on one tender; that is still one appearance.
 *   won       the supplier appears in award_line for that tender. Award is per
 *             line, so a tender can have several winners and a supplier can win
 *             part of a tender. Partial wins count as wins and are flagged.
 *   decided   the tender has award rows at all. Tenders still open are counted
 *             separately and kept out of the win rate. A tender you have not
 *             lost yet is not a loss, and putting it in the denominator would
 *             understate every active supplier's win rate.
 */

import { query, queryOne } from '../../core/src/db.ts';
import { median, wilson } from './stats.ts';
import { type Db, type Window, dateExpr, missingInputs } from './sql.ts';

export interface SupplierOptions extends Window {
  /** Rows returned in each list. */
  limit?: number;
}

export interface SupplierIdentity {
  cedulaProveedor: string;
  nombre: string | null;
  tipo: string | null;
  tamano: string | null;
  zonaGeo: string | null;
  fechaConstitucion: string | null;
}

export interface WinRate {
  /** Tenders bid on that have been decided. The win-rate denominator. */
  decided: number;
  won: number;
  rate: number | null;
  ci95: { low: number; high: number } | null;
  /** Bid on but not yet decided. Excluded from the rate above, on purpose. */
  undecided: number;
}

export interface PeriodWinRate extends WinRate {
  period: string;
}

export interface BeatenBy {
  cedulaProveedor: string;
  nombre: string | null;
  /** Tenders where this supplier bid, lost, and the listed rival won. */
  times: number;
  /** Median percentage the subject was above the rival on shared priced lines. */
  medianGapPct: number | null;
  /** Shared lines the gap was computed from. Null gap means none were comparable. */
  gapLines: number;
  sanctioned: boolean;
  sanctions: { tipo: string | null; inicio: string | null; final: string | null; estado: string | null }[];
  nroSicop: string[];
}

export interface ProductPerformance {
  codigoProducto: string;
  bidTenders: number;
  wonTenders: number;
  winRate: number | null;
}

export interface InstitutionPerformance {
  cedulaInstitucion: string;
  nombre: string | null;
  decided: number;
  won: number;
  winRate: number | null;
  undecided: number;
}

export interface SupplierAppeals {
  filed: number;
  byResult: { resultado: string; appeals: number }[];
  /** "Con lugar" plus "Parcialmente con lugar" over decided appeals. */
  successRate: number | null;
  decided: number;
}

export interface SupplierProfile {
  window: SupplierOptions;
  missing: string[];
  identity: SupplierIdentity;
  overall: WinRate;
  byPeriod: PeriodWinRate[];
  beatenBy: BeatenBy[];
  products: ProductPerformance[];
  institutions: InstitutionPerformance[];
  appeals: SupplierAppeals;
  ownSanctions: { tipo: string | null; inicio: string | null; final: string | null; estado: string | null; institucion: string | null }[];
  notes: string[];
}

interface Appearance {
  nroSicop: string;
  cedulaInstitucion: string | null;
  period: string | null;
  decided: boolean;
  won: boolean;
  winners: string[];
}

function appearances(db: Db, cedula: string, opts: SupplierOptions): Appearance[] {
  const pubExpr = dateExpr(db, 'tender', 'fecha_publicacion', 't');
  const clauses = ['b.cedula_proveedor = ?'];
  const params: unknown[] = [cedula];
  if (opts.from) {
    clauses.push(`${pubExpr} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`${pubExpr} <= ?`);
    params.push(opts.to);
  }
  if (opts.month) {
    clauses.push('t.source_month = ?');
    params.push(opts.month);
  }
  if (opts.institution) {
    clauses.push('t.cedula_institucion = ?');
    params.push(opts.institution);
  }

  const rows = query<{ nroSicop: string; cedulaInstitucion: string | null; period: string | null }>(
    db,
    `SELECT DISTINCT t.nro_sicop AS nroSicop,
            t.cedula_institucion AS cedulaInstitucion,
            substr(${pubExpr}, 1, 7) AS period
       FROM bid b
       JOIN tender t ON t.nro_sicop = b.nro_sicop
      WHERE ${clauses.join(' AND ')}`,
    params,
  );
  if (rows.length === 0) return [];

  const ids = rows.map((r) => r.nroSicop);
  const winnersByTender = new Map<string, string[]>();
  // Chunked so a supplier with thousands of tenders does not blow the parameter limit.
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const placeholders = chunk.map(() => '?').join(',');
    for (const a of query<{ nroSicop: string; cedulaProveedor: string }>(
      db,
      `SELECT DISTINCT nro_sicop AS nroSicop, cedula_proveedor AS cedulaProveedor
         FROM award_line
        WHERE nro_sicop IN (${placeholders})
          AND cedula_proveedor IS NOT NULL AND trim(cedula_proveedor) <> ''`,
      chunk,
    )) {
      const list = winnersByTender.get(a.nroSicop) ?? [];
      list.push(a.cedulaProveedor);
      winnersByTender.set(a.nroSicop, list);
    }
  }

  return rows.map((r) => {
    const winners = winnersByTender.get(r.nroSicop) ?? [];
    return {
      nroSicop: r.nroSicop,
      cedulaInstitucion: r.cedulaInstitucion,
      period: r.period,
      decided: winners.length > 0,
      won: winners.includes(cedula),
      winners,
    };
  });
}

function toWinRate(rows: readonly Appearance[]): WinRate {
  const decided = rows.filter((r) => r.decided);
  const won = decided.filter((r) => r.won).length;
  return {
    decided: decided.length,
    won,
    rate: decided.length > 0 ? won / decided.length : null,
    ci95: wilson(won, decided.length),
    undecided: rows.length - decided.length,
  };
}

/**
 * Median percentage the subject bid above a rival, over lines both priced in the
 * same currency on the same product code. Same-currency and same-code are
 * required for the same reason as in the bid spread screen: without them the
 * ratio is an exchange rate or a comparison of different goods.
 */
function gapAgainst(db: Db, subject: string, rival: string, tenderIds: readonly string[]): { median: number | null; lines: number } {
  const ids = [...new Set(tenderIds)];
  if (ids.length === 0) return { median: null, lines: 0 };
  const gaps: number[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    const rows = query<{ mine: number; theirs: number }>(
      db,
      `SELECT ml.precio_unitario AS mine, rl.precio_unitario AS theirs
         FROM bid_line ml
         JOIN bid mo ON mo.nro_sicop = ml.nro_sicop AND mo.nro_oferta = ml.nro_oferta
         JOIN bid_line rl ON rl.nro_sicop = ml.nro_sicop
                         AND rl.nro_linea = ml.nro_linea
                         AND rl.codigo_producto = ml.codigo_producto
                         AND rl.moneda = ml.moneda
                         AND rl.nro_oferta <> ml.nro_oferta
         JOIN bid ro ON ro.nro_sicop = rl.nro_sicop AND ro.nro_oferta = rl.nro_oferta
        WHERE ml.nro_sicop IN (${placeholders})
          AND mo.cedula_proveedor = ?
          AND ro.cedula_proveedor = ?
          AND ml.precio_unitario > 0 AND rl.precio_unitario > 0`,
      [...chunk, subject, rival],
    );
    for (const r of rows) gaps.push(((r.mine - r.theirs) / r.theirs) * 100);
  }
  return { median: median(gaps), lines: gaps.length };
}

export function supplierProfile(db: Db, cedula: string, opts: SupplierOptions = {}): SupplierProfile {
  const limit = opts.limit ?? 15;
  const missing = missingInputs(db, ['bid', 'tender']);

  const identityRow = queryOne<{
    cedulaProveedor: string;
    nombre: string | null;
    tipo: string | null;
    tamano: string | null;
    zonaGeo: string | null;
    fechaConstitucion: string | null;
  }>(
    db,
    `SELECT cedula_proveedor AS cedulaProveedor, nombre, tipo, tamano AS tamano,
            zona_geo AS zonaGeo, fecha_constitucion AS fechaConstitucion
       FROM supplier WHERE cedula_proveedor = ?`,
    [cedula],
  );
  const identity: SupplierIdentity = identityRow ?? {
    cedulaProveedor: cedula,
    nombre: null,
    tipo: null,
    tamano: null,
    zonaGeo: null,
    fechaConstitucion: null,
  };

  const rows = missing.length ? [] : appearances(db, cedula, opts);
  const overall = toWinRate(rows);

  const periods = new Map<string, Appearance[]>();
  for (const r of rows) {
    const p = r.period ?? 'unknown';
    const list = periods.get(p) ?? [];
    list.push(r);
    periods.set(p, list);
  }
  const byPeriod: PeriodWinRate[] = [...periods.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, list]) => ({ period, ...toWinRate(list) }));

  // Who took the work. Only decided tenders the subject lost.
  const lostTo = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.decided || r.won) continue;
    for (const w of new Set(r.winners)) {
      const list = lostTo.get(w) ?? [];
      list.push(r.nroSicop);
      lostTo.set(w, list);
    }
  }
  const rivals = [...lostTo.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, limit);
  const sanctionsByCedula = sanctionIndex(db, rivals.map(([c]) => c));
  const namesByCedula = supplierNames(db, rivals.map(([c]) => c));

  const beatenBy: BeatenBy[] = rivals.map(([rival, tenderIds]) => {
    const gap = gapAgainst(db, cedula, rival, tenderIds);
    const sanctions = sanctionsByCedula.get(rival) ?? [];
    return {
      cedulaProveedor: rival,
      nombre: namesByCedula.get(rival) ?? null,
      times: tenderIds.length,
      medianGapPct: gap.median,
      gapLines: gap.lines,
      sanctioned: sanctions.length > 0,
      sanctions: sanctions.map((s) => ({ tipo: s.tipo, inicio: s.inicio, final: s.final, estado: s.estado })),
      nroSicop: [...new Set(tenderIds)].sort(),
    };
  });

  return {
    window: opts,
    missing,
    identity,
    overall,
    byPeriod,
    beatenBy,
    products: productPerformance(db, cedula, rows, limit),
    institutions: institutionPerformance(db, rows, limit),
    appeals: supplierAppeals(db, cedula, opts),
    ownSanctions: (sanctionIndex(db, [cedula]).get(cedula) ?? []).map((s) => ({
      tipo: s.tipo,
      inicio: s.inicio,
      final: s.final,
      estado: s.estado,
      institucion: s.institucion,
    })),
    notes: [
      'win rate counts a tender as won when the supplier holds any awarded line on it, including a partial award',
      'tenders with no award rows yet are reported as undecided and kept out of the win rate',
      'a rival sanction may postdate the tenders listed next to it; check inicio_sancion before drawing a link',
      'consortium bids are attributed to the cedula on the offer, not split across consortium members',
    ],
  };
}

interface SanctionRow {
  cedula: string;
  tipo: string | null;
  inicio: string | null;
  final: string | null;
  estado: string | null;
  institucion: string | null;
}

function sanctionIndex(db: Db, cedulas: readonly string[]): Map<string, SanctionRow[]> {
  const out = new Map<string, SanctionRow[]>();
  if (cedulas.length === 0) return out;
  const placeholders = cedulas.map(() => '?').join(',');
  let rows: SanctionRow[] = [];
  try {
    rows = query<SanctionRow>(
      db,
      `SELECT cedula_proveedor AS cedula, tipo_sancion AS tipo, inicio_sancion AS inicio,
              final_sancion AS final, estado, cedula_institucion AS institucion
         FROM sanction
        WHERE cedula_proveedor IN (${placeholders})`,
      [...cedulas],
    );
  } catch {
    rows = [];
  }
  for (const r of rows) {
    const list = out.get(r.cedula) ?? [];
    list.push(r);
    out.set(r.cedula, list);
  }
  return out;
}

function supplierNames(db: Db, cedulas: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (cedulas.length === 0) return out;
  const placeholders = cedulas.map(() => '?').join(',');
  for (const r of query<{ cedula: string; nombre: string }>(
    db,
    `SELECT cedula_proveedor AS cedula, nombre FROM supplier WHERE cedula_proveedor IN (${placeholders})`,
    [...cedulas],
  )) {
    out.set(r.cedula, r.nombre);
  }
  return out;
}

function productPerformance(
  db: Db,
  cedula: string,
  rows: readonly Appearance[],
  limit: number,
): ProductPerformance[] {
  const decided = rows.filter((r) => r.decided);
  if (decided.length === 0) return [];
  const wonIds = new Set(decided.filter((r) => r.won).map((r) => r.nroSicop));
  const ids = decided.map((r) => r.nroSicop);

  const bidCodes = new Map<string, Set<string>>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const placeholders = chunk.map(() => '?').join(',');
    for (const r of query<{ code: string; nroSicop: string }>(
      db,
      `SELECT DISTINCT l.codigo_producto AS code, l.nro_sicop AS nroSicop
         FROM bid_line l
         JOIN bid b ON b.nro_sicop = l.nro_sicop AND b.nro_oferta = l.nro_oferta
        WHERE l.nro_sicop IN (${placeholders})
          AND b.cedula_proveedor = ?
          AND l.codigo_producto IS NOT NULL AND trim(l.codigo_producto) <> ''`,
      [...chunk, cedula],
    )) {
      const set = bidCodes.get(r.code) ?? new Set();
      set.add(r.nroSicop);
      bidCodes.set(r.code, set);
    }
  }

  const out: ProductPerformance[] = [];
  for (const [code, tenders] of bidCodes) {
    const won = [...tenders].filter((t) => wonIds.has(t)).length;
    out.push({
      codigoProducto: code,
      bidTenders: tenders.size,
      wonTenders: won,
      winRate: tenders.size > 0 ? won / tenders.size : null,
    });
  }
  return out.sort((a, b) => b.bidTenders - a.bidTenders).slice(0, limit);
}

function institutionPerformance(db: Db, rows: readonly Appearance[], limit: number): InstitutionPerformance[] {
  const byInstitution = new Map<string, Appearance[]>();
  for (const r of rows) {
    if (!r.cedulaInstitucion) continue;
    const list = byInstitution.get(r.cedulaInstitucion) ?? [];
    list.push(r);
    byInstitution.set(r.cedulaInstitucion, list);
  }
  const cedulas = [...byInstitution.keys()];
  const names = new Map<string, string>();
  if (cedulas.length > 0) {
    const placeholders = cedulas.map(() => '?').join(',');
    for (const r of query<{ cedula: string; nombre: string }>(
      db,
      `SELECT cedula, nombre FROM institution WHERE cedula IN (${placeholders})`,
      cedulas,
    )) {
      names.set(r.cedula, r.nombre);
    }
  }
  return [...byInstitution.entries()]
    .map(([cedulaInstitucion, list]) => {
      const wr = toWinRate(list);
      return {
        cedulaInstitucion,
        nombre: names.get(cedulaInstitucion) ?? null,
        decided: wr.decided,
        won: wr.won,
        winRate: wr.rate,
        undecided: wr.undecided,
      };
    })
    .sort((a, b) => b.decided + b.undecided - (a.decided + a.undecided))
    .slice(0, limit);
}

/**
 * Appeals the supplier filed. Roughly 30% of decided appeals succeed across the
 * whole register, which is the number to compare an individual supplier against.
 * "Rechaza de plano" is a summary rejection on admissibility, not a ruling on
 * the merits, and it is by far the most common outcome.
 */
export function supplierAppeals(db: Db, cedula: string, opts: SupplierOptions = {}): SupplierAppeals {
  if (missingInputs(db, ['appeal']).length) {
    return { filed: 0, byResult: [], successRate: null, decided: 0 };
  }
  const dateCol = dateExpr(db, 'appeal', 'fecha_presentacion', 'a');
  const clauses = ['a.cedula_proveedor = ?'];
  const params: unknown[] = [cedula];
  if (opts.from) {
    clauses.push(`${dateCol} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`${dateCol} <= ?`);
    params.push(opts.to);
  }
  if (opts.month) {
    clauses.push('a.source_month = ?');
    params.push(opts.month);
  }

  const rows = query<{ resultado: string; appeals: number }>(
    db,
    `SELECT trim(COALESCE(a.resultado,'')) AS resultado, COUNT(DISTINCT a.nro_recurso) AS appeals
       FROM appeal a
      WHERE ${clauses.join(' AND ')}
      GROUP BY resultado
      ORDER BY appeals DESC`,
    params,
  );

  const filed = rows.reduce((s, r) => s + r.appeals, 0);
  const decidedRows = rows.filter((r) => r.resultado !== '');
  const decided = decidedRows.reduce((s, r) => s + r.appeals, 0);
  const upheld = decidedRows
    .filter((r) => r.resultado === 'Con lugar' || r.resultado === 'Parcialmente con lugar')
    .reduce((s, r) => s + r.appeals, 0);

  return {
    filed,
    byResult: rows.map((r) => ({ resultado: r.resultado || '(undecided)', appeals: r.appeals })),
    successRate: decided > 0 ? upheld / decided : null,
    decided,
  };
}
