Costa Rica publishes its national procurement record as open data, refreshed every day. That published record is quietly rewritten after the fact, and until now nobody kept a copy of what it said before. Ancla takes a snapshot of the whole record every day, reduces each of roughly 300,000 monthly entries to a fingerprint, combines those into a single 64-character value, and writes that value to DecentralChain. From then on, anyone can prove whether a contract, a bid, or a tender still says what it said on the day it was published. No permission is needed from any institution, nothing sensitive goes on the blockchain, and verification requires trusting nobody, including us. The first commitment went live on 27 August 2026, in transaction `5QcP1tNimcmt3993fNmyACZ1JmZEaMoMbacUHq7VBxRG`.

## 1. What this document covers

Ancla is a working system, not a proposal. This explains what problem it solves, how it works, what it can and cannot prove, who would pay for it, and what it costs to run. Section 9 covers pricing and buyers. Sections 6 and 11 cover the limits and the ways it can fail, because a system whose entire value is evidentiary has to be honest about its own boundaries before anyone else tests them.

## 2. The problem

### 2.1 Costa Rica already publishes the data

Costa Rica runs SICOP, the Sistema Integrado de Compras Públicas, operated by RACSA for the Ministerio de Hacienda. Law 9395 made it mandatory for public contracting. A companion project, the Observatorio de Compra Pública, republishes that data in bulk as monthly archives of CSV files, updated daily at around 13:00 UTC, going back to December 2010.

This is genuinely good open data. It is free, needs no login, and is published explicitly for reuse: *"análisis, seguimiento, fiscalización y el desarrollo de nuevas aplicaciones."* One command downloads the entire national procurement history.

| Property | Value |
|---|---|
| Monthly archives available | 189 |
| Coverage | December 2010 to present |
| Total size | 3.04 GB compressed |
| Tables per archive | 25 |
| Records in a typical month | ~300,000 |
| Refresh | daily |

### 2.2 The record changes after publication

Archives normally stop changing on the last day of the month they cover. Some do not.

Checking every archive's last-modified timestamp against its own month end, and grouping by the day the change happened, produces nine republication events.

| Date | Months rewritten | Range | Size |
|---|---|---|---|
| 2022-12-06 | 106 | 201012–201910 | 566.8 MB |
| 2022-12-07 | 26 | 201911–202112 | 597.7 MB |
| 2022-12-08 | 11 | 202201–202211 | 422.5 MB |
| 2022-12-09 | 1 | 201212 | 3.0 MB |
| **2024-09-20** | **7** | **202401–202408** | **144.5 MB** |
| **2024-10-03** | **1** | **202407** | **13.8 MB** |
| **2024-10-04** | **1** | **202409** | **51.1 MB** |
| **2025-05-06** | **3** | **202502–202504** | **105.2 MB** |
| **2026-08-10** | **2** | **202606–202607** | **105.7 MB** |

The December 2022 cluster is the original load that created the archive. Ignore it.

The five later events are the finding: **14 closed month-archives revised between 2024 and 2026**, none of them during the normal daily window, none accompanied by any public record of what changed. July 2024 was rewritten twice, six weeks apart.

There is a further detail worth noting. The archives rewritten on 20 September 2024 store their CSV files inside a `YYYYMM/` folder within the zip. Every other archive, before and after, stores them at the top level. That is a structural fingerprint: those files were re-exported by a different tool, not patched in place.

### 2.3 Nobody kept a baseline

None of this is necessarily improper. Some of it will be routine backfill, and some corrections are legitimate and expected. That is exactly the problem. **There is no way to tell,** because no record exists of what those archives said before they were rewritten.

We checked. The Internet Archive holds zero captures of these files. No research group, no newsroom, no agency has published a historical mirror. Before Ancla, the last-modified timestamp was the only evidence that anything had happened at all, and it says nothing about what.

That is the gap. Not that the data is hidden, but that the published version is the only version, and it is mutable.

## 3. Why the obvious fixes do not work

Three approaches have been tried in Latin America. Understanding why they failed shapes what Ancla is.

### 3.1 Replacing the procurement system

