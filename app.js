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
const PAGE_DELAY_MS = 350; // small pause between requests, be gentle on the API
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

// ---------------------------------------------------------------------
// Data sources
// ---------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Only exists when served by server.py. Anywhere else this is a 404.
async function fetchViaLocalProxy(url) {
  const res = await fetch(`__proxy__?target=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error("NO_PROXY");
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
    url: absoluteUrl(firstDefined(doc, FIELD_CANDIDATES.url), title),
    image: firstDefined(doc, FIELD_CANDIDATES.image) || null,
  };
}

function buildQueryUrl(start) {
  const params = new URLSearchParams({
    q: "*",
    fq: "type:GAME AND product_code_txt:*",
    sort: "sorting_title asc",
    start: String(start),
    rows: String(ROWS_PER_PAGE),
    wt: "json",
  });
  return `${SOLR_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------
async function scanLive() {
  const games = [];
  const seen = new Set();
  let start = 0;
  let numFound = null;

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

    start += ROWS_PER_PAGE;
    const pct = Math.min(100, Math.round((start / Math.max(numFound, 1)) * 100));
    progressBar.style.width = pct + "%";
    progressLabel.textContent = `${games.length} van ${numFound} games opgehaald…`;

    if (docs.length === 0) break;
    if (start < numFound && start < MAX_ROWS_SAFETY) await sleep(PAGE_DELAY_MS);
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

async function runScan() {
  scanBtn.disabled = true;
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

  try {
    try {
      allGames = await scanLive();
      dataNote = "live opgehaald";
    } catch (err) {
      if (!err || err.message !== "NO_PROXY") throw err;
      allGames = await loadSnapshot();
    }

    progressBar.style.width = "100%";
    progressLabel.textContent = `Klaar, ${allGames.length} games.`;
    controlsEl.classList.remove("hidden");
    summaryEl.classList.remove("hidden");
    applyFilters();
  } catch (err) {
    console.error(err);
    if (err && err.message === "NO_SNAPSHOT") {
      errorBox.textContent =
        "Geen data gevonden. Start in GitHub de workflow 'Update games.json' " +
        "(Actions-tab, Run workflow) en probeer het over een minuut opnieuw.";
    } else {
      errorBox.textContent = "Scan mislukt: " + (err && err.message ? err.message : err);
    }
    errorBox.classList.remove("hidden");
  } finally {
    scanBtn.disabled = false;
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

  switch (sortSelect.value) {
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
    systems.textContent = g.systems.join(", ");

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
scanBtn.addEventListener("click", runScan);

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

sourceLink.href = SOURCE_URLS.all;
