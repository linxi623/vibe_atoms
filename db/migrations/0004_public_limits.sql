CREATE TABLE rate_limit_buckets (
  action text NOT NULL,
  scope text NOT NULL,
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (action, scope, key, window_start)
);
CREATE INDEX rate_limit_buckets_window_idx ON rate_limit_buckets(window_start);

CREATE TABLE platform_counters (
  name text PRIMARY KEY,
  count integer NOT NULL DEFAULT 0
);
