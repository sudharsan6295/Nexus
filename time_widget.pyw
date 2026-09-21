"""Nexus desktop time widget.

Opens a modern HTML UI in a native window. Times stay in data/time_data.json.
"""

from __future__ import annotations

import copy
import json
import re
import socket
import threading
import traceback
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import webview

APP_DIR = Path(__file__).resolve().parent
UI_DIR = APP_DIR / "ui"
DATA_PATH = APP_DIR / "data" / "time_data.json"
MIME = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}

_DATA_LOCK = threading.RLock()
_DATA: dict | None = None
_WRITE_LOCK = threading.Lock()
_API: "Api | None" = None

MAX_BODY_BYTES = 1_000_000
MAX_NOTES_CHARS = 8_000
MAX_CATEGORIES = 200
MAX_SESSIONS_PER_CATEGORY = 5_000
_HEX_COLOR = re.compile(r"^#?[0-9A-Fa-f]{6}$")
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

# Single default size. Users drag window edges to grow/shrink.
COMPACT_WIDTH = 380
COMPACT_HEIGHT = 680
MIN_WIDTH = 280
MIN_HEIGHT = 480
MAX_WIDTH = 900
MAX_HEIGHT = 1400


def sanitize_color(value: object) -> str:
    text = str(value or "").strip()
    if _HEX_COLOR.fullmatch(text):
        return text if text.startswith("#") else f"#{text}"
    return "#3B82F6"


def sanitize_id(value: object) -> str | None:
    text = str(value or "").strip()
    if _SAFE_ID.fullmatch(text):
        return text
    return None


def empty_data() -> dict:
    return {
        "always_on_top": True,
        "show_new": False,
        "show_notes": False,
        "window_width": COMPACT_WIDTH,
        "window_height": COMPACT_HEIGHT,
        "categories": [],
    }


def clamp_size(width: object, height: object) -> tuple[int, int]:
    try:
        w = int(width)
    except (TypeError, ValueError):
        w = COMPACT_WIDTH
    try:
        h = int(height)
    except (TypeError, ValueError):
        h = COMPACT_HEIGHT
    w = max(MIN_WIDTH, min(MAX_WIDTH, w))
    h = max(MIN_HEIGHT, min(MAX_HEIGHT, h))
    return w, h


def load_json() -> dict:
    if not DATA_PATH.exists():
        return empty_data()
    try:
        raw = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        backup = DATA_PATH.with_name("time_data.json.bak")
        try:
            if backup.exists():
                backup.unlink()
            DATA_PATH.replace(backup)
        except OSError:
            pass
        return empty_data()
    if not isinstance(raw, dict):
        return empty_data()
    categories = []
    for item in raw.get("categories") or []:
        if not isinstance(item, dict):
            continue
        cat_id = sanitize_id(item.get("id"))
        name = str(item.get("name") or "").strip()
        if not cat_id or not name:
            continue
        notes = item["notes"] if isinstance(item.get("notes"), str) else ""
        running = item.get("running_since")
        if running is not None and not isinstance(running, str):
            running = None
        categories.append({
            "id": cat_id,
            "name": name[:80],
            "color": sanitize_color(item.get("color")),
            "notes": notes[:MAX_NOTES_CHARS],
            "running_since": running,
            "sessions": normalize_sessions(item.get("sessions")),
        })
    raw["categories"] = categories
    raw["always_on_top"] = bool(raw.get("always_on_top", True))
    raw["show_new"] = bool(raw.get("show_new", False))
    raw["show_notes"] = bool(raw.get("show_notes", False))
    # Migrate old preset keys to compact defaults unless real pixel sizes exist.
    if "window_width" not in raw or "window_height" not in raw:
        raw["window_width"] = COMPACT_WIDTH
        raw["window_height"] = COMPACT_HEIGHT
    raw["window_width"], raw["window_height"] = clamp_size(
        raw.get("window_width"), raw.get("window_height")
    )
    raw.pop("window_size", None)
    return raw


def write_json(data: dict) -> None:
    DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(data, indent=2)
    with _WRITE_LOCK:
        tmp = DATA_PATH.with_suffix(".json.tmp")
        tmp.write_text(payload, encoding="utf-8")
        tmp.replace(DATA_PATH)


