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
is comparing a hash against one it generated itself, which proves nothing. `ancla
recover` prints that gap period by period rather than papering over it, and will keep
saying `currentOnly` for all fourteen until somebody produces a copy that reproduces
a root committed before they offered it.

It only sees **what gets published**. Contracts that never entered SICOP are
invisible. The Contraloría found 27.1% of awarded value in 2021 flowed outside the
platform, and Ancla cannot measure that: you cannot detect an absence in a dataset
that only records presence.

---

## Status

| Component | State |
|---|---|
| Historical mirror | 189 archives, 3.04 GB, complete |
| Canonicalization and Merkle proofs | working, version `ancla-canon-2` |
| Change detection | working, tested against real archives |
| Row-level evidence bundles | working, version `ancla-bundle-2`, with a field-level summary |
| Per-capture and per-diff commitments | working, keyed by content, not by day |
| Daily watch job | **live**, launchd, 09:30 local |
| Anchoring to mainnet | **live**, 420 capture commitments: 228 under `ancla-canon-1`, 192 under `-2` |
| Longitudinal index | 189 months, ~6 million rows |
| Entity resolution | 72,105 resolved actors |
| Analytics and integrity screens | working |
| REST API, OCDS export, alerts | working |
| Spanish web app and public verifier | **live** at decentralamerica.com/evidencia |
| Tests | 409 passing across 36 files, plus 12 real-data tests that skip without a mirror |

One honest gap. Change detection has not yet caught a rewrite of a *closed*
month, because none has occurred since the mirror was taken. Based on the record that
happens about twice a year, and the bundle machinery is exercised in the meantime
against the two copies of 202608 the publisher actually served five days apart:
259,891 classified changes, rebuilt byte for byte from the archives by a second pass.

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

# other countries. --source takes cr (default), pa, hn, and the variants below
node packages/ingest/src/cli.ts survey --source pa
node packages/ingest/src/cli.ts mirror --source pa -c 4

# Honduras serves an expired certificate, so it is opt-in per run
node packages/ingest/src/cli.ts mirror --source hn --accept-unverified-tls

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
| ONCAE HonduCompras | `hn-oncae-hc1` | year | 2005 – 2026 | OCDS; **certificate expired 2026-07-05** |
| ONCAE catálogo electrónico | `hn-oncae-ce` | year | 2014 – 2026 | convenio marco orders |
| ONCAE difusión directa | `hn-oncae-ddc` | year | 2010 – 2019 | discontinued |

Yearly sources are a weaker instrument than monthly ones, and Honduras shows why:
an annual file legitimately grows all year and is routinely rebuilt afterwards, so
"this closed period changed" is a much blunter claim than it is for a month. Read
an ONCAE republication event as a question, not a finding.

Adding one means writing a `Source` and registering it. The bar is not that the
country publishes data; it is that it publishes **a whole period as one file, at a
URL we can derive, whose bytes are identical between two fetches**. Fetch the same
archive twice and compare before writing an adapter — a portal that rebuilds on
demand reports a rewrite every day and proves nothing.

Guatemala clears that bar on the data and fails it on access: `ocds.guatecompras.gt`
and `datos.minfin.gob.gt` both sit behind a Cloudflare challenge (`cf-mitigated:
challenge`). That is an access control the operator turned on deliberately, so the
route forward is an access request to MINFIN/DGAE, not a bypass. Its OCDS also
appears in the OCP data registry, but see below before reaching for that.

El Salvador and Nicaragua publish no bulk archive at all, so no adapter can reach
them, and the site's `planeado` status for both is the honest one.

**Do not mirror the OCP data registry as a substitute.** Its downloads redirect to
`fastly.data.open-contracting.org/downloads/<publisher>/<run-id>/<year>.jsonl.gz`
with a fresh run id each retrieval, because each run re-exports the publisher's
data. Hashing that detects OCP regenerating its own file, not a government
rewriting the record, which is the one thing this project claims to detect.

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
   4. bundle              what changed between two copies, field by field
              |
   5. anchor              write the root, and the bundle digest, to DecentralChain
              |
   6. index               stitch all 189 months into one SQL history
              |
   7. analyse             competition, duration, price, collusion screens
              |
   8. deliver             REST API, OCDS, alerts, web, verifier
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

