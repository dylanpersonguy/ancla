/**
 * Shared runtime for the two pages.
 *
 * The message catalogue is not shipped with the site. It is fetched from
 * GET /api/i18n/:lang, which is the same catalogue the API and the alert engine
 * use, so a string can only be wrong in one place. The cost is that the site needs
 * the API to render, which is acceptable: without the API there is no feed and no
 * proof to show, so a site that renders but says nothing would be worse.
 *
 * Two strings are hardcoded below, in both languages, for the case where the API
 * cannot be reached at all. They are the only exception and they exist so that the
 * failure is legible rather than blank.
 */

/**
 * Where the API lives, relative to whatever directory this page was served from.
 *
 * Not a hardcoded "/api". The same files are served at the root of their own
 * host and under /evidencia on decentralamerica.com, and an absolute path works
 * in exactly one of those. Deriving it from the page's own location means the
 * export is mountable anywhere without a build step or a config file, which is
 * the property that lets anyone mirror it under a path of their choosing.
 */
function defaultApiBase() {
  return `${location.pathname.replace(/[^/]*$/, "")}api`;
}

export const API =
  new URLSearchParams(location.search).get("api") || globalThis.ANCLA_API || defaultApiBase();

const OFFLINE = {
  es: "No se pudo contactar la API de Ancla. Vuelva a intentarlo en un momento.",
  en: "Could not reach the Ancla API. Try again in a moment.",
};

export const LANGS = ["es", "en"];
export const DEFAULT_LANG = "es";

let messages = {};
let lang = DEFAULT_LANG;

export function currentLang() {
  return lang;
}

/**
 * Spanish unless the reader has said otherwise, in the URL or by using the toggle.
 * The browser's own preference is deliberately not consulted: the audience is in
 * Costa Rica, and a Costa Rican lawyer on an English-configured laptop should still
 * land on the Spanish page.
 */
function preferredLang() {
  const q = new URLSearchParams(location.search).get("lang");
  if (LANGS.includes(q)) return q;
  try {
    const stored = localStorage.getItem("ancla.lang");
    if (LANGS.includes(stored)) return stored;
  } catch {
    /* storage blocked; the default applies */
  }
  return DEFAULT_LANG;
}

/** Look up a message. Unknown keys render as the key, which makes gaps visible. */
export function t(key, params = {}) {
  const raw = messages[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

export function offlineMessage() {
  return OFFLINE[lang] ?? OFFLINE.es;
}

export async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${API}${path}${sep}lang=${lang}`, {
    headers: { accept: "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.error?.message ?? `HTTP ${res.status}`;
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return body;
}

/** Fill every element tagged with a message key. Called after load and on switch. */
export function applyMessages(root = document) {
  for (const el of root.querySelectorAll("[data-t]")) el.textContent = t(el.dataset.t);
  for (const el of root.querySelectorAll("[data-t-placeholder]")) {
    el.placeholder = t(el.dataset.tPlaceholder);
  }
  for (const el of root.querySelectorAll("[data-t-title]")) el.title = t(el.dataset.tTitle);
  const title = document.querySelector("[data-t-document-title]");
  if (title) document.title = `${t(title.dataset.tDocumentTitle)} · ${t("app.name")}`;
  document.documentElement.lang = lang;
}

async function loadCatalogue(next) {
  const res = await fetch(`${API}/i18n/${next}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  messages = body.messages ?? {};
  lang = body.lang ?? next;
}

function wireLangButtons(onChange) {
  for (const button of document.querySelectorAll(".langs button")) {
    button.setAttribute("aria-pressed", String(button.dataset.lang === lang));
    button.addEventListener("click", async () => {
      if (button.dataset.lang === lang) return;
      try {
        localStorage.setItem("ancla.lang", button.dataset.lang);
      } catch {
        /* storage blocked; the switch still applies for this page view */
      }
      try {
        await loadCatalogue(button.dataset.lang);
      } catch {
        return;
      }
      for (const b of document.querySelectorAll(".langs button")) {
        b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
      }
      const url = new URL(location.href);
      url.searchParams.set("lang", lang);
      history.replaceState(null, "", url);
      applyMessages();
      await onChange?.();
    });
  }
}

/**
 * Boot a page: load the catalogue, translate the shell, wire the toggle.
 * `render` runs after the catalogue is in place and again on every switch.
 */
export async function boot(render) {
  lang = preferredLang();
  try {
    await loadCatalogue(lang);
  } catch {
    const banner = document.getElementById("banner");
    if (banner) {
      banner.textContent = offlineMessage();
      banner.classList.remove("hidden");
    }
    return;
  }
  applyMessages();
  wireLangButtons(render);
  await render?.();
}

// ------------------------------------------------------------------ helpers

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("data-") || k === "href" || k.startsWith("aria-")) {
      node.setAttribute(k, v);
    } else node[k] = v;
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function fmtNumber(n) {
  if (n === null || n === undefined) return "-";
  return new Intl.NumberFormat(lang === "es" ? "es-CR" : "en-US").format(n);
}

export function fmtDateTime(iso) {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(lang === "es" ? "es-CR" : "en-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(d);
}

export function fmtMonth(month) {
  if (!/^\d{6}$/.test(String(month ?? ""))) return month ?? "-";
  const d = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(4, 6)) - 1, 1));
  return new Intl.DateTimeFormat(lang === "es" ? "es-CR" : "en-CA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
}

export function shortHash(hex, n = 12) {
  return typeof hex === "string" && hex.length > n ? `${hex.slice(0, n)}…` : (hex ?? "-");
}
