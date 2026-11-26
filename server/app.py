"""The HTTP side: the MCP endpoint behind the key, the download links, /healthz.

    /k/<key>/mcp     POST, DELETE        MCP (Streamable HTTP, stateless, JSON responses; GET is 405)
    /d/<id>          GET                 the PDF, or a waiting page while it is written
    /healthz         GET                 {"ok": true, "model": ..., "busy": ...}
Everything else, a wrong key included, is the same plain 404."""
from __future__ import annotations

import asyncio
import contextlib
import contextvars
import html
import json
import logging
import os
import re
import threading
import time

import mcp_types as types
from mcp.server.lowlevel import Server
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager

from . import keys as keys_mod
from . import text as text_mod
from .config import Config
from .jobs import PAPERS, PENS, SCHEMES, SIZES, Job, Refused, Store, Writer, new_id, node
from .keys import REFRESH
from .model import ModelSource

log = logging.getLogger("handschrift")

MAX_BODY = 200_000
TOOL = types.Tool(
    name="handschrift_pdf",
    description=("Schreibt Text in der Handschrift des Besitzers auf A4-Seiten und antwortet mit einem Link zum PDF; "
                 "den Link unverändert weitergeben. Text schlicht übergeben: Absätze durch eine Leerzeile trennen, "
                 "kein Markdown, Aufzählungen mit „- “. Höchstens 12.000 Zeichen."),
    input_schema={
        "type": "object",
        "properties": {
            "text": {"type": "string"},
            "papier": {"type": "string", "enum": list(PAPERS), "default": "liniert"},
            # "dunkle Schrift" must not lead to farbe=dunkel, which means dark paper
            "farbe": {"type": "string", "enum": list(SCHEMES), "default": "hell",
                      "description": "Papier: hell = weiß mit dunkler Schrift, dunkel = dunkel mit heller Schrift"},
            "groesse": {"type": "string", "enum": list(SIZES), "default": "mittel", "description": "Schriftgröße"},
            "stift": {"type": "string", "enum": list(PENS), "default": "fineliner"},
        },
        "required": ["text"],
    },
)
_request = contextvars.ContextVar("handschrift_request")     # (key hash, base url) of the MCP call


# What assistants send instead of the German values.
_SYNONYMS = {"lined": "liniert", "ruled": "liniert", "linien": "liniert", "grid": "kariert", "squared": "kariert",
             "karo": "kariert", "kariertes": "kariert", "blank": "blanko", "plain": "blanko", "leer": "blanko",
             "light": "hell", "white": "hell", "weiss": "hell", "dark": "dunkel", "black": "dunkel", "schwarz": "dunkel",
             "small": "klein", "medium": "mittel", "normal": "mittel", "large": "gross", "big": "gross",
             "pen": "fineliner", "fountain": "fueller", "fountainpen": "fueller", "fountain pen": "fueller",
             "fullfederhalter": "fueller", "pencil": "bleistift"}


def _pick(name: str, value, allowed, default, notes: list) -> str:
    v = str(value if value is not None else "").strip().lower().replace("ü", "ue").replace("ö", "oe").replace("ß", "ss")
    v = _SYNONYMS.get(v, v)
    if v in allowed:
        return v
    if v:
        notes.append(f"{name} „{str(value)[:20]}“ unbekannt, {default} verwendet")
    return default


def _title(text: str) -> str:
    line = next((s.strip() for s in text.split("\n") if s.strip()), "Handschrift")
    return line if len(line) <= 60 else line[:59] + "…"


_HOST = re.compile(r"^([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:\d{1,5})?$")


def _base_url(cfg: Config, scope) -> str:
    """Without HANDSCHRIFT_PUBLIC_URL, from the headers; only a plain host and http(s)
    pass, since the line goes into the assistant's context."""
    if cfg.public_url:
        return cfg.public_url
    h = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
    hosts = [(h.get(k) or "").split(",")[0].strip() for k in ("x-forwarded-host", "host")]
    host = next((x for x in hosts if _HOST.match(x)), "localhost")
    proto = (h.get("x-forwarded-proto") or "").split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = "https" if scope.get("scheme") == "https" else "http"
    return f"{proto}://{host}"


def _line(text: str, error: bool = False) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=text)], is_error=error)


