import json
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from price_monitor_domain import Reliability

from .models import CollectionJob, CollectedObservation, JobSummary, SourceTask


CLAIM_JOB_SQL = """
SELECT id::text
FROM collection_jobs
WHERE status = 'pending'
  AND (scheduled_for IS NULL OR scheduled_for <= clock_timestamp())
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1
"""


def psycopg_database_url(database_url: str) -> str:
    parts = urlsplit(database_url)
    query = [(key, value) for key, value in parse_qsl(parts.query) if key != "schema"]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


class PostgresCollectorRepository:
    def __init__(self, database_url: str) -> None:
        import psycopg
        from psycopg.rows import dict_row

        self._connection = psycopg.connect(psycopg_database_url(database_url), row_factory=dict_row)

    def close(self) -> None:
        self._connection.close()

    def claim_next_job(self, worker_id: str) -> CollectionJob | None:
        with self._connection.transaction():
            job_row = self._connection.execute(CLAIM_JOB_SQL).fetchone()
            if job_row is None:
                return None

            job_id = job_row["id"]
            self._connection.execute(
                """
                UPDATE collection_jobs
                SET status = 'running',
                    started_at = clock_timestamp(),
                    locked_at = clock_timestamp(),
                    locked_by = %s
                WHERE id = %s::uuid
                """,
                (worker_id, job_id),
            )
            rows = self._connection.execute(
                """
                SELECT
                    %s::text AS job_id,
                    o.id::text AS offer_id,
                    s.id::text AS source_id,
                    s.external_key AS source_key,
                    o.competitor_url AS url,
                    s.collection_method,
                    s.request_timeout_seconds,
                    s.max_retries,
                    s.rate_limit_per_host,
                    p.name AS expected_product_name,
                    o.seller_article
                FROM offers o
                JOIN sources s ON s.id = o.source_id
                JOIN products p ON p.id = o.product_id
                WHERE o.is_active
                  AND s.is_active
                  AND o.match_status = 'exact'
                ORDER BY s.external_key, o.id
                """,
                (job_id,),
            ).fetchall()

        tasks = tuple(self._task_from_row(row) for row in rows)
        return CollectionJob(job_id, tasks)

    @staticmethod
    def _task_from_row(row: dict[str, Any]) -> SourceTask:
        return SourceTask(
            job_id=row["job_id"],
            offer_id=row["offer_id"],
            source_id=row["source_id"],
            source_key=row["source_key"],
            url=row["url"],
            collection_method=row["collection_method"],
            timeout_seconds=float(row["request_timeout_seconds"]),
            max_retries=int(row["max_retries"]),
            rate_limit_per_host=float(row["rate_limit_per_host"]),
            expected_product_name=row["expected_product_name"],
            seller_article=row["seller_article"],
        )

    def start_attempt(self, task: SourceTask, attempt_number: int, method: str) -> int:
        with self._connection.transaction():
            row = self._connection.execute(
                """
                INSERT INTO collection_attempts (
                    job_id, source_id, offer_id, attempt_number, method, status, started_at
                ) VALUES (%s::uuid, %s::uuid, %s::uuid, %s, %s, 'running', clock_timestamp())
                RETURNING id
                """,
                (task.job_id, task.source_id, task.offer_id, attempt_number, method),
            ).fetchone()
        return int(row["id"])

    def finish_attempt(
        self,
        attempt_id: int,
        *,
        status: str,
        http_status: int | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None:
        with self._connection.transaction():
            self._connection.execute(
                """
                UPDATE collection_attempts
                SET status = %s,
                    http_status = %s,
                    error_code = %s,
                    error_message = %s,
                    finished_at = clock_timestamp()
                WHERE id = %s
                """,
                (status, http_status, error_code, error_message, attempt_id),
            )

    def save_observation(
        self,
        task: SourceTask,
        attempt_id: int,
        observation: CollectedObservation,
    ) -> None:
        price = observation.price
        database_reliability = "valid" if price.reliability is Reliability.RELIABLE else price.reliability.value
        with self._connection.transaction():
            self._connection.execute(
                """
                INSERT INTO price_observations (
                    job_id, attempt_id, offer_id, raw_price, normalized_price, currency,
                    source_quantity, normalized_quantity, unit, price_type, vat_included,
                    stock_status, region, delivery_included, installation_included,
                    observed_at, method, reliability, exclusion_reason, evidence_text,
                    evidence_json, collector_version, source_payload_hash
                ) VALUES (
                    %s::uuid, %s, %s::uuid, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s, %s, %s, %s,
                    %s, %s, %s, %s, %s,
                    %s::jsonb, %s, %s
                )
                """,
                (
                    task.job_id,
                    attempt_id,
                    task.offer_id,
                    price.raw_price,
                    price.normalized_price,
                    price.currency,
                    observation.source_quantity,
                    observation.normalized_quantity,
                    observation.unit,
                    price.price_type.value,
                    price.vat_included,
                    price.stock_status,
                    price.region,
                    price.delivery_included,
                    price.installation_included,
                    observation.observed_at,
                    price.method.value,
                    database_reliability,
                    price.exclusion_reason,
                    observation.evidence_text,
                    json.dumps(observation.evidence, ensure_ascii=False),
                    observation.collector_version,
                    observation.source_payload_hash,
                ),
            )

    def finish_job(self, job_id: str, summary: JobSummary) -> None:
        with self._connection.transaction():
            self._connection.execute(
                """
                UPDATE collection_jobs
                SET status = %s,
                    summary = %s::jsonb,
                    finished_at = clock_timestamp(),
                    locked_at = NULL,
                    locked_by = NULL
                WHERE id = %s::uuid
                """,
                (summary.status.value, json.dumps(summary.as_dict()), job_id),
            )
