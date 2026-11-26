"""python -m server   (from the repository root; server/README.md)"""
import logging
import os
import sys

from .config import ROOT, Config

if ROOT not in sys.path:
    sys.path.insert(0, ROOT)                     # hw/ beside server/


def main():
    import torch
    import uvicorn

    from .app import App

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", stream=sys.stdout)
    for noisy in ("mcp", "httpx", "httpx2", "huggingface_hub", "uvicorn.error"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg = Config.from_env()
    torch.set_num_threads(max(1, cfg.threads))
    app = App(cfg)

    class Server(uvicorn.Server):
        def handle_exit(self, sig, frame):
            # Before uvicorn waits out its grace time: waiting tool calls answer at once
            # and the writer stops after its batch, instead of a 500 and minutes of CPU.
            app.stop()
            super().handle_exit(sig, frame)

    # No access log: request paths carry the key.  No limit_concurrency: it counts open
    # connections, so a stranger's half-open ones would turn real calls into 503s sooner.
    Server(uvicorn.Config(app, host=cfg.host, port=cfg.port, access_log=False, log_config=None,
                          proxy_headers=False, server_header=False, date_header=False,
                          timeout_graceful_shutdown=int(os.environ.get("HANDSCHRIFT_GRACE", 5)))).run()


if __name__ == "__main__":
    main()
