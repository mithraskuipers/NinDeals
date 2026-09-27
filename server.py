#!/usr/bin/env python3
"""NinDeals local server.

Serves this folder as a static site and exposes one extra endpoint,
GET /__proxy__?target=<url>, which fetches that URL server-side and returns
the body with a permissive CORS header. Browsers only enforce CORS on
requests made *from* a page's JavaScript — a request made by this Python
process to Nintendo's API has no such restriction, so this sidesteps the
CORS problem entirely without depending on any third-party proxy service.

Only the Nintendo search API host is allowed through, so this can't be used
as an open proxy for arbitrary sites.

This endpoint only exists when the site is served by this script (via
start.sh / start.bat). When hosted as plain static files (e.g. GitHub
Pages) it isn't present, and app.js automatically falls back to public
CORS proxies instead — see FETCH_STRATEGIES in app.js.
"""
import sys
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000

ALLOWED_HOSTS = {"search.nintendo-europe.com"}


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/__proxy__":
            self.handle_proxy(parsed)
        else:
            super().do_GET()

    def handle_proxy(self, parsed):
        qs = urllib.parse.parse_qs(parsed.query)
        target = (qs.get("target") or [None])[0]
        if not target:
            self.send_error(400, "Missing target parameter")
            return

        host = urllib.parse.urlparse(target).hostname
        if host not in ALLOWED_HOSTS:
            self.send_error(403, "Host not allowed")
            return

        try:
            req = urllib.request.Request(
                target, headers={"User-Agent": "NinDeals/1.0"}
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read()
                content_type = resp.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as exc:
            self.send_error(502, f"Upstream returned HTTP {exc.code}")
            return
        except Exception as exc:  # noqa: BLE001 - report any failure to the client
            self.send_error(502, f"Upstream request failed: {exc}")
            return

        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - keep console output tidy
        pass


if __name__ == "__main__":
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"NinDeals server running on 0.0.0.0:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
