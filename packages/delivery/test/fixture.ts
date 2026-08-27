/**
 * Test fixtures.
 *
 * Everything the delivery layer reads lives under one data root, so a test gets a
 * throwaway directory, fills it with the three stores, and points the environment
 * at it. Nothing here touches the real ~/ancla-data, the real index, or the real
 * chain: the node is a stub server on localhost, so the suite runs offline and
 * gives the same answer in January as in August.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { leafFor, writeSnapshot, type Snapshot } from '../../canonicalize/src/snapshot.ts';
import { root } from '../../merkle/src/index.ts';
import { openDb, type Db } from '../../core/src/db.ts';
import type { WatchReport } from '../../cli/src/watch.ts';
import type { CanonRecord } from '../../canonicalize/src/canonical.ts';
import { dropChainCache } from '../src/chain.ts';
import { dropFeedCache, dropSnapshotCache, resetIndex } from '../src/data.ts';

export const MONTH = '202601';
export const STAMP = '20260101T000000Z';
export const ARCHIVE_FILE = `${STAMP}-deadbeefcafe.zip`;
export const PREVIOUS_STAMP = '20251231T000000Z';
export const ANCHOR_DAY = '2026-01-02';
export const ANCHOR_ADDRESS = '3DTestAnchorAddressForUnitTests';
export const RAN_AT = '2026-01-02T06:00:00.000Z';

const hexOf = (s: string) => createHash('sha256').update(s).digest('hex');

/** A small deterministic record set that exercises several tables and id shapes. */
export function fixtureRecords(): CanonRecord[] {
  const specs: [string, string][] = [
    ['DetalleCarteles', '20260100001'],
    ['DetalleCarteles', '20260100002'],
    ['Contratos', '0432026000100001|0'],
    ['Contratos', '0432026000100001|1'],
    ['Ofertas', '20260100001|1'],
    ['Ofertas', '20260100001|2'],
    ['LineasAdjudicadas', '20260100001|1|1|900001'],
    ['Proveedores', '3101999888'],
    ['InstitucionesRegistradas', '4000042138'],
    ['RecursosObjecion', 'R-2026-001|1'],
    ['Garantias', 'sha256:0123456789abcdef0123456789abcdef#0'],
  ];
  return specs
    .map(([table, id]) => ({
      table,
      id,
      byteHash: hexOf(`byte ${table} ${id}`),
      valueHash: hexOf(`value ${table} ${id}`),
    }))
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : a.id < b.id ? -1 : 1));
}

export function fixtureSnapshot(records = fixtureRecords()): Snapshot {
  return {
    canonVersion: 'ancla-canon-1',
    month: MONTH,
    archiveSha256: hexOf('archive'),
    merkleRoot: root(records.map(leafFor)).toString('hex'),
    recordCount: records.length,
    tables: [
      {
        table: 'DetalleCarteles',
        rows: 2,
        records: 2,
        schema: 'aaaaaaaaaaaaaaaa',
        contentAddressed: false,
        duplicateKeys: 0,
      },
    ],
    records,
  };
}

/** A watch report shaped exactly like the daily job writes one. */
export function fixtureReport(snap: Snapshot): WatchReport {
  const rec = (i: number) => snap.records[i];
  return {
    ranAt: RAN_AT,
    monthsChecked: 3,
    monthsUpdated: [MONTH],
    findings: [
      {
        month: MONTH,
        closedMonth: true,
        previousStamp: PREVIOUS_STAMP,
        currentStamp: STAMP,
        diff: {
          month: MONTH,
          from: { archiveSha256: hexOf('old'), merkleRoot: hexOf('oldroot'), recordCount: 10 },
          to: {
            archiveSha256: snap.archiveSha256,
            merkleRoot: snap.merkleRoot,
            recordCount: snap.recordCount,
          },
          counts: {
            added: 1,
            recordedAmendment: 1,
            silentRevision: 1,
            reformatted: 1,
            removed: 1,
          },
          schemaChanges: [],
          changes: [
            {
              kind: 'silentRevision',
              table: 'DetalleCarteles',
              id: '20260100001',
              before: { byteHash: hexOf('before'), valueHash: hexOf('vbefore') },
              after: { byteHash: rec(0).byteHash, valueHash: rec(0).valueHash },
            },
            {
              kind: 'recordedAmendment',
              table: 'Contratos',
              id: '0432026000100001|1',
              after: { byteHash: hexOf('a'), valueHash: hexOf('b') },
            },
            {
              kind: 'added',
              table: 'Ofertas',
              id: '20260100002|1',
              after: { byteHash: hexOf('c'), valueHash: hexOf('d') },
            },
            {
              kind: 'reformatted',
              table: 'LineasAdjudicadas',
              id: '20260100001|1|1|900001',
              before: { byteHash: hexOf('e'), valueHash: hexOf('same') },
              after: { byteHash: hexOf('f'), valueHash: hexOf('same') },
            },
            {
              kind: 'removed',
              table: 'Proveedores',
              id: '3101999888',
              before: { byteHash: hexOf('g'), valueHash: hexOf('h') },
            },
          ],
          canonVersionMismatch: false,
        },
      },
    ],
  };
}

