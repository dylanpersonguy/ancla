/**
 * How each published CSV maps onto the index schema.
 *
 * Every mapping here was checked against all 189 mirrored archives rather than
 * taken from documentation. Two facts came out of that check and shape the whole
 * loader:
 *
 *   1. Column ORDER is not stable. The 2025-09 republication reordered nine of
 *      the eleven tables we load without renaming anything. A positional reader
 *      would have silently written award prices into the currency column for the
 *      last twelve months. Columns are therefore always resolved by name.
 *   2. Column NAMES are stable, but their case is not: RecursosObjecion ships
 *      `recurso_stat` and `nro_procedimiento` in lower case while its neighbours
 *      are upper case. Header lookup is case-insensitive.
 *
 * LineasOfertadas is the one table whose column SET moved: CODIGO_PRODUCTO_CL
 * comes and goes between 2013 and 2024. Absent columns read as null, so a spec
 * may name a column that only some months carry.
 *
 * This list is also the skip list. The loader inflates a CSV only if a spec
 * names it, which is what keeps InvitacionProcedimiento out: it reaches 447 MB
 * uncompressed in 202211, holds nothing the schema keeps, and is the one entry
 * that would put the loader's memory use at the mercy of the source.
 */

export type ColumnKind = 'text' | 'date' | 'date8' | 'num';

export type Column = {
  /** Column in the index schema. */
  col: string;
  /** Header in the published CSV. An array tries each name in order. */
  csv: string | string[];
  kind: ColumnKind;
};

export type TableSpec = {
  /** CSV basename inside the archive, without the extension. */
  csv: string;
  /** Table in packages/core/src/schema.sql. */
  table: string;
  /** Index columns that identify a row. Must be backed by a unique index. */
  key: string[];
  columns: Column[];
  /** True when the schema table carries archive_stamp as well as source_month. */
  stamp: boolean;
  /**
   * True when the unique index is one we create ourselves over COALESCE(col,'').
   * The upsert conflict target has to match the index expression exactly.
   */
  coalesceKey?: boolean;
};

const t = (col: string, csv: string | string[]): Column => ({ col, csv, kind: 'text' });
const d = (col: string, csv: string | string[]): Column => ({ col, csv, kind: 'date' });
const d8 = (col: string, csv: string | string[]): Column => ({ col, csv, kind: 'date8' });
const n = (col: string, csv: string | string[]): Column => ({ col, csv, kind: 'num' });

