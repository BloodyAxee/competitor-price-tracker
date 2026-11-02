ALTER TABLE offers
    ADD COLUMN comparison_profile jsonb;

ALTER TABLE offers
    DROP CONSTRAINT offers_match_status_check;

ALTER TABLE offers
    ADD CONSTRAINT offers_match_status_check
    CHECK (match_status IN ('exact', 'comparable', 'review', 'rejected'));

ALTER TABLE offers
    ADD CONSTRAINT offers_comparison_profile_object_check
    CHECK (comparison_profile IS NULL OR jsonb_typeof(comparison_profile) = 'object');

ALTER TABLE offers
    ADD CONSTRAINT offers_comparable_profile_check
    CHECK (match_status <> 'comparable' OR comparison_profile IS NOT NULL);

CREATE INDEX offers_comparable_idx
    ON offers(product_id, id)
    WHERE is_active AND match_status = 'comparable';
