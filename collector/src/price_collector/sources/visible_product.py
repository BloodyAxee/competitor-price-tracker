import re
from dataclasses import dataclass
from html.parser import HTMLParser

from price_monitor_domain import parse_money

from ..errors import PermanentCollectionError
from .structured_data import StructuredProduct, identity_tokens, normalized_text, validate_product_name


@dataclass(frozen=True)
class VisibleProductProfile:
    price_patterns: tuple[str, ...]
    stop_markers: tuple[str, ...] = ()
    availability_patterns: tuple[tuple[str, str], ...] = (
        (r"\bв наличии\b", "https://schema.org/InStock"),
        (r"\bпод заказ\b", "https://schema.org/BackOrder"),
        (r"\bнет в наличии\b", "https://schema.org/OutOfStock"),
    )


_PRICE_NUMBER = r"(?<![\d.])(?:\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d{4,9})(?!\d)"
_HIGH_VALUE_PRICE_NUMBER = r"(?<![\d.])(?:\d{2,3}(?:[ \u00a0\u202f]\d{3})+|\d{5,9})(?!\d)"


VISIBLE_SOURCE_PROFILES = {
    "source:aet-auto.ru": VisibleProductProfile(
        price_patterns=(
            rf"(?P<price>{_PRICE_NUMBER})\s*₽\s*(?:В наличии|[−–—-]\s*\+\s*В корзину)",
        ),
        stop_markers=("С этим товаром покупают", "Похожие товары"),
    ),
    "source:autoservice2.ru": VisibleProductProfile(
        price_patterns=(rf"Ваша цена:\s*(?P<price>{_PRICE_NUMBER})\s*руб\.?",),
        stop_markers=("Рекомендуем также", "Оригинальные запчасти для"),
    ),
    "source:master-instrument.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*a\s*(?:В корзину|О товаре)",),
        stop_markers=("Запчасти", "Опции и запчасти"),
    ),
    "source:mactak-m.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*руб\.?\s*(?:В корзину|Купить)",),
        stop_markers=("Похожие товары", "С этим товаром покупают"),
    ),
    "source:nordberg-shop.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*(?:RUB|₽)\s*(?:В корзину|Минимальный заказ)",),
        stop_markers=("Опции и аксессуары", "С этим товаром покупают"),
    ),
    "source:rossvik.moscow": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*₽\s*(?:В корзину|Сравнить|Гарантия|Наличие)",),
        stop_markers=("Рекомендуем купить",),
    ),
    "source:rustehnika.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*₽\s*(?:В кредит|Купить в 1 клик|Описание)",),
        stop_markers=("Описание", "Похожие товары"),
    ),
    "source:technovector.ru": VisibleProductProfile(
        price_patterns=(
            rf"Артикул:\s*[^₽]{{0,100}}?(?P<price>{_PRICE_NUMBER})\s*₽\s*Срок поставки",
        ),
        stop_markers=("C этим товаром покупают", "С этим товаром покупают"),
    ),
    "source:tmktools.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*[р₽]\s*(?:Оставить заявку|Авторизуйтесь)",),
        stop_markers=("Описание", "Сервис и запчасти"),
    ),
    "source:topmaster-shop.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*₽",),
        stop_markers=("С этим товаром покупают", "Похожие товары"),
    ),
    "source:atsgroup.su": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*₽\s*(?:В наличии|Купить)",),
        stop_markers=("Связанные разделы каталога", "Похожие товары"),
    ),
    "source:technosouz.ru": VisibleProductProfile(
        price_patterns=(rf"Цена\s+с\s+НДС\s*(?P<price>{_PRICE_NUMBER})\s*руб\.?\s*Купить",),
        stop_markers=("Похожие товары", "С этим товаром покупают"),
    ),
    "source:optima-trade.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_HIGH_VALUE_PRICE_NUMBER})\s*р\s*уб\.?\s*с НДС",),
        stop_markers=("Сопутствующие товары", "Похожие товары", "С этим товаром покупают"),
    ),
    "source:carmod.ru": VisibleProductProfile(
        price_patterns=(rf"Подробности\s*(?P<price>{_PRICE_NUMBER})\s*₽\s*В корзину",),
        stop_markers=("Похожие товары", "Рекомендуем"),
    ),
    "source:vsedlyasto.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*руб\.?\s*за\s*1\s*В наличии",),
        stop_markers=("С этим товаром покупают", "Похожие товары", "Рекомендуем"),
    ),
    "source:vseinstrumenti.ru": VisibleProductProfile(
        price_patterns=(rf"(?P<price>{_PRICE_NUMBER})\s*₽\s*-\s*\d+%\s*для бизнеса",),
        stop_markers=("Аналоги", "ОПИСАНИЕ И ХАРАКТЕРИСТИКИ"),
    ),
}


