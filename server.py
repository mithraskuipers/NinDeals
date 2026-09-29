#!/usr/bin/env python3
"""NinDeals local server: serves this folder and proxies Nintendo's search API.

GET /__proxy__?target=<url> fetches that URL server-side (no CORS there) and
returns it. Only Nintendo's search API host is allowed.
"""
import json
import os
import subprocess
import sys
import threading
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
ALLOWED_HOSTS = {"search.nintendo-europe.com"}
SAVE_PATH = Path(__file__).resolve().parent / "games.json"
MAX_SAVE_BYTES = 100 * 1024 * 1024
SAVE_LOCK = threading.Lock()
# Set NINDEALS_NO_GIT=1 to only write games.json and never touch git.
NO_GIT = os.environ.get("NINDEALS_NO_GIT") == "1"
COMMIT_MESSAGE = "chore: update games.json (full rescan)"


def run_git(*args, timeout=90):
    return subprocess.run(
        ["git", *args], cwd=SAVE_PATH.parent, capture_output=True, text=True,
        timeout=timeout, env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


def git_error(result):
    text = (result.stderr or result.stdout or "").strip()
    return text.splitlines()[-1] if text else f"exit code {result.returncode}"


def publish_to_git():
    """Commit and push games.json. Returns (status, detail).

    status is one of: pushed, unchanged, skipped, failed.
    """
    if NO_GIT:
        return "skipped", "git staat uit (NINDEALS_NO_GIT=1)"
    try:
        inside = run_git("rev-parse", "--is-inside-work-tree")
        if inside.returncode != 0:
            return "skipped", "map is geen git-repository"
        added = run_git("add", "games.json")
        if added.returncode != 0:
            return "failed", git_error(added)
        if run_git("diff", "--cached", "--quiet", "--", "games.json").returncode == 0:
            return "unchanged", "geen wijzigingen"
        # "-- games.json" so nothing else you may have staged is committed
        commit = run_git("commit", "-m", COMMIT_MESSAGE, "--", "games.json")
        if commit.returncode != 0:
            return "failed", git_error(commit)
        push = run_git("push")
        if push.returncode != 0:
            # The scheduled GitHub Action may have pushed in the meantime:
            # replay our commit on top of it, our games.json wins conflicts.
            pull = run_git("pull", "--rebase", "--autostash", "-X", "theirs")
            if pull.returncode != 0:
                run_git("rebase", "--abort")
                return "failed", git_error(pull)
            push = run_git("push")
            if push.returncode != 0:
                return "failed", git_error(push)
        return "pushed", "gepusht"
    except FileNotFoundError:
        return "skipped", "git is niet geinstalleerd"
    except subprocess.TimeoutExpired:
        return "failed", "git duurde te lang (inloggegevens nodig?)"
    except Exception as exc:  # noqa: BLE001
        return "failed", str(exc)


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Never let the browser reuse an old copy of anything we serve.
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

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
        with SAVE_LOCK:
            tmp = SAVE_PATH.with_name("games.json.tmp")
            tmp.write_bytes(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            tmp.replace(SAVE_PATH)
            git_status, git_detail = publish_to_git()
        body = json.dumps({"ok": True,
                           "git": {"status": git_status, "detail": git_detail}}).encode()
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
