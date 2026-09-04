BEGIN;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS last_login_at timestamptz,
  ADD COLUMN IF NOT EXISTS data_processing_informed_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_policy_acknowledged_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_notice_version text;

ALTER TABLE session_participants
  ALTER COLUMN show_on_podium SET DEFAULT false;

ALTER TABLE session_participants
  ADD COLUMN IF NOT EXISTS podium_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS podium_consent_changed_at timestamptz,
  ADD COLUMN IF NOT EXISTS podium_consent_changed_by uuid,
  ADD COLUMN IF NOT EXISTS podium_consent_source text;

ALTER TABLE session_participants
  DROP CONSTRAINT IF EXISTS session_participants_podium_consent_changed_by_fkey;
ALTER TABLE session_participants
  ADD CONSTRAINT session_participants_podium_consent_changed_by_fkey
  FOREIGN KEY (podium_consent_changed_by) REFERENCES app_users(id) ON DELETE SET NULL;

ALTER TABLE session_participants
  DROP CONSTRAINT IF EXISTS session_participants_podium_consent_source_check;
ALTER TABLE session_participants
  ADD CONSTRAINT session_participants_podium_consent_source_check
  CHECK (podium_consent_source IS NULL OR podium_consent_source IN ('learner_form','instructor_oral'));

-- Les anciennes valeurs provenaient d’une option cochée par défaut et ne
-- constituent donc pas un consentement explicite au classement public.
UPDATE session_participants
SET show_on_podium=false
WHERE podium_consent_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_logs (
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

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_actor_idx ON audit_logs(actor_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_entity_idx ON audit_logs(entity_type,entity_id,created_at DESC);

COMMIT;
