import json
import re
import unicodedata
from collections.abc import Iterator
from dataclasses import dataclass
from decimal import Decimal
from html import unescape
from html.parser import HTMLParser
from typing import Any

from price_monitor_domain import parse_money

from ..errors import PermanentCollectionError


@dataclass(frozen=True)
class StructuredProduct:
    name: str
    price: Decimal
    currency: str
    availability: str | None
    specifications: dict[str, str]


class _JsonLdParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.blocks: list[str] = []
        self._buffer: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.casefold(): value for key, value in attrs}
        if (
            tag.casefold() == "script"
            and (attributes.get("type") or "").casefold() == "application/ld+json"
        ):
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._buffer is not None:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "script" and self._buffer is not None:
            self.blocks.append("".join(self._buffer))
            self._buffer = None


def _walk_products(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        item_type = value.get("@type")
        types = item_type if isinstance(item_type, list) else [item_type]
        if any(str(candidate).casefold() == "product" for candidate in types):
            yield value
        for nested in value.values():
            yield from _walk_products(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_products(nested)


def normalized_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", unescape(str(value))).casefold()
    return " ".join(text.replace("–", "-").replace("—", "-").replace("″", '"').split())


def identity_tokens(value: str) -> tuple[str, ...]:
    normalized = normalized_text(value).replace("×", "x")
    normalized = re.sub(r"(?<=[a-zа-яё0-9])\(([a-zа-яё0-9]+)\)", r"\1", normalized)
    raw_tokens = re.findall(r"[a-zа-яё0-9]+(?:[-./][a-zа-яё0-9]+)*", normalized)
    compact_tokens = [re.sub(r"[^a-zа-яё0-9]", "", token) for token in raw_tokens]
    model_tokens = [
        compact
        for raw, compact in zip(raw_tokens, compact_tokens, strict=True)
        if len(compact) >= 3
        and (
            (any(character.isalpha() for character in compact) and any(character.isdigit() for character in compact))
            or (raw.isdigit() and len(raw) >= 4)
        )
    ]
    if model_tokens:
        return tuple(dict.fromkeys(model_tokens))

    ignored = {
        "автомат",
        "балансировочный",
        "грузовых",
        "колес",
        "комплект",
        "окрасочная",
        "полуавтомат",
        "станок",
        "стенд",
        "сушильная",
        "шиномонтажный",
        "nordberg",
        "rossvik",
        "guangli",
    }
    distinctive = [token for token in compact_tokens if len(token) >= 4 and token not in ignored]
    return (max(distinctive, key=len),) if distinctive else ()


def _product_specs(product: dict[str, Any]) -> dict[str, str]:
    properties = product.get("additionalProperty")
    if not isinstance(properties, list):
        return {}
    result: dict[str, str] = {}
    for item in properties:
        if isinstance(item, dict) and item.get("name") is not None and item.get("value") is not None:
            result[normalized_text(item["name"])] = normalized_text(item["value"])
    return result


def _validate_identity(
    product: dict[str, Any],
    expected_name: str,
    required_specs: dict[str, str] | None,
) -> tuple[str, dict[str, str]]:
    name = str(product.get("name") or "").strip()
    normalized_name = normalized_text(name)
    normalized_name = re.sub(
        r"(?<=[a-zа-яё0-9])\(([a-zа-яё0-9]+)\)",
        r"\1",
        normalized_name,
    )
    expected_tokens = identity_tokens(expected_name)
    if not expected_tokens:
        raise PermanentCollectionError(
            "The expected product name has no stable identity token",
            code="unsupported_offer",
        )

    def token_is_present(token: str) -> bool:
        separated = r"[^a-zа-яё0-9]*".join(re.escape(character) for character in token)
        return re.search(
            rf"(?<![a-zа-яё0-9]){separated}(?![a-zа-яё0-9])",
            normalized_name,
        ) is not None

    tokens_match = all(token_is_present(token) for token in expected_tokens)
    if not tokens_match:
        raise PermanentCollectionError(
            f"Unexpected product name: {name or 'missing'}",
            code="product_mismatch",
        )

    specs = _product_specs(product)
    for spec_name, expected_value in (required_specs or {}).items():
        actual_value = specs.get(spec_name)
        if actual_value is None:
            raise PermanentCollectionError(
                f"Required product specification is missing: {spec_name}",
                code="missing_product_specification",
            )
        if actual_value != normalized_text(expected_value):
            raise PermanentCollectionError(
                f"Unexpected product specification: {spec_name}",
                code="product_mismatch",
            )
    return name, specs


def validate_product_name(name: str, expected_name: str) -> str:
    validated_name, _ = _validate_identity({"name": name}, expected_name, None)
    return validated_name


def _single_offer(product: dict[str, Any]) -> dict[str, Any]:
    raw_offers = product.get("offers")
    offers = raw_offers if isinstance(raw_offers, list) else [raw_offers]
    valid_offers = [
        offer
        for offer in offers
        if isinstance(offer, dict) and offer.get("price") is not None
    ]
    if not valid_offers:
        raise PermanentCollectionError("Published price is missing", code="missing_price")
    if len(valid_offers) > 1:
        raise PermanentCollectionError("Published price is ambiguous", code="ambiguous_price")
    return valid_offers[0]


def parse_json_ld_product(
    html: str,
    expected_name: str,
    *,
    required_specs: dict[str, str] | None = None,
) -> StructuredProduct:
    parser = _JsonLdParser()
    parser.feed(html)
    products: list[dict[str, Any]] = []
    invalid_blocks = 0
    for block in parser.blocks:
        try:
            products.extend(_walk_products(json.loads(block)))
        except json.JSONDecodeError:
            invalid_blocks += 1

    matching: list[tuple[dict[str, Any], str, dict[str, str]]] = []
    identity_errors: list[PermanentCollectionError] = []
    for product in products:
        try:
            name, specs = _validate_identity(product, expected_name, required_specs)
            matching.append((product, name, specs))
        except PermanentCollectionError as error:
            identity_errors.append(error)
    if not matching:
        if identity_errors:
            raise identity_errors[0]
        code = "invalid_structured_data" if invalid_blocks and not products else "product_mismatch"
        raise PermanentCollectionError("Exact product data was not found", code=code)
    if len(matching) > 1:
        raise PermanentCollectionError("Exact product data is ambiguous", code="ambiguous_product")

    product, name, specs = matching[0]
    offer = _single_offer(product)
    currency = str(offer.get("priceCurrency") or "").upper()
    if currency not in ("RUB", "RUR"):
        raise PermanentCollectionError(
            f"Unsupported currency: {currency or 'missing'}",
            code="unsupported_currency",
        )
    try:
        price = parse_money(str(offer["price"]))
    except ValueError as error:
        raise PermanentCollectionError(
            "Published price has an unsupported format",
            code="invalid_price",
        ) from error
    availability = str(offer["availability"]) if offer.get("availability") else None
    return StructuredProduct(name, price, "RUB", availability, specs)


def stock_status(availability: str | None) -> str | None:
    if availability is None:
        return None
    value = availability.rstrip("/").rsplit("/", 1)[-1].casefold()
    return {
        "instock": "in_stock",
        "outofstock": "out_of_stock",
        "preorder": "preorder",
        "backorder": "backorder",
    }.get(value)
