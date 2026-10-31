CREATE TABLE products (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_key text NOT NULL UNIQUE,
    name text NOT NULL,
    brand text,
    article text,
    own_url text,
    catalog_scope text NOT NULL,
    priority smallint NOT NULL DEFAULT 100,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT products_catalog_scope_check
        CHECK (catalog_scope IN ('required', 'additional', 'component')),
    CONSTRAINT products_priority_check
        CHECK (priority >= 0),
    CONSTRAINT products_own_url_check
        CHECK (own_url IS NULL OR own_url ~ '^https?://')
);

CREATE TABLE product_specs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    spec_key text NOT NULL,
    raw_value text,
    normalized_text text,
    normalized_number numeric,
    unit text,
    is_material boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT product_specs_value_check
        CHECK (
            raw_value IS NOT NULL
            OR normalized_text IS NOT NULL
            OR normalized_number IS NOT NULL
        ),
    CONSTRAINT product_specs_product_key_unique
        UNIQUE (product_id, spec_key)
);

CREATE TABLE product_components (
    bundle_product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    component_product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity numeric(12, 4) NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (bundle_product_id, component_product_id),
    CONSTRAINT product_components_quantity_check
        CHECK (quantity > 0),
    CONSTRAINT product_components_not_self_check
        CHECK (bundle_product_id <> component_product_id)
);

CREATE TABLE sellers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    external_key text NOT NULL UNIQUE,
    display_name text NOT NULL,
    legal_name text,
    website_url text,
    region text,
    official_status text NOT NULL DEFAULT 'unknown',
    official_evidence_url text,
    official_verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT sellers_official_status_check
        CHECK (
            official_status IN (
                'unknown',
                'self_claimed',
                'verified_dealer',
                'manufacturer'
            )
        ),
    CONSTRAINT sellers_website_url_check
        CHECK (website_url IS NULL OR website_url ~ '^https?://'),
    CONSTRAINT sellers_evidence_url_check
        CHECK (
            official_evidence_url IS NULL
            OR official_evidence_url ~ '^https?://'
        )
);

CREATE TABLE sources (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    seller_id uuid REFERENCES sellers(id) ON DELETE RESTRICT,
    external_key text NOT NULL UNIQUE,
    name text NOT NULL,
    base_url text,
    domain text,
    source_type text NOT NULL,
    official_status text NOT NULL DEFAULT 'unknown',
    official_evidence_url text,
    collection_method text NOT NULL DEFAULT 'http',
    request_timeout_seconds integer NOT NULL DEFAULT 20,
    max_retries smallint NOT NULL DEFAULT 3,
    rate_limit_per_host numeric(8, 3) NOT NULL DEFAULT 1,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT sources_type_check
        CHECK (
            source_type IN (
                'manufacturer',
                'official_dealer',
                'retailer',
                'marketplace',
                'manual'
            )
        ),
    CONSTRAINT sources_official_status_check
        CHECK (
            official_status IN (
                'unknown',
                'self_claimed',
                'verified_dealer',
                'manufacturer'
            )
        ),
    CONSTRAINT sources_collection_method_check
        CHECK (collection_method IN ('http', 'playwright', 'manual')),
    CONSTRAINT sources_timeout_check
        CHECK (request_timeout_seconds > 0),
    CONSTRAINT sources_retries_check
        CHECK (max_retries >= 0),
    CONSTRAINT sources_rate_limit_check
        CHECK (rate_limit_per_host > 0),
    CONSTRAINT sources_base_url_check
        CHECK (base_url IS NULL OR base_url ~ '^https?://'),
    CONSTRAINT sources_evidence_url_check
        CHECK (
            official_evidence_url IS NULL
            OR official_evidence_url ~ '^https?://'
        )
);

CREATE TABLE offers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    seller_id uuid NOT NULL REFERENCES sellers(id) ON DELETE RESTRICT,
    source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    competitor_url text NOT NULL,
    seller_article text,
    match_status text NOT NULL DEFAULT 'review',
    match_reason text,
    is_active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT offers_match_status_check
        CHECK (match_status IN ('exact', 'review', 'rejected')),
    CONSTRAINT offers_url_check
        CHECK (competitor_url ~ '^https?://'),
    CONSTRAINT offers_product_source_url_unique
        UNIQUE (product_id, source_id, competitor_url)
);

CREATE TABLE collection_jobs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    job_key text UNIQUE,
    trigger_type text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    scheduled_for timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    locked_at timestamptz,
    locked_by text,
    summary jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT collection_jobs_trigger_type_check
        CHECK (trigger_type IN ('manual', 'scheduled')),
    CONSTRAINT collection_jobs_status_check
        CHECK (
            status IN (
                'pending',
                'running',
                'partial_success',
                'success',
                'failed'
            )
        ),
    CONSTRAINT collection_jobs_time_order_check
        CHECK (
            finished_at IS NULL
            OR started_at IS NULL
            OR finished_at >= started_at
        )
);

CREATE TABLE collection_attempts (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES collection_jobs(id) ON DELETE RESTRICT,
    source_id uuid NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    offer_id uuid REFERENCES offers(id) ON DELETE RESTRICT,
    attempt_number smallint NOT NULL DEFAULT 1,
    method text NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    http_status integer,
    started_at timestamptz,
    finished_at timestamptz,
    error_code text,
    error_message text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT collection_attempts_number_check
        CHECK (attempt_number > 0),
    CONSTRAINT collection_attempts_method_check
        CHECK (method IN ('http', 'playwright', 'manual')),
    CONSTRAINT collection_attempts_status_check
        CHECK (
            status IN (
                'pending',
                'running',
                'success',
                'failed',
                'skipped'
            )
        ),
    CONSTRAINT collection_attempts_http_status_check
        CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
    CONSTRAINT collection_attempts_time_order_check
        CHECK (
            finished_at IS NULL
            OR started_at IS NULL
            OR finished_at >= started_at
        ),
    CONSTRAINT collection_attempts_job_offer_number_unique
        UNIQUE NULLS NOT DISTINCT (job_id, offer_id, attempt_number)
);

