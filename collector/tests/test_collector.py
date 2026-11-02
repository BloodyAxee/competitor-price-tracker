import inspect
import unittest
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal

from price_monitor_domain import MatchStatus, PriceInput, PriceType, evaluate_price
from price_collector.adapters import AdapterRegistry
from price_collector.browser import BrowserDocument, PlaywrightFetcher
from price_collector.engine import CollectorEngine
from price_collector.errors import (
    ManualFallbackRequired,
    PermanentCollectionError,
    RetryableCollectionError,
)
from price_collector.http import HostRateLimiter, HttpFetcher, HttpResponse
from price_collector.models import (
    CollectedObservation,
    CollectionJob,
    JobStatus,
    SourceTask,
)
from price_collector.repository import CLAIM_JOB_SQL, psycopg_database_url


def _task(source_key: str, *, retries: int = 0) -> SourceTask:
    return SourceTask(
        job_id="00000000-0000-0000-0000-000000000001",
        offer_id=f"offer-{source_key}",
        source_id=f"source-{source_key}",
        source_key=source_key,
        url=f"https://{source_key}.example/product",
        collection_method="http",
        timeout_seconds=2,
        max_retries=retries,
        rate_limit_per_host=1,
    )


def _observation(*, unreliable: bool = False) -> CollectedObservation:
    decision = evaluate_price(
        PriceInput(
            Decimal("123000"),
            PriceType.RETAIL,
            is_from_price=unreliable,
        ),
        MatchStatus.EXACT,
    )
    return CollectedObservation(
        price=decision,
        source_quantity=Decimal("1"),
        normalized_quantity=Decimal("1"),
        unit="piece",
        observed_at=datetime.now(UTC),
        evidence_text="123 000 ₽",
        evidence={"selector": "fixture"},
    )


class RecordingLimiter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, float]] = []

    def wait(self, url: str, requests_per_second: float) -> None:
        self.calls.append((url, requests_per_second))


class StubPlaywrightFetcher(PlaywrightFetcher):
    def _fetch_document(self, url: str, *, timeout: float) -> BrowserDocument:
        return BrowserDocument(url, "<html>rendered</html>", 200)


class FakeRepository:
    def __init__(self, job: CollectionJob) -> None:
        self.job = job
        self.claimed = False
        self.attempts: list[dict[str, object]] = []
        self.observations: list[CollectedObservation] = []
        self.summary = None

    def claim_next_job(self, worker_id: str) -> CollectionJob | None:
        if self.claimed:
            return None
        self.claimed = True
        return self.job

    def start_attempt(self, task: SourceTask, attempt_number: int, method: str) -> int:
        self.attempts.append(
            {
                "task": task,
                "number": attempt_number,
                "method": method,
                "status": "running",
            }
        )
        return len(self.attempts)

    def finish_attempt(self, attempt_id: int, **values: object) -> None:
        self.attempts[attempt_id - 1].update(values)

    def save_observation(
        self,
        task: SourceTask,
        attempt_id: int,
        observation: CollectedObservation,
    ) -> None:
        self.observations.append(observation)

    def finish_job(self, job_id: str, summary: object) -> None:
        self.summary = summary


class SequenceAdapter:
    method = "http"

    def __init__(self, key: str, outcomes: list[object]) -> None:
        self.key = key
        self.outcomes = outcomes
        self.calls = 0

    def collect(self, task: SourceTask) -> CollectedObservation:
        outcome = self.outcomes[min(self.calls, len(self.outcomes) - 1)]
        self.calls += 1
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class CollectorEngineTest(unittest.TestCase):
    def test_one_source_failure_does_not_abort_other_sources(self) -> None:
        tasks = (_task("good"), _task("bad"))
        repository = FakeRepository(CollectionJob(tasks[0].job_id, tasks))
        engine = CollectorEngine(
            repository,
            AdapterRegistry(
                (
                    SequenceAdapter("good", [_observation()]),
                    SequenceAdapter(
                        "bad",
                        [PermanentCollectionError("broken fixture", code="parse_error")],
                    ),
                )
            ),
            sleeper=lambda _: None,
        )

        summary = engine.process_next_job("worker-1")

        self.assertEqual(summary.status, JobStatus.PARTIAL_SUCCESS)
        self.assertEqual(summary.succeeded, 1)
        self.assertEqual(summary.failed, 1)
        self.assertEqual(len(repository.observations), 1)

    def test_429_and_500_are_retried_with_bounded_backoff(self) -> None:
        task = _task("temporary", retries=2)
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))
        sleeps: list[float] = []
        adapter = SequenceAdapter(
            "temporary",
            [
                RetryableCollectionError("429", code="temporary_http_error", http_status=429),
                RetryableCollectionError("500", code="temporary_http_error", http_status=500),
                _observation(),
            ],
        )
        engine = CollectorEngine(repository, AdapterRegistry((adapter,)), sleeper=sleeps.append)

        summary = engine.process_job(repository.job)

        self.assertEqual(summary.status, JobStatus.SUCCESS)
        self.assertEqual(adapter.calls, 3)
        self.assertEqual(sleeps, [1.0, 2.0])
        self.assertEqual([attempt["number"] for attempt in repository.attempts], [1, 2, 3])

    def test_retries_are_never_infinite(self) -> None:
        task = _task("timeout", retries=2)
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))
        adapter = SequenceAdapter(
            "timeout",
            [RetryableCollectionError("timeout", code="network_timeout")],
        )
        engine = CollectorEngine(
            repository,
            AdapterRegistry((adapter,)),
            sleeper=lambda _: None,
        )

        summary = engine.process_job(repository.job)

        self.assertEqual(summary.status, JobStatus.FAILED)
        self.assertEqual(adapter.calls, 3)
        self.assertEqual(len(repository.attempts), 3)

    def test_suspicious_price_is_saved_but_not_treated_as_comparable(self) -> None:
        task = _task("wrong-price")
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))
        engine = CollectorEngine(
            repository,
            AdapterRegistry((SequenceAdapter("wrong-price", [_observation(unreliable=True)]),)),
        )

        summary = engine.process_job(repository.job)

        self.assertEqual(summary.status, JobStatus.SUCCESS)
        self.assertFalse(repository.observations[0].price.eligible_for_comparison)
        self.assertEqual(repository.observations[0].price.exclusion_reason, "price_from")

    def test_human_verification_uses_manual_fallback_without_retry(self) -> None:
        task = _task("protected", retries=3)
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))
        adapter = SequenceAdapter(
            "protected",
            [ManualFallbackRequired("captcha", code="human_verification_required")],
        )
        engine = CollectorEngine(repository, AdapterRegistry((adapter,)))

        summary = engine.process_job(repository.job)

        self.assertEqual(summary.status, JobStatus.FAILED)
        self.assertEqual(summary.skipped, 1)
        self.assertEqual(adapter.calls, 1)
        self.assertEqual(repository.attempts[0]["status"], "skipped")

    def test_missing_adapter_is_explicitly_skipped(self) -> None:
        task = _task("not-implemented")
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))

        summary = CollectorEngine(repository, AdapterRegistry()).process_job(repository.job)

        self.assertEqual(summary.skipped, 1)
        self.assertEqual(repository.attempts[0]["error_code"], "adapter_not_registered")


