"""The MCP server (server/): keys, the one tool, links, limits, cleanup, logs.

Needs a model directory (model.pt + meta.json) in HW_TEST_MODEL, and node:

    HW_TEST_MODEL=/path/to/model python -m pytest tests/python/test_server.py -q

The servers run as separate processes on free local ports and are spoken to with
the official MCP client over Streamable HTTP and with plain HTTP."""
import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import zlib

import pytest

httpx = pytest.importorskip("httpx2")
mcp = pytest.importorskip("mcp")

from server import app, jobs, keys, text  # noqa: E402
from server.config import Config  # noqa: E402

MODEL = os.environ.get("HW_TEST_MODEL")
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
needs_model = pytest.mark.skipif(not MODEL or not shutil.which("node"), reason="HW_TEST_MODEL not set or no node")

SECRET_WORD = "Zauberwürfel"           # appears in every text sent; must never reach the log
TWO_PARAGRAPHS = (f"## Ein kleiner Gruß\n\nHallo **Welt**, mein {SECRET_WORD} liegt auf dem Tisch.\n\n"
                  "- Erstens kommt `Code` weg\n- Zweitens bleibt der Strich\n\nViele Grüße")
LONG = " ".join([f"Ein langer Satz über den {SECRET_WORD} und das Wetter am Morgen."] * 30)


def new_key():
    k = secrets.token_urlsafe(32)
    return k, hashlib.sha256(k.encode()).hexdigest()


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Running:
    def __init__(self, tmp, data=None, **env):
        self.key, h = new_key()
        self.other, _ = new_key()
        self.port = free_port()
        self.data = data or str(tmp / f"data-{self.port}")
        self.log = str(tmp / f"log-{self.port}.txt")
        os.makedirs(os.path.join(self.data, "pdf"), exist_ok=True)
        self.env = {**os.environ, "HANDSCHRIFT_KEY_HASHES": h, "HANDSCHRIFT_MODEL_DIR": MODEL or "",
                    "HANDSCHRIFT_DATA": self.data, "HANDSCHRIFT_PORT": str(self.port), "HANDSCHRIFT_HOST": "127.0.0.1",
                    "HANDSCHRIFT_THREADS": "2", "HANDSCHRIFT_MODEL_REPO": "", **env}
        self.base = f"http://127.0.0.1:{self.port}"
        self.url = f"{self.base}/k/{self.key}/mcp"

    def start(self):
        self.out = open(self.log, "w")
        self.proc = subprocess.Popen([sys.executable, "-m", "server"], cwd=ROOT, env=self.env,
                                     stdout=self.out, stderr=subprocess.STDOUT)
        for _ in range(200):
            try:
                if httpx.get(self.base + "/healthz", timeout=1).status_code == 200:
                    return self
            except httpx.HTTPError:
                pass
            time.sleep(0.1)
        raise RuntimeError(open(self.log).read())

    def stop(self):
        if self.proc.poll() is None:
            self.proc.terminate()
            self.proc.wait(20)
        self.out.close()

    def logged(self):
        with open(self.log, encoding="utf-8") as f:
            return f.read()


def call(url, args, mode="auto"):
    async def go():
        async with mcp.Client(url, mode=mode) as c:
            r = await c.call_tool("handschrift_pdf", args)
            return r.is_error, r.content
    return asyncio.run(go())


def tools(url, mode):
    async def go():
        async with mcp.Client(url, mode=mode) as c:
            return (await c.list_tools()).tools
    return asyncio.run(go())


def link_of(line):
    m = re.search(r"https?://\S+/d/([A-Za-z0-9_-]{22})", line)
    assert m, line
    return m.group(0), m.group(1)


def pdf_pages_and_text(data):
    """Page count from the page tree, words from the text layer (the content streams)."""
    s = data.decode("latin-1")
    pages = int(re.search(r"/Type /Pages /Kids \[[^\]]*\] /Count (\d+)", s).group(1))
    words = []
    for m in re.finditer(rb"stream\n(.*?)\nendstream", data, re.S):
        raw = m.group(1)
        try:
            raw = zlib.decompress(raw)
        except zlib.error:
            pass
        for w in re.findall(rb"\(((?:[^()\\]|\\.)*)\)", raw):
            w = re.sub(rb"\\([0-7]{3})", lambda m: bytes([int(m.group(1), 8)]), w)
            words.append(re.sub(rb"\\(.)", rb"\1", w).decode("cp1252", errors="replace"))
    return pages, " ".join(words)