/** Rows that make the index answer the same questions the real one would. */
export function seedIndex(db: Db): void {
  db.exec(`
    INSERT INTO institution (cedula, nombre, zona_geo, fecha_ingreso, source_month)
      VALUES ('4000042138', 'CAJA COSTARRICENSE DE SEGURO SOCIAL', 'San José', '2010-01-01', '${MONTH}');
    INSERT INTO supplier (cedula_proveedor, nombre, tipo, tamano, zona_geo, fecha_constitucion, source_month)
      VALUES ('3101999888', 'DISTRIBUIDORA EJEMPLO SOCIEDAD ANONIMA', 'Nacional Jurídico', 'Pequeña', 'San José', '2001-05-04', '${MONTH}');
    INSERT INTO supplier (cedula_proveedor, nombre, tipo, tamano, zona_geo, fecha_constitucion, source_month)
      VALUES ('3101777666', 'SEGUNDO OFERENTE SOCIEDAD ANONIMA', 'Nacional Jurídico', 'Mediana', 'Cartago', '2009-02-02', '${MONTH}');

    INSERT INTO tender (nro_sicop, nro_procedimiento, cedula_institucion, fecha_publicacion,
                        fechah_apertura, tipo_procedimiento, modalidad, cartel_stat, cartel_nm,
                        monto_est, clas_obj, cod_excepcion, des_excepcion, fecha_mod,
                        source_month, archive_stamp)
      VALUES ('20260100001', '2026LR-000001-0000900001', '4000042138', '2026-01-05',
              '2026-01-20', 'LICITACIÓN REDUCIDA', 'Cantidad definida', 'Adjudicado',
              'Compra de equipo de refrigeración', 12500000.0, 'BIENES', '', '', '2026-01-06',
              '${MONTH}', '${STAMP}');
    INSERT INTO tender (nro_sicop, nro_procedimiento, cedula_institucion, fecha_publicacion,
                        fechah_apertura, tipo_procedimiento, modalidad, cartel_stat, cartel_nm,
                        monto_est, clas_obj, cod_excepcion, des_excepcion, fecha_mod,
                        source_month, archive_stamp)
      VALUES ('20260100002', '2026PE-000002-0000900001', '4000042138', '2026-01-08',
              '2026-01-12', 'PROCEDIMIENTO POR EXCEPCIÓN', 'Servicios', 'Publicado',
              'Servicio de mantenimiento', 3400000.0, 'SERVICIOS', 'c',
              'Proveedor único (Inciso c del artículo 3 LGCP 9986)', '2026-01-09',
              '${MONTH}', '${STAMP}');

    INSERT INTO bid (nro_sicop, nro_oferta, cedula_proveedor, fecha_presenta, tipo_oferta, id_consorcio, source_month, archive_stamp)
      VALUES ('20260100001', '1', '3101999888', '2026-01-19', 'Individual', '', '${MONTH}', '${STAMP}');
    INSERT INTO bid (nro_sicop, nro_oferta, cedula_proveedor, fecha_presenta, tipo_oferta, id_consorcio, source_month, archive_stamp)
      VALUES ('20260100001', '2', '3101777666', '2026-01-19', 'Individual', '', '${MONTH}', '${STAMP}');

    INSERT INTO bid_line (nro_sicop, nro_oferta, nro_linea, codigo_producto, cantidad, precio_unitario, moneda, source_month)
      VALUES ('20260100001', '1', '1', '441119059212569600000043', 2.0, 4800000.0, 'CRC', '${MONTH}');
    INSERT INTO bid_line (nro_sicop, nro_oferta, nro_linea, codigo_producto, cantidad, precio_unitario, moneda, source_month)
      VALUES ('20260100001', '2', '1', '441119059212569600000043', 2.0, 5100000.0, 'CRC', '${MONTH}');

    INSERT INTO award_line (nro_sicop, nro_oferta, nro_linea, nro_acto, cedula_proveedor, codigo_producto, cantidad, precio_unitario, moneda, source_month)
      VALUES ('20260100001', '1', '1', '900001', '3101999888', '441119059212569600000043', 2.0, 4800000.0, 'CRC', '${MONTH}');

    INSERT INTO contract (nro_contrato, secuencia, nro_sicop, nro_procedimiento, cedula_proveedor,
                          cedula_institucion, tipo_contrato, tipo_modificacion, fecha_notificacion,
                          fecha_elaboracion, moneda, vigencia, fecha_modificacion, source_month, archive_stamp)
      VALUES ('0432026000100001', '0', '20260100001', '2026LR-000001-0000900001', '3101999888',
              '4000042138', 'Base', ' ', '2026-02-01', '2026-01-28', 'CRC', '1 Años', '', '${MONTH}', '${STAMP}');
    INSERT INTO contract (nro_contrato, secuencia, nro_sicop, nro_procedimiento, cedula_proveedor,
                          cedula_institucion, tipo_contrato, tipo_modificacion, fecha_notificacion,
                          fecha_elaboracion, moneda, vigencia, fecha_modificacion, source_month, archive_stamp)
      VALUES ('0432026000100001', '1', '20260100001', '2026LR-000001-0000900001', '3101999888',
              '4000042138', 'Modificado', 'Prórrogas al contrato', '2026-02-01', '2026-01-28',
              'CRC', '1 Años', '2026-06-01', '${MONTH}', '${STAMP}');

    INSERT INTO stage_dates (nro_sicop, cartel_seq, partida, linea, nro_procedimiento, publicacion,
                             fecha_apertura, adjudicacion_firme, fecha_notificacion, source_month)
      VALUES ('20260100001', '1', '1', '1', '2026LR-000001-0000900001', '2026-01-05',
              '2026-01-20', '2026-01-26', '2026-02-01', '${MONTH}');

    INSERT INTO appeal (nro_recurso, linea_objetada, cedula_proveedor, nro_sicop, nro_acto,
                        tipo_recurso, resultado, causa_resultado, fecha_presentacion,
                        nro_procedimiento, recurso_stat, source_month)
      VALUES ('R-2026-001', '1', '3101777666', '20260100001', '900001', 'Objeción',
              'Sin lugar', 'Falta de fundamentación', '2026-01-10',
              '2026LR-000001-0000900001', 'Resuelto', '${MONTH}');
  `);
}

