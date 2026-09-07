BEGIN;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS participant_code_format;

ALTER TABLE app_users
  ADD CONSTRAINT participant_code_format
  CHECK (participant_code IS NULL OR participant_code ~ '^TS-[A-Z0-9]{4}(-[A-Z0-9]{4})?$');

COMMIT;