CREATE TABLE price_observations (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id uuid NOT NULL REFERENCES collection_jobs(id) ON DELETE RESTRICT,
    attempt_id bigint NOT NULL REFERENCES collection_attempts(id) ON DELETE RESTRICT,
    offer_id uuid NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
    raw_price numeric(14, 2),
    normalized_price numeric(14, 2),
    currency char(3) NOT NULL DEFAULT 'RUB',
    source_quantity numeric(12, 4),
    normalized_quantity numeric(12, 4),
    unit text,
    price_type text NOT NULL DEFAULT 'unknown',
    vat_included boolean,
    vat_rate numeric(5, 2),
    stock_status text,
    region text,
    delivery_included boolean,
    installation_included boolean,
    observed_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    method text NOT NULL,
    reliability text NOT NULL,
    exclusion_reason text,
    evidence_text text,
    evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
    collector_version text,
    source_payload_hash text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT price_observations_raw_price_check
        CHECK (raw_price IS NULL OR raw_price > 0),
    CONSTRAINT price_observations_normalized_price_check
        CHECK (normalized_price IS NULL OR normalized_price > 0),
    CONSTRAINT price_observations_source_quantity_check
        CHECK (source_quantity IS NULL OR source_quantity > 0),
    CONSTRAINT price_observations_normalized_quantity_check
        CHECK (normalized_quantity IS NULL OR normalized_quantity > 0),
    CONSTRAINT price_observations_currency_check
        CHECK (currency ~ '^[A-Z]{3}$'),
    CONSTRAINT price_observations_price_type_check
        CHECK (price_type IN ('rrp', 'retail', 'sale', 'quote', 'unknown')),
    CONSTRAINT price_observations_vat_rate_check
        CHECK (vat_rate IS NULL OR vat_rate BETWEEN 0 AND 100),
    CONSTRAINT price_observations_method_check
        CHECK (method IN ('auto', 'manual')),
    CONSTRAINT price_observations_reliability_check
        CHECK (reliability IN ('valid', 'review', 'unreliable')),
    CONSTRAINT price_observations_valid_price_check
        CHECK (
            reliability <> 'valid'
            OR (
                raw_price IS NOT NULL
                AND normalized_price IS NOT NULL
                AND normalized_quantity IS NOT NULL
                AND unit IS NOT NULL
            )
        ),
    CONSTRAINT price_observations_exclusion_reason_check
        CHECK (
            reliability = 'valid'
            OR exclusion_reason IS NOT NULL
        )
);

CREATE TABLE app_settings (
    key text PRIMARY KEY,
    value jsonb NOT NULL,
    description text,
    is_secret boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT app_settings_no_secrets_check
        CHECK (is_secret = false)
);

CREATE INDEX product_specs_product_id_idx
    ON product_specs(product_id);
CREATE INDEX product_components_component_id_idx
    ON product_components(component_product_id);
CREATE INDEX sources_seller_id_idx
    ON sources(seller_id);
CREATE INDEX offers_product_id_idx
    ON offers(product_id);
CREATE INDEX offers_seller_id_idx
    ON offers(seller_id);
CREATE INDEX offers_source_id_idx
    ON offers(source_id);
CREATE INDEX collection_jobs_status_created_idx
    ON collection_jobs(status, created_at);
CREATE INDEX collection_jobs_scheduled_for_idx
    ON collection_jobs(scheduled_for)
    WHERE status = 'pending';
CREATE INDEX collection_attempts_job_id_idx
    ON collection_attempts(job_id);
CREATE INDEX collection_attempts_source_id_idx
    ON collection_attempts(source_id);
CREATE INDEX collection_attempts_offer_id_idx
    ON collection_attempts(offer_id);
CREATE INDEX price_observations_offer_received_idx
    ON price_observations(offer_id, received_at DESC, id DESC);
CREATE INDEX price_observations_job_id_idx
    ON price_observations(job_id);
CREATE INDEX price_observations_reliability_idx
    ON price_observations(reliability, received_at DESC);

CREATE FUNCTION reject_price_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION
        'price_observations is append-only: % is forbidden',
        TG_OP
        USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER price_observations_reject_update_delete
BEFORE UPDATE OR DELETE ON price_observations
FOR EACH ROW
EXECUTE FUNCTION reject_price_observation_mutation();

CREATE TRIGGER price_observations_reject_truncate
BEFORE TRUNCATE ON price_observations
FOR EACH STATEMENT
EXECUTE FUNCTION reject_price_observation_mutation();

CREATE VIEW current_valid_prices AS
SELECT DISTINCT ON (po.offer_id)
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
    po.delivery_included,
    po.installation_included,
    po.observed_at,
    po.received_at,
    po.method,
    po.collector_version
FROM price_observations po
JOIN offers o ON o.id = po.offer_id
WHERE po.reliability = 'valid'
ORDER BY po.offer_id, po.received_at DESC, po.id DESC;

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

INSERT INTO app_settings (key, value, description)
VALUES
    (
        'collection_cron',
        to_jsonb('0 3 * * *'::text),
        'Daily collection schedule in cron format'
    ),
    (
        'timezone',
        to_jsonb('Europe/Moscow'::text),
        'Timezone used for scheduling and display'
    ),
    (
        'bundle_policy',
        to_jsonb('same_seller_only'::text),
        'Both competitor bundle components must come from one seller'
    );
