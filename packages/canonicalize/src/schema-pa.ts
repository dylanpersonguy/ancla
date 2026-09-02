/**
 * PanamaCompra en Cifras — table keys.
 *
 * The archive is OCDS flattened to CSV: one file per repeated element, every row
 * carrying the `ocid` of the contracting process it belongs to, then the id of
 * the thing within it. The long column names are OCDS JSON paths and the `/0/`
 * in them is an artefact of that flattening, not an array index that varies.
 *
 * Every key here was measured against 2026-07 rather than inferred from the
 * standard: each is the smallest combination of id columns that is unique across
 * the whole file, with no blank keys. Sixteen tables keyed on the obvious
 * columns. `releases` needed the release url, because one ocid legitimately has
 * many releases and neither date nor tag separates them.
 *
 * Two tables are absent on purpose and fall through to content addressing:
 *
 *   com_contracts             967 rows, 851 distinct whole rows. The 116
 *                             collisions are literal duplicate rows, so no key
 *                             can separate them. SICOP does the same thing.
 *   com_con_imp_documents     has no id column for the document at all, and the
 *                             url repeats 111 times.
 *
 * A key that stops being unique degrades one row rather than the table: the
 * canonicaliser content-addresses any row whose key collides. So a future award
 * with two suppliers costs one content-addressed row, not a broken table.
 */

import type { TableDef } from './schema.ts';

const OCID = 'ocid';
const AWARD = 'compiledRelease/awards/0/id';
const BID = 'compiledRelease/bids/details/0/id';
const PARTY = 'compiledRelease/parties/0/id';

export const PANAMA_TABLES: Record<string, TableDef> = {
  com_awa_items: { key: [OCID, AWARD, 'compiledRelease/awards/0/items/0/id'] },
  com_awa_suppliers: { key: [OCID, AWARD] },
  com_awards: { key: [OCID, AWARD] },
  com_bid_det_documents: { key: [OCID, BID, 'compiledRelease/bids/details/0/documents/0/id'] },
  com_bid_det_items: { key: [OCID, BID, 'compiledRelease/bids/details/0/items/0/id'] },
  com_bid_det_tenderers: { key: [OCID, BID] },
  com_bid_details: { key: [OCID, BID] },
  com_con_documents: { key: [OCID, 'compiledRelease/contracts/0/documents/0/id'] },
  com_par_additionalIdentifiers: { key: [OCID, PARTY] },
  com_parties: { key: [OCID, PARTY] },
  com_pla_bud_budgetBreakdown: {
    key: [OCID, 'compiledRelease/planning/budget/budgetBreakdown/0/id'],
  },
  com_relatedProcesses: { key: [OCID] },
  com_sources: { key: [OCID] },
  com_ten_items: { key: [OCID, 'compiledRelease/tender/items/0/id'] },
  com_ten_tenderers: { key: [OCID, 'compiledRelease/tender/tenderers/0/id'] },
  records: { key: [OCID] },
  releases: { key: [OCID, 'releases/0/url'] },
};
