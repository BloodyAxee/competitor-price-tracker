from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

from price_monitor_domain import PriceDecision


class JobStatus(StrEnum):
    SUCCESS = "success"
    PARTIAL_SUCCESS = "partial_success"
    FAILED = "failed"


@dataclass(frozen=True)
class SourceTask:
    job_id: str
    offer_id: str
    source_id: str
    source_key: str
    url: str
    collection_method: str
    timeout_seconds: float
    max_retries: int
    rate_limit_per_host: float


@dataclass(frozen=True)
class CollectionJob:
    id: str
    tasks: tuple[SourceTask, ...]


@dataclass(frozen=True)
class CollectedObservation:
    price: PriceDecision
    source_quantity: Decimal | None
    normalized_quantity: Decimal | None
    unit: str | None
    observed_at: datetime | None
    evidence_text: str | None
    evidence: dict[str, Any]
    source_payload_hash: str | None = None
    collector_version: str = "0.1.0"


@dataclass(frozen=True)
class JobSummary:
    status: JobStatus
    total: int
    succeeded: int
    failed: int
    skipped: int

    def as_dict(self) -> dict[str, int | str]:
        return {
            "status": self.status.value,
            "total": self.total,
            "succeeded": self.succeeded,
            "failed": self.failed,
            "skipped": self.skipped,
        }
