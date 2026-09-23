import { pool, safe, sessionUser, isUuid, httpError } from './lot-improvements-common.js';

const asNumber = value => value === null || value === undefined ? null : Number(value);
const sameSet = (left, right) => left.length === right.length && left.every(value => new Set(right).has(value));
const statisticsKindForExamType = examType => examType === 'experience' ? 'experience_exam' : 'exam';
const examLabelForType = examType => examType === 'experience' ? 'Examen Expérience' : 'Examen final';

function requireUuid(value, label) {
  if (!isUuid(value)) throw httpError(400, `${label} invalide.`);
  return value;
}

function responseTimeMs(timing, submission, durationSeconds) {
  if (!timing?.started_at || !submission?.submitted_at) return null;
  const started = new Date(timing.started_at).getTime();
  const submitted = new Date(submission.submitted_at).getTime();
  const ended = timing.ends_at ? new Date(timing.ends_at).getTime() : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(started) || !Number.isFinite(submitted)) return null;
  const measured = Math.max(0, Math.min(submitted, ended) - started);
  const maximum = Number(durationSeconds || 0) > 0 ? Number(durationSeconds) * 1000 : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(measured, maximum));
}

async function statisticsCatalog() {
  const [themes, groups, sessions, exams] = await Promise.all([
    pool.query(`SELECT id,name FROM themes WHERE is_active ORDER BY position,name`),
    pool.query(
      `SELECT tg.id,tg.name,tg.theme_id,t.name AS theme_name,tg.status,tg.start_date,tg.end_date
       FROM training_groups tg JOIN themes t ON t.id=tg.theme_id
       WHERE tg.archived_at IS NULL
       ORDER BY tg.start_date DESC,tg.created_at DESC`
    ),
    pool.query(
      `SELECT ls.id,ls.code,ls.group_id,tg.name AS group_name,ls.status,ls.created_at,ls.ended_at,
        t.id AS theme_id,t.name AS theme_name,c.id AS chapter_id,c.title AS chapter_title,
        q.id AS quiz_id,q.title AS quiz_title
       FROM live_sessions ls
       JOIN quizzes q ON q.id=ls.quiz_id
       JOIN chapters c ON c.id=q.chapter_id
       JOIN themes t ON t.id=c.theme_id
       LEFT JOIN training_groups tg ON tg.id=ls.group_id
       WHERE ls.archived_at IS NULL AND (tg.id IS NULL OR tg.archived_at IS NULL)
       ORDER BY ls.created_at DESC`
    ),
    pool.query(
      `SELECT fe.id,fe.group_id,fe.exam_type,fe.title,fe.code,fe.status,fe.created_at,
        tg.name AS group_name,t.id AS theme_id,t.name AS theme_name
       FROM final_exams fe
       JOIN training_groups tg ON tg.id=fe.group_id
       JOIN themes t ON t.id=tg.theme_id
       WHERE fe.archived_at IS NULL AND tg.archived_at IS NULL
       ORDER BY fe.created_at DESC`
    )
  ]);
  return { themes: themes.rows, groups: groups.rows, sessions: sessions.rows, exams: exams.rows };
}