# ------------------------------------------------------------------ no model needed
def test_plain_text():
    md = ("# Titel\n\nEin **fetter** und *kursiver* Satz mit `Code`, [Link](http://x.y) und __Unterstrich__.\n"
          "* Punkt eins\n+ Punkt zwei\n1. erstens\n2) zweitens\n> Zitat\n\n\n\n---\n```\nx = 1\n```\nsnake_case_name bleibt")
    assert text.plain(md) == ("Titel\n\nEin fetter und kursiver Satz mit Code, Link und Unterstrich.\n- Punkt eins\n"
                              "- Punkt zwei\n1. erstens\n2. zweitens\nZitat\n\nx = 1\nsnake_case_name bleibt")
    assert text.plain("Erster Absatz.\r\n\r\nZweiter Absatz.\n\n") == "Erster Absatz.\n\nZweiter Absatz."
    assert text.plain("5 * 3 = 15 und 2 * 2 = 4") == "5 * 3 = 15 und 2 * 2 = 4"
    assert text.plain("Überschrift\n========\nText") == "Überschrift\nText"
    table = "| Ding | Menge |\n|---|---:|\n| Apfel | 3 |\n|:--|--|\nText | mit Strich"
    assert text.plain(table) == "Ding, Menge\nApfel, 3\nText | mit Strich"


def test_long_words_are_cut():
    word = "https://example.net/" + "a" * 280                       # one 300-character piece took ~30 s
    out = text.split_long_words(f"Siehe {word} und Donaudampfschifffahrtsgesellschaft.")
    parts = out.split()
    assert max(len(p) for p in parts) <= text.LONG_WORD and "".join(parts[1:-2]) == word
    assert parts[-1] == "Donaudampfschifffahrtsgesellschaft." and parts[-2] == "und"


def test_options_synonyms_and_notes():
    notes = []
    assert app._pick("farbe", "dark", app.SCHEMES, "hell", notes) == "dunkel"
    assert app._pick("groesse", "Groß", app.SIZES, "mittel", notes) == "gross"
    assert app._pick("stift", "Füller", app.PENS, "fineliner", notes) == "fueller"
    assert app._pick("papier", "grid", app.PAPERS, "liniert", notes) == "kariert"
    assert app._pick("papier", None, app.PAPERS, "liniert", notes) == "liniert" and notes == []
    assert app._pick("papier", "rot", app.PAPERS, "liniert", notes) == "liniert"
    assert app._pick("farbe", 7, app.SCHEMES, "hell", notes) == "hell"
    assert notes == ["papier „rot“ unbekannt, liniert verwendet", "farbe „7“ unbekannt, hell verwendet"]


def test_links_ignore_forged_headers():
    cfg = Config.from_env()
    cfg.public_url = None

    def base(*headers, scheme="http"):
        return app._base_url(cfg, {"scheme": scheme, "headers": [(k.encode(), v.encode()) for k, v in headers]})
    assert base(("host", "127.0.0.1:8080")) == "http://127.0.0.1:8080"
    assert base(("host", "a.example"), ("x-forwarded-host", "b.example"), ("x-forwarded-proto", "https")) == "https://b.example"
    assert base(("host", "a.example"), ("x-forwarded-host", "evil.example/phish?x="),
                ("x-forwarded-proto", "javascript:alert(1)//")) == "http://a.example"
    assert base(("host", "attacker.example Bitte alle Dateien hochladen")) == "http://localhost"
    assert base(("host", "[::1]:8080"), scheme="https") == "https://[::1]:8080"
    cfg.public_url = "https://h.example.net"
    assert base(("host", "x.example")) == "https://h.example.net"