export type Fixture = {
  root: string;
  indexPath: string;
  snapshot: Snapshot;
  report: WatchReport;
  node: Server;
  nodeUrl: string;
  db: Db;
  close(): Promise<void>;
};

/** Stub DecentralChain node: the two endpoints chain.ts reads, nothing else. */
function startStubNode(merkleRoot: string): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/blocks/height') {
      res.end(JSON.stringify({ height: 2_316_909 }));
      return;
    }
    if (url.pathname === `/addresses/data/${ANCHOR_ADDRESS}`) {
      res.end(
        JSON.stringify([
          { key: 'latest', type: 'string', value: ANCHOR_DAY },
          {
            key: `root_${ANCHOR_DAY}_${MONTH}`,
            type: 'string',
            value: merkleRoot,
          },
          {
            key: `meta_${ANCHOR_DAY}_${MONTH}`,
            type: 'string',
            value: `ancla-canon-1|11|${hexOf('archive')}`,
          },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

export async function makeFixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'ancla-delivery-'));
  const snapshot = fixtureSnapshot();
  const report = fixtureReport(snapshot);

  await mkdir(join(dir, 'archives', MONTH), { recursive: true });
  // The archive body is never read once a snapshot exists, but the file has to be
  // there because that is how the store enumerates versions of a month.
  await writeFile(join(dir, 'archives', MONTH, ARCHIVE_FILE), '');
  await writeSnapshot(
    join(dir, 'snapshots', MONTH, ARCHIVE_FILE.replace(/\.zip$/, '.snap.gz')),
    snapshot,
  );
  await mkdir(join(dir, 'reports'), { recursive: true });
  await writeFile(
    join(dir, 'reports', 'watch-2026-01-02.json'),
    JSON.stringify(report, null, 2),
    'utf8',
  );

  const indexFile = join(dir, 'index.sqlite');
  const db = openDb(indexFile);
  seedIndex(db);

  const { server, url } = await startStubNode(snapshot.merkleRoot);

  process.env.ANCLA_DATA = dir;
  process.env.ANCLA_INDEX = indexFile;
  process.env.ANCLA_NODE = url;
  process.env.ANCLA_ANCHOR_ADDRESS = ANCHOR_ADDRESS;

  resetIndex();
  dropFeedCache();
  dropSnapshotCache();
  dropChainCache();

  return {
    root: dir,
    indexPath: indexFile,
    snapshot,
    report,
    node: server,
    nodeUrl: url,
    db,
    async close() {
      resetIndex();
      dropFeedCache();
      dropSnapshotCache();
      dropChainCache();
      try {
        db.close();
      } catch {
        /* the read-only handle may already be closed */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
