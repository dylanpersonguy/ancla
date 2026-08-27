/**
 * Open Contracting Data Standard 1.1 export.
 *
 * Costa Rica committed to publishing SICOP in OCDS under Open Government
 * Partnership commitment CR0052 and has not done it. The data is public; only the
 * standard shape is missing. This file supplies the shape.
 *
 * Every mapping decision that loses or invents information is written down next to
 * the code that makes it, because an export nobody can audit is worth as much as
 * no export at all. The honest summary of what is and is not covered:
 *
 *   covered      tender, awards, contracts and their amendments, parties, items,
 *                and planning rationale for exception procedures.
 *   partial      tender.items come from the bid and award lines, since the index
 *                does not carry the cartel line table. A procedure with no bids
 *                yet therefore has no items.
 *   absent       documents, milestones, and the pre-tender planning stage. The
 *                Observatorio does not publish them in the bulk archives.
 *
 * The ocid prefix "anclacr" is used because this is a third-party republication.
 * It is not registered with the OCDS registry, which issues six-character prefixes
 * to publishing agencies. Anyone consuming these releases should read the prefix
 * as "Ancla's view of the Costa Rican record", not as an official identifier.
 */

import { rows } from './data.ts';
import { DEFAULT_LANG, type Lang, t } from './i18n.ts';

export const OCID_PREFIX = 'ocds-anclacr-';
export const OCDS_VERSION = '1.1';

/**
 * The cedula, as SICOP prints it. This is not a code from org-id.guide; there is
 * no registered list for the Costa Rican cedula at the time of writing, so the
 * scheme is declared as local rather than dressed up as a registered one.
 */
export const ID_SCHEME = 'CR-CED';
export const SICOP_PRODUCT_SCHEME = 'CR-SICOP';

// ---------------------------------------------------------------------------
// Row shapes, matching packages/core/src/schema.sql
// ---------------------------------------------------------------------------

export type TenderRow = {
  nro_sicop: string;
  nro_procedimiento: string | null;
  cedula_institucion: string | null;
  fecha_publicacion: string | null;
  fechah_apertura: string | null;
  tipo_procedimiento: string | null;
  modalidad: string | null;
  cartel_stat: string | null;
  cartel_nm: string | null;
  monto_est: number | null;
  clas_obj: string | null;
  cod_excepcion: string | null;
  des_excepcion: string | null;
  source_month: string;
  archive_stamp: string;
};

export type BidRow = {
  nro_sicop: string;
  nro_oferta: string;
  cedula_proveedor: string | null;
  fecha_presenta: string | null;
  tipo_oferta: string | null;
};

export type BidLineRow = {
  nro_sicop: string;
  nro_oferta: string;
  nro_linea: string;
  codigo_producto: string | null;
  cantidad: number | null;
  precio_unitario: number | null;
  moneda: string | null;
};

export type AwardLineRow = BidLineRow & {
  nro_acto: string;
  cedula_proveedor: string | null;
};

export type ContractRow = {
  nro_contrato: string;
  secuencia: string;
  nro_sicop: string | null;
  cedula_proveedor: string | null;
  cedula_institucion: string | null;
  tipo_contrato: string | null;
  tipo_modificacion: string | null;
  fecha_notificacion: string | null;
  fecha_elaboracion: string | null;
  moneda: string | null;
  vigencia: string | null;
  fecha_modificacion: string | null;
};

export type PartyRow = { cedula: string; nombre: string | null };

export type ReleaseInput = {
  tender: TenderRow;
  bids: BidRow[];
  bidLines: BidLineRow[];
  awardLines: AwardLineRow[];
  contracts: ContractRow[];
  institution: PartyRow | null;
  suppliers: PartyRow[];
};

// ---------------------------------------------------------------------------
// Codelist mapping
// ---------------------------------------------------------------------------

const strip = (v: string | null | undefined): string => (v ?? '').replace(/^"|"$/g, '').trim();

