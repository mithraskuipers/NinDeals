#!/usr/bin/env python3
"""Fetch the full Nintendo EU game catalog and write games.json.

Runs server-side (GitHub Actions, or your own machine), so Nintendo's CORS
rules do not apply. The website only reads the resulting games.json.
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

LOCALE = "nl"
SOLR_URL = f"https://search.nintendo-europe.com/{LOCALE}/select"
ROWS_PER_PAGE = 200
MAX_ROWS_SAFETY = 20000
DEFAULT_PAGE_DELAY_SECONDS = 1.0

FIELDS = {
    "title": ["title", "title_s", "pageTitle"],
    "regular": ["price_regular_f", "price_regular", "regular_price_f"],
    "current": ["price_discounted_f", "price_lowest_f", "price_current_f",
                "price_final_f", "price_has_discount_f"],
    "url": ["url", "url_s", "product_url_s"],
    "image": ["image_url_sq_s", "image_url_h2x1_s", "image_url", "image_url_s"],
    "released": ["pretty_date_s", "dates_released_dts", "date_from", "release_date_s"],
}
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "games.json"


def first(doc, keys):
    for key in keys:
        value = doc.get(key)
        if value not in (None, ""):
            return value[0] if isinstance(value, list) else value
    return None


def absolute_url(raw, title):
    if raw:
        return raw if raw.startswith("http") else f"https://www.nintendo.com{raw}"
    q = urllib.parse.quote(title or "")
    return f"https://www.nintendo.com/nl-nl/Zoeken/Zoeken-299117.html?q={q}"


def parse_release_date(raw):
    """Return the release date as 'YYYY-MM-DD', or None if unknown."""
    if not raw:
        return None
    raw = str(raw).strip()
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", raw)          # 2024-07-05T00:00:00Z
    if m:
        return f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    m = re.match(r"^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$", raw)  # 05/07/2024 (dd/mm/yyyy)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return None


def normalize(doc):
    title = first(doc, FIELDS["title"])
    if not title:
        return None
    try:
        regular = float(first(doc, FIELDS["regular"]))
    except (TypeError, ValueError):
        regular = None
    try:
        current = float(first(doc, FIELDS["current"]))
    except (TypeError, ValueError):
        current = regular
    if current is None:
        return None
    base = regular if regular is not None else current
    pct = round((1 - current / base) * 100) if base > 0 and current < base else 0
    systems = doc.get("system_names_txt") or doc.get("system_names") or []
    is2 = any(re.search(r"switch\s*2", s, re.I) for s in systems)
    is1 = any(re.search(r"switch", s, re.I) and not re.search(r"switch\s*2", s, re.I)
              for s in systems)
    return {
        "id": doc.get("objectID") or (doc.get("nsuid_txt") or [None])[0] or title,
        "title": title,
        "originalPrice": round(base, 2),
        "currentPrice": round(current, 2),
        "discountPct": pct,
        "systems": systems,
        "isSwitch1": is1,
        "isSwitch2": is2,
        "released": parse_release_date(first(doc, FIELDS["released"])),
        "url": absolute_url(first(doc, FIELDS["url"]), title),
        "image": first(doc, FIELDS["image"]),
    }


def fetch_page(start):
    params = {"q": "*", "fq": "type:GAME AND product_code_txt:*",
              "sort": "sorting_title asc", "start": str(start),
              "rows": str(ROWS_PER_PAGE), "wt": "json"}
    url = f"{SOLR_URL}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "NinDeals/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--delay", type=float, default=DEFAULT_PAGE_DELAY_SECONDS,
                        help="seconds to wait between pages (default: %(default)s)")
    args = parser.parse_args()
    delay = max(0.0, args.delay)

    start, num_found, seen, games = 0, None, set(), []
    while num_found is None or (start < num_found and start < MAX_ROWS_SAFETY):
        print(f"Fetching start={start}", file=sys.stderr)
        response = fetch_page(start).get("response") or {}
        num_found = response.get("numFound", 0)
        docs = response.get("docs") or []
        if not docs:
            break
        for doc in docs:
            game = normalize(doc)
            if game and game["id"] not in seen:
                seen.add(game["id"])
                games.append(game)
        start += ROWS_PER_PAGE
        if start < num_found:
            time.sleep(delay)

    if not games:
        sys.exit("No games fetched, keeping the existing games.json")

    games.sort(key=lambda g: g["title"])
    payload = {"generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
               "count": len(games), "games": games}
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False))
    print(f"Wrote {len(games)} games", file=sys.stderr)


if __name__ == "__main__":
    main()
