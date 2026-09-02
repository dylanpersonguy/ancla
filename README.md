# Ancla

A public evidence layer for Costa Rican procurement records.

Costa Rica publishes every public contract as open data, refreshed daily. That
published record gets rewritten after the fact, at the same web address, with the
previous version discarded. Until August 2026 nobody kept a copy of what it said
before.

Ancla mirrors the record every day, reduces it to a single fingerprint, and commits
that fingerprint to DecentralChain. From then on, any change to an already-published
record is provable by anyone, against a timestamp nobody controls. Assembling that
mirror also produced something separately useful: the only complete, queryable
history of Costa Rican procurement, 2010 to 2026.

Live on mainnet since 27 August 2026. Running cost is under one dollar a year.

---

## What this proves, and what it does not

Read this before using anything here. Overclaiming is the failure mode that makes
work like this worthless.

Ancla proves that **a published record did or did not change, forward from the moment
of anchoring**. That is the entire claim.

It does **not** prove a record is accurate. A perfectly anchored corrupt contract is
still corrupt.

It does **not** detect corruption. It detects change. SICOP records legitimate
amendments explicitly, and Ancla excludes those. What remains is the narrow
interesting case: a published field that changed with no amendment recorded. Some of
those will have innocent explanations too.

It **cannot audit the past**. Anchoring establishes integrity from the day it starts.
Five republication events between 2024 and 2026 rewrote 14 closed months, and what
those files said beforehand is permanently unknowable. Any system claiming otherwise
is comparing a hash against one it generated itself, which proves nothing.

It only sees **what gets published**. Contracts that never entered SICOP are
invisible. The Contraloría found 27.1% of awarded value in 2021 flowed outside the
platform, and Ancla cannot measure that: you cannot detect an absence in a dataset
that only records presence.

---

## Status

| Component | State |
|---|---|
| Historical mirror | 189 archives, 3.04 GB, complete |
| Canonicalization and Merkle proofs | working, version `ancla-canon-1` |
| Change detection | working, tested against real archives |
| Daily watch job | working, **not yet scheduled** |
| Anchoring to mainnet | **live**, one root committed |
| Longitudinal index | 189 months, ~6 million rows |
| Entity resolution | 72,105 resolved actors |
| Analytics and integrity screens | working |
| REST API, OCDS export, alerts | working |
| Spanish web app and public verifier | working, not yet hosted |
| Tests | 306 passing across 22 files |

Two honest gaps. The daily anchor is currently run by hand, so the chain holds one
root rather than a daily series; scheduling it is the single most important operational
task in this repo. And change detection has not yet caught a live rewrite, because
none has occurred since the mirror was taken. Based on the record, that happens about
twice a year.

---

## Quick start

Requires **Node 24 or newer**. There is no build step: Node runs the TypeScript
directly via type stripping.

```bash
pnpm install

# what the source holds, how big it is, and what it has rewritten
node packages/ingest/src/cli.ts survey

# mirror every archive. resumable, idempotent, never overwrites
node packages/ingest/src/cli.ts mirror -c 4

# a second country. --source takes cr (default), pa, or pa-tienda
node packages/ingest/src/cli.ts survey --source pa
node packages/ingest/src/cli.ts mirror --source pa -c 4

# canonicalize archives into Merkle-rooted snapshots
node packages/cli/src/main.ts snapshot

# stitch every month into one queryable history
node packages/index/src/cli.ts load
node packages/index/src/cli.ts resolve

# ask it something
node packages/analytics/src/cli.ts competition

# serve the API and web app
node packages/delivery/src/serve.ts
```

The mirror lives **outside** the repo. Default `$HOME/ancla-data`, override with
`ANCLA_DATA`. It reaches roughly 12 GB with archives, snapshots and the index, and
none of it belongs in git.

Costa Rica keeps the original paths (`archives/`, `manifest.jsonl` at the root);
every later source lives under `sources/<id>/`. That asymmetry is deliberate — see
`legacyRoot` in `packages/ingest/src/source.ts`.

