FROM python:3.13-slim

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN pip install "psycopg[binary]==3.3.6"

COPY smoke.py /tests/python/smoke.py

ENTRYPOINT ["python", "/tests/python/smoke.py"]