The most direct fix is to rebuild SICOP on a tamper-proof foundation. This is a multi-year sovereign IT procurement. RACSA holds the operating contract, and a tender of that size goes to Indra or Accenture. A small team does not win it and should not try.

### 3.2 Putting the ledger inside the institution

A 2025 academic paper proposed exactly this for Costa Rica, using Hyperledger Fabric, a permissioned blockchain. The design has a flaw that no amount of engineering fixes: **a ledger operated by the institution being audited is not an independent witness.** If Hacienda runs the nodes, Hacienda can rewrite the ledger.

This is not hypothetical. Of three comparable projects in the region, two never left pilot.

| Programme | Approach | Outcome |
|---|---|---|
| Colombia (WEF, IDB, Procuraduría) | permissioned proof of concept | did not pass pilot |
| Aragón, Spain | permissioned pilot | did not pass pilot |
| Peru (Stamping.io on LACChain) | permissioned, IDB-backed | reached production |

Peru's system works, and it is the closest thing to a competitor. But it anchors from *inside* the procurement system's own write path. The party that creates the record also commits the fingerprint, so an insider who edits a record can simply commit the edited version. The evidence is exactly as trustworthy as the operator.

Ancla observes from outside and integrates with nothing. The observer is independent of the writer. That is a weaker system in one respect, covered in section 6, and a stronger one in the respect that matters for evidence.

### 3.3 Claims that do not survive checking

The same 2025 paper reports that procurement corruption costs Costa Rica over $135 million a year, and that a blockchain approach cut processing time 37.5%. We traced both.

The $135 million figure is attributed to a Contraloría report, DFOE-CAP-SGP-00005-2021. The string "135" does not appear in that report. The nearest real number is a single case, Caso Cochinilla, at roughly ₡78 billion across three years. The 37.5% figure comes from a simulation on a test network. Nothing was deployed.

We mention this because credibility is the entire product. A system that exists to prove records were not altered cannot afford to cite numbers that fall apart when someone checks them. Every figure in this document traces to a primary source, and section 13 lists them.

## 4. What Ancla does

Once a day, Ancla downloads Costa Rica's entire published procurement record, reduces it to a single fingerprint, and writes that fingerprint to a public blockchain.

That is the whole idea. Everything else is detail about doing it in a way that stands up.

The fingerprint is built so that changing any one field, in any one of roughly 300,000 records, changes the final value. If the published record is later altered, the new fingerprint will not match the one already committed, and the mismatch is provable by anyone against a timestamp nobody controls.

Three properties make this useful:

**It needs nobody's permission.** The data is already public and explicitly licensed for reuse. No integration, no memorandum of understanding, no procurement process. It was running the day it was written.

**Nothing sensitive goes on chain.** Only a 64-character fingerprint. No documents, no names, no amounts. The blockchain never sees the data, which keeps the whole thing clear of Costa Rica's data protection law in a way a document-storage design would not be.

**Verification requires trusting nobody.** The checking code runs in the reader's own browser against a public blockchain node. Nobody has to take our word for anything, which is the only arrangement an audit institution can accept.

## 5. How it works

Five steps, once a day.

```
  Observatorio bulk archives          daily, public, no auth
            |
     1. ingest                        download, fingerprint, store forever
            |
     2. canonicalize                  reduce each record to two fingerprints
            |
     3. combine                       fold ~300,000 into one 64-char root
            |
     4. anchor                        write the root to DecentralChain
            |
     5. verify                        anyone re-checks, in their own browser
```

### 5.1 Ingest: keep everything, overwrite nothing

Each archive is stored under a filename built from its publication timestamp and its own content fingerprint. When a month is rewritten, the new version lands *beside* the old one rather than replacing it. A month's folder becomes its revision history.

This is the part with a real deadline attached. Every day the system does not run is a day of history that cannot be recovered, because nobody else is keeping it.

### 5.2 Canonicalize: two fingerprints, not one

Each record gets reduced to a stable identity and two separate fingerprints.

| Fingerprint | Covers | Answers |
|---|---|---|
| `byteHash` | every field exactly as published | did anything at all change? |
| `valueHash` | numbers normalized, timestamps dropped | did a *value* change? |

The distinction matters more than it sounds. A price published as `1.000` and later republished as `1` is the same price, printed differently. A system with one fingerprint reports that as tampering, floods its own output with false alarms, and gets ignored.