## Sources

| Source | Id | Granularity | Coverage seen | Notes |
|---|---|---|---|---|
| Observatorio de Compra Pública | `cr-observatorio` | month | 201012 – 202608, 189 archives | SICOP + SIAC |
| PanamaCompra en Cifras | `pa-panamacompra` | month | 202309 – 202609, 37 archives | OCDS; ships an incomplete TLS chain |
| PanamaCompra tienda virtual | `pa-tienda-virtual` | month | — | catalogue store, separate registry |

Adding one means writing a `Source` and registering it. The bar is not that the
country publishes data; it is that it publishes **a whole period as one file, at a
URL we can derive, whose bytes are identical between two fetches**. Fetch the same
archive twice and compare before writing an adapter — a portal that rebuilds on
demand reports a rewrite every day and proves nothing.

Guatemala and Honduras both clear that bar and are not written yet. El Salvador
and Nicaragua publish no bulk archive at all, so no adapter can reach them.

---

## How it works

```
   Observatorio de Compra Pública        daily, public, no authentication
              |
   1. ingest              download, hash, store forever, never overwrite
              |
   2. canonicalize        reduce each record to two fingerprints
              |
   3. merkle              fold ~1.4M records into one 64-character root
              |
   4. anchor              write the root to DecentralChain
              |
   5. index               stitch all 189 months into one SQL history
              |
   6. analyse             competition, duration, price, collusion screens
              |
   7. deliver             REST API, OCDS, alerts, web, verifier
```

### Ingest keeps everything and overwrites nothing

Each archive is stored as `archives/<month>/<lastModified>-<sha256 prefix>.zip`. That
naming does three jobs at once: re-running is idempotent, a rewritten month lands
beside its predecessor instead of replacing it, and a month's directory listing is its
revision history.

`manifest.jsonl` is append-only and is itself the first evidence artifact. Before any
canonicalization exists it already answers a question nobody could answer before: what
did the source publish for month M, and when did it change?

### Canonicalization produces two digests, not one

Each record is reduced to a stable identity and two separate SHA-256 digests.

| Digest | Covers | Answers |
|---|---|---|
| `byteHash` | every field exactly as published | did anything at all change? |
| `valueHash` | volatile fields dropped, numbers normalized | did a *value* change? |

The distinction is load-bearing. A price published as `1.000` and republished as `1`
is the same price printed differently. A system with one digest calls that tampering,
drowns its own output in false alarms, and gets ignored.

This is not hypothetical. During development a comparison between two data sources
reported **40,845 discrepancies**. Every one was an artifact of the comparison code:
a normalization routine using `rstrip('0')` turned `6780000` into `678`. The whole
episode is written up in
[`findings/2026-08-26-cross-source.md`](findings/2026-08-26-cross-source.md) rather
than buried, and there is now a test pinning that exact case.

`CANON_VERSION` is stamped into every anchor. Changing the rules without changing the
version would silently invalidate every commitment made before, which is the one
failure this project cannot survive. Released versions are never modified.

### Merkle trees follow RFC 6962

The Certificate Transparency construction, not the Bitcoin one. Leaves and internal
nodes are domain-separated with `0x00` / `0x01` prefixes so a leaf digest can never be
replayed as an internal node, and odd nodes are promoted rather than duplicated, which
avoids the duplicate-leaf collision of CVE-2012-2459. There is a test asserting
`[a,b,b]` and `[a,b]` produce different roots.

Proving one record belongs to a set of 300,000 takes about 19 hashes.

### The chain stores roots and nothing else

One transaction, three entries:

```
root_2026-08-27_202512 = 4a58b302bf5f1311b2d90526d5b8ad0535fac14d688045e98dda7bb965001198
meta_2026-08-27_202512 = ancla-canon-1|301189|ce92277ce996f610...
latest                 = 2026-08-27
```

