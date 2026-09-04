import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CANON_VERSION,
  canonicalNumber,
  canonicalizeTable,
  detectDelimiter,
  parseCsv,
} from '../src/canonical.ts';
import { tableNameOf } from '../src/zip.ts';

const csv = (s: string) => Buffer.from(s, 'utf8');
const rows = (s: string, d = 0x3b) => [...parseCsv(csv(s), d)];

test('parses semicolon rows with CRLF endings', () => {
  assert.deepEqual(rows('A;B\r\n1;2\r\n'), [
    ['A', 'B'],
    ['1', '2'],
  ]);
});

test('parses quoted fields containing the delimiter', () => {
  assert.deepEqual(rows('A;B\r\n"x;y";2\r\n')[1], ['x;y', '2']);
});

test('parses escaped quotes inside quoted fields', () => {
  assert.deepEqual(rows('A\r\n"he said ""hi"""\r\n')[1], ['he said "hi"']);
});

test('parses a quoted field containing a newline', () => {
  const r = rows('A;B\r\n"line1\nline2";2\r\n');
  assert.equal(r.length, 2);
  assert.equal(r[1][0], 'line1\nline2');
});

test('keeps empty trailing fields', () => {
  assert.deepEqual(rows('A;B;C\r\n1;;\r\n')[1], ['1', '', '']);
});

test('handles a final row with no trailing newline', () => {
  assert.deepEqual(rows('A;B\r\n1;2')[1], ['1', '2']);
});

test('detects the comma delimiter used by SancionProveedores', () => {
  assert.equal(detectDelimiter(csv('A,B,C\r\n1,2,3\r\n')), 0x2c);
  assert.equal(detectDelimiter(csv('A;B;C\r\n1;2;3\r\n')), 0x3b);
});

test('canonicalNumber normalizes without corrupting integers', () => {
  // The bug that produced 40,845 phantom mismatches: rstrip made 6780000 into 678.
  assert.equal(canonicalNumber('6780000'), '6780000');
  assert.equal(canonicalNumber('1.000'), '1');
  assert.equal(canonicalNumber('2619.470000'), '2619.47');
  assert.equal(canonicalNumber('0.000'), '0');
  assert.equal(canonicalNumber('-0.000'), '0');
  assert.equal(canonicalNumber('-0.500'), '-0.5');
  assert.equal(canonicalNumber('007'), '7');
  assert.equal(canonicalNumber('1,5'), '1.5');
  assert.equal(canonicalNumber('not a number'), null);
  assert.equal(canonicalNumber(''), null);
});

const SAMPLE =
  'NRO_SICOP;NRO_OFERTA;NRO_LINEA;CANTIDAD_OFERTADA\r\n' +
  'S1;O1;1;1.000\r\n' +
  'S1;O1;2;250.500\r\n' +
  'S2;O9;1;3\r\n';

test('canonicalization is deterministic for identical input', () => {
  const a = canonicalizeTable('LineasOfertadas', csv(SAMPLE));
  const b = canonicalizeTable('LineasOfertadas', csv(SAMPLE));
  assert.deepEqual(
    a.records.map((r) => r.byteHash),
    b.records.map((r) => r.byteHash),
  );
});

test('the declared composite key becomes the record id', () => {
  const r = canonicalizeTable('LineasOfertadas', csv(SAMPLE));
  assert.deepEqual(
    r.records.map((x) => x.id),
    ['S1|O1|1', 'S1|O1|2', 'S2|O9|1'],
  );
  assert.equal(r.contentAddressed, false);
});

test('reformatting a number moves the byte hash but not the value hash', () => {
  const before = canonicalizeTable('LineasOfertadas', csv(SAMPLE));
  const after = canonicalizeTable(
    'LineasOfertadas',
    csv(SAMPLE.replace('1.000', '1').replace('250.500', '250.5')),
  );
  assert.notEqual(before.records[0].byteHash, after.records[0].byteHash);
  assert.equal(before.records[0].valueHash, after.records[0].valueHash);
});

test('changing a value moves both hashes', () => {
  const before = canonicalizeTable('LineasOfertadas', csv(SAMPLE));
  const after = canonicalizeTable('LineasOfertadas', csv(SAMPLE.replace(';1.000', ';2.000')));
  assert.notEqual(before.records[0].byteHash, after.records[0].byteHash);
  assert.notEqual(before.records[0].valueHash, after.records[0].valueHash);
});

test('a volatile field is excluded from the value hash but not the byte hash', () => {
  const base = 'CEDULA;NOMBRE_INSTITUCION;FECHA_MOD\r\nC1;Inst;2026-01-01\r\n';
  const later = 'CEDULA;NOMBRE_INSTITUCION;FECHA_MOD\r\nC1;Inst;2026-08-01\r\n';
  const a = canonicalizeTable('InstitucionesRegistradas', csv(base));
  const b = canonicalizeTable('InstitucionesRegistradas', csv(later));
  assert.notEqual(a.records[0].byteHash, b.records[0].byteHash);
  assert.equal(a.records[0].valueHash, b.records[0].valueHash);
});

