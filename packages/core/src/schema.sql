-- Ancla longitudinal index.
--
-- The Observatorio publishes monthly fragments. A procedure opened in March and
-- paid in November appears in neither month completely, which is why any analysis
-- of a single archive is biased toward short-lived records. This schema is the
-- stitched view: every month folded into one queryable history.
--
-- Provenance is kept per row. source_month is the archive a row came from and
-- archive_stamp is that archive's publication timestamp, so any figure can be
-- traced back to the exact file it came from and re-verified against an anchor.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS tender (
  nro_sicop          TEXT PRIMARY KEY,
  nro_procedimiento  TEXT,
  cedula_institucion TEXT,
  fecha_publicacion  TEXT,
  fechah_apertura    TEXT,
  tipo_procedimiento TEXT,
  modalidad          TEXT,
  cartel_stat        TEXT,
  cartel_nm          TEXT,
  monto_est          REAL,
  clas_obj           TEXT,
  cod_excepcion      TEXT,
  des_excepcion      TEXT,
  fecha_mod          TEXT,
  source_month       TEXT NOT NULL,
  archive_stamp      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS bid (
  nro_sicop        TEXT NOT NULL,
  nro_oferta       TEXT NOT NULL,
  cedula_proveedor TEXT,
  fecha_presenta   TEXT,
  tipo_oferta      TEXT,
  id_consorcio     TEXT,
  source_month     TEXT NOT NULL,
  archive_stamp    TEXT NOT NULL,
  PRIMARY KEY (nro_sicop, nro_oferta)
);

CREATE TABLE IF NOT EXISTS bid_line (
  nro_sicop        TEXT NOT NULL,
  nro_oferta       TEXT NOT NULL,
  nro_linea        TEXT NOT NULL,
  codigo_producto  TEXT,
  cantidad         REAL,
  precio_unitario  REAL,
  moneda           TEXT,
  source_month     TEXT NOT NULL,
  PRIMARY KEY (nro_sicop, nro_oferta, nro_linea)
);

CREATE TABLE IF NOT EXISTS award_line (
  nro_sicop        TEXT NOT NULL,
  nro_oferta       TEXT NOT NULL,
  nro_linea        TEXT NOT NULL,
  nro_acto         TEXT NOT NULL,
  cedula_proveedor TEXT,
  codigo_producto  TEXT,
  cantidad         REAL,
  precio_unitario  REAL,
  moneda           TEXT,
  source_month     TEXT NOT NULL,
  PRIMARY KEY (nro_sicop, nro_oferta, nro_linea, nro_acto)
);

CREATE TABLE IF NOT EXISTS contract (
  nro_contrato       TEXT NOT NULL,
  secuencia          TEXT NOT NULL,
  nro_sicop          TEXT,
  nro_procedimiento  TEXT,
  cedula_proveedor   TEXT,
  cedula_institucion TEXT,
  tipo_contrato      TEXT,
  tipo_modificacion  TEXT,
  fecha_notificacion TEXT,
  fecha_elaboracion  TEXT,
  moneda             TEXT,
  vigencia           TEXT,
  fecha_modificacion TEXT,
  source_month       TEXT NOT NULL,
  archive_stamp      TEXT NOT NULL,
  PRIMARY KEY (nro_contrato, secuencia)
);

-- FechaPorEtapas: 27 stage dates per procedure. The basis for every duration
-- statistic, and only meaningful once stitched across months.
CREATE TABLE IF NOT EXISTS stage_dates (
  nro_sicop                 TEXT NOT NULL,
  cartel_seq                TEXT NOT NULL,
  partida                   TEXT NOT NULL,
  linea                     TEXT NOT NULL,
  nro_procedimiento         TEXT,
  publicacion               TEXT,
  fecha_apertura            TEXT,
  adjudicacion_firme        TEXT,
  fecha_notificacion        TEXT,
  fecha_elaboracion_contrato TEXT,
  fecha_1ra_sol_pago        TEXT,
  fecha_ult_sol_pago        TEXT,
  fecha_resul_pago          TEXT,
  source_month              TEXT NOT NULL,
  PRIMARY KEY (nro_sicop, cartel_seq, partida, linea)
);

CREATE TABLE IF NOT EXISTS appeal (
  nro_recurso       TEXT NOT NULL,
  linea_objetada    TEXT NOT NULL,
  cedula_proveedor  TEXT,
  nro_sicop         TEXT,
  nro_acto          TEXT,
  tipo_recurso      TEXT,
  resultado         TEXT,
  causa_resultado   TEXT,
  fecha_presentacion TEXT,
  nro_procedimiento TEXT,
  recurso_stat      TEXT,
  source_month      TEXT NOT NULL,
  PRIMARY KEY (nro_recurso, linea_objetada)
);

CREATE TABLE IF NOT EXISTS supplier (
  cedula_proveedor TEXT PRIMARY KEY,
  nombre           TEXT,
  tipo             TEXT,
  tamano           TEXT,
  zona_geo         TEXT,
  fecha_constitucion TEXT,
  source_month     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS institution (
  cedula       TEXT PRIMARY KEY,
  nombre       TEXT,
  zona_geo     TEXT,
  fecha_ingreso TEXT,
  source_month TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sanction (
  cedula_proveedor   TEXT,
  cedula_institucion TEXT,
  no_resolucion      TEXT,
  codigo_producto    TEXT,
  tipo_sancion       TEXT,
  descr_sancion      TEXT,
  inicio_sancion     TEXT,
  final_sancion      TEXT,
  estado             TEXT,
  source_month       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inhibition (
  ced_institucion TEXT,
  ced_funcionario TEXT,
  nom_funcionario TEXT,
  fecha_inicio    TEXT,
  fecha_fin       TEXT,
  estado          TEXT,
  source_month    TEXT NOT NULL
);

-- Entity resolution. A cedula is not a company: consortia bid under a shared
-- ID_CONSORCIO, and corporate groups share officers, addresses, and names.
-- entity is the resolved actor; entity_member maps the cedulas that belong to it.
CREATE TABLE IF NOT EXISTS entity (
  entity_id      TEXT PRIMARY KEY,
  canonical_name TEXT,
  kind           TEXT NOT NULL,   -- supplier | consortium | group
  member_count   INTEGER NOT NULL DEFAULT 1,
  evidence       TEXT             -- why these were merged, as JSON
);

CREATE TABLE IF NOT EXISTS entity_member (
  entity_id        TEXT NOT NULL,
  cedula_proveedor TEXT NOT NULL,
  role             TEXT,
  PRIMARY KEY (entity_id, cedula_proveedor)
);

-- Which archive versions have been loaded, so ingest is resumable and a rewritten
-- month can be reloaded without duplicating rows.
CREATE TABLE IF NOT EXISTS loaded_archive (
  source_month  TEXT NOT NULL,
  archive_stamp TEXT NOT NULL,
  sha256        TEXT NOT NULL,
  loaded_at     TEXT NOT NULL,
  row_counts    TEXT,
  PRIMARY KEY (source_month, archive_stamp)
);

CREATE INDEX IF NOT EXISTS ix_tender_inst    ON tender(cedula_institucion);
CREATE INDEX IF NOT EXISTS ix_tender_proc    ON tender(nro_procedimiento);
CREATE INDEX IF NOT EXISTS ix_tender_pub     ON tender(fecha_publicacion);
CREATE INDEX IF NOT EXISTS ix_tender_exc     ON tender(cod_excepcion);
CREATE INDEX IF NOT EXISTS ix_bid_prov       ON bid(cedula_proveedor);
CREATE INDEX IF NOT EXISTS ix_bid_sicop      ON bid(nro_sicop);
CREATE INDEX IF NOT EXISTS ix_bid_consorcio  ON bid(id_consorcio);
CREATE INDEX IF NOT EXISTS ix_bidline_prod   ON bid_line(codigo_producto);
CREATE INDEX IF NOT EXISTS ix_award_prov     ON award_line(cedula_proveedor);
CREATE INDEX IF NOT EXISTS ix_award_prod     ON award_line(codigo_producto);
CREATE INDEX IF NOT EXISTS ix_award_sicop    ON award_line(nro_sicop);
CREATE INDEX IF NOT EXISTS ix_contract_prov  ON contract(cedula_proveedor);
CREATE INDEX IF NOT EXISTS ix_contract_inst  ON contract(cedula_institucion);
CREATE INDEX IF NOT EXISTS ix_stage_sicop    ON stage_dates(nro_sicop);
CREATE INDEX IF NOT EXISTS ix_appeal_prov    ON appeal(cedula_proveedor);
CREATE INDEX IF NOT EXISTS ix_appeal_sicop   ON appeal(nro_sicop);
CREATE INDEX IF NOT EXISTS ix_appeal_fecha   ON appeal(fecha_presentacion);
CREATE INDEX IF NOT EXISTS ix_member_cedula  ON entity_member(cedula_proveedor);
