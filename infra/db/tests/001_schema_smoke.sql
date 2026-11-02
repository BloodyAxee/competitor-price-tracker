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
        'price_regions',
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
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'collection_jobs'
          AND column_name = 'collection_mode'
          AND column_default = '''full''::text'
    ) THEN
        RAISE EXCEPTION 'Missing full-default collection mode';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'offers'
          AND column_name = 'collect_in_fast_mode'
    ) THEN
        RAISE EXCEPTION 'Missing fast collection offer flag';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'offers'
          AND column_name = 'comparison_profile'
          AND data_type = 'jsonb'
    ) THEN
        RAISE EXCEPTION 'Missing comparable offer profile';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'price_observations'
          AND column_name = 'region_code'
    ) THEN
        RAISE EXCEPTION 'Missing canonical price region code';
    END IF;

    IF (SELECT count(*) FROM price_regions WHERE is_active) <> 7 THEN
        RAISE EXCEPTION 'Expected seven active regional price points';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'collection_jobs'::regclass
          AND conname = 'collection_jobs_collection_mode_check'
    ) THEN
        RAISE EXCEPTION 'Missing collection mode constraint';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'offers'::regclass
          AND conname = 'offers_comparable_profile_check'
    ) THEN
        RAISE EXCEPTION 'Missing comparable profile constraint';
    END IF;
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

DO $$
DECLARE
    stored_mode text;
BEGIN
    SELECT collection_mode INTO stored_mode
    FROM collection_jobs
    WHERE job_key = 'test-job';
    IF stored_mode <> 'full' THEN
        RAISE EXCEPTION 'Existing job path must default to full, got %', stored_mode;
    END IF;
END;
$$;

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
  AND src.external_key = 'test-source'
  AND o.source_id = src.id
  AND o.product_id = (
      SELECT id FROM products WHERE external_key = 'test-t300-380'
  );

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
    po.job_id,
    po.attempt_id,
    po.offer_id,
    po.raw_price,
    po.normalized_price,
    po.source_quantity,
    po.normalized_quantity,
    po.unit,
    po.price_type,
    po.observed_at + interval '1 minute',
    po.method,
    po.reliability,
    po.evidence_text
FROM price_observations po
JOIN collection_jobs j ON j.id = po.job_id
WHERE j.job_key = 'test-job';

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
    region,
    region_code,
    observed_at,
    method,
    reliability,
    evidence_text
)
SELECT
    po.job_id,
    po.attempt_id,
    po.offer_id,
    97500,
    97500,
    po.source_quantity,
    po.normalized_quantity,
    po.unit,
    po.price_type,
    'Москва',
    'moscow',
    po.observed_at + interval '2 minutes',
    po.method,
    po.reliability,
    'regional fixture'
FROM price_observations po
JOIN collection_jobs j ON j.id = po.job_id
WHERE j.job_key = 'test-job'
ORDER BY po.id
LIMIT 1;

DO $$
DECLARE
    observation_count integer;
BEGIN
    SELECT count(*) INTO observation_count
    FROM price_observations po
    JOIN collection_jobs j ON j.id = po.job_id
    WHERE j.job_key = 'test-job';
    IF observation_count <> 3 THEN
        RAISE EXCEPTION
            'Expected three append-only observations, got %',
            observation_count;
    END IF;
END;
$$;

DO $$
BEGIN
    BEGIN
        UPDATE price_observations
        SET normalized_price = 1
        WHERE job_id = (SELECT id FROM collection_jobs WHERE job_key = 'test-job');
        RAISE EXCEPTION 'UPDATE unexpectedly succeeded';
    EXCEPTION
        WHEN SQLSTATE '55000' THEN
            NULL;
    END;

    BEGIN
        DELETE FROM price_observations
        WHERE job_id = (SELECT id FROM collection_jobs WHERE job_key = 'test-job');
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
    SELECT count(*) INTO current_count
    FROM current_valid_prices
    WHERE product_id = (SELECT id FROM products WHERE external_key = 'test-t300-380');
    SELECT count(*) INTO comparison_count
    FROM comparison_candidates
    WHERE product_id = (SELECT id FROM products WHERE external_key = 'test-t300-380');

    IF current_count <> 2 OR comparison_count <> 2 THEN
        RAISE EXCEPTION
            'Expected separate unscoped and Moscow prices, got % and %',
            current_count,
            comparison_count;
    END IF;
END;
$$;

ROLLBACK;
