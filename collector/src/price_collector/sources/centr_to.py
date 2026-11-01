import json
import re
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from urllib.parse import urlsplit

from price_monitor_domain import MatchStatus, PriceInput, PriceType, evaluate_price

from ..errors import PermanentCollectionError
from ..models import CollectedObservation, SourceTask
from .fallback import BrowserPageFetcher, HttpPageFetcher, ProductParser, extract_product
from .structured_data import (
    StructuredProduct,
    identity_tokens,
    parse_json_ld_product,
    stock_status,
    validate_product_name,
)


SOURCE_KEY = "source:centr-to.ru"
T300_PRODUCT_ID = "15155"
T300_EXPECTED_SPECS = {
    "напряжение питания, в": "380",
    "внешний зажим диска": '10-21"',
    "внутренний зажим диска": '12-24"',
    "максимальный диаметр шины, мм": "1140",
    "ширина колеса, мм": "355",
}


CentrToProduct = StructuredProduct


def parse_centr_to_product(
    html: str,
    expected_name: str,
    *,
    required_specs: dict[str, str] | None = None,
) -> StructuredProduct:
    return parse_json_ld_product(
        html,
        expected_name,
        required_specs=required_specs,
    )


def parse_centr_to_t300(html: str) -> StructuredProduct:
    return parse_centr_to_product(
        html,
        "Шиномонтажный станок Станкоимпорт T300, 380 В",
        required_specs=T300_EXPECTED_SPECS,
    )


_EMBEDDED_PRODUCT_PATTERN = re.compile(
    r'"name":"(?P<name>(?:\\.|[^"\\])*)",'
    r'"id":(?P<id>\d+),'
    r'"price":(?P<price>null|-?\d+(?:\.\d+)?),'
    r'"defaultPrice":(?P<default_price>null|-?\d+(?:\.\d+)?),'
    r'"discountPrice":(?P<discount_price>null|-?\d+(?:\.\d+)?)',
)


def parse_centr_to_embedded_product(
    html: str,
    expected_name: str,
    product_id: str,
) -> StructuredProduct:
    matches = [match for match in _EMBEDDED_PRODUCT_PATTERN.finditer(html) if match["id"] == product_id]
    if not matches:
        raise PermanentCollectionError(
            f"Embedded product {product_id} was not found",
            code="missing_embedded_product",
        )

    candidates: list[StructuredProduct] = []
    for match in matches:
        name = json.loads(f'"{match["name"]}"')
        validate_product_name(name, expected_name)
        raw_price = match["discount_price"] if match["discount_price"] != "null" else match["price"]
        if raw_price == "null":
            raw_price = match["default_price"]
        if raw_price == "null":
            raise PermanentCollectionError("Published price is missing", code="missing_price")
        price = Decimal(raw_price)
        if price <= 0:
            raise PermanentCollectionError("Published price is not positive", code="invalid_price")
        candidates.append(StructuredProduct(name, price, "RUB", None, {}))

    unique = {(candidate.name, candidate.price): candidate for candidate in candidates}
    if len(unique) != 1:
        raise PermanentCollectionError(
            f"Embedded product {product_id} is ambiguous",
            code="ambiguous_product",
        )
    return next(iter(unique.values()))


class CentrToAdapter:
    key = SOURCE_KEY
    method = "http"

    def __init__(
        self,
        fetcher: HttpPageFetcher,
        *,
        browser_fetcher: BrowserPageFetcher | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._browser_fetcher = browser_fetcher
        self._clock = clock or (lambda: datetime.now(UTC))

    def collect(self, task: SourceTask) -> CollectedObservation:
        url = urlsplit(task.url)
        hostname = (url.hostname or "").casefold().removeprefix("www.")
        path_match = re.match(r"^/good-(\d+)(?:-|$)", url.path)
        if hostname != "centr-to.ru" or path_match is None:
            raise PermanentCollectionError(
                "The centr-to adapter only supports product card URLs",
                code="unsupported_offer",
            )
        product_id = path_match.group(1)
        if task.seller_article and task.seller_article != product_id:
            raise PermanentCollectionError(
                "The product card ID does not match the imported offer",
                code="product_mismatch",
            )
        if not task.expected_product_name:
            raise PermanentCollectionError(
                "The imported offer has no expected product name",
                code="unsupported_offer",
            )
        required_specs = T300_EXPECTED_SPECS if product_id == T300_PRODUCT_ID else None
        extraction = extract_product(
            task,
            self._fetcher,
            (
                ProductParser(
                    "schema.org JSON-LD",
                    lambda html: parse_centr_to_product(
                        html,
                        task.expected_product_name or "",
                        required_specs=required_specs,
                    ),
                ),
                ProductParser(
                    "centr-to embedded product",
                    lambda html: parse_centr_to_embedded_product(
                        html,
                        task.expected_product_name or "",
                        product_id,
                    ),
                ),
            ),
            browser_fetcher=self._browser_fetcher,
        )
        product = extraction.product

        current_stock = stock_status(product.availability)
        decision = evaluate_price(
            PriceInput(
                raw_price=product.price,
                price_type=PriceType.RETAIL,
                package_quantity=Decimal("1"),
                currency=product.currency,
                stock_status=current_stock,
            ),
            MatchStatus.EXACT,
        )
        evidence = {
            "product_name": product.name,
            "expected_product_name": task.expected_product_name,
            "identity_tokens": identity_tokens(task.expected_product_name),
            "seller_article": product_id,
            "price": str(product.price),
            "currency": product.currency,
            "availability": product.availability,
            "specifications": product.specifications,
            "source_url": extraction.final_url,
            "structured_data": extraction.parser,
            "transport": extraction.transport,
        }
        return CollectedObservation(
            price=decision,
            source_quantity=Decimal("1"),
            normalized_quantity=Decimal("1"),
            unit="piece",
            observed_at=self._clock(),
            evidence_text=(
                f"{product_id}; {product.price} {product.currency}; "
                f"{current_stock or 'stock unknown'}"
            ),
            evidence=evidence,
            source_payload_hash=sha256(extraction.html.encode("utf-8")).hexdigest(),
        )


CentrToT300Adapter = CentrToAdapter
