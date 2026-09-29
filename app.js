/* ----------------------------------------------------------------------
   NinDeals
   ----------------------------------------------------------------------
   Two ways to get the data, tried in this order on "Start scan":

   1. Live: when the page is served by server.py (start.bat / start.sh),
      that small Python server fetches Nintendo's API for the page, so the
      scan is live.
   2. Snapshot: on GitHub Pages there is no server, and Nintendo's API only
      answers requests from nintendo.com. So a scheduled GitHub Action
      (.github/workflows/update-data.yml) fetches the catalog and commits
      games.json, and the page reads that file. Same-origin, nothing to block.

   Everything shown is kept in memory for this browser session only.
   ------------------------------------------------------------------- */

const LOCALE = "nl";
const SOLR_URL = `https://search.nintendo-europe.com/${LOCALE}/select`;
const ROWS_PER_PAGE = 200;
const MAX_ROWS_SAFETY = 20000;
// Delay between pages is set by the user (#delayInput, default 0.35 s).
const SNAPSHOT_URL = "games.json";

const FIELD_CANDIDATES = {
  title: ["title", "title_s", "pageTitle"],
  regularPrice: ["price_regular_f", "price_regular", "regular_price_f"],
  currentPrice: [
    "price_discounted_f",
    "price_lowest_f",
    "price_current_f",
    "price_final_f",
    "price_has_discount_f",
  ],
  url: ["url", "url_s", "product_url_s"],
  image: ["image_url_sq_s", "image_url_h2x1_s", "image_url", "image_url_s"],
  released: ["pretty_date_s", "dates_released_dts", "date_from", "release_date_s"],
};

const SOURCE_URLS = {
  all: "https://www.nintendo.com/nl-nl/Zoeken/Zoeken-299117.html?f=147394-5-10-57-6970-11772-107828",
  switch2: "https://www.nintendo.com/nl-nl/Zoeken/Zoeken-299117.html?f=147394-15-57-6970-11772-107828",
  switch1: "https://www.nintendo.com/nl-nl/Zoeken/Zoeken-299117.html?f=147394-5-10-57-6970-11772",
};

let allGames = [];
let currentSystem = "all";
let dataNote = "";

// ---------------------------------------------------------------------
// DOM refs
// ---------------------------------------------------------------------
const scanBtn = document.getElementById("scanBtn");
const forceBtn = document.getElementById("forceBtn");
const delayInput = document.getElementById("delayInput");
const scanInfo = document.getElementById("scanInfo");
const sourceLink = document.getElementById("sourceLink");
const progressEl = document.getElementById("progress");
const progressBar = document.getElementById("progressBar");
const progressLabel = document.getElementById("progressLabel");
const errorBox = document.getElementById("errorBox");
const controlsEl = document.getElementById("controls");
const summaryEl = document.getElementById("summary");
const summaryText = document.getElementById("summaryText");
const gridEl = document.getElementById("grid");
const emptyStateEl = document.getElementById("emptyState");

const searchInput = document.getElementById("searchInput");
const sortSelect = document.getElementById("sortSelect");
const onSaleOnly = document.getElementById("onSaleOnly");
const minDiscount = document.getElementById("minDiscount");
const minDiscountVal = document.getElementById("minDiscountVal");
const priceMin = document.getElementById("priceMin");
const priceMax = document.getElementById("priceMax");
const priceRangeVal = document.getElementById("priceRangeVal");
const releaseFrom = document.getElementById("releaseFrom");
const releaseTo = document.getElementById("releaseTo");

