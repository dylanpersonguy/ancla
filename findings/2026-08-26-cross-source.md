# Cross-source reconciliation: tested, and it does not work

**Date:** 2026-08-26
**Question:** can we detect tampering by comparing two independent government
publications of the same procurement records, and thereby produce findings
retroactively instead of waiting 90 days for an anchoring baseline?

**Answer: no.** Where the sources overlap they agree. The idea is dead as proposed.

Two smaller findings came out of the test and are worth pursuing separately.

## What was tested

Three questions, in order.

### 1. Is SIAC bulk-downloadable? No.

The hypothesis needed SIAC, the Contraloría's contractual-activity register, as an
independent record against SICOP. It is not publicly available in bulk.

- The Observatorio has exactly one download page, and it is SICOP only.
- All 25 tables in the Observatorio archives are keyed on `NRO_SICOP`. There is no
  source discriminator and no SIAC-origin field. The "SICOP and SIAC" description
  refers to the web dashboards, not the bulk download.
- The CGR's open-data bundle
  (`cgrfiles.cgr.go.cr/.../datos-abiertos-cgr.zip`, 416 KB) is the Contraloría's own
  institutional transparency data: its budget, salaries, foreign travel, and its own
  procurement. `cp/da-contratacion.csv` holds 31 rows, all of them the CGR buying
  things for itself. It is not the national register.
- SIAC's public interface is an Oracle APEX query application that refuses automated
  requests. No bulk export was found.

**This also kills a second idea.** The CGR's headline finding, that 27.1% of awarded
value flowed outside SICOP, cannot be measured from open data. Contracts that bypassed
SICOP have no `NRO_SICOP` and are therefore absent from the only bulk dataset that
exists. Absence cannot be detected in a dataset that only records presence. Measuring
the bypass requires SIAC, and SIAC is not published.

### 2. Do the sources disagree? No.

A genuine second publication does exist: the Ministerio de Hacienda posts annual bid
data on `datos.go.cr` for 2022 through 2024, as XLSX. The 2024 file is 64 MB, 565,865
rows, published 2026-03-05.

It shares a schema with the Observatorio's `Ofertas` joined to `LineasOfertadas`, so
the two can be compared line by line after mapping `NRO_SICOP` to
`NUMERO_PROCEDIMIENTO` through `DetalleCarteles`.

Result on the 76,322 bid lines present in both:

| Field | Differences | Share |
|---|---|---|
| `CANTIDAD_OFERTADA` | 0 | 0.000% |
| `PRECIO_UNITARIO_OFERTADO` | 887 | 1.162% |

Quantities agree exactly. Every price difference inspected is Hacienda rounding to two
decimal places: `0.0341` to `0.03`, `0.1492` to `0.15`, `2465.689` to `2465.69`. One
class is worth noting because it destroys information rather than blurring it: unit
prices below half a cent round to `0`.

There is no tampering signal here. Two independent publications of the same records
agree.

A caution for anyone repeating this: an early version of this analysis reported 40,845
price mismatches. That was a bug in the comparison, not a finding. `rstrip('0')`
turns `6780000` into `678`. A second pass reported differences that were float64
round-trip noise from Excel (`2619.47` stored as `2619.4699999999998`). Only the third
pass, using exact decimal comparison with a relative tolerance, produced the number
above. Sub-percent findings in this domain are usually your own tooling.

### 3. Is the overlap wide enough? No, and this was the surprise.

| Source | Keyed bid lines |
|---|---|
| Hacienda, 2024 only | 565,345 |
| Observatorio, 2022 through 2024 combined | 320,976 |
| Present in both | 76,322 (13.5% of Hacienda) |

Only 13.5% of the bid lines Hacienda publishes for 2024 appear anywhere in the
Observatorio's archives.

This is not a partitioning artifact. Widening the Observatorio window from 2024 to all
of 2022 through 2024 recovered zero additional matches. Of the 489,023 unmatched keys,
475,477 belong to 2024 procedures, which belong in the 2024 monthly archives by any
partitioning scheme.

It is also not selective. If the omission were censorship of losing bids, unmatched
lines would skew toward ineligible ones. They do not:

| `ELEGIBLE` | Present in Observatorio | Absent from Observatorio |
|---|---|---|
| Sí | 60.6% | 57.9% |
| No | 32.6% | 35.6% |
| No evaluada | 6.7% | 6.5% |

Near-identical distributions. Whatever drives the gap, it is not eligibility.

## The two findings worth keeping

**A completeness gap.** Costa Rica's public procurement open data appears to publish a
small fraction of the bid-line detail the Ministry of Finance itself holds. That is a
transparency-quality finding rather than an integrity one, and it is checkable by
anyone.

Do not publish this yet. One explanation remains untested: the Observatorio's
`LineasOfertadas` may be partitioned on a dimension not yet identified, in which case
the gap is an artifact of how the comparison was framed. Rule that out first. This is
exactly the kind of claim that is easy to make loudly and wrong.

**A field-level omission.** Hacienda publishes `ELEGIBLE`, which records whether a bid
was ruled eligible. The string does not appear in the header of any of the 25
Observatorio tables. Bid eligibility is the crux of most procurement disputes, and it
is absent from the daily public record while sitting in an annual spreadsheet almost
nobody reads.

## Incidental finding: the rewrites came from a different pipeline

The archives rewritten on 2024-09-20 store their CSVs under a `YYYYMM/` directory
inside the zip. Every other archive, before and after, stores them flat at the root.

That is a structural fingerprint. The September 2024 republication was a re-export from
a different tool or pipeline, not an incremental correction to existing data. Worth
knowing when the differ eventually explains what those rewrites changed.

## What this means for the plan

Layer 1 as proposed is dead. There is no retroactive shortcut: no second independent
source, no measurable bypass, no third-party baseline. The Internet Archive holds zero
captures of these archives, so nothing exists to diff against.

Forward-only change detection is therefore the whole product, and the 90-day wait is
real rather than something to engineer around. The mirror completed the same day this
was tested: 189 archives, 3.04 GB, zero errors. That snapshot is the earliest baseline
that will ever exist for Costa Rican procurement, because nobody else kept one.

## Reproduce

```bash
node packages/ingest/src/cli.ts survey     # archive inventory and rewrite events
node packages/ingest/src/cli.ts mirror     # 189 archives, 3.04 GB, ~17 min
```

Hacienda's comparison files, via the CKAN API at `datosabiertos.gob.go.cr`:

```
https://datosabiertos.gob.go.cr/api/3/action/package_search?q=Ofertas
```
