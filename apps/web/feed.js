/**
 * The public changes feed.
 *
 * This page has one job: let someone who is not a programmer see that a published
 * record changed, which record, whose it was, and whether the change was declared
 * or silent. Everything else on the page is subordinate to that. The strongest
 * visual weight belongs to a silent revision in a month that had already closed,
 * because that is the only thing here that should make anyone pick up a phone.
 */

import {
  api,
  applyMessages,
  boot,
  el,
  fmtDateTime,
  fmtMonth,
  fmtNumber,
  offlineMessage,
  shortHash,
  t,
} from "./ancla.js";

const KINDS = ["silentRevision", "removed", "recordedAmendment", "added", "reformatted"];
const PAGE = 50;

const state = { offset: 0, total: 0, filters: {} };

function banner(text) {
  const node = document.getElementById("banner");
  node.textContent = text;
  node.classList.toggle("hidden", !text);
}

function readFilters() {
  const form = document.getElementById("filters");
  const data = new FormData(form);
  const out = {};
  for (const [k, v] of data.entries()) if (String(v).trim()) out[k] = String(v).trim();
  return out;
}

function query() {
  const params = new URLSearchParams({ limit: String(PAGE), offset: String(state.offset) });
  for (const [k, v] of Object.entries(state.filters)) params.set(k, v);
  return params.toString();
}

function entry(change) {
  // Built as a list and joined, so a record with no institution and no procedure
  // number does not render a stray separator at the start of the line.
  const meta = [];
  if (change.institution) {
    meta.push([
      `${t("feed.institution")}: `,
      el("strong", {}, change.institution.nombre || change.institution.cedula),
    ]);
  }
  if (change.nroSicop) {
    meta.push([`${t("field.nroSicop")}: `, el("strong", {}, change.nroSicop)]);
  }
  meta.push([`${t("feed.month")}: `, el("strong", {}, fmtMonth(change.month))]);

  const metaLine = el("p", { class: "entry-meta" });
  meta.forEach((part, i) => {
    if (i > 0) metaLine.append(document.createTextNode(" \u00b7 "));
    for (const bit of part) metaLine.append(bit instanceof Node ? bit : document.createTextNode(bit));
  });

  const body = el(
    "div",
    { class: "entry-body" },
    el(
      "p",
      { class: "entry-title" },
      el("span", { class: "chip", "data-kind": change.kind }, change.kindLabel),
      " ",
      change.tableLabel,
      " ",
      el("span", { class: "rid" }, change.id),
    ),
    metaLine,
    el("p", { class: "entry-meta" }, change.kindDescription),
  );

  if (change.before && change.after) {
    body.append(
      el(
        "p",
        { class: "hashes" },
        `${t("feed.beforeAfter")}: ${shortHash(change.before.byteHash, 16)} \u2192 ${shortHash(
          change.after.byteHash,
          16,
        )}`,
      ),
    );
  }

  // The long explanation is worth the space only where it changes what a reader
  // should do. On a declared amendment or a reformatting, the label alone is enough.
  if (change.closedMonth) {
    const material = change.kind === "silentRevision" || change.kind === "removed";
    body.append(
      el(
        "p",
        { class: "flag" },
        material ? `${t("feed.closedMonth")}. ${t("feed.closedMonthNote")}` : t("feed.closedMonth"),
      ),
    );
  }

  const verifyHref = `./verify.html?month=${encodeURIComponent(
    change.month,
  )}&table=${encodeURIComponent(change.table)}&id=${encodeURIComponent(change.id)}`;
  body.append(el("p", {}, el("a", { href: verifyHref }, t("feed.verifyThis"))));

  return el(
    "article",
    { class: "entry" },
    el(
      "div",
      { class: "entry-when" },
      el("div", {}, t("feed.detectedAt")),
      el("div", {}, fmtDateTime(change.detectedAt)),
    ),
    body,
  );
}

function emptyState() {
  return el(
    "div",
    { class: "empty" },
    el("p", {}, t("feed.empty")),
    el("p", {}, t("feed.emptyHint")),
  );
}

async function loadStats() {
  const node = document.getElementById("stats");
  node.replaceChildren();
  let stats;
  try {
    stats = await api("/stats");
  } catch {
    return;
  }
  const cells = [
    [t("stats.anchors"), fmtNumber(stats.anchors.days), stats.anchors.latest ?? ""],
    [t("stats.months"), fmtNumber(stats.archives.months), ""],
    [
      t("stats.tenders"),
      fmtNumber(stats.index.tenders),
      stats.index.available ? "" : t("status.indexMissing"),
    ],
    [t("stats.changes"), fmtNumber(stats.changes.total), ""],
    [t("stats.silent"), fmtNumber(stats.changes.byKind.silentRevision ?? 0), ""],
  ];
  for (const [label, value, hint] of cells) {
    node.append(
      el(
        "div",
        { class: "stat" },
        el("dt", {}, label),
        el("dd", {}, value, hint ? el("small", {}, hint) : null),
      ),
    );
  }

  const line = document.getElementById("anchor-line");
  line.textContent = `${t("anchor.account")} ${stats.anchors.address} · ${t(
    "anchor.latest",
  )} ${stats.anchors.latest ?? t("common.none")}`;
}

