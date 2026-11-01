import logging
import os
import socket

from .adapters import AdapterRegistry
from .browser import PlaywrightFetcher
from .engine import CollectorEngine
from .http import HttpFetcher
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
    fetcher = HttpFetcher(user_agent)
    browser_fetcher = PlaywrightFetcher(user_agent)
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
        engine = CollectorEngine(repository, adapters)
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
