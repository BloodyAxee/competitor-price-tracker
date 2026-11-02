import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from threading import Lock
from typing import Protocol
from urllib.parse import urlsplit

from .adapters import AdapterRegistry
from .errors import ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError
from .models import CollectionJob, CollectedObservation, JobStatus, JobSummary, SourceTask


_RETRYABLE_CIRCUIT_ERRORS = frozenset(
    {
        "browser_error",
        "browser_timeout",
        "network_error",
        "temporary_http_error",
    }
)


@dataclass(frozen=True)
class _TaskOutcome:
    status: str
    error_code: str | None = None
    opens_circuit: bool = False


class CollectorRepository(Protocol):
    def claim_next_job(self, worker_id: str) -> CollectionJob | None: ...

    def start_attempt(self, task: SourceTask, attempt_number: int, method: str) -> int: ...

    def finish_attempt(
        self,
        attempt_id: int,
        *,
        status: str,
        http_status: int | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> None: ...

    def save_observation(
        self,
        task: SourceTask,
        attempt_id: int,
        observation: CollectedObservation,
    ) -> None: ...

    def finish_job(self, job_id: str, summary: JobSummary) -> None: ...


class CollectorEngine:
    def __init__(
        self,
        repository: CollectorRepository,
        adapters: AdapterRegistry,
        *,
        sleeper=time.sleep,
        base_backoff_seconds: float = 1.0,
        max_backoff_seconds: float = 30.0,
        max_concurrency: int = 4,
        circuit_breaker_threshold: int = 2,
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        if circuit_breaker_threshold < 1:
            raise ValueError("circuit_breaker_threshold must be positive")
        self._repository = repository
        self._adapters = adapters
        self._sleeper = sleeper
        self._base_backoff_seconds = base_backoff_seconds
        self._max_backoff_seconds = max_backoff_seconds
        self._max_concurrency = max_concurrency
        self._circuit_breaker_threshold = circuit_breaker_threshold
        self._repository_lock = Lock()

    def process_next_job(self, worker_id: str) -> JobSummary | None:
        with self._repository_lock:
            job = self._repository.claim_next_job(worker_id)
        if job is None:
            return None
        return self.process_job(job)

    def process_job(self, job: CollectionJob) -> JobSummary:
        tasks_by_host: dict[str, list[SourceTask]] = {}
        for task in job.tasks:
            host = urlsplit(task.url).hostname
            host_key = host.casefold() if host else task.source_key.casefold()
            tasks_by_host.setdefault(host_key, []).append(task)

        outcomes: list[str] = []
        if tasks_by_host:
            worker_count = min(self._max_concurrency, len(tasks_by_host))
            with ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="collector-source",
            ) as executor:
                futures = [
                    executor.submit(self._process_host_tasks, host_tasks)
                    for host_tasks in tasks_by_host.values()
                ]
                for future in futures:
                    outcomes.extend(future.result())

        succeeded = outcomes.count("success")
        failed = outcomes.count("failed")
        skipped = outcomes.count("skipped")

        if failed == 0 and skipped == 0:
            status = JobStatus.SUCCESS
        elif succeeded > 0:
            status = JobStatus.PARTIAL_SUCCESS
        else:
            status = JobStatus.FAILED

        summary = JobSummary(status, len(job.tasks), succeeded, failed, skipped)
        with self._repository_lock:
            self._repository.finish_job(job.id, summary)
        return summary

    def _process_host_tasks(self, tasks: list[SourceTask]) -> list[str]:
        outcomes: list[str] = []
        repeated_error_code: str | None = None
        repeated_error_count = 0
        circuit_error_code: str | None = None

        for task in tasks:
            if circuit_error_code is not None:
                self._record_circuit_breaker_skip(task, circuit_error_code)
                outcomes.append("skipped")
                continue

            outcome = self._process_task(task)
            outcomes.append(outcome.status)
            if not outcome.opens_circuit or outcome.error_code is None:
                repeated_error_code = None
                repeated_error_count = 0
                continue

            if outcome.error_code == repeated_error_code:
                repeated_error_count += 1
            else:
                repeated_error_code = outcome.error_code
                repeated_error_count = 1
            if repeated_error_count >= self._circuit_breaker_threshold:
                circuit_error_code = outcome.error_code

        return outcomes

    def _process_task(self, task: SourceTask) -> _TaskOutcome:
        adapter = self._adapters.get(task.source_key)
        if adapter is None:
            with self._repository_lock:
                attempt_id = self._repository.start_attempt(task, 1, task.collection_method)
                self._repository.finish_attempt(
                    attempt_id,
                    status="skipped",
                    error_code="adapter_not_registered",
                    error_message="No adapter is registered for this source",
                )
            return _TaskOutcome("skipped")

        total_attempts = task.max_retries + 1
        for attempt_number in range(1, total_attempts + 1):
            with self._repository_lock:
                attempt_id = self._repository.start_attempt(task, attempt_number, adapter.method)
            try:
                observation = adapter.collect(task)
                with self._repository_lock:
                    self._repository.save_observation(task, attempt_id, observation)
                    self._repository.finish_attempt(attempt_id, status="success")
                return _TaskOutcome("success")
            except ManualFallbackRequired as error:
                self._finish_known_error(attempt_id, "skipped", error)
                return _TaskOutcome("skipped")
            except PermanentCollectionError as error:
                self._finish_known_error(attempt_id, "failed", error)
                return _TaskOutcome("failed", getattr(error, "code", None))
            except RetryableCollectionError as error:
                self._finish_known_error(attempt_id, "failed", error)
                if attempt_number == total_attempts:
                    error_code = getattr(error, "code", None)
                    return _TaskOutcome(
                        "failed",
                        error_code,
                        error_code in _RETRYABLE_CIRCUIT_ERRORS,
                    )
                delay = min(
                    self._base_backoff_seconds * (2 ** (attempt_number - 1)),
                    self._max_backoff_seconds,
                )
                self._sleeper(delay)
            except Exception as error:
                with self._repository_lock:
                    self._repository.finish_attempt(
                        attempt_id,
                        status="failed",
                        error_code="unexpected_error",
                        error_message=str(error)[:1000],
                    )
                return _TaskOutcome("failed", "unexpected_error")

        return _TaskOutcome("failed")

    def _record_circuit_breaker_skip(self, task: SourceTask, cause_code: str) -> None:
        adapter = self._adapters.get(task.source_key)
        method = adapter.method if adapter is not None else task.collection_method
        with self._repository_lock:
            attempt_id = self._repository.start_attempt(task, 1, method)
            self._repository.finish_attempt(
                attempt_id,
                status="skipped",
                error_code="circuit_breaker_open",
                error_message=(
                    "Host skipped after repeated retryable failures "
                    f"with error code {cause_code}"
                ),
            )

    def _finish_known_error(self, attempt_id: int, status: str, error: Exception) -> None:
        with self._repository_lock:
            self._repository.finish_attempt(
                attempt_id,
                status=status,
                http_status=getattr(error, "http_status", None),
                error_code=getattr(error, "code", "collection_error"),
                error_message=str(error)[:1000],
            )
