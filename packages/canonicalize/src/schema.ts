/**
 * Table definitions for the Observatorio archives.
 *
 * `key` is the composite primary key used to give a record a stable identity
 * across snapshots. Getting this right is what lets the differ say "this record
 * changed" instead of "one record vanished and a different one appeared".
 *
 * Keys here are proposals. `verifyKeys` in canonical.ts checks each against real
 * data; any table whose proposed key is not unique falls back to content
 * addressing, where the whole row is the identity. Content-addressed tables still
 * anchor correctly, they just report edits as a removal plus an addition.
 */

export type TableDef = {
  key: string[];
  /** Fields excluded from the semantic hash: they move without the record changing. */
  volatile?: string[];
};

export const TABLES: Record<string, TableDef> = {
  AdjudicacionesFirme: { key: ['NRO_SICOP', 'NRO_ACTO'], volatile: ['FECHA_REV'] },
  Contratos: { key: ['NRO_CONTRATO', 'SECUENCIA'] },
  DetalleCarteles: { key: ['NRO_SICOP'], volatile: ['FECHA_MOD'] },
  DetalleLineaCartel: { key: ['NRO_SICOP', 'NUMERO_LINEA', 'NUMERO_PARTIDA'] },
  FechaPorEtapas: { key: ['NRO_SICOP', 'CARTEL_SEQ', 'PARTIDA', 'LINEA'] },
  FuncionariosInhibicion: {
    key: ['CED_INSTITUCION', 'CED_FUNCIONARIO', 'FECHA_INICIO'],
    volatile: ['fecha_registro'],
  },
  // No column combination is unique: the source emits ~3,000 literal duplicate
  // rows per month here. Content addressing with an occurrence counter is correct.
  Garantias: { key: ['NRO_SICOP', 'nro_garantia', 'gara_seq'], volatile: ['fecha_registro'] },
  InstitucionesRegistradas: { key: ['CEDULA'], volatile: ['FECHA_MOD'] },
  InvitacionProcedimiento: { key: ['NRO_SICOP', 'CEDULA_PROVEEDOR', 'SECUENCIA'] },
  LineasAdjudicadas: { key: ['NRO_SICOP', 'NRO_OFERTA', 'NRO_LINEA', 'NRO_ACTO'] },
  LineasContratadas: {
    key: ['NRO_SICOP', 'NRO_CONTRATO', 'SECUENCIA', 'NRO_LINEA_CONTRATO'],
  },
  LineasOfertadas: { key: ['NRO_SICOP', 'NRO_OFERTA', 'NRO_LINEA'] },
  LineasRecibidas: {
    key: ['NRO_SICOP', 'NRO_CONTRATO', 'SECUENCIA', 'NRO_LINEA', 'ENTREGA', 'NRO_RECEP_DEFINITIVA'],
  },
  Ofertas: { key: ['NRO_SICOP', 'NRO_OFERTA'] },
  OrdenPedido: {
    key: ['NRO_SICOP', 'NRO_ORDEN', 'LINEA_ORD_PEDIDO', 'FECHA_ELABORACION_ORDEN'],
    volatile: ['FECHAREGISTRO'],
  },
  ProcedimientoADM: { key: ['NRO_SICOP', 'NUMERO_PA', 'CEDULA_PROVEEDOR'] },
  ProcedimientoAdjudicacion: {
    key: ['NRO_SICOP', 'LINEA', 'CEDULA_PROVEEDOR'],
    volatile: ['fecha_rev'],
  },
  Proveedores: { key: ['CEDULA_PROVEEDOR'], volatile: ['fecha_registro', 'fecha_mod'] },
  ReajustePrecios: {
    key: ['NRO_SICOP', 'NRO_CONTRATO', 'NRO_LINEA_CONTRATO', 'NUMERO_REAJUSTE'],
  },
  Recepciones: { key: ['NRO_SICOP', 'NRO_CONTRATO', 'NRO_RECEP_DEFINITIVA'] },
  // NRO_RECURSO alone is not unique: one appeal objects to several lines.
  RecursosObjecion: { key: ['NRO_RECURSO', 'LINEA_OBJETADA'] },
  // ~80% literal duplicate rows. Content addressed. See Garantias.
  Remates: { key: ['NRO_SICOP', 'CED_PROVEEDOR', 'MONTO_PUJA'], volatile: ['fecha_mod'] },
  SancionProveedores: {
    key: ['CEDULA_PROVEEDOR', 'CEDULA_INSTITUCION', 'NO_RESOLUCION', 'CODIGO_PRODUCTO'],
    volatile: ['fecha_registro'],
  },
  // ~75% literal duplicate rows. Content addressed. See Garantias.
  SistemaEvaluacionOfertas: {
    key: ['NRO_SICOP', 'EVAL_ITEM_SEQNO'],
    volatile: ['fecha_registro'],
  },
  Sistemas: { key: ['NRO_SICOP', 'NUMERO_LINEA', 'NUMERO_PARTIDA'] },
};

export function tableDef(name: string): TableDef | null {
  return TABLES[name] ?? null;
}
