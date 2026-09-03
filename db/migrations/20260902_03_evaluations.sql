BEGIN;

ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS show_podium boolean NOT NULL DEFAULT false;
ALTER TABLE live_sessions ADD COLUMN IF NOT EXISTS podium_visible boolean NOT NULL DEFAULT false;
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS show_on_podium boolean NOT NULL DEFAULT true;
ALTER TABLE session_participants ADD COLUMN IF NOT EXISTS podium_alias text;
UPDATE session_participants SET podium_alias='Joueur-' || upper(substr(md5(id::text),1,6)) WHERE podium_alias IS NULL;

ALTER TABLE certificates ADD COLUMN IF NOT EXISTS grading_snapshot jsonb;

CREATE TABLE IF NOT EXISTS training_group_grading (
  group_id uuid PRIMARY KEY REFERENCES training_groups(id) ON DELETE CASCADE,
  include_quizzes boolean NOT NULL DEFAULT true,
  quiz_weight numeric(5,2) NOT NULL DEFAULT 100 CHECK(quiz_weight BETWEEN 0 AND 100),
  include_exam boolean NOT NULL DEFAULT false,
  exam_weight numeric(5,2) NOT NULL DEFAULT 0 CHECK(exam_weight BETWEEN 0 AND 100),
  include_experience boolean NOT NULL DEFAULT false,
  experience_weight numeric(5,2) NOT NULL DEFAULT 0 CHECK(experience_weight BETWEEN 0 AND 100),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS final_exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL UNIQUE REFERENCES training_groups(id) ON DELETE CASCADE,
  code varchar(8) NOT NULL UNIQUE,
  title text NOT NULL,
  instructions text,
  duration_minutes integer NOT NULL DEFAULT 60 CHECK(duration_minutes BETWEEN 5 AND 480),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS final_exam_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES final_exams(id) ON DELETE CASCADE,
  body text NOT NULL,
  points numeric(6,2) NOT NULL CHECK(points > 0 AND points <= 1000),
  position integer NOT NULL DEFAULT 0,
  UNIQUE(exam_id,position)
);

CREATE TABLE IF NOT EXISTS final_exam_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES final_exam_questions(id) ON DELETE CASCADE,
  label char(1) NOT NULL CHECK(label IN ('A','B','C','D')),
  body text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  UNIQUE(question_id,label)
);

CREATE TABLE IF NOT EXISTS final_exam_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES final_exams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  submitted_at timestamptz,
  score_points numeric(8,2),
  score_percent numeric(5,2),
  UNIQUE(exam_id,user_id)
);

CREATE TABLE IF NOT EXISTS final_exam_answers (
  attempt_id uuid NOT NULL REFERENCES final_exam_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES final_exam_questions(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES final_exam_options(id) ON DELETE CASCADE,
  PRIMARY KEY(attempt_id,question_id,option_id)
);

CREATE TABLE IF NOT EXISTS practical_experiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  comment text,
  score numeric(8,2) NOT NULL CHECK(score >= 0),
  max_score numeric(8,2) NOT NULL DEFAULT 20 CHECK(max_score > 0),
  evaluated_by uuid NOT NULL REFERENCES app_users(id),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  CHECK(score <= max_score)
);
CREATE INDEX IF NOT EXISTS practical_experiences_group_user_idx ON practical_experiences(group_id,user_id);

COMMIT;
