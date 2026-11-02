ALTER TABLE offers
    ADD COLUMN collect_in_fast_mode boolean NOT NULL DEFAULT false;

ALTER TABLE collection_jobs
    ADD COLUMN collection_mode text NOT NULL DEFAULT 'full';

ALTER TABLE collection_jobs
    ADD CONSTRAINT collection_jobs_collection_mode_check
    CHECK (collection_mode IN ('fast', 'full'));

UPDATE offers AS offer
SET collect_in_fast_mode = true
FROM sources AS source, products AS product
WHERE source.id = offer.source_id
  AND product.id = offer.product_id
  AND offer.is_active
  AND source.is_active
  AND source.collection_method <> 'manual'
  AND (
      source.domain = 'centr-to.ru'
      OR (
          offer.match_status = 'exact'
          AND offer.match_reason LIKE 'Основной источник.%'
          AND source.domain <> 'topmaster-shop.ru'
      )
      OR (
          product.catalog_scope = 'component'
          AND offer.match_status = 'exact'
          AND source.domain <> 'topmaster-shop.ru'
      )
  );

CREATE INDEX offers_fast_collection_idx
    ON offers(source_id, id)
    WHERE is_active AND collect_in_fast_mode;
