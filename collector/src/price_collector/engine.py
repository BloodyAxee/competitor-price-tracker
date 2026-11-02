import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from typing import Protocol

from .adapters import AdapterRegistry
from .errors import ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError
from .models import CollectionJob, CollectedObservation, JobStatus, JobSummary, SourceTask


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
    ) -> None:
        if max_concurrency < 1:
            raise ValueError("max_concurrency must be positive")
        self._repository = repository
        self._adapters = adapters
        self._sleeper = sleeper
        self._base_backoff_seconds = base_backoff_seconds
        self._max_backoff_seconds = max_backoff_seconds
        self._max_concurrency = max_concurrency
        self._repository_lock = Lock()

    def process_next_job(self, worker_id: str) -> JobSummary | None:
        with self._repository_lock:
            job = self._repository.claim_next_job(worker_id)
        if job is None:
            return None
        return self.process_job(job)

    def process_job(self, job: CollectionJob) -> JobSummary:
        tasks_by_source: dict[str, list[SourceTask]] = {}
        for task in job.tasks:
            tasks_by_source.setdefault(task.source_key.casefold(), []).append(task)

        outcomes: list[str] = []
        if tasks_by_source:
            worker_count = min(self._max_concurrency, len(tasks_by_source))
            with ThreadPoolExecutor(
                max_workers=worker_count,
                thread_name_prefix="collector-source",
            ) as executor:
                futures = [
                    executor.submit(self._process_source_tasks, source_tasks)
                    for source_tasks in tasks_by_source.values()
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

    def _process_source_tasks(self, tasks: list[SourceTask]) -> list[str]:
        return [self._process_task(task) for task in tasks]

    def _process_task(self, task: SourceTask) -> str:
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
            return "skipped"

        total_attempts = task.max_retries + 1
        for attempt_number in range(1, total_attempts + 1):
            with self._repository_lock:
                attempt_id = self._repository.start_attempt(task, attempt_number, adapter.method)
            try:
                observation = adapter.collect(task)
                with self._repository_lock:
                    self._repository.save_observation(task, attempt_id, observation)
                    self._repository.finish_attempt(attempt_id, status="success")
                return "success"
            except ManualFallbackRequired as error:
                self._finish_known_error(attempt_id, "skipped", error)
                return "skipped"
            except PermanentCollectionError as error:
                self._finish_known_error(attempt_id, "failed", error)
                return "failed"
            except RetryableCollectionError as error:
                self._finish_known_error(attempt_id, "failed", error)
                if attempt_number == total_attempts:
                    return "failed"
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
                return "failed"

        return "failed"

    def _finish_known_error(self, attempt_id: int, status: str, error: Exception) -> None:
        with self._repository_lock:
            self._repository.finish_attempt(
                attempt_id,
                status=status,
                http_status=getattr(error, "http_status", None),
                error_code=getattr(error, "code", "collection_error"),
                error_message=str(error)[:1000],
            )
