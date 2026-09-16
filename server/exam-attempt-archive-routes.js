import { pool, safe, sessionUser, isUuid, httpError } from './lot-improvements-common.js';

const requireId = (value, label) => {
  if (!isUuid(value)) throw httpError(400, `${label} invalide.`);
  return value;
};

const sameSet = (left, right) => left.length === right.length && left.every(value => new Set(right).has(value));

async function requireSuperadmin(req) {
  const user = await sessionUser(req, 'staff');
  if (user.role !== 'superadmin') throw httpError(403, 'Accès réservé au superadministrateur.');
  return user;
}

async function activeExamDetails(examId) {
  const examResult = await pool.query(
    `SELECT fe.id,fe.code,fe.title,fe.status,fe.duration_minutes,fe.group_id,
      tg.name AS group_name,t.name AS theme_name
     FROM final_exams fe
     JOIN training_groups tg ON tg.id=fe.group_id
     JOIN themes t ON t.id=tg.theme_id
     WHERE fe.id=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [examId]
  );
  const exam = examResult.rows[0];
  if (!exam) throw httpError(404, 'Examen final introuvable.');

  const [questionsResult, optionsResult, attemptsResult, answersResult] = await Promise.all([
    pool.query(
      'SELECT id,body,points,position FROM final_exam_questions WHERE exam_id=$1 ORDER BY position,id',
      [exam.id]
    ),
    pool.query(
      `SELECT option.id,option.question_id,option.label,option.body,option.is_correct
       FROM final_exam_options option
       JOIN final_exam_questions question ON question.id=option.question_id
       WHERE question.exam_id=$1
       ORDER BY question.position,option.label`,
      [exam.id]
    ),
    pool.query(
      `SELECT attempt.id,attempt.user_id,attempt.started_at,attempt.expires_at,attempt.submitted_at,
        attempt.score_points,attempt.score_percent,u.first_name,u.last_name,u.participant_code
       FROM final_exam_attempts attempt
       JOIN app_users u ON u.id=attempt.user_id
       WHERE attempt.exam_id=$1 AND attempt.archived_at IS NULL
       ORDER BY lower(u.last_name),lower(u.first_name)`,
      [exam.id]
    ),
    pool.query(
      `SELECT answer.attempt_id,answer.question_id,answer.option_id
       FROM final_exam_answers answer
       JOIN final_exam_attempts attempt ON attempt.id=answer.attempt_id
       WHERE attempt.exam_id=$1 AND attempt.archived_at IS NULL`,
      [exam.id]
    )
  ]);

  const questions = questionsResult.rows.map((question, index) => {
    const options = optionsResult.rows.filter(option => option.question_id === question.id);
    return { ...question, display_position:index + 1, options };
  });

  const attempts = attemptsResult.rows.map(attempt => {
    const question_results = {};
    for (const question of questions) {
      const selected = answersResult.rows
        .filter(answer => answer.attempt_id === attempt.id && answer.question_id === question.id)
        .map(answer => answer.option_id);
      const correct = question.options.filter(option => option.is_correct).map(option => option.id);
      const answered = selected.length > 0;
      const correctAnswer = answered && sameSet(selected, correct);
      question_results[question.id] = {
        answered,
        is_correct: correctAnswer,
        points_earned: correctAnswer ? Number(question.points) : 0,
        selected_option_ids: selected
      };
    }
    return { ...attempt, question_results };
  });

  return { exam, questions, attempts };
}

export function registerExamAttemptArchiveRoutes(app) {
  app.get('/api/quality/final-exams/:id/active-details', safe(async (req, res) => {
    await sessionUser(req, 'staff');
    const examId = requireId(req.params.id, 'Examen');
    res.set('Cache-Control', 'no-store').json(await activeExamDetails(examId));
  }));

  app.get('/api/quality/final-exams/:id/archived-attempts', safe(async (req, res) => {
    await sessionUser(req, 'staff');
    const examId = requireId(req.params.id, 'Examen');
    const result = await pool.query(
      `SELECT id FROM final_exam_attempts
       WHERE exam_id=$1 AND archived_at IS NOT NULL
       ORDER BY archived_at DESC`,
      [examId]
    );
    res.set('Cache-Control', 'no-store').json({ attempt_ids: result.rows.map(row => row.id) });
  }));

  app.post('/api/quality/final-exam-attempts/:id/archive', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const attemptId = requireId(req.params.id, 'Copie');
    const result = await pool.query(
      `UPDATE final_exam_attempts
       SET archived_at=now(),archived_by=$2
       WHERE id=$1 AND submitted_at IS NOT NULL AND archived_at IS NULL
       RETURNING id`,
      [attemptId, user.id]
    );
    if (!result.rows[0]) {
      const exists = await pool.query('SELECT submitted_at,archived_at FROM final_exam_attempts WHERE id=$1', [attemptId]);
      if (!exists.rows[0]) throw httpError(404, 'Copie d’examen introuvable.');
      if (!exists.rows[0].submitted_at) throw httpError(409, 'La copie doit être rendue avant de pouvoir être archivée.');
      throw httpError(409, 'Cette copie est déjà archivée.');
    }
    res.status(204).end();
  }));

  app.get('/api/quality/archived-final-exam-attempts', safe(async (req, res) => {
    await requireSuperadmin(req);
    const result = await pool.query(
      `SELECT attempt.id,attempt.exam_id,attempt.archived_at,attempt.submitted_at,attempt.score_percent,
        u.first_name,u.last_name,u.participant_code,fe.title AS exam_title,tg.name AS group_name
       FROM final_exam_attempts attempt
       JOIN app_users u ON u.id=attempt.user_id
       JOIN final_exams fe ON fe.id=attempt.exam_id
       JOIN training_groups tg ON tg.id=fe.group_id
       WHERE attempt.archived_at IS NOT NULL
       ORDER BY attempt.archived_at DESC,lower(u.last_name),lower(u.first_name)`
    );
    res.set('Cache-Control', 'no-store').json({ attempts: result.rows });
  }));

  app.post('/api/quality/final-exam-attempts/:id/restore', safe(async (req, res) => {
    await requireSuperadmin(req);
    const attemptId = requireId(req.params.id, 'Copie');
    const result = await pool.query(
      `UPDATE final_exam_attempts
       SET archived_at=NULL,archived_by=NULL
       WHERE id=$1 AND archived_at IS NOT NULL
       RETURNING id`,
      [attemptId]
    );
    if (!result.rows[0]) throw httpError(404, 'Copie archivée introuvable.');
    res.status(204).end();
  }));

  app.delete('/api/quality/final-exam-attempts/:id', safe(async (req, res) => {
    await requireSuperadmin(req);
    const attemptId = requireId(req.params.id, 'Copie');
    const result = await pool.query(
      'DELETE FROM final_exam_attempts WHERE id=$1 AND archived_at IS NOT NULL RETURNING id',
      [attemptId]
    );
    if (!result.rows[0]) throw httpError(404, 'Copie archivée introuvable.');
    res.status(204).end();
  }));
}