class App:
    def __init__(self, cfg: Config | None = None):
        self.cfg = cfg or Config.from_env()
        os.makedirs(self.cfg.data, exist_ok=True)
        self.models = ModelSource(self.cfg)
        reader = self.models.reader
        self.keys = keys_mod.Keys(self.cfg.key_hashes, (lambda: reader.read(keys_mod.KEYS_FILE)) if reader else None)
        self.store = Store(self.cfg)
        self.writer = Writer(self.cfg, self.store, self.models)
        self.mcp = Server("handschrift", version="1", on_list_tools=self._list_tools, on_call_tool=self._call_tool)
        self.manager = StreamableHTTPSessionManager(app=self.mcp, json_response=True, stateless=True,
                                                    max_request_body_size=MAX_BODY)
        self.stopping = threading.Event()             # set by the signal handler (__main__) and at shutdown
        self._stop_seen: asyncio.Event | None = None
        self.loop: asyncio.AbstractEventLoop | None = None

    def stop(self) -> None:
        """SIGTERM/SIGINT: before uvicorn's grace time runs, so that the waiting tool calls
        still answer and the writer thread stops after its batch."""
        self.stopping.set()
        self.writer.stop_all()
        if self.loop is not None and self._stop_seen is not None:
            self.loop.call_soon_threadsafe(self._stop_seen.set)

    # ---------------------------------------------------------------- MCP tool
    async def _list_tools(self, ctx, params) -> types.ListToolsResult:
        return types.ListToolsResult(tools=[TOOL])

    async def _call_tool(self, ctx, params) -> types.CallToolResult:
        if params.name != TOOL.name:
            return _line(f"Unbekanntes Werkzeug. Es gibt nur {TOOL.name}.", True)
        key, base = _request.get()
        args = params.arguments or {}
        try:
            return await self._write(key, base, args)
        except Refused as e:
            log.info("call key=%s refused: %s", key, str(e)[:40])
            return _line(str(e), True)
        except Exception as e:                         # never a raw message (paths, node's stderr) to the chat
            log.error("call key=%s error: %s", key, type(e).__name__)
            return _line("Beim Schreiben ist etwas schiefgegangen. Bitte später noch einmal versuchen.", True)

    async def _write(self, key: str, base: str, args: dict) -> types.CallToolResult:
        t0 = time.perf_counter()
        if self.stopping.is_set():
            raise Refused(_RESTART)
        self.writer.count_call(key)                    # first: refused and broken calls are not free
        raw = args.get("text")
        if not isinstance(raw, str) or not raw.strip():
            raise Refused("Es fehlt der Text, der geschrieben werden soll.")
        text = text_mod.plain(raw)
        if len(text) > text_mod.MAX_CHARS:
            n = f"{len(text):,}".replace(",", ".")
            raise Refused(f"Der Text ist zu lang ({n} Zeichen, höchstens 12.000). "
                          "Bitte kürzen oder in mehreren Teilen schicken.")
        text = text_mod.split_long_words(text)
        notes: list[str] = []
        options = {"papier": _pick("papier", args.get("papier"), PAPERS, "liniert", notes),
                   "farbe": _pick("farbe", args.get("farbe"), SCHEMES, "hell", notes),
                   "groesse": _pick("groesse", args.get("groesse"), SIZES, "mittel", notes),
                   "stift": _pick("stift", args.get("stift"), PENS, "fineliner", notes)}
        version, synth = await asyncio.to_thread(self.models.get)
        if synth is None:
            raise Refused("Das Handschrift-Modell ist gerade nicht verfügbar. Bitte später noch einmal versuchen.")
        token = self.writer.reserve(key)              # budget and queue before the node plan, not after
        job = None
        try:
            plan = await asyncio.to_thread(node, self.cfg, {"cmd": "plan", "text": text, "charset": synth.charset.chars})
            if not plan["pieces"]:
                raise Refused("In diesem Text steht nichts, was sich mit der Hand schreiben lässt.")
            job = Job(id=new_id(), key=key, text=text, plan=plan, options=options, title=_title(text))
            self.writer.submit(job)
        finally:
            if job is None:
                self.writer.release(key, token)
        log.info("call key=%s chars=%d/%d pieces=%d longest=%d queue=%d %s", key, len(raw), len(text), job.total,
                 max(len(p["text"]) for p in plan["pieces"]), self.writer.waiting(), ",".join(options.values()))
        link = f"{base}/d/{job.id}"
        waits = [asyncio.ensure_future(job.finished.wait()), asyncio.ensure_future(self._stop_seen.wait())]
        try:
            await asyncio.wait(waits, timeout=self.cfg.wait_seconds, return_when=asyncio.FIRST_COMPLETED)
        finally:
            for w in waits:
                w.cancel()
        missing = plan["unsupported"]
        extra = ([f"Weggelassen: {' '.join(missing[:5])}{' …' if len(missing) > 5 else ''}"] if missing else []) + notes
        note = "".join(f" {x}." for x in extra)
        log.info("answer key=%s state=%s after %.1fs", key, job.state, time.perf_counter() - t0)
        if job.state == "done":
            return _line(f"PDF mit {job.pages} {'Seite' if job.pages == 1 else 'Seiten'}: {link}{note}")
        if job.state == "failed":
            return _line(job.error or "Beim Schreiben ist etwas schiefgegangen. Bitte noch einmal versuchen.", True)
        if self.stopping.is_set():
            return _line(_RESTART, True)
        return _line(f"Die Seiten werden noch geschrieben; der Link zeigt den Fortschritt und dann das PDF: {link}{note}")

    # ---------------------------------------------------------------- HTTP
    async def __call__(self, scope, receive, send):
        if scope["type"] == "lifespan":
            return await self._lifespan(receive, send)
        if scope["type"] != "http":
            return
        path, method = scope["path"], scope["method"]
        parts = path.split("/")
        if path == "/healthz" and method in ("GET", "HEAD"):
            version = self.models.version
            busy = self.writer.busy
            return await _send(send, 200, json.dumps({"ok": True, "model": version, "busy": busy}).encode(), "application/json")
        if len(parts) == 3 and parts[1] == "d" and method in ("GET", "HEAD"):
            return await self._download(parts[2], send, method == "HEAD")
        if len(parts) == 4 and parts[1] == "k" and parts[3] == "mcp" and method in ("POST", "GET", "DELETE"):
            h = self.keys.check(parts[2])
            if h and method == "GET":
                # Stateless: nothing is ever sent on a server stream, and an open one would
                # stay open for good.  The spec allows 405; clients then do without it.
                return await _send(send, 405, b"", "text/plain; charset=utf-8", extra=[(b"allow", b"POST, DELETE")])
            if h:
                return await self._mcp(h[:6], scope, receive, send)
        await _send(send, 404, b"Not Found", "text/plain; charset=utf-8")

    async def _mcp(self, key: str, scope, receive, send):
        length = next((v for k, v in scope["headers"] if k == b"content-length"), None)
        if length is not None and (not length.isdigit() or int(length) > MAX_BODY):
            return await _too_big(send)
        body, more = b"", True
        while more:
            msg = await receive()
            if msg["type"] == "http.disconnect":
                return
            body += msg.get("body", b"")
            more = msg.get("more_body", False)
            if len(body) > MAX_BODY:
                return await _too_big(send)
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": body, "more_body": False}
            return await receive()

        token = _request.set((key, _base_url(self.cfg, scope)))
        try:
            await self.manager.handle_request(scope, replay, send)
        finally:
            _request.reset(token)

    async def _download(self, doc_id: str, send, head: bool):
        p = self.store.path(doc_id)
        if p is None:
            return await _send(send, 404, b"Not Found", "text/plain; charset=utf-8")
        job = self.store.jobs.get(doc_id)
        if job is not None and not job.finished.is_set():
            return await _send(send, 200, b"" if head else self._waiting_page(job), "text/html; charset=utf-8")
        if job is not None and job.state == "failed":
            page = _page("Das hat nicht geklappt", f"<p>{html.escape(job.error)}</p>")
            return await _send(send, 200, b"" if head else page, "text/html; charset=utf-8")
        f = await asyncio.to_thread(self.store.finished, doc_id)
        if f is None:
            state = None if job is not None else await asyncio.to_thread(self.store.left_over, doc_id)
            if state is not None:                      # a job of an earlier run of the server
                why = ("Beim Schreiben ist etwas schiefgegangen." if state == "failed" else
                       "Das Schreiben wurde unterbrochen, weil der Server neu gestartet ist.")
                page = _page("Das hat nicht geklappt", f"<p>{why} Bitte den Text noch einmal schicken.</p>")
                return await _send(send, 410, b"" if head else page, "text/html; charset=utf-8")
            page = _page("Nicht gefunden", "<p>Dieses PDF gibt es nicht (mehr). PDFs bleiben "
                         f"{self.cfg.keep_days:g} Tage abrufbar.</p>")
            return await _send(send, 404, b"" if head else page, "text/html; charset=utf-8")
        with open(f, "rb") as fh:
            data = fh.read()
        name = time.strftime("handschrift-%Y-%m-%d.pdf", time.localtime(os.path.getmtime(f)))
        await _send(send, 200, b"" if head else data, "application/pdf",
                    extra=[(b"content-disposition", f'inline; filename="{name}"'.encode()),
                           (b"content-length", str(len(data)).encode())])

    def _waiting_page(self, job: Job) -> bytes:
        if job.state == "queued":
            n = self.writer.position(job)
            status = f"Wartet, bis die Texte davor fertig sind (Platz {n})." if n else "Gleich geht es los."
        elif job.state == "writing":
            status = f"Schreibt … {job.done} von {job.total} Stücken."
        elif job.state == "retrying":
            status = f"Alle {job.total} Stücke geschrieben, schief geratene werden neu geschrieben."
        else:
            status = "Setzt die Seiten und erstellt das PDF."
        share = 100 * job.done / max(job.total, 1) if job.state != "queued" else 0
        body = (f"<p>{html.escape(status)}</p><div class=bar><div style='width:{share:.0f}%'></div></div>"
                "<p class=small>Diese Seite lädt sich von selbst neu und zeigt dann das PDF.</p>")
        return _page("Die Seiten werden geschrieben", body, refresh=3)

    # ---------------------------------------------------------------- lifecycle
    async def _lifespan(self, receive, send):
        msg = await receive()
        assert msg["type"] == "lifespan.startup"
        self.loop, self._stop_seen = asyncio.get_running_loop(), asyncio.Event()
        async with contextlib.AsyncExitStack() as stack:
            try:
                await stack.enter_async_context(self.manager.run())
                self.store.cleanup()
                tasks = [asyncio.create_task(self.writer.run()), asyncio.create_task(self._hourly()),
                         asyncio.create_task(self._keys_loop()), asyncio.create_task(asyncio.to_thread(self.models.get))]
                stack.callback(lambda: [t.cancel() for t in tasks])
                stack.callback(self.stop)
                log.info("ready: keys from env=%d, repo=%s, model=%s, wait=%ss, threads=%d",
                         len(self.keys.env), "yes" if self.models.reader else "no",
                         "local" if self.cfg.model_dir else ("repo" if self.cfg.model_repo else "none"),
                         self.cfg.wait_seconds, self.cfg.threads)
                if not self.cfg.public_url and self.cfg.host not in ("127.0.0.1", "localhost", "::1"):
                    log.warning("HANDSCHRIFT_PUBLIC_URL is not set: links are built from the request's Host header")
            except Exception as e:
                await send({"type": "lifespan.startup.failed", "message": type(e).__name__})
                return
            await send({"type": "lifespan.startup.complete"})
            msg = await receive()
        await send({"type": "lifespan.shutdown.complete"})

    async def _keys_loop(self):
        """mcp/keys.json is read here, never inside a request (a stranger's request would
        otherwise wait for the repository)."""
        if self.keys.fetch is None:
            return
        while True:
            await asyncio.to_thread(self.keys.refresh)
            await asyncio.sleep(REFRESH)

    async def _hourly(self):
        while True:
            await asyncio.sleep(3600)
            await asyncio.to_thread(self.store.cleanup)
            self.writer.forget_old()