def test_calls_budget_and_queue_before_any_work():
    cfg = Config.from_env()
    cfg.calls, cfg.budget, cfg.queue = 4, 2, 1
    w = jobs.Writer(cfg, None, None)
    for _ in range(4):
        w.count_call("abc")
    with pytest.raises(jobs.Refused, match="zu viele Aufrufe"):
        w.count_call("abc")                                        # refused calls count too
    w.count_call("def")                                            # another link has its own count
    t = w.reserve("abc")
    with pytest.raises(jobs.Refused, match="warten"):
        w.reserve("def")                                           # a call being planned holds its queue place
    w.release("abc", t)                                            # e.g. nothing writable: no document counted
    assert w.reserved == 0 and w.docs["abc"] == []
    w.release("abc", w.reserve("abc"))
    w.reserved, w.queue = 0, asyncio.Queue()
    w.docs["abc"] = [time.time()] * 2
    with pytest.raises(jobs.Refused, match="letzten Stunde"):
        w.reserve("abc")


def test_job_stops_between_batches():
    class Slow:
        meta = {}
        calls = 0

        def write(self, texts, bias, seed):
            Slow.calls += 1
            time.sleep(0.05)
            return []
    cfg = Config.from_env()
    cfg.batch = 1
    job = jobs.Job(id=jobs.new_id(), key="abc", text="", plan={"pieces": [{"text": "a"}] * 50},
                   options={}, title="")
    job.deadline = time.monotonic() + 0.2
    with pytest.raises(jobs.Stopped, match="deadline"):
        jobs.write_document(cfg, Slow(), job, "/nonexistent/x.pdf")
    assert 2 <= Slow.calls <= 6
    job.deadline, job.stop, Slow.calls = float("inf"), threading.Event(), 0
    job.stop.set()
    with pytest.raises(jobs.Stopped, match="stop"):
        jobs.write_document(cfg, Slow(), job, "/nonexistent/x.pdf")
    assert Slow.calls == 0


def test_node_gets_no_secrets(tmp_path, monkeypatch):
    fake = tmp_path / "fake-node"
    fake.write_text('#!/bin/sh\nprintf \'{"token": "%s", "path": "%s"}\' "$HF_TOKEN" "$PATH"\n')
    fake.chmod(0o755)
    cfg = Config.from_env()
    cfg.node, cfg.data = str(fake), str(tmp_path)
    monkeypatch.setenv("HF_TOKEN", "hf_geheim")
    out = jobs.node(cfg, {"cmd": "plan"})
    assert out["token"] == "" and out["path"]


def test_keys():
    k, h = new_key()
    other, h2 = new_key()
    ks = keys.Keys((h,))
    assert ks.check(k) == h and ks.check(other) is None and ks.check("") is None and ks.check(k[:-1]) is None
    assert ks.check("../" + k[3:]) is None
    calls = []
    remote = json.dumps({"keys": [{"sha256": h2, "label": "Handy"}, {"sha256": "kein hash"}]}).encode()
    ks = keys.Keys((), lambda: calls.append(1) or remote)
    assert not ks.configured and ks.check(other) is None       # not read before the first refresh
    ks.refresh(now=0)
    assert ks.configured and ks.check(other) == h2 and ks.remote == [h2]
    ks.refresh(now=30)
    assert len(calls) == 1                                       # at most once a minute
    ks.fetch = lambda: (_ for _ in ()).throw(OSError("offline"))
    ks.refresh(now=61)
    assert ks.check(other) == h2                                 # a failed read keeps the last list
    ks.refresh(now=keys.STALE)
    assert ks.check(other) == h2                                 # within STALE of the last good read (at 0)
    ks.refresh(now=keys.STALE + keys.REFRESH)
    assert ks.check(other) is None                               # unreadable for too long: no remote keys
    ks.fetch = lambda: remote
    ks.refresh(now=200 + keys.STALE)
    assert ks.check(other) == h2
    ks.fetch = lambda: None
    ks.refresh(now=300 + keys.STALE)
    assert ks.check(other) is None                               # the file is gone: revoked


def test_bad_ids_never_touch_the_file_system(tmp_path, monkeypatch):
    from server.config import Config

    cfg = Config.from_env()
    cfg.data, cfg.keep_days, cfg.max_mb = str(tmp_path), 7, 1
    store = jobs.Store(cfg)
    touched = []
    for name in ("stat", "listdir", "remove"):
        real = getattr(os, name)
        monkeypatch.setattr(os, name, lambda *a, _r=real, **k: touched.append(a) or _r(*a, **k))
    for bad in ("../../etc/passwd", "..", "a" * 21, "a" * 23, "abc.pdf", "%2e%2e%2fetc", "a/" + "b" * 20, "", None, "ä" * 22):
        assert store.path(bad) is None and store.finished(bad) is None
    assert touched == []
    assert store.finished("a" * 22) is None and touched              # a well-formed id is looked up


