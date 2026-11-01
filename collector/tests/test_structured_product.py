import unittest
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from price_monitor_domain import Reliability
from price_collector.errors import ManualFallbackRequired, PermanentCollectionError
from price_collector.http import HttpResponse
from price_collector.models import SourceTask
from price_collector.sources.structured_data import identity_tokens
from price_collector.sources.structured_product import StructuredProductAdapter


FIXTURE = Path(__file__).parent / "fixtures" / "structured_competitor_products.html"


class StaticFetcher:
    def __init__(self, html: str) -> None:
        self.html = html

    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        return HttpResponse(200, self.html, {"Content-Type": "text/html"})


def _task(url: str = "https://www.nordberg.ru/catalog/nordberg-4523/") -> SourceTask:
    return SourceTask(
        job_id="00000000-0000-0000-0000-000000000001",
        offer_id="00000000-0000-0000-0000-000000000002",
        source_id="00000000-0000-0000-0000-000000000003",
        source_key="source:nordberg.ru",
        url=url,
        collection_method="http",
        timeout_seconds=20,
        max_retries=2,
        rate_limit_per_host=1,
        expected_product_name="Балансировочный станок NORDBERG 4523 с автовводом",
    )


class StructuredProductAdapterTest(unittest.TestCase):
    def test_identity_tokens_keep_model_suffixes_and_ignore_numeric_ranges(self) -> None:
        self.assertEqual(identity_tokens("NORDBERG 45TRK(B), 14–26"), ("45trkb",))
        self.assertEqual(identity_tokens("Грузовой ES-26D, 14–26"), ("es26d",))

    def test_selects_exact_product_from_graph_and_builds_observation(self) -> None:
        observed_at = datetime(2026, 11, 1, 13, 30, tzinfo=UTC)
        adapter = StructuredProductAdapter(
            StaticFetcher(FIXTURE.read_text(encoding="utf-8")),
            "source:nordberg.ru",
            clock=lambda: observed_at,
        )

        observation = adapter.collect(_task())

        self.assertEqual(observation.price.raw_price, Decimal("189000.00"))
        self.assertEqual(observation.price.reliability, Reliability.RELIABLE)
        self.assertEqual(observation.price.stock_status, "in_stock")
        self.assertEqual(observation.observed_at, observed_at)
        self.assertEqual(observation.evidence["identity_tokens"], ("4523",))

    def test_rejects_url_from_another_domain_before_request(self) -> None:
        adapter = StructuredProductAdapter(StaticFetcher(""), "source:nordberg.ru")

        with self.assertRaisesRegex(PermanentCollectionError, "does not belong"):
            adapter.collect(_task("https://example.org/product"))

    def test_missing_published_price_is_explicit(self) -> None:
        html = FIXTURE.read_text(encoding="utf-8").replace('"price": "189000.00",', "")
        adapter = StructuredProductAdapter(StaticFetcher(html), "source:nordberg.ru")

        with self.assertRaisesRegex(PermanentCollectionError, "price is missing"):
            adapter.collect(_task())

    def test_challenge_page_requires_manual_fallback(self) -> None:
        adapter = StructuredProductAdapter(
            StaticFetcher("<title>Подтвердите, что вы человек</title>"),
            "source:nordberg.ru",
        )

        with self.assertRaises(ManualFallbackRequired):
            adapter.collect(_task())


if __name__ == "__main__":
    unittest.main()
