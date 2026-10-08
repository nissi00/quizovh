BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='training_group_grading' AND column_name='include_practice'
  ) THEN
    ALTER TABLE training_group_grading
      ADD COLUMN include_practice boolean NOT NULL DEFAULT false,
      ADD COLUMN practice_weight numeric(5,2) NOT NULL DEFAULT 0 CHECK(practice_weight BETWEEN 0 AND 100),
      ADD COLUMN include_experience_exam boolean NOT NULL DEFAULT false,
      ADD COLUMN experience_exam_weight numeric(5,2) NOT NULL DEFAULT 0 CHECK(experience_exam_weight BETWEEN 0 AND 100);

    UPDATE training_group_grading
    SET include_practice=include_experience,
        practice_weight=CASE WHEN include_experience THEN round(experience_weight / 2, 2) ELSE 0 END,
        include_experience_exam=include_experience,
        experience_exam_weight=CASE WHEN include_experience THEN experience_weight - round(experience_weight / 2, 2) ELSE 0 END;
  END IF;
END $$;

COMMIT;