def _diameter_range_pattern(minimum: int, maximum: int) -> str:
    """Match both compact ranges and separate min/max rows in specification tables."""
    return (
        rf"(?:{minimum}\s*-\s*{maximum}|"
        rf"(?:мин(?:имальн\w*)?\.?\s*диаметр\w*\s+диск\w*[^0-9]{{0,40}}{minimum}"
        rf".{{0,160}}макс(?:имальн\w*)?\.?\s*диаметр\w*\s+диск\w*[^0-9]{{0,40}}{maximum}))"
    )


_EXACT_QUALIFIER_RULES: dict[tuple[str, ...], tuple[tuple[str, str], ...]] = {
    ("mt290",): ((r"\b380\s*[вv]\b", "380 V"), (r"14\s*-\s*26", "14-26")),
    ("46trke42b",): ((r"\b380\s*[вv]\b", "380 V"), (r"14\s*-\s*42", "14-42")),
    ("45trkb",): ((r"\b380\s*[вv]\b", "380 V"), (r"200\s*кг", "200 kg")),
    ("4641",): ((r"\b380\s*[вv]\b", "380 V"), (r"(?:двухскорост|2\s*скорост)", "two speeds")),
    ("46trkb",): (
        (r"\b380\s*[вv]\b", "380 V"),
        (_diameter_range_pattern(14, 26), "14-26"),
        (
            r"(?:односкорост|одна скорость|количество скоростей[^0-9]{0,20}1|"
            r"максимальн\w* (?:вес|масса) колес\w*[^0-9]{0,20}1000\s*кг|1000\s*кг)",
            "one speed or 1000 kg wheel mass",
        ),
    ),
    ("46trkeb",): (
        (r"\b380\s*[вv]\b", "380 V"),
        (_diameter_range_pattern(14, 26), "14-26"),
        (
            r"(?:односкорост|одна скорость|количество скоростей[^0-9]{0,20}1|"
            r"максимальн\w* (?:вес|масса) колес\w*[^0-9]{0,20}1000\s*кг|1000\s*кг)",
            "one speed or 1000 kg wheel mass",
        ),
    ),
    ("vt63",): (
        (r"vt\s*[-_.]?\s*63\s*[-_.]?\s*5005", "VT-63.5005 article"),
        (r"\b220\s*[вv]\b", "220 V"),
        (r"(?:ral\s*5005|синий)", "blue RAL5005"),
        (r"(?:lcd|жк)", "LCD display"),
        (r"(?:лазер|laser)", "laser"),
        (r"(?:уз|sonar|ультразвук)", "ultrasonic sensor"),
    ),
    ("4523",): (
        (r"\b220\s*[вv]\b", "220 V"),
        (_diameter_range_pattern(10, 24), "10-24"),
        (r"(?:автоматическ\w* ввод\w* (?:двух|2х|2-х) параметр|автоввод)", "automatic input"),
    ),
    ("4523n1b",): (
        (r"\b220\s*[вv]\b", "220 V"),
        (_diameter_range_pattern(10, 24), "10-24"),
        (r"(?:лазер|laser)", "laser"),
        (r"(?:автоматическ\w* ввод\w* (?:двух|2х|2-х) параметр|автоввод)", "automatic input"),
    ),
    ("45trke",): ((r"\b220\s*[вv]\b", "220 V"), (r"150\s*кг", "150 kg")),
    ("4638nb",): (
        (r"\b220\s*[вv]\b", "220 V"),
        (r"(?:односкорост|количество скоростей[^0-9]{0,20}1)", "one speed"),
    ),
    ("p7204", "mc4"): ((r"(?:четыре|4)[^\n]{0,40}камер", "four cameras"),),
    ("46trke56b",): (
        (r"\b380\s*[вv]\b", "380 V"),
        (_diameter_range_pattern(14, 56), "14-56"),
        (r"(?:двухскорост|2\s*скорост)", "two speeds"),
    ),
    ("4641n",): ((r"\b380\s*[вv]\b", "380 V"), (r"(?:двухскорост|2\s*скорост)", "two speeds")),
    ("vt64", "220в", "ral5005"): ((r"\b220\s*[вv]\b", "220 V"), (r"ral\s*5005", "RAL5005")),
    ("es950",): (
        (r"\b380\s*[вv]\b", "380 V"),
        (r"12\s*-\s*24", "12-24"),
        (r"1[,.]5\s*[\"″]?\s*-\s*20", "1.5-20"),
        (r"1200\s*мм", "1200 mm wheel diameter"),
        (r"150\s*кг", "150 kg wheel mass"),
        (r"(?:вал|диаметр вала)[^\n]{0,30}40\s*мм", "40 mm shaft"),
        (r"пневм\w*\s*подъ[её]мник", "pneumatic lift"),
    ),
    ("v26",): (
        (r"\b380\s*[вv]\b", "380 V"),
        (r"14\s*-\s*26", "14-26"),
        (r"1500\s*мм", "1500 mm wheel diameter"),
        (r"760\s*мм", "760 mm wheel width"),
        (r"(?:вес|масса)[^\n]{0,40}(?:1500\s*кг|кг[^\n]{0,10}1500)", "1500 kg wheel mass"),
    ),
    ("4523c",): (
        (r"\b220\s*[вv]\b", "220 V"),
        (r"10\s*-\s*24", "10-24"),
        (r"1[,.]5\s*[\"″]?\s*-\s*20", "1.5-20"),
        (r"(?:вал|диаметр вала)[^\n]{0,30}40\s*мм", "40 mm shaft"),
        (r"(?:65\s*кг|кг[^0-9]{0,10}65)", "65 kg wheel mass"),
        (r"ручн\w*\s+ввод", "manual input"),
    ),
    ("4523a",): (
        (r"\b220\s*[вv]\b", "220 V"),
        (_diameter_range_pattern(10, 24), "10-24"),
        (r"(?:автоматическ\w* ввод\w* (?:тр[её]х|3)[^\n]{0,30}параметр|измерение ширины диска[^\n]{0,30}автомат)", "three-parameter automatic input"),
        (r"(?:65\s*кг|кг[^0-9]{0,10}65)", "65 kg wheel mass"),
        (r"(?:вал|диаметр вала)[^\n]{0,30}40\s*мм", "40 mm shaft"),
    ),
    ("4524cb",): (
        (r"\b220\s*[вv]\b", "220 V"),
        (_diameter_range_pattern(10, 24), "10-24"),
        (r"ручн\w*\s+ввод", "manual input"),
        (r"(?:6|шесть)[^\n]{0,30}программ", "six programs"),
    ),
    ("t300", "380"): (
        (r"\b380\s*[вv]\b", "380 V"),
        (r"полуавтомат", "semi-automatic type"),
        (r"10\s*-\s*21", "10-21 outside clamping"),
        (r"12\s*-\s*24", "12-24 inside clamping"),
        (r"1140\s*мм", "1140 mm wheel diameter"),
        (r"355\s*мм", "355 mm wheel width"),
    ),
    ("v524",): (
        (r"v\s*-?\s*524[.\s-]*380[.\s-]*5005", "V524.380.5005 article"),
        (r"\b380\s*[вv]\b", "380 V"),
        (r"10\s*-\s*20", "10-20 outside clamping"),
        (r"12\s*-\s*24", "12-24 inside clamping"),
        (r"980\s*мм", "980 mm wheel diameter"),
    ),
    ("vt61",): (
        (r"vt\s*-?\s*61[_\s-]*5005", "VT-61_5005 article"),
        (r"\b220\s*[вv]\b", "220 V"),
        (r"ral\s*5005", "RAL5005"),
        (r"1[,.]5\s*[\"″]?\s*-\s*20", "1.5-20"),
        (r"1000\s*мм", "1000 mm wheel diameter"),
        (r"65\s*кг", "65 kg wheel mass"),
        (r"(?:вал|диаметр вала)[^\n]{0,30}40\s*мм", "40 mm shaft"),
        (r"(?:автоматическ\w* ввод\w* (?:двух|2)[^\n]{0,30}параметр|электронн\w* линейк)", "two-parameter input"),
    ),
    ("gl3",): (
        (r"(?:стен|сэндвич-панел)[^\n]{0,80}50\s*мм", "50 mm walls"),
        (r"(?:основан|цокол)[^\n]{0,80}(?:300\s*мм|30\s*см)", "300 mm base"),
        (r"40[^\n]{0,40}(?:ламп|светильник)[^\n]{0,80}16[^\n]{0,40}(?:ламп|светильник)", "40+16 lights"),
        (r"(?:приточн\w* блок)[^\n]{0,40}7[,.]5\s*квт", "7.5 kW inlet fan"),
        (r"(?:экстрактор|вытяжн\w* блок)[^\n]{0,40}5[,.]5\s*квт", "5.5 kW exhaust fan"),
        (r"22000\s*м", "22000 m3/h airflow"),
        (r"riello\s*g20[^\n]{0,80}202\s*квт", "Riello G20 202 kW burner"),
        (r"потреблен[^\n]{0,40}15\s*квт", "15 kW electric power"),
    ),
    ("standart",): (
        (
            r"(?:6[,.]9\s*[xх×]\s*3[,.]9\s*[xх×]\s*2[,.]65|"
            r"6900\s*[xх×]\s*3900\s*[xх×]\s*2650)",
            "6.9 x 3.9 x 2.65 m internal size",
        ),
        (r"высота основан[^\n]{0,30}(?:300\s*мм|мм[^0-9]{0,10}300)", "300 mm base"),
        (r"riello\s*f40[^\n]{0,30}g20", "Riello F40 G20 burner"),
        (r"толщина[^\n]{0,30}50\s*мм", "50 mm walls"),
        (r"(?:приток|вытяж)[^\n]{0,50}7[,.]5\s*квт", "7.5 kW ventilation"),
        (r"25000\s*м", "25000 m3/h airflow"),
    ),
}


