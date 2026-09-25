// app.js — Digital Volume PoC (CORS-safe via Cloudflare Worker proxy)
// ✅ Uses available dates (data/available-dates.json) to constrain the date picker
// ✅ Defaults to mode=edition (Digital Volume)
// ✅ Fetches XML via your Worker proxy, which then fetches data.oireachtas.ie
// ✅ Toggle layout fix: toggle is positioned OUT OF FLOW so it cannot push the date down
// ✅ Date picker UX: no auto-correct while typing; auto-correct on change (picker selection) and/or Go, with hint
// ✅ DEFAULT_DATE is set dynamically to the latest date from data/available-dates.json
// ✅ Kebab menu: Save offline copy + Print + Share link (injected if missing)
// ✅ NEW: Back-to-top button (injected; no HTML/CSS changes required)

const NS = "http://docs.oasis-open.org/legaldocml/ns/akn/3.0/CSD13";

// Hard fallback only (used if available-dates.json fails to load)
const FALLBACK_DATE = "2026-09-17";
// Runtime default (set after we load available-dates.json)
let DEFAULT_DATE = FALLBACK_DATE;

// Cloudflare Worker proxy (CORS bypass)
const PROXY_BASE = "https://digital-volume-proxy.cassdavid.workers.dev/akn";

// Default mode: edition == Digital Volume
const DEFAULT_MODE = "edition"; // (web|edition)

/* -----------------------------
   URL builders
------------------------------ */

// Oireachtas canonical Akoma Ntoso endpoint pattern
function oirCanonicalXmlUrl(dateISO) {
  return `https://data.oireachtas.ie/akn/ie/debateRecord/dail/${dateISO}/debate/mul@/main.xml`;
}

// Proxied URL used by the browser (Worker fetches canonical, adds CORS headers)
function proxiedOirXmlUrl(dateISO) {
  const target = oirCanonicalXmlUrl(dateISO);
  return `${PROXY_BASE}?url=${encodeURIComponent(target)}`;
}

/* -----------------------------
   Query + mode helpers
------------------------------ */

/** Accepts ?date=YYYY-MM-DD */
function getDateFromQuery(fallback = DEFAULT_DATE) {
  const u = new URL(window.location.href);
  const d = u.searchParams.get("date");
  return /^\d{4}-\d{2}-\d{2}$/.test(d || "") ? d : fallback;
}

/** mode (web|edition) with default=edition */
function getModeFromQueryOrStorage(fallback = DEFAULT_MODE) {
  const u = new URL(window.location.href);
  const q = (u.searchParams.get("mode") || "").toLowerCase();
  const s = (localStorage.getItem("dv_mode") || "").toLowerCase();
  const mode = (q || s || fallback || "").toLowerCase();
  return mode === "web" ? "web" : "edition";
}

// Keep URL + storage in sync; edition is the default if absent
function setMode(mode) {
  const m = mode === "web" ? "web" : "edition";
  localStorage.setItem("dv_mode", m);

  const u = new URL(window.location.href);
  u.searchParams.set("mode", m);
  history.replaceState(null, "", u.toString());

  document.documentElement.setAttribute("data-mode", m);
}

function modeTitle(mode) {
  return mode === "edition" ? "Switch to Web view" : "Switch to Digital Volume view";
}

/* -----------------------------
   Utilities
------------------------------ */

function text(el) {
  return (el?.textContent || "").replace(/\s+/g, " ").trim();
}

function q1(nsParent, tag, pred = null) {
  const els = nsParent.getElementsByTagNameNS(NS, tag);
  if (!pred) return els[0] || null;
  for (const el of els) if (pred(el)) return el;
  return null;
}

function qAll(nsParent, tag) {
  return Array.from(nsParent.getElementsByTagNameNS(NS, tag));
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return node;
}

async function fetchTextOrThrow(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return await res.text();
}

async function loadXMLFromDate(dateISO) {
  const url = proxiedOirXmlUrl(dateISO);

  try {
    const xmlText = await fetchTextOrThrow(url);
    const doc = new DOMParser().parseFromString(xmlText, "application/xml");
    const pe = doc.getElementsByTagName("parsererror")[0];
    if (pe) throw new Error(`XML parse error for ${dateISO}`);
    return doc;
  } catch (e) {
    throw new Error(
      `Failed to load XML for ${dateISO}.\n\nTried:\n- ${url}\n\nLast error: ${String(e)}`
    );
  }
}

async function loadPageMap() {
  try {
    const res = await fetch("data/pagemap.json", { cache: "no-store" });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/* -----------------------------
   Speech id helper (used in render + citations)
------------------------------ */

function spkNumFromId(spkId) {
  if (!spkId) return "";
  const m = String(spkId).match(/^spk_(\d+)$/);
  return m ? m[1] : "";
}

/* -----------------------------
   Available dates (for date picker)
------------------------------ */

let AVAILABLE_DATES = null; // Set<string> once loaded
let AVAILABLE_SORTED = null; // string[] cached sorted ISO dates

async function loadAvailableDates() {
  try {
    const res = await fetch("data/available-dates.json", { cache: "no-store" });
    if (!res.ok) return null;
    const data = await res.json();

    // Accept either ["YYYY-MM-DD", ...] or { dates: [...] }
    const arr = Array.isArray(data) ? data : Array.isArray(data?.dates) ? data.dates : null;
    if (!arr) return null;

    const set = new Set(arr.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)));
    if (!set.size) return null;

    const sorted = Array.from(set).sort(); // ISO => lexicographic sort works
    AVAILABLE_SORTED = sorted;

    // Dynamic default is latest available date
    DEFAULT_DATE = sorted[sorted.length - 1] || FALLBACK_DATE;

    return set;
  } catch {
    return null;
  }
}

/** nearest earlier (or earliest) available; uses cached sorted list */
function nearestAvailableOnOrBefore(dateISO) {
  if (!AVAILABLE_DATES || !AVAILABLE_DATES.size || !AVAILABLE_SORTED?.length) return dateISO;
  if (AVAILABLE_DATES.has(dateISO)) return dateISO;

  const sorted = AVAILABLE_SORTED;
  // binary search first >= dateISO
  let lo = 0,
    hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < dateISO) lo = mid + 1;
    else hi = mid;
  }
  // choose previous (earlier) if possible, else first
  const idx = Math.max(0, lo - 1);
  return sorted[idx] || dateISO;
}

