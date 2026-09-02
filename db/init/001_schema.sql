CREATE TYPE user_role AS ENUM ('learner', 'instructor', 'superadmin');
CREATE TYPE session_status AS ENUM ('waiting', 'live', 'polling', 'finished');
CREATE TYPE participation_status AS ENUM ('joined', 'waiting_list', 'left');

CREATE TABLE app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id uuid UNIQUE,
  email text UNIQUE,
  participant_code varchar(12) UNIQUE,
  first_name text NOT NULL,
  last_name text NOT NULL,
  role user_role NOT NULL DEFAULT 'learner',
  password_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT staff_email_required CHECK (role = 'learner' OR email IS NOT NULL),
  CONSTRAINT participant_code_format CHECK (participant_code IS NULL OR participant_code ~ '^TS-[A-Z0-9]{4}-[A-Z0-9]{4}$')
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash char(64) NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('staff', 'learner')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);

CREATE TABLE themes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chapters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  theme_id uuid NOT NULL REFERENCES themes(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text,
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE(theme_id, position)
);

CREATE TABLE quizzes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id uuid NOT NULL UNIQUE REFERENCES chapters(id) ON DELETE CASCADE,
  title text NOT NULL,
  instructions text,
  is_final_exam boolean NOT NULL DEFAULT false,
  default_duration_seconds integer NOT NULL DEFAULT 30 CHECK(default_duration_seconds BETWEEN 5 AND 3600),
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  body text NOT NULL,
  difficulty smallint NOT NULL DEFAULT 1 CHECK(difficulty BETWEEN 1 AND 3),
  subtopic text,
  duration_seconds integer NOT NULL DEFAULT 30 CHECK(duration_seconds BETWEEN 5 AND 3600),
  explanation text,
  position integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  UNIQUE(quiz_id, position)
);

CREATE TABLE answer_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  label char(1) NOT NULL CHECK(label IN ('A','B','C','D')),
  body text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  UNIQUE(question_id, label)
);

CREATE TABLE grading_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  passing_score numeric(5,2) NOT NULL CHECK(passing_score BETWEEN 0 AND 100),
  max_attempts integer NOT NULL DEFAULT 1 CHECK(max_attempts > 0),
  rubric_file_name text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE training_groups (
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
CREATE INDEX training_groups_theme_idx ON training_groups(theme_id);
CREATE INDEX training_groups_instructor_idx ON training_groups(instructor_id);

CREATE TABLE live_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(8) NOT NULL UNIQUE,
  quiz_id uuid NOT NULL REFERENCES quizzes(id),
  group_id uuid REFERENCES training_groups(id),
  instructor_id uuid NOT NULL REFERENCES app_users(id),
  status session_status NOT NULL DEFAULT 'waiting',
  current_question_id uuid REFERENCES questions(id),
  question_started_at timestamptz,
  question_ends_at timestamptz,
  capacity smallint NOT NULL DEFAULT 30 CHECK(capacity BETWEEN 1 AND 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX live_sessions_group_idx ON live_sessions(group_id);

CREATE TABLE training_group_participants (
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(group_id,user_id)
);
CREATE INDEX training_group_participants_user_idx ON training_group_participants(user_id);

CREATE TABLE session_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  status participation_status NOT NULL DEFAULT 'waiting_list',
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, user_id)
);

CREATE TABLE live_answers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  participant_id uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES answer_options(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, question_id, participant_id, option_id)
);

CREATE TABLE live_answer_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  participant_id uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES answer_options(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, question_id, participant_id, option_id)
);
CREATE INDEX live_answer_drafts_lookup_idx
  ON live_answer_drafts(session_id, question_id, participant_id);

CREATE TABLE live_answer_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id),
  participant_id uuid NOT NULL REFERENCES session_participants(id) ON DELETE CASCADE,
  is_correct boolean NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, question_id, participant_id)
);
CREATE INDEX live_submissions_session_participant_idx
  ON live_answer_submissions(session_id, participant_id);

CREATE TABLE certificates (
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
CREATE INDEX certificates_group_idx ON certificates(training_group_id);
CREATE INDEX certificates_public_token_idx ON certificates(public_token);

CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  score numeric(5,2),
  passed boolean,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
