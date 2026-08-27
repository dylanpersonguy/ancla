# Ancla

A public evidence layer for Costa Rican procurement records.

Costa Rica publishes its national procurement record as open data, refreshed daily.
That published record gets rewritten after the fact, and nobody keeps a copy of what
it said before. Ancla snapshots it every day, hashes it, and commits the hash to
DecentralChain. From then on, any change to an already-published record is provable
by anyone, against a timestamp no one controls.

## What this proves, and what it does not

Read this before using anything here.

Ancla proves **tamper-evidence, forward from the moment of anchoring**. That is the
entire claim.

It does not prove honesty. A perfectly anchored corrupt contract is still corrupt.

It cannot audit the past. Anchoring establishes integrity from the day it starts, not
before. Any tool claiming to detect tampering that predates its own first commitment
is comparing a hash against a hash it generated itself, which proves nothing.

It does not flag corruption. It flags change. SICOP records legitimate amendments
explicitly, via `SECUENCIA` and `TIPO_MODIFICACION`, and Ancla excludes those. What
remains is the narrow, interesting class: a published field that changed with no
amendment recorded. Some of those will have innocent explanations too.

Overclaiming is the failure mode that makes work like this worthless. The narrow
claim is the product.

## What we found before writing any of this

The archive source publishes 189 monthly archives going back to December 2010,
3.04 GB in total, refreshed daily around 13:00 UTC.

Surveying every archive's `Last-Modified` against its own month end turns up nine
republication events, where closed months were rewritten in a batch long after they
should have been final:

| Date | Months | Range | Size |
|---|---|---|---|
| 2022-12-06 | 106 | 201012..201910 | 566.8 MB |
| 2022-12-07 | 26 | 201911..202112 | 597.7 MB |
| 2022-12-08 | 11 | 202201..202211 | 422.5 MB |
| 2022-12-09 | 1 | 201212 | 3.0 MB |
| 2024-09-20 | 7 | 202401..202408 | 144.5 MB |
| 2024-10-03 | 1 | 202407 | 13.8 MB |
| 2024-10-04 | 1 | 202409 | 51.1 MB |
| 2025-05-06 | 3 | 202502..202504 | 105.2 MB |
| 2026-08-10 | 2 | 202606..202607 | 105.7 MB |

The December 2022 cluster is the initial load that built the archive. The five later
events are the finding: 14 closed month-archives revised across 2024 to 2026, with no
public record of what changed. July 2024 was rewritten twice.

This is what the archive-level record shows. Which rows changed, and whether any
change was improper, needs the canonicalizer and the baseline. That is the next piece
of work, and it is only answerable going forward.

Reproduce the table yourself:

```bash
node packages/ingest/src/cli.ts survey
```

## Quick start

Requires Node 24 or newer. There is no build step: Node runs the TypeScript
directly. The ingest and canonicalization paths have zero dependencies on purpose,
because a tool that must produce byte-identical output for years should not have a
dependency tree that can drift under it.

```bash
# what the source holds, how big, and what it has rewritten
node packages/ingest/src/cli.ts survey

# mirror every archive. resumable, idempotent, never overwrites
node packages/ingest/src/cli.ts mirror -c 4

# canonicalize archives into Merkle-rooted snapshots
node packages/cli/src/main.ts snapshot

# compare a month's two most recent versions
node packages/cli/src/main.ts diff 202607

# Merkle proof for one record
node packages/cli/src/main.ts prove 202512 Contratos "CE201907001175|01"

# commit today's roots to DecentralChain (dry run without --broadcast)
node packages/cli/src/main.ts anchor
```

The mirror lives outside the repo. Default `$HOME/ancla-data`, override with
`ANCLA_DATA`. Keep it out of git.

## How it works

