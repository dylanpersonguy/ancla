import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { query, queryOne } from '../../core/src/db.ts';
import {
  archiveVersions,
  latestArchives,
  loadArchive,
  loadRange,
  openIndex,
  parseDate8,
} from '../src/load.ts';
import { buildZip, csv, type ZipInput } from './zipwrite.ts';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'ancla-index-'));
  temps.push(d);
  return d;
}

/** A mirror-shaped tree: <root>/archives/<month>/<stamp>-<hash>.zip */
function mirror(months: Record<string, Record<string, ZipInput[]>>): string {
  const root = scratch();
  for (const [month, versions] of Object.entries(months)) {
    const dir = join(root, month);
    mkdirSync(dir, { recursive: true });
    for (const [stamp, entries] of Object.entries(versions)) {
      writeFileSync(join(dir, `${stamp}-abc123def456.zip`), buildZip(entries));
    }
  }
  return root;
}

function db() {
  return openIndex(join(scratch(), 'index.sqlite'));
}

const TENDERS = (rows: (string | number)[][]) => ({
  name: 'DetalleCarteles.csv',
  data: csv([
    [
      'NRO_SICOP',
      'CEDULA_INSTITUCION',
      'FECHA_PUBLICACION',
      'NRO_PROCEDIMIENTO',
      'TIPO_PROCEDIMIENTO',
      'MODALIDAD_PROCEDIMIENTO',
      'DES_EXCEPCION',
      'MONTO_EST',
      'FECHA_MOD',
      'CARTEL_STAT',
      'CARTEL_NM',
      'FECHAH_APERTURA',
      'CODIGO_BPIP',
      'CLAS_OBJ',
      'COD_EXCEPCION',
    ],
    ...rows,
  ]),
});

const tenderRow = (
  sicop: string,
  pub: string,
  monto: string,
  extra: Partial<{ stat: string; nm: string; apertura: string }> = {},
) => [
  sicop,
  '3014042094',
  pub,
  `2024LD-${sicop}`,
  'LICITACION',
  'ORDINARIA',
  '',
  monto,
  '',
  extra.stat ?? 'Adjudicado',
  extra.nm ?? 'Compra de sillas',
  extra.apertura ?? '2024-01-20 09:00:00.0000000',
  '',
  'BIENES',
  '',
];

test('loads a flat archive and writes provenance on every row', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [TENDERS([tenderRow('20240001', '2024-01-05 10:00:00.0000000', '6780000')])],
    },
  });
  const d = db();
  const total = loadRange(d, { root });
  assert.equal(total.loaded, 1);
  const row = queryOne<Record<string, unknown>>(d, 'SELECT * FROM tender');
  assert.equal(row?.nro_sicop, '20240001');
  assert.equal(row?.source_month, '202401');
  assert.equal(row?.archive_stamp, '20240131T120000Z');
});

test('dates become ISO regardless of the published shape', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        TENDERS([
          tenderRow('A', '2024-01-05 10:00:00.0000000', '1'),
          tenderRow('B', '05-01-2024', '1'),
          tenderRow('C', '2024-01-07', '1'),
          tenderRow('D', 'not a date', '1'),
        ]),
      ],
    },
  });
  const d = db();
  loadRange(d, { root });
  const got = Object.fromEntries(
    query<{ nro_sicop: string; fecha_publicacion: string | null }>(
      d,
      'SELECT nro_sicop, fecha_publicacion FROM tender',
    ).map((r) => [r.nro_sicop, r.fecha_publicacion]),
  );
  assert.deepEqual(got, {
    A: '2024-01-05',
    B: '2024-01-05',
    C: '2024-01-07',
    D: null,
  });
});

test('a large integer survives intact and a comma decimal is read as a decimal', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        TENDERS([
          tenderRow('BIG', '2024-01-05', '6780000'),
          tenderRow('COMMA', '2024-01-05', '13144321,67'),
          tenderRow('TRAIL', '2024-01-05', '1500.000000'),
        ]),
      ],
    },
  });
  const d = db();
  loadRange(d, { root });
  const got = Object.fromEntries(
    query<{ nro_sicop: string; monto_est: number | null }>(
      d,
      'SELECT nro_sicop, monto_est FROM tender',
    ).map((r) => [r.nro_sicop, r.monto_est]),
  );
  // 678 instead of 6780000 is the failure mode this asserts against.
  assert.equal(got.BIG, 6780000);
  assert.equal(got.COMMA, 13144321.67);
  assert.equal(got.TRAIL, 1500);
});

