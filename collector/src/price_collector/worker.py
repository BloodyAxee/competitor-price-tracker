import logging
import time
from threading import Event

from .engine import CollectorEngine


class CollectorWorker:
    def __init__(
        self,
        engine: CollectorEngine,
        worker_id: str,
        *,
        poll_seconds: float = 5.0,
        stop_event: Event | None = None,
    ) -> None:
        self._engine = engine
        self._worker_id = worker_id
        self._poll_seconds = poll_seconds
        self._stop_event = stop_event or Event()
        self._logger = logging.getLogger(__name__)

    def run_once(self) -> bool:
        summary = self._engine.process_next_job(self._worker_id)
        if summary is None:
            return False
        self._logger.info(
            "Collection job finished status=%s succeeded=%s failed=%s skipped=%s",
            summary.status.value,
            summary.succeeded,
            summary.failed,
            summary.skipped,
        )
        return True

    def run_forever(self) -> None:
        self._logger.info("Collector worker started worker_id=%s", self._worker_id)
        while not self._stop_event.is_set():
            processed = self.run_once()
            if not processed:
                self._stop_event.wait(self._poll_seconds)
