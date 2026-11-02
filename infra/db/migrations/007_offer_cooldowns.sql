ALTER TABLE offers
    ADD COLUMN failure_streak smallint NOT NULL DEFAULT 0,
    ADD COLUMN cooldown_until timestamptz,
    ADD COLUMN last_collection_error_code text,
    ADD COLUMN last_collection_failure_at timestamptz,
    ADD COLUMN last_collection_success_at timestamptz,
    ADD CONSTRAINT offers_failure_streak_check CHECK (failure_streak >= 0);

CREATE INDEX offers_cooldown_idx
    ON offers(cooldown_until, id)
    WHERE is_active AND cooldown_until IS NOT NULL;

CREATE FUNCTION update_offer_collection_health()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    next_failure_streak smallint;
    has_recent_working_exact_alternative boolean;
    cooldown_interval interval;
BEGIN
    IF NEW.offer_id IS NULL OR NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF NEW.status = 'success' THEN
        UPDATE offers
        SET failure_streak = 0,
            cooldown_until = NULL,
            last_collection_error_code = NULL,
            last_collection_success_at = clock_timestamp()
        WHERE id = NEW.offer_id;
        RETURN NEW;
    END IF;

    IF NEW.status <> 'failed' OR NEW.error_code NOT IN (
        'browser_error',
        'browser_timeout',
        'network_error',
        'temporary_http_error'
    ) THEN
        IF NEW.status = 'failed' THEN
            UPDATE offers
            SET failure_streak = 0,
                last_collection_error_code = NEW.error_code,
                last_collection_failure_at = clock_timestamp()
            WHERE id = NEW.offer_id;
        END IF;
        RETURN NEW;
    END IF;

    SELECT
        CASE
            WHEN offer.last_collection_error_code = NEW.error_code
                THEN LEAST(offer.failure_streak + 1, 32767)::smallint
            ELSE 1::smallint
        END,
        EXISTS (
            SELECT 1
            FROM offers alternative
            JOIN price_observations observation
              ON observation.offer_id = alternative.id
             AND observation.reliability = 'valid'
             AND observation.received_at >= clock_timestamp() - interval '7 days'
            WHERE alternative.product_id = offer.product_id
              AND alternative.id <> offer.id
              AND alternative.is_active
              AND alternative.match_status = 'exact'
              AND alternative.collect_in_fast_mode
        )
    INTO next_failure_streak, has_recent_working_exact_alternative
    FROM offers offer
    WHERE offer.id = NEW.offer_id;

    IF next_failure_streak IS NULL THEN
        RETURN NEW;
    END IF;

    cooldown_interval := CASE
        WHEN next_failure_streak >= 4 THEN interval '24 hours'
        WHEN next_failure_streak = 3 THEN interval '6 hours'
        ELSE interval '1 hour'
    END;

    UPDATE offers
    SET failure_streak = next_failure_streak,
        cooldown_until = CASE
            WHEN next_failure_streak >= 2
             AND NOT collect_in_fast_mode
             AND has_recent_working_exact_alternative
                THEN GREATEST(
                    COALESCE(cooldown_until, '-infinity'::timestamptz),
                    clock_timestamp() + cooldown_interval
                )
            ELSE cooldown_until
        END,
        last_collection_error_code = NEW.error_code,
        last_collection_failure_at = clock_timestamp()
    WHERE id = NEW.offer_id;

    RETURN NEW;
END;
$$;

CREATE TRIGGER collection_attempt_offer_health_trigger
AFTER UPDATE OF status ON collection_attempts
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION update_offer_collection_health();
