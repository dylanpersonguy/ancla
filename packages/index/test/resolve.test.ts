import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { type Db, query, queryOne } from '../../core/src/db.ts';
import { openIndex } from '../src/load.ts';
import {
  type Actor,
  groupSuppliers,
  legalForm,
  normalizeName,
  registrySerial,
  resolve,
  serialCollisions,
} from '../src/resolve.ts';

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function db(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'ancla-resolve-'));
  temps.push(dir);
  return openIndex(join(dir, 'index.sqlite'));
}

function addSupplier(d: Db, cedula: string, nombre: string, month = '202406'): void {
  d.prepare(
    'INSERT OR REPLACE INTO supplier (cedula_proveedor, nombre, source_month) VALUES (?,?,?)',
  ).run(cedula, nombre, month);
}

function addBid(
  d: Db,
  sicop: string,
  oferta: string,
  cedula: string,
  consorcio = '',
  month = '202406',
): void {
  d.prepare(
    'INSERT OR REPLACE INTO bid (nro_sicop, nro_oferta, cedula_proveedor, id_consorcio,' +
      ' source_month, archive_stamp) VALUES (?,?,?,?,?,?)',
  ).run(sicop, oferta, cedula, consorcio, month, '20240630T120000Z');
}

const a = (cedula: string, nombre: string): Actor => ({ cedula, nombre });

// ---------------------------------------------------------------- normalizer

test('normalizeName strips accents, punctuation and case', () => {
  assert.equal(normalizeName('Compañía Ejemplo, S.A.'), 'COMPANIA EJEMPLO');
  assert.equal(normalizeName('COPPER AND TOOLS C.A.T. SOCIEDAD ANÓNIMA'), 'COPPER AND TOOLS CAT');
  assert.equal(normalizeName('  Doble   Espacio  Limitada '), 'DOBLE ESPACIO');
});

test('normalizeName unwinds stacked legal forms', () => {
  // Real name from the mirror: two legal forms on one company.
  assert.equal(
    normalizeName('THREE RIVERS SOFTWARE LLC, SOCIEDAD ANONIMA'),
    'THREE RIVERS SOFTWARE',
  );
  assert.equal(
    normalizeName('EATON ELECTRICAL  SOCIEDAD DE RESPONSABILIDAD LIMITADA'),
    'EATON ELECTRICAL',
  );
  assert.equal(
    normalizeName('GLOBAL HEALTH CHOICES SOCIEDAD RESPONSABILIDAD LIMITADA'),
    'GLOBAL HEALTH CHOICES',
  );
});

test('normalizeName keeps the distinguishing part of a name', () => {
  // SA is stripped as a legal form; SANTA is not, and must not be truncated.
  assert.equal(normalizeName('SANTA LUCIA SA'), 'SANTA LUCIA');
  assert.equal(normalizeName('SALUD INTEGRAL SOCIEDAD ANONIMA'), 'SALUD INTEGRAL');
});

test('normalizeName joins initials but not around a legal form', () => {
  assert.equal(normalizeName('GRUPO M & M NEGOCIOS'), 'GRUPO MM NEGOCIOS');
  // The trap: the legal form comes off before initials are joined, or C.A.T.
  // S.A. spells the invented word CATSA and matches nothing.
  assert.equal(normalizeName('COPPER AND TOOLS C.A.T. S.A.'), 'COPPER AND TOOLS CAT');
  assert.equal(normalizeName('CINCO E SOCIEDAD ANONIMA'), 'CINCO E');
  assert.equal(normalizeName('DATOS S R L'), 'DATOS');
});

test('a name that is only a legal form normalizes to nothing', () => {
  assert.equal(normalizeName('SOCIEDAD ANONIMA'), '');
  assert.equal(normalizeName(''), '');
  assert.equal(normalizeName(null), '');
});

