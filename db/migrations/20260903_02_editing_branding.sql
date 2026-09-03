BEGIN;

CREATE TABLE IF NOT EXISTS branding_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 char(64) NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK(mime_type IN ('image/png','image/jpeg')),
  file_name text,
  data bytea NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK(id = 1),
  logo_asset_id uuid REFERENCES branding_assets(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES app_users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO organization_settings(id) VALUES(1)
ON CONFLICT(id) DO NOTHING;

ALTER TABLE certificates
  ADD COLUMN IF NOT EXISTS logo_asset_id uuid REFERENCES branding_assets(id);

ALTER TABLE certificates DROP CONSTRAINT IF EXISTS certificates_status_check;
ALTER TABLE certificates
  ADD CONSTRAINT certificates_status_check CHECK(status IN ('issued','revoked','outdated'));

CREATE TABLE IF NOT EXISTS practical_experience_revisions (
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

CREATE INDEX IF NOT EXISTS practical_experience_revisions_experience_idx
  ON practical_experience_revisions(experience_id,changed_at DESC);

COMMIT;
