import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as manifest from '../src/manifest.ts';
import { OBSERVATORIO } from '../src/observatorio.ts';
import { PANAMACOMPRA } from '../src/panamacompra.ts';
import { SOURCES, resolveSource } from '../src/sources.ts';

test('aliases resolve, and the default is Costa Rica', () => {
  assert.equal(resolveSource().id, 'cr-observatorio');
  assert.equal(resolveSource('cr').id, 'cr-observatorio');
  assert.equal(resolveSource('pa').id, 'pa-panamacompra');
  assert.equal(resolveSource('pa-panamacompra').id, 'pa-panamacompra');
});

test('an unknown source names the known ones rather than falling back', () => {
  // Falling back to Costa Rica would silently mirror the wrong country.
  assert.throws(() => resolveSource('gt'), /unknown source "gt"/);
});

test('source ids are unique', () => {
  const ids = SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('Costa Rica keeps the legacy paths its 189 archives already use', () => {
  process.env.ANCLA_DATA = '/tmp/ancla-test-root';
  assert.equal(manifest.sourceRoot(OBSERVATORIO), '/tmp/ancla-test-root');
  assert.equal(manifest.manifestPath(OBSERVATORIO), '/tmp/ancla-test-root/manifest.jsonl');
  assert.equal(manifest.archivesRoot(OBSERVATORIO), '/tmp/ancla-test-root/archives');
});

test('every later source is namespaced under its own id', () => {
  process.env.ANCLA_DATA = '/tmp/ancla-test-root';
  const root = join('/tmp/ancla-test-root', 'sources', 'pa-panamacompra');
  assert.equal(manifest.sourceRoot(PANAMACOMPRA), root);
  assert.equal(manifest.manifestPath(PANAMACOMPRA), join(root, 'manifest.jsonl'));
  assert.notEqual(manifest.archivesRoot(PANAMACOMPRA), manifest.archivesRoot(OBSERVATORIO));
});
