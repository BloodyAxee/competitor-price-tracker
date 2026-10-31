FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN pip install --no-cache-dir \
        "playwright==1.64.1" \
        "psycopg[binary]==3.3.6" \
    && python -m playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir --no-deps .

RUN useradd --create-home --uid 10001 collector
USER collector

CMD ["price-collector"]
