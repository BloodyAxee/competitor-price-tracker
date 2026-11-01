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

    def test_aet_current_cart_controls_are_supported(self) -> None:
        html = (FIXTURES / "aet_auto_visible.html").read_text(encoding="utf-8").replace(
            "379 490 ₽</div><div>В наличии",
            "392 350 ₽ − + В корзину</div><div>Доставка от 1 дня",
        )

        product = parse_visible_product(
            html,
            "Грузовой шиномонтажный станок AE&T MT-290",
            VISIBLE_SOURCE_PROFILES["source:aet-auto.ru"],
        )

        self.assertEqual(product.price, Decimal("392350"))

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

    def test_required_voltage_is_checked_automatically(self) -> None:
        html = (FIXTURES / "aet_auto_visible.html").read_text(encoding="utf-8").replace(
            "380В", "220В"
        ).replace("380 В", "220 В")

        with self.assertRaisesRegex(PermanentCollectionError, "380 V"):
            parse_visible_product(
                html,
                "Грузовой шиномонтажный станок AE&T MT-290",
                VISIBLE_SOURCE_PROFILES["source:aet-auto.ru"],
            )

    def test_navigation_stop_marker_before_product_does_not_hide_the_card(self) -> None:
        html = """
        <html><body>
          <nav>Каталог Запчасти</nav>
          <h1>Станок балансировочный NORDBERG 45TRK(B)</h1>
          <div>Синий, 380 В</div><div>217 500 a В корзину</div>
          <div>Описание Опции и запчасти О товаре</div>
          <article>Допустимая масса колеса до 200 кг</article>
          <h2>Запчасти</h2><div>7 150 a Заказать</div>
        </body></html>
        """

        product = parse_visible_product(
            html,
            "Балансировочный станок 45TRK(B): колёса до 200 кг",
            VISIBLE_SOURCE_PROFILES["source:master-instrument.ru"],
        )

        self.assertEqual(product.price, Decimal("217500"))


if __name__ == "__main__":
    unittest.main()