function setDatePickerConstraints(inputEl) {
  if (!inputEl || !AVAILABLE_SORTED?.length) return;

  inputEl.min = AVAILABLE_SORTED[0];
  inputEl.max = AVAILABLE_SORTED[AVAILABLE_SORTED.length - 1];

  // Optional <datalist> suggestions (browser support varies for type="date")
  const existing = document.getElementById("availableDatesList");
  if (existing) existing.remove();

  const dl = document.createElement("datalist");
  dl.id = "availableDatesList";
  for (const d of AVAILABLE_SORTED) {
    const opt = document.createElement("option");
    opt.value = d;
    dl.appendChild(opt);
  }
  document.body.appendChild(dl);
  inputEl.setAttribute("list", "availableDatesList");
}

/* -----------------------------
   Toggle styling (OUT OF FLOW)
------------------------------ */

function injectModeToggleStylesOnce() {
  if (document.getElementById("dvModeToggleStyles")) return;

  const css = `
/* Right column wrapper */
.tophead__datewrap{
  position: relative;
  justify-self: end;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
}

/* Date stays baseline-aligned with volume */
.tophead__date{
  text-align: right;
}

/* Toggle is OUT OF FLOW: it will not push the date */
.modeToggle{
  position: absolute;
  right: 32px; /* leave room for kebab button */
  top: 0;
  transform: translateY(-145%); /* adjust if you want it higher/lower */
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: var(--sans, system-ui);
  font-size: .82rem;
  color: rgba(0,0,0,.70);
  user-select: none;
  white-space: nowrap;
}

.modeToggle__label{ letter-spacing: .02em; }

.modeToggle__switch{
  appearance: none;
  border: 0;
  background: transparent;
  padding: 0;
  margin: 0;
  cursor: pointer;
  line-height: 0;
}

.modeToggle__track{
  display: inline-block;
  width: 44px;
  height: 24px;
  border-radius: 999px;
  border: 1px solid rgba(0,0,0,.22);
  background: rgba(0,0,0,.06);
  position: relative;
  vertical-align: middle;
  transition: background 140ms ease-in-out, border-color 140ms ease-in-out;
}

.modeToggle__thumb{
  position: absolute;
  top: 50%;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  border: 1px solid rgba(0,0,0,.22);
  transform: translateY(-50%);
  transition: left 140ms ease-in-out;
}

.modeToggle__switch[aria-checked="true"] .modeToggle__track{
  background: rgba(0,0,0,.14);
  border-color: rgba(0,0,0,.30);
}
.modeToggle__switch[aria-checked="true"] .modeToggle__thumb{ left: 23px; }

.modeToggle__switch:focus-visible{
  outline: 3px solid currentColor;
  outline-offset: 4px;
  border-radius: 999px;
}

@media print{ .modeToggle{ display:none !important; } }
`;

  const style = document.createElement("style");
  style.id = "dvModeToggleStyles";
  style.textContent = css;
  document.head.appendChild(style);
}

/* -----------------------------
   Kebab menu (Print / Offline / Share link)
------------------------------ */

function injectKebabStylesOnce() {
  if (document.getElementById("dvKebabStyles")) return;

  const css = `
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0;}

.kebab{
  position:absolute;
  right:0;
  top:0;
  transform: translateY(-145%); /* keep aligned with toggle row */
  z-index: 60;
}

.kebab__btn{
  background:transparent;
  border:0;
  cursor:pointer;
  padding:2px 6px;
  border-radius:999px;

  /* thicker feel */
  color: rgba(0,0,0,.84);
  font-weight: 700;
  font-size: 1.02em;
  line-height: 1;
}

.kebab__btn:hover{ background: rgba(0,0,0,.06); }

.kebab__btn:focus-visible{
  outline: 6px solid currentColor;
  outline-offset: 7px;
  border-radius: 999px;
}

.kebab__menu{
  margin-top: 8px;
  background: #fff;
  border: 1.5px solid rgba(0,0,0,.14);
  border-radius: 12px;
  box-shadow: 0 10px 28px rgba(0,0,0,.14);
  padding: 6px;
  min-width: 180px;
}

.kebab__item{
  width: 100%;
  text-align: left;
  border: 0;
  background: transparent;
  padding: 10px 10px;
  cursor: pointer;
  border-radius: 10px;
  font-family: var(--sans, system-ui);
  font-size: .92rem;

  /* thicker feel */
  font-weight: 600;
  color: rgba(0,0,0,.86);
}

.kebab__item:hover{ background: rgba(0,0,0,.06); }

@media print{ .kebab{ display:none !important; } }
`;

  const style = document.createElement("style");
  style.id = "dvKebabStyles";
  style.textContent = css;
  document.head.appendChild(style);
}

function closeKebab(menu, btn) {
  if (!menu || !btn) return;
  menu.hidden = true;
  btn.setAttribute("aria-expanded", "false");
}

function openKebab(menu, btn) {
  if (!menu || !btn) return;
  menu.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}

function ensureShareMenuItem(menu) {
  if (!menu) return null;

  let shareBtn = document.getElementById("shareLinkBtn");
  if (shareBtn) return shareBtn;

  // Insert between Offline and Print (nice UX)
  shareBtn = document.createElement("button");
  shareBtn.id = "shareLinkBtn";
  shareBtn.className = "kebab__item";
  shareBtn.type = "button";
  shareBtn.setAttribute("role", "menuitem");
  shareBtn.textContent = "Share link";

  const printBtn = document.getElementById("printBtn");
  if (printBtn && printBtn.parentElement === menu) {
    menu.insertBefore(shareBtn, printBtn);
  } else {
    menu.appendChild(shareBtn);
  }

  return shareBtn;
}