export const SPECS: TableSpec[] = [
  {
    csv: 'DetalleCarteles',
    table: 'tender',
    key: ['nro_sicop'],
    stamp: true,
    columns: [
      t('nro_sicop', 'NRO_SICOP'),
      t('nro_procedimiento', 'NRO_PROCEDIMIENTO'),
      t('cedula_institucion', 'CEDULA_INSTITUCION'),
      d('fecha_publicacion', 'FECHA_PUBLICACION'),
      d('fechah_apertura', 'FECHAH_APERTURA'),
      t('tipo_procedimiento', 'TIPO_PROCEDIMIENTO'),
      t('modalidad', 'MODALIDAD_PROCEDIMIENTO'),
      t('cartel_stat', 'CARTEL_STAT'),
      t('cartel_nm', 'CARTEL_NM'),
      n('monto_est', 'MONTO_EST'),
      t('clas_obj', 'CLAS_OBJ'),
      t('cod_excepcion', 'COD_EXCEPCION'),
      t('des_excepcion', 'DES_EXCEPCION'),
      d('fecha_mod', 'FECHA_MOD'),
    ],
  },
  {
    csv: 'Ofertas',
    table: 'bid',
    key: ['nro_sicop', 'nro_oferta'],
    stamp: true,
    columns: [
      t('nro_sicop', 'NRO_SICOP'),
      t('nro_oferta', 'NRO_OFERTA'),
      t('cedula_proveedor', 'CEDULA_PROVEEDOR'),
      d('fecha_presenta', 'FECHA_PRESENTA_OFERTA'),
      t('tipo_oferta', 'TIPO_OFERTA'),
      t('id_consorcio', 'ID_CONSORCIO'),
    ],
  },
  {
    csv: 'LineasOfertadas',
    table: 'bid_line',
    key: ['nro_sicop', 'nro_oferta', 'nro_linea'],
    stamp: false,
    columns: [
      t('nro_sicop', 'NRO_SICOP'),
      t('nro_oferta', 'NRO_OFERTA'),
      t('nro_linea', 'NRO_LINEA'),
      t('codigo_producto', 'CODIGO_PRODUCTO'),
      n('cantidad', 'CANTIDAD_OFERTADA'),
      n('precio_unitario', 'PRECIO_UNITARIO_OFERTADO'),
      t('moneda', 'TIPO_MONEDA'),
    ],
  },
  {
    csv: 'LineasAdjudicadas',
    table: 'award_line',
    key: ['nro_sicop', 'nro_oferta', 'nro_linea', 'nro_acto'],
    stamp: false,
    columns: [
      t('nro_sicop', 'NRO_SICOP'),
      t('nro_oferta', 'NRO_OFERTA'),
      t('nro_linea', 'NRO_LINEA'),
      t('nro_acto', 'NRO_ACTO'),
      t('cedula_proveedor', 'CEDULA_PROVEEDOR'),
      t('codigo_producto', 'CODIGO_PRODUCTO'),
      n('cantidad', 'CANTIDAD_ADJUDICADA'),
      n('precio_unitario', 'PRECIO_UNITARIO_ADJUDICADO'),
      t('moneda', 'TIPO_MONEDA'),
    ],
  },
  {
    csv: 'Contratos',
    table: 'contract',
    key: ['nro_contrato', 'secuencia'],
    stamp: true,
    columns: [
      t('nro_contrato', 'NRO_CONTRATO'),
      t('secuencia', 'SECUENCIA'),
      t('nro_sicop', 'NRO_SICOP'),
      t('nro_procedimiento', ['NUMERO_PROCEDIMIENTO', 'NRO_PROCEDIMIENTO']),
      t('cedula_proveedor', 'CEDULA_PROVEEDOR'),
      t('cedula_institucion', 'CEDULA_INSTITUCION'),
      t('tipo_contrato', 'TIPO_CONTRATO'),
      t('tipo_modificacion', 'TIPO_MODIFICACION'),
      d('fecha_notificacion', 'FECHA_NOTIFICACION'),
      d('fecha_elaboracion', 'FECHA_ELABORACION'),
      t('moneda', 'MONEDA'),
      t('vigencia', 'VIGENCIA'),
      d('fecha_modificacion', 'FECHA_MODIFICACION'),
    ],
  },
  {
    // 27 stage dates per procedure line. The schema keeps the subset that any
    // duration question actually needs; the rest stay in the archives.
    csv: 'FechaPorEtapas',
    table: 'stage_dates',
    key: ['nro_sicop', 'cartel_seq', 'partida', 'linea'],
    stamp: false,
    columns: [
      t('nro_sicop', 'NRO_SICOP'),
      t('cartel_seq', 'CARTEL_SEQ'),
      t('partida', 'PARTIDA'),
      t('linea', 'LINEA'),
      t('nro_procedimiento', ['NUMERO_PROCEDIMIENTO', 'NRO_PROCEDIMIENTO']),
      d('publicacion', 'PUBLICACION'),
      d('fecha_apertura', 'FECHA_APERTURA'),
      d('adjudicacion_firme', 'ADJUDICACION_FIRME'),
      d('fecha_notificacion', 'FECHA_NOTIFICACION'),
      d('fecha_elaboracion_contrato', 'FECHA_ELABORACION_CONTRATO'),
      d('fecha_1ra_sol_pago', 'FECHA_1RA_SOL_PAGO'),
      d('fecha_ult_sol_pago', 'FECHA_ULT_SOL_PAGO'),
      d('fecha_resul_pago', 'FECHA_RESUL_PAGO'),
    ],
  },
  {
    // NRO_RECURSO alone is not unique: one appeal objects to several lines and
    // the source emits one row per objected line.
    csv: 'RecursosObjecion',
    table: 'appeal',
    key: ['nro_recurso', 'linea_objetada'],
    stamp: false,
    columns: [
      t('nro_recurso', 'NRO_RECURSO'),
      t('linea_objetada', 'LINEA_OBJETADA'),
      t('cedula_proveedor', 'CEDULA_PROVEEDOR'),
      t('nro_sicop', 'NRO_SICOP'),
      t('nro_acto', 'NRO_ACTO'),
      t('tipo_recurso', 'TIPO_RECURSO'),
      t('resultado', 'RESULTADO'),
      t('causa_resultado', 'CAUSA_RESULTADO'),
      d('fecha_presentacion', 'FECHA_PRESENTACION_RECURSO'),
      t('nro_procedimiento', ['NRO_PROCEDIMIENTO', 'NUMERO_PROCEDIMIENTO']),
      t('recurso_stat', 'RECURSO_STAT'),
    ],
  },
  {
    // A cumulative registry, not a monthly delta: every archive republishes the
    // whole supplier list, so later months simply refresh earlier rows.
    csv: 'Proveedores',
    table: 'supplier',
    key: ['cedula_proveedor'],
    stamp: false,
    columns: [
      t('cedula_proveedor', 'CEDULA_PROVEEDOR'),
      t('nombre', 'NOMBRE_PROVEEDOR'),
      t('tipo', 'TIPO_PROVEEDOR'),
      // The published header carries an enye. Some tools transliterate it, so
      // accept both spellings rather than lose the company size field.
      t('tamano', ['TAMAÑO_PROVEEDOR', 'TAMANO_PROVEEDOR']),
      t('zona_geo', 'ZONA_GEO_PROV'),
      d8('fecha_constitucion', 'FECHA_CONSTITUCION'),
    ],
  },
  {
    csv: 'InstitucionesRegistradas',
    table: 'institution',
    key: ['cedula'],
    stamp: false,
    columns: [
      t('cedula', 'CEDULA'),
      t('nombre', 'NOMBRE_INSTITUCION'),
      t('zona_geo', 'ZONA_GEO_INST'),
      d('fecha_ingreso', 'FECHA_INGRESO'),
    ],
  },
  {
    // The only comma-delimited table in the archive.
    csv: 'SancionProveedores',
    table: 'sanction',
    key: ['cedula_proveedor', 'cedula_institucion', 'no_resolucion', 'codigo_producto'],
    stamp: false,
    coalesceKey: true,
    columns: [
      t('cedula_proveedor', 'CEDULA_PROVEEDOR'),
      t('cedula_institucion', 'CEDULA_INSTITUCION'),
      t('no_resolucion', 'NO_RESOLUCION'),
      t('codigo_producto', 'CODIGO_PRODUCTO'),
      t('tipo_sancion', 'TIPO_SANCION'),
      t('descr_sancion', 'DESCR_SANCION'),
      d8('inicio_sancion', 'INICIO_SANCION'),
      d8('final_sancion', 'FINAL_SANCION'),
      t('estado', 'ESTADO'),
    ],
  },
  {
    csv: 'FuncionariosInhibicion',
    table: 'inhibition',
    key: ['ced_institucion', 'ced_funcionario', 'fecha_inicio'],
    stamp: false,
    coalesceKey: true,
    columns: [
      t('ced_institucion', 'CED_INSTITUCION'),
      t('ced_funcionario', 'CED_FUNCIONARIO'),
      t('nom_funcionario', 'NOM_FUNCIONARIO'),
      d('fecha_inicio', 'FECHA_INICIO'),
      d('fecha_fin', 'FECHA_FIN'),
      t('estado', 'ESTADO'),
    ],
  },
];

