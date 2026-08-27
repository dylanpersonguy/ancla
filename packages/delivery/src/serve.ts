/**
 * One process that serves the site and the API together.
 *
 *   node packages/delivery/src/serve.ts
 *
 * The static files in apps/web are plain HTML, CSS and JavaScript with no build
 * step, so what is served here is the same bytes that would go on any static host.
 * The API is mounted at /api so the page can call it on its own origin, which is
 * also how it should be deployed: a reverse proxy in front, same origin, no CORS
 * preflight on the common path.
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRouter, indexPage, sendJson } from './api.ts';
import { anchorAddress, anchorNode } from './chain.ts';
import { pickLang, t } from './i18n.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));
export const WEB_ROOT = process.env.ANCLA_WEB_ROOT ?? resolve(HERE, '../../../apps/web');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Resolve a URL path inside the web root, or null when it escapes.
 *
 * Written out rather than trusted to path.join because a static server is the one
 * place in this project where a traversal bug reads the anchor key off disk.
 */
export function safePath(root: string, urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return null;
    }
  })();
  if (decoded === null || decoded.includes('\0')) return null;
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const full = resolve(root, rel);
  const rootResolved = resolve(root);
  if (full !== rootResolved && !full.startsWith(`${rootResolved}/`)) return null;
  return full;
}

async function serveFile(res: ServerResponse, file: string): Promise<boolean> {
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (info.isDirectory()) return false;
  res.writeHead(200, {
    'content-type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    // Short cache: the site changes when the feed changes, and nobody wants to
    // explain to a journalist that they are looking at yesterday's page.
    'cache-control': 'public, max-age=60',
  });
  createReadStream(file).pipe(res);
  return true;
}

export function createSiteServer(webRoot = WEB_ROOT) {
  const api = createRouter('/api');
  return createServer(async (req, res) => {
    try {
      if (await api(req, res)) return;
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const lang = pickLang(url.searchParams.get('lang'), req.headers['accept-language'] ?? null);

      // The router only claims paths that name a route, so /api itself lands here.
      // It is the endpoint listing the site links to from the nav.
      if (url.pathname === '/api' || url.pathname === '/api/') {
        indexPage(res, lang, '/api');
        return;
      }

      let pathname = url.pathname;
      if (pathname === '/') pathname = '/index.html';
      // Extensionless paths get .html, so /verify serves verify.html.
      if (!extname(pathname)) pathname = `${pathname}.html`;

      const file = safePath(webRoot, pathname);
      if (file && (await serveFile(res, file))) return;

      sendJson(res, 404, {
        error: { code: 'not_found', message: t('error.notFound', lang, { what: url.pathname }) },
      });
    } catch (err) {
      process.stderr.write(`serve error: ${(err as Error).stack}\n`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('internal error');
    }
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = Number(process.env.ANCLA_PORT ?? 8080);
  createSiteServer().listen(port, () => {
    process.stdout.write(`ancla site   http://localhost:${port}\n`);
    process.stdout.write(`ancla api    http://localhost:${port}/api\n`);
    process.stdout.write(`web root     ${WEB_ROOT}\n`);
    process.stdout.write(`anchor       ${anchorAddress()} via ${anchorNode()}\n`);
  });
}
