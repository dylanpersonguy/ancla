#!/usr/bin/env node
/**
 * Render a markdown doc to PDF via headless Chrome.
 *
 *   node docs/render.mjs docs/ancla-explained.md "Ancla" "subtitle"
 *
 * Palette and type follow the DecentralChain brand: ink on warm paper, DC Indigo
 * as the only accent, IBM Plex throughout. Print-first, so the dark canvas from
 * the screen brand is deliberately not used here.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { marked } from 'marked';

const [, , mdPath, titleArg, subtitleArg] = process.argv;
if (!mdPath) {
  process.stderr.write('usage: node docs/render.mjs <file.md> [title] [subtitle]\n');
  process.exit(1);
}

const TITLE = titleArg ?? 'Ancla';
const SUBTITLE = subtitleArg ?? '';
const DATE = '27 August 2026';
const VERSION = 'v1.0';

const raw = readFileSync(resolve(mdPath), 'utf8');

// The file opens with an unheaded paragraph: that is the abstract.
const firstHeading = raw.indexOf('\n## ');
const abstractMd = raw.slice(0, firstHeading).trim();
const bodyMd = raw.slice(firstHeading).trim();

marked.use({ gfm: true, breaks: false });
const abstract = marked.parse(abstractMd);
let body = marked.parse(bodyMd);

// Break before each top-level numbered section except the first.
body = body.replace(/<h2>(\d+)\./g, (m, n) => (n === '1' ? m : `<h2 class="brk">${n}.`));
// Split the section number out so it can be set in mono indigo.
body = body.replace(/<h2([^>]*)>(\d+(?:\.\d+)?)\.\s*/g, '<h2$1><span class="n">$2</span>');
body = body.replace(/<h3([^>]*)>(\d+(?:\.\d+)*)\s*/g, '<h3$1><span class="n">$2</span>');

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root{
  --paper:#FAF9F6; --sink:#F2F0EA; --ink:#141414; --muted:#5A5A5A;
  --rule:#E4E1D9; --indigo:#3A2CB7; --cyan:#28C8F0;
  --pos:#16A34A; --neg:#DC2626; --warn:#D97706;
}
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
@page{size:A4;margin:20mm 18mm 16mm;}
@page:first{margin:0;}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact;}
body{
  font-family:'IBM Plex Sans',system-ui,sans-serif;
  font-size:10pt;line-height:1.68;color:var(--ink);background:var(--paper);
}

/* cover */
.cover{
  height:297mm;padding:38mm 24mm 24mm;display:flex;flex-direction:column;
  page-break-after:always;background:var(--paper);
}
.wordmark{
  font-family:'IBM Plex Mono',monospace;font-size:9pt;font-weight:600;
  letter-spacing:.22em;text-transform:uppercase;color:var(--indigo);
}
.cover h1{
  font-size:40pt;font-weight:600;letter-spacing:-.02em;line-height:1.04;
  margin-top:12mm;
}
.cover .sub{font-size:14pt;color:var(--muted);margin-top:6mm;max-width:120mm;line-height:1.45;}
.rule-grad{height:3px;width:56mm;margin-top:10mm;
  background:linear-gradient(90deg,var(--indigo),var(--cyan));}
.byline{
  font-family:'IBM Plex Mono',monospace;font-size:8.5pt;color:var(--muted);
  margin-top:auto;line-height:1.9;
}
.cover .tag{
  margin-top:14mm;padding:6mm 7mm;background:var(--sink);
  border-left:3px solid var(--indigo);font-size:10.5pt;line-height:1.6;max-width:130mm;
}

/* abstract */
.abstract{
  padding:5mm 6mm;background:var(--sink);border-left:3px solid var(--indigo);
  margin-bottom:9mm;font-size:10pt;line-height:1.7;
}
.abstract p{margin:0;}
.abstract code{background:transparent;padding:0;font-size:8.6pt;}

/* headings */
h2{
  font-size:17pt;font-weight:600;letter-spacing:-.01em;margin:11mm 0 4mm;
  padding-bottom:2.5mm;border-bottom:1px solid var(--rule);
}
h2.brk{page-break-before:always;margin-top:0;}
h3{font-size:11.5pt;font-weight:600;margin:7mm 0 2.5mm;}
h2 .n,h3 .n{
  font-family:'IBM Plex Mono',monospace;color:var(--indigo);font-weight:500;
  margin-right:3.5mm;
}
h2 .n{font-size:14pt;} h3 .n{font-size:10pt;}
h2+p,h3+p{margin-top:0;}

p{margin:0 0 3.2mm;}
strong{font-weight:600;}
em{font-style:italic;color:var(--ink);}

ul,ol{margin:0 0 3.5mm 5mm;}
li{margin-bottom:1.6mm;padding-left:1mm;}
li::marker{color:var(--indigo);}

/* code */
code{
  font-family:'IBM Plex Mono',monospace;font-size:8.4pt;
  background:var(--sink);padding:.4mm 1.1mm;border-radius:2px;word-break:break-all;
}
pre{
  background:var(--sink);border-left:2px solid var(--rule);
  padding:4mm 5mm;margin:0 0 4mm;overflow:hidden;page-break-inside:avoid;
}
pre code{background:transparent;padding:0;font-size:8.2pt;line-height:1.62;word-break:normal;}

/* tables */
table{
  width:100%;border-collapse:collapse;margin:0 0 5mm;font-size:8.8pt;
  page-break-inside:avoid;
}
thead th{
  text-align:left;font-family:'IBM Plex Mono',monospace;font-size:7.6pt;
  font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);
  border-bottom:1.5px solid var(--ink);padding:2.2mm 2.5mm;
}
tbody td{border-bottom:1px solid var(--rule);padding:2.2mm 2.5mm;vertical-align:top;}
tbody tr:nth-child(even){background:rgba(242,240,234,.55);}
tbody td:nth-child(n+2){font-variant-numeric:tabular-nums;}
table code{font-size:7.8pt;}

blockquote{
  border-left:3px solid var(--indigo);padding:3mm 5mm;margin:0 0 4mm;
  background:var(--sink);color:var(--ink);
}
hr{border:none;border-top:1px solid var(--rule);margin:7mm 0;}
a{color:var(--indigo);text-decoration:none;}
h2,h3{page-break-after:avoid;}
`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${TITLE}</title>
<style>${CSS}</style></head><body>
<section class="cover">
  <div class="wordmark">DecentralAmerica</div>
  <h1>${TITLE}</h1>
  <div class="sub">${SUBTITLE}</div>
  <div class="rule-grad"></div>
  <div class="tag">
    A public evidence layer for Costa Rican procurement records. Live on
    DecentralChain mainnet since 27 August 2026.
  </div>
  <div class="byline">
    ${VERSION} &nbsp;·&nbsp; ${DATE}<br>
    DecentralAmerica &nbsp;·&nbsp; decentralchain.io<br>
    root 4a58b302bf5f1311 &nbsp;·&nbsp; height 2,316,909
  </div>
</section>
<main>
<div class="abstract">${abstract}</div>
${body}
</main></body></html>`;

const htmlPath = resolve(mdPath).replace(/\.md$/, '.html');
const pdfPath = resolve(mdPath).replace(/\.md$/, '.pdf');
writeFileSync(htmlPath, html, 'utf8');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--virtual-time-budget=20000',
    `--print-to-pdf=${pdfPath}`,
    `file://${htmlPath}`,
  ],
  { stdio: 'pipe' },
);

process.stdout.write(`${basename(pdfPath)} written\n`);
