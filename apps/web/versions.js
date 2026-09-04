/**
 * The archive browser: which copies exist, and what changed between two of them.
 *
 * The trust model is the point of this page and it is worth stating plainly.
 * Three things arrive from three places:
 *
 *   the manifest         from our API. Untrusted.
 *   the committed digest from a public DecentralChain node, fetched by this page
 *                        directly. Not proxied through us.
 *   the digest itself    computed here, in the reader's browser, from the manifest.
 *
 * If our API alters one count in a manifest, the digest computed here stops
 * matching the one the chain has held since the day the bundle was published, and
 * the page says so. That is the only reason a reader has to believe any number on
 * this page, and it is why the recomputation runs client-side rather than being
 * reported by the server as a boolean.
 *
 * What this page cannot do is rebuild the bundle from the two 50 MB archives. That
 * check exists, it is the one that matters most, and it runs in `ancla
 * verify-bundle`. The command is printed next to every bundle rather than hidden,
 * because a verifier that only works if you use our website is not a verifier.
 */

import {
  api,
  boot,
  el,
  fmtDateTime,
  fmtNumber,
  shortHash,
  t,
} from "./ancla.js";
import { bundleDigest, diffChainKey, versionChainKey } from "./bundle-digest.js";

const NODE = "https://mainnet-node.decentralchain.io";

/**
 * Publisher labels, keyed by the source id the API stamps on every capture.
 *
 * Hardcoded rather than fetched because it is two entries and a fallback, and a
 * source the page does not know about should still be selectable by its id
 * rather than disappear.
 */
const SOURCES = {
  "cr-observatorio": { flag: "🇨🇷", name: "Costa Rica", portal: "SICOP" },
  "pa-panamacompra": { flag: "🇵🇦", name: "Panamá", portal: "PanamaCompra" },
};

const sourceLabel = (id) => {
  const s = SOURCES[id];
  return s ? `${s.flag} ${s.name} · ${s.portal}` : id;
};
const KINDS = ["silentRevision", "removed", "reformatted", "recordedAmendment", "added"];
const PAGE = 50;

const $ = (id) => document.getElementById(id);

/** `20260831T130427Z` -> a readable instant. This is the publisher's own stamp. */
function stampToIso(stamp) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(stamp ?? "");
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : null;
}

function chainLink(address, key) {
  return `${NODE}/addresses/data/${address}/${encodeURIComponent(key)}`;
}