async function quizParticipantResults(sessionId) {
  const session = await pool.query(
    `SELECT ls.id,ls.code,ls.status,ls.created_at,ls.ended_at,ls.group_id,
      COALESCE(tg.name,'Sans groupe') AS group_name,COALESCE(tg.passing_score,70)::numeric AS passing_score,
      t.id AS theme_id,t.name AS theme_name,c.id AS chapter_id,c.title AS chapter_title,
      q.id AS quiz_id,q.title AS quiz_title
     FROM live_sessions ls
     JOIN quizzes q ON q.id=ls.quiz_id
     JOIN chapters c ON c.id=q.chapter_id
     JOIN themes t ON t.id=c.theme_id
     LEFT JOIN training_groups tg ON tg.id=ls.group_id
     WHERE ls.id=$1 AND ls.archived_at IS NULL`,
    [sessionId]
  );
  if (!session.rows[0]) throw httpError(404, 'Session de quiz introuvable.');

  const result = await pool.query(
    `SELECT u.id AS user_id,u.first_name,u.last_name,u.participant_code,sp.id AS participant_id,sp.joined_at,
      count(q.id)::integer AS question_count,
      count(las.id)::integer AS answered_count,
      count(las.id) FILTER (WHERE las.is_correct)::integer AS correct_count,
      COALESCE(sum(las.points_earned),0)::numeric AS earned_points,
      max(las.submitted_at) AS last_answer_at
     FROM session_participants sp
     JOIN app_users u ON u.id=sp.user_id
     JOIN live_sessions ls ON ls.id=sp.session_id
     JOIN questions q ON q.quiz_id=ls.quiz_id AND q.is_active AND q.archived_at IS NULL
     LEFT JOIN live_answer_submissions las
       ON las.session_id=ls.id AND las.participant_id=sp.id AND las.question_id=q.id
     WHERE sp.session_id=$1 AND (sp.status<>'waiting_list' OR las.id IS NOT NULL)
     GROUP BY u.id,u.first_name,u.last_name,u.participant_code,sp.id,sp.joined_at
     ORDER BY lower(u.last_name),lower(u.first_name),sp.joined_at`,
    [sessionId]
  );

  return {
    evaluation: { kind:'quiz', ...session.rows[0] },
    participants: result.rows.map(row => {
      const questionCount = Number(row.question_count || 0);
      const points = Number(row.earned_points || 0);
      return {
        ...row,
        question_count: questionCount,
        answered_count: Number(row.answered_count || 0),
        correct_count: Number(row.correct_count || 0),
        earned_points: points,
        score_percent: questionCount ? Math.round(points * 10000 / questionCount) / 100 : 0,
        activity_at: row.last_answer_at || row.joined_at
      };
    })
  };
}

