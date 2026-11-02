import logging
import os
import socket

from .adapters import AdapterRegistry
from .browser import PlaywrightFetcher
from .engine import CollectorEngine
from .http import HostRateLimiter, HttpFetcher
from .repository import PostgresCollectorRepository
from .sources import (
    STRUCTURED_SOURCE_KEYS,
    CentrToAdapter,
    SiToolsT300Adapter,
    StructuredProductAdapter,
)
from .worker import CollectorWorker


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RuntimeError("DATABASE_URL is required")

    user_agent = os.getenv(
        "COLLECTOR_USER_AGENT",
        "CompetitorPriceTracker/0.1 (+price-monitoring-prototype)",
    )
    limiter = HostRateLimiter()
    fetcher = HttpFetcher(user_agent, limiter=limiter)
    browser_fetcher = PlaywrightFetcher(
        user_agent,
        limiter=limiter,
        settle_ms=int(os.getenv("COLLECTOR_BROWSER_SETTLE_MS", "300")),
        storage_state_path=os.getenv("COLLECTOR_BROWSER_STORAGE_STATE") or None,
        verification_retry_hosts=tuple(
            host.strip()
            for host in os.getenv(
                "COLLECTOR_BROWSER_VERIFICATION_RETRY_HOSTS",
                "rustehnika.ru",
            ).split(",")
            if host.strip()
        ),
        verification_retry_seconds=float(
            os.getenv("COLLECTOR_BROWSER_VERIFICATION_RETRY_SECONDS", "3")
        ),
    )
    adapters = AdapterRegistry(
        (
            CentrToAdapter(fetcher, browser_fetcher=browser_fetcher),
            SiToolsT300Adapter(fetcher, browser_fetcher=browser_fetcher),
            *(
                StructuredProductAdapter(fetcher, key, browser_fetcher=browser_fetcher)
                for key in STRUCTURED_SOURCE_KEYS
            ),
        )
    )
    repository = PostgresCollectorRepository(database_url)
    try:
        engine = CollectorEngine(
            repository,
            adapters,
            max_concurrency=int(os.getenv("COLLECTOR_MAX_CONCURRENCY", "4")),
            circuit_breaker_threshold=int(
                os.getenv("COLLECTOR_CIRCUIT_BREAKER_THRESHOLD", "2")
            ),
        )
        worker = CollectorWorker(
            engine,
            os.getenv("COLLECTOR_WORKER_ID", socket.gethostname()),
            poll_seconds=float(os.getenv("COLLECTOR_POLL_SECONDS", "5")),
        )
        if os.getenv("COLLECTOR_RUN_ONCE", "false").casefold() == "true":
            worker.run_once()
        else:
            worker.run_forever()
    finally:
        repository.close()


if __name__ == "__main__":
    main()
