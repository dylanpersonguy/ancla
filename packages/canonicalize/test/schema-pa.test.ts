import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { PANAMA_TABLES } from '../src/schema-pa.ts';
import { buildSnapshot } from '../src/snapshot.ts';
import { TABLES, tableDef } from '../src/schema.ts';

test('a schema is chosen, not global', () => {
  // Costa Rica stays the default so every existing caller is unaffected.
  assert.ok(tableDef('Contratos'));
  assert.equal(tableDef('com_awards'), null, 'CR schema must not know Panama tables');
  assert.ok(tableDef('com_awards', PANAMA_TABLES));
  assert.equal(tableDef('Contratos', PANAMA_TABLES), null);
});

test('the two tables that cannot be keyed are left out deliberately', () => {
  // com_contracts emits 116 literal duplicate rows and com_con_imp_documents has
  // no document id at all. Declaring a key for either would invent identity for
  // rows that have none; both are meant to reach content addressing.
  assert.equal(PANAMA_TABLES.com_contracts, undefined);
  assert.equal(PANAMA_TABLES.com_con_imp_documents, undefined);
});

test('every Panama key begins with ocid', () => {
  // ocid is the contracting process. A key without it is only unique inside one
  // process and collides across the file the moment two processes share an id.
  for (const [name, def] of Object.entries(PANAMA_TABLES)) {
    assert.equal(def.key[0], 'ocid', `${name} must be scoped by ocid`);
  }
});

test('the two schemas share no table names', () => {
  const overlap = Object.keys(TABLES).filter((t) => t in PANAMA_TABLES);
  assert.deepEqual(overlap, [], 'a shared name would canonicalize under the wrong keys');
});

const ARCHIVES = join(
  process.env.ANCLA_DATA ?? join(process.env.HOME ?? '.', 'ancla-data'),
  'sources/pa-panamacompra/archives/202607',
);
const zip = existsSync(ARCHIVES)
  ? readdirSync(ARCHIVES)
      .filter((f) => f.endsWith('.zip'))
      .map((f) => join(ARCHIVES, f))[0]
  : undefined;

test('the keys hold against the real archive', { skip: !zip }, () => {
  const snap = buildSnapshot('202607', readFileSync(zip as string), PANAMA_TABLES);
  for (const t of snap.tables) {
    if (PANAMA_TABLES[t.table]) {
      // One record per row is the whole claim: a collision would silently merge
      // two rows into one identity and hide a change between them.
      assert.equal(t.records, t.rows, `${t.table} lost rows to key collisions`);
      assert.equal(t.duplicateKeys, 0, `${t.table} had duplicate keys`);
      assert.equal(t.contentAddressed, false, `${t.table} fell back to content addressing`);
    } else {
      assert.equal(t.contentAddressed, true, `${t.table} should be content addressed`);
    }
  }
  assert.equal(snap.tables.length, 19);
  assert.match(snap.merkleRoot, /^[0-9a-f]{64}$/);
});
