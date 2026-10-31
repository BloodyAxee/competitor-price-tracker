import unittest
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from price_monitor_domain import Reliability
from price_collector.errors import ManualFallbackRequired, PermanentCollectionError
from price_collector.http import HttpResponse
from price_collector.models import SourceTask
from price_collector.sources.si_tools import SiToolsT300Adapter, parse_si_tools_t300


FIXTURE = Path(__file__).parent / "fixtures" / "si_tools_t300.html"


def _task() -> SourceTask:
    return SourceTask(
        job_id="00000000-0000-0000-0000-000000000001",
        offer_id="00000000-0000-0000-0000-000000000002",
        source_id="00000000-0000-0000-0000-000000000003",
        source_key="source:si-tools.ru",
        url="https://si-tools.ru/catalog/shinomontazhnie_stanki/t300_shinomontazhnyy_poluavtomat_380v/",
        collection_method="http",
        timeout_seconds=20,
        max_retries=2,
        rate_limit_per_host=1,
    )


class StaticFetcher:
    def __init__(self, html: str) -> None:
        self.html = html
        self.calls: list[tuple[str, float, float]] = []

    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        self.calls.append((url, timeout, rate_limit_per_host))
        return HttpResponse(200, self.html, {"Content-Type": "text/html"})


class SiToolsParserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = FIXTURE.read_text(encoding="utf-8")

    def test_fixture_extracts_exact_product_and_price(self) -> None:
        product = parse_si_tools_t300(self.html)

        self.assertEqual(product.name, "T300 шиномонтажный полуавтомат 380В")
        self.assertEqual(product.sku, "T300 380V")
        self.assertEqual(product.price, Decimal("95000"))
        self.assertEqual(product.currency, "RUB")
        self.assertEqual(product.availability, "http://schema.org/InStock")

    def test_changed_markup_fails_instead_of_producing_zero_price(self) -> None:
        changed = self.html.replace('itemprop="price"', 'data-field="price"')

        with self.assertRaisesRegex(PermanentCollectionError, "missing: price"):
            parse_si_tools_t300(changed)

    def test_wrong_voltage_sku_is_rejected(self) -> None:
        wrong_product = self.html.replace("T300 380V", "T300 220V")

        with self.assertRaisesRegex(PermanentCollectionError, "Expected SKU"):
            parse_si_tools_t300(wrong_product)


class SiToolsAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = FIXTURE.read_text(encoding="utf-8")

    def test_adapter_builds_reliable_append_only_observation(self) -> None:
        observed_at = datetime(2026, 11, 1, 9, 30, tzinfo=UTC)
        fetcher = StaticFetcher(self.html)
        adapter = SiToolsT300Adapter(fetcher, clock=lambda: observed_at)

        observation = adapter.collect(_task())

        self.assertEqual(observation.price.reliability, Reliability.RELIABLE)
        self.assertEqual(observation.price.raw_price, Decimal("95000"))
        self.assertEqual(observation.price.normalized_price, Decimal("95000"))
        self.assertEqual(observation.price.stock_status, "in_stock")
        self.assertEqual(observation.normalized_quantity, Decimal("1"))
        self.assertEqual(observation.unit, "piece")
        self.assertEqual(observation.observed_at, observed_at)
        self.assertEqual(len(observation.source_payload_hash), 64)
        self.assertEqual(fetcher.calls[0][1:], (20, 1))

    def test_two_fixture_collections_remain_two_observations(self) -> None:
        times = iter(
            (
                datetime(2026, 11, 1, 9, 30, tzinfo=UTC),
                datetime(2026, 11, 2, 9, 30, tzinfo=UTC),
            )
        )
        adapter = SiToolsT300Adapter(StaticFetcher(self.html), clock=lambda: next(times))

        observations = [adapter.collect(_task()), adapter.collect(_task())]

        self.assertEqual(len(observations), 2)
        self.assertNotEqual(observations[0].observed_at, observations[1].observed_at)
        self.assertEqual([item.price.raw_price for item in observations], [Decimal("95000")] * 2)

    def test_captcha_page_requests_manual_fallback(self) -> None:
        adapter = SiToolsT300Adapter(StaticFetcher("<title>Verify you are human</title>"))

        with self.assertRaises(ManualFallbackRequired):
            adapter.collect(_task())


if __name__ == "__main__":
    unittest.main()
