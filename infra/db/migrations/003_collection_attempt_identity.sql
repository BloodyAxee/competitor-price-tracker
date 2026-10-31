ALTER TABLE collection_attempts
    DROP CONSTRAINT collection_attempts_job_offer_number_unique;

ALTER TABLE collection_attempts
    ADD CONSTRAINT collection_attempts_job_source_offer_number_unique
    UNIQUE NULLS NOT DISTINCT (
        job_id,
        source_id,
        offer_id,
        attempt_number
    );
