#!/usr/bin/env python3
"""NinDeals local server: serves this folder and proxies Nintendo's search API.

GET /__proxy__?target=<url> fetches that URL server-side (no CORS there) and
returns it. Only Nintendo's search API host is allowed.
"""
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ALLOWED_HOSTS = {"search.nintendo-europe.com"}
SAVE_PATH = Path(__file__).resolve().parent / "games.json"
MAX_SAVE_BYTES = 100 * 1024 * 1024


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/__proxy__":
            self.handle_proxy(parsed)
        else:
            super().do_GET()

    def do_POST(self):
        if urllib.parse.urlparse(self.path).path != "/__save__":
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_SAVE_BYTES:
            self.send_error(400, "Bad payload size")
            return
        try:
            data = json.loads(self.rfile.read(length))
            games = data["games"]
            if not isinstance(games, list) or not games:
                raise ValueError("no games")
        except Exception:  # noqa: BLE001
            self.send_error(400, "Invalid payload")
            return
        payload = {"generated_at": data.get("generated_at"),
                   "count": len(games), "games": games}
        tmp = SAVE_PATH.with_name("games.json.tmp")
        tmp.write_bytes(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        tmp.replace(SAVE_PATH)
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_proxy(self, parsed):
        target = (urllib.parse.parse_qs(parsed.query).get("target") or [None])[0]
        if not target:
            self.send_error(400, "Missing target parameter")
            return
        if urllib.parse.urlparse(target).hostname not in ALLOWED_HOSTS:
            self.send_error(403, "Host not allowed")
            return
        try:
            req = urllib.request.Request(target, headers={"User-Agent": "NinDeals/1.0"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = resp.read()
                content_type = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as exc:
            self.send_error(502, f"Upstream returned HTTP {exc.code}")
            return
        except Exception as exc:  # noqa: BLE001
            self.send_error(502, f"Upstream request failed: {exc}")
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"NinDeals server running on 0.0.0.0:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