test('registrySerial and legalForm read a Costa Rican company number', () => {
  assert.equal(registrySerial('3101517780'), '517780');
  assert.equal(legalForm('3101517780'), '101');
  assert.equal(legalForm('3102517780'), '102');
  assert.equal(registrySerial('0105070110'), null); // natural person
  assert.equal(registrySerial('9000017131'), null); // foreign company
  assert.equal(registrySerial('155835439032'), null); // DIMEX
  assert.equal(registrySerial(''), null);
});

// ------------------------------------------------------------------- merging

test('merges a legal form conversion: same registry serial, same name', () => {
  const { groups } = groupSuppliers([
    a('3101517780', 'THREE RIVERS SOFTWARE LLC, SOCIEDAD ANONIMA'),
    a('3102517780', 'THREE RIVERS SOFTWARE LIMITADA'),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].members.map((m) => m.cedula),
    ['3101517780', '3102517780'],
  );
  assert.equal(groups[0].evidence.rule, 'shared-registry-serial-and-name');
  assert.equal(groups[0].evidence.registry_serial, '517780');
});

test('refuses to merge two cedulas that share a serial but not a name', () => {
  // Both of these are in the mirror under serial 192375.
  const actors = [
    a('3101192375', 'SOL JUPITER Y VENUS PRODUCCIONES SOCIEDAD ANONIMA'),
    a('3102192375', 'GRUPO CORPORATIVO AR PUNTO COM SOCIEDAD DE RESPONSABILIDAD LIMITADA'),
  ];
  assert.deepEqual(groupSuppliers(actors).groups, []);
  const flagged = serialCollisions(actors);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].reason, 'serial-shared-names-differ');
  assert.equal(flagged[0].key, '192375');
});

test('refuses to merge two cedulas that share a name but not a serial', () => {
  // CONTIMACA DE COSTA RICA S.A. exists twice. One group or two companies is not
  // something this data can say, so they stay apart.
  const { groups, rejected } = groupSuppliers([
    a('3101349484', 'CONTIMACA DE COSTA RICA SOCIEDAD ANONIMA'),
    a('3101474385', 'CONTIMACA DE COSTA RICA SOCIEDAD ANONIMA'),
  ]);
  assert.deepEqual(groups, []);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason, 'name-shared-serials-differ');
  assert.deepEqual(rejected[0].cedulas, ['3101349484', '3101474385']);
});

test('never merges natural persons who share a name', () => {
  // Two different people, both JORGE BOLANOS GONZALEZ, both in the mirror.
  const { groups } = groupSuppliers([
    a('0105070110', 'JORGE BOLANOS GONZALEZ'),
    a('0400950494', 'JORGE BOLANOS GONZALEZ'),
  ]);
  assert.deepEqual(groups, []);
});

test('never merges a person into a company that carries their name', () => {
  const { groups } = groupSuppliers([
    a('3101067023', 'JORGE BOLANOS GONZALEZ SOCIEDAD ANONIMA'),
    a('0105070110', 'JORGE BOLANOS GONZALEZ'),
  ]);
  assert.deepEqual(groups, []);
});

test('never merges a DIMEX holder into a national cedula with the same name', () => {
  const { groups } = groupSuppliers([
    a('132000175833', 'EDSON ABRAHAM DUARTE SOTO'),
    a('0801580474', 'EDSON ABRAHAM DUARTE SOTO'),
  ]);
  assert.deepEqual(groups, []);
});

test('never merges foreign companies, which have no registry serial', () => {
  const { groups } = groupSuppliers([
    a('9000017410', 'SPC INTERNACIONAL SOCIEDAD ANONIMA'),
    a('9000021385', 'SPC INTERNACIONAL SOCIEDAD ANONIMA'),
  ]);
  assert.deepEqual(groups, []);
});

test('never merges on a name that is nothing but a legal form', () => {
  const { groups } = groupSuppliers([
    a('3101111111', 'SOCIEDAD ANONIMA'),
    a('3102111111', 'SOCIEDAD ANONIMA'),
  ]);
  assert.deepEqual(groups, []);
});

