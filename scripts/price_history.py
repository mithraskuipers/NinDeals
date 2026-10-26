"""Per game price history, stored in history.json next to games.json.

Format:
  {"updated_at": "<ISO time of the last scan>",
   "games": {"<id>": [["<ISO time>", currentPrice, originalPrice], ...]}}

An entry is only appended when the price differs from the previous entry, so
the file stays small. "updated_at" tells when prices were last checked, which
is how far the last price is known to have been valid.
"""
import json
from pathlib import Path


def _load(path):
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        if isinstance(data.get("games"), dict):
            return data
    except (OSError, ValueError, AttributeError):
        pass
    return {"updated_at": None, "games": {}}


def _apply(history, games, ts):
    records = history["games"]
    for game in games:
        current, original = game.get("currentPrice"), game.get("originalPrice")
        if current is None or game.get("id") is None:
            continue
        entries = records.setdefault(str(game["id"]), [])
        if entries and entries[-1][1] == current and entries[-1][2] == original:
            continue
        entries.append([ts, current, original])


def record(history_path, games, ts, seed_from=None):
    """Add the prices of this scan. If there is no history yet, first seed it
    from the existing snapshot (seed_from) so those prices are not lost."""
    history = _load(history_path)
    if not history["games"] and seed_from and Path(seed_from).exists():
        try:
            old = json.loads(Path(seed_from).read_text(encoding="utf-8"))
            _apply(history, old.get("games") or [], old.get("generated_at") or ts)
        except (OSError, ValueError, AttributeError):
            pass
    _apply(history, games, ts)
    history["updated_at"] = ts
    path = Path(history_path)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(history, ensure_ascii=False, separators=(",", ":")),
                   encoding="utf-8")
    tmp.replace(path)