test('columns are found by name, so a reordered header loads the same', () => {
  const straight = mirror({
    202401: { '20240131T120000Z': [TENDERS([tenderRow('X', '2024-01-05', '999')])] },
  });
  // The 2025-09 republication reordered nine tables. A positional reader would
  // put CARTEL_STAT into monto_est here and never say so.
  const shuffled = mirror({
    202401: {
      '20240131T120000Z': [
        {
          name: 'DetalleCarteles.csv',
          data: csv([
            ['MONTO_EST', 'CARTEL_NM', 'NRO_SICOP', 'CARTEL_STAT', 'FECHA_PUBLICACION'],
            ['999', 'Compra de sillas', 'X', 'Adjudicado', '2024-01-05'],
          ]),
        },
      ],
    },
  });
  const a = db();
  const b = db();
  loadRange(a, { root: straight });
  loadRange(b, { root: shuffled });
  const pick = 'SELECT nro_sicop, cartel_stat, cartel_nm, monto_est, fecha_publicacion FROM tender';
  assert.deepEqual(queryOne(a, pick), queryOne(b, pick));
});

test('a column the archive does not carry reads as null rather than failing', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        {
          name: 'LineasOfertadas.csv',
          // CODIGO_PRODUCTO_CL comes and goes across the mirror; TIPO_MONEDA is
          // dropped here to prove an absent mapped column is tolerated too.
          data: csv([
            ['NRO_SICOP', 'NRO_OFERTA', 'NRO_LINEA', 'CODIGO_PRODUCTO', 'CANTIDAD_OFERTADA'],
            ['S1', 'O1', '1', 'P1', '3'],
          ]),
        },
      ],
    },
  });
  const d = db();
  loadRange(d, { root });
  const row = queryOne<Record<string, unknown>>(d, 'SELECT * FROM bid_line');
  assert.equal(row?.cantidad, 3);
  assert.equal(row?.moneda, null);
  assert.equal(row?.precio_unitario, null);
});

test('the comma-delimited table is detected and loaded', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        {
          name: 'SancionProveedores.csv',
          data: csv(
            [
              [
                'NOMBRE_INSTITUCION',
                'CEDULA_INSTITUCION',
                'CODIGO_PRODUCTO',
                'CEDULA_PROVEEDOR',
                'TIPO_SANCION',
                'DESCR_SANCION',
                'INICIO_SANCION',
                'FINAL_SANCION',
                'ESTADO',
                'NO_RESOLUCION',
              ],
              [
                '"MUSEO NACIONAL"',
                '"3007075500"',
                '"5610153092385183"',
                '"0114340969"',
                '"Apercibimiento"',
                '"cerro; abrio, y siguio"',
                '11062024',
                '11122024',
                '"Firme"',
                '"R-1"',
              ],
            ],
            ',',
          ),
        },
      ],
    },
  });
  const d = db();
  loadRange(d, { root });
  const row = queryOne<Record<string, unknown>>(d, 'SELECT * FROM sanction');
  assert.equal(row?.cedula_proveedor, '0114340969');
  // A semicolon inside a quoted field must not be mistaken for a delimiter.
  assert.equal(row?.descr_sancion, 'cerro; abrio, y siguio');
  // DDMMYYYY with no separators, which is what this table publishes.
  assert.equal(row?.inicio_sancion, '2024-06-11');
  assert.equal(row?.final_sancion, '2024-12-11');
});

test('CSVs nested under YYYYMM inside the zip load like flat ones', () => {
  const flat = mirror({
    202401: { '20240131T120000Z': [TENDERS([tenderRow('N', '2024-01-05', '5')])] },
  });
  const nested = mirror({
    202401: {
      '20240131T120000Z': [
        { ...TENDERS([tenderRow('N', '2024-01-05', '5')]), name: '202401/DetalleCarteles.csv' },
      ],
    },
  });
  const a = db();
  const b = db();
  loadRange(a, { root: flat });
  loadRange(b, { root: nested });
  assert.deepEqual(queryOne(a, 'SELECT * FROM tender'), queryOne(b, 'SELECT * FROM tender'));
});

test('literal duplicate rows collapse to one', () => {
  const dup = ['S1', 'O1', '1', 'ACT1', '3101000001', 'P1', '2', '100', 'CRC'];
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        {
          name: 'LineasAdjudicadas.csv',
          data: csv([
            [
              'NRO_SICOP',
              'NRO_OFERTA',
              'NRO_LINEA',
              'NRO_ACTO',
              'CEDULA_PROVEEDOR',
              'CODIGO_PRODUCTO',
              'CANTIDAD_ADJUDICADA',
              'PRECIO_UNITARIO_ADJUDICADO',
              'TIPO_MONEDA',
            ],
            dup,
            dup,
            dup,
            ['S1', 'O1', '2', 'ACT1', '3101000001', 'P1', '1', '50', 'CRC'],
          ]),
        },
      ],
    },
  });
  const d = db();
  const total = loadRange(d, { root });
  assert.equal(total.read.award_line, 4);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM award_line')?.n, 2);
});