/**
 * OCDS method codelist: open, selective, limited, direct.
 *
 * The Costa Rican types under Ley 9986 do not line up one to one. A licitacion of
 * any size is publicly advertised, so it is open. A procedimiento por excepcion
 * restricts who may be invited without being a named single-source award, so it is
 * limited. Procedimientos especiales cover regimes with their own invitation rules,
 * which is selective. The original Spanish always travels in
 * procurementMethodDetails so nobody has to trust this table.
 */
export function procurementMethod(tipo: string | null): string | undefined {
  const s = strip(tipo).toUpperCase();
  if (!s) return undefined;
  if (s.startsWith('LICITACI')) return 'open';
  if (s.includes('REMATE')) return 'open';
  if (s.includes('EXCEPCI')) return 'limited';
  if (s.includes('ESPECIAL')) return 'selective';
  return undefined;
}

/** OCDS procurementCategory: goods, services, works. */
export function procurementCategory(clasObj: string | null): {
  main?: string;
  additional?: string[];
} {
  const s = strip(clasObj).toUpperCase();
  if (s.includes('OBRA')) return { main: 'works' };
  if (s.includes('BIENES') && s.includes('SERVICIO')) {
    return { main: 'goods', additional: ['services'] };
  }
  if (s.includes('BIENES')) return { main: 'goods' };
  if (s.includes('SERVICIO')) return { main: 'services' };
  return {};
}

/** OCDS tenderStatus: planning, planned, active, cancelled, unsuccessful, complete, withdrawn. */
export function tenderStatus(cartelStat: string | null): string | undefined {
  const s = strip(cartelStat).toLowerCase();
  if (!s) return undefined;
  if (s.includes('infructuoso') || s.includes('desierto')) return 'unsuccessful';
  if (s.includes('anulad') || s.includes('cancelad')) return 'cancelled';
  if (s.includes('contrato') || s.includes('firme') || s.includes('adjudicad')) return 'complete';
  return 'active';
}

/** ISO 4217 as published. CRC when the source says nothing, which is the local default. */
export function currency(raw: string | null | undefined, fallback = 'CRC'): string {
  const s = strip(raw).toUpperCase();
  return /^[A-Z]{3}$/.test(s) ? s : fallback;
}