async function shareCurrentLink() {
  const url = new URL(window.location.href);

  // ensure a date exists in link
  const d = getDateFromQuery(DEFAULT_DATE);
  if (d) url.searchParams.set("date", d);

  // ensure mode exists in link
  url.searchParams.set("mode", getModeFromQueryOrStorage(DEFAULT_MODE));

  const shareUrl = url.toString();

  // Best case: native share sheet
  if (navigator.share) {
    try {
      await navigator.share({
        title: document.title || "Digital Volume",
        url: shareUrl,
      });
      return;
    } catch {
      // user cancelled; fall through to clipboard
    }
  }

  // Clipboard fallback
  try {
    await navigator.clipboard.writeText(shareUrl);
    toastHint(`Link copied: ${shareUrl}`);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = shareUrl;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    toastHint(`Link copied: ${shareUrl}`);
  }
}

let TOAST_TIMER = null;
function toastHint(msg) {
  const hint = document.getElementById("loadHint");
  if (!hint) return;

  hint.textContent = msg;
  if (TOAST_TIMER) window.clearTimeout(TOAST_TIMER);
  TOAST_TIMER = window.setTimeout(() => {
    hint.textContent = "";
  }, 2200);
}

async function downloadOfflineSnapshot() {
  const article = document.querySelector("article.edition");
  if (!article) return;

  let cssText = "";
  try {
    const res = await fetch("css/styles.css", { cache: "no-store" });
    cssText = res.ok ? await res.text() : "";
  } catch {
    cssText = "";
  }

  // Clone and remove web-only controls
  const clone = article.cloneNode(true);
  clone.querySelector(".loader")?.remove();
  clone.querySelector(".modeToggle")?.remove();
  clone.querySelector(".kebab")?.remove();
  clone.querySelector(".toc__toggle")?.remove();

  const safeDate = getDateFromQuery(DEFAULT_DATE);
  const filename = safeDate ? `digital-volume-${safeDate}.html` : "digital-volume-offline.html";

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Official Report | Digital Volume (Offline)</title>
<style>${cssText}</style>
</head>
<body style="background:#fff">
${clone.outerHTML}
</body>
</html>`;

  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function wireKebabMenu() {
  const btn = document.getElementById("kebabBtn");
  const menu = document.getElementById("kebabMenu");
  if (!btn || !menu) return;

  injectKebabStylesOnce();

  const shareBtn = ensureShareMenuItem(menu);
  const offlineBtn = document.getElementById("offlineBtn");
  const printBtn = document.getElementById("printBtn");

  btn.addEventListener("click", () => {
    const isOpen = btn.getAttribute("aria-expanded") === "true";
    if (isOpen) closeKebab(menu, btn);
    else openKebab(menu, btn);
  });

  document.addEventListener("click", (e) => {
    if (btn.contains(e.target) || menu.contains(e.target)) return;
    closeKebab(menu, btn);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeKebab(menu, btn);
  });

  if (printBtn) {
    printBtn.addEventListener("click", () => {
      closeKebab(menu, btn);
      window.print();
    });
  }

  if (offlineBtn) {
    offlineBtn.addEventListener("click", async () => {
      closeKebab(menu, btn);
      await downloadOfflineSnapshot();
    });
  }

  if (shareBtn) {
    shareBtn.addEventListener("click", async () => {
      closeKebab(menu, btn);
      await shareCurrentLink();
    });
  }
}

/* -----------------------------
   Mode switch wiring (uses existing #modeSwitch in index.html)
------------------------------ */

function wireModeSwitch({ inputEl }) {
  const modeSwitch = document.getElementById("modeSwitch");
  if (!modeSwitch) return;

  const paint = () => {
    const m = getModeFromQueryOrStorage(DEFAULT_MODE);
    setMode(m);

    // aria-checked=true means Digital Volume is active
    modeSwitch.setAttribute("aria-checked", String(m === "edition"));
    modeSwitch.title = modeTitle(m);
  };

  const toggle = () => {
    const cur = getModeFromQueryOrStorage(DEFAULT_MODE);
    const next = cur === "edition" ? "web" : "edition";
    setMode(next);
    paint();

    if (next === "web") {
      const d = (inputEl?.value || getDateFromQuery(DEFAULT_DATE) || DEFAULT_DATE).trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        window.location.href = `https://www.oireachtas.ie/en/debates/debate/dail/${d}/`;
      }
    }
  };

  paint();

  modeSwitch.addEventListener("click", toggle);
  modeSwitch.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
}

/* -----------------------------
   Date picker wiring (UX you described)
------------------------------ */

function wireDatePickerUI() {
  injectModeToggleStylesOnce();

  const input = document.getElementById("datePicker");
  const button = document.getElementById("loadBtn");
  const hint = document.getElementById("loadHint");

  if (input && AVAILABLE_SORTED?.length) setDatePickerConstraints(input);

  const requested = getDateFromQuery(DEFAULT_DATE);
  const initial =
    AVAILABLE_DATES && AVAILABLE_DATES.size ? nearestAvailableOnOrBefore(requested) : requested;

  if (input) input.value = initial;

  if (input && hint) {
    input.addEventListener("input", () => {
      hint.textContent = "";
    });
  }

  if (input && hint) {
    input.addEventListener("change", () => {
      const raw = (input.value || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return;

      if (AVAILABLE_DATES && AVAILABLE_DATES.size && !AVAILABLE_DATES.has(raw)) {
        const nearest = nearestAvailableOnOrBefore(raw);
        input.value = nearest;
        hint.textContent = `No XML for ${raw}. Nearest available: ${nearest}.`;
      } else {
        hint.textContent = "";
      }
    });
  }

  const go = () => {
    if (!input) return;

    const raw = (input.value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      if (hint) hint.textContent = "Enter a date in YYYY-MM-DD format.";
      return;
    }

    let chosen = raw;

    if (AVAILABLE_DATES && AVAILABLE_DATES.size && !AVAILABLE_DATES.has(raw)) {
      const nearest = nearestAvailableOnOrBefore(raw);
      chosen = nearest;
      if (hint) hint.textContent = `No XML for ${raw}. Loading nearest available: ${nearest}.`;
      input.value = chosen;
    } else {
      if (hint) hint.textContent = "";
    }

    const u = new URL(window.location.href);
    u.searchParams.set("date", chosen);
    u.searchParams.set("mode", getModeFromQueryOrStorage(DEFAULT_MODE));
    window.location.href = u.toString();
  };

  if (button) button.addEventListener("click", go);
  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });
  }

  wireModeSwitch({ inputEl: input });
}