def get_data() -> dict:
    global _DATA
    with _DATA_LOCK:
        if _DATA is None:
            _DATA = load_json()
        return copy.deepcopy(_DATA)


def set_data(data: dict, *, sync: bool = False) -> dict:
    global _DATA
    normalized = normalize_payload(data)
    with _DATA_LOCK:
        _DATA = normalized
        snapshot = copy.deepcopy(_DATA)
    if sync:
        write_json(snapshot)
    else:
        threading.Thread(target=write_json, args=(snapshot,), daemon=True).start()
    return snapshot


def normalize_sessions(raw: object) -> list:
    if not isinstance(raw, list):
        return []
    sessions = []
    for item in raw[:MAX_SESSIONS_PER_CATEGORY]:
        if not isinstance(item, dict):
            continue
        start = item.get("start")
        end = item.get("end")
        if not isinstance(start, str) or not isinstance(end, str):
            continue
        if len(start) > 40 or len(end) > 40:
            continue
        sessions.append({"start": start, "end": end})
    return sessions


def normalize_payload(payload: dict) -> dict:
    current = empty_data()
    current["always_on_top"] = bool(payload.get("always_on_top", True))
    current["show_new"] = bool(payload.get("show_new", False))
    current["show_notes"] = bool(payload.get("show_notes", False))
    with _DATA_LOCK:
        existing = _DATA if isinstance(_DATA, dict) else empty_data()
    width = payload.get("window_width", existing.get("window_width", COMPACT_WIDTH))
    height = payload.get("window_height", existing.get("window_height", COMPACT_HEIGHT))
    current["window_width"], current["window_height"] = clamp_size(width, height)
    categories = []
    for item in (payload.get("categories") or [])[:MAX_CATEGORIES]:
        if not isinstance(item, dict):
            continue
        cat_id = sanitize_id(item.get("id"))
        name = str(item.get("name") or "").strip()
        if not cat_id or not name:
            continue
        notes = item["notes"] if isinstance(item.get("notes"), str) else ""
        running = item.get("running_since")
        if running is not None and not isinstance(running, str):
            running = None
        if isinstance(running, str) and len(running) > 40:
            running = None
        categories.append({
            "id": cat_id,
            "name": name[:80],
            "color": sanitize_color(item.get("color")),
            "notes": notes[:MAX_NOTES_CHARS],
            "running_since": running,
            "sessions": normalize_sessions(item.get("sessions")),
        })
    current["categories"] = categories
    return current


def update_window_size(width: int, height: int) -> None:
    data = get_data()
    w, h = clamp_size(width, height)
    if data.get("window_width") == w and data.get("window_height") == h:
        return
    data["window_width"] = w
    data["window_height"] = h
    set_data(data, sync=False)


def stop_running_timers() -> None:
    data = get_data()
    moment = datetime.now().replace(microsecond=0).isoformat(timespec="seconds")
    changed = False
    for category in data.get("categories") or []:
        start = category.get("running_since")
        if not start:
            continue
        category["running_since"] = None
        if moment > start:
            category.setdefault("sessions", []).append({"start": start, "end": moment})
        changed = True
    if changed:
        set_data(data, sync=True)


def _browser_form(window):
    """WinForms BrowserView instance for UI-thread marshaling. Avoids window.native."""
    try:
        gui = getattr(window, "gui", None)
        browser_view = getattr(gui, "BrowserView", None)
        if browser_view is None:
            return None
        return browser_view.instances.get(window.uid)
    except Exception:
        return None


def _apply_on_top(window, enabled: bool) -> bool:
    """Set TopMost via pywebview only — never touch window.native (that freezes Edge)."""
    try:
        window.on_top = bool(enabled)
        return True
    except Exception:
        return False


def schedule_on_top(window, enabled: bool) -> bool:
    """Apply on-top on the WinForms UI thread without blocking the caller."""
    if window is None:
        return False
    desired = bool(enabled)

    def apply() -> None:
        _apply_on_top(window, desired)

    form = _browser_form(window)
    if form is None:
        return False
    try:
        from System import Action

        # Always marshal — setting TopMost off the UI thread freezes the app.
        form.BeginInvoke(Action(apply))
        return True
    except Exception:
        return False


