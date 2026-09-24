BEGIN;

ALTER TABLE completion_attestation_batches
  ADD COLUMN IF NOT EXISTS archived_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES app_users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS completion_attestation_batches_active_idx
  ON completion_attestation_batches(group_id,created_at DESC)
  WHERE archived_at IS NULL;

COMMIT;