// ---------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only exists when served by server.py. Anywhere else this is a 404.
// Throws Error("NO_PROXY") when there is no local server, and
// Error("UPSTREAM_<status>") when the server is there but Nintendo's API failed.
async function fetchViaLocalProxy(url) {
  let res;
  try {
    res = await fetch(`__proxy__?target=${encodeURIComponent(url)}`);
  } catch {
    throw new Error("NO_PROXY");
  }
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    throw new Error("NO_PROXY");
  }
  if (!res.ok) throw new Error("UPSTREAM_" + res.status);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("NO_PROXY");
  }
  if (!data || !data.response) throw new Error("NO_PROXY");
  return data;
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------
function firstDefined(doc, keys) {
  for (const k of keys) {
    const v = doc[k];
    if (v !== undefined && v !== null && v !== "") {
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function absoluteUrl(rawUrl, title) {
  if (rawUrl) {
    if (rawUrl.startsWith("http")) return rawUrl;
    return `https://www.nintendo.com${rawUrl}`;
  }
  return `https://www.nintendo.com/nl-nl/Zoeken/Zoeken-299117.html?q=${encodeURIComponent(
    title || ""
  )}`;
}

// Returns "YYYY-MM-DD" or null.
function parseReleaseDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); // 2024-07-05T00:00:00Z
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // 05/07/2024 (dd/mm/yyyy)
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

function formatDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
}

function normalizeDoc(doc) {
  const title = firstDefined(doc, FIELD_CANDIDATES.title);
  if (!title) return null;

  const regular = parseFloat(firstDefined(doc, FIELD_CANDIDATES.regularPrice));
  let current = parseFloat(firstDefined(doc, FIELD_CANDIDATES.currentPrice));
  if (isNaN(current)) current = isNaN(regular) ? null : regular;
  if (current == null) return null;

  const base = isNaN(regular) ? current : regular;
  const discountPct =
    base > 0 && current < base ? Math.round((1 - current / base) * 100) : 0;

  const systems = doc.system_names_txt || doc.system_names || [];
  const isSwitch2 = systems.some((s) => /switch\s*2/i.test(s));
  const isSwitch1 = systems.some((s) => /switch/i.test(s) && !/switch\s*2/i.test(s));

  return {
    id: doc.objectID || doc.nsuid_txt?.[0] || title,
    title,
    originalPrice: base,
    currentPrice: current,
    discountPct,
    systems,
    isSwitch1,
    isSwitch2,
    released: parseReleaseDate(firstDefined(doc, FIELD_CANDIDATES.released)),
    url: absoluteUrl(firstDefined(doc, FIELD_CANDIDATES.url), title),
    image: firstDefined(doc, FIELD_CANDIDATES.image) || null,
  };
}

function buildQueryUrl(start, rows = ROWS_PER_PAGE) {
  const params = new URLSearchParams({
    q: "*",
    fq: "type:GAME AND product_code_txt:*",
    sort: "sorting_title asc",
    start: String(start),
    rows: String(rows),
    wt: "json",
  });
  return `${SOLR_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------
function getDelaySeconds() {
  const v = parseFloat(String(delayInput.value).replace(",", "."));
  return isNaN(v) || v < 0 ? 0 : v;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} sec`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m} min ${rest} sec` : `${m} min`;
}

// Rough estimate: every page costs one request (assumed at least 0.8 s, or
// twice the measured round trip of the small preflight request, because full
// pages are bigger) plus the user's delay between pages.
function estimateSeconds(pages, delaySec, rttSec) {
  const perRequest = Math.max(0.8, (rttSec || 0) * 2);
  return pages * perRequest + Math.max(0, pages - 1) * delaySec;
}

let catalogInfo = null; // { numFound, pages, rtt } once the preflight worked
let catalogError = null;

async function checkCatalog() {
  scanInfo.textContent = "Aantal pagina's ophalen…";
  const t0 = performance.now();
  try {
    const data = await fetchViaLocalProxy(buildQueryUrl(0, 1));
    const numFound = data.response.numFound || 0;
    catalogInfo = {
      numFound,
      pages: Math.ceil(numFound / ROWS_PER_PAGE),
      rtt: (performance.now() - t0) / 1000,
    };
    catalogError = null;
  } catch (err) {
    catalogInfo = null;
    catalogError = err && err.message ? err.message : String(err);
  }
  renderScanInfo();
}

function renderScanInfo() {
  if (catalogInfo) {
    const delay = getDelaySeconds();
    const est = estimateSeconds(catalogInfo.pages, delay, catalogInfo.rtt);
    let text =
      `${catalogInfo.numFound.toLocaleString("nl-NL")} games gevonden in ` +
      `${catalogInfo.pages} pagina's van ${ROWS_PER_PAGE} · geschatte scantijd ca. ${formatDuration(est)}`;
    if (delay === 0) text += " · let op: zonder vertraging is de kans op blokkade groter";
    scanInfo.textContent = text;
  } else if (catalogError === "NO_PROXY") {
    scanInfo.textContent =
      "Geen lokale server gevonden: 'Start scan' laadt games.json. Een live scan of volledige herscan " +
      "kan alleen via start.bat / start.sh.";
  } else if (catalogError) {
    scanInfo.textContent = `Kon het aantal pagina's niet ophalen (${describeError(catalogError)}).`;
  }
}

