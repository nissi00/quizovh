-- Archivage des copies d'examen final.

ALTER TABLE final_exam_attempts
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

ALTER TABLE final_exam_attempts
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id);

CREATE INDEX IF NOT EXISTS final_exam_attempts_archived_idx
  ON final_exam_attempts(archived_at)
  WHERE archived_at IS NOT NULL;