class Api:
    def __init__(self) -> None:
        self.window = None

    def set_on_top(self, enabled: bool) -> bool:
        # Return immediately; BeginInvoke does the real work on the UI thread.
        return schedule_on_top(self.window, bool(enabled))


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def start_ui_server() -> tuple[ThreadingHTTPServer, str]:
    port = free_port()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args) -> None:
            return

        def _send(self, code: int, body: bytes, content_type: str) -> None:
            self.send_response(code)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

        def _read_json_body(self) -> dict | None:
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                return None
            if length < 0 or length > MAX_BODY_BYTES:
                return None
            raw = self.rfile.read(length) if length else b""
            try:
                payload = json.loads(raw.decode("utf-8")) if raw else {}
            except (UnicodeDecodeError, json.JSONDecodeError):
                return None
            return payload if isinstance(payload, dict) else None

        def _safe_ui_file(self, rel: str) -> Path | None:
            root = UI_DIR.resolve()
            target = (UI_DIR / rel).resolve()
            try:
                if not target.is_relative_to(root):
                    return None
            except AttributeError:
                if root not in target.parents and target != root:
                    return None
            if not target.is_file():
                return None
            return target

        def do_GET(self) -> None:
            path = urlparse(self.path).path
            if path == "/api/data":
                body = json.dumps(get_data()).encode("utf-8")
                self._send(200, body, "application/json; charset=utf-8")
                return
            rel = "index.html" if path in ("", "/") else path.lstrip("/")
            target = self._safe_ui_file(rel)
            if target is None:
                self._send(404, b"not found", "text/plain; charset=utf-8")
                return
            self._send(200, target.read_bytes(), MIME.get(target.suffix.lower(), "application/octet-stream"))

        def do_POST(self) -> None:
            path = urlparse(self.path).path
            payload = self._read_json_body()
            if payload is None:
                self._send(400, b"bad request", "text/plain; charset=utf-8")
                return

            if path == "/api/on-top":
                enabled = bool(payload.get("enabled"))
                data = get_data()
                data["always_on_top"] = enabled
                set_data(data, sync=False)
                api = _API
                if api is not None and api.window is not None:
                    schedule_on_top(api.window, enabled)
                self._send(200, b'{"ok":true}', "application/json; charset=utf-8")
                return

            if path != "/api/data":
                self._send(404, b"not found", "text/plain; charset=utf-8")
                return
            set_data(payload, sync=False)
            self._send(200, b'{"ok":true}', "application/json; charset=utf-8")

    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{port}/"


def main() -> None:
    global _API
    data = get_data()
    width, height = clamp_size(data.get("window_width"), data.get("window_height"))

    server, url = start_ui_server()
    api = Api()
    _API = api
    window = webview.create_window(
        "Nexus",
        url=url,
        width=width,
        height=height,
        min_size=(MIN_WIDTH, MIN_HEIGHT),
        resizable=True,
        background_color="#0B0F17",
        on_top=bool(data.get("always_on_top", True)),
        text_select=True,
    )
    api.window = window

    resize_timer: threading.Timer | None = None

    def on_loaded() -> None:
        # loaded fires on the UI thread — safe to set TopMost directly.
        _apply_on_top(window, bool(get_data().get("always_on_top", True)))

    def on_resized() -> None:
        nonlocal resize_timer
        try:
            w = int(getattr(window, "width", width) or width)
            h = int(getattr(window, "height", height) or height)
        except Exception:
            return

        def persist() -> None:
            update_window_size(w, h)

        if resize_timer is not None:
            resize_timer.cancel()
        resize_timer = threading.Timer(0.35, persist)
        resize_timer.daemon = True
        resize_timer.start()

    def on_closing() -> None:
        nonlocal resize_timer
        if resize_timer is not None:
            resize_timer.cancel()
        try:
            update_window_size(int(window.width), int(window.height))
            # Flush size to disk before exit.
            set_data(get_data(), sync=True)
        except Exception:
            pass
        stop_running_timers()
        server.shutdown()

    window.events.loaded += on_loaded
    try:
        window.events.resized += on_resized
    except Exception:
        pass
    window.events.closing += on_closing

    try:
        webview.start(gui="edgechromium", debug=False)
    except Exception:
        webview.start(debug=False)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        DATA_PATH.parent.mkdir(parents=True, exist_ok=True)
        (DATA_PATH.parent / "error.log").write_text(traceback.format_exc(), encoding="utf-8")
        raise
