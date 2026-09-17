BEGIN;

ALTER TABLE final_exams
  DROP CONSTRAINT IF EXISTS final_exams_group_id_key;

CREATE INDEX IF NOT EXISTS final_exams_group_idx
  ON final_exams(group_id);

COMMIT;
