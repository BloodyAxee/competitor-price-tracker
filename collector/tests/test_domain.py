import json
import unittest
from decimal import Decimal
from pathlib import Path

from price_monitor_domain import (
    BundleComponent,
    CollectionMethod,
    MatchStatus,
    OfficialStatus,
    PriceInput,
    PriceType,
    PricedOffer,
    ProductIdentity,
    Reliability,
    evaluate_bundle,
    evaluate_manual_price,
    evaluate_price,
    match_products,
    parse_money,
    preferred_offers,
)


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "domain_cases.json"


def _product(data: dict[str, object]) -> ProductIdentity:
    return ProductIdentity(
        brand=str(data["brand"]),
        model=str(data["model"]),
        material_specs={str(key): str(value) for key, value in dict(data["specs"]).items()},
    )


class MatchingRulesTest(unittest.TestCase):
    def test_research_regressions(self) -> None:
        fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
        for case in fixture["matching"]:
            with self.subTest(case=case["name"]):
                decision = match_products(_product(case["required"]), _product(case["observed"]))
                self.assertEqual(decision.status.value, case["expected"])

    def test_similar_model_is_never_exact(self) -> None:
        for required_model, observed_model in (
            ("4641N", "4641"),
            ("T300", "T300A"),
            ("VT-61", "VT-64"),
            ("4523", "4523PA1"),
        ):
            with self.subTest(required=required_model, observed=observed_model):
                result = match_products(
                    ProductIdentity("brand", required_model),
                    ProductIdentity("brand", observed_model),
                )
                self.assertIsNot(result.status, MatchStatus.EXACT)

    def test_normalization_only_ignores_case_and_whitespace(self) -> None:
        result = match_products(
            ProductIdentity(" NORDBERG ", "4523PA1(B)"),
            ProductIdentity("nordberg", "  4523PA1(B)  "),
        )
        self.assertIs(result.status, MatchStatus.EXACT)


class PriceRulesTest(unittest.TestCase):
    def test_russian_money_strings_are_parsed_without_float_rounding(self) -> None:
        self.assertEqual(parse_money("1 234 567 ₽"), Decimal("1234567"))
        self.assertEqual(parse_money("299\u202f990,50 руб."), Decimal("299990.50"))

    def test_from_price_is_not_silently_parsed_as_regular_price(self) -> None:
        with self.assertRaises(ValueError):
            parse_money("от 100 000 ₽")

    def test_homogeneous_package_is_normalized_to_one_unit(self) -> None:
        for quantity in range(1, 201):
            with self.subTest(quantity=quantity):
                candidate = PriceInput(
                    raw_price=Decimal(quantity * 137),
                    price_type=PriceType.RETAIL,
                    package_quantity=Decimal(quantity),
                )
                result = evaluate_price(candidate, MatchStatus.EXACT)
                self.assertEqual(result.normalized_price, Decimal("137"))
                self.assertTrue(result.eligible_for_comparison)

    def test_heterogeneous_set_is_not_divided(self) -> None:
        result = evaluate_price(
            PriceInput(
                raw_price=Decimal("120000"),
                price_type=PriceType.RETAIL,
                package_quantity=Decimal("2"),
                package_homogeneous=False,
            ),
            MatchStatus.EXACT,
        )
        self.assertEqual(result.exclusion_reason, "heterogeneous_package")
        self.assertIsNone(result.normalized_price)

    def test_unreliable_inputs_are_retained_with_reason(self) -> None:
        cases = (
            (PriceInput(Decimal("100"), PriceType.RETAIL, is_from_price=True), "price_from"),
            (PriceInput(Decimal("100"), PriceType.RETAIL, is_stale=True), "stale_page"),
            (PriceInput(None, PriceType.QUOTE), "quote_only"),
        )
        for candidate, reason in cases:
            with self.subTest(reason=reason):
                result = evaluate_price(candidate, MatchStatus.EXACT)
                self.assertEqual(result.reliability, Reliability.UNRELIABLE)
                self.assertEqual(result.exclusion_reason, reason)
                self.assertEqual(result.raw_price, candidate.raw_price)

    def test_non_exact_product_is_excluded(self) -> None:
        result = evaluate_price(
            PriceInput(Decimal("100"), PriceType.RETAIL),
            MatchStatus.REVIEW,
        )
        self.assertEqual(result.exclusion_reason, "non_exact_product")

    def test_manual_input_is_always_marked_manual(self) -> None:
        result = evaluate_manual_price(
            PriceInput(Decimal("100"), PriceType.RETAIL, method=CollectionMethod.AUTO),
            MatchStatus.EXACT,
        )
        self.assertIs(result.method, CollectionMethod.MANUAL)

    def test_unknown_conditions_stay_none(self) -> None:
        result = evaluate_price(
            PriceInput(Decimal("100"), PriceType.RETAIL),
            MatchStatus.EXACT,
        )
        self.assertIsNone(result.vat_included)
        self.assertIsNone(result.stock_status)
        self.assertIsNone(result.region)
        self.assertIsNone(result.delivery_included)
        self.assertIsNone(result.installation_included)

    def test_unknown_price_type_requires_review(self) -> None:
        result = evaluate_price(
            PriceInput(Decimal("100"), PriceType.UNKNOWN),
            MatchStatus.EXACT,
        )
        self.assertIs(result.reliability, Reliability.REVIEW)
        self.assertFalse(result.eligible_for_comparison)


