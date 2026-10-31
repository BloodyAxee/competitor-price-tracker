import re
import unicodedata

from .model import MatchDecision, MatchStatus, ProductIdentity


def _canonical(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    return re.sub(r"\s+", " ", normalized)


def match_products(required: ProductIdentity, observed: ProductIdentity) -> MatchDecision:
    if _canonical(required.brand) != _canonical(observed.brand):
        return MatchDecision(MatchStatus.UNRELIABLE, "brand_mismatch")

    if _canonical(required.model) != _canonical(observed.model):
        return MatchDecision(MatchStatus.UNRELIABLE, "model_mismatch")

    if required.article:
        if not observed.article:
            return MatchDecision(MatchStatus.REVIEW, "missing_article")
        if _canonical(required.article) != _canonical(observed.article):
            return MatchDecision(MatchStatus.UNRELIABLE, "article_mismatch")

    observed_specs = {_canonical(key): _canonical(value) for key, value in observed.material_specs.items()}
    for key, required_value in required.material_specs.items():
        canonical_key = _canonical(key)
        observed_value = observed_specs.get(canonical_key)
        if observed_value is None:
            return MatchDecision(MatchStatus.REVIEW, f"missing_spec:{key}")
        if _canonical(required_value) != observed_value:
            return MatchDecision(MatchStatus.UNRELIABLE, f"spec_conflict:{key}")

    return MatchDecision(MatchStatus.EXACT)
