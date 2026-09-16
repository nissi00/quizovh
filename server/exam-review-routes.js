import { pool, safe, sessionUser, isUuid, httpError } from './lot-improvements-common.js';

const requireId = (value, label) => {
  if (!isUuid(value)) throw httpError(400, `${label} invalide.`);
  return value;
};

const examCodePattern = /^[A-Z0-9]{4,8}$/;

async function requireSuperadmin(req) {
  const user = await sessionUser(req, 'staff');
  if (user.role !== 'superadmin') throw httpError(403, 'Accès réservé au superadministrateur.');
  return user;
}

async function featureState(examId) {
  const examResult = await pool.query(
    `SELECT fe.id,fe.code,fe.title,fe.status,fe.shuffle_questions,
      (SELECT count(*)::integer FROM final_exam_attempts a WHERE a.exam_id=fe.id) AS attempt_count,
      fps.question_id AS presentation_question_id
     FROM final_exams fe
     LEFT JOIN final_exam_presentation_state fps ON fps.exam_id=fe.id
     WHERE fe.id=$1 AND fe.archived_at IS NULL`,
    [examId]
  );
  const exam = examResult.rows[0];
  if (!exam) throw httpError(404, 'Examen final introuvable.');

  const questions = await pool.query(
    `SELECT id,body,points::numeric AS points,position
     FROM final_exam_questions
     WHERE exam_id=$1
     ORDER BY position,id`,
    [examId]
  );
  return {
    exam: {
      ...exam,
      attempt_count: Number(exam.attempt_count || 0),
      shuffle_questions: exam.shuffle_questions === true
    },
    questions: questions.rows
  };
}

