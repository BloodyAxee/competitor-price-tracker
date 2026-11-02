import time
import unittest
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from threading import Event, Lock

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
    CollectionMode,
    JobStatus,
    SourceTask,
)
from price_collector.repository import CLAIM_JOB_SQL, COLLECT_TASKS_SQL, psycopg_database_url


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


class SignalingAdapter:
    method = "http"

    def __init__(
        self,
        key: str,
        *,
        entered: Event | None = None,
        release: Event | None = None,
        finished: Event | None = None,
    ) -> None:
        self.key = key
        self.entered = entered
        self.release = release
        self.finished = finished

    def collect(self, task: SourceTask) -> CollectedObservation:
        if self.entered is not None:
            self.entered.set()
        if self.release is not None and not self.release.wait(2):
            raise AssertionError("Timed out waiting to release test adapter")
        if self.finished is not None:
            self.finished.set()
        return _observation()


class SameSourceBlockingAdapter:
    method = "http"

    def __init__(self, key: str) -> None:
        self.key = key
        self.first_started = Event()
        self.second_started = Event()
        self.release_first = Event()
        self.calls = 0
        self.max_active = 0
        self._active = 0
        self._lock = Lock()

    def collect(self, task: SourceTask) -> CollectedObservation:
        with self._lock:
            self.calls += 1
            call_number = self.calls
            self._active += 1
            self.max_active = max(self.max_active, self._active)
        try:
            if call_number == 1:
                self.first_started.set()
                if not self.release_first.wait(2):
                    raise AssertionError("Timed out waiting to release first same-source task")
            else:
                self.second_started.set()
            return _observation()
        finally:
            with self._lock:
                self._active -= 1


class ConcurrencyTracker:
    def __init__(self, expected_initial: int) -> None:
        self.expected_initial = expected_initial
        self.started = 0
        self.active = 0
        self.max_active = 0
        self.initial_batch_started = Event()
        self.release = Event()
        self.lock = Lock()


class TrackedAdapter:
    method = "http"

    def __init__(self, key: str, tracker: ConcurrencyTracker) -> None:
        self.key = key
        self.tracker = tracker

    def collect(self, task: SourceTask) -> CollectedObservation:
        with self.tracker.lock:
            self.tracker.started += 1
            self.tracker.active += 1
            self.tracker.max_active = max(self.tracker.max_active, self.tracker.active)
            if self.tracker.started == self.tracker.expected_initial:
                self.tracker.initial_batch_started.set()
        try:
            if not self.tracker.release.wait(2):
                raise AssertionError("Timed out waiting to release concurrent adapters")
            return _observation()
        finally:
            with self.tracker.lock:
                self.tracker.active -= 1


class RepositoryConcurrencyProbe(FakeRepository):
    def __init__(self, job: CollectionJob) -> None:
        super().__init__(job)
        self.max_active_calls = 0
        self._active_calls = 0
        self._probe_lock = Lock()

    def _call(self, callback: Callable[[], object]) -> object:
        with self._probe_lock:
            self._active_calls += 1
            self.max_active_calls = max(self.max_active_calls, self._active_calls)
        try:
            time.sleep(0.003)
            return callback()
        finally:
            with self._probe_lock:
                self._active_calls -= 1

    def start_attempt(self, task: SourceTask, attempt_number: int, method: str) -> int:
        attempt_id = self._call(
            lambda: FakeRepository.start_attempt(self, task, attempt_number, method)
        )
        if not isinstance(attempt_id, int):
            raise AssertionError("Fake repository returned a non-integer attempt id")
        return attempt_id

    def finish_attempt(self, attempt_id: int, **values: object) -> None:
        self._call(lambda: FakeRepository.finish_attempt(self, attempt_id, **values))

    def save_observation(
        self,
        task: SourceTask,
        attempt_id: int,
        observation: CollectedObservation,
    ) -> None:
        self._call(
            lambda: FakeRepository.save_observation(self, task, attempt_id, observation)
        )

    def finish_job(self, job_id: str, summary: object) -> None:
        self._call(lambda: FakeRepository.finish_job(self, job_id, summary))