```
Observatorio bulk CSV        daily, ~13:00 UTC, 189 monthly archives
        |
   [ ingest ]                fetch, hash, store with provenance, never overwrite
        |
   [ canonicalize ]          per record: stable composite key, two digests
        |                      byteHash   every field exactly as published
        |                      valueHash  volatile fields dropped, numbers normalized
   [ merkle ]                RFC 6962 tree over sorted records, one root per archive
        |
   [ anchor ]                one DataTransaction: StringEntry per month root
        |
   [ differ ]                added | recordedAmendment | silentRevision
        |                    | reformatted | removed
   [ verifier ]              client-side proof check against the node REST API
```

**Two digests, not one.** The byte hash is the evidence: any change at all moves it.
The value hash is the judgement: it ignores reformatting so the differ can tell
`1.000` becoming `1` apart from a price actually changing. Collapsing these into one
number is how a project like this ends up reporting forty thousand discrepancies that
do not exist. That happened during development. See
[findings/2026-08-26-cross-source.md](findings/2026-08-26-cross-source.md).

**The chain stores roots and nothing else.** No on-chain proof verification, no clever
contract. `contracts/ancla.ride` is about thirty lines of logic. Proofs are checked
client-side, so the contract cannot be the thing that breaks, and a lawyer can be
walked through all of it.

**Canonicalization is versioned and frozen.** `CANON_VERSION` is part of every anchor.
Changing the rules without changing the version silently invalidates every anchor that
came before, which is the one failure this project cannot survive.

**No salt.** The plan called for salted hashes. We do not salt, and the reason belongs
in the open: the verifier needs the salt to check anything, so it has to be published
with the root, which makes it useless against the attack it was meant to stop. The
records are already public open data. Salting here would be ceremony.

## What the data does to a canonicalizer

Real properties of the source, all handled and all covered by tests:

- Archives rewritten on 2024-09-20 nest their CSVs under `YYYYMM/`. Every other
  archive stores them flat. Both must canonicalize identically.
- `SancionProveedores` is comma-delimited. The other 24 tables use semicolons.
- `NRO_RECURSO` does not identify an appeal on its own: one appeal objects to several
  lines. The key is `NRO_RECURSO` plus `LINEA_OBJETADA`.
- Three tables emit literal duplicate rows, `SistemaEvaluacionOfertas` at about 75%.
  Those are content addressed with an occurrence index so duplicates stay individually
  addressable and a change in the number of copies is visible.

## Tests

```bash
node --test packages/*/test/*.test.ts apps/*/test/*.test.ts
```

51 tests. The ones that matter most: canonicalization determinism, number
normalization against the integer-corruption bug, RFC 6962 proofs at odd and even tree
sizes, and parity between the browser verifier and the Node implementation. If those
two implementations ever drift, every published proof silently stops verifying.

## Source

[Observatorio de Compra Pública](https://www.observatoriocomprapublica.go.cr/descargas-sicop/),
which republishes SICOP (Ministerio de Hacienda) and SIAC (Contraloría General de la
República) as monthly ZIP archives of semicolon-delimited CSVs on public Azure blob
storage. Published explicitly for reuse: "análisis, seguimiento, fiscalización y el
desarrollo de nuevas aplicaciones."

Do not scrape `sicop.go.cr` directly. Its open-data module is a stateful WebLogic JSP
that returns 403 to a plain fetch and 500 with a browser user-agent. The Observatorio
path is the same data, already flattened.

## Status

Working end to end: ingest, mirror, provenance manifest, republication survey,
canonicalizer, Merkle trees, differ, anchor transaction builder, node client, RIDE
contract, and the public verifier.

Not yet done:

- The anchor account is not deployed. `contracts/ancla.ride` still carries a
  placeholder owner key, and no root has been committed to mainnet. That waits on the
  governance decision about who holds the anchor account, which is the real blocker
  and not a technical one.
- The differ has no real pair to compare yet. It is covered by tests against synthetic
  mutations, and it produces its first genuine result the next time the source rewrites
  a month. Based on the survey, that has happened five times since 2024.

## License

MIT. The point of this project is that anyone can check the work.