class FakeTransport:
    def __init__(self, response: HttpResponse) -> None:
        self.response = response
        self.headers = None

    def request(self, url: str, headers: object, timeout: float) -> HttpResponse:
        self.headers = headers
        return self.response


class FetcherTest(unittest.TestCase):
    def test_http_client_sends_identifiable_user_agent(self) -> None:
        transport = FakeTransport(HttpResponse(200, "ok", {}))
        fetcher = HttpFetcher(
            "CompetitorPriceTracker/0.1",
            transport=transport,
            limiter=HostRateLimiter(),
        )

        response = fetcher.fetch("https://example.com", timeout=2, rate_limit_per_host=1)

        self.assertEqual(response.text, "ok")
        self.assertEqual(transport.headers["User-Agent"], "CompetitorPriceTracker/0.1")

    def test_http_statuses_are_classified(self) -> None:
        cases = (
            (429, RetryableCollectionError),
            (500, RetryableCollectionError),
            (403, ManualFallbackRequired),
            (404, PermanentCollectionError),
        )
        for status, expected_error in cases:
            with self.subTest(status=status):
                fetcher = HttpFetcher(
                    "CompetitorPriceTracker/0.1",
                    transport=FakeTransport(HttpResponse(status, "", {})),
                )
                with self.assertRaises(expected_error):
                    fetcher.fetch("https://example.com", timeout=2, rate_limit_per_host=1000)

    def test_host_rate_limit_waits_between_requests(self) -> None:
        now = [0.0]
        sleeps: list[float] = []

        def sleep(seconds: float) -> None:
            sleeps.append(seconds)
            now[0] += seconds

        limiter = HostRateLimiter(clock=lambda: now[0], sleeper=sleep)
        limiter.wait("https://example.com/a", 0.5)
        limiter.wait("https://example.com/b", 0.5)

        self.assertEqual(sleeps, [2.0])

    def test_playwright_never_bypasses_human_verification(self) -> None:
        with self.assertRaises(ManualFallbackRequired):
            PlaywrightFetcher.assert_not_protected("<title>Verify you are human</title>")

    def test_playwright_uses_the_same_per_host_rate_limit_contract(self) -> None:
        limiter = RecordingLimiter()
        fetcher = StubPlaywrightFetcher("CompetitorPriceTracker/0.1", limiter=limiter)

        document = fetcher.fetch(
            "https://example.com/product",
            timeout=2,
            rate_limit_per_host=0.5,
        )

        self.assertEqual(document.status_code, 200)
        self.assertEqual(limiter.calls, [("https://example.com/product", 0.5)])

    def test_job_claim_uses_skip_locked(self) -> None:
        normalized_sql = " ".join(CLAIM_JOB_SQL.split()).upper()
        self.assertIn("FOR UPDATE SKIP LOCKED", normalized_sql)

    def test_job_collects_exact_and_review_offers(self) -> None:
        from price_collector.repository import PostgresCollectorRepository

        source = inspect.getsource(PostgresCollectorRepository.claim_next_job)
        normalized_sql = " ".join(source.split()).upper()
        self.assertIn("O.MATCH_STATUS IN ('EXACT', 'REVIEW')", normalized_sql)

    def test_prisma_schema_parameter_is_removed_for_psycopg(self) -> None:
        original = "postgresql://db:5432/database?schema=public&sslmode=require"
        normalized = psycopg_database_url(original)
        self.assertEqual(
            normalized,
            "postgresql://db:5432/database?sslmode=require",
        )


if __name__ == "__main__":
    unittest.main()