This is not a theoretical concern. During development, a first attempt at comparing two data sources reported 40,845 discrepancies. Every one was an artifact of the comparison code, not the data. That failure is documented in the repository rather than buried, and the two-fingerprint design is the direct response to it.

The rules for producing these fingerprints are frozen and version-stamped as `ancla-canon-1`. Changing them without changing the version would silently invalidate every commitment made before, which is the one failure the system cannot survive.

### 5.3 Combine: one value for the whole month

The record fingerprints are sorted and folded together into a single 64-character root, using the same construction that underpins the public logs browsers use to detect forged website certificates.

The useful property: proving one record belongs to a set of 300,000 takes about 19 short values, not the whole set. A supplier can prove their contract was in the published record without handling a 40 MB file.

### 5.4 Anchor: what actually goes on the blockchain

One transaction. Three entries.

```
root_2026-08-27_202512 = 4a58b302bf5f1311b2d90526d5b8ad0535fac14d688045e98dda7bb965001198
meta_2026-08-27_202512 = ancla-canon-1|301189|ce92277ce996f610...
latest                 = 2026-08-27
```

The blockchain's only job is to hold that value somewhere it cannot be quietly changed, with a timestamp nobody controls. There is no complex smart contract, no token, no on-chain computation. The contract is about thirty lines and refuses to overwrite a value that already exists.

That simplicity is deliberate and it is an argument, not a shortcut. A lawyer at the Contraloría can be walked through thirty lines. Nobody is going to audit a thousand-line smart contract on behalf of a state procurement system.

### 5.5 Verify: in the reader's own browser

Someone checking a record needs three things: the record, a short proof, and the root from the blockchain. The verifier page recomputes the fingerprint locally and compares. If they match, that record is exactly as published on that date. If they do not, it changed, and the blockchain says when the original was committed.

The verification code contacts the public blockchain node and nothing else. It does not contact us. That is the point.

### 5.6 A real example

This is not illustrative. It happened.

| Step | Value |
|---|---|
| Record | contract `CE201907001175\|01`, December 2025 |
| Records in that month | 301,189 |
| Proof length | 19 steps |
| Root committed | `4a58b302bf5f1311b2d90526d5b8ad0535fac14d688045e98dda7bb965001198` |
| Transaction | `5QcP1tNimcmt3993fNmyACZ1JmZEaMoMbacUHq7VBxRG` |
| Block height | 2,316,909 |
| Cost | 0.001 DCC |

Anyone can fetch that root from a public node and confirm the contract was in Costa Rica's published procurement record on 27 August 2026, in exactly that form.

## 6. What it proves, and what it does not

This section exists because overclaiming is how projects like this become worthless, and because volunteering your own limits before anyone asks is the difference between a vendor and a witness.

**Ancla proves that a published record did or did not change, forward from the moment of anchoring.** That is the claim. It is narrow on purpose.

It does **not** prove a record is accurate. A perfectly anchored corrupt contract is still corrupt.

It does **not** detect corruption. It detects change. SICOP records legitimate amendments explicitly, and Ancla excludes those. What is left is the interesting category: a published field that changed with no amendment recorded. Some of those will have innocent explanations too.

It **cannot audit the past.** Anchoring establishes integrity from the day it starts. Anything that happened to the record before 27 August 2026 is beyond reach, and no amount of cleverness recovers it. Any system claiming otherwise is comparing a fingerprint against one it generated itself, which proves nothing.

It only sees **what gets published.** Contracts that never entered SICOP are invisible. The Contraloría found that 27.1% of awarded value in 2021 flowed outside the platform entirely, and Ancla cannot measure that, because you cannot detect an absence in a dataset that only records what is present.

## 7. What is live today

| Component | Status |
|---|---|
| Historical mirror | 189 archives, 3.04 GB, complete |
| Canonicalization | working, version `ancla-canon-1` |
| Merkle trees and proofs | working, 51 automated tests passing |
| Change detection | working, tested against real archive data |
| Daily watch job | working, exits with an alert code on a material change |
| Anchor to mainnet | **live**, first root committed 27 August 2026 |
| Public verifier | working, browser-side |
| Anchoring account | funded, roughly two and a half years of runway |

