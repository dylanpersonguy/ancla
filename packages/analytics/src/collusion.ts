/**
 * Bid-pattern screens.
 *
 * Read this before reading any output from this file.
 *
 * These are SCREENS. A screen sorts a large population so a human can look at
 * the top of the list first. A high score means "worth looking at". It does not
 * mean collusion, it is not evidence of collusion, and no output of this module
 * should ever be described as collusion detected. Every pattern here has an
 * innocent explanation that occurs constantly in real procurement: markets with
 * three suppliers produce the same three bidders every time, a firm that
 * specialises in one product code loses to the same competitor because that
 * competitor is cheaper, and a distributor reselling the same manufacturer's
 * price list produces stable percentage gaps by arithmetic.
 *
 * Two design rules follow from that.
 *
 * First, every screen returns the tender IDs behind its score. A score with no
 * evidence trail is unfalsifiable, and unfalsifiable claims about a government
 * are how this kind of work gets discredited.
 *
 * Second, the pairwise screens attach a probability and then adjust it for the
 * number of pairs tested. Supplier A losing to supplier B four times in a row is
 * a one-in-sixteen event, and a run over ten thousand pairs will turn up
 * hundreds of them by chance alone. The Bonferroni-adjusted p-value is the
 * number to sort on. The raw one will mislead you.
 */

import { query } from '../../core/src/db.ts';
import { binomialTailGE, bonferroni, coefficientOfVariation, evenness, median } from './stats.ts';
import { type Db, type Window, LATEST_AWARD_LINES, dateExpr, missingInputs } from './sql.ts';

export const SCREEN_DISCLAIMER =
  'This is an indicator, not a finding. A high score means the pattern is unusual enough to be worth a human ' +
  'checking the listed tenders. Concentrated markets, product specialisation and shared price lists all produce ' +
  'these patterns without any agreement between suppliers.';

export interface CollusionOptions extends Window {
  /** Minimum repeated observations before a pattern is reported at all. */
  minTenders?: number;
  /** Rows returned per screen. */
  limit?: number;
  /**
   * Significance cutoff for the screens that compute one. A pair whose adjusted
   * p-value is above this is not reported. Set it high to see everything, but
   * then the output is a ranking, not a shortlist.
   */
  alpha?: number;
  /** Rotation: smallest group worth calling a group. Two suppliers is not a ring. */
  minGroupSize?: number;
  /** Rotation: minimum share of each member's bidding that happens inside the group. */
  minExclusivity?: number;
}