/**
 * Every change, fetched once.
 *
 * The feed is the flattened watch reports, which is hundreds of rows at most, so
 * one payload is cheaper than a request per page and it is the only shape a
 * static export can serve. Filtering and paging then happen below, over the same
 * array, which means this page behaves identically against a live API and
 * against a folder of files — there is no second code path to disagree with the
 * first. A live API still narrows server-side; `all` just asks it not to.
 */
let allChanges = null;
let allMeta = null;

async function fetchAll() {
  if (allChanges) return;
  const data = await api("/changes?all=1&limit=1000");
  allChanges = data.changes;
  allMeta = data.meta;
}

/** The filters the form offers, applied here rather than in a query string. */
function matching() {
  const f = state.filters;
  return allChanges.filter((c) => {
    if (f.month && c.month !== f.month) return false;
    if (f.kind && c.kind !== f.kind) return false;
    if (f.date && c.detectedAt.slice(0, 10) !== f.date) return false;
    if (f.institution && (c.institution?.cedula ?? "") !== f.institution) return false;
    return true;
  });
}

/**
 * A change names its own kind. The export leaves the labels out because they are
 * language-dependent and the data is not; the catalogue this page already loaded
 * has both strings. A live API sends them, so prefer those when present.
 */
function label(change) {
  return {
    kindLabel: change.kindLabel ?? t(`kind.${change.kind}`),
    kindDescription: change.kindDescription ?? t(`kind.${change.kind}.desc`),
    tableLabel: change.tableLabel ?? change.table,
  };
}

async function loadFeed(append = false) {
  const list = document.getElementById("feed");
  if (!append) list.replaceChildren(el("p", { class: "skeleton" }, t("common.loading")));
  try {
    await fetchAll();
  } catch (err) {
    banner(err.message || offlineMessage());
    list.replaceChildren();
    return;
  }
  banner("");

  const hits = matching();
  state.total = hits.length;
  const page = hits.slice(state.offset, state.offset + PAGE);

  if (!append) list.replaceChildren();
  if (!hits.length && !append) {
    list.append(emptyState());
  } else {
    for (const change of page) list.append(entry({ ...change, ...label(change) }));
  }

  const shown = Math.min(state.offset + page.length, state.total);
  document.getElementById("count").textContent = t("feed.showing", {
    shown: fmtNumber(shown),
    total: fmtNumber(state.total),
  });

  const more = document.getElementById("more");
  more.classList.toggle("hidden", shown >= state.total);

  if (allMeta && !allMeta.indexAvailable && state.filters.institution) {
    banner(t("error.noIndex"));
  }
}

async function fillMonths() {
  const select = document.getElementById("f-month");
  const chosen = select.value;
  select.replaceChildren(el("option", { value: "" }, t("feed.filter.all")));
  try {
    const data = await api("/months");
    // Newest first: a reader looking for a rewrite is looking at recent months.
    for (const m of data.months.slice().reverse()) {
      select.append(el("option", { value: m.month }, fmtMonth(m.month)));
    }
  } catch {
    /* the month filter degrades to "all", which is still usable */
  }
  select.value = chosen;
}

function fillKinds() {
  const select = document.getElementById("f-kind");
  const chosen = select.value;
  select.replaceChildren(el("option", { value: "" }, t("feed.filter.all")));
  for (const k of KINDS) select.append(el("option", { value: k }, t(`kind.${k}`)));
  select.value = chosen;
}

async function render() {
  fillKinds();
  await fillMonths();
  applyMessages();
  state.offset = 0;
  await Promise.all([loadStats(), loadFeed(false)]);
}

document.getElementById("filters").addEventListener("submit", async (event) => {
  event.preventDefault();
  state.filters = readFilters();
  state.offset = 0;
  await loadFeed(false);
});

document.getElementById("clear").addEventListener("click", async () => {
  document.getElementById("filters").reset();
  state.filters = {};
  state.offset = 0;
  await loadFeed(false);
});

document.getElementById("more").addEventListener("click", async () => {
  state.offset += PAGE;
  await loadFeed(true);
});

boot(render);
