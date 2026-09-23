BEGIN;

ALTER TABLE final_exams
  ADD COLUMN IF NOT EXISTS exam_type text NOT NULL DEFAULT 'final';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'final_exams_exam_type_check'
  ) THEN
    ALTER TABLE final_exams
      ADD CONSTRAINT final_exams_exam_type_check
      CHECK (exam_type IN ('final', 'experience'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS final_exams_group_type_idx
  ON final_exams(group_id, exam_type);

COMMIT;
