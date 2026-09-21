import { rateLimit } from 'express-rate-limit';
import { pool, safe, sessionUser, isUuid, httpError } from './lot-improvements-common.js';

const presentationQualityLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1000,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

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

export async function closeExpiredQuestions() {
  const candidate = await pool.query(
    `SELECT 1 FROM live_sessions
     WHERE status='live' AND current_question_id IS NOT NULL
       AND question_ends_at IS NOT NULL AND question_ends_at<=now()
     LIMIT 1`
  );
  if (!candidate.rows[0]) return;

  await withTransaction(async client => {
    const expired = await client.query(
      `SELECT ls.id,ls.current_question_id,ls.quiz_id FROM live_sessions ls
       WHERE status='live' AND current_question_id IS NOT NULL
         AND question_ends_at IS NOT NULL AND question_ends_at<=now()
       FOR UPDATE`
    );

    for (const session of expired.rows) {
      await client.query(
        `INSERT INTO live_answers(session_id,question_id,participant_id,option_id)
         SELECT d.session_id,d.question_id,d.participant_id,d.option_id
         FROM live_answer_drafts d
         JOIN session_participants sp ON sp.id=d.participant_id AND sp.status='joined'
         LEFT JOIN live_answer_submissions las
           ON las.session_id=d.session_id AND las.question_id=d.question_id AND las.participant_id=d.participant_id
         WHERE d.session_id=$1 AND d.question_id=$2 AND las.id IS NULL
         ON CONFLICT DO NOTHING`,
        [session.id, session.current_question_id]
      );

      await client.query(
        `INSERT INTO live_answer_submissions(session_id,question_id,participant_id,is_correct,points_earned)
         SELECT $1,$2,sp.id,
           NOT EXISTS (
             SELECT 1 FROM answer_options correct_option
             WHERE correct_option.question_id=$2 AND correct_option.is_correct
               AND NOT EXISTS (
                 SELECT 1 FROM live_answer_drafts d
                 WHERE d.session_id=$1 AND d.question_id=$2
                   AND d.participant_id=sp.id AND d.option_id=correct_option.id
               )
           )
           AND NOT EXISTS (
             SELECT 1 FROM live_answer_drafts d
             JOIN answer_options selected_option ON selected_option.id=d.option_id
             WHERE d.session_id=$1 AND d.question_id=$2
               AND d.participant_id=sp.id AND NOT selected_option.is_correct
           ),
           CASE WHEN qz.partial_credit_enabled THEN
             COALESCE((
               SELECT count(*) FILTER (WHERE selected_option.is_correct)::numeric /
                 NULLIF((SELECT count(*) FROM answer_options WHERE question_id=$2 AND is_correct),0)
               FROM live_answer_drafts d
               JOIN answer_options selected_option ON selected_option.id=d.option_id
               WHERE d.session_id=$1 AND d.question_id=$2 AND d.participant_id=sp.id
             ),0)
           ELSE CASE WHEN NOT EXISTS (
             SELECT 1 FROM answer_options correct_option
             WHERE correct_option.question_id=$2 AND correct_option.is_correct
               AND NOT EXISTS (
                 SELECT 1 FROM live_answer_drafts d
                 WHERE d.session_id=$1 AND d.question_id=$2
                   AND d.participant_id=sp.id AND d.option_id=correct_option.id
               )
           ) AND NOT EXISTS (
             SELECT 1 FROM live_answer_drafts d
             JOIN answer_options selected_option ON selected_option.id=d.option_id
             WHERE d.session_id=$1 AND d.question_id=$2
               AND d.participant_id=sp.id AND NOT selected_option.is_correct
           ) THEN 1 ELSE 0 END END
         FROM session_participants sp
         JOIN quizzes qz ON qz.id=$3
         WHERE sp.session_id=$1 AND sp.status='joined'
           AND EXISTS (
             SELECT 1 FROM live_answer_drafts d
             WHERE d.session_id=$1 AND d.question_id=$2 AND d.participant_id=sp.id
           )
         ON CONFLICT(session_id,question_id,participant_id) DO NOTHING`,
        [session.id, session.current_question_id, session.quiz_id]
      );

      await client.query(
        'DELETE FROM live_answer_drafts WHERE session_id=$1 AND question_id=$2',
        [session.id, session.current_question_id]
      );
      await client.query(
        "UPDATE live_sessions SET status='polling' WHERE id=$1 AND status='live'",
        [session.id]
      );
    }
  });
}