class CollectorEngineTest(unittest.TestCase):
    def test_slow_source_does_not_block_independent_source(self) -> None:
        tasks = (_task("slow"), _task("fast"))
        job = CollectionJob(tasks[0].job_id, tasks)
        repository = FakeRepository(job)
        slow_started = Event()
        release_slow = Event()
        fast_finished = Event()
        engine = CollectorEngine(
            repository,
            AdapterRegistry(
                (
                    SignalingAdapter("slow", entered=slow_started, release=release_slow),
                    SignalingAdapter("fast", finished=fast_finished),
                )
            ),
            max_concurrency=2,
        )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(engine.process_job, job)
            self.assertTrue(slow_started.wait(1))
            self.assertTrue(fast_finished.wait(1))
            release_slow.set()
            summary = future.result(timeout=2)

        self.assertEqual(summary.status, JobStatus.SUCCESS)
        self.assertEqual(summary.succeeded, 2)

    def test_tasks_from_same_source_are_never_concurrent(self) -> None:
        tasks = (_task("same-host"), _task("same-host"))
        job = CollectionJob(tasks[0].job_id, tasks)
        repository = FakeRepository(job)
        adapter = SameSourceBlockingAdapter("same-host")
        engine = CollectorEngine(
            repository,
            AdapterRegistry((adapter,)),
            max_concurrency=4,
        )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(engine.process_job, job)
            self.assertTrue(adapter.first_started.wait(1))
            self.assertFalse(adapter.second_started.wait(0.1))
            adapter.release_first.set()
            summary = future.result(timeout=2)

        self.assertEqual(summary.succeeded, 2)
        self.assertEqual(adapter.calls, 2)
        self.assertEqual(adapter.max_active, 1)

    def test_concurrency_is_bounded_by_configured_limit(self) -> None:
        tasks = tuple(_task(f"source-{index}") for index in range(6))
        job = CollectionJob(tasks[0].job_id, tasks)
        repository = FakeRepository(job)
        tracker = ConcurrencyTracker(expected_initial=4)
        adapters = tuple(TrackedAdapter(task.source_key, tracker) for task in tasks)
        engine = CollectorEngine(
            repository,
            AdapterRegistry(adapters),
            max_concurrency=4,
        )

        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(engine.process_job, job)
            self.assertTrue(tracker.initial_batch_started.wait(1))
            with tracker.lock:
                self.assertEqual(tracker.started, 4)
                self.assertEqual(tracker.max_active, 4)
            tracker.release.set()
            summary = future.result(timeout=2)

        self.assertEqual(summary.succeeded, 6)
        self.assertEqual(tracker.max_active, 4)

    def test_repository_writes_remain_serialized(self) -> None:
        tasks = tuple(_task(f"source-{index}") for index in range(4))
        job = CollectionJob(tasks[0].job_id, tasks)
        repository = RepositoryConcurrencyProbe(job)
        adapters = tuple(SignalingAdapter(task.source_key) for task in tasks)

        summary = CollectorEngine(
            repository,
            AdapterRegistry(adapters),
            max_concurrency=4,
        ).process_job(job)

        self.assertEqual(summary.succeeded, 4)
        self.assertEqual(len(repository.attempts), 4)
        self.assertEqual(len(repository.observations), 4)
        self.assertEqual(repository.max_active_calls, 1)

    def test_concurrency_must_be_positive(self) -> None:
        task = _task("invalid-concurrency")
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))

        with self.assertRaisesRegex(ValueError, "max_concurrency must be positive"):
            CollectorEngine(repository, AdapterRegistry(), max_concurrency=0)

    def test_circuit_breaker_threshold_must_be_positive(self) -> None:
        task = _task("invalid-circuit-threshold")
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))

        with self.assertRaisesRegex(ValueError, "circuit_breaker_threshold must be positive"):
            CollectorEngine(
                repository,
                AdapterRegistry(),
                circuit_breaker_threshold=0,
            )

    def test_offer_in_active_cooldown_is_explicitly_skipped(self) -> None:
        task = replace(
            _task("cooling-down"),
            cooldown_until=datetime.now(UTC) + timedelta(hours=1),
        )
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))
        adapter = SequenceAdapter(task.source_key, [_observation()])

        summary = CollectorEngine(
            repository,
            AdapterRegistry((adapter,)),
        ).process_job(repository.job)

        self.assertEqual(summary.skipped, 1)
        self.assertEqual(adapter.calls, 0)
        self.assertEqual(repository.attempts[0]["error_code"], "source_cooldown")

    def test_expired_offer_cooldown_does_not_block_collection(self) -> None:
        task = replace(
            _task("cooled-down"),
            cooldown_until=datetime.now(UTC) - timedelta(seconds=1),
        )
        repository = FakeRepository(CollectionJob(task.job_id, (task,)))
        adapter = SequenceAdapter(task.source_key, [_observation()])

        summary = CollectorEngine(
            repository,
            AdapterRegistry((adapter,)),
        ).process_job(repository.job)

        self.assertEqual(summary.succeeded, 1)
        self.assertEqual(adapter.calls, 1)

    def test_repeated_retryable_host_failure_opens_circuit_for_remaining_tasks(self) -> None:
        tasks = tuple(
            replace(
                _task(f"unstable-{index}"),
                url=f"https://unstable.example/product-{index}",
            )
            for index in range(4)
        )
        repository = FakeRepository(CollectionJob(tasks[0].job_id, tasks))
        adapters = tuple(
            SequenceAdapter(
                task.source_key,
                [RetryableCollectionError("timeout", code="browser_timeout")],
            )
            for task in tasks
        )

        summary = CollectorEngine(
            repository,
            AdapterRegistry(adapters),
            sleeper=lambda _: None,
            circuit_breaker_threshold=2,
        ).process_job(repository.job)

        self.assertEqual(summary.failed, 2)
        self.assertEqual(summary.skipped, 2)
        self.assertEqual([adapter.calls for adapter in adapters], [1, 1, 0, 0])
        self.assertEqual(
            [attempt.get("error_code") for attempt in repository.attempts],
            [
                "browser_timeout",
                "browser_timeout",
                "circuit_breaker_open",
                "circuit_breaker_open",
            ],
        )

    def test_success_resets_repeated_failure_count_for_host(self) -> None:
        tasks = tuple(
            replace(
                _task(f"recovering-{index}"),
                url=f"https://recovering.example/product-{index}",
            )
            for index in range(4)
        )
        adapters = (
            SequenceAdapter(
                tasks[0].source_key,
                [RetryableCollectionError("timeout", code="browser_timeout")],
            ),
            SequenceAdapter(tasks[1].source_key, [_observation()]),
            SequenceAdapter(
                tasks[2].source_key,
                [RetryableCollectionError("timeout", code="browser_timeout")],
            ),
            SequenceAdapter(tasks[3].source_key, [_observation()]),
        )
        repository = FakeRepository(CollectionJob(tasks[0].job_id, tasks))

        summary = CollectorEngine(
            repository,
            AdapterRegistry(adapters),
            sleeper=lambda _: None,
            circuit_breaker_threshold=2,
        ).process_job(repository.job)

        self.assertEqual(summary.succeeded, 2)
        self.assertEqual(summary.failed, 2)
        self.assertEqual(summary.skipped, 0)
        self.assertEqual([adapter.calls for adapter in adapters], [1, 1, 1, 1])

    def test_permanent_failures_do_not_open_host_circuit(self) -> None:
        tasks = tuple(
            replace(
                _task(f"invalid-{index}"),
                url=f"https://invalid.example/product-{index}",
            )
            for index in range(3)
        )
        adapters = tuple(
            SequenceAdapter(
                task.source_key,
                [PermanentCollectionError("invalid", code="missing_price")],
            )
            for task in tasks
        )
        repository = FakeRepository(CollectionJob(tasks[0].job_id, tasks))

        summary = CollectorEngine(
            repository,
            AdapterRegistry(adapters),
            circuit_breaker_threshold=2,
        ).process_job(repository.job)

        self.assertEqual(summary.failed, 3)
        self.assertEqual(summary.skipped, 0)
        self.assertEqual([adapter.calls for adapter in adapters], [1, 1, 1])

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

    def test_waiting_host_does_not_block_an_independent_host(self) -> None:
        now = [0.0]
        clock_lock = Lock()
        sleep_started = Event()
        release_sleep = Event()

        def clock() -> float:
            with clock_lock:
                return now[0]

        def sleep(seconds: float) -> None:
            sleep_started.set()
            if not release_sleep.wait(2):
                raise AssertionError("Timed out waiting to release rate-limit sleep")
            with clock_lock:
                now[0] += seconds

        limiter = HostRateLimiter(clock=clock, sleeper=sleep)
        limiter.wait("https://slow.example/a", 0.5)

        with ThreadPoolExecutor(max_workers=2) as executor:
            slow_future = executor.submit(limiter.wait, "https://slow.example/b", 0.5)
            self.assertTrue(sleep_started.wait(1))
            fast_future = executor.submit(limiter.wait, "https://fast.example/a", 0.5)
            fast_future.result(timeout=1)
            release_sleep.set()
            slow_future.result(timeout=2)

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
        self.assertIn("COLLECTION_MODE", normalized_sql)

    def test_job_collects_exact_comparable_and_review_offers(self) -> None:
        normalized_sql = " ".join(COLLECT_TASKS_SQL.split()).upper()
        self.assertIn("O.MATCH_STATUS IN ('EXACT', 'COMPARABLE', 'REVIEW')", normalized_sql)

    def test_fast_jobs_only_select_explicit_fast_offers(self) -> None:
        normalized_sql = " ".join(COLLECT_TASKS_SQL.split()).upper()
        self.assertIn("%S = 'FULL' OR O.COLLECT_IN_FAST_MODE", normalized_sql)
        self.assertEqual(CollectionJob("job", (), CollectionMode.FAST).mode, CollectionMode.FAST)

    def test_prisma_schema_parameter_is_removed_for_psycopg(self) -> None:
        original = "postgresql://db:5432/database?schema=public&sslmode=require"
        normalized = psycopg_database_url(original)
        self.assertEqual(
            normalized,
            "postgresql://db:5432/database?sslmode=require",
        )


if __name__ == "__main__":
    unittest.main()