test('literal duplicate rows stay individually addressable', () => {
  const dup = 'NRO_SICOP;EVAL_ITEM_SEQNO;FACTOR_EVAL\r\nS1;1;x\r\nS1;1;x\r\nS1;1;x\r\n';
  const r = canonicalizeTable('SistemaEvaluacionOfertas', csv(dup));
  assert.equal(r.records.length, 3);
  assert.equal(new Set(r.records.map((x) => x.id)).size, 3, 'ids must be distinct');
  assert.ok(r.contentAddressed);
});

test('duplicate-row identity does not depend on row order', () => {
  const a = canonicalizeTable(
    'SistemaEvaluacionOfertas',
    csv('NRO_SICOP;EVAL_ITEM_SEQNO;FACTOR_EVAL\r\nS1;1;x\r\nS1;1;y\r\nS1;1;x\r\n'),
  );
  const b = canonicalizeTable(
    'SistemaEvaluacionOfertas',
    csv('NRO_SICOP;EVAL_ITEM_SEQNO;FACTOR_EVAL\r\nS1;1;x\r\nS1;1;x\r\nS1;1;y\r\n'),
  );
  assert.deepEqual(
    a.records.map((r) => r.byteHash).sort(),
    b.records.map((r) => r.byteHash).sort(),
  );
});

test('an unknown table still canonicalizes, content addressed', () => {
  const r = canonicalizeTable('SomeNewTable', csv('A;B\r\n1;2\r\n'));
  assert.equal(r.records.length, 1);
  assert.ok(r.contentAddressed);
  assert.ok(r.records[0].id.startsWith('sha256:'));
});

test('the schema fingerprint moves when a column is added', () => {
  const a = canonicalizeTable('Ofertas', csv('NRO_SICOP;NRO_OFERTA\r\nS1;O1\r\n'));
  const b = canonicalizeTable('Ofertas', csv('NRO_SICOP;NRO_OFERTA;NUEVO\r\nS1;O1;z\r\n'));
  assert.notEqual(a.schema, b.schema);
});

test('the canonicalizer version is pinned', () => {
  // Changing this invalidates every prior anchor. It must be a deliberate act.
  // Moved to v2 on 2026-09-03 with the tolerant quote rule below.
  assert.equal(CANON_VERSION, 'ancla-canon-2');
});

test('an unescaped inch mark does not swallow the rest of the file', () => {
  // The publisher writes RACK DE 19" inside a quoted field without escaping it.
  // A strict reader closes the field there, desynchronises, and merges every
  // following row into one. In 202608 that lost 3,820 rows of Sistemas alone.
  const csv = Buffer.from(
    'NRO;DESC;COD\r\n' +
      '1;"GABINETE PARA RACK DE 19" (482,6 mm), COLOR NEGRO";A\r\n' +
      '2;"SEGUNDA FILA";B\r\n' +
      '3;"RESPALDO DE 2.4", MECANISMO RÁPIDO";C\r\n' +
      '4;"CUARTA FILA";D\r\n',
    'utf8',
  );
  const rows = [...parseCsv(csv, 0x3b)];
  assert.equal(rows.length, 5, 'header plus four rows must survive');
  assert.deepEqual(rows[1], ['1', 'GABINETE PARA RACK DE 19" (482,6 mm), COLOR NEGRO', 'A']);
  assert.deepEqual(rows[2], ['2', 'SEGUNDA FILA', 'B']);
  assert.deepEqual(rows[3], ['3', 'RESPALDO DE 2.4", MECANISMO RÁPIDO', 'C']);
  assert.deepEqual(rows[4], ['4', 'CUARTA FILA', 'D']);
});

test('a quoted title with quoted words inside it stays one field', () => {
  // ARTE "BÁRBARO" Y PRERROMÁNICO, from a real book listing in Sistemas.
  const csv = Buffer.from('A;B\r\n1;"ARTE "BÁRBARO" Y PRERROMÁNICO"\r\n2;"x"\r\n', 'utf8');
  const rows = [...parseCsv(csv, 0x3b)];
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['1', 'ARTE "BÁRBARO" Y PRERROMÁNICO']);
});

test('properly escaped quotes are still unescaped, not doubled up', () => {
  // The tolerant rule must not break RFC 4180 input, which is most of the mirror.
  const csv = Buffer.from('A;B\r\n1;"he said ""hello"" twice"\r\n', 'utf8');
  assert.deepEqual([...parseCsv(csv, 0x3b)][1], ['1', 'he said "hello" twice']);
});

test('a quote before a delimiter still closes the field', () => {
  // The whole rule turns on what follows the quote, so the ordinary case needs
  // pinning as hard as the awkward one.
  const csv = Buffer.from('A;B;C\r\n"x";"y";"z"\r\n', 'utf8');
  assert.deepEqual([...parseCsv(csv, 0x3b)][1], ['x', 'y', 'z']);
});

test('a quoted field may still contain a real line break', () => {
  const csv = Buffer.from('A;B\r\n1;"line one\r\nline two"\r\n2;"z"\r\n', 'utf8');
  const rows = [...parseCsv(csv, 0x3b)];
  assert.equal(rows.length, 3);
  assert.equal(rows[1]?.[1], 'line one\r\nline two');
});

test('zip layout does not affect the table name', () => {
  // The 2024-09-20 republication nested CSVs under YYYYMM/; others are flat.
  assert.equal(tableNameOf('202401/Contratos.csv'), 'Contratos');
  assert.equal(tableNameOf('Contratos.csv'), 'Contratos');
  assert.equal(tableNameOf('notes.txt'), null);
});
