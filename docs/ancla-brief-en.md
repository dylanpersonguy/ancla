Costa Rica publishes every public contract as open data. That published record gets quietly rewritten after the fact, and until August 2026 nobody kept a copy of what it said before. Ancla fixes that, and in doing so it assembled something more valuable: the only complete, verifiable history of Costa Rican procurement, 2010 to 2026. It is running now on DecentralChain mainnet and costs under a dollar a year.

## 1. What it is

Three things stacked on each other.

**A tamper-proof camera.** Every day it photographs the entire published procurement record, reduces it to a single fingerprint, and stamps that on a public blockchain. If anyone edits a published contract afterward, the fingerprint no longer matches and anyone can prove it.

**A database nobody else has.** The government publishes in monthly chunks, so a contract opened in March and paid in November appears complete in neither file. We stitched all 189 months into one searchable history: 6 million rows. This sounds like plumbing and is actually the valuable part.

**Analysis on top.** Which markets have no real competition, who bids against whom, which institutions are outliers, and who pays on time.

In one sentence: *we built the only complete, verifiable copy of Costa Rica's procurement history, and the tools that read it.*

## 2. The problem

Costa Rica's open data is genuinely good. Free, no login, fifteen years deep, updated daily. The problem is not secrecy.

The problem is that the published version is the only version, and it changes.

Archives should freeze when their month ends. These did not:

| Rewritten on | Months affected | Range |
|---|---|---|
| 2024-09-20 | 7 | 202401–202408 |
| 2024-10-03 | 1 | 202407 |
| 2024-10-04 | 1 | 202409 |
| 2025-05-06 | 3 | 202502–202504 |
| 2026-08-10 | 2 | 202606–202607 |

Fourteen closed months revised between 2024 and 2026, none during the normal daily window, none with any public statement of what changed. July 2024 was rewritten twice, six weeks apart.

Some of this is probably routine correction. That is exactly the difficulty: **there was no way to tell.** No record existed of what those files said before. The Internet Archive has zero captures. No university or newsroom kept a mirror.

From 27 August 2026 that is no longer true.

## 3. How it works

```
   Government publishes daily
            |
   we copy it, never overwriting
            |
   fingerprint every record
            |
   fold into one 64-character value
            |
   write that value to DecentralChain
            |
   stitch every month into one history
            |
   analyse, alert, serve
```

Nothing sensitive goes on the blockchain. No documents, no names, no amounts. Just a fingerprint, a count, and a date. The chain's only job is to hold that value somewhere nobody can quietly change it, with a timestamp nobody controls.

Verification runs in the reader's own browser against a public node. Nobody has to trust us, which is the only arrangement an auditor accepts.

## 4. Why DecentralChain

The fair challenge is why use a blockchain at all. The alternative is a signed database, and it fails for one reason: the signature is worth only as much as trust in whoever holds the key, and the file can be replaced silently. If we vouch for our own archive, a reader has to trust us. The whole point is evidence that requires trusting nobody.

| | Bitcoin | Ethereum | Permissioned | DecentralChain |
|---|---|---|---|---|
| Independent of the audited party | yes | yes | **no** | yes |
| Predictable near-zero cost | partly | **no** | yes | yes |
| Queryable named state | **no** | yes | yes | yes |
| Contract a lawyer can audit | n/a | **no** | varies | yes |
| Costa Rican jurisdiction | no | no | varies | **yes** |

**Not a permissioned chain.** This is what Peru runs and what a 2025 academic paper proposed for Costa Rica. A ledger operated by the institution being audited is not a witness. If the Ministry runs the nodes, the Ministry can rewrite the ledger.

**Not Bitcoin.** A superb timestamp and nothing else. No way to ask which root was committed for June 2026. Worth adding later as a free backstop.

**Not Ethereum.** Fees are set by auction, so operating cost is unpredictable. And naming Ethereum in a government meeting turns the meeting into one about tokens.

**DecentralChain** costs a fixed 0.001 DCC per day with no fee auction, stores named values natively without needing a smart contract, uses a contract language that provably cannot loop so a Contraloría lawyer can read all thirty lines, and has a Costa Rican jurisdiction and a validator set that can be publicly named.

## 5. It already works