export async function presentationState(code) {
  await closeExpiredQuestions();
  const base = await pool.query(
    `SELECT ls.id,ls.code,ls.quiz_id,ls.status,ls.current_question_id,ls.question_started_at,ls.question_ends_at,
      ls.show_podium,ls.podium_visible,
      qz.title AS quiz_title,c.title AS chapter_title,t.name AS theme_name
     FROM live_sessions ls
     JOIN quizzes qz ON qz.id=ls.quiz_id
     JOIN chapters c ON c.id=qz.chapter_id
     JOIN themes t ON t.id=c.theme_id
     LEFT JOIN training_groups tg ON tg.id=ls.group_id
     WHERE ls.code=$1 AND ls.archived_at IS NULL AND (tg.id IS NULL OR tg.archived_at IS NULL)`,
    [code]
  );
  const session = base.rows[0];
  if (!session) throw httpError(404, 'Session introuvable.');

  const reviewing = session.status === 'waiting' && Boolean(session.current_question_id && session.question_started_at);
  const counts = await pool.query(
    `SELECT
      count(*) FILTER (WHERE status='joined')::integer AS joined_count,
      count(*) FILTER (WHERE status='waiting_list')::integer AS waiting_count,
      (SELECT count(*)::integer FROM questions
       WHERE quiz_id=$2 AND is_active AND archived_at IS NULL) AS question_count
     FROM session_participants WHERE session_id=$1`,
    [session.id, session.quiz_id]
  );

  let question = null;
  let pollResults = [];
  let podium = [];
  let answeredCount = 0;

  if (session.current_question_id) {
    const questionResult = await pool.query(
      `SELECT q.id,q.body,q.duration_seconds,q.position,q.image_asset_id,ba.sha256 AS image_sha256,
        (SELECT count(*)>1 FROM answer_options c WHERE c.question_id=q.id AND c.is_correct) AS multiple_answers,
        (SELECT count(*)::integer FROM questions visible
         WHERE visible.quiz_id=q.quiz_id AND visible.is_active AND visible.archived_at IS NULL
           AND (visible.position<q.position OR (visible.position=q.position AND visible.id<=q.id))) AS display_position
       FROM questions q LEFT JOIN branding_assets ba ON ba.id=q.image_asset_id WHERE q.id=$1`,
      [session.current_question_id]
    );
    question = questionResult.rows[0] || null;
    if (question) {
      question.position = Number(question.display_position || question.position || 1);
      delete question.display_position;
      question.image_url = question.image_asset_id ? `/api/questions/${question.id}/image?v=${encodeURIComponent(question.image_sha256 || '')}` : null;
      const options = await pool.query(
        'SELECT id,label,body,is_correct FROM answer_options WHERE question_id=$1 ORDER BY label',
        [question.id]
      );
      question.options = options.rows.map(option => reviewing
        ? option
        : { id: option.id, label: option.label, body: option.body });

      const answered = await pool.query(
        `SELECT count(*)::integer AS count
         FROM live_answer_submissions las
         JOIN session_participants sp ON sp.id=las.participant_id
         WHERE las.session_id=$1 AND las.question_id=$2 AND sp.status='joined'`,
        [session.id, question.id]
      );
      answeredCount = answered.rows[0].count;

      if (session.status === 'polling' || reviewing) {
        const polls = await pool.query(
          `SELECT ao.label,count(la.id)::integer AS response_count
           FROM answer_options ao LEFT JOIN live_answers la
             ON la.option_id=ao.id AND la.session_id=$1 AND la.question_id=$2
           WHERE ao.question_id=$2 GROUP BY ao.label ORDER BY ao.label`,
          [session.id, question.id]
        );
        pollResults = polls.rows;
      }
    }
  }

  if (session.show_podium && session.podium_visible && session.current_question_id) {
    const ranking = await pool.query(
      `SELECT sp.podium_alias,
         COALESCE(sum(CASE WHEN answered_question.position <= current_question.position
           AND answered_question.is_active AND answered_question.archived_at IS NULL
           THEN CASE WHEN las.is_correct AND COALESCE(las.points_earned,0)=0 THEN 1 ELSE COALESCE(las.points_earned,0) END
           ELSE 0 END),0)::numeric AS earned_points,
         (SELECT count(*)::integer FROM questions completed_question
          WHERE completed_question.quiz_id=ls.quiz_id AND completed_question.position <= current_question.position
            AND completed_question.is_active AND completed_question.archived_at IS NULL) AS completed_count,
         sp.joined_at
       FROM session_participants sp
       JOIN live_sessions ls ON ls.id=sp.session_id
       JOIN questions current_question ON current_question.id=ls.current_question_id
       LEFT JOIN live_answer_submissions las ON las.participant_id=sp.id AND las.session_id=sp.session_id
       LEFT JOIN questions answered_question ON answered_question.id=las.question_id
       WHERE sp.session_id=$1 AND sp.status='joined' AND sp.show_on_podium
         AND sp.podium_alias IS NOT NULL AND sp.podium_alias !~ '^Joueur-[A-F0-9]{6}$'
       GROUP BY sp.id,sp.podium_alias,sp.joined_at,ls.quiz_id,current_question.position
       ORDER BY (COALESCE(sum(CASE WHEN answered_question.position <= current_question.position
           AND answered_question.is_active AND answered_question.archived_at IS NULL
           THEN CASE WHEN las.is_correct AND COALESCE(las.points_earned,0)=0 THEN 1 ELSE COALESCE(las.points_earned,0) END
           ELSE 0 END),0) /
         NULLIF((SELECT count(*) FROM questions completed_question
           WHERE completed_question.quiz_id=ls.quiz_id AND completed_question.position <= current_question.position
             AND completed_question.is_active AND completed_question.archived_at IS NULL),0)) DESC,
         sp.joined_at ASC`,
      [session.id]
    );
    podium = ranking.rows.map((item, index) => {
      const earned = Number(item.earned_points || 0);
      const completed = Number(item.completed_count || 0);
      return { rank: index + 1, alias: item.podium_alias, score_percent: completed ? Math.round((earned * 100 / completed) * 10) / 10 : 0 };
    });
  }

  const participantCounts = counts.rows[0];
  return {
    server_now: new Date().toISOString(),
    code: session.code,
    status: session.status,
    theme_name: session.theme_name,
    chapter_title: session.chapter_title,
    quiz_title: session.quiz_title,
    question_started_at: session.question_started_at,
    question_ends_at: session.question_ends_at,
    show_podium: session.show_podium,
    podium_visible: session.podium_visible,
    podium,
    reviewing,
    question,
    poll_results: pollResults,
    joined_count: participantCounts.joined_count,
    waiting_count: participantCounts.waiting_count,
    answered_count: answeredCount,
    question_count: participantCounts.question_count,
    question_position: question?.position || null
  };
}