No documents, no names, no amounts. A fingerprint, a record count, and a date. The
chain never sees procurement data, which keeps the design clear of Costa Rican data
protection law in a way that storing documents would not.

`contracts/ancla.ride` is about thirty lines and refuses to overwrite an existing key.
There is deliberately **no on-chain proof verification**: proofs are checked
client-side against the node's REST API, so the contract cannot be the thing that
breaks, and a lawyer can be walked through all of it.

### The index makes the history answerable

The Observatorio publishes monthly fragments. A procedure opened in March and paid in
November appears completely in neither file, so any statistic drawn from one archive
is biased toward short-lived records.

Measuring publication to contract notification inside a single month gives **652
observations and a mean of 11 days**. Across the stitched history it gives **32,647
observations and a mean of 43 days**, with 26,738 links crossing a month boundary and
existing in no single archive.

---

## The packages

| Package | Purpose |
|---|---|
| `core` | SQLite schema for the longitudinal index, shared query and parsing helpers |
| `ingest` | Mirror the Observatorio archives with provenance; survey, mirror, status |
| `canonicalize` | Dependency-free zip reader, CSV parser, deterministic canonicalization, snapshots |
| `merkle` | RFC 6962 tree, proofs, verification |
| `differ` | Classify what changed between two snapshots |
| `index` | Load archives into SQLite, resolve entities |
| `analytics` | Competition, durations, prices, collusion screens, benchmarking |
| `anchor` | DataTransaction serializer, signer, node client, key handling |
| `delivery` | REST API, OCDS export, alert engine, Spanish i18n, static server |
| `cli` | Unified `ancla` command over the whole pipeline |
| `apps/web` | Spanish-first change feed and hosted verifier |
| `apps/verifier` | Standalone browser verifier, no backend |

One runtime dependency across the whole repo: `@decentralchain/ts-lib-crypto`, used in
`packages/anchor` for Ed25519 signing. Everything else is `node:` builtins. That is
deliberate. A system whose value rests on producing identical output years from now
should not have a dependency tree that can shift underneath it.

`@decentralchain/transactions` is **not** used, because it cannot be imported under
Node's ESM resolver: `@decentralchain/protobuf-serialization@2.0.0` imports
`protobufjs/minimal` with no file extension. The DataTransaction serializer in
`packages/anchor/src/datatx.ts` was written directly against `node-scala`'s own
`DataTxSerializer.scala` instead.

---

## What the source data does to you

Real properties of the Observatorio archives, all handled, all covered by tests. These
are the things that would have corrupted the index silently.

**Column order is not stable.** Between August and September 2025 the seventh column
of `LineasAdjudicadas` changed from `ACARREOS` (freight) to `CANTIDAD_ADJUDICADA`
(awarded quantity), with no rename. A positional reader loads freight charges as
quantities for a year and never raises an error. Everything resolves by header name,
case-insensitively, since `RecursosObjecion` ships some columns lower-case.

**Zip layout is not stable.** Archives rewritten on 2024-09-20 nest their CSVs under a
`YYYYMM/` folder. Every other archive stores them flat. Both must canonicalize
identically. This is also a forensic signal: those files were re-exported by a
different pipeline, not patched in place.

**One table uses a different delimiter.** `SancionProveedores` is comma-delimited. The
other 24 use semicolons.

**Some date columns have no separators.** They arrive as `DDMMYYYY`. Day-first
ordering was established by measurement across the whole mirror, not assumed: the
first pair reaches 31 and the second never exceeds 12.

**`NRO_RECURSO` does not identify an appeal.** One appeal objects to several lines, so
the key is `NRO_RECURSO` plus `LINEA_OBJETADA`.

**Three tables emit literal duplicate rows.** `Garantias` around 50%, `Remates` around
80%, `SistemaEvaluacionOfertas` around 75%. Those are content-addressed with an
occurrence index so duplicates stay individually addressable and a change in the
number of copies is visible.

