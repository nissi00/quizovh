BEGIN;

ALTER TABLE final_exam_attempts
  ADD COLUMN IF NOT EXISTS last_question_id uuid REFERENCES final_exam_questions(id) ON DELETE SET NULL;

-- Repair existing numbering gaps without changing question identifiers.
CREATE TEMP TABLE _final_exam_positions ON COMMIT DROP AS
SELECT id,row_number() OVER (PARTITION BY exam_id ORDER BY position,id)::integer AS new_position
FROM final_exam_questions;
UPDATE final_exam_questions question
SET position=-1000000-map.new_position
FROM _final_exam_positions map
WHERE question.id=map.id;
UPDATE final_exam_questions SET position=-position-1000000 WHERE position < -1000000;

CREATE TEMP TABLE _quiz_positions ON COMMIT DROP AS
SELECT id,row_number() OVER (PARTITION BY quiz_id ORDER BY position,id)::integer AS new_position
FROM questions;
UPDATE questions question
SET position=-1000000-map.new_position
FROM _quiz_positions map
WHERE question.id=map.id;
UPDATE questions SET position=-position-1000000 WHERE position < -1000000;

CREATE OR REPLACE FUNCTION renumber_final_exam_questions_after_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  target_position integer := OLD.position;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM final_exams WHERE id=OLD.exam_id) THEN
    RETURN OLD;
  END IF;
  FOR item IN
    SELECT id FROM final_exam_questions
    WHERE exam_id=OLD.exam_id AND position>OLD.position
    ORDER BY position,id
  LOOP
    UPDATE final_exam_questions SET position=target_position WHERE id=item.id;
    target_position := target_position + 1;
  END LOOP;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS final_exam_questions_renumber_after_delete ON final_exam_questions;
CREATE TRIGGER final_exam_questions_renumber_after_delete
AFTER DELETE ON final_exam_questions
FOR EACH ROW EXECUTE FUNCTION renumber_final_exam_questions_after_delete();

CREATE OR REPLACE FUNCTION renumber_quiz_questions_after_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  item record;
  target_position integer := OLD.position;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM quizzes WHERE id=OLD.quiz_id) THEN
    RETURN OLD;
  END IF;
  FOR item IN
    SELECT id FROM questions
    WHERE quiz_id=OLD.quiz_id AND position>OLD.position
    ORDER BY position,id
  LOOP
    UPDATE questions SET position=target_position WHERE id=item.id;
    target_position := target_position + 1;
  END LOOP;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS questions_renumber_after_delete ON questions;
CREATE TRIGGER questions_renumber_after_delete
AFTER DELETE ON questions
FOR EACH ROW EXECUTE FUNCTION renumber_quiz_questions_after_delete();

COMMIT;
