import unittest
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from price_monitor_domain import Reliability
from price_collector.errors import (
    ManualFallbackRequired,
    PermanentCollectionError,
    RetryableCollectionError,
)
from price_collector.browser import BrowserDocument
from price_collector.http import HttpResponse
from price_collector.models import SourceTask
from price_collector.sources.structured_data import identity_tokens, parse_microdata_product
from price_collector.sources.structured_product import StructuredProductAdapter


FIXTURE = Path(__file__).parent / "fixtures" / "structured_competitor_products.html"
MICRODATA_FIXTURE = Path(__file__).parent / "fixtures" / "topmaster_microdata.html"


class StaticFetcher:
    def __init__(self, html: str) -> None:
        self.html = html

    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        return HttpResponse(200, self.html, {"Content-Type": "text/html"})


class StaticBrowserFetcher:
    def __init__(self, html: str) -> None:
        self.html = html
        self.calls = 0

    def fetch(
        self,
        url: str,
        *,
        timeout: float,
        rate_limit_per_host: float,
    ) -> BrowserDocument:
        self.calls += 1
        return BrowserDocument(url, self.html, 200)


class NetworkFailingFetcher:
    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        raise RetryableCollectionError("TLS handshake timed out", code="network_error")


class RateLimitedFetcher:
    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        raise RetryableCollectionError("HTTP 429", code="temporary_http_error", http_status=429)


def _task(
    url: str = "https://www.nordberg.ru/catalog/nordberg-4523/",
    *,
    match_status: str = "exact",
) -> SourceTask:
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
        match_status=match_status,
    )


class StructuredProductAdapterTest(unittest.TestCase):
    def test_microdata_selects_exact_product_and_ignores_recommendation(self) -> None:
        product = parse_microdata_product(
            MICRODATA_FIXTURE.read_text(encoding="utf-8"),
            "Станок шиномонтажный автомат, двухскоростной, 380 В, синий NORDBERG 4641N",
        )

        self.assertEqual(product.name, "Станок шиномонтажный автомат Nordberg 4641N")
        self.assertEqual(product.price, Decimal("212100"))
        self.assertEqual(product.currency, "RUB")
        self.assertEqual(product.availability, "https://schema.org/InStock")

    def test_identity_tokens_keep_model_suffixes_and_ignore_numeric_ranges(self) -> None:
        self.assertEqual(identity_tokens("NORDBERG 45TRK(B), 14–26"), ("45trkb",))
        self.assertEqual(identity_tokens("Грузовой ES-26D, 14–26"), ("es26d",))
        self.assertEqual(identity_tokens("Окрасочно-сушильная камера NORDBERG STANDART"), ("standart",))

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

    def test_review_offer_keeps_raw_price_but_excludes_it_from_comparison(self) -> None:
        adapter = StructuredProductAdapter(
            StaticFetcher(FIXTURE.read_text(encoding="utf-8")),
            "source:nordberg.ru",
        )

        observation = adapter.collect(_task(match_status="review"))

        self.assertEqual(observation.price.raw_price, Decimal("189000.00"))
        self.assertIsNone(observation.price.normalized_price)
        self.assertEqual(observation.price.reliability, Reliability.UNRELIABLE)
        self.assertEqual(observation.price.exclusion_reason, "non_exact_product")

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

    def test_english_user_verification_page_is_not_parsed_as_a_product(self) -> None:
        adapter = StructuredProductAdapter(
            StaticFetcher("<html><title>User verification...</title></html>"),
            "source:nordberg.ru",
        )

        with self.assertRaises(ManualFallbackRequired):
            adapter.collect(_task())

    def test_browser_retries_extraction_after_http_document_is_incomplete(self) -> None:
        browser = StaticBrowserFetcher(FIXTURE.read_text(encoding="utf-8"))
        adapter = StructuredProductAdapter(
            StaticFetcher("<html><h1>Loading</h1></html>"),
            "source:nordberg.ru",
            browser_fetcher=browser,
        )

        observation = adapter.collect(_task())

        self.assertEqual(observation.price.raw_price, Decimal("189000.00"))
        self.assertEqual(observation.evidence["transport"], "browser")
        self.assertEqual(browser.calls, 1)

    def test_browser_retries_after_http_network_failure(self) -> None:
        browser = StaticBrowserFetcher(FIXTURE.read_text(encoding="utf-8"))
        adapter = StructuredProductAdapter(
            NetworkFailingFetcher(),
            "source:nordberg.ru",
            browser_fetcher=browser,
        )

        observation = adapter.collect(_task())

        self.assertEqual(observation.price.raw_price, Decimal("189000.00"))
        self.assertEqual(observation.evidence["transport"], "browser")
        self.assertEqual(browser.calls, 1)

    def test_browser_does_not_bypass_rate_limit(self) -> None:
        browser = StaticBrowserFetcher(FIXTURE.read_text(encoding="utf-8"))
        adapter = StructuredProductAdapter(
            RateLimitedFetcher(),
            "source:nordberg.ru",
            browser_fetcher=browser,
        )

        with self.assertRaisesRegex(RetryableCollectionError, "429"):
            adapter.collect(_task())

        self.assertEqual(browser.calls, 0)

    def test_browser_is_not_started_when_http_document_is_complete(self) -> None:
        browser = StaticBrowserFetcher("unused")
        adapter = StructuredProductAdapter(
            StaticFetcher(FIXTURE.read_text(encoding="utf-8")),
            "source:nordberg.ru",
            browser_fetcher=browser,
        )

        observation = adapter.collect(_task())

        self.assertEqual(observation.evidence["transport"], "http")
        self.assertEqual(browser.calls, 0)


if __name__ == "__main__":
    unittest.main()