/* -----------------------------
   Back to Top (injected) — no HTML/CSS changes needed
------------------------------ */

function injectBackToTopStylesOnce() {
  if (document.getElementById("dvBackToTopStyles")) return;

  const css = `
.backtotop{
  position: fixed;
  right: 22px;
  bottom: 28px;

  width: 44px;
  height: 44px;
  border-radius: 999px;

  border: 1px solid rgba(0,0,0,.18);
  background: #fff;
  color: rgba(0,0,0,.75);

  font-family: var(--sans, system-ui);
  font-size: 1.2rem;
  font-weight: 700;

  cursor: pointer;
  box-shadow: 0 6px 18px rgba(0,0,0,.12);

  opacity: 0;
  pointer-events: none;
  transform: translateY(6px);
  transition: opacity 180ms ease, transform 180ms ease;
}

.backtotop--visible{
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.backtotop:hover{
  background: rgba(0,0,0,.06);
}

.backtotop:focus-visible{
  outline: 3px solid currentColor;
  outline-offset: 4px;
}

@media print{
  .backtotop{ display:none !important; }
}
`;

  const style = document.createElement("style");
  style.id = "dvBackToTopStyles";
  style.textContent = css;
  document.head.appendChild(style);
}

function enableBackToTop() {
  injectBackToTopStylesOnce();

  // Avoid duplicate injection if init() runs again
  if (document.querySelector(".backtotop")) return;

  const btn = document.createElement("button");
  btn.className = "backtotop";
  btn.type = "button";
  btn.setAttribute("aria-label", "Back to top");
  btn.setAttribute("title", "Back to top");
  btn.textContent = "↑";
  document.body.appendChild(btn);

  const showAfter = 600;

  const updateVisibility = () => {
    if (window.scrollY > showAfter) btn.classList.add("backtotop--visible");
    else btn.classList.remove("backtotop--visible");
  };

  window.addEventListener("scroll", updateVisibility, { passive: true });
  updateVisibility();

  btn.addEventListener("click", () => {
    // You already have id="top" on the masthead header
    const top = document.getElementById("top") || document.body;
    top.scrollIntoView({ behavior: "smooth", block: "start" });
  });
}

/* -----------------------------
   Inline rendering
------------------------------ */

function inlineNodes(xmlEl) {
  if (!xmlEl) return [];
  const out = [];

  const isText = (n) => n.nodeType === Node.TEXT_NODE;
  const isEl = (n) => n.nodeType === Node.ELEMENT_NODE;
  const norm = (s) => (s || "").replace(/\s+/g, " ");

  function pushText(s) {
    const t = norm(s);
    if (!t.trim()) return;
    const last = out[out.length - 1];
    if (last && last.nodeType === Node.TEXT_NODE) last.nodeValue += t;
    else out.push(document.createTextNode(t));
  }

  function pushNode(node) {
    if (node) out.push(node);
  }

  function walk(node) {
    for (const child of Array.from(node.childNodes)) {
      if (isText(child)) {
        pushText(child.nodeValue || "");
        continue;
      }
      if (isEl(child)) {
        const ln = child.localName;

        if (ln === "i" || ln === "em") {
          const inner = inlineNodes(child);
          if (inner.length) pushNode(el("em", {}, inner));
          continue;
        }

        if (ln === "b" || ln === "strong") {
          const inner = inlineNodes(child);
          if (inner.length) pushNode(el("strong", {}, inner));
          continue;
        }

        if (ln === "q" || ln === "quote") {
          pushText("“");
          walk(child);
          pushText("”");
          continue;
        }

        if (ln === "br") {
          pushNode(document.createElement("br"));
          continue;
        }

        walk(child);
      }
    }
  }

  walk(xmlEl);

  if (out.length && out[0].nodeType === Node.TEXT_NODE) {
    out[0].nodeValue = out[0].nodeValue.replace(/^\s+/, "");
    if (!out[0].nodeValue.trim()) out.shift();
  }
  if (out.length && out[out.length - 1].nodeType === Node.TEXT_NODE) {
    out[out.length - 1].nodeValue = out[out.length - 1].nodeValue.replace(/\s+$/, "");
    if (!out[out.length - 1].nodeValue.trim()) out.pop();
  }

  const spaced = [];
  for (let i = 0; i < out.length; i++) {
    const cur = out[i];
    const prev = spaced[spaced.length - 1];

    const prevIsText = prev && prev.nodeType === Node.TEXT_NODE;
    const curIsText = cur.nodeType === Node.TEXT_NODE;

    if (prev && (!prevIsText || !curIsText)) {
      const prevText = prevIsText ? prev.nodeValue : "";
      const curText = curIsText ? cur.nodeValue : "";

      const prevEndsSpace = prevIsText ? /\s$/.test(prevText) : false;
      const curStartsSpace = curIsText ? /^\s/.test(curText) : false;

      if (!prevEndsSpace && !curStartsSpace) {
        const prevEndsPunct = prevIsText ? /[“(\[]$/.test(prevText) : false;
        const curStartsPunct = curIsText ? /^[,.;:!?)}\]]/.test(curText) : false;
        if (!prevEndsPunct && !curStartsPunct) spaced.push(document.createTextNode(" "));
      }
    }

    spaced.push(cur);
  }

  return spaced;
}

/* -----------------------------
   Title page fill
------------------------------ */

let DOC_DATE_ISO = "";

// Historical column map: target eId -> column label (e.g., "Col. 2850")
let COL_BY_TARGET = new Map();

function getDocDateISO(doc) {
  const preface = q1(doc, "preface");
  if (!preface) return "";
  const blocks = qAll(preface, "block");
  const dateBlock =
    blocks.find((b) => b.getAttribute("name") === "date_en") ||
    blocks.find((b) => b.getAttribute("name") === "date_ga") ||
    null;
  if (!dateBlock) return "";
  const docDate = q1(dateBlock, "docDate");
  return docDate?.getAttribute("date") || "";
}

