/* ----------------------------------------------------------------------
   NinDeals
   ----------------------------------------------------------------------
   Pure client-side, live, on-demand. Nothing is stored anywhere except
   in memory for this browser session.

   Nintendo's search backend is an Apache Solr instance. Solr's JSON
   response writer supports a "json.wrf" callback parameter, i.e. JSONP:
   the classic pre-CORS technique of loading cross-origin JSON via a
   <script> tag instead of fetch(). Script tags are never subject to CORS,
   so this reaches Nintendo's API directly from the browser with no proxy
   and no backend of any kind.

   This depends on Nintendo's Solr instance having JSONP enabled. If it
   ever isn't (some Solr configs disable json.wrf for security reasons),
   the request below will time out — see the error message in that case.
   ------------------------------------------------------------------- */

const LOCALE = "nl";
const SOLR_URL = `https://search.nintendo-europe.com/${LOCALE}/select`;
const ROWS_PER_PAGE = 200;
const MAX_ROWS_SAFETY = 20000;
const PAGE_DELAY_MS = 350; // small pause between requests, be gentle on the API
const JSONP_TIMEOUT_MS = 12000;

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
let jsonpCounter = 0;

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
// JSONP transport (no server, no proxy, no CORS involved at all)
// ---------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fetchViaJsonp(baseUrl, timeoutMs = JSONP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const callbackName = `nindeals_cb_${Date.now()}_${jsonpCounter++}`;
    const script = document.createElement("script");
    let settled = false;

    const cleanup = () => {
      delete window[callbackName];
      script.remove();
      clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(
          "Geen antwoord (timeout). Nintendo's zoekserver ondersteunt mogelijk geen JSONP meer."
        )
      );
    }, timeoutMs);

    window[callbackName] = (data) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("Kon de zoek-API niet laden (scriptfout)."));
    };

    const separator = baseUrl.includes("?") ? "&" : "?";
    script.src = `${baseUrl}${separator}json.wrf=${callbackName}`;
    document.head.appendChild(script);
  });
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

  try {
    let start = 0;
    let numFound = null;
    const seen = new Set();

    while (numFound === null || (start < numFound && start < MAX_ROWS_SAFETY)) {
      const data = await fetchViaJsonp(buildQueryUrl(start));
      const resp = data.response;
      if (!resp) throw new Error("Onverwacht antwoord van de zoek-API.");

      numFound = resp.numFound;
      const docs = resp.docs || [];

      for (const doc of docs) {
        const game = normalizeDoc(doc);
        if (game && !seen.has(game.id)) {
          seen.add(game.id);
          allGames.push(game);
        }
      }

      start += ROWS_PER_PAGE;
      const pct = Math.min(100, Math.round((start / Math.max(numFound, 1)) * 100));
      progressBar.style.width = pct + "%";
      progressLabel.textContent = `${allGames.length} van ${numFound} games opgehaald…`;

      if (docs.length === 0) break;
      if (start < numFound && start < MAX_ROWS_SAFETY) {
        await sleep(PAGE_DELAY_MS);
      }
    }

    progressLabel.textContent = `Klaar — ${allGames.length} games gevonden.`;
    controlsEl.classList.remove("hidden");
    summaryEl.classList.remove("hidden");
    applyFilters();
  } catch (err) {
    console.error(err);
    errorBox.textContent =
      "Kon de Nintendo zoek-API niet bereiken via JSONP. " + (err.message || err);
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
  summaryText.textContent = `${games.length} van ${allGames.length} games`;
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