async def _send(send, status: int, body: bytes, ctype: str, extra=()):
    headers = [(b"content-type", ctype.encode()), (b"cache-control", b"no-store"),
               (b"x-robots-tag", b"noindex"), (b"referrer-policy", b"no-referrer"), *extra]
    if not any(k == b"content-length" for k, _ in headers):
        headers.append((b"content-length", str(len(body)).encode()))
    await send({"type": "http.response.start", "status": status, "headers": headers})
    await send({"type": "http.response.body", "body": body})


_RESTART = "Der Server startet gerade neu, das PDF wurde nicht fertig. Bitte den Text gleich noch einmal schicken."


async def _too_big(send):
    err = {"jsonrpc": "2.0", "id": None,
           "error": {"code": -32600, "message": "Die Anfrage ist zu groß (höchstens 200 KB). Bitte einen kürzeren Text schicken."}}
    await _send(send, 413, json.dumps(err, ensure_ascii=False).encode(), "application/json")


def _page(title: str, body: str, refresh: int | None = None) -> bytes:
    meta = f'<meta http-equiv="refresh" content="{refresh}">' if refresh else ""
    return f"""<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">{meta}<title>{html.escape(title)}</title>
<style>body{{font:17px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1b2a49;background:#fff}}
@media (prefers-color-scheme:dark){{body{{color:#e9ecf1;background:#1b1f26}}}}
.bar{{height:8px;border-radius:4px;background:#dfe5ee;overflow:hidden}}.bar div{{height:100%;background:#2141b8}}
.small{{font-size:14px;opacity:.7}}</style></head><body><h1 style="font-size:22px">{html.escape(title)}</h1>{body}</body></html>""".encode()
