/**
 * CLI smoke tests.
 *
 * These run the real binary against a temporary index on disk, because the
 * failure this guards against is not a wrong statistic. It is the command
 * throwing on an empty table, or printing a confident zero where it should be
 * saying there is no data. Both would have shipped without this file.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb } from '../../core/src/db.ts';
import { insertInstitution, insertStage, insertSupplier, tenderWithBidders } from './fixture.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'src', 'cli.ts');
const workdir = mkdtempSync(join(tmpdir(), 'ancla-analytics-'));

after(() => rmSync(workdir, { recursive: true, force: true }));

interface Run {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** An index with enough shape for every subcommand to have something to say. */
function populated(): string {
  const path = join(workdir, 'populated.sqlite');
  const db = openDb(path);
  insertInstitution(db, 'INSTA', 'Ministerio de Prueba');
  insertSupplier(db, 'SA', 'Proveedor Uno S.A.');
  insertSupplier(db, 'SB', 'Proveedor Dos S.A.');
  for (let i = 0; i < 40; i++) {
    const solo = i % 4 === 0;
    tenderWithBidders(db, {
      nroSicop: `T${i}`,
      institucion: 'INSTA',
      fecha: '2025-12-05',
      bidders: solo ? ['SA'] : ['SA', 'SB'],
      winner: i % 3 === 0 ? 'SB' : 'SA',
      prices: solo ? { SA: 1000 } : { SA: 1000 + i, SB: 1200 + i },
      codigo: 'PROD-A',
      estado: 'Contrato',
    });
    insertStage(db, {
      nroSicop: `T${i}`,
      publicacion: '2025-12-05',
      adjudicacionFirme: i % 2 === 0 ? '2025-12-25' : null,
    });
  }
  db.close();
  return path;
}

/** A schema with every table present and empty, which is the mid-ingest state. */
function empty(): string {
  const path = join(workdir, 'empty.sqlite');
  openDb(path).close();
  return path;
}

const POPULATED = populated();
const EMPTY = empty();

const COMMANDS: { name: string; args: string[] }[] = [
  { name: 'competition', args: ['competition'] },
  { name: 'duration', args: ['duration'] },
  { name: 'prices', args: ['prices', '--min-sample', '10'] },
  { name: 'prices --code', args: ['prices', '--code', 'PROD-A', '--min-sample', '10'] },
  { name: 'collusion', args: ['collusion'] },
  { name: 'supplier', args: ['supplier', '--supplier', 'SA'] },
  { name: 'institution', args: ['institution', '--institution', 'INSTA'] },
  { name: 'rank', args: ['rank', '--metric', 'single_bidder_rate', '--min-sample', '10'] },
];

for (const { name, args } of COMMANDS) {
  test(`${name} runs against a populated index`, () => {
    const r = run([...args, '--db', POPULATED]);
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    assert.ok(r.stdout.length > 0, 'produced no output');
  });

  test(`${name} degrades cleanly on an index with empty tables`, () => {
    const r = run([...args, '--db', EMPTY]);
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
  });

  test(`${name} emits valid json`, () => {
    const r = run([...args, '--db', POPULATED, '--json']);
    assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed, 'object');
  });
}

test('competition prints the figures with their denominators', () => {
  const r = run(['competition', '--db', POPULATED]);
  // 10 of 40 tenders had exactly one bidder.
  assert.match(r.stdout, /10 of 40 tenders that received bids had exactly one bidder: 25\.0%/);
  assert.match(r.stdout, /95% interval/);
  assert.match(r.stdout, /a bidder is a distinct cedula_proveedor, not a distinct offer/);
});

test('duration prints the censoring counts next to the median', () => {
  const r = run(['duration', '--db', POPULATED]);
  assert.match(r.stdout, /observation date/);
  assert.match(r.stdout, /still running/);
  assert.match(r.stdout, /unfinished/);
});

test('collusion prints the indicator disclaimer above the tables', () => {
  const r = run(['collusion', '--db', POPULATED]);
  assert.match(r.stdout, /These are screens, not findings/);
  const disclaimerAt = r.stdout.indexOf('These are screens, not findings');
  const firstTableAt = r.stdout.indexOf('bid-rotation');
  assert.ok(disclaimerAt >= 0 && disclaimerAt < firstTableAt, 'disclaimer must come first');
});

test('prices prints the unit-of-measure caveat', () => {
  const r = run(['prices', '--code', 'PROD-A', '--db', POPULATED, '--min-sample', '10']);
  // The caveat is wrapped for the terminal, so match it across the line break.
  assert.match(r.stdout.replace(/\s+/g, ' '), /never publishes the unit of measure/);
});

test('a missing index file is an error with a next step, not a stack trace', () => {
  const r = run(['competition', '--db', join(workdir, 'does-not-exist.sqlite')]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No index at/);
  assert.match(r.stderr, /build it first/);
  assert.equal(r.stdout, '');
});

test('no arguments prints usage and a non-zero status', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /ancla analytics/);
});

test('an unknown command is rejected', () => {
  const r = run(['nonsense', '--db', POPULATED]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown command nonsense/);
});

test('an unknown flag is rejected before anything opens the database', () => {
  const r = run(['competition', '--not-a-flag']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown flag --not-a-flag/);
});

test('supplier requires the supplier it is meant to profile', () => {
  const r = run(['supplier', '--db', POPULATED]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires --supplier/);
});
