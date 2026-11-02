CREATE TABLE price_regions (
    code text PRIMARY KEY,
    name text NOT NULL UNIQUE,
    city text NOT NULL,
    federal_district text NOT NULL,
    sort_order smallint NOT NULL UNIQUE,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT price_regions_code_check CHECK (code ~ '^[a-z][a-z0-9-]*$'),
    CONSTRAINT price_regions_sort_order_check CHECK (sort_order > 0)
);

INSERT INTO price_regions (code, name, city, federal_district, sort_order)
VALUES
    ('moscow', 'Москва', 'Москва', 'Центральный', 10),
    ('saint-petersburg', 'Санкт-Петербург', 'Санкт-Петербург', 'Северо-Западный', 20),
    ('kazan', 'Казань', 'Казань', 'Приволжский', 30),
    ('yekaterinburg', 'Екатеринбург', 'Екатеринбург', 'Уральский', 40),
    ('krasnodar', 'Краснодар', 'Краснодар', 'Южный', 50),
    ('novosibirsk', 'Новосибирск', 'Новосибирск', 'Сибирский', 60),
    ('khabarovsk', 'Хабаровск', 'Хабаровск', 'Дальневосточный', 70);

ALTER TABLE price_observations
    ADD COLUMN region_code text REFERENCES price_regions(code) ON DELETE RESTRICT;

CREATE INDEX price_observations_region_offer_received_idx
    ON price_observations(region_code, offer_id, received_at DESC, id DESC)
    WHERE region_code IS NOT NULL;

DROP VIEW comparison_candidates;
DROP VIEW current_valid_prices;

CREATE VIEW current_valid_prices AS
SELECT DISTINCT ON (po.offer_id, po.region_code)
    po.id,
    po.offer_id,
    o.product_id,
    o.seller_id,
    o.source_id,
    po.normalized_price,
    po.currency,
    po.unit,
    po.price_type,
    po.vat_included,
    po.vat_rate,
    po.stock_status,
    po.region,
    po.region_code,
    po.delivery_included,
    po.installation_included,
    po.observed_at,
    po.received_at,
    po.method,
    po.collector_version
FROM price_observations po
JOIN offers o ON o.id = po.offer_id
WHERE po.reliability = 'valid'
ORDER BY po.offer_id, po.region_code, po.received_at DESC, po.id DESC;

CREATE VIEW comparison_candidates AS
SELECT
    cvp.*,
    o.competitor_url,
    o.seller_article,
    s.display_name AS seller_name,
    src.name AS source_name,
    src.source_type,
    src.official_status,
    CASE
        WHEN src.source_type = 'manufacturer' THEN 1
        WHEN src.official_status = 'verified_dealer' THEN 2
        WHEN src.source_type = 'retailer' THEN 3
        WHEN src.source_type = 'marketplace' THEN 4
        ELSE 5
    END AS source_priority
FROM current_valid_prices cvp
JOIN offers o ON o.id = cvp.offer_id
JOIN sellers s ON s.id = o.seller_id
JOIN sources src ON src.id = o.source_id
WHERE o.match_status = 'exact'
  AND o.is_active
  AND src.is_active;
