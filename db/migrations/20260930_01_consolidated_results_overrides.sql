BEGIN;

CREATE TABLE IF NOT EXISTS training_result_overrides (
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  evaluation_key text NOT NULL,
  score_percent numeric(5,2) NOT NULL CHECK (score_percent >= 0 AND score_percent <= 100),
  original_score_percent numeric(5,2) NOT NULL CHECK (original_score_percent >= 0 AND original_score_percent <= 100),
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id,user_id,evaluation_key),
  CONSTRAINT training_result_overrides_key_format CHECK (
    evaluation_key = 'practice'
    OR evaluation_key ~ '^(quiz|final_exam|experience_exam):[0-9a-fA-F-]{36}$'
  )
);

CREATE INDEX IF NOT EXISTS training_result_overrides_user_idx
  ON training_result_overrides(user_id,group_id);

COMMIT;