| | |
|---|---|
| Network | DecentralChain mainnet |
| First anchor | 27 August 2026, block 2,316,909 |
| Records committed | 301,189 |
| Cost | 0.001 DCC |

A real contract, `CE201907001175|01`, produces a 19-step proof that reproduces the root fetched independently from a public node. Anyone can repeat that today without our help.

## 6. What the data already shows

**41.1% of Costa Rican public tenders receive exactly one bid.** That is 106,190 of 258,420. Single-bidder rate is the primary red flag the OECD and World Bank use to screen procurement systems.

| Year | Tenders | Single bidder |
|---|---|---|
| 2015 | 2,485 | 27.4% |
| 2018 | 12,497 | 41.1% |
| 2022 | 38,190 | 43.3% |
| 2025 | 25,975 | 42.5% |

It rose sharply to 2018 and has held at 42 to 43% since. The figure is conservative: consortium members currently count as separate bidders, so resolving them pushes it up.

Equally important is what the platform refuses to answer. Award-to-payment duration is 99.8% incomplete, so we decline to publish a number. About 59% of product codes are not price-comparable because of unit-of-measure problems in the source. Refusing is the output. In this business the refusals are what make the answers worth anything.

## 7. How we make money

The anchoring is the long game. The database sells now.

**Suppliers, the fastest path.** 1,845 companies bid twelve or more times a year. They are named in the data with their full history. Today they bid blind: they do not know who beat them, at what price, or which buyers actually pay on time. A subscription at $150 a month answers that daily.

**Dispute evidence.** Around 19,000 formal objections are filed each year by 5,469 distinct firms, and roughly 30% succeed. When a tender changes after publication, the affected bidders have a limited window to act. An alert with a deadline attached, and a signed exhibit behind it, is worth real money to a company already paying a lawyer.

**Institutions.** 461 entities buy things. Sell them a pre-audit self-check: what the auditors will find, before they arrive. Longer sales cycle, larger contract.

| Line | Annual range | Basis |
|---|---|---|
| Supplier subscriptions | $330k – $665k | 10–20% of 1,845 at $150/mo |
| Institutional contracts | $460k – $920k | 5–10% of 461 at $20k/yr |
| Dispute packages | $100k – $300k | 3–8% of ~19,000 objections |
| **Total** | **$0.9M – $1.9M** | |

At normal software multiples that is a $3M to $11M business in one small country. Panama, Guatemala, Honduras, and El Salvador run the same system, and Peru and Colombia are far larger, which plausibly puts a regional footprint at $3M to $10M a year.

## 8. What is honest about this

**Nobody has paid us anything yet.** Every figure in section 7 is arithmetic until a supplier says yes. The first real step is calling thirty of those 1,845 firms, not building more software.

**The archives are public.** A competitor could download all 189 today and rebuild the index within a week. What they cannot obtain is what those archives said *before* they were rewritten, because we hold the only copy, and provenance, because ours is anchored and theirs is a claim about a file on a disk. So the advantage is near zero looking backward and compounds every day forward. That argues for running the daily job without interruption more than anything else here.

**The claim is narrow on purpose.** Ancla proves a published record did or did not change, from the moment anchoring began. It does not prove a record is accurate, does not detect corruption, and cannot audit the past. It also cannot see contracts that never entered SICOP, and the Contraloría found 27.1% of awarded value in 2021 flowed outside the platform.

**The largest risk is governance, not technology.** Whoever holds the anchoring key writes the record. If that party has a commercial interest in token sales, the first journalist to connect those facts ends the programme. The anchoring account belongs with institutions that have no financial stake in procurement outcomes.

## 9. Where it stands

Running today: the full mirror, the daily job, change detection, the index, the analysis, a REST API, an OCDS export, and a Spanish web app with a public verifier. 306 automated tests pass.

Not yet done: the backfill of all 189 historical roots is prepared but not broadcast, and change detection has not caught a live rewrite because none has happened since we started watching. Based on the record, that occurs about twice a year.

**Next 90 days.** Anchor daily without missing one. Publish the verifier. Publish the single-bidder finding, which is a national story drawn from the government's own data and generates inbound instead of cold calls. Interview thirty frequent bidders and find out whether they will pay.

That last item is the only one that turns any of this from a plan into a business.