test('a shared serial across three legal forms merges into one group', () => {
  const { groups } = groupSuppliers([
    a('3102177137', 'GUTIERREZ MARIN Y ASOCIADOS LIMITADA'),
    a('3108177137', 'GUTIERREZ MARIN Y ASOCIADOS SOCIEDAD DE ACTIVIDADES PROFESIONALES'),
    a('3101177137', 'RSM COSTA RICA AUDIT TAX AND CONSULTING SERVICES SOCIEDAD ANONIMA'),
  ]);
  // Only the two that agree on a name; the third keeps its own identity.
  assert.equal(groups.length, 1);
  assert.deepEqual(
    groups[0].members.map((m) => m.cedula),
    ['3102177137', '3108177137'],
  );
});

test('grouping does not depend on input order', () => {
  const pair = [
    a('3102632632', 'OUTSOURCE EMPRESARIAL SOCIEDAD DE RESPONSABILIDAD LIMITADA'),
    a('3101632632', 'OUTSOURCE EMPRESARIAL SOCIEDAD ANONIMA'),
  ];
  const forward = groupSuppliers(pair);
  const backward = groupSuppliers([...pair].reverse());
  assert.deepEqual(forward.groups, backward.groups);
  assert.equal(forward.groups[0].entityId, 'group:3101632632');
});

test('a thousand distinct companies produce no groups at all', () => {
  const actors = Array.from({ length: 1000 }, (_, i) =>
    a(`3101${String(100000 + i)}`, `EMPRESA NUMERO ${i} SOCIEDAD ANONIMA`),
  );
  assert.deepEqual(groupSuppliers(actors).groups, []);
});

// ------------------------------------------------------------ against the db

test('consortium members become one actor, and keep their own', () => {
  const d = db();
  addSupplier(d, '3101000001', 'ALFA SOCIEDAD ANONIMA');
  addSupplier(d, '3101000002', 'BETA SOCIEDAD ANONIMA');
  addBid(d, 'S1', 'O1', '3101000001', '1201600044');
  addBid(d, 'S1', 'O2', '3101000002', '1201600044');
  addBid(d, 'S2', 'O3', '3101000001', ''); // same company bidding alone

  const stats = resolve(d);
  assert.equal(stats.consortia, 1);
  assert.equal(stats.suppliers, 2);

  const consortium = queryOne<{ entity_id: string; member_count: number; evidence: string }>(
    d,
    "SELECT * FROM entity WHERE kind = 'consortium'",
  );
  assert.equal(consortium?.entity_id, 'consorcio:1201600044');
  assert.equal(consortium?.member_count, 2);
  assert.equal(JSON.parse(consortium?.evidence ?? '{}').rule, 'shared-id-consorcio');

  // Additive, not replacing: the member is still its own actor.
  const owned = query<{ entity_id: string; kind: string }>(
    d,
    `SELECT e.entity_id, e.kind FROM entity_member m JOIN entity e USING (entity_id)
     WHERE m.cedula_proveedor = '3101000001' ORDER BY e.kind`,
  );
  assert.deepEqual(
    owned.map((r) => r.kind),
    ['consortium', 'supplier'],
  );
});

