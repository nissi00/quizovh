-- Politique de confidentialité remplaçable depuis l’administration.
-- Le document reste stocké dans PostgreSQL et sa nouvelle empreinte impose
-- automatiquement une nouvelle prise de connaissance par les apprenants.
BEGIN;

ALTER TABLE branding_assets
  DROP CONSTRAINT IF EXISTS branding_assets_mime_type_check;

ALTER TABLE branding_assets
  ADD CONSTRAINT branding_assets_mime_type_check
  CHECK (mime_type IN ('image/png','image/jpeg','application/pdf'));

ALTER TABLE organization_settings
  ADD COLUMN IF NOT EXISTS privacy_policy_asset_id uuid
  REFERENCES branding_assets(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS branding_assets_policy_idx
  ON branding_assets(id) WHERE mime_type = 'application/pdf';

COMMIT;
