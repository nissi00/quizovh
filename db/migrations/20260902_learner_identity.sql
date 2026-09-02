BEGIN;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS participant_code varchar(12);

UPDATE app_users
SET participant_code = 'TS-' || upper(substr(md5(id::text), 1, 4)) || '-' || upper(substr(md5(id::text), 5, 4))
WHERE role = 'learner' AND participant_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_participant_code_idx
  ON app_users(participant_code)
  WHERE participant_code IS NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'participant_code_format'
      AND conrelid = 'app_users'::regclass
  ) THEN
    ALTER TABLE app_users
      ADD CONSTRAINT participant_code_format
      CHECK (participant_code IS NULL OR participant_code ~ '^TS-[A-Z0-9]{4}-[A-Z0-9]{4}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS live_answer_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  participant_id uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES answer_options(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, question_id, participant_id, option_id)
);

CREATE INDEX IF NOT EXISTS live_answer_drafts_lookup_idx
  ON live_answer_drafts(session_id, question_id, participant_id);

COMMIT;
