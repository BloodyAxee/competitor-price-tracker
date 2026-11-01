import unittest
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from price_monitor_domain import Reliability
from price_collector.errors import ManualFallbackRequired, PermanentCollectionError
from price_collector.http import HttpResponse
from price_collector.models import SourceTask
from price_collector.sources.centr_to import (
    CentrToAdapter,
    parse_centr_to_embedded_product,
    parse_centr_to_product,
    parse_centr_to_t300,
)


FIXTURE = Path(__file__).parent / "fixtures" / "centr_to_t300.html"
SECOND_FIXTURE = Path(__file__).parent / "fixtures" / "centr_to_4523.html"
EMBEDDED_FIXTURE = Path(__file__).parent / "fixtures" / "centr_to_embedded.html"


def _task(
    url: str = "https://centr-to.ru/good-15155-t300-shinomontazhnyy-poluavtomat-380v",
    *,
    expected_product_name: str = "Шиномонтажный станок Станкоимпорт T300, 380 В",
    seller_article: str = "15155",
) -> SourceTask:
    return SourceTask(
        job_id="00000000-0000-0000-0000-000000000001",
        offer_id="00000000-0000-0000-0000-000000000002",
        source_id="00000000-0000-0000-0000-000000000003",
        source_key="source:centr-to.ru",
        url=url,
        collection_method="http",
        timeout_seconds=45,
        max_retries=2,
        rate_limit_per_host=0.5,
        expected_product_name=expected_product_name,
        seller_article=seller_article,
    )


class StaticFetcher:
    def __init__(self, html: str) -> None:
        self.html = html
        self.calls: list[tuple[str, float, float]] = []

    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        self.calls.append((url, timeout, rate_limit_per_host))
        return HttpResponse(200, self.html, {"Content-Type": "text/html"})


class CentrToParserTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = FIXTURE.read_text(encoding="utf-8")

    def test_fixture_extracts_exact_product_price_and_specs(self) -> None:
        product = parse_centr_to_t300(self.html)

        self.assertEqual(product.name, "Шиномонтажный станок полуавтомат 380В T300")
        self.assertEqual(product.price, Decimal("95000"))
        self.assertEqual(product.currency, "RUB")
        self.assertEqual(product.availability, "https://schema.org/InStock")
        self.assertEqual(product.specifications["напряжение питания, в"], "380")

    def test_missing_structured_price_fails_explicitly(self) -> None:
        changed = self.html.replace('"price": "95000",', "")

        with self.assertRaisesRegex(PermanentCollectionError, "price is missing"):
            parse_centr_to_t300(changed)

    def test_wrong_voltage_is_rejected(self) -> None:
        wrong_product = self.html.replace('"value": "380"', '"value": "220"')

        with self.assertRaisesRegex(PermanentCollectionError, "Unexpected product specification"):
            parse_centr_to_t300(wrong_product)

    def test_second_product_uses_the_same_structured_data_parser(self) -> None:
        product = parse_centr_to_product(
            SECOND_FIXTURE.read_text(encoding="utf-8"),
            "Балансировочный станок NORDBERG 4523 с автовводом",
        )

        self.assertEqual(product.name, "Балансировочный станок NORDBERG 4523 с автовводом")
        self.assertEqual(product.price, Decimal("189000"))

    def test_wrong_model_is_rejected(self) -> None:
        with self.assertRaisesRegex(PermanentCollectionError, "Unexpected product name"):
            parse_centr_to_product(
                SECOND_FIXTURE.read_text(encoding="utf-8"),
                "Балансировочный станок NORDBERG 4524C(B)",
            )

    def test_embedded_product_uses_exact_card_id_and_ignores_other_prices(self) -> None:
        product = parse_centr_to_embedded_product(
            EMBEDDED_FIXTURE.read_text(encoding="utf-8"),
            "Балансировочный станок 4523PA1(B) с автовводом",
            "21885",
        )

        self.assertEqual(product.name, "Станок балансировочный автомат с дисплеем, синий 4523PA1(B)")
        self.assertEqual(product.price, Decimal("222000"))

    def test_embedded_product_rejects_another_card_id(self) -> None:
        with self.assertRaisesRegex(PermanentCollectionError, "was not found"):
            parse_centr_to_embedded_product(
                EMBEDDED_FIXTURE.read_text(encoding="utf-8"),
                "Балансировочный станок 4523PA1(B) с автовводом",
                "99999",
            )


class CentrToAdapterTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = FIXTURE.read_text(encoding="utf-8")

    def test_adapter_builds_reliable_own_price_observation(self) -> None:
        observed_at = datetime(2026, 11, 1, 11, 30, tzinfo=UTC)
        fetcher = StaticFetcher(self.html)
        adapter = CentrToAdapter(fetcher, clock=lambda: observed_at)

        observation = adapter.collect(_task())

        self.assertEqual(observation.price.reliability, Reliability.RELIABLE)
        self.assertEqual(observation.price.raw_price, Decimal("95000"))
        self.assertEqual(observation.price.normalized_price, Decimal("95000"))
        self.assertEqual(observation.price.stock_status, "in_stock")
        self.assertEqual(observation.normalized_quantity, Decimal("1"))
        self.assertEqual(observation.unit, "piece")
        self.assertEqual(observation.observed_at, observed_at)
        self.assertEqual(observation.evidence["seller_article"], "15155")
        self.assertEqual(fetcher.calls[0][1:], (45, 0.5))

    def test_unverified_centr_to_url_is_rejected_before_request(self) -> None:
        fetcher = StaticFetcher(self.html)
        adapter = CentrToAdapter(fetcher)

        with self.assertRaisesRegex(PermanentCollectionError, "does not match"):
            adapter.collect(_task("https://centr-to.ru/good-999-other-product"))
        self.assertEqual(fetcher.calls, [])

    def test_second_product_builds_an_observation(self) -> None:
        adapter = CentrToAdapter(StaticFetcher(SECOND_FIXTURE.read_text(encoding="utf-8")))

        observation = adapter.collect(
            _task(
                "https://centr-to.ru/good-12941-stanok-balansirovochnyy-nordberg-4523",
                expected_product_name="Балансировочный станок NORDBERG 4523 с автовводом",
                seller_article="12941",
            )
        )

        self.assertEqual(observation.price.normalized_price, Decimal("189000"))
        self.assertEqual(observation.evidence["seller_article"], "12941")

    def test_adapter_falls_back_to_embedded_exact_product(self) -> None:
        adapter = CentrToAdapter(StaticFetcher(EMBEDDED_FIXTURE.read_text(encoding="utf-8")))

        observation = adapter.collect(
            _task(
                "https://centr-to.ru/good-21885-stanok-balansirovochnyy-4523pa1-b",
                expected_product_name="Балансировочный станок 4523PA1(B) с автовводом",
                seller_article="21885",
            )
        )

        self.assertEqual(observation.price.normalized_price, Decimal("222000"))
        self.assertEqual(observation.evidence["structured_data"], "centr-to embedded product")

    def test_challenge_page_requests_manual_fallback(self) -> None:
        adapter = CentrToAdapter(StaticFetcher("<title>Verify you are human</title>"))

        with self.assertRaises(ManualFallbackRequired):
            adapter.collect(_task())


if __name__ == "__main__":
    unittest.main()