async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export function registerExamReviewRoutes(app) {
  app.get('/api/quality/final-exams/:id/feature-state', safe(async (req, res) => {
    await sessionUser(req, 'staff');
    const examId = requireId(req.params.id, 'Examen');
    res.set('Cache-Control', 'no-store').json(await featureState(examId));
  }));

  app.patch('/api/quality/final-exams/:id/shuffle', safe(async (req, res) => {
    await sessionUser(req, 'staff');
    const examId = requireId(req.params.id, 'Examen');
    const enabled = req.body?.enabled === true;

    const result = await withTransaction(async client => {
      const examResult = await client.query(
        `SELECT id,status FROM final_exams
         WHERE id=$1 AND archived_at IS NULL
         FOR UPDATE`,
        [examId]
      );
      const exam = examResult.rows[0];
      if (!exam) throw httpError(404, 'Examen final introuvable.');
      if (exam.status === 'closed') throw httpError(409, 'Rouvrez l’examen avant de modifier cette option.');

      const attempts = await client.query(
        'SELECT count(*)::integer AS count FROM final_exam_attempts WHERE exam_id=$1',
        [examId]
      );
      if (Number(attempts.rows[0]?.count || 0) > 0) {
        throw httpError(409, 'Le mélange des questions est verrouillé dès qu’une copie a commencé.');
      }

      return client.query(
        'UPDATE final_exams SET shuffle_questions=$2 WHERE id=$1 RETURNING id,shuffle_questions',
        [examId, enabled]
      );
    });

    res.json(result.rows[0]);
  }));

  app.post('/api/quality/final-exam-questions/:id/archive', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const questionId = requireId(req.params.id, 'Question');

    await withTransaction(async client => {
      const questionResult = await client.query(
        `SELECT q.id,q.exam_id,q.body,q.points,q.position,fe.status
         FROM final_exam_questions q
         JOIN final_exams fe ON fe.id=q.exam_id
         WHERE q.id=$1 AND fe.archived_at IS NULL
         FOR UPDATE`,
        [questionId]
      );
      const question = questionResult.rows[0];
      if (!question) throw httpError(404, 'Question d’examen introuvable.');
      if (question.status !== 'draft') {
        throw httpError(409, 'Une question ne peut être archivée que lorsque l’examen est en préparation.');
      }

      const attempts = await client.query(
        'SELECT count(*)::integer AS count FROM final_exam_attempts WHERE exam_id=$1',
        [question.exam_id]
      );
      if (Number(attempts.rows[0]?.count || 0) > 0) {
        throw httpError(409, 'Cette question a déjà été utilisée dans une copie et doit être conservée.');
      }

      const options = await client.query(
        `SELECT id,label,body,is_correct
         FROM final_exam_options
         WHERE question_id=$1
         ORDER BY label`,
        [questionId]
      );

      await client.query(
        `INSERT INTO final_exam_question_archives
          (question_id,exam_id,body,points,position,options_json,archived_by)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT(question_id) DO NOTHING`,
        [
          question.id,
          question.exam_id,
          question.body,
          question.points,
          question.position,
          JSON.stringify(options.rows),
          user.id
        ]
      );

      await client.query(
        'UPDATE final_exam_presentation_state SET question_id=NULL,updated_by=$2,updated_at=now() WHERE exam_id=$1 AND question_id=$3',
        [question.exam_id, user.id, questionId]
      );
      await client.query('DELETE FROM final_exam_questions WHERE id=$1', [questionId]);
    });

    res.status(204).end();
  }));

  app.get('/api/quality/archived-final-exam-questions', safe(async (req, res) => {
    await requireSuperadmin(req);
    const result = await pool.query(
      `SELECT a.id,a.question_id,a.exam_id,a.body,a.points::numeric AS points,a.position,a.archived_at,
        fe.title AS exam_title,fe.status AS exam_status,tg.name AS group_name
       FROM final_exam_question_archives a
       JOIN final_exams fe ON fe.id=a.exam_id
       JOIN training_groups tg ON tg.id=fe.group_id
       ORDER BY a.archived_at DESC,a.position`
    );
    res.set('Cache-Control', 'no-store').json({ questions: result.rows });
  }));

  app.post('/api/quality/final-exam-question-archives/:id/restore', safe(async (req, res) => {
    await requireSuperadmin(req);
    const archiveId = requireId(req.params.id, 'Archive');

    await withTransaction(async client => {
      const archiveResult = await client.query(
        `SELECT a.*,fe.status
         FROM final_exam_question_archives a
         JOIN final_exams fe ON fe.id=a.exam_id
         WHERE a.id=$1
         FOR UPDATE`,
        [archiveId]
      );
      const archive = archiveResult.rows[0];
      if (!archive) throw httpError(404, 'Question archivée introuvable.');
      if (archive.status !== 'draft') {
        throw httpError(409, 'Rouvrez cet examen en préparation avant de restaurer la question.');
      }

      const attempts = await client.query(
        'SELECT count(*)::integer AS count FROM final_exam_attempts WHERE exam_id=$1',
        [archive.exam_id]
      );
      if (Number(attempts.rows[0]?.count || 0) > 0) {
        throw httpError(409, 'Cette question ne peut plus être restaurée car une copie de l’examen existe déjà.');
      }

      const occupied = await client.query(
        'SELECT 1 FROM final_exam_questions WHERE exam_id=$1 AND position=$2',
        [archive.exam_id, archive.position]
      );
      let position = Number(archive.position);
      if (occupied.rows[0]) {
        const last = await client.query(
          'SELECT COALESCE(max(position),0)::integer AS position FROM final_exam_questions WHERE exam_id=$1',
          [archive.exam_id]
        );
        position = Number(last.rows[0]?.position || 0) + 1;
      }

      await client.query(
        `INSERT INTO final_exam_questions(id,exam_id,body,points,position)
         VALUES($1,$2,$3,$4,$5)`,
        [archive.question_id, archive.exam_id, archive.body, archive.points, position]
      );

      const options = Array.isArray(archive.options_json) ? archive.options_json : [];
      for (const option of options) {
        await client.query(
          `INSERT INTO final_exam_options(id,question_id,label,body,is_correct)
           VALUES($1,$2,$3,$4,$5)`,
          [option.id, archive.question_id, option.label, option.body, option.is_correct === true]
        );
      }

      await client.query('DELETE FROM final_exam_question_archives WHERE id=$1', [archiveId]);
    });

    res.status(204).end();
  }));

  app.delete('/api/quality/final-exam-question-archives/:id', safe(async (req, res) => {
    await requireSuperadmin(req);
    const archiveId = requireId(req.params.id, 'Archive');
    const result = await pool.query(
      'DELETE FROM final_exam_question_archives WHERE id=$1 RETURNING id',
      [archiveId]
    );
    if (!result.rows[0]) throw httpError(404, 'Question archivée introuvable.');
    res.status(204).end();
  }));

  app.put('/api/quality/final-exams/:id/presentation-question', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const examId = requireId(req.params.id, 'Examen');
    const rawQuestionId = req.body?.question_id;
    const questionId = rawQuestionId === null || rawQuestionId === '' || rawQuestionId === undefined
      ? null
      : requireId(rawQuestionId, 'Question');

    const examResult = await pool.query(
      'SELECT id,status FROM final_exams WHERE id=$1 AND archived_at IS NULL',
      [examId]
    );
    const exam = examResult.rows[0];
    if (!exam) throw httpError(404, 'Examen final introuvable.');
    if (exam.status !== 'closed') {
      throw httpError(409, 'Clôturez l’examen avant d’afficher une question sur PowerPoint.');
    }

    if (questionId) {
      const question = await pool.query(
        'SELECT 1 FROM final_exam_questions WHERE id=$1 AND exam_id=$2',
        [questionId, examId]
      );
      if (!question.rows[0]) throw httpError(404, 'Question introuvable dans cet examen.');
    }

    await pool.query(
      `INSERT INTO final_exam_presentation_state(exam_id,question_id,updated_by,updated_at)
       VALUES($1,$2,$3,now())
       ON CONFLICT(exam_id) DO UPDATE SET
         question_id=EXCLUDED.question_id,
         updated_by=EXCLUDED.updated_by,
         updated_at=now()`,
      [examId, questionId, user.id]
    );

    res.json({ exam_id: examId, question_id: questionId });
  }));

  app.get('/api/quality/presentation/exam-review', safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!examCodePattern.test(code)) throw httpError(400, 'Code d’examen invalide.');

    const examResult = await pool.query(
      `SELECT fe.id,fe.code,fe.title,fe.status,fe.duration_minutes,
        tg.name AS group_name,t.name AS theme_name,fps.question_id
       FROM final_exams fe
       JOIN training_groups tg ON tg.id=fe.group_id
       JOIN themes t ON t.id=tg.theme_id
       LEFT JOIN final_exam_presentation_state fps ON fps.exam_id=fe.id
       WHERE fe.code=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
      [code]
    );
    const exam = examResult.rows[0];
    if (!exam) throw httpError(404, 'Examen final introuvable.');
    if (exam.status !== 'closed' || !exam.question_id) {
      return res.set('Cache-Control', 'no-store').json({
        active: false,
        code: exam.code,
        status: exam.status
      });
    }

    const questionResult = await pool.query(
      `SELECT id,body,points::numeric AS points,position
       FROM final_exam_questions
       WHERE id=$1 AND exam_id=$2`,
      [exam.question_id, exam.id]
    );
    const question = questionResult.rows[0];
    if (!question) {
      return res.set('Cache-Control', 'no-store').json({
        active: false,
        code: exam.code,
        status: exam.status
      });
    }

    const options = await pool.query(
      `SELECT id,label,body,is_correct
       FROM final_exam_options
       WHERE question_id=$1
       ORDER BY label`,
      [question.id]
    );

    res.set('Cache-Control', 'no-store').json({
      active: true,
      exam: {
        id: exam.id,
        code: exam.code,
        title: exam.title,
        status: exam.status,
        group_name: exam.group_name,
        theme_name: exam.theme_name
      },
      question: { ...question, options: options.rows }
    });
  }));
}