function getDocDateText(doc) {
  const preface = q1(doc, "preface");
  if (!preface) return "";
  const blocks = qAll(preface, "block");
  const dateBlock =
    blocks.find((b) => b.getAttribute("name") === "date_en") ||
    blocks.find((b) => b.getAttribute("name") === "date_ga") ||
    null;
  if (!dateBlock) return "";
  const docDate = q1(dateBlock, "docDate");
  return text(docDate || dateBlock);
}

function fillTitlePage(doc) {
  const preface = q1(doc, "preface");
  if (!preface) return;

  const blockByName = (name) => {
    const blocks = qAll(preface, "block");
    return blocks.find((b) => b.getAttribute("name") === name) || null;
  };

  const getBlockText = (name, innerTag) => {
    const b = blockByName(name);
    if (!b) return "";
    const inner = innerTag ? q1(b, innerTag) : null;
    return text(inner || b);
  };

  const vol = getBlockText("volume", "docNumber");
  const no = getBlockText("number", "docNumber");

  const volnoEl = document.getElementById("volno");
  const pubdateEl = document.getElementById("pubdate");

  if (volnoEl) volnoEl.innerHTML = `${vol}<br>${no}`;

  if (pubdateEl) {
    const dateText = getDocDateText(doc) || "";
    pubdateEl.innerHTML = dateText.includes(",") ? dateText.replace(",", ",<br>") : dateText;
  }

  const titleGa = document.getElementById("title_ga");
  const titleEn = document.getElementById("title_en");
  const house = document.getElementById("house");

  if (titleGa) titleGa.textContent = getBlockText("title_ga", "docTitle");
  if (titleEn) titleEn.textContent = getBlockText("title_en", "docTitle");
  if (house) house.textContent = getBlockText("proponent_ga", "docProponent") || "DÁIL ÉIREANN";

  const statusGa = document.getElementById("status_ga");
  const statusEn = document.getElementById("status_en");
  if (statusGa) statusGa.textContent = getBlockText("status_ga", "docStatus");
  if (statusEn) statusEn.textContent = getBlockText("status_en", "docStatus");

  const statusGaEm = document.getElementById("status_ga_em");
  const statusEnEm = document.getElementById("status_en_em");
  if (statusGaEm) statusGaEm.textContent = "—Neamhcheartaithe";
  if (statusEnEm) statusEnEm.textContent = "—Unrevised";

  const kicker = document.getElementById("kicker");
  if (kicker) kicker.textContent = "";
}

/* -----------------------------
   Chamber extraction + Irish-correct casing
------------------------------ */

function getDocProponent(doc) {
  const preface = q1(doc, "preface");
  if (!preface) return "";
  const blocks = qAll(preface, "block");
  const b =
    blocks.find((x) => x.getAttribute("name") === "proponent_ga") ||
    blocks.find((x) => x.getAttribute("name") === "proponent_en") ||
    null;
  if (!b) return "";
  const p = q1(b, "docProponent");
  return text(p || b);
}

function normalizeChamber(raw) {
  const s = (raw || "").replace(/\s+/g, " ").trim();
  const low = s.toLowerCase();
  if (low.includes("dáil")) return "Dáil Éireann";
  if (low.includes("seanad")) return "Seanad Éireann";
  return s
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatLongDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" });
}

function getEditionDateText() {
  const pub = document.getElementById("pubdate");
  if (!pub) return "";
  return (pub.textContent || "").replace(/\s+/g, " ").trim();
}

/* -----------------------------
   Historical columns (≤2012)
------------------------------ */

function getDocYearISO() {
  const m = (DOC_DATE_ISO || "").match(/^(\d{4})-/);
  return m ? parseInt(m[1], 10) : NaN;
}

function buildColumnMap(doc) {
  COL_BY_TARGET = new Map();

  const year = getDocYearISO();
  if (!Number.isFinite(year) || year > 2012) return;

  const all = Array.from(doc.getElementsByTagName("*")).filter((n) => n.localName === "column");
  for (const c of all) {
    const refersTo = c.getAttribute("refersTo") || "";
    const showAs = c.getAttribute("showAs") || "";
    if (!refersTo || !showAs) continue;

    const target = refersTo.startsWith("#") ? refersTo.slice(1) : refersTo;
    if (!target) continue;

    const label = showAs.trim();
    if (!label) continue;

    if (!COL_BY_TARGET.has(target)) COL_BY_TARGET.set(target, label);
  }
}

function makeColMarker(label, targetId) {
  return el("div", { class: "col-marker__wrap" }, [
    el("span", {
      class: "col-marker",
      text: label,
      title: targetId ? `Column marker for ${targetId}` : label,
    }),
  ]);
}

/* -----------------------------
   ToC + Column jump UI
------------------------------ */

function scrollToId(id) {
  if (!id) return;
  const elTarget = document.getElementById(id);
  if (!elTarget) return;
  elTarget.scrollIntoView({ behavior: "smooth", block: "start" });
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
}

