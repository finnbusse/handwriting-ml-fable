# The trainer Space (Docker, free "CPU basic": 2 vCPU, 16 GB RAM). Built by
# Hugging Face from the files scripts/deploy_trainer.py uploads; this file ends
# up as /Dockerfile there, next to hw/, scripts/, data/quality/ and trainer/.
FROM python:3.12-slim

RUN useradd -m -u 1000 user
USER user
ENV HOME=/home/user PATH=/home/user/.local/bin:$PATH PYTHONUNBUFFERED=1
WORKDIR /home/user/app

COPY --chown=user requirements.txt ./requirements.txt
COPY --chown=user trainer/requirements.txt ./trainer-requirements.txt
RUN pip install --no-cache-dir --user torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir --user -r requirements.txt -r trainer-requirements.txt

COPY --chown=user . .
# The pretrained weights, fetched once at build time (checked by checksum); otherwise the first run fetches them.
RUN python -c "from hw.base import ensure_base; ensure_base('artifacts/base')" \
 || echo "base weights not fetched now; the first run will fetch them"

EXPOSE 7860
CMD ["uvicorn", "trainer.app:app", "--host", "0.0.0.0", "--port", "7860"]
