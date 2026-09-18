BEGIN;

SELECT pg_advisory_xact_lock(hashtext('ts-quiz-audit-retention'));

DELETE FROM audit_logs WHERE id IN (
  SELECT id
  FROM audit_logs
  ORDER BY created_at DESC,id DESC
  OFFSET 300
);

COMMIT;
