# The handwriting MCP server.  Build from the repository root:
#   docker build -f server/Dockerfile -t handschrift .
# linux/amd64 and linux/arm64 (Raspberry Pi 5): python slim and Debian's nodejs exist for both,
# and the CPU index of PyTorch has wheels for both.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HANDSCHRIFT_DATA=/data HANDSCHRIFT_PORT=8080 TZ=Europe/Berlin

RUN apt-get update && apt-get install -y --no-install-recommends nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.15.0 \
 && pip install -r server/requirements.txt

# only what the server runs: the hw package (sampling) and the app's page modules
COPY hw/ hw/
COPY web/js/engine/ web/js/engine/
COPY web/js/generate/ web/js/generate/
COPY web/js/capture/ web/js/capture/
COPY server/__init__.py server/__main__.py server/app.py server/config.py server/jobs.py \
     server/keys.py server/model.py server/text.py server/pages.mjs server/

RUN useradd --system --uid 10001 --home-dir /data handschrift \
 && mkdir -p /data && chown handschrift /data
USER handschrift
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=60s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('HANDSCHRIFT_PORT','8080')+'/healthz')"
CMD ["python", "-m", "server"]
