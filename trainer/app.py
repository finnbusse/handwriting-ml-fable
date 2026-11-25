"""The trainer Space: a small HTTP service that runs scripts/retrain.py for the
web app's Training tab.

    POST /start   Authorization: Bearer <token>   {"epochs": 30, "lines_only": false, "sample_every": 1, "resume": false}
    GET  /status  (Authorization optional: with the owner's token the log tail is included)
    POST /stop    Authorization: Bearer <token>   {"force": false}

Only the Space's owner (SPACE_AUTHOR_NAME, set by Hugging Face) may start or
stop: the token is checked with whoami.  Progress itself is not served from
here; the driver writes it into the model repo, where the app reads it.

    uvicorn trainer.app:app --host 0.0.0.0 --port 7860
"""
from __future__ import annotations

import os
import re

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from . import jobs

STATUS_FOR = {"auth": 401, "owner": 403, "busy": 409, "options": 400, "idle": 409}


def app_origin(owner: str) -> str:
    """The web app's static Space: https://<owner>-handschrift.static.hf.space"""
    sub = re.sub(r"[^a-z0-9-]", "-", f"{owner}-handschrift".lower())
    return f"https://{sub}.static.hf.space"


def bearer(request: Request) -> str | None:
    h = request.headers.get("authorization") or ""
    return h[7:].strip() if h.lower().startswith("bearer ") else None


def create_app(owner: str | None = None, runner: jobs.Runner | None = None, defaults: dict | None = None) -> FastAPI:
    owner = owner if owner is not None else os.environ.get("SPACE_AUTHOR_NAME", "")
    runner = runner or jobs.Runner(owner)
    defaults = defaults or jobs.retrain_defaults()
    app = FastAPI(title="Handschrift Training", docs_url=None, redoc_url=None, openapi_url=None)
    origins = [app_origin(owner)] if owner else []
    extra = os.environ.get("HW_EXTRA_ORIGINS", "")
    origins += [o.strip() for o in extra.split(",") if o.strip()]
    app.add_middleware(CORSMiddleware, allow_origins=origins,
                       allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
                       allow_methods=["GET", "POST"], allow_headers=["Authorization", "Content-Type"],
                       max_age=600)
    app.state.runner = runner

    def refused(e: jobs.Refused):
        return JSONResponse({"ok": False, "error": e.kind, "detail": str(e)}, status_code=STATUS_FOR.get(e.kind, 400))

    async def body(request: Request):
        try:
            data = await request.json()
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    @app.get("/")
    def root():
        return {"service": "handschrift-training", "ok": True}

    @app.get("/status")
    def status(request: Request):
        token = bearer(request)
        authorized = False
        if token:
            try:
                runner.check(token)
                authorized = True
            except jobs.Refused:
                authorized = False
        return dict(runner.status(authorized), defaults=defaults, authorized=authorized)

    @app.post("/start")
    async def start(request: Request):
        try:
            job = await run_in_threadpool(runner.start, bearer(request), await body(request))
        except jobs.Refused as e:
            return refused(e)
        return {"ok": True, "run_id": job.run_id, "started": jobs.iso(job.started)}

    @app.post("/stop")
    async def stop(request: Request):
        data = await body(request)
        try:
            job = await run_in_threadpool(runner.stop, bearer(request), bool(data.get("force")))
        except jobs.Refused as e:
            return refused(e)
        return {"ok": True, "run_id": job.run_id}

    return app


app = create_app() if os.environ.get("HW_TRAINER_NO_APP") != "1" else None
