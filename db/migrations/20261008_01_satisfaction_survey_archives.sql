BEGIN;

ALTER TABLE satisfaction_surveys
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS satisfaction_surveys_archived_idx
  ON satisfaction_surveys(archived_at)
  WHERE archived_at IS NOT NULL;

COMMIT;
