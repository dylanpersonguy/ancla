/**
 * A stored archive is never replaced. That is the claim the whole project rests
 * on, so it is tested against a real HTTP server writing to a real directory
 * rather than asserted in a comment.
 *
 * The failure this guards against is quiet. `rename` over an existing path
 * succeeds, reports success, and destroys the only copy of what the publisher
 * served last week. Nothing downstream would notice: the manifest would say
 * "stored", the snapshot would rebuild, and the diff would compare the new file
 * against itself.
 */

import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { mirrorPeriod } from '../src/mirror.ts';
import type { Source } from '../src/source.ts';
import { currentMonth, monthClosesAt, monthRange } from '../src/source.ts';

let server: Server;
let port = 0;
let root = '';

/** What the server is currently serving, and when it says it was written. */
let body = 'first copy';
let lastModified = 'Mon, 01 Jun 2026 00:00:00 GMT';

const SOURCE: Source = {
  id: 'test-immutable',
  country: 'CR',
  label: 'test',
  granularity: 'month',
  firstPeriod: '202601',
  extension: 'zip',
  periodRange: (from, to) => monthRange(from, to),
  currentPeriod: (now) => currentMonth(now),
  url: () => `http://127.0.0.1:${port}/archive.zip`,
  head: async (period) => ({
    period,
    exists: true,
    status: 200,
    lastModified,
    contentLength: Buffer.byteLength(body),
  }),
  closesAt: (period) => monthClosesAt(period),
};

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'ancla-immutable-'));
  process.env.ANCLA_DATA = root;
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip', 'last-modified': lastModified });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const dir = () => join(root, 'sources', 'test-immutable', 'archives', '202605');

test('the first fetch stores a copy named for its stamp and its hash', async () => {
  const out = await mirrorPeriod(SOURCE, '202605', { concurrency: 1, force: false });
  assert.equal(out.status, 'stored');
  const files = await readdir(dir());
  assert.equal(files.length, 1);
  assert.match(files[0] as string, /^20260601T000000Z-[0-9a-f]{12}\.zip$/);
});

test('a second look at the same copy stores nothing new', async () => {
  const out = await mirrorPeriod(SOURCE, '202605', { concurrency: 1, force: false });
  assert.equal(out.status, 'unchanged');
  assert.equal((await readdir(dir())).length, 1);
});

test('--force re-downloads and still does not replace the file it holds', async () => {
  // The bytes are identical, so the name collides. The stored copy must be the
  // one that was there first, untouched, not a fresh write that happens to match.
  const before = await stat(join(dir(), (await readdir(dir()))[0] as string));
  const out = await mirrorPeriod(SOURCE, '202605', { concurrency: 1, force: true });
  assert.equal(out.status, 'unchanged');
  const files = await readdir(dir());
  assert.equal(files.length, 1);
  const now = await stat(join(dir(), files[0] as string));
  assert.equal(now.ino, before.ino, 'the original inode must survive a forced refetch');
  assert.equal(now.birthtimeMs, before.birthtimeMs);
});

test('a rewrite lands beside its predecessor, and the predecessor still reads', async () => {
  body = 'second copy, rewritten after the month closed';
  lastModified = 'Wed, 10 Sep 2026 12:00:00 GMT';
  const out = await mirrorPeriod(SOURCE, '202605', { concurrency: 1, force: false });
  assert.equal(out.status, 'stored');

  const files = (await readdir(dir())).sort();
  assert.equal(files.length, 2);
  assert.equal(await readFile(join(dir(), files[0] as string), 'utf8'), 'first copy');
  assert.equal(
    await readFile(join(dir(), files[1] as string), 'utf8'),
    'second copy, rewritten after the month closed',
  );
});

test('different bytes under the same stamp are two files, not an overwrite', async () => {
  // The publisher's Last-Modified is theirs to set, and it can be wrong or reused.
  // Identity has to survive that, which is why the content hash is in the name.
  body = 'third copy, same stamp as the second';
  const out = await mirrorPeriod(SOURCE, '202605', { concurrency: 1, force: true });
  assert.equal(out.status, 'stored');

  const files = await readdir(dir());
  assert.equal(files.length, 3);
  const stamped = files.filter((f) => f.startsWith('20260910T120000Z-'));
  assert.equal(stamped.length, 2, 'one stamp, two distinct copies');
  assert.equal(new Set(stamped).size, 2);
});

test('the manifest recorded every observation, and never dropped one', async () => {
  const lines = (await readFile(join(root, 'sources', 'test-immutable', 'manifest.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    lines.map((l) => l.status),
    ['stored', 'unchanged', 'unchanged', 'stored', 'stored'],
  );
  // Every line names the file it observed, so the manifest alone is a revision
  // history even if every snapshot were lost.
  assert.ok(lines.every((l) => typeof l.path === 'string' && l.path.includes('202605')));
});