/** Dates arrive as YYYY-MM-DD from the index. OCDS wants a full date-time. */
export function ocdsDate(iso: string | null | undefined): string | undefined {
  const s = (iso ?? '').trim();
  if (!s) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T00:00:00Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * The SICOP product code is 24 digits. The leading eight are the UNSPSC commodity
 * code and the rest identify the catalogue entry, so both are published: UNSPSC as
 * the primary classification because that is what cross-country analysis uses, and
 * the full SICOP code as an additional classification so nothing is lost.
 */
export function classifications(code: string | null | undefined): {
  classification?: { scheme: string; id: string };
  additionalClassifications?: { scheme: string; id: string }[];
} {
  const s = strip(code);
  if (!s) return {};
  const out: ReturnType<typeof classifications> = {
    additionalClassifications: [{ scheme: SICOP_PRODUCT_SCHEME, id: s }],
  };
  if (/^\d{8}/.test(s)) out.classification = { scheme: 'UNSPSC', id: s.slice(0, 8) };
  return out;
}

// ---------------------------------------------------------------------------
// Release construction
// ---------------------------------------------------------------------------

export type Amount = { amount: number; currency: string };

export function ocidFor(nroSicop: string): string {
  return `${OCID_PREFIX}${nroSicop}`;
}

function partyId(cedula: string): string {
  return `${ID_SCHEME}-${cedula}`;
}

type Priced = { cantidad: number | null; precio_unitario: number | null; moneda: string | null };

function money(lines: Priced[]): Amount | undefined {
  if (!lines.length) return undefined;
  const currencies = new Set(lines.map((l) => currency(l.moneda)));
  // Mixed-currency totals would be a fabricated number, so no value is emitted.
  if (currencies.size !== 1) return undefined;
  let total = 0;
  for (const l of lines) total += (l.cantidad ?? 0) * (l.precio_unitario ?? 0);
  if (!Number.isFinite(total)) return undefined;
  return { amount: Number(total.toFixed(5)), currency: [...currencies][0] };
}

type Lined = Priced & { nro_linea: string; codigo_producto: string | null };

function itemsFrom(lines: Lined[], idPrefix: string): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const l of lines) {
    const id = `${idPrefix}-${l.nro_linea}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const item: Record<string, unknown> = { id, ...classifications(l.codigo_producto) };
    if (l.cantidad !== null && l.cantidad !== undefined) item.quantity = l.cantidad;
    if (l.precio_unitario !== null && l.precio_unitario !== undefined) {
      item.unit = { value: { amount: l.precio_unitario, currency: currency(l.moneda) } };
    }
    out.push(item);
  }
  return out;
}

/** Drop empty members so a release carries only fields the source actually filled. */
function clean<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === undefined || v === null) delete obj[k];
    else if (Array.isArray(v) && v.length === 0) delete obj[k];
    else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) delete obj[k];
  }
  return obj;
}

export function buildRelease(
  input: ReleaseInput,
  lang: Lang = DEFAULT_LANG,
): Record<string, unknown> {
  const tn = input.tender;

  // Parties. Roles accumulate, since one cedula can be both tenderer and supplier.
  const roles = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const addRole = (cedula: string | null | undefined, role: string) => {
    const c = strip(cedula);
    if (!c) return;
    if (!roles.has(c)) roles.set(c, new Set());
    roles.get(c)!.add(role);
  };
  for (const s of input.suppliers) names.set(strip(s.cedula), strip(s.nombre));
  if (input.institution) names.set(strip(input.institution.cedula), strip(input.institution.nombre));
  addRole(tn.cedula_institucion, 'buyer');
  for (const b of input.bids) addRole(b.cedula_proveedor, 'tenderer');
  for (const a of input.awardLines) addRole(a.cedula_proveedor, 'supplier');
  for (const c of input.contracts) addRole(c.cedula_proveedor, 'supplier');

  const parties = [...roles.entries()].map(([cedula, set]) =>
    clean({
      id: partyId(cedula),
      name: names.get(cedula) || undefined,
      identifier: clean({
        scheme: ID_SCHEME,
        id: cedula,
        legalName: names.get(cedula) || undefined,
      }),
      roles: [...set].sort(),
    }),
  );

  const contractCurrency = currency(input.contracts.find((c) => c.moneda)?.moneda ?? null);
  const cat = procurementCategory(tn.clas_obj);
  const buyerCedula = strip(tn.cedula_institucion);

  const tender = clean({
    id: strip(tn.nro_procedimiento) || tn.nro_sicop,
    title: strip(tn.cartel_nm) || undefined,
    status: tenderStatus(tn.cartel_stat),
    procuringEntity:
      buyerCedula ?
        clean({ id: partyId(buyerCedula), name: names.get(buyerCedula) || undefined })
      : undefined,
    items: itemsFrom(input.bidLines, `${tn.nro_sicop}-item`),
    value:
      tn.monto_est !== null && tn.monto_est !== undefined ?
        { amount: tn.monto_est, currency: contractCurrency }
      : undefined,
    procurementMethod: procurementMethod(tn.tipo_procedimiento),
    procurementMethodDetails: strip(tn.tipo_procedimiento) || undefined,
    procurementMethodRationale: strip(tn.des_excepcion) || undefined,
    mainProcurementCategory: cat.main,
    additionalProcurementCategories: cat.additional,
    tenderPeriod: clean({
      startDate: ocdsDate(tn.fecha_publicacion),
      endDate: ocdsDate(tn.fechah_apertura),
    }),
    numberOfTenderers: input.bids.length || undefined,
    tenderers: [...new Set(input.bids.map((b) => strip(b.cedula_proveedor)).filter(Boolean))].map(
      (c) => clean({ id: partyId(c), name: names.get(c) || undefined }),
    ),
    // The modality is not an OCDS concept. It travels as a submission-method note
    // rather than being dropped, because "segun demanda" changes how a contract is
    // read and an analyst who loses it draws the wrong conclusion about value.
    submissionMethodDetails: strip(tn.modalidad) || undefined,
  });

  // One OCDS award per (acto de adjudicacion, supplier). NRO_ACTO is the decision;
  // a single decision can award lines to several suppliers, and OCDS models an
  // award as going to one set of suppliers with one value.
  const awardGroups = new Map<string, AwardLineRow[]>();
  for (const l of input.awardLines) {
    const key = `${strip(l.nro_acto)} ${strip(l.cedula_proveedor)}`;
    const list = awardGroups.get(key);
    if (list) list.push(l);
    else awardGroups.set(key, [l]);
  }
  const awards = [...awardGroups.entries()].map(([key, lines]) => {
    const [acto, supplier] = key.split(' ');
    return clean({
      id: `${acto}-${supplier}`,
      status: 'active',
      suppliers:
        supplier ?
          [clean({ id: partyId(supplier), name: names.get(supplier) || undefined })]
        : [],
      items: itemsFrom(lines, `${tn.nro_sicop}-${acto}-item`),
      value: money(lines),
    });
  });

  // Contracts. SECUENCIA is the revision counter: the base row is the contract and
  // every later sequence is an amendment SICOP declared as such.
  const byNumber = new Map<string, ContractRow[]>();
  for (const c of input.contracts) {
    const list = byNumber.get(c.nro_contrato);
    if (list) list.push(c);
    else byNumber.set(c.nro_contrato, [c]);
  }
  const soleAward = awards.length === 1 ? (awards[0].id as string) : undefined;
  const contracts = [...byNumber.entries()].map(([nro, revisions]) => {
    const ordered = revisions.slice().sort((a, b) => Number(a.secuencia) - Number(b.secuencia));
    const base = ordered[0];
    const amendments = ordered.slice(1).map((r) =>
      clean({
        id: `${nro}-${r.secuencia}`,
        date: ocdsDate(r.fecha_modificacion ?? r.fecha_elaboracion),
        rationale: strip(r.tipo_modificacion) || undefined,
      }),
    );
    return clean({
      id: nro,
      awardID: soleAward,
      status: 'active',
      dateSigned: ocdsDate(base.fecha_elaboracion),
      period: clean({ startDate: ocdsDate(base.fecha_notificacion) }),
      // The source states duration as free text ("1 Anos", "12 Meses"), which is not
      // an OCDS period. It is published verbatim rather than guessed into dates.
      description: strip(base.vigencia) || undefined,
      amendments,
    });
  });

  const planning = clean({
    rationale: strip(tn.des_excepcion) || undefined,
    budget:
      tn.monto_est !== null && tn.monto_est !== undefined ?
        clean({
          id: strip(tn.nro_procedimiento) || tn.nro_sicop,
          description: t('ocds.budgetNote', lang),
          amount: { amount: tn.monto_est, currency: contractCurrency },
        })
      : undefined,
  });

  const tag: string[] = ['tender'];
  if (awards.length) tag.push('award');
  if (contracts.length) tag.push('contract');
  if (Object.keys(planning).length) tag.unshift('planning');

  const fallbackDate = ocdsDate(
    `${tn.source_month.slice(0, 4)}-${tn.source_month.slice(4, 6)}-01`,
  );

  return clean({
    ocid: ocidFor(tn.nro_sicop),
    // The release id names the archive version it was read from, so two releases
    // built from two versions of the same month stay distinguishable, which is the
    // point of a release being immutable.
    id: `${tn.nro_sicop}-${tn.source_month}-${tn.archive_stamp}`,
    date: ocdsDate(tn.fecha_publicacion) ?? fallbackDate ?? new Date(0).toISOString(),
    tag,
    initiationType: 'tender',
    language: lang,
    parties,
    buyer:
      buyerCedula ?
        clean({ id: partyId(buyerCedula), name: names.get(buyerCedula) || undefined })
      : undefined,
    planning: Object.keys(planning).length ? planning : undefined,
    tender,
    awards,
    contracts,
  });
}

export type PackageOptions = {
  lang?: Lang;
  uri?: string;
  publishedDate?: string;
  publisherUri?: string;
};

export function buildPackage(
  releases: Record<string, unknown>[],
  opts: PackageOptions = {},
): Record<string, unknown> {
  const lang = opts.lang ?? DEFAULT_LANG;
  return {
    uri: opts.uri ?? 'urn:ancla:ocds',
    version: OCDS_VERSION,
    publishedDate: opts.publishedDate ?? new Date().toISOString(),
    publisher: clean({
      name: t('ocds.publisherName', lang),
      scheme: ID_SCHEME,
      uri: opts.publisherUri || undefined,
    }),
    license: 'https://opendatacommons.org/licenses/pddl/1-0/',
    publicationPolicy: t('ocds.publisherNote', lang),
    releases,
  };
}

// ---------------------------------------------------------------------------
// Reading a month out of the index
// ---------------------------------------------------------------------------

const TENDER_COLS =
  'nro_sicop, nro_procedimiento, cedula_institucion, fecha_publicacion, fechah_apertura, tipo_procedimiento, modalidad, cartel_stat, cartel_nm, monto_est, clas_obj, cod_excepcion, des_excepcion, source_month, archive_stamp';

export function tendersForMonth(month: string, limit: number, offset: number): TenderRow[] {
  return rows<TenderRow>(
    `SELECT ${TENDER_COLS} FROM tender WHERE source_month = ? ORDER BY nro_sicop LIMIT ? OFFSET ?`,
    [month, limit, offset],
  );
}

export function tenderByNumber(nroSicop: string): TenderRow | undefined {
  return rows<TenderRow>(`SELECT ${TENDER_COLS} FROM tender WHERE nro_sicop = ? LIMIT 1`, [
    nroSicop,
  ])[0];
}

export function tenderCountForMonth(month: string): number {
  return (
    rows<{ n: number }>('SELECT COUNT(*) AS n FROM tender WHERE source_month = ?', [month])[0]?.n ??
    0
  );
}

export function loadRelease(tender: TenderRow): ReleaseInput {
  const sicop = tender.nro_sicop;
  const bids = rows<BidRow>(
    'SELECT nro_sicop, nro_oferta, cedula_proveedor, fecha_presenta, tipo_oferta FROM bid WHERE nro_sicop = ?',
    [sicop],
  );
  const bidLines = rows<BidLineRow>(
    'SELECT nro_sicop, nro_oferta, nro_linea, codigo_producto, cantidad, precio_unitario, moneda FROM bid_line WHERE nro_sicop = ?',
    [sicop],
  );
  const awardLines = rows<AwardLineRow>(
    'SELECT nro_sicop, nro_oferta, nro_linea, nro_acto, cedula_proveedor, codigo_producto, cantidad, precio_unitario, moneda FROM award_line WHERE nro_sicop = ?',
    [sicop],
  );
  const contracts = rows<ContractRow>(
    'SELECT nro_contrato, secuencia, nro_sicop, cedula_proveedor, cedula_institucion, tipo_contrato, tipo_modificacion, fecha_notificacion, fecha_elaboracion, moneda, vigencia, fecha_modificacion FROM contract WHERE nro_sicop = ?',
    [sicop],
  );
  const institution =
    tender.cedula_institucion ?
      (rows<PartyRow>('SELECT cedula, nombre FROM institution WHERE cedula = ?', [
        tender.cedula_institucion,
      ])[0] ?? null)
    : null;

  const cedulas = [
    ...new Set(
      [...bids, ...awardLines, ...contracts]
        .map((r) => strip((r as { cedula_proveedor?: string | null }).cedula_proveedor))
        .filter(Boolean),
    ),
  ];
  const suppliers =
    cedulas.length ?
      rows<PartyRow>(
        `SELECT cedula_proveedor AS cedula, nombre FROM supplier WHERE cedula_proveedor IN (${cedulas
          .map(() => '?')
          .join(',')})`,
        cedulas,
      )
    : [];

  return { tender, bids, bidLines, awardLines, contracts, institution, suppliers };
}

export function packageForMonth(
  month: string,
  opts: PackageOptions & { limit?: number; offset?: number } = {},
): { package: Record<string, unknown>; total: number; limit: number; offset: number } {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
  const offset = Math.max(opts.offset ?? 0, 0);
  const total = tenderCountForMonth(month);
  const releases = tendersForMonth(month, limit, offset).map((tn) =>
    buildRelease(loadRelease(tn), opts.lang),
  );
  return { package: buildPackage(releases, opts), total, limit, offset };
}