**Award acts double-count money.** The primary key includes `nro_acto`, so a re-issued
award appears twice at full value. Summing raw `award_line` overstates awarded value
by 33%. One superseded row held 1.4 trillion CRC, corrected in a later act to three
items at $8,000. All money paths read a deduplicated view.

**Exception rates are not comparable across 2022-12-01.** Ley 9986 stopped classifying
small-value direct contracting as an exception. The raw series falls from 82.4% to
20.6% and reads as a collapse in no-bid contracting. Excluding *escasa cuantía* it is
22.1% to 20.6%. Nothing changed but the law.

---

## What the data shows

**41.1% of Costa Rican public tenders that receive any bid receive exactly one.** That
is 106,190 of 258,420. Single-bidder rate is the primary red flag the OECD and World
Bank use to screen procurement systems.

| Year | Tenders | Single bidder |
|---|---|---|
| 2015 | 2,485 | 27.4% |
| 2018 | 12,497 | 41.1% |
| 2022 | 38,190 | 43.3% |
| 2025 | 25,975 | 42.5% |

The figure is conservative: consortium members currently count as separate bidders, so
consuming `entity`/`entity_member` in the competition screens will push it up.

**9,596 tenders were modified after publication and later formally objected to.** That
is the shape of the problem in one number. Most of those modifications will be
routine. Nobody can currently tell which.

### What the analytics refuse to answer

The refusals matter as much as the answers.

- **Award-to-payment duration is unquotable.** 99.8% censored: 16 completed against
  8,122 unfinished. Kaplan-Meier declines a median and so do we.
- **Roughly 59% of product codes are not price-comparable.** One spans a factor of
  2.08e13, which is a unit-of-measure artifact. Refusing is the output.
- **Collusion screens stay silent on random data** across ten seeded trials. On real
  data they return one bid-rotation group from 110,912 tested. They are indicators
  that flag cases worth a human look, never findings that name a wrongdoer.

---

## Commands

```
ingest CLI     node packages/ingest/src/cli.ts <cmd>
  survey                          archive inventory, sizes, republication events
  mirror [--from M] [--to M]      download; resumable, never overwrites
         [-c N] [--force]
  status                          what we hold and what has changed

main CLI       node packages/cli/src/main.ts <cmd>
  snapshot [month...]             canonicalize into Merkle-rooted snapshots
  diff <YYYYMM>                   compare a month's two most recent versions
  watch [--from M] [--to M]       the daily job: refetch, diff, report
  keygen [--force]                create the anchor account (seed stays on disk)
  anchor [--day D] [--month M]    commit roots to DecentralChain
         [--all] [--broadcast]    --all batches every month; dry run without --broadcast
  prove <YYYYMM> <Table> <id>     Merkle proof for one record
        [--day YYYY-MM-DD]
  node                            chain reachability check

index CLI      node packages/index/src/cli.ts <cmd>
  load [--from M] [--to M]        stitch archives into SQLite
  resolve                         entity resolution over suppliers and consortia
  stats                           row counts, coverage, censoring warnings

analytics CLI  node packages/analytics/src/cli.ts <cmd>
  competition                     single-bidder rate, bidder mix, exception usage
  duration                        stage durations, censoring always reported
  prices                          unit price benchmarking, with a homogeneity guard
  collusion                       rotation, consistent losing, bid spread screens
  supplier --supplier CEDULA      win and loss forensics for one firm
  institution --institution CED   peer benchmark for one buyer
  rank --metric <name>            national ranking on one metric
  common: --json  --db PATH  --from YYYY-MM-DD  --to YYYY-MM-DD

delivery       node packages/delivery/src/serve.ts
  serves apps/web plus the API at /api
```

### Environment

| Variable | Meaning |
|---|---|
| `ANCLA_DATA` | data root, default `$HOME/ancla-data` |
| `ANCLA_INDEX` | index path, default `$ANCLA_DATA/index.sqlite` |
| `ANCLA_NODE` | chain node, default `https://mainnet-node.decentralchain.io` |
| `ANCLA_SEED` | anchor seed; overrides the key file, for secret managers |
| `ANCLA_KEY_FILE` | seed file path, default `$ANCLA_DATA/anchor.key`, mode 0600 |
| `ANCLA_SMTP_*` | SMTP settings for email alerts; dry-run transport by default |

