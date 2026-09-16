ALTER TABLE final_exams
  ADD COLUMN IF NOT EXISTS shuffle_questions boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS final_exam_attempt_question_order (
  attempt_id uuid NOT NULL REFERENCES final_exam_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES final_exam_questions(id) ON DELETE CASCADE,
  display_position integer NOT NULL CHECK(display_position > 0),
  PRIMARY KEY(attempt_id, question_id),
  UNIQUE(attempt_id, display_position)
);
CREATE INDEX IF NOT EXISTS final_exam_attempt_question_order_lookup_idx
  ON final_exam_attempt_question_order(attempt_id, display_position);

CREATE TABLE IF NOT EXISTS final_exam_question_archives (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL UNIQUE,
  exam_id uuid NOT NULL REFERENCES final_exams(id) ON DELETE CASCADE,
  body text NOT NULL,
  points numeric(6,2) NOT NULL,
  position integer NOT NULL,
  options_json jsonb NOT NULL,
  archived_at timestamptz NOT NULL DEFAULT now(),
  archived_by uuid REFERENCES app_users(id)
);
CREATE INDEX IF NOT EXISTS final_exam_question_archives_exam_idx
  ON final_exam_question_archives(exam_id, archived_at DESC);

CREATE TABLE IF NOT EXISTS final_exam_presentation_state (
  exam_id uuid PRIMARY KEY REFERENCES final_exams(id) ON DELETE CASCADE,
  question_id uuid REFERENCES final_exam_questions(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
