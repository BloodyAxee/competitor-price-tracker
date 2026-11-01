import json
import unittest
from decimal import Decimal
from pathlib import Path

from price_collector.errors import PermanentCollectionError
from price_collector.sources.visible_product import VISIBLE_SOURCE_PROFILES, parse_visible_product


FIXTURES = Path(__file__).parent / "fixtures"


class VisibleProductParserTest(unittest.TestCase):
    def test_aet_price_is_scoped_to_the_exact_product(self) -> None:
        product = parse_visible_product(
            (FIXTURES / "aet_auto_visible.html").read_text(encoding="utf-8"),
            "Грузовой шиномонтажный станок AE&T MT-290",
            VISIBLE_SOURCE_PROFILES["source:aet-auto.ru"],
        )

        self.assertEqual(product.price, Decimal("379490"))
        self.assertEqual(product.availability, "https://schema.org/InStock")

    def test_autoservice_recommendation_price_is_ignored(self) -> None:
        product = parse_visible_product(
            (FIXTURES / "autoservice_visible.html").read_text(encoding="utf-8"),
            "Шиномонтажный станок NORDBERG 46TRKE42(B), 14–42″",
            VISIBLE_SOURCE_PROFILES["source:autoservice2.ru"],
        )

        self.assertEqual(product.price, Decimal("550000"))

    def test_similar_model_heading_is_rejected(self) -> None:
        html = (FIXTURES / "autoservice_visible.html").read_text(encoding="utf-8").replace(
            "46TRKE42(B)", "46TRKE56(B)"
        )

        with self.assertRaises(PermanentCollectionError):
            parse_visible_product(
                html,
                "Шиномонтажный станок NORDBERG 46TRKE42(B), 14–42″",
                VISIBLE_SOURCE_PROFILES["source:autoservice2.ru"],
            )

    def test_supported_source_profiles_ignore_accessory_prices(self) -> None:
        cases = json.loads((FIXTURES / "visible_source_cases.json").read_text(encoding="utf-8"))
        for case in cases:
            with self.subTest(source=case["source"]):
                product = parse_visible_product(
                    case["html"],
                    case["expected_name"],
                    VISIBLE_SOURCE_PROFILES[case["source"]],
                )
                self.assertEqual(product.price, Decimal(case["expected_price"]))


if __name__ == "__main__":
    unittest.main()