function buildTOCFromDOM() {
  const tocHost = document.getElementById("toc");
  if (!tocHost) return;
  tocHost.innerHTML = "";

  const main = document.getElementById("main");
  if (!main) return;

  const sections = Array.from(main.querySelectorAll("section.section[id]"));
  const items = [];

  for (const sec of sections) {
    const name = (sec.getAttribute("data-section") || "").toLowerCase();
    if (name === "ta" || name === "nil" || name === "staon") continue;

    const heading = sec.querySelector(".section__heading");
    const title = heading ? (heading.textContent || "").replace(/\s+/g, " ").trim() : "";
    if (!title) continue;

    const tag = heading ? heading.tagName.toLowerCase() : "h2";
    const level = tag.startsWith("h") ? parseInt(tag.slice(1), 10) : 2;
    const depthClass = `toc__item--d${Math.min(6, Math.max(2, level))}`;

    items.push({ id: sec.id, title, depthClass });
  }

  if (!items.length && COL_BY_TARGET.size === 0) return;

  const panelId = "toc-panel";
  const header = el("div", { class: "toc__header" });

  const toggle = el("button", {
    class: "toc__toggle",
    type: "button",
    "aria-expanded": "false",
    "aria-controls": panelId,
    text: "CONTENTS ▸",
  });

  const panel = el("div", { class: "toc__panel", id: panelId }, []);
  panel.setAttribute("hidden", "");
  panel.appendChild(el("a", { class: "toc__skip", href: "#main", text: "Skip to debate ↓" }));

  if (COL_BY_TARGET.size > 0) {
    const colWrap = el("div", { class: "col-jump" }, []);
    const label = el("label", {
      class: "col-jump__label",
      for: "colJumpInput",
      text: "Go to column",
    });
    const input = el("input", {
      class: "col-jump__input",
      id: "colJumpInput",
      type: "text",
      inputmode: "numeric",
      placeholder: "e.g. 2850",
      "aria-label": "Go to column number",
    });
    const btn = el("button", { class: "col-jump__btn", type: "button", text: "Go" });

    const go = () => {
      const raw = (input.value || "").trim();
      const m = raw.match(/\d{3,6}/);
      if (!m) return;

      const targetLabel = `Col. ${m[0]}`;
      for (const [targetId, lbl] of COL_BY_TARGET.entries()) {
        if ((lbl || "").trim() === targetLabel) {
          scrollToId(targetId);
          return;
        }
      }
    };

    btn.addEventListener("click", go);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        go();
      }
    });

    colWrap.appendChild(label);
    colWrap.appendChild(el("div", { class: "col-jump__row" }, [input, btn]));
    panel.appendChild(colWrap);
  }

  const list = el("ul", { class: "toc__list" });
  for (const it of items) {
    const a = el("a", { class: "toc__link", href: `#${it.id}`, text: it.title });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      scrollToId(it.id);
    });
    list.appendChild(el("li", { class: `toc__item ${it.depthClass}` }, [a]));
  }
  panel.appendChild(list);

  const LABEL_CLOSED = "CONTENTS ▸";
  const LABEL_OPEN = "CONTENTS ▾";

  toggle.addEventListener("click", () => {
    const isOpen = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!isOpen));
    if (isOpen) {
      panel.setAttribute("hidden", "");
      toggle.textContent = LABEL_CLOSED;
    } else {
      panel.removeAttribute("hidden");
      toggle.textContent = LABEL_OPEN;
    }
  });

  header.appendChild(toggle);
  tocHost.classList.add("toc");
  tocHost.appendChild(header);
  tocHost.appendChild(panel);
}

/* -----------------------------
   debateBody rendering (RECURSIVE + divisions)
------------------------------ */

