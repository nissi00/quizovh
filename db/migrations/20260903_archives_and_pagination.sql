BEGIN;

ALTER TABLE app_users ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);
ALTER TABLE questions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE questions ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);
ALTER TABLE training_groups ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE training_groups ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);
ALTER TABLE final_exams ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE final_exams ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);
ALTER TABLE practical_experiences ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE practical_experiences ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE certificates ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);

CREATE INDEX IF NOT EXISTS app_users_archived_idx ON app_users(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS questions_archived_idx ON questions(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS training_groups_archived_idx ON training_groups(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS live_sessions_archived_idx ON live_sessions(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS final_exams_archived_idx ON final_exams(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS practical_experiences_archived_idx ON practical_experiences(archived_at) WHERE archived_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS certificates_archived_idx ON certificates(archived_at) WHERE archived_at IS NOT NULL;

COMMIT;
