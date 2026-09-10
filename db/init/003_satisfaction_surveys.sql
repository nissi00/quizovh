BEGIN;

CREATE TABLE IF NOT EXISTS satisfaction_surveys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  code varchar(8) NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE INDEX IF NOT EXISTS satisfaction_surveys_group_idx
  ON satisfaction_surveys(group_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS satisfaction_surveys_one_open_per_group_idx
  ON satisfaction_surveys(group_id) WHERE status='open';

CREATE TABLE IF NOT EXISTS satisfaction_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  survey_id uuid NOT NULL REFERENCES satisfaction_surveys(id) ON DELETE CASCADE,
  response_token_hash char(64) NOT NULL,
  answers jsonb NOT NULL CHECK (jsonb_typeof(answers)='object'),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (survey_id, response_token_hash)
);

CREATE INDEX IF NOT EXISTS satisfaction_responses_survey_idx
  ON satisfaction_responses(survey_id, submitted_at DESC);

COMMIT;
