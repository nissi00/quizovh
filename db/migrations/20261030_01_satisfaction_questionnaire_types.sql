BEGIN;

ALTER TABLE satisfaction_surveys
  ADD COLUMN IF NOT EXISTS survey_type text NOT NULL DEFAULT 'trainee';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='satisfaction_surveys'::regclass AND conname='satisfaction_surveys_type_check') THEN
    ALTER TABLE satisfaction_surveys ADD CONSTRAINT satisfaction_surveys_type_check
      CHECK (survey_type IN ('trainee','client','follow_up','trainer','opco'));
  END IF;
END;
$$;

DROP INDEX IF EXISTS satisfaction_surveys_one_open_per_group_idx;
CREATE UNIQUE INDEX IF NOT EXISTS satisfaction_surveys_one_open_per_group_type_idx
  ON satisfaction_surveys(group_id,survey_type) WHERE status='open';

COMMIT;
