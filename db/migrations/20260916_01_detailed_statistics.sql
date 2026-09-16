-- Detailed statistics: preserve the start time of live quiz questions and
-- measure the active time used by a learner before the first answer in an exam.

CREATE TABLE IF NOT EXISTS live_question_timings (
  session_id uuid NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL,
  ends_at timestamptz,
  PRIMARY KEY(session_id, question_id)
);
CREATE INDEX IF NOT EXISTS live_question_timings_started_idx
  ON live_question_timings(session_id, started_at);

CREATE OR REPLACE FUNCTION capture_live_question_timing()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.current_question_id IS NOT NULL AND NEW.question_started_at IS NOT NULL THEN
    INSERT INTO live_question_timings(session_id, question_id, started_at, ends_at)
    VALUES(NEW.id, NEW.current_question_id, NEW.question_started_at, NEW.question_ends_at)
    ON CONFLICT(session_id, question_id) DO UPDATE SET
      started_at = EXCLUDED.started_at,
      ends_at = EXCLUDED.ends_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS live_sessions_capture_question_timing ON live_sessions;
CREATE TRIGGER live_sessions_capture_question_timing
AFTER INSERT OR UPDATE OF current_question_id, question_started_at, question_ends_at
ON live_sessions
FOR EACH ROW
EXECUTE FUNCTION capture_live_question_timing();

-- The current question can be backfilled. Older completed questions cannot be
-- reconstructed reliably, so their response time will remain unavailable.
INSERT INTO live_question_timings(session_id, question_id, started_at, ends_at)
SELECT id, current_question_id, question_started_at, question_ends_at
FROM live_sessions
WHERE current_question_id IS NOT NULL AND question_started_at IS NOT NULL
ON CONFLICT(session_id, question_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS final_exam_question_timings (
  attempt_id uuid NOT NULL REFERENCES final_exam_attempts(id) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES final_exam_questions(id) ON DELETE CASCADE,
  accumulated_ms bigint NOT NULL DEFAULT 0 CHECK(accumulated_ms >= 0),
  active_started_at timestamptz,
  answered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(attempt_id, question_id)
);
CREATE INDEX IF NOT EXISTS final_exam_question_timings_attempt_idx
  ON final_exam_question_timings(attempt_id, question_id);

CREATE OR REPLACE FUNCTION close_exam_question_timing_on_submit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.submitted_at IS NOT NULL AND OLD.submitted_at IS NULL THEN
    UPDATE final_exam_question_timings
    SET accumulated_ms = accumulated_ms + CASE
          WHEN active_started_at IS NULL THEN 0
          ELSE GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (NEW.submitted_at - active_started_at)) * 1000)::bigint)
        END,
        active_started_at = NULL,
        updated_at = NEW.submitted_at
    WHERE attempt_id = NEW.id AND active_started_at IS NOT NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS final_exam_close_question_timing ON final_exam_attempts;
CREATE TRIGGER final_exam_close_question_timing
AFTER UPDATE OF submitted_at ON final_exam_attempts
FOR EACH ROW
EXECUTE FUNCTION close_exam_question_timing_on_submit();