It has moved once, on 2026-09-03, to `ancla-canon-2`. See **The publisher writes
broken CSV** below for why, and *What a version bump costs* for what it did to the
228 commitments already on chain.

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

### Every capture is committed, not just every day

The daily plan writes `root_<day>_<period>`, which is addressed by the day the job
ran. That is enough to prove the record changed, and it has one hole: a copy that
arrives and is replaced between two runs is never committed to, and a day the job
misses takes that copy's root with it. The bytes survive on disk either way. What is
lost is the ability to prove afterwards that they are the bytes we had, which is the
half that matters.

So each capture also gets a key derived from its own bytes:

```
ver_202608_2a8f44f57e6b    = 77c30fc86e5bf2c69f1f36e8dce61b39a06a23470a3a9396b79627a2b9d56734
vmeta_202608_2a8f44f57e6b  = ancla-canon-1|1652192|2a8f44f57e6b99a2…|20260831T130427Z
```

The twelve hex are the front of the archive's SHA-256, so the same copy always lands
on the same key with the same value. Anchoring it twice is a no-op the contract
refuses rather than a rewrite, and two different copies cannot collide onto one key
without a SHA-256 collision. `ancla anchor --versions` drops keys already on chain
before signing, so a quiet day costs nothing.

### What a version bump costs

Changing the canonicaliser is the most expensive thing this project can do, so it is
worth being exact about what it does and does not invalidate.

**The archives are untouched.** They are the evidence. Every `archiveSha256` on chain
still describes the same bytes, and a v1 root is still reproducible from those bytes
by v1 code, which is in this history.

**A v1 root and a v2 root describe different record sets.** Not because the file
changed but because v1 merged rows that v2 keeps apart. So they cannot be compared,
and nothing tries to: `vmeta` carries the canon version, the differ refuses a
cross-version comparison, and a capture anchored under v1 renders as anchored under
v1 rather than as missing.

**A capture needs one key per version.** The chain key is derived from the archive's
hash, which does not change when the rules do — so a v2 root would land on the key
its v1 root already occupies, the contract would refuse to overwrite it (correctly),
and the anchor step would skip that capture forever. Keys therefore carry the
canonicaliser:

```
ver_202608_2a8f44f57e6b      ancla-canon-1, already on chain, unsuffixed
ver_202608_2a8f44f57e6b_c2   ancla-canon-2
```

**Snapshots too.** They used to be named for the archive alone, so re-snapshotting
would have overwritten the file each anchored v1 root was built from. They now carry
their version, and the old unsuffixed path is still read so nothing already built is
orphaned.

**Re-anchoring is a deliberate act, not a migration step.** The 228 v1 commitments
stay exactly where they are and stay true. Committing the v2 roots is a separate
decision with its own cost, and `ancla anchor --versions` will show it as a plan
before it sends anything.

### A bundle says what changed, not just that something did

A root proves a file moved. It cannot say which contract moved, and that is the only
question a journalist or an auditor actually has. So a republication also produces an
**evidence bundle**: a directory holding a manifest and one line per changed row.

```
bundles/202608/20260826T130636Z__20260831T130427Z/
  manifest.json       both versions, both roots, the five counts, two digests
  changes.jsonl.gz    one line per change, with old and new values
```

A silent revision names the field and both sides of it:

```json
{"kind":"silentRevision","table":"Contratos","id":"CE202608001300|00",
 "fields":[{"field":"FECHA_NOTIFICACION","before":"","after":"2026-08-27 00:00:00.0000000"}]}
```

A removal keeps the whole row, because nothing else will. An addition keeps the row
that appeared. The reformatted class still exists here and is still separate from a
revision, for the same reason it is separate in the differ.

**The bundle digest is what goes on chain**, under a key naming both copies:

```
diff_202608_7cc3a068c019_2a8f44f57e6b_c2  = 9100885e298fab7990b990672853390d…
dmeta_202608_7cc3a068c019_2a8f44f57e6b_c2 = ancla-bundle-1|246692,24,7592,1905,3678|08612c90…
```