export interface ScreenResult<E> {
  screen: string;
  /** What the screen looks for, in one sentence. */
  looksFor: string;
  /** Rows examined before filtering. Context for the hit count. */
  population: number;
  /** Independent comparisons made, for the multiple-testing adjustment. */
  testsPerformed: number;
  hits: E[];
  disclaimer: string;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Shared extraction
// ---------------------------------------------------------------------------

interface TenderBidders {
  nroSicop: string;
  cedulaInstitucion: string | null;
  bidders: string[];
  winners: Set<string>;
  decided: boolean;
}

function scopedTenders(db: Db, opts: CollusionOptions): TenderBidders[] {
  const pubExpr = dateExpr(db, 'tender', 'fecha_publicacion', 't');
  const clauses = ['1=1'];
  const params: unknown[] = [];
  if (opts.from) {
    clauses.push(`${pubExpr} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`${pubExpr} <= ?`);
    params.push(opts.to);
  }
  if (opts.month) {
    clauses.push('t.source_month = ?');
    params.push(opts.month);
  }
  if (opts.institution) {
    clauses.push('t.cedula_institucion = ?');
    params.push(opts.institution);
  }

  const bids = query<{ nroSicop: string; cedulaInstitucion: string | null; cedulaProveedor: string }>(
    db,
    `SELECT t.nro_sicop AS nroSicop,
            t.cedula_institucion AS cedulaInstitucion,
            b.cedula_proveedor AS cedulaProveedor
       FROM tender t
       JOIN bid b ON b.nro_sicop = t.nro_sicop
      WHERE ${clauses.join(' AND ')}
        AND b.cedula_proveedor IS NOT NULL AND trim(b.cedula_proveedor) <> ''
      GROUP BY t.nro_sicop, b.cedula_proveedor`,
    params,
  );

  const awards = query<{ nroSicop: string; cedulaProveedor: string }>(
    db,
    `SELECT DISTINCT a.nro_sicop AS nroSicop, a.cedula_proveedor AS cedulaProveedor
       FROM award_line a
       JOIN tender t ON t.nro_sicop = a.nro_sicop
      WHERE ${clauses.join(' AND ')}
        AND a.cedula_proveedor IS NOT NULL AND trim(a.cedula_proveedor) <> ''`,
    params,
  );

  const winners = new Map<string, Set<string>>();
  for (const a of awards) {
    let s = winners.get(a.nroSicop);
    if (!s) {
      s = new Set();
      winners.set(a.nroSicop, s);
    }
    s.add(a.cedulaProveedor);
  }

  const byTender = new Map<string, TenderBidders>();
  for (const b of bids) {
    let t = byTender.get(b.nroSicop);
    if (!t) {
      t = {
        nroSicop: b.nroSicop,
        cedulaInstitucion: b.cedulaInstitucion,
        bidders: [],
        winners: winners.get(b.nroSicop) ?? new Set(),
        decided: winners.has(b.nroSicop),
      };
      byTender.set(b.nroSicop, t);
    }
    t.bidders.push(b.cedulaProveedor);
  }
  for (const t of byTender.values()) t.bidders.sort();
  return [...byTender.values()];
}

// ---------------------------------------------------------------------------
// 1. Bid rotation
// ---------------------------------------------------------------------------

export interface RotationHit {
  /** The exact set of suppliers that keeps appearing together. */
  group: string[];
  groupSize: number;
  /** Tenders where this exact set was the full bidder list. */
  coBidTenders: number;
  /**
   * coBidTenders over every tender any member of the group bid on. Near 1 means
   * these suppliers almost never appear apart. Low means they are simply active
   * in the same market and happened to line up a few times.
   */
  exclusivity: number;
  /** Of those, how many were decided. Wins are only countable on decided ones. */
  decidedTenders: number;
  winsBySupplier: { cedulaProveedor: string; wins: number }[];
  /** 1.0 means wins split perfectly evenly across the group. */
  evenness: number | null;
  /** How many of the group have won at least once. */
  distinctWinners: number;
  score: number;
  nroSicop: string[];
  institutions: string[];
}

/**
 * Bid rotation screen.
 *
 * Looks for an identical set of suppliers appearing as the complete bidder list
 * on several tenders, with the wins spread evenly across the set rather than
 * concentrated on one of them. Rotation is the pattern; a single supplier
 * winning every time is not rotation, it is just a strong competitor, and it
 * scores zero here.
 *
 * Three constraints, all of them added because the screen fired on random data
 * without them. Simulated markets of 15 suppliers across 5 institutions, with
 * bidders and winners drawn uniformly at random, produced one to four hits per
 * run before these were in place:
 *
 *   exact set match     overlapping subsets recur constantly; identical full
 *                       bidder lists are much rarer
 *   at least three      every false positive in the simulation was a pair. Two
 *   members             suppliers landing on the same four tenders is a normal
 *                       week in a small market, not a ring
 *   exclusivity floor   the group has to appear together rather than merely
 *                       often. Members who also bid apart constantly are just
 *                       active suppliers in a concentrated market
 *
 * Score = evenness of the win split, times a saturation factor on how many times
 * the set repeated, times exclusivity. Every component is reported separately so
 * the score can be taken apart and argued with.
 */
export function bidRotation(db: Db, opts: CollusionOptions = {}): ScreenResult<RotationHit> {
  const minTenders = opts.minTenders ?? 4;
  const minGroupSize = opts.minGroupSize ?? 3;
  const minExclusivity = opts.minExclusivity ?? 0.25;
  const limit = opts.limit ?? 25;
  const all = scopedTenders(db, opts);

  // Every tender each supplier bid on, sole bids included, for the exclusivity
  // ratio. Counting only contested tenders here would let a supplier that bids
  // alone most of the time look like a dedicated member of a group.
  const appearances = new Map<string, number>();
  for (const t of all) {
    for (const b of t.bidders) appearances.set(b, (appearances.get(b) ?? 0) + 1);
  }

  const tenders = all.filter((t) => t.bidders.length >= 2);

  const groups = new Map<string, TenderBidders[]>();
  for (const t of tenders) {
    const key = t.bidders.join('|');
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }

  const hits: RotationHit[] = [];
  for (const [key, list] of groups) {
    if (list.length < minTenders) continue;
    const group = key.split('|');
    if (group.length < minGroupSize) continue;
    // Least exclusive member sets the ratio: one member who bids everywhere is
    // enough to explain the overlap without any agreement.
    const exclusivity = Math.min(...group.map((g) => list.length / (appearances.get(g) ?? list.length)));
    if (exclusivity < minExclusivity) continue;
    const decided = list.filter((t) => t.decided);
    const wins = new Map<string, number>();
    for (const g of group) wins.set(g, 0);
    for (const t of decided) {
      for (const w of t.winners) {
        if (wins.has(w)) wins.set(w, (wins.get(w) ?? 0) + 1);
      }
    }
    const winCounts = [...wins.values()];
    const distinctWinners = winCounts.filter((c) => c > 0).length;
    // Slots is the whole group: a member who never wins should pull the score down.
    const ev = evenness(winCounts, group.length).evenness;
    // Saturation: repeating the minimum number of times counts half, twice that
    // counts full. Keeps a 4-tender group from outranking a 20-tender group.
    const saturation = Math.min(1, list.length / (2 * minTenders));
    const score = ev === null ? 0 : ev * saturation * exclusivity;
    if (distinctWinners < 2) continue; // no rotation without at least two winners
    hits.push({
      group,
      groupSize: group.length,
      coBidTenders: list.length,
      exclusivity,
      decidedTenders: decided.length,
      winsBySupplier: [...wins.entries()]
        .map(([cedulaProveedor, w]) => ({ cedulaProveedor, wins: w }))
        .sort((a, b) => b.wins - a.wins),
      evenness: ev,
      distinctWinners,
      score,
      nroSicop: list.map((t) => t.nroSicop).sort(),
      institutions: [...new Set(list.map((t) => t.cedulaInstitucion).filter((x): x is string => !!x))].sort(),
    });
  }

  hits.sort((a, b) => b.score - a.score || b.coBidTenders - a.coBidTenders);
  return {
    screen: 'bid-rotation',
    looksFor:
      'the same exact set of suppliers as the full bidder list on several tenders, with the winner alternating between them',
    population: tenders.length,
    testsPerformed: groups.size,
    hits: hits.slice(0, limit),
    disclaimer: SCREEN_DISCLAIMER,
    notes: [
      `a group had to have at least ${minGroupSize} members and appear on at least ${minTenders} tenders with an identical bidder set`,
      `every member had to spend at least ${(minExclusivity * 100).toFixed(0)}% of its bidding inside the group`,
      'a market with only three registered suppliers produces this pattern with no agreement at all',
      'wins are counted only on tenders that have award rows; undecided tenders are excluded from the split',
    ],
  };
}

// ---------------------------------------------------------------------------
// 2. Consistent losing
// ---------------------------------------------------------------------------

export interface ConsistentLosingHit {
  loser: string;
  winner: string;
  /** Tenders where both bid and the tender was decided. */
  encounters: number;
  winnerWins: number;
  loserWins: number;
  lossRate: number;
  /** P(winner takes at least this many of the encounters) under a fair coin. */
  pValue: number;
  /** The same after Bonferroni over every pair tested in this run. */
  pValueAdjusted: number;
  score: number;
  sharedProductCodes: string[];
  nroSicop: string[];
  institutions: string[];
}

/**
 * Consistent losing screen.
 *
 * Looks for supplier A repeatedly bidding against supplier B and never, or
 * almost never, winning. Cover bidding produces this. So does being worse at the
 * job, which is far more common.
 *
 * The score is 1 minus the adjusted p-value, so it only rises when the run of
 * losses is longer than chance would supply across the whole set of pairs
 * tested. With the default minimum of five encounters, a clean sweep gives a raw
 * p of 0.031, which after adjusting for a few thousand pairs is not remarkable
 * at all. That is the intended behaviour: small numbers should not score.
 */
export function consistentLosing(db: Db, opts: CollusionOptions = {}): ScreenResult<ConsistentLosingHit> {
  const minTenders = opts.minTenders ?? 5;
  const limit = opts.limit ?? 25;
  const alpha = opts.alpha ?? 0.05;
  const tenders = scopedTenders(db, opts).filter((t) => t.decided && t.bidders.length >= 2);

  interface PairState {
    encounters: number;
    aWins: number;
    bWins: number;
    tenders: string[];
    institutions: Set<string>;
  }
  const pairs = new Map<string, PairState>();

  for (const t of tenders) {
    for (let i = 0; i < t.bidders.length; i++) {
      for (let j = i + 1; j < t.bidders.length; j++) {
        const a = t.bidders[i];
        const b = t.bidders[j];
        const aWon = t.winners.has(a);
        const bWon = t.winners.has(b);
        if (!aWon && !bWon) continue; // neither took the tender; tells us nothing
        if (aWon && bWon) continue; // split award; not a head-to-head outcome
        const key = `${a}|${b}`;
        let st = pairs.get(key);
        if (!st) {
          st = { encounters: 0, aWins: 0, bWins: 0, tenders: [], institutions: new Set() };
          pairs.set(key, st);
        }
        st.encounters++;
        if (aWon) st.aWins++;
        else st.bWins++;
        st.tenders.push(t.nroSicop);
        if (t.cedulaInstitucion) st.institutions.add(t.cedulaInstitucion);
      }
    }
  }

  const eligible = [...pairs.entries()].filter(([, st]) => st.encounters >= minTenders);
  const testsPerformed = eligible.length;

  const hits: ConsistentLosingHit[] = [];
  for (const [key, st] of eligible) {
    const [a, b] = key.split('|');
    const winner = st.aWins >= st.bWins ? a : b;
    const loser = winner === a ? b : a;
    const winnerWins = Math.max(st.aWins, st.bWins);
    const loserWins = Math.min(st.aWins, st.bWins);
    const p = binomialTailGE(winnerWins, st.encounters, 0.5);
    const adjusted = bonferroni(p, testsPerformed);
    // Above the cutoff the run of losses is no longer than chance supplies across
    // the pairs tested. Reporting it anyway would be manufacturing a shortlist.
    if (adjusted > alpha) continue;
    hits.push({
      loser,
      winner,
      encounters: st.encounters,
      winnerWins,
      loserWins,
      lossRate: winnerWins / st.encounters,
      pValue: p,
      pValueAdjusted: adjusted,
      score: 1 - adjusted,
      sharedProductCodes: sharedCodes(db, st.tenders, loser, winner),
      nroSicop: [...new Set(st.tenders)].sort(),
      institutions: [...st.institutions].sort(),
    });
  }

  hits.sort((a, b) => a.pValueAdjusted - b.pValueAdjusted || b.encounters - a.encounters);
  return {
    screen: 'consistent-losing',
    looksFor: 'one supplier repeatedly bidding against another and losing every time',
    population: tenders.length,
    testsPerformed,
    hits: hits.slice(0, limit),
    disclaimer: SCREEN_DISCLAIMER,
    notes: [
      `a pair had to meet at least ${minTenders} times on decided tenders`,
      `p-values are Bonferroni-adjusted over the ${testsPerformed} pairs tested; sort on the adjusted value`,
      `only pairs with an adjusted p-value at or below ${alpha} are listed`,
      'tenders where both suppliers won lines, or neither did, are excluded as not head to head',
    ],
  };
}

/** Product codes both suppliers actually bid on within the shared tenders. */
function sharedCodes(db: Db, tenderIds: readonly string[], a: string, b: string): string[] {
  const ids = [...new Set(tenderIds)];
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = query<{ code: string }>(
    db,
    `SELECT DISTINCT l.codigo_producto AS code
       FROM bid_line l
       JOIN bid o ON o.nro_sicop = l.nro_sicop AND o.nro_oferta = l.nro_oferta
      WHERE l.nro_sicop IN (${placeholders})
        AND o.cedula_proveedor IN (?, ?)
        AND l.codigo_producto IS NOT NULL AND trim(l.codigo_producto) <> ''
      LIMIT 25`,
    [...ids, a, b],
  );
  return rows.map((r) => r.code).sort();
}

// ---------------------------------------------------------------------------
// 3. Bid spread
// ---------------------------------------------------------------------------

export interface BidSpreadHit {
  winner: string;
  loser: string;
  /** Tender lines where both priced the same product code in the same currency. */
  lines: number;
  medianGapPct: number;
  meanGapPct: number;
  /** Coefficient of variation of the gap. Near zero means a fixed markup. */
  cv: number | null;
  score: number;
  gaps: { nroSicop: string; nroLinea: string; codigoProducto: string; gapPct: number }[];
  nroSicop: string[];
}

/**
 * Bid spread screen.
 *
 * On a line where one supplier won and another lost, the gap is
 * (losing price - winning price) / winning price. Genuine competition produces
 * gaps that jump around. A fixed percentage gap repeated across unrelated
 * tenders is the arithmetic signature of one price being derived from the other.
 *
 * Two constraints matter. Both bids must be on the same product code, or the
 * ratio compares different goods. Both must be in the same currency, or the gap
 * is an exchange rate. Neither of those is optional and both are enforced in the
 * query rather than assumed.
 *
 * The most common innocent explanation, and it is very common: both suppliers
 * resell the same manufacturer and mark up from the same list price.
 */
export function bidSpread(db: Db, opts: CollusionOptions = {}): ScreenResult<BidSpreadHit> {
  // Five rather than four. Four gap observations can look stable by luck, and a
  // simulated random market produced exactly that at the four-tender floor.
  const minTenders = opts.minTenders ?? 5;
  const limit = opts.limit ?? 25;
  const missing = missingInputs(db, ['bid_line', 'award_line']);
  if (missing.length) {
    return {
      screen: 'bid-spread',
      looksFor: 'a stable percentage gap between one supplier and another across unrelated tenders',
      population: 0,
      testsPerformed: 0,
      hits: [],
      disclaimer: SCREEN_DISCLAIMER,
      notes: [`no rows in ${missing.join(', ')}`],
    };
  }

  const pubExpr = dateExpr(db, 'tender', 'fecha_publicacion', 't');
  const clauses = ['1=1'];
  const params: unknown[] = [];
  if (opts.from) {
    clauses.push(`${pubExpr} >= ?`);
    params.push(opts.from);
  }
  if (opts.to) {
    clauses.push(`${pubExpr} <= ?`);
    params.push(opts.to);
  }
  if (opts.month) {
    clauses.push('t.source_month = ?');
    params.push(opts.month);
  }
  if (opts.institution) {
    clauses.push('t.cedula_institucion = ?');
    params.push(opts.institution);
  }

  const rows = query<{
    nroSicop: string;
    nroLinea: string;
    codigoProducto: string;
    winner: string;
    loser: string;
    winPrice: number;
    losePrice: number;
  }>(
    db,
    `SELECT w.nro_sicop        AS nroSicop,
            w.nro_linea        AS nroLinea,
            w.codigo_producto  AS codigoProducto,
            w.cedula_proveedor AS winner,
            lo.cedula_proveedor AS loser,
            w.precio_unitario  AS winPrice,
            l.precio_unitario  AS losePrice
       FROM ${LATEST_AWARD_LINES} w
       JOIN tender t   ON t.nro_sicop = w.nro_sicop
       JOIN bid_line l ON l.nro_sicop = w.nro_sicop
                      AND l.nro_linea = w.nro_linea
                      AND l.nro_oferta <> w.nro_oferta
                      AND l.codigo_producto = w.codigo_producto
                      AND l.moneda = w.moneda
       JOIN bid lo     ON lo.nro_sicop = l.nro_sicop AND lo.nro_oferta = l.nro_oferta
      WHERE ${clauses.join(' AND ')}
        AND w.precio_unitario > 0 AND l.precio_unitario > 0
        AND w.cedula_proveedor IS NOT NULL AND lo.cedula_proveedor IS NOT NULL
        AND lo.cedula_proveedor <> w.cedula_proveedor
        AND l.precio_unitario >= w.precio_unitario`,
    params,
  );

  const pairs = new Map<
    string,
    { gaps: { nroSicop: string; nroLinea: string; codigoProducto: string; gapPct: number }[] }
  >();
  for (const r of rows) {
    const gapPct = ((r.losePrice - r.winPrice) / r.winPrice) * 100;
    if (!Number.isFinite(gapPct)) continue;
    const key = `${r.winner}|${r.loser}`;
    const st = pairs.get(key) ?? { gaps: [] };
    st.gaps.push({ nroSicop: r.nroSicop, nroLinea: r.nroLinea, codigoProducto: r.codigoProducto, gapPct });
    pairs.set(key, st);
  }

  const hits: BidSpreadHit[] = [];
  for (const [key, st] of pairs) {
    const distinctTenders = new Set(st.gaps.map((g) => g.nroSicop));
    if (distinctTenders.size < minTenders) continue;
    const values = st.gaps.map((g) => g.gapPct);
    const { cv, mean } = coefficientOfVariation(values);
    const med = median(values) as number;
    // A gap of essentially zero is two identical prices, which is a different
    // pattern (identical bids) and not what this screen measures.
    if (med < 0.5) continue;
    // A gap of 140% that varies by a third is not a stable gap. On simulated
    // random markets the tightest coincidental pair sat near cv 0.29, so the
    // window runs 0.08 to 0.20: score 1 at or below 0.08, nothing at 0.20 up.
    const stability = cv === null ? 0 : Math.max(0, Math.min(1, (0.2 - cv) / 0.12));
    // Stability over a handful of lines is cheap. Saturate at twice the floor so
    // a long stable run outranks a short one.
    const saturation = Math.min(1, distinctTenders.size / (2 * minTenders));
    const score = stability * saturation;
    if (score <= 0) continue;
    const [winner, loser] = key.split('|');
    hits.push({
      winner,
      loser,
      lines: st.gaps.length,
      medianGapPct: med,
      meanGapPct: mean ?? 0,
      cv,
      score,
      gaps: st.gaps.slice(0, 20),
      nroSicop: [...distinctTenders].sort(),
    });
  }

  hits.sort((a, b) => b.score - a.score || b.lines - a.lines);
  return {
    screen: 'bid-spread',
    looksFor: 'a stable percentage gap between one supplier and another across unrelated tenders',
    population: rows.length,
    testsPerformed: pairs.size,
    hits: hits.slice(0, limit),
    disclaimer: SCREEN_DISCLAIMER,
    notes: [
      `a pair had to share priced lines on at least ${minTenders} distinct tenders`,
      'only lines with the same product code and the same currency on both sides are compared',
      'the gap has to vary by less than a fifth of its own size before it scores at all',
      'two resellers marking up the same manufacturer list price produce a stable gap with no agreement',
    ],
  };
}

// ---------------------------------------------------------------------------
// 4. Single-bidder concentration
// ---------------------------------------------------------------------------

export interface SingleBidderPairHit {
  cedulaProveedor: string;
  cedulaInstitucion: string;
  institucion: string | null;
  /** Tenders at this institution where this supplier was the only bidder. */
  soleBidTenders: number;
  /** Of those, how many it also won. */
  soleBidWins: number;
  /** This institution's total tenders that had exactly one bidder. */
  institutionSingleBidderTenders: number;
  /** Share of those taken by this supplier. */
  shareOfInstitutionSingleBidder: number;
  /** This supplier's total tenders at this institution. */
  supplierTendersAtInstitution: number;
  /** Share of this supplier's appearances here that faced no competition. */
  shareOfSupplierTenders: number;
  score: number;
  nroSicop: string[];
}

/**
 * Single-bidder concentration screen.
 *
 * A supplier and an institution that keep meeting with nobody else in the room.
 * This is the pair-level version of the headline single-bidder rate.
 *
 * Unlike the other three, this screen is descriptive rather than inferential. It
 * does not claim the pattern is improbable; it reports where competition is
 * absent and leaves the reason open. That distinction is load bearing. Feed it a
 * simulated market of fifteen suppliers bidding at random and it returns a dozen
 * hits, because in that market competition really is thin. The other three
 * screens return nothing on the same data, and they are supposed to. This one
 * fires on any concentrated market by construction, which is exactly what it is
 * for, and it is why the output must never be read as evidence of an agreement.
 *
 * Score combines how much of the institution's uncontested business the supplier
 * holds with how much of the supplier's business here was uncontested. Both
 * components are reported. Sole-source purchases under a legal exception show up
 * here by design, which is why competition.ts reports exception usage next to it.
 */
export function singleBidderConcentration(
  db: Db,
  opts: CollusionOptions = {},
): ScreenResult<SingleBidderPairHit> {
  const minTenders = opts.minTenders ?? 3;
  const limit = opts.limit ?? 25;
  const tenders = scopedTenders(db, opts);

  const institutionSingles = new Map<string, number>();
  const pairTenders = new Map<string, { total: number; sole: number; soleWins: number; ids: string[] }>();

  for (const t of tenders) {
    const inst = t.cedulaInstitucion;
    if (!inst) continue;
    const sole = t.bidders.length === 1;
    if (sole) institutionSingles.set(inst, (institutionSingles.get(inst) ?? 0) + 1);
    for (const s of t.bidders) {
      const key = `${s}|${inst}`;
      const st = pairTenders.get(key) ?? { total: 0, sole: 0, soleWins: 0, ids: [] };
      st.total++;
      if (sole) {
        st.sole++;
        st.ids.push(t.nroSicop);
        if (t.winners.has(s)) st.soleWins++;
      }
      pairTenders.set(key, st);
    }
  }

  const names = new Map<string, string>();
  for (const r of query<{ cedula: string; nombre: string }>(db, 'SELECT cedula, nombre FROM institution')) {
    names.set(r.cedula, r.nombre);
  }

  const hits: SingleBidderPairHit[] = [];
  for (const [key, st] of pairTenders) {
    if (st.sole < minTenders) continue;
    const [cedulaProveedor, cedulaInstitucion] = key.split('|');
    const instSingles = institutionSingles.get(cedulaInstitucion) ?? st.sole;
    const shareOfInstitution = instSingles > 0 ? st.sole / instSingles : 0;
    const shareOfSupplier = st.total > 0 ? st.sole / st.total : 0;
    hits.push({
      cedulaProveedor,
      cedulaInstitucion,
      institucion: names.get(cedulaInstitucion) ?? null,
      soleBidTenders: st.sole,
      soleBidWins: st.soleWins,
      institutionSingleBidderTenders: instSingles,
      shareOfInstitutionSingleBidder: shareOfInstitution,
      supplierTendersAtInstitution: st.total,
      shareOfSupplierTenders: shareOfSupplier,
      // Geometric mean of the two shares: a supplier needs both to score.
      score: Math.sqrt(shareOfInstitution * shareOfSupplier),
      nroSicop: st.ids.sort(),
    });
  }

  hits.sort((a, b) => b.score - a.score || b.soleBidTenders - a.soleBidTenders);
  return {
    screen: 'single-bidder-concentration',
    looksFor: 'a supplier and an institution repeatedly transacting with no other bidder present',
    population: tenders.length,
    testsPerformed: pairTenders.size,
    hits: hits.slice(0, limit),
    disclaimer: SCREEN_DISCLAIMER,
    notes: [
      `a pair had to have at least ${minTenders} uncontested tenders together`,
      'this screen is descriptive: it reports where competition is absent, not that the absence is suspicious',
      'lawful sole-source purchases appear here by construction; check exception usage alongside',
      'a genuinely single-supplier market produces this with no agreement at all',
    ],
  };
}

// ---------------------------------------------------------------------------

export interface CollusionReport {
  window: CollusionOptions;
  missing: string[];
  disclaimer: string;
  rotation: ScreenResult<RotationHit>;
  consistentLosing: ScreenResult<ConsistentLosingHit>;
  bidSpread: ScreenResult<BidSpreadHit>;
  singleBidderConcentration: ScreenResult<SingleBidderPairHit>;
}

export function collusionReport(db: Db, opts: CollusionOptions = {}): CollusionReport {
  const missing = missingInputs(db, ['tender', 'bid']);
  const empty = <E>(screen: string): ScreenResult<E> => ({
    screen,
    looksFor: '',
    population: 0,
    testsPerformed: 0,
    hits: [],
    disclaimer: SCREEN_DISCLAIMER,
    notes: [`no rows in ${missing.join(', ')}`],
  });
  if (missing.length) {
    return {
      window: opts,
      missing,
      disclaimer: SCREEN_DISCLAIMER,
      rotation: empty('bid-rotation'),
      consistentLosing: empty('consistent-losing'),
      bidSpread: empty('bid-spread'),
      singleBidderConcentration: empty('single-bidder-concentration'),
    };
  }
  return {
    window: opts,
    missing,
    disclaimer: SCREEN_DISCLAIMER,
    rotation: bidRotation(db, opts),
    consistentLosing: consistentLosing(db, opts),
    bidSpread: bidSpread(db, opts),
    singleBidderConcentration: singleBidderConcentration(db, opts),
  };
}