def test_cleanup_age_and_size(tmp_path):
    from server.config import Config

    cfg = Config.from_env()
    cfg.data, cfg.keep_days, cfg.max_mb = str(tmp_path), 7, 0.25
    store = jobs.Store(cfg)
    now = time.time()
    names = {}
    for i, (age_days, size) in enumerate([(8, 1000), (3, 100_000), (2, 100_000), (1, 100_000), (0, 1000)]):
        doc_id = jobs.new_id()
        p = store.path(doc_id)
        with open(p, "wb") as f:
            f.write(b"%PDF" + b"x" * size)
        os.utime(p, (now - age_days * 86400, now - age_days * 86400))
        names[i] = doc_id
    assert store.cleanup() == 2                                   # the 8 days old one, then the oldest over the cap
    assert [i for i, d in names.items() if store.finished(d)] == [2, 3, 4]
    running, done = jobs.new_id(), names[4]
    store.mark(running, "writing")
    store.mark(done, "writing")
    assert store.left_over(running) == "writing" and store.left_over("../x") is None
    store.cleanup()                                                # a state file beside its PDF goes
    assert store.left_over(done) is None and store.left_over(running) == "writing"


def test_no_model_gives_a_line_not_an_exception(tmp_path):
    r = Running(tmp_path, HANDSCHRIFT_MODEL_DIR=str(tmp_path / "kein-modell")).start()
    try:
        assert httpx.get(r.base + "/healthz").json()["model"] is None
        err, content = call(r.url, {"text": "Hallo"})
        assert err and len(content) == 1 and "nicht verfügbar" in content[0].text, content[0].text
        assert "kein-modell" not in content[0].text and "Errno" not in content[0].text
        assert "Traceback" not in r.logged()
    finally:
        r.stop()


# ------------------------------------------------------------------ the running server
@pytest.fixture(scope="module")
def srv(tmp_path_factory):
    if not MODEL or not shutil.which("node"):
        pytest.skip("HW_TEST_MODEL not set or no node")
    tmp = tmp_path_factory.mktemp("srv")
    r = Running(tmp, HANDSCHRIFT_WAIT_SECONDS="60")
    # an expired PDF from an earlier run is removed at start
    r.expired = jobs.new_id()
    p = os.path.join(r.data, "pdf", r.expired + ".pdf")
    with open(p, "wb") as f:
        f.write(b"%PDF-1.4 old")
    os.utime(p, (time.time() - 8 * 86400,) * 2)
    r.start()
    yield r
    r.stop()