function describeError(message) {
  if (message === "NO_PROXY") {
    return "Geen verbinding met de lokale server. Start de app via start.bat / start.sh.";
  }
  if (message.startsWith("UPSTREAM_")) {
    return `Nintendo gaf een foutmelding (HTTP ${message.slice(9)}). Mogelijk geblokkeerd of te snel; probeer een langere vertraging.`;
  }
  return message;
}

async function scanLive(delayMs) {
  const games = [];
  const seen = new Set();
  let start = 0;
  let numFound = null;
  let pagesDone = 0;
  const t0 = performance.now();

  while (numFound === null || (start < numFound && start < MAX_ROWS_SAFETY)) {
    const data = await fetchViaLocalProxy(buildQueryUrl(start));
    const resp = data.response;
    numFound = resp.numFound;
    const docs = resp.docs || [];

    for (const doc of docs) {
      const game = normalizeDoc(doc);
      if (game && !seen.has(game.id)) {
        seen.add(game.id);
        games.push(game);
      }
    }

    pagesDone++;
    start += ROWS_PER_PAGE;
    const totalPages = Math.max(1, Math.ceil(numFound / ROWS_PER_PAGE));
    const pct = Math.min(100, Math.round((pagesDone / totalPages) * 100));
    const elapsed = (performance.now() - t0) / 1000;
    const eta = (elapsed / pagesDone) * Math.max(0, totalPages - pagesDone);
    progressBar.style.width = pct + "%";
    progressLabel.textContent =
      `Pagina ${pagesDone} van ${totalPages} · ${games.length} games` +
      (eta > 0 ? ` · nog ca. ${formatDuration(eta)}` : "");

    if (docs.length === 0) break;
    if (start < numFound && start < MAX_ROWS_SAFETY) await sleep(delayMs);
  }
  return games;
}