Roughly 2,800 lines of code. No runtime dependencies in the parts that must keep producing identical results for years, which is a deliberate choice: a dependency tree is a thing that can change underneath you, and this system's value depends on it not doing that.

Two things are not done. Change detection has not yet caught a live rewrite, because none has happened since the mirror was taken, and the historical backfill of all 189 roots is still processing. Neither is a design problem; both resolve with time.

## 8. Who this is for

Four audiences, with different reasons to care.

### 8.1 Suppliers who bid on public contracts

This is the group with money and motive, and the one most likely to pay.

In 26 days of August 2026, suppliers filed **1,357 formal objections** to procurement decisions. That is roughly 19,000 a year. Each one is a company with a lawyer, a grievance, and a budget, formally contesting an outcome.

Tender documents carry modification dates. A supplier who can prove *the tender said X when I bid and says Y now* has a filing exhibit, not an argument. Today they have no way to obtain that proof, because the only published version is the current one.

Governments do not pay to be audited. Losing bidders pay to win appeals.

### 8.2 The Contraloría General de la República

The CGR is the natural champion, and the wrong first customer.

They wrote the report documenting that 27.1% of awarded value bypassed SICOP six years after the platform became mandatory, and that only 9 of 182 institutions used it through to the final stage. Ancla operationalizes their own finding. But they are an audit institution with a modest procurement budget, and approaching them as a buyer rather than as a partner misreads the relationship.

### 8.3 Journalists and civil society

A continuously updating, independently verifiable feed of *records that changed after publication* is a story generator. Groups already working this data, including the Todos los Contratos project at UCR and ACCESA, are collaborators and credibility rather than customers.

### 8.4 Institutions that want to prove their own integrity

Municipalities and autonomous institutions have independent procurement authority, and one mayor can say yes. For an institution that is doing things correctly, a public verification portal carrying its own name is a reputational asset. This is the path to institutional revenue, and it starts small and local rather than at the ministry.

## 9. What it could sell for

Everything in this section is a set of assumptions to test, not a measurement. The numbers describing Costa Rican procurement are real and sourced. The pricing is a model.

### 9.1 The market, measured

| Quantity | Value | Source |
|---|---|---|
| Formal supplier objections, annualized | ~19,000 | Observatorio bulk data, Aug 2026 |
| Awarded value outside SICOP, 2021 | ₡542,505 million | CGR |
| Share of awarded value outside SICOP | 27.1% | CGR DFOE-CAP-SGP-00005-2021 |
| Institutions using SICOP to final stage | 9 of 182 | CGR |
| Registered suppliers | tens of thousands | Observatorio supplier registry |

### 9.2 Three revenue lines

**Evidence subscription for suppliers.** Continuous monitoring of the tenders a company bids on, with alerts when terms change after publication. Comparable tender-intelligence services in the region price between $40 and $400 per month. At $75 per month and 300 subscribers, that is $270,000 a year. Three hundred subscribers is under 2% of the firms that file an objection annually.

**Per-dispute evidence package.** A one-off, court-ready proof for a specific procurement, produced on demand. Against legal fees for a formal objection, $200 to $600 is a rounding error for the client. At 1,000 packages a year, the low end is $200,000. Capturing 5% of annual objections gets you there.

**Institutional infrastructure contract.** A named public verification portal for a municipality, university, or utility, priced as infrastructure with a service level agreement, never as tokens. Comparable civic transparency contracts in the region run $15,000 to $60,000 a year. Five institutions at $30,000 is $150,000.

### 9.3 What a realistic first three years might look like

| Year | Focus | Range |
|---|---|---|
| 1 | evidence feed, first paying suppliers, one institution | $30k – $80k |
| 2 | supplier subscriptions at scale, two to four institutions | $150k – $350k |
| 3 | institutional contracts plus first regional expansion | $400k – $900k |

Treat these as a hypothesis with a clear falsification test. The one number that decides everything is whether a supplier who loses a bid will pay for proof that the terms changed. That is answerable in a month by talking to twenty firms that filed an objection this year, and it should be answered before anyone builds a sales motion on top of it.

### 9.4 The regional multiple