function renderBody(doc, pageMap = []) {
  const main = document.getElementById("main");
  if (!main) return;
  main.innerHTML = "";

  const debateBody = q1(doc, "debateBody");
  if (!debateBody) {
    main.appendChild(el("p", { text: "No debateBody found." }));
    return;
  }

  const pageByEid = new Map();
  for (const row of pageMap) {
    if (!row || typeof row !== "object") continue;
    const page = row.page;
    const eid = row.eid;
    if (!eid || page === null || page === undefined) continue;
    pageByEid.set(String(eid), String(page));
  }

  const maybePageMarker = (eid) => {
    const p = pageByEid.get(String(eid || ""));
    if (!p) return null;
    return el("div", { class: "page-marker", "data-page": p, id: `p-${p}` });
  };

  const maybeColMarker = (targetEid) => {
    const label = COL_BY_TARGET.get(String(targetEid || ""));
    if (!label) return null;
    return makeColMarker(label, targetEid);
  };

  const renderHeadingDirect = (sec, sectionEl, level = 2) => {
    const directHeading = Array.from(sec.children).find((n) => n.localName === "heading");
    const content = directHeading ? inlineNodes(directHeading) : [];
    if (directHeading && content.length) {
      const tag = `h${Math.min(6, Math.max(2, level))}`;
      sectionEl.appendChild(el(tag, { class: "section__heading" }, content));
    }
  };

  const renderSummary = (s) => {
    const clsRaw = (s.getAttribute("class") || "").toLowerCase();
    const sId = s.getAttribute("eId") || "";
    const content = inlineNodes(s);
    if (!content.length) return null;

    const t = (s.textContent || "").replace(/\s+/g, " ").trim();
    const tLower = t.toLowerCase();

    const isDivisionLine = /^the\s+d[áa]il\s+divided:/i.test(t);
    const isSectionCaps = /^SECTION\s+\d+\b/.test(t) && t === t.toUpperCase();
    if (isSectionCaps) return null;

    const isInterruptions = /^\(\s*interruptions?\s*\)\s*\.?\s*$/i.test(t);
    const isPrayer =
      /^paidir agus machnamh\s*\.?\s*$/i.test(t) || /^prayer and reflection\s*\.?\s*$/i.test(t);

    const isChairFormula =
      tLower.startsWith("chuaigh an cathaoirleach") ||
      tLower.startsWith("chuaigh an cathaoirleach gníomhach") ||
      tLower.startsWith("chuaigh an ceann comhairle") ||
      tLower.startsWith("chuaigh an leas-cheann comhairle");

    const shouldItalicise = (isInterruptions || isPrayer) && !isChairFormula;

    const classes = [
      "summary",
      clsRaw.includes("center") ? "center" : "",
      isDivisionLine ? "summary--divisionline" : "",
      shouldItalicise ? "summary--italic" : "",
    ]
      .filter(Boolean)
      .join(" ");

    return el("p", { class: classes, id: sId || undefined }, content);
  };

  const renderQuestion = (q) => {
    const qId = q.getAttribute("eId") || "";
    const wrap = el("div", { class: "question", id: qId || undefined }, []);

    const ps = Array.from(q.children).filter((n) => n.localName === "p");
    for (const pEl of ps) {
      const pid = pEl.getAttribute("eId") || "";
      const ppm = maybePageMarker(pid);
      if (ppm) wrap.appendChild(ppm);

      const content = inlineNodes(pEl);
      if (!content.length) continue;
      wrap.appendChild(el("p", { class: "question__p", id: pid || undefined }, content));
    }
    return wrap;
  };

  const renderSpeech = (sp) => {
    const spId = sp.getAttribute("eId") || "";

    const fromEl = q1(sp, "from");
    const fromTxt = text(fromEl);
    const speakerName = fromTxt ? fromTxt.replace(/\s*\d{4}.*$/, "").trim() : "";

    const speechWrap = el("article", {
      class: "speech",
      id: spId || undefined,
      "data-speaker": speakerName || null,
    });

    const spkNum = spkNumFromId(spId);
    if (spkNum) speechWrap.setAttribute("data-spknum", spkNum);

    const ps = Array.from(sp.children).filter((n) => n.localName === "p");
    ps.forEach((pEl, idx) => {
      const pid = pEl.getAttribute("eId") || "";
      const extraClass = (pEl.getAttribute("class") || "").trim();

      const ppm = maybePageMarker(pid);
      if (ppm) speechWrap.appendChild(ppm);

      const content = inlineNodes(pEl);
      if (!content.length) return;

      const cls = `speech__p${idx === 0 ? " speech__p--first" : ""}${
        extraClass ? ` ${extraClass}` : ""
      }`;

      if (idx === 0 && speakerName) {
        speechWrap.appendChild(
          el("p", { class: cls, id: pid || undefined }, [
            el("span", { class: "speaker", text: `${speakerName}:` }),
            " ",
            ...content,
          ])
        );
      } else {
        speechWrap.appendChild(el("p", { class: cls, id: pid || undefined }, content));
      }
    });

    return { spId, node: speechWrap };
  };

  const renderDivision = (divisionSec) => {
    const wrapper = el("section", {
      class: "division",
      id: divisionSec.getAttribute("eId") || undefined,
    });

    const preSummaries = [];
    const postSummaries = [];
    let seenVoteBlock = false;

    const isVoteBlock = (n) => {
      if (!n || n.localName !== "debateSection") return false;
      const nm = (n.getAttribute("name") || "").toLowerCase();
      return nm === "ta" || nm === "nil" || nm === "staon";
    };

    for (const child of Array.from(divisionSec.children)) {
      if (isVoteBlock(child)) {
        seenVoteBlock = true;
        continue;
      }
      if (child.localName === "summary") {
        const sNode = renderSummary(child);
        if (sNode) (seenVoteBlock ? postSummaries : preSummaries).push(sNode);
      }
    }

    const getVoteList = (name) => {
      const sec = Array.from(divisionSec.children).find(
        (n) =>
          n.localName === "debateSection" &&
          (n.getAttribute("name") || "").toLowerCase() === name
      );
      if (!sec) return [];
      const ps = Array.from(sec.children).filter((n) => n.localName === "p");
      return ps
        .slice(1)
        .map((p) => {
          const personEl = Array.from(p.children).find((n) => n.localName === "person");
          return text(personEl || p);
        })
        .filter(Boolean);
    };

    const ta = getVoteList("ta");
    const nil = getVoteList("nil");
    const staon = getVoteList("staon");
    const maxLen = Math.max(ta.length, nil.length, staon.length);

    for (const s of preSummaries) wrapper.appendChild(s);

    const table = el("table", { class: "division__table" });
    table.appendChild(
      el("thead", {}, [
        el("tr", {}, [
          el("th", { scope: "col", text: "Tá" }),
          el("th", { scope: "col", text: "Níl" }),
          el("th", { scope: "col", text: "Staon" }),
        ]),
      ])
    );

    const tbody = el("tbody");
    for (let i = 0; i < maxLen; i++) {
      tbody.appendChild(
        el("tr", {}, [
          el("td", { text: ta[i] || "" }),
          el("td", { text: nil[i] || "" }),
          el("td", { text: staon[i] || "" }),
        ])
      );
    }
    table.appendChild(tbody);
    wrapper.appendChild(table);

    for (const s of postSummaries) wrapper.appendChild(s);

    return wrapper;
  };

  function renderDebateSection(sec, level = 2) {
    const eId = sec.getAttribute("eId") || "";
    const nameRaw = sec.getAttribute("name") || "";
    const name = nameRaw.toLowerCase();

    if (name === "division") return renderDivision(sec);

    const sectionEl = el("section", {
      class: "section",
      id: eId || undefined,
      "data-section": name,
    });

    const cm = maybeColMarker(eId);
    if (cm) sectionEl.appendChild(cm);

    renderHeadingDirect(sec, sectionEl, level);

    for (const child of Array.from(sec.children)) {
      const tag = child.localName;

      if (tag === "heading") continue;

      if (tag === "summary") {
        const sNode = renderSummary(child);
        if (sNode) sectionEl.appendChild(sNode);
        continue;
      }

      if (tag === "question") {
        const qNode = renderQuestion(child);
        if (qNode) sectionEl.appendChild(qNode);
        continue;
      }

      if (tag === "speech") {
        const { spId, node } = renderSpeech(child);

        const cm2 = maybeColMarker(spId);
        if (cm2) sectionEl.appendChild(cm2);

        const pm = maybePageMarker(spId);
        if (pm) sectionEl.appendChild(pm);

        sectionEl.appendChild(node);
        continue;
      }

      if (tag === "debateSection") {
        sectionEl.appendChild(renderDebateSection(child, level + 1));
        continue;
      }

      const content = inlineNodes(child);
      if (content.length) sectionEl.appendChild(el("p", { class: "fallback" }, content));
    }

    return sectionEl;
  }

  const topSections = Array.from(debateBody.children).filter((n) => n.localName === "debateSection");
  for (const sec of topSections) main.appendChild(renderDebateSection(sec, 2));
}

/* -----------------------------
   Citation UX (speech-level)
------------------------------ */

function formatAccessedDate(d = new Date()) {
  return d.toLocaleDateString("en-IE", { day: "2-digit", month: "long", year: "numeric" });
}

function getEditionYear() {
  const dt = getEditionDateText();
  const m = dt.match(/\b(19|20)\d{2}\b/);
  return m ? m[0] : "";
}