class SourcePriorityTest(unittest.TestCase):
    def test_official_source_is_preferred_without_mixing_price_types(self) -> None:
        retail = evaluate_price(PriceInput(Decimal("100"), PriceType.RETAIL), MatchStatus.EXACT)
        sale = evaluate_price(PriceInput(Decimal("90"), PriceType.SALE), MatchStatus.EXACT)
        offers = [
            PricedOffer("retailer", OfficialStatus.VERIFIED_RETAILER, retail),
            PricedOffer("manufacturer", OfficialStatus.MANUFACTURER, retail),
            PricedOffer("sale", OfficialStatus.MANUFACTURER, sale),
            PricedOffer("dealer", OfficialStatus.OFFICIAL_DEALER, retail),
        ]

        ranked = preferred_offers(offers, PriceType.RETAIL)

        self.assertEqual([offer.source_id for offer in ranked], ["manufacturer", "dealer", "retailer"])


class BundleRulesTest(unittest.TestCase):
    def test_4641n_and_vt64_are_summed_for_one_seller(self) -> None:
        result = evaluate_bundle(
            (
                BundleComponent("4641N", "seller-a", Decimal("210000")),
                BundleComponent("VT-64", "seller-a", Decimal("90000")),
            ),
            ("4641N", "VT-64"),
        )
        self.assertEqual(result.normalized_price, Decimal("300000"))
        self.assertTrue(result.eligible_for_comparison)

    def test_cross_seller_bundle_is_excluded_by_default(self) -> None:
        result = evaluate_bundle(
            (
                BundleComponent("4641N", "seller-a", Decimal("210000")),
                BundleComponent("VT-64", "seller-b", Decimal("90000")),
            ),
            ("4641N", "VT-64"),
        )
        self.assertEqual(result.exclusion_reason, "mixed_sellers")

    def test_bundle_total_property(self) -> None:
        for first in range(1, 80, 7):
            for second in range(1, 80, 11):
                with self.subTest(first=first, second=second):
                    result = evaluate_bundle(
                        (
                            BundleComponent("a", "seller", Decimal(first)),
                            BundleComponent("b", "seller", Decimal(second)),
                        ),
                        ("a", "b"),
                    )
                    self.assertEqual(result.normalized_price, Decimal(first + second))


if __name__ == "__main__":
    unittest.main()