Panama, Guatemala, Honduras, and El Salvador run structurally identical systems: PanamaCompra, Guatecompras, HonduCompras, COMPRASAL. The problem, the data shape, and the buyer are the same. Nothing about Ancla is specific to Costa Rica except the ingest adapter.

This is also the only version of the story where a Central American blockchain is a structural fact rather than a marketing line, and it is far more defensible than competing on liquidity with chains that have more of it.

## 10. What it costs to run

| Item | Cost |
|---|---|
| Blockchain fee per daily anchor | 0.001 DCC |
| Annual anchoring cost | ~0.37 DCC |
| Storage | 3.2 GB plus ~50 MB a month |
| Compute | one scheduled job a day |
| Data access | free and public |

The system currently holds enough balance for roughly two and a half years of daily anchoring. The dominant cost of this project is people, not infrastructure.

## 11. What could go wrong

**Governance, and it is the largest risk by a wide margin.** Whoever controls the anchoring account writes the roots. A procurement-integrity system is only as credible as the independence of the party holding that key. If the same organization has a commercial stake in blockchain token sales, the first competent journalist to connect those two facts ends the programme, and no amount of engineering survives that. The fix is structural rather than technical: the anchoring account belongs with a named set of institutions that have no financial interest in procurement outcomes.

**Overclaiming.** Covered in section 6. The narrow claim is the product.

**Rule drift.** If the fingerprinting rules change without a version change, every earlier commitment becomes unverifiable. The version is stamped into every anchor for this reason, and released versions are never modified.

**Source dependency.** The whole pipeline reads from one public endpoint we do not control. The full mirror is the mitigation, and a second ingest path is worth building before any institutional pilot.

**Availability.** If the chain stops producing blocks, anchoring stops. A free secondary timestamp to Bitcoin is a cheap backstop worth adding.

**Legal.** Costa Rica's Ley 8968 governs personal data, and a replacement bill closer to European rules has been before the legislature since 2022. The exposure is small, because Ancla anchors fingerprints of data the state already published deliberately. Worth an hour of Costa Rican counsel before the first institutional pilot; not a blocker now.

## 12. What happens next

**Now through 90 days.** Anchor daily without interruption. Complete the historical backfill of all 189 roots. Publish the verifier at a public address. Talk to twenty suppliers who filed an objection this year and find out whether they would pay for proof.

**Three to nine months.** Catch and publish the first live rewrite. Based on the record, republication events occur roughly twice a year, so this is a matter of waiting with an instrument running. Sign one institution, most plausibly a municipality or a university, since one decision-maker can say yes.

**Nine to eighteen months.** Approach the Contraloría as a partner, RACSA with an integration specification, and Hacienda as the budget holder. These are three different conversations and merging them kills all three.

**Beyond.** The same system pointed at Panama, Guatemala, Honduras, and El Salvador.

The near-term value is already banked regardless of how that goes. From 27 August 2026, Costa Rica's published procurement record has a witness it did not have before, and the cost of keeping it is under a dollar a year.

## 13. Sources

Every figure in this document traces to one of these.

1. Observatorio de Compra Pública, SICOP bulk downloads. `observatoriocomprapublica.go.cr/descargas-sicop/`
2. Contraloría General de la República, DFOE-CAP-SGP-00005-2021. Source of the 27.1% and the 9-of-182 findings
3. Diario Extra, on ₡542,505 million in purchases outside SICOP
4. World Economic Forum, *Exploring Blockchain Technology for Government Transparency*. The Colombia programme
5. IDB Lab, LACChain and LACNet becoming LNet, September 2025. The Peru programme
6. OECD Digital Government Index 2025, Costa Rica at 0.45 against a 0.70 average, up from 0.22
7. Open Government Partnership commitment CR0052, open contracting standards in SICOP
8. Silva-Atencio and Salas-Castro, LEIRD 2025. The paper whose figures are discussed in section 3.3 and used for nothing
9. Ancla repository, `findings/2026-08-26-cross-source.md`. Method and full numbers for the comparison in section 5.2
10. DecentralChain mainnet transaction `5QcP1tNimcmt3993fNmyACZ1JmZEaMoMbacUHq7VBxRG` at height 2,316,909
