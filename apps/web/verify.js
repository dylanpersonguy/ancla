/**
 * The hosted verifier.
 *
 * The hashing lives in hash.js, unchanged from apps/verifier/index.html, and is
 * pinned against the Node implementation by
 * packages/delivery/test/verifier-parity.test.ts.
 *
 * What is new compared to the pasted-JSON verifier: a record can be looked up by
 * its procedure number and the proof fetched from the API. That is a convenience,
 * not a shortcut in the trust model. The proof still has to reproduce the root on
 * its own, in this page, and the root still has to match what is on chain. A
 * malicious API can hand over a proof, and it will fail here.
 */

import { api, applyMessages, boot, el, offlineMessage, t } from "./ancla.js";
import { recompute } from "./hash.js";

// The node the page reads the chain from. Prefilled from the API and editable,
// because a reader who does not trust this deployment has to be able to point the
// check at a node they do trust. The API is never asked what the root is.
const DEFAULT_NODE = "https://mainnet-node.decentralchain.io";
const $ = (id) => document.getElementById(id);

function nodeUrl() {
  return ($("node").value.trim() || DEFAULT_NODE).replace(/\/$/, "");
}

async function onChainRoot(addr, day, month) {
  const key = `root_${day}_${month}`;
  const res = await fetch(`${nodeUrl()}/addresses/data/${addr}/${encodeURIComponent(key)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return String((await res.json()).value);
}

// The tables a record can live in. Ordered so the ones a person actually looks up
// come first; the rest are there because a change feed entry can point at any of them.
const TABLES = [
  "DetalleCarteles",
  "Contratos",
  "Ofertas",
  "LineasAdjudicadas",
  "AdjudicacionesFirme",
  "RecursosObjecion",
  "Proveedores",
  "InstitucionesRegistradas",
  "DetalleLineaCartel",
  "FechaPorEtapas",
  "LineasOfertadas",
  "LineasContratadas",
  "ProcedimientoAdjudicacion",
  "InvitacionProcedimiento",
  "Garantias",
  "OrdenPedido",
  "Recepciones",
  "LineasRecibidas",
  "ReajustePrecios",
  "SancionProveedores",
  "FuncionariosInhibicion",
  "ProcedimientoADM",
  "Remates",
  "SistemaEvaluacionOfertas",
  "Sistemas",
];

/** A table label, or the raw name when the catalogue has no entry for it. */
function tableName(table) {
  const label = t(`table.${table}`);
  return label === `table.${table}` ? table : label;
}

function banner(text) {
  const node = $("banner");
  node.textContent = text;
  node.classList.toggle("hidden", !text);
}

function card(...children) {
  $("result").replaceChildren(el("div", { class: "card" }, ...children));
}

function verdict(cls, text) {
  return el("p", { class: `verdict ${cls}` }, text);
}

function kv(label, value) {
  return [el("dt", {}, label), el("dd", {}, value ?? t("verify.unstated"))];
}

async function fillMonths() {
  const select = $("l-month");
  const chosen = select.value;
  select.replaceChildren(el("option", { value: "" }, t("common.unknown")));
  try {
    const data = await api("/months");
    for (const m of data.months.slice().reverse()) {
      select.append(el("option", { value: m.month }, m.month));
    }
  } catch {
    /* without the API the month has to be typed into the proof by hand */
  }
  select.value = chosen;
}

function fillTables() {
  const select = $("l-table");
  const chosen = select.value;
  select.replaceChildren();
  for (const table of TABLES) {
    select.append(el("option", { value: table }, tableName(table)));
  }
  select.value = chosen || "DetalleCarteles";
}

/** Pull a proof from the API and drop it in the textarea for the reader to inspect. */
async function fetchProof(id, month, table) {
  const path = `/proof/${encodeURIComponent(month)}/${encodeURIComponent(
    table,
  )}/${encodeURIComponent(id)}`;
  const doc = await api(path);
  $("proof").value = JSON.stringify(doc, null, 2);
  if (doc.anchorAddress && !$("addr").value.trim()) $("addr").value = doc.anchorAddress;
  return doc;
}

/**
 * When no month is given, ask the index which month the procedure was published in.
 * Falls back to asking the reader, because guessing here would send them to a
 * "record not found" that means nothing.
 */
async function resolveMonth(id) {
  const tender = await api(`/tenders/${encodeURIComponent(id)}`);
  return tender?.tender?.source_month ?? null;
}

async function runVerification() {
  let p;
  try {
    p = JSON.parse($("proof").value);
  } catch {
    return card(verdict("bad", t("verify.badJson")));
  }
  for (const field of ["table", "id", "byteHash", "proof", "merkleRoot"]) {
    if (!(field in p)) {
      return card(verdict("bad", t("verify.missingField", { field })));
    }
  }

  const computed = await recompute(p);
  const consistent = computed === String(p.merkleRoot).toLowerCase();
  const parts = [verdict(consistent ? "ok" : "bad", t(consistent ? "verify.consistent" : "verify.inconsistent"))];

  const addr = $("addr").value.trim();
  const day = p.anchoredDay;
  if (addr && day && p.month) {
    try {
      const published = await onChainRoot(addr, day, p.month);
      if (published === null) {
        parts.push(verdict("warn", t("verify.chain.absent", { day })));
      } else if (published.toLowerCase() === computed) {
        parts.push(verdict("ok", t("verify.chain.match", { day })));
      } else {
        parts.push(verdict("bad", t("verify.chain.differs")));
      }
    } catch (err) {
      parts.push(verdict("warn", t("verify.chain.unreachable", { reason: err.message })));
    }
  }

  parts.push(
    el(
      "dl",
      { class: "kv" },
      ...kv(t("verify.row.record"), `${tableName(p.table)} ${p.id}`),
      ...kv(t("verify.row.recordHash"), p.byteHash),
      ...kv(t("verify.row.recomputed"), computed),
      ...kv(t("verify.row.stated"), String(p.merkleRoot)),
      ...kv(
        t("verify.row.pathLabel"),
        t("verify.row.path", { steps: p.proof.length, leaves: p.leafCount ?? "?" }),
      ),
      ...kv(t("verify.row.canon"), p.canonVersion),
      ...kv(t("verify.row.node"), addr ? nodeUrl() : t("common.none")),
      ...kv(t("verify.row.archive"), p.archiveSha256),
    ),
  );
  card(...parts);
}

$("lookup").addEventListener("submit", async (event) => {
  event.preventDefault();
  banner("");
  const id = $("l-sicop").value.trim();
  const table = $("l-table").value;
  let month = $("l-month").value;
  if (!id) return;
  try {
    if (!month) {
      month = await resolveMonth(id);
      if (!month) throw new Error(t("error.badMonth"));
      $("l-month").value = month;
    }
    await fetchProof(id, month, table);
    await runVerification();
  } catch (err) {
    banner(t("verify.lookup.failed", { reason: err.message || offlineMessage() }));
  }
});

$("go").addEventListener("click", runVerification);

$("sample").addEventListener("click", () => {
  $("proof").value = JSON.stringify(
    {
      month: "202512",
      table: "Contratos",
      id: "EXAMPLE|01",
      byteHash: "00".repeat(32),
      merkleRoot: "00".repeat(32),
      leafCount: 1,
      canonVersion: "ancla-canon-1",
      proof: [],
    },
    null,
    2,
  );
});

async function render() {
  fillTables();
  await fillMonths();
  applyMessages();
  try {
    const health = await api("/health");
    $("addr").value ||= health.chain.address ?? "";
    $("node").value ||= health.chain.node ?? DEFAULT_NODE;
    $("anchor-line").textContent = `${t("anchor.account")} ${health.chain.address} · ${t(
      "anchor.node",
    )} ${health.chain.node} · ${t("anchor.height")} ${health.chain.height ?? "-"}`;
  } catch {
    $("node").value ||= DEFAULT_NODE;
    banner(offlineMessage());
  }
  // A link from the feed carries the record it wants checked.
  const q = new URLSearchParams(location.search);
  const id = q.get("id");
  if (id) {
    $("l-sicop").value = id;
    if (q.get("month")) $("l-month").value = q.get("month");
    if (q.get("table")) $("l-table").value = q.get("table");
    $("lookup").requestSubmit();
  }
}

boot(render);