async function examParticipantResults(examId, examType) {
  const exam = await pool.query(
    `SELECT fe.id,fe.exam_type,fe.title,fe.code,fe.status,fe.group_id,fe.duration_minutes,fe.created_at,
      tg.name AS group_name,tg.passing_score::numeric AS passing_score,t.id AS theme_id,t.name AS theme_name,
      (SELECT count(*)::integer FROM final_exam_questions q WHERE q.exam_id=fe.id) AS question_count,
      (SELECT COALESCE(sum(q.points),0)::numeric FROM final_exam_questions q WHERE q.exam_id=fe.id) AS total_points
     FROM final_exams fe
     JOIN training_groups tg ON tg.id=fe.group_id
     JOIN themes t ON t.id=tg.theme_id
     WHERE fe.id=$1 AND fe.exam_type=$2 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [examId, examType]
  );
  if (!exam.rows[0]) throw httpError(404, `${examLabelForType(examType)} introuvable.`);

  const result = await pool.query(
    `SELECT a.id AS attempt_id,a.user_id,a.started_at,a.expires_at,a.submitted_at,
      a.score_points::numeric AS score_points,a.score_percent::numeric AS score_percent,
      u.first_name,u.last_name,u.participant_code,
      count(DISTINCT ans.question_id)::integer AS answered_count
     FROM final_exam_attempts a
     JOIN app_users u ON u.id=a.user_id
     LEFT JOIN final_exam_answers ans ON ans.attempt_id=a.id
     WHERE a.exam_id=$1
     GROUP BY a.id,a.user_id,a.started_at,a.expires_at,a.submitted_at,a.score_points,a.score_percent,
       u.first_name,u.last_name,u.participant_code
     ORDER BY lower(u.last_name),lower(u.first_name),a.started_at`,
    [examId]
  );

  const questionReviewResult = await pool.query(
    `WITH correct_options AS (
       SELECT q.id AS question_id,
         COALESCE(
           array_agg(o.id ORDER BY o.id) FILTER (WHERE o.is_correct),
           ARRAY[]::uuid[]
         ) AS option_ids
       FROM final_exam_questions q
       LEFT JOIN final_exam_options o ON o.question_id=q.id
       WHERE q.exam_id=$1
       GROUP BY q.id
     ), attempt_question_results AS (
       SELECT q.id,q.body,q.position,a.id AS attempt_id,
         COALESCE(
           array_agg(ans.option_id ORDER BY ans.option_id) FILTER (WHERE ans.option_id IS NOT NULL),
           ARRAY[]::uuid[]
         ) AS selected_option_ids,
         co.option_ids AS correct_option_ids
       FROM final_exam_questions q
       JOIN correct_options co ON co.question_id=q.id
       LEFT JOIN final_exam_attempts a ON a.exam_id=q.exam_id
       LEFT JOIN final_exam_answers ans ON ans.attempt_id=a.id AND ans.question_id=q.id
       WHERE q.exam_id=$1
       GROUP BY q.id,q.body,q.position,a.id,co.option_ids
     )
     SELECT id,body,position,
       count(attempt_id) FILTER (WHERE cardinality(selected_option_ids)>0)::integer AS answered_count,
       count(attempt_id) FILTER (
         WHERE cardinality(selected_option_ids)>0
           AND selected_option_ids<>correct_option_ids
       )::integer AS incorrect_count
     FROM attempt_question_results
     GROUP BY id,body,position
     ORDER BY position,id`,
    [examId]
  );

  const questionCount = Number(exam.rows[0].question_count || 0);
  const questionsToReview = questionReviewResult.rows
    .map(row => ({
      ...row,
      answered_count:Number(row.answered_count || 0),
      incorrect_count:Number(row.incorrect_count || 0)
    }))
    .filter(row => row.incorrect_count > 0 || row.answered_count === 0)
    .map(row => ({
      ...row,
      status:row.incorrect_count > 0 ? 'incorrect' : 'unanswered'
    }));
  return {
    evaluation: { kind:statisticsKindForExamType(examType), ...exam.rows[0], question_count:questionCount, total_points:Number(exam.rows[0].total_points || 0) },
    questions_to_review:questionsToReview,
    participants: result.rows.map(row => ({
      ...row,
      answered_count: Number(row.answered_count || 0),
      question_count: questionCount,
      score_points: asNumber(row.score_points),
      score_percent: asNumber(row.score_percent),
      activity_at: row.submitted_at || row.started_at,
      state: row.submitted_at ? 'submitted' : (new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'in_progress')
    }))
  };
}

async function quizDetail(sessionId, userId) {
  const base = await pool.query(
    `SELECT ls.id AS session_id,ls.code,ls.status,ls.created_at,ls.ended_at,ls.group_id,
      COALESCE(tg.name,'Sans groupe') AS group_name,t.id AS theme_id,t.name AS theme_name,
      c.id AS chapter_id,c.title AS chapter_title,q.id AS quiz_id,q.title AS quiz_title,
      sp.id AS participant_id,sp.joined_at,u.id AS user_id,u.first_name,u.last_name,u.participant_code
     FROM live_sessions ls
     JOIN quizzes q ON q.id=ls.quiz_id
     JOIN chapters c ON c.id=q.chapter_id
     JOIN themes t ON t.id=c.theme_id
     LEFT JOIN training_groups tg ON tg.id=ls.group_id
     JOIN session_participants sp ON sp.session_id=ls.id
     JOIN app_users u ON u.id=sp.user_id
     WHERE ls.id=$1 AND u.id=$2 AND ls.archived_at IS NULL`,
    [sessionId, userId]
  );
  const meta = base.rows[0];
  if (!meta) throw httpError(404, 'Résultat de quiz introuvable pour cet apprenant.');

  const [questionsResult, optionsResult, submissionsResult, answersResult, timingsResult] = await Promise.all([
    pool.query(
      `SELECT id,body,position,duration_seconds FROM questions
       WHERE quiz_id=$1 AND is_active AND archived_at IS NULL ORDER BY position,id`,
      [meta.quiz_id]
    ),
    pool.query(
      `SELECT o.id,o.question_id,o.label,o.body,o.is_correct
       FROM answer_options o JOIN questions q ON q.id=o.question_id
       WHERE q.quiz_id=$1 AND q.is_active AND q.archived_at IS NULL
       ORDER BY q.position,o.label`,
      [meta.quiz_id]
    ),
    pool.query(
      `SELECT question_id,is_correct,points_earned::numeric AS points_earned,submitted_at
       FROM live_answer_submissions WHERE session_id=$1 AND participant_id=$2`,
      [sessionId, meta.participant_id]
    ),
    pool.query(
      `SELECT question_id,option_id,submitted_at FROM live_answers
       WHERE session_id=$1 AND participant_id=$2 ORDER BY submitted_at`,
      [sessionId, meta.participant_id]
    ),
    pool.query(
      `SELECT question_id,started_at,ends_at FROM live_question_timings WHERE session_id=$1`,
      [sessionId]
    )
  ]);

  const submissions = new Map(submissionsResult.rows.map(row => [row.question_id, row]));
  const timings = new Map(timingsResult.rows.map(row => [row.question_id, row]));
  const questions = questionsResult.rows.map((question, index) => {
    const options = optionsResult.rows.filter(option => option.question_id === question.id);
    const selectedIds = answersResult.rows.filter(answer => answer.question_id === question.id).map(answer => answer.option_id);
    const submission = submissions.get(question.id) || null;
    const points = Number(submission?.points_earned || 0);
    let status = 'unanswered';
    if (submission) status = submission.is_correct ? 'correct' : (points > 0 ? 'partial' : 'incorrect');
    return {
      ...question,
      display_position:index + 1,
      possible_points:1,
      points_earned:points,
      status,
      selected_option_ids:selectedIds,
      options,
      submitted_at:submission?.submitted_at || null,
      response_time_ms:responseTimeMs(timings.get(question.id), submission, question.duration_seconds)
    };
  });
  const earned = questions.reduce((sum, question) => sum + Number(question.points_earned || 0), 0);
  const correct = questions.filter(question => question.status === 'correct').length;
  const answered = questions.filter(question => question.status !== 'unanswered').length;
  return {
    evaluation:{ kind:'quiz', ...meta },
    learner:{ id:meta.user_id,first_name:meta.first_name,last_name:meta.last_name,participant_code:meta.participant_code },
    summary:{ question_count:questions.length,answered_count:answered,correct_count:correct,earned_points:Math.round(earned*100)/100,total_points:questions.length,score_percent:questions.length?Math.round(earned*10000/questions.length)/100:0 },
    questions
  };
}

async function examDetail(examId, userId, examType) {
  const base = await pool.query(
    `SELECT a.id AS attempt_id,a.started_at,a.expires_at,a.submitted_at,a.score_points::numeric AS score_points,
      a.score_percent::numeric AS score_percent,fe.id AS exam_id,fe.title,fe.code,fe.status,fe.duration_minutes,
      fe.group_id,fe.exam_type,tg.name AS group_name,t.id AS theme_id,t.name AS theme_name,
      u.id AS user_id,u.first_name,u.last_name,u.participant_code
     FROM final_exam_attempts a
     JOIN final_exams fe ON fe.id=a.exam_id
     JOIN training_groups tg ON tg.id=fe.group_id
     JOIN themes t ON t.id=tg.theme_id
     JOIN app_users u ON u.id=a.user_id
     WHERE fe.id=$1 AND u.id=$2 AND fe.exam_type=$3 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [examId, userId, examType]
  );
  const meta = base.rows[0];
  if (!meta) throw httpError(404, `Copie d’${examLabelForType(examType).toLocaleLowerCase('fr-FR')} introuvable pour cet apprenant.`);

  const [questionsResult, optionsResult, answersResult, timingsResult] = await Promise.all([
    pool.query('SELECT id,body,points::numeric AS points,position FROM final_exam_questions WHERE exam_id=$1 ORDER BY position,id', [examId]),
    pool.query(
      `SELECT o.id,o.question_id,o.label,o.body,o.is_correct
       FROM final_exam_options o JOIN final_exam_questions q ON q.id=o.question_id
       WHERE q.exam_id=$1 ORDER BY q.position,o.label`,
      [examId]
    ),
    pool.query('SELECT question_id,option_id FROM final_exam_answers WHERE attempt_id=$1', [meta.attempt_id]),
    pool.query(
      `SELECT question_id,accumulated_ms,active_started_at,answered_at
       FROM final_exam_question_timings WHERE attempt_id=$1`,
      [meta.attempt_id]
    )
  ]);

  const timings = new Map(timingsResult.rows.map(row => [row.question_id, row]));
  const questions = questionsResult.rows.map((question, index) => {
    const options = optionsResult.rows.filter(option => option.question_id === question.id);
    const selected = answersResult.rows.filter(answer => answer.question_id === question.id).map(answer => answer.option_id);
    const correct = options.filter(option => option.is_correct).map(option => option.id);
    const answered = selected.length > 0;
    const isCorrect = answered && sameSet(selected, correct);
    const timing = timings.get(question.id);
    let responseTime = timing ? Number(timing.accumulated_ms || 0) : null;
    if (timing?.active_started_at && !timing.answered_at) {
      const started = new Date(timing.active_started_at).getTime();
      const stopCandidates = [Date.now(), new Date(meta.expires_at).getTime()];
      if (meta.submitted_at) stopCandidates.push(new Date(meta.submitted_at).getTime());
      const stopped = Math.min(...stopCandidates.filter(Number.isFinite));
      if (Number.isFinite(started) && Number.isFinite(stopped)) responseTime += Math.max(0, stopped-started);
    }
    const possible = Number(question.points || 0);
    return {
      ...question,
      points:possible,
      display_position:index + 1,
      possible_points:possible,
      points_earned:isCorrect ? possible : 0,
      status:answered ? (isCorrect ? 'correct' : 'incorrect') : 'unanswered',
      selected_option_ids:selected,
      options,
      response_time_ms:timing ? Math.round(responseTime) : null,
      answered_at:timing?.answered_at || null
    };
  });

  const earned = meta.score_points === null ? questions.reduce((sum,q)=>sum+q.points_earned,0) : Number(meta.score_points);
  const total = questions.reduce((sum,q)=>sum+q.possible_points,0);
  const answered = questions.filter(question=>question.status!=='unanswered').length;
  const correct = questions.filter(question=>question.status==='correct').length;
  return {
    evaluation:{ kind:statisticsKindForExamType(examType),exam_type:meta.exam_type,exam_id:meta.exam_id,title:meta.title,code:meta.code,status:meta.status,group_id:meta.group_id,group_name:meta.group_name,theme_id:meta.theme_id,theme_name:meta.theme_name,duration_minutes:meta.duration_minutes },
    learner:{ id:meta.user_id,first_name:meta.first_name,last_name:meta.last_name,participant_code:meta.participant_code },
    attempt:{ id:meta.attempt_id,started_at:meta.started_at,expires_at:meta.expires_at,submitted_at:meta.submitted_at },
    summary:{ question_count:questions.length,answered_count:answered,correct_count:correct,earned_points:Math.round(earned*100)/100,total_points:Math.round(total*100)/100,score_percent:meta.score_percent===null?(total?Math.round(earned*10000/total)/100:0):Number(meta.score_percent) },
    questions
  };
}

