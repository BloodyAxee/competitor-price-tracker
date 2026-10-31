BEGIN;

DO $$
DECLARE
    required_relation text;
BEGIN
    FOREACH required_relation IN ARRAY ARRAY[
        'products',
        'product_specs',
        'product_components',
        'sellers',
        'sources',
        'offers',
        'collection_jobs',
        'collection_attempts',
        'price_observations',
        'app_settings',
        'current_valid_prices',
        'comparison_candidates'
    ]
    LOOP
        IF to_regclass('public.' || required_relation) IS NULL THEN
            RAISE EXCEPTION 'Missing relation: %', required_relation;
        END IF;
    END LOOP;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'collection_attempts'::regclass
          AND conname = 'collection_attempts_job_source_offer_number_unique'
          AND pg_get_constraintdef(oid) LIKE
              'UNIQUE NULLS NOT DISTINCT (job_id, source_id, offer_id, attempt_number)%'
    ) THEN
        RAISE EXCEPTION 'Missing source-aware collection attempt identity';
    END IF;
END;
$$;

INSERT INTO products (
    external_key,
    name,
    brand,
    article,
    own_url,
    catalog_scope
)
VALUES (
    'test-t300-380',
    'T300 380 test',
    'СТАНКОИМПОРТ',
    'T300 380V',
    'https://example.test/own/t300',
    'required'
);

INSERT INTO sellers (
    external_key,
    display_name,
    website_url,
    official_status
)
VALUES (
    'test-seller',
    'Test seller',
    'https://example.test',
    'verified_dealer'
);

INSERT INTO sources (
    seller_id,
    external_key,
    name,
    base_url,
    domain,
    source_type,
    official_status,
    collection_method
)
SELECT
    id,
    'test-source',
    'Test source',
    'https://example.test',
    'example.test',
    'official_dealer',
    'verified_dealer',
    'http'
FROM sellers
WHERE external_key = 'test-seller';

INSERT INTO offers (
    product_id,
    seller_id,
    source_id,
    competitor_url,
    seller_article,
    match_status
)
SELECT
    p.id,
    s.id,
    src.id,
    'https://example.test/t300',
    'T300 380V',
    'exact'
FROM products p
CROSS JOIN sellers s
CROSS JOIN sources src
WHERE p.external_key = 'test-t300-380'
  AND s.external_key = 'test-seller'
  AND src.external_key = 'test-source';

INSERT INTO collection_jobs (
    job_key,
    trigger_type,
    status,
    started_at
)
VALUES (
    'test-job',
    'manual',
    'running',
    clock_timestamp()
);

INSERT INTO collection_attempts (
    job_id,
    source_id,
    offer_id,
    method,
    status,
    started_at,
    finished_at
)
SELECT
    j.id,
    src.id,
    o.id,
    'http',
    'success',
    clock_timestamp(),
    clock_timestamp()
FROM collection_jobs j
CROSS JOIN sources src
CROSS JOIN offers o
WHERE j.job_key = 'test-job'
  AND src.external_key = 'test-source';

INSERT INTO price_observations (
    job_id,
    attempt_id,
    offer_id,
    raw_price,
    normalized_price,
    source_quantity,
    normalized_quantity,
    unit,
    price_type,
    observed_at,
    method,
    reliability,
    evidence_text
)
SELECT
    j.id,
    a.id,
    o.id,
    95000,
    95000,
    1,
    1,
    'item',
    'retail',
    clock_timestamp(),
    'auto',
    'valid',
    'fixture'
FROM collection_jobs j
CROSS JOIN collection_attempts a
CROSS JOIN offers o
WHERE j.job_key = 'test-job'
  AND a.job_id = j.id
  AND a.offer_id = o.id;

INSERT INTO price_observations (
    job_id,
    attempt_id,
    offer_id,
    raw_price,
    normalized_price,
    source_quantity,
    normalized_quantity,
    unit,
    price_type,
    observed_at,
    method,
    reliability,
    evidence_text
)
SELECT
    job_id,
    attempt_id,
    offer_id,
    raw_price,
    normalized_price,
    source_quantity,
    normalized_quantity,
    unit,
    price_type,
    observed_at + interval '1 minute',
    method,
    reliability,
    evidence_text
FROM price_observations;

DO $$
DECLARE
    observation_count integer;
BEGIN
    SELECT count(*) INTO observation_count FROM price_observations;
    IF observation_count <> 2 THEN
        RAISE EXCEPTION
            'Expected two append-only observations, got %',
            observation_count;
    END IF;
END;
$$;

DO $$
BEGIN
    BEGIN
        UPDATE price_observations
        SET normalized_price = 1;
        RAISE EXCEPTION 'UPDATE unexpectedly succeeded';
    EXCEPTION
        WHEN SQLSTATE '55000' THEN
            NULL;
    END;

    BEGIN
        DELETE FROM price_observations;
        RAISE EXCEPTION 'DELETE unexpectedly succeeded';
    EXCEPTION
        WHEN SQLSTATE '55000' THEN
            NULL;
    END;

    BEGIN
        EXECUTE 'TRUNCATE TABLE price_observations';
        RAISE EXCEPTION 'TRUNCATE unexpectedly succeeded';
    EXCEPTION
        WHEN SQLSTATE '55000' THEN
            NULL;
    END;
END;
$$;

DO $$
DECLARE
    current_count integer;
    comparison_count integer;
BEGIN
    SELECT count(*) INTO current_count FROM current_valid_prices;
    SELECT count(*) INTO comparison_count FROM comparison_candidates;

    IF current_count <> 1 OR comparison_count <> 1 THEN
        RAISE EXCEPTION
            'Expected one current valid price and comparison candidate, got % and %',
            current_count,
            comparison_count;
    END IF;
END;
$$;

ROLLBACK;
