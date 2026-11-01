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

    def test_new_exact_sources_reject_a_missing_material_qualifier(self) -> None:
        cases = json.loads((FIXTURES / "visible_source_cases.json").read_text(encoding="utf-8"))
        mutations = {
            "Балансировочный станок ROSSVIK VT-63 с автовводом": ("VT-63.5005", "VT-63.7016"),
            "Балансировочный станок ES-950 с пневмоподъёмником": ("встроенный пневмоподъёмник", "подъёмник приобретается отдельно"),
            "Грузовой шиномонтажный станок ROSSVIK V-26": ("максимальный вес колеса 1500 кг", "максимальный вес колеса 500 кг"),
            "Балансировочный станок NORDBERG 4523C, 220 В": ("40 мм", "36 мм"),
            "Шиномонтажный полуавтомат ROSSVIK V-524, 380 В": ("V524.380.5005", "V524.220.5005"),
            "Балансировочный станок ROSSVIK VT-61, 220 В": ("RAL5005", "RAL3020"),
            "Окрасочно-сушильная камера Guangli GL3": ("нижний свет 16 ламп", "нижний свет 10 ламп"),
            "Окрасочно-сушильная камера NORDBERG STANDART": (
                "6,9 x 3,9 x 2,65",
                "6,9 x 3,9 x 2,70",
            ),
        }

        for case in cases:
            mutation = mutations.get(case["expected_name"])
            if mutation is None:
                continue
            original, replacement = mutation
            with self.subTest(source=case["source"], product=case["expected_name"]):
                with self.assertRaisesRegex(PermanentCollectionError, "qualifier"):
                    parse_visible_product(
                        case["html"].replace(original, replacement),
                        case["expected_name"],
                        VISIBLE_SOURCE_PROFILES[case["source"]],
                    )

    def test_conflicting_two_speed_nordberg_version_is_rejected(self) -> None:
        html = """
        <html><body>
          <h1>46TRKE(B) NORDBERG шиномонтажный станок</h1>
          <div>380 В, диски 14-26, максимальный вес колеса 1000 кг, двухскоростной</div>
          <div>413 000 RUB В корзину</div>
        </body></html>
        """

        with self.assertRaisesRegex(PermanentCollectionError, "Conflicting"):
            parse_visible_product(
                html,
                "Грузовой шиномонтажный станок NORDBERG 46TRKE(B)",
                VISIBLE_SOURCE_PROFILES["source:nordberg-shop.ru"],
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