async function closeActiveTiming(client, attemptId, questionId = null) {
  const values = questionId ? [attemptId, questionId] : [attemptId];
  const questionFilter = questionId ? ' AND question_id=$2' : '';
  await client.query(
    `UPDATE final_exam_question_timings
     SET accumulated_ms=accumulated_ms + GREATEST(0,FLOOR(EXTRACT(EPOCH FROM (now()-active_started_at))*1000)::bigint),
       active_started_at=NULL,updated_at=now()
     WHERE attempt_id=$1${questionFilter} AND active_started_at IS NOT NULL AND answered_at IS NULL`,
    values
  );
}

async function recordExamTiming(user, body) {
  const code = String(body?.exam_code || '').trim().toUpperCase();
  const questionId = requireUuid(String(body?.question_id || ''), 'Question');
  const action = String(body?.action || '');
  if (!/^[A-Z0-9]{4,8}$/.test(code)) throw httpError(400, 'Code d’examen invalide.');
  if (!['enter','pause','answer'].includes(action)) throw httpError(400, 'Action de chronométrage invalide.');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const attemptResult = await client.query(
      `SELECT a.id,a.submitted_at,a.expires_at,fe.id AS exam_id
       FROM final_exam_attempts a JOIN final_exams fe ON fe.id=a.exam_id
       WHERE fe.code=$1 AND a.user_id=$2 FOR UPDATE OF a`,
      [code,user.id]
    );
    const attempt = attemptResult.rows[0];
    if (!attempt || attempt.submitted_at || new Date(attempt.expires_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return;
    }
    const question = await client.query('SELECT id FROM final_exam_questions WHERE id=$1 AND exam_id=$2', [questionId,attempt.exam_id]);
    if (!question.rows[0]) throw httpError(404, 'Question d’examen introuvable.');

    if (action === 'enter') {
      await closeActiveTiming(client, attempt.id);
      await client.query(
        `INSERT INTO final_exam_question_timings(attempt_id,question_id,active_started_at,updated_at)
         VALUES($1,$2,now(),now())
         ON CONFLICT(attempt_id,question_id) DO UPDATE SET
           active_started_at=CASE WHEN final_exam_question_timings.answered_at IS NULL THEN now() ELSE final_exam_question_timings.active_started_at END,
           updated_at=now()`,
        [attempt.id,questionId]
      );
    } else if (action === 'pause') {
      await closeActiveTiming(client, attempt.id, questionId);
    } else {
      await closeActiveTiming(client, attempt.id, questionId);
      await client.query(
        `INSERT INTO final_exam_question_timings(attempt_id,question_id,answered_at,updated_at)
         VALUES($1,$2,now(),now())
         ON CONFLICT(attempt_id,question_id) DO UPDATE SET
           answered_at=COALESCE(final_exam_question_timings.answered_at,now()),updated_at=now()`,
        [attempt.id,questionId]
      );
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(()=>undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function registerStatisticsRoutes(app) {
  app.get('/api/statistics/catalog', safe(async (req,res) => {
    await sessionUser(req,'staff');
    res.set('Cache-Control','no-store').json(await statisticsCatalog());
  }));

  app.get('/api/statistics/results', safe(async (req,res) => {
    await sessionUser(req,'staff');
    const kind = String(req.query?.kind || '');
    if (kind === 'quiz') {
      const sessionId = requireUuid(String(req.query?.session_id || ''), 'Session');
      return res.set('Cache-Control','no-store').json(await quizParticipantResults(sessionId));
    }
    if (kind === 'exam' || kind === 'experience_exam') {
      const examId = requireUuid(String(req.query?.exam_id || ''), 'Examen');
      const examType = kind === 'experience_exam' ? 'experience' : 'final';
      return res.set('Cache-Control','no-store').json(await examParticipantResults(examId,examType));
    }
    throw httpError(400, 'Type de statistique invalide.');
  }));

  app.get('/api/statistics/detail', safe(async (req,res) => {
    await sessionUser(req,'staff');
    const kind = String(req.query?.kind || '');
    const userId = requireUuid(String(req.query?.user_id || ''), 'Apprenant');
    if (kind === 'quiz') {
      const sessionId = requireUuid(String(req.query?.session_id || ''), 'Session');
      return res.set('Cache-Control','no-store').json(await quizDetail(sessionId,userId));
    }
    if (kind === 'exam' || kind === 'experience_exam') {
      const examId = requireUuid(String(req.query?.exam_id || ''), 'Examen');
      const examType = kind === 'experience_exam' ? 'experience' : 'final';
      return res.set('Cache-Control','no-store').json(await examDetail(examId,userId,examType));
    }
    throw httpError(400, 'Type de statistique invalide.');
  }));

  app.post('/api/statistics/exam-timing', safe(async (req,res) => {
    const user = await sessionUser(req,'learner');
    await recordExamTiming(user,req.body || {});
    res.status(204).end();
  }));
}