test('every cedula has exactly one owning actor once groups are applied', () => {
  const d = db();
  addSupplier(d, '3101517780', 'THREE RIVERS SOFTWARE LLC, SOCIEDAD ANONIMA');
  addSupplier(d, '3102517780', 'THREE RIVERS SOFTWARE LIMITADA');
  addSupplier(d, '3101349484', 'CONTIMACA DE COSTA RICA SOCIEDAD ANONIMA');
  addSupplier(d, '3101474385', 'CONTIMACA DE COSTA RICA SOCIEDAD ANONIMA');
  addBid(d, 'S1', 'O1', '3101517780', '1201600044');

  resolve(d);
  const dupes = query<{ cedula_proveedor: string; n: number }>(
    d,
    `SELECT m.cedula_proveedor, COUNT(*) AS n FROM entity_member m JOIN entity e USING (entity_id)
     WHERE e.kind <> 'consortium' GROUP BY m.cedula_proveedor HAVING n > 1`,
  );
  assert.deepEqual(dupes, []);

  // The merged pair resolves to one group; the refused pair stays as two.
  const kindOf = (c: string) =>
    queryOne<{ kind: string; entity_id: string }>(
      d,
      `SELECT e.kind, e.entity_id FROM entity_member m JOIN entity e USING (entity_id)
       WHERE m.cedula_proveedor = ? AND e.kind <> 'consortium'`,
      [c],
    );
  assert.equal(kindOf('3101517780')?.kind, 'group');
  assert.equal(kindOf('3102517780')?.entity_id, kindOf('3101517780')?.entity_id);
  assert.equal(kindOf('3101349484')?.kind, 'supplier');
  assert.notEqual(kindOf('3101349484')?.entity_id, kindOf('3101474385')?.entity_id);
});

test('a bidder the supplier registry never listed still gets an entity', () => {
  const d = db();
  // Seven months publish Proveedores.csv empty. Actors are taken from what they
  // did, not from whether the registry happened to list them.
  addBid(d, 'S1', 'O1', '3101999999');
  const stats = resolve(d);
  assert.equal(stats.actors, 1);
  assert.equal(
    queryOne<{ kind: string }>(d, "SELECT kind FROM entity WHERE kind = 'supplier'")?.kind,
    'supplier',
  );
});

test('resolve is idempotent and rebuilds rather than accumulates', () => {
  const d = db();
  addSupplier(d, '3101517780', 'THREE RIVERS SOFTWARE SOCIEDAD ANONIMA');
  addSupplier(d, '3102517780', 'THREE RIVERS SOFTWARE LIMITADA');
  addBid(d, 'S1', 'O1', '3101517780', 'C1');
  addBid(d, 'S1', 'O2', '3101000009', 'C1');

  const first = resolve(d);
  const snapshot = () => ({
    entities: query(d, 'SELECT * FROM entity ORDER BY entity_id'),
    members: query(d, 'SELECT * FROM entity_member ORDER BY entity_id, cedula_proveedor'),
  });
  const before = snapshot();
  const second = resolve(d);
  assert.deepEqual(second, first);
  assert.deepEqual(snapshot(), before);
});

test('a merge carries its reason, and the reason names both cedulas', () => {
  const d = db();
  addSupplier(d, '3101632632', 'OUTSOURCE EMPRESARIAL SOCIEDAD ANONIMA');
  addSupplier(d, '3102632632', 'OUTSOURCE EMPRESARIAL SOCIEDAD DE RESPONSABILIDAD LIMITADA');
  resolve(d);
  const g = queryOne<{ evidence: string; member_count: number; canonical_name: string }>(
    d,
    "SELECT * FROM entity WHERE kind = 'group'",
  );
  const ev = JSON.parse(g?.evidence ?? '{}');
  assert.equal(ev.rule, 'shared-registry-serial-and-name');
  assert.equal(ev.normalized_name, 'OUTSOURCE EMPRESARIAL');
  assert.deepEqual(
    ev.members.map((m: { cedula: string; legal_form: string }) => [m.cedula, m.legal_form]),
    [
      ['3101632632', '101'],
      ['3102632632', '102'],
    ],
  );
  assert.equal(g?.member_count, 2);
  assert.equal(g?.canonical_name, 'OUTSOURCE EMPRESARIAL SOCIEDAD DE RESPONSABILIDAD LIMITADA');
});

test('an empty index resolves to nothing without failing', () => {
  const d = db();
  const stats = resolve(d);
  assert.equal(stats.actors, 0);
  assert.equal(stats.entities, 0);
  assert.equal(queryOne<{ n: number }>(d, 'SELECT COUNT(*) AS n FROM entity')?.n, 0);
});
