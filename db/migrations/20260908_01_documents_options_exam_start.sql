BEGIN;

ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS data_processing_notice_asset_id uuid REFERENCES branding_assets(id) ON DELETE SET NULL;

ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS privacy_policy_version text,
  ADD COLUMN IF NOT EXISTS data_processing_notice_version text;

UPDATE app_users
SET privacy_policy_version = COALESCE(privacy_policy_version, privacy_notice_version)
WHERE privacy_policy_version IS NULL AND privacy_notice_version IS NOT NULL;

UPDATE app_users
SET data_processing_notice_version = 'not-configured-v1'
WHERE data_processing_notice_version IS NULL AND data_processing_informed_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS privacy_document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type text NOT NULL CHECK(document_type IN ('privacy_policy','data_processing_notice')),
  asset_id uuid NOT NULL REFERENCES branding_assets(id) ON DELETE RESTRICT,
  version char(64) NOT NULL,
  file_name text NOT NULL,
  published_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_type,version)
);
CREATE INDEX IF NOT EXISTS privacy_document_versions_published_idx
  ON privacy_document_versions(document_type,published_at DESC);

CREATE TABLE IF NOT EXISTS privacy_acknowledgements (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK(document_type IN ('privacy_policy','data_processing_notice')),
  document_version text NOT NULL,
  acknowledged_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id,document_type,document_version)
);
CREATE INDEX IF NOT EXISTS privacy_acknowledgements_date_idx
  ON privacy_acknowledgements(acknowledged_at DESC);
CREATE INDEX IF NOT EXISTS privacy_acknowledgements_user_idx
  ON privacy_acknowledgements(user_id,acknowledged_at DESC);

INSERT INTO privacy_document_versions(document_type,asset_id,version,file_name,published_by,published_at)
SELECT 'privacy_policy',ba.id,ba.sha256,COALESCE(ba.file_name,'privacy-policy.pdf'),ba.created_by,ba.created_at
FROM organization_settings os
JOIN branding_assets ba ON ba.id=os.privacy_policy_asset_id
WHERE os.id=1
ON CONFLICT(document_type,version) DO NOTHING;

INSERT INTO privacy_acknowledgements(user_id,document_type,document_version,acknowledged_at)
SELECT id,'privacy_policy',privacy_policy_version,privacy_policy_acknowledged_at
FROM app_users
WHERE role='learner' AND privacy_policy_acknowledged_at IS NOT NULL AND privacy_policy_version IS NOT NULL
ON CONFLICT(user_id,document_type,document_version) DO NOTHING;

INSERT INTO privacy_acknowledgements(user_id,document_type,document_version,acknowledged_at)
SELECT id,'data_processing_notice',data_processing_notice_version,data_processing_informed_at
FROM app_users
WHERE role='learner' AND data_processing_informed_at IS NOT NULL AND data_processing_notice_version IS NOT NULL
ON CONFLICT(user_id,document_type,document_version) DO NOTHING;

ALTER TABLE live_sessions ALTER COLUMN show_podium SET DEFAULT true;
UPDATE live_sessions SET show_podium=true WHERE show_podium=false;

ALTER TABLE answer_options DROP CONSTRAINT IF EXISTS answer_options_label_check;
ALTER TABLE answer_options
  ADD CONSTRAINT answer_options_label_check CHECK(label IN ('A','B','C','D','E','F'));

ALTER TABLE final_exam_options DROP CONSTRAINT IF EXISTS final_exam_options_label_check;
ALTER TABLE final_exam_options
  ADD CONSTRAINT final_exam_options_label_check CHECK(label IN ('A','B','C','D','E','F'));

COMMIT;
