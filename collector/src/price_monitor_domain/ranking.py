from .model import OfficialStatus, PriceType, PricedOffer


_SOURCE_PRIORITY = {
    OfficialStatus.MANUFACTURER: 0,
    OfficialStatus.OFFICIAL_DEALER: 1,
    OfficialStatus.VERIFIED_RETAILER: 2,
    OfficialStatus.UNKNOWN: 3,
}


def preferred_offers(offers: list[PricedOffer], price_type: PriceType) -> list[PricedOffer]:
    eligible = [
        offer
        for offer in offers
        if offer.price.eligible_for_comparison and offer.price.price_type is price_type
    ]
    return sorted(eligible, key=lambda offer: (_SOURCE_PRIORITY[offer.official_status], offer.source_id))
