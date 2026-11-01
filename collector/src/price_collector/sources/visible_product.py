import re
from dataclasses import dataclass
from html.parser import HTMLParser

from price_monitor_domain import parse_money

from ..errors import PermanentCollectionError
from .structured_data import StructuredProduct, validate_product_name


@dataclass(frozen=True)
class VisibleProductProfile:
    price_patterns: tuple[str, ...]
    stop_markers: tuple[str, ...] = ()
    availability_patterns: tuple[tuple[str, str], ...] = (
        (r"\bв наличии\b", "https://schema.org/InStock"),
        (r"\bпод заказ\b", "https://schema.org/BackOrder"),
        (r"\bнет в наличии\b", "https://schema.org/OutOfStock"),
    )


VISIBLE_SOURCE_PROFILES = {
    "source:aet-auto.ru": VisibleProductProfile(
        price_patterns=(r"(?P<price>\d[\d\s]{2,})\s*₽\s*В наличии",),
        stop_markers=("С этим товаром покупают", "Похожие товары"),
    ),
    "source:autoservice2.ru": VisibleProductProfile(
        price_patterns=(r"Ваша цена:\s*(?P<price>\d[\d\s]{2,})\s*руб\.?",),
        stop_markers=("Рекомендуем также", "Оригинальные запчасти для"),
    ),
}


class _VisibleTextParser(HTMLParser):
    _IGNORED = {"script", "style", "noscript", "svg"}
    _BREAKS = {
        "article",
        "br",
        "div",
        "footer",
        "h1",
        "h2",
        "h3",
        "header",
        "li",
        "main",
        "p",
        "section",
        "table",
        "td",
        "th",
        "tr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.text: list[str] = []
        self.headings: list[str] = []
        self.titles: list[str] = []
        self._ignored_depth = 0
        self._capture: tuple[str, list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        if tag in self._IGNORED:
            self._ignored_depth += 1
            return
        if self._ignored_depth:
            return
        if tag in self._BREAKS:
            self.text.append("\n")
        if tag in {"h1", "title"}:
            self._capture = (tag, [])

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        self.text.append(data)
        if self._capture is not None:
            self._capture[1].append(data)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in self._IGNORED:
            self._ignored_depth = max(0, self._ignored_depth - 1)
            return
        if self._ignored_depth:
            return
        if self._capture is not None and self._capture[0] == tag:
            value = " ".join("".join(self._capture[1]).split())
            if value:
                (self.headings if tag == "h1" else self.titles).append(value)
            self._capture = None
        if tag in self._BREAKS:
            self.text.append("\n")


def parse_visible_product(
    html: str,
    expected_name: str,
    profile: VisibleProductProfile,
) -> StructuredProduct:
    parser = _VisibleTextParser()
    parser.feed(html)
    identity_candidates = parser.headings + parser.titles
    if not identity_candidates:
        raise PermanentCollectionError("Visible product heading is missing", code="missing_product_name")

    name: str | None = None
    identity_errors: list[PermanentCollectionError] = []
    for candidate in identity_candidates:
        try:
            name = validate_product_name(candidate, expected_name)
            break
        except PermanentCollectionError as error:
            identity_errors.append(error)
    if name is None:
        raise identity_errors[0]

    visible_text = " ".join(" ".join(parser.text).split())
    lowered = visible_text.casefold()
    stop_indexes = [lowered.find(marker.casefold()) for marker in profile.stop_markers]
    stop_indexes = [index for index in stop_indexes if index >= 0]
    if stop_indexes:
        visible_text = visible_text[: min(stop_indexes)]

    prices = []
    for pattern in profile.price_patterns:
        for match in re.finditer(pattern, visible_text, re.IGNORECASE):
            try:
                prices.append(parse_money(match["price"]))
            except ValueError as error:
                raise PermanentCollectionError(
                    "Visible price has an unsupported format",
                    code="invalid_price",
                ) from error
    unique_prices = list(dict.fromkeys(prices))
    if not unique_prices:
        raise PermanentCollectionError("Visible product price is missing", code="missing_price")
    if len(unique_prices) > 1:
        raise PermanentCollectionError("Visible product price is ambiguous", code="ambiguous_price")

    availability = None
    for pattern, value in profile.availability_patterns:
        if re.search(pattern, visible_text, re.IGNORECASE):
            availability = value
            break
    return StructuredProduct(name, unique_prices[0], "RUB", availability, {})