/** Read one data entry straight off a public node, not through our API. */
async function readChainEntry(address, key) {
  const res = await fetch(chainLink(address, key), { headers: { accept: "application/json" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return String((await res.json()).value);
}

function anchorState(capture, known) {
  if (!known) return { cls: "warn", key: "versions.anchorUnknown" };
  if (capture.anchoredRoot === null) return { cls: "warn", key: "versions.notAnchored" };
  return capture.anchorMatches
    ? { cls: "ok", key: "versions.anchored" }
    : { cls: "bad", key: "versions.anchorMismatch" };
}

function captureCard(capture, known, address) {
  const state = anchorState(capture, known);
  const key =
    capture.archiveSha256 && capture.canonVersion
      ? versionChainKey(capture.period, capture.archiveSha256, capture.canonVersion)
      : null;
  return el(
    "div",
    { class: "card" },
    el(
      "div",
      { class: "capture-head" },
      el("span", { class: "mono" }, fmtDateTime(stampToIso(capture.stamp))),
      el("span", { class: `chip state-${state.cls}` }, t(state.key)),
      capture.afterClose ? el("span", { class: "chip state-warn" }, t("versions.afterClose")) : null,
    ),
    el(
      "dl",
      { class: "kv" },
      el("dt", {}, t("versions.root")),
      el("dd", { class: "mono" }, capture.merkleRoot ?? "-"),
      el("dt", {}, t("versions.records")),
      el("dd", {}, fmtNumber(capture.recordCount)),
      el("dt", {}, "sha256"),
      el("dd", { class: "mono" }, capture.archiveSha256 ?? "-"),
      key && known
        ? [
            el("dt", {}, t("bundle.onChain")),
            el(
              "dd",
              {},
              el("a", { class: "mono", href: chainLink(address, key), rel: "noopener" }, key),
            ),
          ]
        : null,
    ),
  );
}

const MOVEMENT_CLASS = {
  numeric: "num",
  reprint: "reprint",
  filled: "filled",
  cleared: "cleared",
  text: "text",
};

/** Empty and absent are different answers and must not render the same. */
function cell(v) {
  if (v === null) return el("span", { class: "absent" }, "—");
  if (v === "") return el("span", { class: "absent" }, "∅");
  return document.createTextNode(v);
}

function fmtDelta(d) {
  if (d === null || d === undefined) return null;
  const n = Number(d);
  if (!Number.isFinite(n)) return d;
  return `${n > 0 ? "+" : ""}${fmtNumber(n)}`;
}

/**
 * One changed field, inline.
 *
 * The values are the reason anyone opened this page, so they are on the row
 * rather than behind a disclosure. An earlier version put every change in a
 * <details> and a reader had to click seven thousand times to find the twelve
 * that mattered.
 */
function fieldRow(f) {
  const delta = fmtDelta(f.delta);
  return el(
    "div",
    { class: `fieldrow ${MOVEMENT_CLASS[f.movement] ?? "text"}` },
    el("span", { class: "fname mono" }, f.field),
    el("span", { class: "was mono" }, cell(f.before)),
    el("span", { class: "arrow" }, "→"),
    el("span", { class: "now mono" }, cell(f.after)),
    delta ? el("span", { class: "delta mono" }, delta) : null,
  );
}

/** The whole row, for a change where one side does not exist. */
function wholeRow(fields) {
  const entries = Object.entries(fields ?? {});
  if (!entries.length) return null;
  return el(
    "table",
    { class: "fields" },
    el(
      "tbody",
      {},
      entries.map(([k, v]) =>
        el("tr", {}, el("td", { class: "mono" }, k), el("td", { class: "mono" }, cell(v))),
      ),
    ),
  );
}

function changeRow(line) {
  const head = el(
    "div",
    { class: "change-head" },
    el("span", { class: "chip", "data-kind": line.kind }, t(`kind.${line.kind}`)),
    el("span", { class: "mono id" }, `${line.table} ${line.id}`),
  );

  if (line.valuesOmitted) {
    return el(
      "div",
      { class: "change" },
      head,
      el("p", { class: "note tight" }, t("bundle.valuesOmitted")),
    );
  }

  // A revision's question is "what changed", so the fields are the row. An
  // addition or a removal's question is "what is this record", so the whole row
  // stays folded away until asked for.
  if (line.fields) {
    return el("div", { class: "change" }, head, line.fields.map(fieldRow));
  }
  const body = wholeRow(line.before ?? line.after);
  return el(
    "details",
    { class: "change" },
    el("summary", {}, head),
    body,
  );
}

/**
 * Which fields moved, most-changed first.
 *
 * This is the part that turns a bundle into an answer. Six thousand rows where a
 * notification date got filled in and twelve rows where an amount moved look
 * identical in a flat list; here they are two lines, and the second one is
 * clickable.
 */
function fieldSummary(summary, onPick) {
  if (!summary.fields.length) return null;
  const rows = summary.fields.map((f) => {
    const parts = [];
    if (f.numeric) parts.push(el("span", { class: "tag num" }, `${fmtNumber(f.numeric)} ${t("move.numeric")}`));
    if (f.filled) parts.push(el("span", { class: "tag filled" }, `${fmtNumber(f.filled)} ${t("move.filled")}`));
    if (f.cleared) parts.push(el("span", { class: "tag cleared" }, `${fmtNumber(f.cleared)} ${t("move.cleared")}`));
    if (f.reprint) parts.push(el("span", { class: "tag reprint" }, `${fmtNumber(f.reprint)} ${t("move.reprint")}`));
    if (f.text) parts.push(el("span", { class: "tag text" }, `${fmtNumber(f.text)} ${t("move.text")}`));
    const tr = el(
      "tr",
      { class: f.numeric ? "has-num" : null },
      el("td", { class: "mono" }, f.table),
      el("td", { class: "mono" }, f.field),
      el("td", { class: "n" }, fmtNumber(f.changes)),
      el("td", {}, parts),
      el(
        "td",
        { class: "n mono" },
        f.numeric ? `↑${fmtNumber(f.up)} ↓${fmtNumber(f.down)}` : "",
      ),
    );
    tr.addEventListener("click", () => onPick(f.table, f.field));
    return tr;
  });

  return el(
    "div",
    { class: "fieldsummary" },
    el("h4", {}, t("bundle.whichFields")),
    el(
      "table",
      { class: "fields sortable" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, t("bundle.table")),
          el("th", {}, t("bundle.field")),
          el("th", { class: "n" }, t("bundle.changes")),
          el("th", {}, t("bundle.movement")),
          el("th", { class: "n" }, t("bundle.direction")),
        ),
      ),
      el("tbody", {}, rows),
    ),
    summary.valuesOmitted
      ? el(
          "p",
          { class: "note tight" },
          t("bundle.summaryPartial", {
            detailed: fmtNumber(summary.detailed),
            total: fmtNumber(summary.changeCount),
          }),
        )
      : null,
  );
}

/**
 * Recompute the bundle digest here and compare it with the chain.
 *
 * Deliberately shows the digest it computed even when it matches, so a reader can
 * paste it into a node query themselves rather than trusting the tick.
 */
async function verifyPanel(manifest, onChain, known, address) {
  const computed = await bundleDigest(manifest);
  const key = diffChainKey(manifest);

  let committed = onChain?.bundleDigest ?? null;
  if (known && committed === null) {
    // Ask the node ourselves. The API may simply not have looked.
    committed = await readChainEntry(address, key).catch(() => null);
  }

  const verdict =
    committed === null
      ? el("p", { class: "verdict warn" }, t("bundle.notOnChain"))
      : committed === computed
        ? el("p", { class: "verdict ok" }, t("bundle.digestOk"))
        : el("p", { class: "verdict bad" }, t("bundle.digestBad"));

  return el(
    "div",
    { class: "card" },
    verdict,
    el(
      "dl",
      { class: "kv" },
      el("dt", {}, t("bundle.digest")),
      el("dd", { class: "mono" }, computed),
      committed
        ? [
            el("dt", {}, t("bundle.onChain")),
            el(
              "dd",
              {},
              el("a", { class: "mono", href: chainLink(address, key), rel: "noopener" }, committed),
            ),
          ]
        : null,
      el("dt", {}, t("bundle.changesDigest")),
      el("dd", { class: "mono" }, manifest.changesSha256),
      el("dt", {}, "canon"),
      el("dd", { class: "mono" }, `${manifest.canonVersion} / ${manifest.bundleVersion}`),
    ),
    el("p", { class: "note" }, t("bundle.rebuild")),
    el(
      "pre",
      { class: "cmd" },
      `ancla bundle ${manifest.period} --from ${manifest.from.stamp} --to ${manifest.to.stamp}\n` +
        `ancla verify-bundle ${manifest.period}`,
    ),
  );
}

async function bundleSection(summary, known, address) {
  const wrap = el("section", { class: "bundle" });
  const [detail, fields] = await Promise.all([
    api(`/bundles/${summary.period}/${summary.pair}`),
    api(`/bundles/${summary.period}/${summary.pair}/fields`),
  ]);
  wrap.append(el("h3", {}, t("bundle.title")));
  wrap.append(await verifyPanel(detail.manifest, detail.onChain, known, address));

  wrap.append(
    el(
      "dl",
      { class: "kv counts" },
      KINDS.flatMap((k) => [
        el("dt", {}, t(`kind.${k}`)),
        el("dd", {}, fmtNumber(summary.counts[k])),
      ]),
    ),
  );

  // --- filters -------------------------------------------------------------
  //
  // Every row worth reading arrives in one payload and is filtered here rather
  // than by the server. That is 1.9 MB over the wire for 202608, and it buys
  // something worth more than the bytes: the page behaves identically against a
  // live API and against a static export, so there is no second code path that
  // can quietly disagree with the first.
  const all = (await api(`/bundles/${summary.period}/${summary.pair}/changes?readable=1`)) ?? {};
  const rows = all.changes ?? [];
  const state = { kind: "silentRevision", table: "", field: "", numeric: false };

  const kindSel = el(
    "select",
    {},
    el("option", { value: "" }, t("bundle.anyKind")),
    KINDS.map((k) => el("option", { value: k }, t(`kind.${k}`))),
  );
  kindSel.value = state.kind;

  const tableSel = el(
    "select",
    {},
    el("option", { value: "" }, t("bundle.anyTable")),
    fields.tables.map((x) => el("option", { value: x.table }, `${x.table} (${fmtNumber(x.rows)})`)),
  );

  const fieldSel = el("select", {}, el("option", { value: "" }, t("bundle.anyField")));
  function refreshFields() {
    const opts = fields.fields.filter((f) => !state.table || f.table === state.table);
    fieldSel.replaceChildren(
      el("option", { value: "" }, t("bundle.anyField")),
      ...opts.map((f) => el("option", { value: f.field }, `${f.field} (${fmtNumber(f.changes)})`)),
    );
    fieldSel.value = state.field;
  }
  refreshFields();

  const numericBox = el("input", { type: "checkbox" });
  const numericId = `num-${summary.period}-${summary.pair}`;
  numericBox.id = numericId;

  const controls = el(
    "form",
    { class: "filters" },
    el("div", { class: "field" }, el("label", {}, t("feed.filter.kind")), kindSel),
    el("div", { class: "field" }, el("label", {}, t("bundle.table")), tableSel),
    el("div", { class: "field" }, el("label", {}, t("bundle.field")), fieldSel),
    el(
      "div",
      { class: "field check" },
      numericBox,
      el("label", { for: numericId }, t("bundle.onlyNumeric")),
    ),
  );
  controls.addEventListener("submit", (e) => e.preventDefault());

  const count = el("p", { class: "count" });
  const list = el("div", { class: "changes" });
  const more = el("button", { type: "button", class: "ghost hidden" }, t("feed.loadMore"));

  const movedAsNumber = (line) =>
    (line.fields ?? []).some((f) => f.movement === "numeric");

  function matching() {
    return rows.filter(
      (l) =>
        (!state.kind || l.kind === state.kind) &&
        (!state.table || l.table === state.table) &&
        (!state.field || (l.fields ?? []).some((f) => f.field === state.field)) &&
        (!state.numeric || movedAsNumber(l)),
    );
  }

  let shown = 0;
  function load(reset) {
    const hits = matching();
    if (reset) {
      shown = 0;
      list.replaceChildren();
    }
    for (const line of hits.slice(shown, shown + PAGE)) list.append(changeRow(line));
    shown = Math.min(shown + PAGE, hits.length);
    count.textContent = t("bundle.showing", {
      shown: fmtNumber(shown),
      matched: fmtNumber(hits.length),
      total: fmtNumber(all.total ?? rows.length),
    });
    more.classList.toggle("hidden", shown >= hits.length);
    if (!hits.length) list.append(el("p", { class: "note" }, t("feed.empty")));
  }

  kindSel.addEventListener("change", () => {
    state.kind = kindSel.value;
    load(true);
  });
  tableSel.addEventListener("change", () => {
    state.table = tableSel.value;
    state.field = "";
    refreshFields();
    load(true);
  });
  fieldSel.addEventListener("change", () => {
    state.field = fieldSel.value;
    load(true);
  });
  numericBox.addEventListener("change", () => {
    state.numeric = numericBox.checked;
    load(true);
  });
  more.addEventListener("click", () => load(false));

  /** Clicking a line of the summary is the same as setting two filters by hand. */
  function pick(table, field) {
    state.kind = "";
    state.table = table;
    state.field = field;
    state.numeric = false;
    kindSel.value = "";
    tableSel.value = table;
    refreshFields();
    fieldSel.value = field;
    numericBox.checked = false;
    load(true);
    list.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const summaryPanel = fieldSummary({ ...fields }, pick);
  if (summaryPanel) wrap.append(summaryPanel);

  load(true);
  wrap.append(controls, count, list, el("div", { class: "row" }, more));
  return wrap;
}

async function render() {
  const [versions, bundles, recovery] = await Promise.all([
    api("/versions"),
    api("/bundles"),
    api("/recovery"),
  ]);

  const address = versions.anchor.address;
  const known = versions.anchorStateKnown;
  $("anchor-line").textContent = `${address} · ${versions.anchor.node}`;

  // Which publishers actually have something here. Taken from the data rather
  // than from a list in this file, so a country that starts being anchored shows
  // up without the page being edited.
  const present = [...new Set(versions.captures.map((c) => c.source))].sort();
  let current = present.includes(readSource()) ? readSource() : present[0];

  const picker = $("source-picker");
  picker.replaceChildren(
    ...present.map((id) => {
      const b = el("button", { type: "button", class: "srcbtn" }, sourceLabel(id));
      b.setAttribute("aria-pressed", String(id === current));
      b.addEventListener("click", () => {
        if (id === current) return;
        current = id;
        writeSource(id);
        for (const other of picker.children) {
          other.setAttribute("aria-pressed", String(other === b));
        }
        void draw();
      });
      return b;
    }),
  );
  picker.classList.toggle("hidden", present.length < 2);

  async function draw() {
    const caps = versions.captures.filter((c) => c.source === current);
    const byPeriod = new Map();
    for (const c of caps) {
      const at = byPeriod.get(c.period);
      if (at) at.push(c);
      else byPeriod.set(c.period, [c]);
    }

    const root = $("periods");
    root.replaceChildren(el("p", { class: "skeleton" }, t("common.loading")));
    const built = document.createDocumentFragment();

    const multi = [...byPeriod.entries()].filter(([, list]) => list.length > 1).sort();
    for (const [period, list] of multi) {
      const section = el(
        "section",
        { class: "period" },
        el("h2", {}, `${period} · ${list.length} ${t("versions.held")}`),
        list.map((c) => captureCard(c, known, address)),
      );
      const forPeriod = bundles.bundles.filter(
        (b) => b.period === period && b.source === current,
      );
      if (!forPeriod.length) {
        section.append(el("p", { class: "note" }, t("versions.bundleNone")));
      } else {
        for (const b of forPeriod) section.append(await bundleSection(b, known, address));
      }
      built.append(section);
    }

    // A publisher with nothing rewritten yet is the good outcome, not an empty
    // page: say what is held and that nothing has moved.
    if (!multi.length) {
      built.append(
        el(
          "p",
          { class: "note" },
          t("versions.nothingRewritten", {
            captures: fmtNumber(caps.length),
            periods: fmtNumber(byPeriod.size),
          }),
        ),
      );
    }
    root.replaceChildren(built);

    const gone = recovery.inventory.filter(
      (r) => r.source === current && r.status === "currentOnly",
    );
    const byDay = new Map();
    for (const r of gone) {
      const at = byDay.get(r.servedDay ?? "?");
      if (at) at.push(r.period);
      else byDay.set(r.servedDay ?? "?", [r.period]);
    }
    $("recovery").replaceChildren(
      byDay.size
        ? el(
            "table",
            { class: "fields" },
            el(
              "tbody",
              {},
              [...byDay.entries()].sort().map(([day, periods]) =>
                el(
                  "tr",
                  {},
                  el("td", { class: "mono" }, day),
                  el(
                    "td",
                    {},
                    `${fmtNumber(periods.length)} · ${periods[0]} – ${periods[periods.length - 1]}`,
                  ),
                ),
              ),
            ),
          )
        : el("p", { class: "note" }, t("versions.nothingLost")),
    );
  }

  await draw();
}

/** The chosen publisher rides in the URL, so a link carries what it showed. */
function readSource() {
  return new URLSearchParams(location.search).get("source") ?? "";
}

function writeSource(id) {
  const url = new URL(location.href);
  url.searchParams.set("source", id);
  history.replaceState(null, "", url);
}

boot(render);
