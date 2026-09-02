BEGIN;

CREATE TABLE IF NOT EXISTS training_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id uuid NOT NULL REFERENCES themes(id),
  instructor_id uuid NOT NULL REFERENCES app_users(id),
  name text NOT NULL,
  client_name text,
  start_date date NOT NULL,
  end_date date NOT NULL,
  location text,
  modality text,
  passing_score numeric(5,2) NOT NULL DEFAULT 70 CHECK(passing_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','active','finished')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(end_date >= start_date)
);
CREATE INDEX IF NOT EXISTS training_groups_theme_idx ON training_groups(theme_id);
CREATE INDEX IF NOT EXISTS training_groups_instructor_idx ON training_groups(instructor_id);

ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS group_id uuid REFERENCES training_groups(id);
CREATE INDEX IF NOT EXISTS live_sessions_group_idx ON live_sessions(group_id);

CREATE TABLE IF NOT EXISTS training_group_participants (
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id,user_id)
);
CREATE INDEX IF NOT EXISTS training_group_participants_user_idx ON training_group_participants(user_id);

CREATE TABLE IF NOT EXISTS certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  certificate_number text NOT NULL UNIQUE,
  public_token text NOT NULL UNIQUE,
  global_score numeric(5,2) NOT NULL CHECK(global_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','revoked')),
  issued_by uuid NOT NULL REFERENCES app_users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(training_group_id,user_id)
);
CREATE INDEX IF NOT EXISTS certificates_group_idx ON certificates(training_group_id);
CREATE INDEX IF NOT EXISTS certificates_public_token_idx ON certificates(public_token);

COMMIT;