async function loadSnapshot() {
  progressBar.style.width = "60%";
  progressLabel.textContent = "Games laden…";
  const res = await fetch(`${SNAPSHOT_URL}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error("NO_SNAPSHOT");
  const data = await res.json();
  const games = data.games || [];
  if (games.length === 0) throw new Error("NO_SNAPSHOT");
  dataNote = data.generated_at
    ? `bijgewerkt ${new Date(data.generated_at).toLocaleString("nl-NL")}`
    : "snapshot";
  return games;
}

// Only works when served by server.py (POST /__save__ writes games.json).
async function saveSnapshot(games) {
  const sorted = [...games].sort((a, b) => a.title.localeCompare(b.title));
  const res = await fetch("__save__", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      generated_at: new Date().toISOString(),
      count: sorted.length,
      games: sorted,
    }),
  });
  if (!res.ok) throw new Error("SAVE_FAILED");
}

// force = true: live scan only, never fall back to games.json, and write a
// fresh games.json when finished.
async function runScan(force) {
  scanBtn.disabled = true;
  forceBtn.disabled = true;
  delayInput.disabled = true;
  errorBox.classList.add("hidden");
  progressEl.classList.remove("hidden");
  progressBar.style.width = "0%";
  progressLabel.textContent = "Verbinden…";
  controlsEl.classList.add("hidden");
  summaryEl.classList.add("hidden");
  gridEl.innerHTML = "";
  emptyStateEl.classList.add("hidden");
  allGames = [];
  dataNote = "";

  const delayMs = Math.round(getDelaySeconds() * 1000);

  try {
    if (force) {
      allGames = await scanLive(delayMs);
      if (allGames.length === 0) throw new Error("Nintendo gaf geen games terug, games.json is niet aangepast.");
      dataNote = "live opgehaald";
      try {
        await saveSnapshot(allGames);
        dataNote += " · games.json opgeslagen";
      } catch {
        dataNote += " · games.json kon niet worden opgeslagen";
      }
    } else {
      try {
        allGames = await scanLive(delayMs);
        dataNote = "live opgehaald";
      } catch (err) {
        const m = err && err.message;
        if (m !== "NO_PROXY" && !(m && m.startsWith("UPSTREAM_"))) throw err;
        allGames = await loadSnapshot();
      }
    }

    progressBar.style.width = "100%";
    progressLabel.textContent = `Klaar, ${allGames.length} games.`;
    controlsEl.classList.remove("hidden");
    summaryEl.classList.remove("hidden");
    applyFilters();
  } catch (err) {
    console.error(err);
    const m = err && err.message ? err.message : String(err);
    if (m === "NO_SNAPSHOT") {
      errorBox.textContent =
        "Geen data gevonden. Start in GitHub de workflow 'Update games.json' " +
        "(Actions-tab, Run workflow) en probeer het over een minuut opnieuw.";
    } else {
      errorBox.textContent = "Scan mislukt: " + describeError(m);
    }
    errorBox.classList.remove("hidden");
  } finally {
    scanBtn.disabled = false;
    forceBtn.disabled = false;
    delayInput.disabled = false;
    setTimeout(() => progressEl.classList.add("hidden"), 800);
  }
}

// ---------------------------------------------------------------------
// Filtering / rendering
// ---------------------------------------------------------------------
function currentSystemGames() {
  if (currentSystem === "switch2") return allGames.filter((g) => g.isSwitch2);
  if (currentSystem === "switch1") return allGames.filter((g) => g.isSwitch1);
  return allGames;
}

function applyFilters() {
  let games = currentSystemGames();

  const query = searchInput.value.trim().toLowerCase();
  if (query) {
    games = games.filter((g) => g.title.toLowerCase().includes(query));
  }

  if (onSaleOnly.checked) {
    games = games.filter((g) => g.discountPct > 0);
  }

  const minD = parseInt(minDiscount.value, 10);
  if (minD > 0) {
    games = games.filter((g) => g.discountPct >= minD);
  }

  const pMin = parseFloat(priceMin.value);
  const pMax = parseFloat(priceMax.value);
  games = games.filter((g) => {
    const p = g.currentPrice;
    if (p < pMin) return false;
    if (pMax < 80 && p > pMax) return false;
    return true;
  });

  const from = releaseFrom.value; // "YYYY-MM-DD" strings compare correctly
  const to = releaseTo.value;
  if (from || to) {
    games = games.filter((g) => {
      if (!g.released) return false;
      if (from && g.released < from) return false;
      if (to && g.released > to) return false;
      return true;
    });
  }

  // Games without a release date always go last when sorting by date
  const byDate = (dir) => (a, b) => {
    if (!a.released && !b.released) return 0;
    if (!a.released) return 1;
    if (!b.released) return -1;
    return dir * a.released.localeCompare(b.released);
  };

  switch (sortSelect.value) {
    case "release-desc":
      games.sort(byDate(-1));
      break;
    case "release-asc":
      games.sort(byDate(1));
      break;
    case "price-asc":
      games.sort((a, b) => a.currentPrice - b.currentPrice);
      break;
    case "price-desc":
      games.sort((a, b) => b.currentPrice - a.currentPrice);
      break;
    case "title-asc":
      games.sort((a, b) => a.title.localeCompare(b.title));
      break;
    default:
      games.sort((a, b) => b.discountPct - a.discountPct);
  }

  render(games);
}

function formatPrice(v) {
  return "€ " + v.toFixed(2).replace(".", ",");
}

function render(games) {
  summaryText.textContent = `${games.length} van ${allGames.length} games` + (dataNote ? ` · ${dataNote}` : "");
  gridEl.innerHTML = "";

  if (games.length === 0) {
    emptyStateEl.classList.remove("hidden");
    return;
  }
  emptyStateEl.classList.add("hidden");

  const frag = document.createDocumentFragment();
  for (const g of games) {
    const card = document.createElement("a");
    card.className = "card";
    card.href = g.url;
    card.target = "_blank";
    card.rel = "noopener";

    const imgDiv = document.createElement("div");
    imgDiv.className = "card-image";
    if (g.image) imgDiv.style.backgroundImage = `url("${g.image}")`;
    if (g.discountPct > 0) {
      const badge = document.createElement("span");
      badge.className = "card-badge";
      badge.textContent = "-" + g.discountPct + "%";
      imgDiv.appendChild(badge);
    }

    const body = document.createElement("div");
    body.className = "card-body";

    const title = document.createElement("div");
    title.className = "card-title";
    title.textContent = g.title;

    const systems = document.createElement("div");
    systems.className = "card-systems";
    systems.textContent = [g.systems.join(", "), formatDate(g.released)]
      .filter(Boolean)
      .join(" \u00b7 ");

    const prices = document.createElement("div");
    prices.className = "card-prices";
    const now = document.createElement("span");
    now.className = "price-now";
    now.textContent = formatPrice(g.currentPrice);
    prices.appendChild(now);
    if (g.discountPct > 0) {
      const was = document.createElement("span");
      was.className = "price-was";
      was.textContent = formatPrice(g.originalPrice);
      prices.appendChild(was);
    }

    body.append(title, systems, prices);
    card.append(imgDiv, body);
    frag.appendChild(card);
  }
  gridEl.appendChild(frag);
}

// ---------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------
scanBtn.addEventListener("click", () => runScan(false));
forceBtn.addEventListener("click", () => runScan(true));
delayInput.addEventListener("input", renderScanInfo);

document.querySelectorAll(".seg").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".seg").forEach((b) => {
      b.classList.remove("active");
      b.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    currentSystem = btn.dataset.system;
    sourceLink.href = SOURCE_URLS[currentSystem];
    if (allGames.length) applyFilters();
  });
});

searchInput.addEventListener("input", applyFilters);
sortSelect.addEventListener("change", applyFilters);
onSaleOnly.addEventListener("change", applyFilters);

minDiscount.addEventListener("input", () => {
  minDiscountVal.textContent = minDiscount.value + "%";
  applyFilters();
});

function syncPriceLabel() {
  const lo = parseInt(priceMin.value, 10);
  let hi = parseInt(priceMax.value, 10);
  if (hi < lo) hi = lo;
  priceRangeVal.textContent = `€${lo} – ${hi >= 80 ? "€80+" : "€" + hi}`;
}

priceMin.addEventListener("input", () => {
  if (parseInt(priceMin.value, 10) > parseInt(priceMax.value, 10)) {
    priceMax.value = priceMin.value;
  }
  syncPriceLabel();
  applyFilters();
});

priceMax.addEventListener("input", () => {
  if (parseInt(priceMax.value, 10) < parseInt(priceMin.value, 10)) {
    priceMin.value = priceMax.value;
  }
  syncPriceLabel();
  applyFilters();
});

releaseFrom.addEventListener("change", applyFilters);
releaseTo.addEventListener("change", applyFilters);

function isoDaysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

document.querySelectorAll(".chip[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.preset === "clear") {
      releaseFrom.value = "";
      releaseTo.value = "";
    } else {
      releaseFrom.value = isoDaysAgo(parseInt(btn.dataset.preset, 10));
      releaseTo.value = "";
    }
    if (allGames.length) applyFilters();
  });
});

sourceLink.href = SOURCE_URLS.all;
checkCatalog();