The `_c2` names the canonicaliser; a `_b2` after it would name the bundle format.
Both are absent for the first version of each, because commitments exist under
those unsuffixed names and renaming them would orphan every one.

That digest covers both archive hashes, both Merkle roots, every count, the schema
changes and the hash of the changes file. It deliberately does **not** cover
`builtAt`, so two machines holding the same two archives produce the same digest.
That is the whole claim, and `ancla verify-bundle` is that claim as an executable
check: it rebuilds the bundle from the two ZIPs and compares byte for byte.

The chain still stores no procurement data. It stores a commitment to a file anyone
can rebuild.

**Which fields moved.** A list of thousands of rows is not an answer to anything, so
a bundle also answers the first question anyone asks. Derived from the changes file
rather than stored in it, so it is outside the digest and anyone can recompute it:

```
  7,382  OrdenPedido       ESTADO_ORDEN                7,382 text changed
  5,756  OrdenPedido       FECHA_PROV_RECIBE_ORDEN     5,756 filled in
    117  OrdenPedido       TOTAL_ORDEN                   117 number moved   ↑69 ↓48
     75  ReajustePrecios   MONTO_TOTAL                    75 number moved   ↑40 ↓35
```

Fifteen thousand rows of dates being filled in is a batch job. A hundred and
seventeen rows where an amount moved is a question. They look identical in a flat
list, and the distinction is what the page leads with.

A value that was reprinted rather than changed — `1.000` becoming `1` — is counted
as a reprint, not as an amount change, for the same reason `byteHash` is kept apart
from `valueHash`. A field summary that reports 1,905 reprints as 1,905 amount changes
is the headline this project exists not to produce.

**On size.** A rewritten closed month moves tens of rows and every one fits. The
open month's daily update moves a quarter of a million, because the month is
filling up, which is not news. Writing every field of every one would spend nine
gigabytes a year to record that August grew during August, and bury the fifteen
hundred rows that were quietly edited or withdrawn under a quarter of a million
that nobody will ask about.

Two separate mechanisms handle that, and the difference between them matters:

| | drops | recorded as |
|---|---|---|
| detail budget | the *values* on a line that is still there | `valuesOmitted` |
| line policy | the *line* | `omittedByPolicy`, plus the policy itself |

Both are inside the digest. A closed month is written in full; the open month gets
`REVISIONS_ONLY`, which lists the revisions, withdrawals and reprints and leaves
additions counted but not enumerated — their evidence is the archive, and the
archive is kept. `counts` always covers every change either way, so the manifest
still says 246,692 records were added; it just does not list them. The arithmetic
is checked: written lines plus policy omissions must equal every change the diff
found, and a kind the policy excluded must have no lines at all.

That is what moved the format to `ancla-bundle-2`. `digestInputV1` is frozen and
reached by dispatch on a manifest's own version, so the two commitments already
written under `ancla-bundle-1` stay checkable — and a diff key carries the bundle
version the same way it carries the canonicaliser, for the same reason: a rebuild
under new rules needs a key of its own or the contract will refuse it and the
newer reading could never be committed at all.

`--bundle-all` on the watch, or `--full` on the command, writes everything.

### What can no longer be recovered

`ancla recover` sorts every period into one of four:

| | |
|---|---|
| `diffable` | two copies held; the row-level diff can be produced right now |
| `priorAnchored` | the chain commits to a copy we do not hold. A candidate can be **tested** against that root; the rows cannot be read out of it |
| `currentOnly` | one copy, written after the period closed, nothing earlier here or on chain. Gone |
| `neverRewritten` | one copy, served before the period closed |

Run against the current mirror it groups the gap by the day the publisher wrote it,
because that is the unit these arrived in:

```
currentOnly  (158)
    2022-12-06   106 period(s)   201012 - 201910
    2022-12-07    26 period(s)   201911 - 202112
    2022-12-08    11 period(s)   202201 - 202211
    2022-12-09     1 period(s)   201212 - 201212
    2024-09-20     7 period(s)   202401 - 202408
    2024-10-03     1 period(s)   202407 - 202407
    2024-10-04     1 period(s)   202409 - 202409
    2025-05-06     3 period(s)   202502 - 202504
    2026-08-10     2 period(s)   202606 - 202607
```

