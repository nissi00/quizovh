BEGIN;

ALTER TABLE quizzes
  ADD COLUMN IF NOT EXISTS partial_credit_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE live_answer_submissions
  ADD COLUMN IF NOT EXISTS points_earned numeric(8,4) NOT NULL DEFAULT 0;

UPDATE live_answer_submissions
SET points_earned = CASE WHEN is_correct THEN 1 ELSE 0 END
WHERE points_earned = 0;

ALTER TABLE live_answer_submissions
  DROP CONSTRAINT IF EXISTS live_answer_submissions_points_earned_check;
ALTER TABLE live_answer_submissions
  ADD CONSTRAINT live_answer_submissions_points_earned_check
  CHECK (points_earned BETWEEN 0 AND 1);

ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS image_asset_id uuid;

ALTER TABLE questions
  DROP CONSTRAINT IF EXISTS questions_image_asset_id_fkey;
ALTER TABLE questions
  ADD CONSTRAINT questions_image_asset_id_fkey
  FOREIGN KEY (image_asset_id) REFERENCES branding_assets(id) ON DELETE SET NULL;

COMMIT;