test('rows with a blank leading key are dropped and counted', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        TENDERS([tenderRow('OK', '2024-01-05', '1'), tenderRow('', '2024-01-05', '1')]),
      ],
    },
  });
  const d = db();
  const total = loadRange(d, { root });
  assert.equal(total.read.tender, 2);
  assert.equal(total.noKey, 1);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n, 1);
});

test('a second run skips what is already recorded, and force reloads it', () => {
  const root = mirror({
    202401: { '20240131T120000Z': [TENDERS([tenderRow('R', '2024-01-05', '1')])] },
  });
  const d = db();
  assert.equal(loadRange(d, { root }).loaded, 1);

  const again = loadRange(d, { root });
  assert.equal(again.loaded, 0);
  assert.equal(again.skipped, 1);

  const forced = loadRange(d, { root, force: true });
  assert.equal(forced.loaded, 1);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n, 1);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM loaded_archive')?.n, 1);
});

test('a month with two stored versions loads the later one', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [TENDERS([tenderRow('V', '2024-01-05', '100', { stat: 'En tramite' })])],
      '20240920T175819Z': [TENDERS([tenderRow('V', '2024-01-05', '100', { stat: 'Adjudicado' })])],
    },
  });
  assert.equal(archiveVersions('202401', root).length, 2);
  assert.equal(latestArchives({ root })[0].stamp, '20240920T175819Z');

  const d = db();
  loadRange(d, { root });
  const row = queryOne<Record<string, unknown>>(d, 'SELECT * FROM tender');
  assert.equal(row?.cartel_stat, 'Adjudicado');
  assert.equal(row?.archive_stamp, '20240920T175819Z');
});

test('an older month never overwrites what a later month published', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [TENDERS([tenderRow('P', '2024-01-05', '100', { stat: 'En tramite' })])],
    },
    202403: {
      '20240331T120000Z': [TENDERS([tenderRow('P', '2024-01-05', '100', { stat: 'Adjudicado' })])],
    },
  });

  const forward = db();
  loadRange(forward, { root });

  // Same archives, loaded newest first. The database must come out identical,
  // because months arrive out of order whenever a rewrite is picked up late.
  const backward = db();
  loadArchive(backward, latestArchives({ root })[1]);
  loadArchive(backward, latestArchives({ root })[0]);

  const pick = 'SELECT nro_sicop, cartel_stat, source_month FROM tender';
  assert.equal(queryOne<{ cartel_stat: string }>(forward, pick)?.cartel_stat, 'Adjudicado');
  assert.deepEqual(queryOne(forward, pick), queryOne(backward, pick));
});

test('the registry tables deduplicate across months instead of stacking up', () => {
  const supplier = (month: string, tamano: string): ZipInput => ({
    name: 'Proveedores.csv',
    data: csv([
      [
        'CEDULA_PROVEEDOR',
        'NOMBRE_PROVEEDOR',
        'TIPO_PROVEEDOR',
        'TAMAÑO_PROVEEDOR',
        'FECHA_CONSTITUCION',
        'zona_geo_prov',
      ],
      ['3101532708', 'COMUNICACION E IMAGEN', 'Nacional Juridico', tamano, '05032008', 'San Jose'],
    ]),
    method: month === '202401' ? 0 : 8, // stored and deflate must behave the same
  });
  const inhibition = (month: string): ZipInput => ({
    name: 'FuncionariosInhibicion.csv',
    data: csv([
      ['CED_INSTITUCION', 'CED_FUNCIONARIO', 'NOM_FUNCIONARIO', 'FECHA_INICIO', 'FECHA_FIN', 'ESTADO'],
      ['3014042094', '0105070110', 'ANA ROJAS', '2023-05-01 00:00:00.0000000', '2026-05-01', month],
    ]),
  });
  const root = mirror({
    202401: { '20240131T120000Z': [supplier('202401', 'Pequeña'), inhibition('202401')] },
    202402: { '20240229T120000Z': [supplier('202402', 'Mediana'), inhibition('202402')] },
  });
  const d = db();
  const total = loadRange(d, { root });
  assert.equal(total.read.supplier, 2);
  assert.equal(total.read.inhibition, 2);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM supplier')?.n, 1);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM inhibition')?.n, 1);
  // inhibition has no primary key in the schema, so the index this package adds
  // is the only thing keeping 189 republications of the same official apart.
  assert.equal(queryOne<{ estado: string }>(d, 'SELECT estado FROM inhibition')?.estado, '202402');
  assert.equal(queryOne<{ tamano: string }>(d, 'SELECT tamano FROM supplier')?.tamano, 'Mediana');
  assert.equal(
    queryOne<{ fecha_constitucion: string }>(d, 'SELECT fecha_constitucion FROM supplier')
      ?.fecha_constitucion,
    '2008-03-05',
  );
});