_FORBIDDEN_QUALIFIER_RULES: dict[tuple[str, ...], tuple[tuple[str, str], ...]] = {
    ("46trkb",): ((r"(?:двухскорост|2\s*скорост)", "two-speed conflicting version"),),
    ("46trkeb",): ((r"(?:двухскорост|2\s*скорост)", "two-speed conflicting version"),),
}


_VISIBLE_IDENTITY_ALIASES: dict[tuple[str, ...], tuple[str, ...]] = {
    # The live card heading is shortened to "ROSSVIK VT-64 (синий)". Voltage and
    # RAL are still mandatory below and are checked by _EXACT_QUALIFIER_RULES.
    ("vt64", "220в", "ral5005"): ("vt64",),
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


def _scoped_visible_text(
    parser: _VisibleTextParser,
    profile: VisibleProductProfile,
    *,
    stop_at_recommendations: bool = True,
) -> str:
    visible_text = " ".join(" ".join(parser.text).split())
    lowered = visible_text.casefold()
    heading_indexes = [lowered.find(heading.casefold()) for heading in parser.headings]
    heading_indexes = [index for index in heading_indexes if index >= 0]
    if heading_indexes:
        visible_text = visible_text[min(heading_indexes) :]
    if not stop_at_recommendations:
        return visible_text
    lowered = visible_text.casefold()
    stop_indexes = [lowered.find(marker.casefold()) for marker in profile.stop_markers]
    stop_indexes = [index for index in stop_indexes if index >= 0]
    return visible_text[: min(stop_indexes)] if stop_indexes else visible_text


def validate_visible_product_qualifiers(
    html: str,
    expected_name: str,
    profile: VisibleProductProfile,
) -> None:
    requirements = _EXACT_QUALIFIER_RULES.get(identity_tokens(expected_name), ())
    if not requirements:
        return
    parser = _VisibleTextParser()
    parser.feed(html)
    evidence = normalized_text(
        _scoped_visible_text(parser, profile, stop_at_recommendations=False)
    )
    for pattern, label in requirements:
        if re.search(pattern, evidence, re.IGNORECASE) is None:
            raise PermanentCollectionError(
                f"Required exact product qualifier is missing: {label}",
                code="missing_product_specification",
            )
    scoped_evidence = normalized_text(_scoped_visible_text(parser, profile))
    for pattern, label in _FORBIDDEN_QUALIFIER_RULES.get(identity_tokens(expected_name), ()):
        if re.search(pattern, scoped_evidence, re.IGNORECASE) is not None:
            raise PermanentCollectionError(
                f"Conflicting product qualifier is present: {label}",
                code="conflicting_product_specification",
            )


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
            expected_tokens = identity_tokens(expected_name)
            required_alias_tokens = _VISIBLE_IDENTITY_ALIASES.get(expected_tokens)
            candidate_tokens = identity_tokens(candidate)
            if required_alias_tokens and all(
                token in candidate_tokens for token in required_alias_tokens
            ):
                name = candidate
                break
    if name is None:
        raise identity_errors[0]

    visible_text = _scoped_visible_text(parser, profile)
    validate_visible_product_qualifiers(html, expected_name, profile)

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