---

## Operating it

The daily job is the product. Every day it does not run is a day of history that
cannot be recovered, because nobody else is keeping it.

```bash
# once
node packages/cli/src/main.ts keygen        # prints the address, never the seed
# fund that address with a small amount of DCC, then:

# daily, after the source refresh at ~13:00 UTC
node packages/cli/src/main.ts watch && \
node packages/cli/src/main.ts anchor --broadcast
```

`watch` exits with code `2` when a **closed** month is rewritten with real value
changes, so a cron wrapper can escalate without parsing prose.

**Back up the seed file.** It is mode 0600 on one machine. Lose it and you cannot
write another root to that account, and the append-only history dead-ends.

**Whoever holds that key is the credibility of this system.** A procurement integrity
service is worth exactly as much as the independence of the party writing the roots.
The anchoring account belongs with institutions that have no financial stake in
procurement outcomes. That is a governance decision, not an engineering one, and it is
the largest open risk in this repo.

---

## Verify any of it yourself

```bash
# the anchored root, straight from a public node
curl https://mainnet-node.decentralchain.io/addresses/data/\
3DTwG5ZydbJDuLdEmwfgDEH3NuwDrgwQFtF/root_2026-08-27_202512

# a proof for one real contract, which should reproduce that root
node packages/cli/src/main.ts prove 202512 Contratos "CE201907001175|01"

# the republication events
node packages/ingest/src/cli.ts survey
```

| | |
|---|---|
| Network | DecentralChain mainnet |
| Anchor account | `3DTwG5ZydbJDuLdEmwfgDEH3NuwDrgwQFtF` |
| First anchor | `5QcP1tNimcmt3993fNmyACZ1JmZEaMoMbacUHq7VBxRG` |
| Block height | 2,316,909 |
| Records committed | 301,189 |
| Cost | 0.001 DCC |

---

## Tests

```bash
node --test packages/*/test/*.test.ts apps/*/test/*.test.ts
```

306 tests across 22 files. The ones that matter most:

- canonicalization determinism, and number normalization against the integer-corruption bug
- RFC 6962 proofs at odd and even tree sizes, and the duplicate-leaf case
- **parity between the browser verifier and the Node implementation**, because if those two drift, every published proof silently stops verifying
- the differ against real archive data: change one estimated unit price in a real
  1.4M-record archive and exactly one silent revision must be reported, with zero false
  positives; reprint a number and zero revisions must be reported

Some real-data tests load full archives repeatedly and take tens of minutes. They skip
cleanly when no mirror is present.

---

## Source

[Observatorio de Compra Pública](https://www.observatoriocomprapublica.go.cr/descargas-sicop/),
which republishes SICOP (Ministerio de Hacienda) and SIAC (Contraloría General de la
República) as monthly ZIP archives of semicolon-delimited CSVs on public Azure blob
storage. Published explicitly for reuse: *"análisis, seguimiento, fiscalización y el
desarrollo de nuevas aplicaciones."*

Do not scrape `sicop.go.cr` directly. Its open-data module is a stateful WebLogic JSP
that returns 403 to a plain fetch and 500 with a browser user-agent. The Observatorio
path is the same data, already flattened.

## Documentation

- [`docs/ancla-brief-en.md`](docs/ancla-brief-en.md) and
  [`docs/ancla-brief-es.md`](docs/ancla-brief-es.md). Six-page overview, English and Spanish.
- [`docs/ancla-platform-en.md`](docs/ancla-platform-en.md). The long-form reference.
- [`findings/2026-08-26-cross-source.md`](findings/2026-08-26-cross-source.md). A
  negative result, written up in full.

## License

MIT. The point of this project is that anyone can check the work.