144 of those are one bulk publication in December 2022, when the Observatorio first
loaded the historical series. The remaining 14 are the republication events, and they
are the ones the earlier writing is about. Listing all 158 one per line would invite
a reader to count 158 rewrites, which is why they are grouped.

A third-party copy can be offered against any of them:

```bash
ancla recover --candidate ./someone-elses-202405.zip --period 202405
```

It canonicalises the file and compares its root against what the chain already holds.
There are exactly three outcomes, and only one of them is a find:

- **exactHistoricalVersion** — reproduces a root committed *before* the file was
  offered. This is the prior version.
- **copyOfHeldVersion** — identical to something already here.
- **unattestedExternalCopy** — reproduces no committed root. A lead for a reporter.
  It cannot be treated as the official prior version, and the tool will not label it
  as one however plausible it looks.

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
| `apps/web` | Spanish-first change feed, version browser, hosted verifier |
| `apps/verifier` | Standalone browser verifier, no backend: record proofs and bundle manifests |

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

**The publisher writes broken CSV, and it costs rows.** Descriptions carry unescaped
inch marks inside quoted fields:

```
"GABINETE DE PARED ABATIBLE PARA RACK DE 19" (482,6 mm), COLOR NEGRO, …"
"…AJUSTE DE ALTURA DEL RESPALDO DE 2.4", MECANISMO DE AJUSTE RÁPIDO…"
"…ARTE "BÁRBARO" Y PRERROMÁNICO E ISLAM, AUTOR: LORENZO DE LA PLAZA…"
```

RFC 4180 requires `""`. A strict reader ends the field at the inch mark and
desynchronises, and because each stray quote inverts the in/out state it stays
desynchronised until the next one flips it back — swallowing every row in between
into a single field. `ancla-canon-1` did exactly that. In 202608 it silently merged
**9,837 records**, including 3,820 rows of `Sistemas` and 2,737 of
`DetalleLineaCartel`, and produced one field 730,185 characters long. Eight of nine
sampled archives across 2015–2026 carry it; only 2010–2014 are clean.

Nothing errored. The records were merged, hashed, indexed and anchored, and the
counts looked plausible the whole way. It surfaced because a row rendered on the
version page had four product descriptions inside one field.

`ancla-canon-2` closes a quoted field only when the next byte is the delimiter, a
line break, or the end of the file. Anything else is a literal quote and the field
continues — what Python's `csv` and Excel do. After the fix, `Sistemas` and
`DetalleLineaCartel` parse to exactly their physical line counts.

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
  /versions[/:period]             every copy held, and whether it is anchored
  /bundles[/:period]              published row-level diffs
  /bundles/:p/:pair               one bundle's manifest, and its commitment on chain
  /bundles/:p/:pair/changes       a page of changed rows, filterable by kind and table
  /recovery                       what can still be recovered, and what cannot
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

## Hosting

Live at **decentralamerica.com/evidencia**.

It runs as the `ancla` service inside the `decentralamerica` Railway project and
is proxied from the site's Caddy over Railway's private network, so it needs no
DNS of its own. A path on that domain rather than a subdomain, because the two
halves are one argument: the site says a record is being kept, and /evidencia is
where a reader checks that without leaving.

The prefix is stripped at the proxy and the pages derive their API base from
their own location, so the export is mountable at any path and still works
standalone — which is the property that lets anyone host their own copy.

The site is a directory of files. `pnpm export` reduces the 13 GB mirror to about
35 MB — the pages, the version inventory, the recovery inventory, and every
published bundle — and writes a self-contained deployable beside the mirror,
outside the repo.

```bash
pnpm export                                    # -> $ANCLA_DATA/site
cd "$ANCLA_DATA/site" && railway up --service ancla
```

No server, no database, no volume, and nothing deployed can reach the archives,
the index, or the anchor key. That is a property rather than a shortcut: a static
site cannot answer one reader differently from another, and anyone who would
rather not trust us can mirror the whole thing.

