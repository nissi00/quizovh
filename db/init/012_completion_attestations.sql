CREATE TABLE IF NOT EXISTS completion_attestation_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id uuid REFERENCES training_groups(id) ON DELETE SET NULL,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  template_version text NOT NULL DEFAULT '2026-09-v1',
  form_snapshot jsonb NOT NULL,
  logo_data bytea,
  logo_mime_type text,
  signature_data bytea,
  signature_mime_type text,
  archived_at timestamptz,
  archived_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT completion_attestation_logo_type_check
    CHECK (logo_mime_type IS NULL OR logo_mime_type IN ('image/png','image/jpeg')),
  CONSTRAINT completion_attestation_signature_type_check
    CHECK (signature_mime_type IS NULL OR signature_mime_type IN ('image/png','image/jpeg'))
);

CREATE TABLE IF NOT EXISTS completion_attestations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES completion_attestation_batches(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  attestation_number text NOT NULL UNIQUE,
  participant_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,user_id)
);

CREATE INDEX IF NOT EXISTS completion_attestation_batches_group_idx
  ON completion_attestation_batches(group_id,created_at DESC);
CREATE INDEX IF NOT EXISTS completion_attestation_batches_active_idx
  ON completion_attestation_batches(group_id,created_at DESC)
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS completion_attestations_batch_idx
  ON completion_attestations(batch_id);
CREATE INDEX IF NOT EXISTS completion_attestations_user_idx
  ON completion_attestations(user_id,created_at DESC);
