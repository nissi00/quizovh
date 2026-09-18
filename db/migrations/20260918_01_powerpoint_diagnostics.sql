BEGIN;

CREATE TABLE IF NOT EXISTS powerpoint_request_metrics (
  minute timestamptz NOT NULL,
  instance_id varchar(80) NOT NULL,
  ip_hash char(16) NOT NULL,
  endpoint varchar(160) NOT NULL,
  http_status integer NOT NULL CHECK(http_status BETWEEN 100 AND 599),
  request_count integer NOT NULL DEFAULT 0 CHECK(request_count >= 0),
  duration_total_ms bigint NOT NULL DEFAULT 0 CHECK(duration_total_ms >= 0),
  duration_max_ms integer NOT NULL DEFAULT 0 CHECK(duration_max_ms >= 0),
  PRIMARY KEY(minute,instance_id,ip_hash,endpoint,http_status)
);

CREATE INDEX IF NOT EXISTS powerpoint_request_metrics_minute_idx
  ON powerpoint_request_metrics(minute DESC);

CREATE TABLE IF NOT EXISTS powerpoint_diagnostic_events (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  request_id varchar(80) NOT NULL,
  instance_id varchar(80) NOT NULL,
  sequence_number bigint,
  mode varchar(20),
  endpoint varchar(160) NOT NULL,
  source varchar(20) NOT NULL CHECK(source IN ('server','client')),
  http_status integer CHECK(http_status BETWEEN 100 AND 599),
  duration_ms integer CHECK(duration_ms >= 0),
  error_kind varchar(60) NOT NULL,
  error_message varchar(240),
  ip_hash char(16) NOT NULL,
  UNIQUE(source,request_id)
);

CREATE INDEX IF NOT EXISTS powerpoint_diagnostic_events_occurred_idx
  ON powerpoint_diagnostic_events(occurred_at DESC);

COMMIT;