Nothing on the host is a trust dependency either way. Every page recomputes its
digests in the reader's browser with Web Crypto and reads the commitments straight
off a public DecentralChain node, not through us. `verify-bundle` is the stronger
check and needs no website at all.

The daily job republishes it when `ANCLA_PUBLISH=1`, alongside `ANCLA_BROADCAST`.
That step lives in the cron rather than in CI because the export can only run
where the mirror is, and the mirror is not on a build server. Without it the
published site is a photograph of whichever day someone last ran the export by
hand, which is a strange thing for a project whose whole claim is a daily record.

Three things bit during setup and are worth knowing before the next deploy:
`railway up` walks up to the git root and applies `.gitignore`, so a deployable
inside an ignored directory uploads almost nothing; Railway's builder honours
`.dockerignore` when it packs the context, so a Dockerfile that excludes itself
disappears before it runs; and the service needs `RAILWAY_DOCKERFILE_PATH` set or
it auto-detects a Node app and tries to build a directory of JSON.

Every anchored publisher is served, not just the first one. `captures`, `bundles`
and `recovery` return all of them with a `source` on each row, and the page has a
country picker that only appears when there is more than one. This was a real hole
rather than a missing feature: Panamá ran the whole pipeline daily — mirrored,
canonicalised, 37 roots on chain — and appeared nowhere on the site that exists to
show it, because every read defaulted to Costa Rica.

A publisher with no canonicalisation schema is deliberately still absent. Honduras
is mirrored and hashed but cannot be turned into records, so there is nothing for a
version browser to show beyond a file size, and showing it beside Costa Rica would
imply a claim we cannot back.

The analytics, OCDS and tender endpoints are deliberately not exported. They need
the SQLite index, they are a different product from the evidence layer, and a
stale copy of them would be worse than none.

## Operating it

The daily job is the product. Every day it does not run is a day of history that
cannot be recovered, because nobody else is keeping it.

```bash
# once
node packages/cli/src/main.ts keygen        # prints the address, never the seed
# fund that address with a small amount of DCC, then:

# daily, after the source refresh at ~13:00 UTC
node packages/cli/src/main.ts watch && \
node packages/cli/src/main.ts anchor --broadcast && \
node packages/cli/src/main.ts anchor --versions --broadcast
```

`scripts/daily.sh` runs all three for every source that has a schema. The third one
is what makes a missed day survivable: the roots it writes are addressed by the
archive's own hash rather than by the calendar, so a copy captured on a day the job
did not run still gets sealed the next time it does. A rewritten closed month also
leaves a bundle on disk, and the report names its digest and the command to commit it.

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

# the commitment to a published row-level diff, straight from a public node
curl https://mainnet-node.decentralchain.io/addresses/data/\
3DTwG5ZydbJDuLdEmwfgDEH3NuwDrgwQFtF/diff_202608_7cc3a068c019_2a8f44f57e6b

# rebuild that diff from the two archives and compare
node packages/cli/src/main.ts verify-bundle 202608
```

The browser verifier at `apps/verifier/index.html` does the same check without a
backend and without this repo: paste a manifest, and it recomputes the digest with
Web Crypto and reads the committed one off a public node itself. What it cannot do is
rebuild the bundle from two 50 MB archives — that is `verify-bundle`, and the page
says so rather than implying otherwise.

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

409 tests across 36 files, plus 12 real-data tests that skip cleanly without a mirror. The ones that matter most:

- canonicalization determinism, and number normalization against the integer-corruption bug
- RFC 6962 proofs at odd and even tree sizes, and the duplicate-leaf case
- **parity between the browser verifier and the Node implementation**, because if those two drift, every published proof silently stops verifying
- the same parity for the bundle digest, across all three implementations. The
  standalone verifier's copy is not re-typed into the test: the test slices the real
  source out of `apps/verifier/index.html` and evaluates it, so editing the page and
  forgetting the package fails here rather than in a reader's browser
- **an archive on disk cannot be replaced**, tested against a live HTTP server. A
  forced refetch of identical bytes must leave the original inode untouched, and two
  different bodies under one Last-Modified must become two files
- a bundle rebuilt from the two real 202608 archives must reproduce its digest byte
  for byte, and every reported silent revision must name a field that actually differs
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