async function examForStaff(examId) {
  if (!isUuid(examId)) throw httpError(400, 'Examen invalide.');
  const result = await pool.query(
    `SELECT fe.id,fe.code,fe.title,fe.status,fe.duration_minutes,fe.group_id,tg.name AS group_name,t.name AS theme_name
     FROM final_exams fe
     JOIN training_groups tg ON tg.id=fe.group_id
     JOIN themes t ON t.id=tg.theme_id
     WHERE fe.id=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [examId]
  );
  if (!result.rows[0]) throw httpError(404, 'Examen final introuvable ou non autorisé.');
  return result.rows[0];
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const right = new Set(b);
  return a.every(value => right.has(value));
}

export function registerQualityRoutes(app) {
  app.get('/api/quality/presentation/state', presentationQualityLimiter, safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw httpError(400, 'Code de session invalide.');
    res.set('Cache-Control', 'no-store').json(await presentationState(code));
  }));

  app.put('/api/quality/final-exams/:code/progress', safe(async (req, res) => {
    const user = await sessionUser(req, 'learner');
    const code = String(req.params.code || '').trim().toUpperCase();
    const questionId = String(req.body?.question_id || '');
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw httpError(400, 'Code d’examen invalide.');
    if (!isUuid(questionId)) throw httpError(400, 'Question invalide.');

    const result = await pool.query(
      `UPDATE final_exam_attempts attempt
       SET last_question_id=$1
       FROM final_exams exam,final_exam_questions question
       WHERE attempt.exam_id=exam.id AND question.exam_id=exam.id
         AND exam.code=$2 AND question.id=$1 AND attempt.user_id=$3
         AND attempt.submitted_at IS NULL AND attempt.expires_at>now() AND exam.status='open'
       RETURNING attempt.id`,
      [questionId, code, user.id]
    );
    if (!result.rows[0]) throw httpError(409, 'La progression ne peut plus être modifiée pour cet examen.');
    res.status(204).end();
  }));

  app.get('/api/quality/final-exams/:id/details', safe(async (req, res) => {
    await sessionUser(req, 'staff');
    const exam = await examForStaff(req.params.id);
    const [questionsResult, optionsResult, attemptsResult, answersResult] = await Promise.all([
      pool.query('SELECT id,body,points,position FROM final_exam_questions WHERE exam_id=$1 ORDER BY position,id', [exam.id]),
      pool.query(
        `SELECT option.id,option.question_id,option.label,option.body,option.is_correct
         FROM final_exam_options option
         JOIN final_exam_questions question ON question.id=option.question_id
         WHERE question.exam_id=$1 ORDER BY question.position,option.label`,
        [exam.id]
      ),
      pool.query(
        `SELECT attempt.id,attempt.user_id,attempt.started_at,attempt.expires_at,attempt.submitted_at,
          attempt.score_points,attempt.score_percent,u.first_name,u.last_name,u.participant_code
         FROM final_exam_attempts attempt JOIN app_users u ON u.id=attempt.user_id
         WHERE attempt.exam_id=$1 ORDER BY lower(u.last_name),lower(u.first_name)`,
        [exam.id]
      ),
      pool.query(
        `SELECT answer.attempt_id,answer.question_id,answer.option_id
         FROM final_exam_answers answer
         JOIN final_exam_attempts attempt ON attempt.id=answer.attempt_id
         WHERE attempt.exam_id=$1`,
        [exam.id]
      )
    ]);

    const questions = questionsResult.rows.map((question, index) => {
      const options = optionsResult.rows.filter(option => option.question_id === question.id);
      return { ...question, display_position: index + 1, options };
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

    res.set('Cache-Control', 'no-store').json({ exam, questions, attempts });
  }));
}