test('quoted fields spanning a CRLF newline load as one value', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        {
          name: 'DetalleCarteles.csv',
          data:
            'NRO_SICOP;CARTEL_NM;FECHA_PUBLICACION\r\n' +
            'Q;"linea uno\r\nlinea dos";2024-01-05\r\n',
        },
      ],
    },
  });
  const d = db();
  loadRange(d, { root });
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n, 1);
  assert.equal(
    queryOne<{ cartel_nm: string }>(d, 'SELECT cartel_nm FROM tender')?.cartel_nm,
    'linea uno\r\nlinea dos',
  );
});

test('the 447 MB table nobody needs is never inflated', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        TENDERS([tenderRow('S', '2024-01-05', '1')]),
        // Deflate-framed garbage. Reaching this entry at all would throw, so a
        // clean load proves the loader never touched it.
        {
          name: 'InvitacionProcedimiento.csv',
          data: 'NRO_SICOP;CEDULA_PROVEEDOR\r\n',
          corrupt: Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]),
        },
      ],
    },
  });
  const d = db();
  const total = loadRange(d, { root });
  assert.equal(total.loaded, 1);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n, 1);
});

test('a zero length CSV is skipped rather than throwing', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        TENDERS([tenderRow('Z', '2024-01-05', '1')]),
        { name: 'Proveedores.csv', data: '', method: 0 },
      ],
    },
  });
  const d = db();
  const total = loadRange(d, { root });
  assert.equal(total.loaded, 1);
  assert.equal(total.read.supplier, 0);
});

test('a failure part way through an archive leaves nothing behind', () => {
  const root = mirror({
    202401: {
      '20240131T120000Z': [
        TENDERS([tenderRow('T', '2024-01-05', '1')]),
        // Ofertas is read after DetalleCarteles, so tender rows are already in
        // the transaction when this one blows up.
        {
          name: 'Ofertas.csv',
          data: 'NRO_SICOP;NRO_OFERTA\r\n',
          corrupt: Buffer.from([0xff, 0xff, 0xff, 0xff]),
        },
      ],
    },
  });
  const d = db();
  assert.throws(() => loadRange(d, { root }));
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM tender')?.n, 0);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM loaded_archive')?.n, 0);
});

test('from and to bound the months loaded', () => {
  const root = mirror({
    202401: { '20240131T120000Z': [TENDERS([tenderRow('A', '2024-01-05', '1')])] },
    202402: { '20240229T120000Z': [TENDERS([tenderRow('B', '2024-02-05', '1')])] },
    202403: { '20240331T120000Z': [TENDERS([tenderRow('C', '2024-03-05', '1')])] },
  });
  const d = db();
  loadRange(d, { root, from: '202402', to: '202402' });
  assert.deepEqual(
    query<{ nro_sicop: string }>(d, 'SELECT nro_sicop FROM tender').map((r) => r.nro_sicop),
    ['B'],
  );
});

test('loaded_archive records the sha256 of the archive bytes', () => {
  const root = mirror({
    202401: { '20240131T120000Z': [TENDERS([tenderRow('H', '2024-01-05', '1')])] },
  });
  const d = db();
  const r = loadArchive(d, latestArchives({ root })[0]);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(
    queryOne<{ sha256: string }>(d, 'SELECT sha256 FROM loaded_archive')?.sha256,
    r.sha256,
  );
});

test('parseDate8 reads DDMMYYYY and refuses what is not a date', () => {
  assert.equal(parseDate8('05032008'), '2008-03-05');
  assert.equal(parseDate8('31122024'), '2024-12-31');
  assert.equal(parseDate8('2024-01-05 10:00:00.0000000'), '2024-01-05');
  assert.equal(parseDate8('05-03-2008'), '2008-03-05');
  assert.equal(parseDate8('No aplica'), null);
  assert.equal(parseDate8('32012024'), null); // day out of range
  assert.equal(parseDate8('01132024'), null); // month out of range
  assert.equal(parseDate8(''), null);
});
