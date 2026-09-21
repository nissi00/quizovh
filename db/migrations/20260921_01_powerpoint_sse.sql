BEGIN;

CREATE OR REPLACE FUNCTION notify_powerpoint_presentation_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  session_identifier uuid;
  session_code text;
BEGIN
  IF TG_TABLE_NAME = 'live_sessions' THEN
    IF TG_OP = 'DELETE' THEN
      session_code := OLD.code;
    ELSE
      session_code := NEW.code;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      session_identifier := OLD.session_id;
    ELSE
      session_identifier := NEW.session_id;
    END IF;
    SELECT code INTO session_code FROM live_sessions WHERE id=session_identifier;
  END IF;

  IF session_code IS NOT NULL THEN
    PERFORM pg_notify('powerpoint_presentation_state', session_code);
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS live_sessions_powerpoint_notify ON live_sessions;
CREATE TRIGGER live_sessions_powerpoint_notify
AFTER INSERT OR UPDATE OR DELETE ON live_sessions
FOR EACH ROW EXECUTE FUNCTION notify_powerpoint_presentation_state();

DROP TRIGGER IF EXISTS session_participants_powerpoint_notify ON session_participants;
CREATE TRIGGER session_participants_powerpoint_notify
AFTER INSERT OR UPDATE OR DELETE ON session_participants
FOR EACH ROW EXECUTE FUNCTION notify_powerpoint_presentation_state();

DROP TRIGGER IF EXISTS live_answers_powerpoint_notify ON live_answers;
CREATE TRIGGER live_answers_powerpoint_notify
AFTER INSERT OR UPDATE OR DELETE ON live_answers
FOR EACH ROW EXECUTE FUNCTION notify_powerpoint_presentation_state();

DROP TRIGGER IF EXISTS live_answer_submissions_powerpoint_notify ON live_answer_submissions;
CREATE TRIGGER live_answer_submissions_powerpoint_notify
AFTER INSERT OR UPDATE OR DELETE ON live_answer_submissions
FOR EACH ROW EXECUTE FUNCTION notify_powerpoint_presentation_state();

COMMIT;
