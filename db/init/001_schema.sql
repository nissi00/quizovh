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
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id),
  last_login_at timestamptz,
  data_processing_informed_at timestamptz,
  privacy_policy_acknowledged_at timestamptz,
  privacy_notice_version text,
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
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id),
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
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id),
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
  show_podium boolean NOT NULL DEFAULT false,
  podium_visible boolean NOT NULL DEFAULT false,
  status session_status NOT NULL DEFAULT 'waiting',
  current_question_id uuid REFERENCES questions(id),
  question_started_at timestamptz,
  question_ends_at timestamptz,
  capacity smallint NOT NULL DEFAULT 30 CHECK(capacity BETWEEN 1 AND 30),
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id)
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
  show_on_podium boolean NOT NULL DEFAULT false,
  podium_alias text,
  podium_consent_at timestamptz,
  podium_consent_changed_at timestamptz,
  podium_consent_changed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  podium_consent_source text CHECK (podium_consent_source IS NULL OR podium_consent_source IN ('learner_form','instructor_oral')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(session_id, user_id)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  actor_role text,
  action text NOT NULL,
  entity_type text,
  entity_id uuid,
  summary text NOT NULL,
  outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_hash char(16),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX audit_logs_actor_idx ON audit_logs(actor_user_id,created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs(entity_type,entity_id,created_at DESC);

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

CREATE TABLE branding_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 char(64) NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg')),
  file_name text,
  data bytea NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE organization_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK(id = 1),
  logo_asset_id uuid REFERENCES branding_assets(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO organization_settings(id) VALUES(1);

CREATE TABLE certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  certificate_number text NOT NULL UNIQUE,
  public_token text NOT NULL UNIQUE,
  global_score numeric(5,2) NOT NULL CHECK(global_score BETWEEN 0 AND 100),
  status text NOT NULL DEFAULT 'issued' CHECK(status IN ('issued','revoked','outdated')),
  logo_asset_id uuid REFERENCES branding_assets(id),
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id),
  grading_snapshot jsonb,
  issued_by uuid NOT NULL REFERENCES app_users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(training_group_id,user_id)
);
CREATE INDEX certificates_group_idx ON certificates(training_group_id);
CREATE INDEX certificates_public_token_idx ON certificates(public_token);

CREATE TABLE training_group_grading (
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

CREATE TABLE final_exams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL UNIQUE REFERENCES training_groups(id) ON DELETE CASCADE,
  code varchar(8) NOT NULL UNIQUE,
  title text NOT NULL,
  instructions text,
  duration_minutes integer NOT NULL DEFAULT 60 CHECK(duration_minutes BETWEEN 5 AND 480),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','open','closed')),
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE final_exam_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id uuid NOT NULL REFERENCES final_exams(id) ON DELETE CASCADE,
  body text NOT NULL,
  points numeric(6,2) NOT NULL CHECK(points > 0 AND points <= 1000),
  position integer NOT NULL DEFAULT 0,
  UNIQUE(exam_id,position)
);

CREATE TABLE final_exam_options (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id uuid NOT NULL REFERENCES final_exam_questions(id) ON DELETE CASCADE,
  label char(1) NOT NULL CHECK(label IN ('A','B','C','D')),
  body text NOT NULL,
  is_correct boolean NOT NULL DEFAULT false,
  UNIQUE(question_id,label)
);

CREATE TABLE final_exam_attempts (
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

CREATE TABLE final_exam_answers (
  attempt_id uuid NOT NULL REFERENCES final_exam_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES final_exam_questions(id) ON DELETE CASCADE,
  option_id uuid NOT NULL REFERENCES final_exam_options(id) ON DELETE CASCADE,
  PRIMARY KEY(attempt_id,question_id,option_id)
);

CREATE TABLE practical_experiences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  name text NOT NULL,
  comment text,
  score numeric(8,2) NOT NULL CHECK(score >= 0),
  max_score numeric(8,2) NOT NULL DEFAULT 20 CHECK(max_score > 0),
  evaluated_by uuid NOT NULL REFERENCES app_users(id),
  evaluated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id),
  CHECK(score <= max_score)
);
CREATE INDEX practical_experiences_group_user_idx ON practical_experiences(group_id,user_id);

CREATE TABLE practical_experience_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  experience_id uuid NOT NULL REFERENCES practical_experiences(id) ON DELETE CASCADE,
  old_comment text,
  new_comment text,
  old_score numeric(8,2) NOT NULL,
  new_score numeric(8,2) NOT NULL,
  old_max_score numeric(8,2) NOT NULL,
  new_max_score numeric(8,2) NOT NULL,
  changed_by uuid NOT NULL REFERENCES app_users(id),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX practical_experience_revisions_experience_idx
  ON practical_experience_revisions(experience_id,changed_at DESC);

CREATE TABLE quiz_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id uuid NOT NULL REFERENCES quizzes(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  score numeric(5,2),
  passed boolean,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