function normalizeSpeakerForCitation(name) {
  const s = (name || "").trim();
  if (!s) return "Unknown";
  if (/^(An|A|Ceann|Cathaoirleach|Leas)/i.test(s)) return s;

  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length === 1) return s;

  const last = parts[parts.length - 1].replace(/[^\p{L}\p{M}'-]/gu, "");
  const initials = parts
    .slice(0, -1)
    .filter((p) => !/^(Mr|Mrs|Ms|Dr|President|Taoiseach|Tánaiste|Deputy)$/i.test(p))
    .map((p) => p[0].toUpperCase() + ".")
    .join("");

  return initials ? `${last}, ${initials}` : last;
}

function makeSpeechCitation({ speakerName, spkId }) {
  const year = getEditionYear() || (DOC_DATE_ISO ? DOC_DATE_ISO.slice(0, 4) : "");
  const dateText = getEditionDateText() || DOC_DATE_ISO;
  const accessed = formatAccessedDate(new Date());

  const spkNum = spkNumFromId(spkId) || "";
  const dateIso = DOC_DATE_ISO || "";
  const url = `https://www.oireachtas.ie/en/debates/debate/dail/${dateIso}/speech/${spkNum}/`;
  const author = normalizeSpeakerForCitation(speakerName);

  return `${author}, (${year}), Dáil Debates (Unrevised), [online], ${dateText}, Available at: ${url} (accessed ${accessed})`;
}

async function copyToClipboard(textToCopy) {
  try {
    await navigator.clipboard.writeText(textToCopy);
    return true;
  } catch {
    const ta = document.createElement("textarea");
    ta.value = textToCopy;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

function enableSpeechLinkCopy() {
  const speeches = document.querySelectorAll(".speech[id][data-speaker]");
  if (!speeches.length) return;

  for (const sp of speeches) {
    const spkId = sp.getAttribute("id") || "";
    const speakerName = sp.getAttribute("data-speaker") || "";
    const spkNum = spkNumFromId(spkId);

    if (spkNum && !sp.hasAttribute("data-spknum")) sp.setAttribute("data-spknum", spkNum);

    sp.setAttribute("title", `Copy citation for ${speakerName || spkId}`);
    if (!sp.hasAttribute("tabindex")) sp.setAttribute("tabindex", "0");

    const doCopy = async () => {
      const citation = makeSpeechCitation({ speakerName, spkId });
      const ok = await copyToClipboard(citation);

      sp.setAttribute("data-copied", ok ? "true" : "false");
      window.setTimeout(() => sp.removeAttribute("data-copied"), 1400);

      if (ok) {
        const oldTitle = sp.getAttribute("title") || "";
        sp.setAttribute("title", "Copied!");
        window.setTimeout(() => sp.setAttribute("title", oldTitle), 900);
      }
    };

    sp.addEventListener("click", (e) => {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      const target = e.target;
      if (target && target.closest && target.closest("a")) return;
      doCopy();
    });

    sp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        doCopy();
      }
    });
  }
}

/* -----------------------------
   Paged media running strings (Vivliostyle)
------------------------------ */

function setRunningStrings({ chamber, dateText }) {
  const chamberEl = document.getElementById("runningChamber");
  if (chamberEl) chamberEl.textContent = chamber || "";

  const dateEl = document.getElementById("runningDate");
  if (dateEl) dateEl.textContent = dateText || "";
}

/* -----------------------------
   Init
------------------------------ */

(async function init() {
  try {
    // 1) Load available dates first (sets DEFAULT_DATE to latest)
    AVAILABLE_DATES = await loadAvailableDates();
    if (!DEFAULT_DATE) DEFAULT_DATE = FALLBACK_DATE;

    // 2) Default mode is edition unless user set otherwise
    const mode = getModeFromQueryOrStorage(DEFAULT_MODE);
    setMode(mode);

    // 3) Wire UI (picker + switch + toggle CSS)
    wireDatePickerUI();

    // 3b) Wire kebab menu (if present in HTML)
    wireKebabMenu();

    // 4) For initial render: if URL date missing, load nearest available (latest by default)
    const requested = getDateFromQuery(DEFAULT_DATE);
    const dateISO =
      AVAILABLE_DATES && AVAILABLE_DATES.size ? nearestAvailableOnOrBefore(requested) : requested;

    const xml = await loadXMLFromDate(dateISO);

    DOC_DATE_ISO = getDocDateISO(xml) || "";

    const chamberRaw = getDocProponent(xml) || "DÁIL ÉIREANN";
    const chamberPrint = normalizeChamber(chamberRaw);

    const editionEl = document.querySelector(".edition");
    if (editionEl) editionEl.setAttribute("data-chamber", chamberPrint);

    const longDate = formatLongDate(DOC_DATE_ISO) || getEditionDateText();
    setRunningStrings({ chamber: chamberPrint, dateText: longDate });

    buildColumnMap(xml);

    const pageMap = await loadPageMap();
    fillTitlePage(xml);
    renderBody(xml, pageMap);
    document.dispatchEvent(new CustomEvent("debate-rendered", { detail: { date: DOC_DATE_ISO } }));

    const titlePage = document.querySelector(".titlepage");
    if (titlePage) titlePage.classList.add("titlepage--unpaired");

    buildTOCFromDOM();
    enableSpeechLinkCopy();

    // ✅ NEW: Back-to-top button
    enableBackToTop();
  } catch (err) {
    const main = document.getElementById("main");
    if (main) {
      main.innerHTML = "";
      main.appendChild(el("p", { text: String(err) }));

      const dateISO = getDateFromQuery(DEFAULT_DATE);
      const mode = getModeFromQueryOrStorage(DEFAULT_MODE);

      main.appendChild(
        el("pre", { class: "debug" }, [
          `mode=${mode}\n`,
          `date=${dateISO}\n`,
          `defaultDate=${DEFAULT_DATE}\n`,
          `proxy=${PROXY_BASE}\n`,
          `oir=${oirCanonicalXmlUrl(dateISO)}\n`,
          `availableDates=${AVAILABLE_DATES ? AVAILABLE_DATES.size : 0}\n`,
        ])
      );
    }
  }
})();
