from collections.abc import Collection
from decimal import Decimal

from .model import BundleComponent, BundleDecision, Reliability


def evaluate_bundle(
    components: Collection[BundleComponent],
    expected_component_ids: Collection[str],
    *,
    same_seller_only: bool = True,
) -> BundleDecision:
    expected = set(expected_component_ids)
    actual = [component.component_id for component in components]

    if len(actual) != len(set(actual)):
        return BundleDecision(None, Reliability.UNRELIABLE, "duplicate_component")
    if set(actual) != expected:
        return BundleDecision(None, Reliability.UNRELIABLE, "incomplete_bundle")
    if any(component.unit_price <= 0 or component.quantity <= 0 for component in components):
        return BundleDecision(None, Reliability.UNRELIABLE, "invalid_component_price")
    if same_seller_only and len({component.seller_id for component in components}) != 1:
        return BundleDecision(None, Reliability.UNRELIABLE, "mixed_sellers")

    total = sum(
        (component.unit_price * component.quantity for component in components),
        start=Decimal("0"),
    )
    return BundleDecision(total, Reliability.RELIABLE, None)
