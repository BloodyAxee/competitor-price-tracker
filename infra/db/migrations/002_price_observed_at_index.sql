CREATE INDEX price_observations_observed_at_idx
    ON price_observations(observed_at DESC)
    WHERE observed_at IS NOT NULL;