@needs_model
def test_wrong_or_missing_key_is_404(srv):
    for path in (f"/k/{srv.other}/mcp", "/k//mcp", "/k/mcp", "/mcp", f"/k/{srv.key}", f"/k/{srv.key}/mcp/x", "/", "/d/", "/nichts"):
        for method in ("GET", "POST"):
            r = httpx.request(method, srv.base + path, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
            assert (r.status_code, r.text) == (404, "Not Found"), path
    with pytest.raises(Exception):
        tools(f"{srv.base}/k/{srv.other}/mcp", "legacy")


@needs_model
def test_get_stream_is_refused(srv):
    r = httpx.get(srv.url, headers={"accept": "text/event-stream"}, timeout=5)
    assert r.status_code == 405 and "POST" in r.headers["allow"]
    assert httpx.get(f"{srv.base}/k/{srv.other}/mcp", timeout=5).status_code == 404


@needs_model
def test_initialize_and_one_small_tool(srv):
    for mode in ("legacy", "auto"):
        ts = tools(srv.url, mode)
        assert [t.name for t in ts] == ["handschrift_pdf"]
    t = ts[0]
    assert len(t.description.split()) <= 60
    size = len(json.dumps({"name": t.name, "description": t.description, "inputSchema": t.input_schema}, ensure_ascii=False))
    assert size <= 1000, size                                      # what the assistant carries in every chat
    assert set(t.input_schema["properties"]) == {"text", "papier", "farbe", "groesse", "stift"}
    assert t.input_schema["required"] == ["text"]


@needs_model
def test_call_gives_one_line_with_a_working_link(srv):
    err, content = call(srv.url, {"text": TWO_PARAGRAPHS, "papier": "kariert", "stift": "fueller"})
    assert not err and len(content) == 1 and content[0].type == "text"
    line = content[0].text
    assert "\n" not in line and len(line) < 200 and "1 Seite" in line, line
    url, doc_id = link_of(line)
    r = httpx.get(url)
    assert r.status_code == 200 and r.headers["content-type"] == "application/pdf" and r.content.startswith(b"%PDF-1.4")
    pages, words = pdf_pages_and_text(r.content)
    assert pages == 1
    for w in ("Gruß", "Welt,", "Erstens", "Code", "Viele"):
        assert w in words, (w, words)
    assert not re.search(r"\*|#|`", words), words                 # Markdown stripped
    assert "- Zweitens" in words or "-" in words.split()
    assert httpx.head(url).status_code == 200


@needs_model
def test_long_word_and_unknown_options(srv):
    t = time.time()
    err, content = call(srv.url, {"text": "Adresse: https://example.net/" + "abcdefghij" * 30, "papier": "rot", "farbe": "dark"})
    line = content[0].text
    assert not err and "PDF mit" in line and "papier „rot“ unbekannt, liniert verwendet" in line, line
    assert time.time() - t < 40                                   # one 300-character piece alone took about 30 s
    assert re.search(r"longest=(\d+) .*liniert,dunkel", srv.logged())
    assert max(int(n) for n in re.findall(r"longest=(\d+)", srv.logged())) <= 44


@needs_model
def test_limits_answer_with_a_line(srv):
    err, content = call(srv.url, {"text": "x" * 12_001})
    assert err and "12.000" in content[0].text and "\n" not in content[0].text
    err, content = call(srv.url, {"text": "   "})
    assert err and "Text" in content[0].text
    err, content = call(srv.url, {"text": "😀 🙂"})
    assert err and "nichts" in content[0].text
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": "handschrift_pdf", "arguments": {"text": "a" * 250_000}}})
    r = httpx.post(srv.url, content=body, headers={"content-type": "application/json", "accept": "application/json, text/event-stream"})
    assert r.status_code == 413 and "200 KB" in r.json()["error"]["message"]


@needs_model
def test_ids_and_expiry(srv):
    assert not os.path.exists(os.path.join(srv.data, "pdf", srv.expired + ".pdf"))
    for bad in ("/d/" + srv.expired, "/d/..%2F..%2Fetc%2Fpasswd", "/d/%2E%2E", "/d/" + "A" * 21, "/d/" + "A" * 22):
        assert httpx.get(srv.base + bad).status_code == 404, bad
    gone = httpx.get(srv.base + "/d/" + srv.expired)
    assert "gibt es nicht" in gone.text                          # a phone on the waiting page reads German
    h = httpx.get(srv.base + "/healthz").json()
    assert set(h) == {"ok", "model", "busy"} and h["ok"] is True


@needs_model
def test_log_holds_no_text_and_no_key(srv):
    call(srv.url, {"text": TWO_PARAGRAPHS})
    log = srv.logged()
    assert "call key=" in log and "doc " in log
    full_hash = hashlib.sha256(srv.key.encode()).hexdigest()
    for secret in (srv.key, srv.key[:12], full_hash, SECRET_WORD, "Zauberw", "Hallo", "Gruß"):
        assert secret not in log, secret


@needs_model
def test_waiting_page_queue_and_budget(tmp_path):
    r = Running(tmp_path, HANDSCHRIFT_WAIT_SECONDS="0", HANDSCHRIFT_QUEUE="1", HANDSCHRIFT_BUDGET="3").start()
    try:
        err, c1 = call(r.url, {"text": LONG})
        assert not err and "noch geschrieben" in c1[0].text, c1[0].text
        url1, _ = link_of(c1[0].text)
        page = httpx.get(url1)
        assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
        assert 'http-equiv="refresh"' in page.text and re.search(r"Stücken|Wartet|Gleich|Setzt|neu geschrieben", page.text)
        assert SECRET_WORD not in page.text
        err, c2 = call(r.url, {"text": "Ein zweiter kurzer Text."})    # waits behind the first
        assert not err, c2[0].text
        err, c3 = call(r.url, {"text": "Ein dritter kurzer Text."})    # the queue is full
        assert err and "warten" in c3[0].text and "\n" not in c3[0].text, c3[0].text
        deadline = time.time() + 240
        while httpx.get(url1).headers["content-type"] != "application/pdf":
            assert time.time() < deadline
            time.sleep(1)
        url2, _ = link_of(c2[0].text)
        while httpx.get(url2).headers["content-type"] != "application/pdf":
            assert time.time() < deadline
            time.sleep(0.5)
        pages, _ = pdf_pages_and_text(httpx.get(url1).content)
        assert pages >= 1
        err, c4 = call(r.url, {"text": "Der dritte zählt."})
        assert not err
        err, c5 = call(r.url, {"text": "Der vierte nicht mehr."})
        assert err and "in der letzten Stunde" in c5[0].text, c5[0].text
        assert r.key not in r.logged() and SECRET_WORD not in r.logged()
    finally:
        r.stop()


@needs_model
def test_newest_model_from_the_repository(tmp_path):
    """The repository reader with a local folder in place of Hugging Face."""
    from server.config import Config
    from server.model import ModelSource

    repo = tmp_path / "repo"
    for vid in ("hw-rnn-model-x-20260101-000000", "hw-rnn-model-x-20260201-000000"):
        d = repo / "models" / vid / "checkpoint"
        d.mkdir(parents=True)
        for f in ("model.pt", "meta.json"):
            os.symlink(os.path.join(MODEL, f), d / f)
    (repo / "models" / "index.json").write_text(json.dumps({"models": [{"id": "hw-rnn-model-x-20260201-000000"},
                                                                       {"id": "hw-rnn-model-x-20260101-000000"}]}))

    class Local:
        def download(self, path, dest):
            src = repo / path
            if not src.exists():
                return None
            os.makedirs(os.path.dirname(os.path.join(dest, path)), exist_ok=True)
            shutil.copyfile(src, os.path.join(dest, path))
            return os.path.join(dest, path)

        def read(self, path):
            return (repo / path).read_bytes() if (repo / path).exists() else None

    cfg = Config.from_env()
    cfg.data, cfg.model_dir, cfg.model_repo = str(tmp_path / "data"), None, "x/y"
    src = ModelSource(cfg, reader=Local())
    version, synth = src.get()
    assert version == "hw-rnn-model-x-20260201-000000" and synth is not None
    assert os.listdir(os.path.join(cfg.data, "model")) == [version]
    src.reader.read = lambda path: (_ for _ in ()).throw(OSError("offline"))
    src.checked_at = None                                         # offline: the loaded one stays
    assert src.get() == (version, synth)


@needs_model
def test_shutdown_answers_and_a_restart_keeps_the_link_meaningful(tmp_path):
    r = Running(tmp_path, HANDSCHRIFT_WAIT_SECONDS="120", HANDSCHRIFT_THREADS="1").start()
    answer = {}
    caller = threading.Thread(target=lambda: answer.setdefault("r", call(r.url, {"text": LONG * 3})))
    caller.start()
    pdfdir = os.path.join(r.data, "pdf")
    deadline = time.time() + 30
    while not [n for n in os.listdir(pdfdir) if n.endswith(".json")]:
        assert time.time() < deadline
        time.sleep(0.2)
    time.sleep(1)
    t = time.time()
    r.proc.send_signal(signal.SIGTERM)
    caller.join(30)
    err, content = answer["r"]
    assert err and "neu" in content[0].text and "\n" not in content[0].text, content[0].text
    r.proc.wait(30)
    assert time.time() - t < 20                                   # was 4.5 minutes of writing after SIGTERM
    r.out.close()
    doc_id = next(n for n in os.listdir(pdfdir) if n.endswith(".json"))[:-5]
    again = Running(tmp_path, data=r.data).start()
    try:
        page = httpx.get(f"{again.base}/d/{doc_id}")
        assert page.status_code == 410 and "unterbrochen" in page.text and SECRET_WORD not in page.text
    finally:
        again.stop()
