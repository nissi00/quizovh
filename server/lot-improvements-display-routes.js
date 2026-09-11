import { pool, safe, sessionUser, httpError } from './lot-improvements-common.js';

async function questionMetrics(session) {
  const counts = await pool.query(
    `SELECT
       (SELECT count(*)::integer FROM session_participants WHERE session_id=$1 AND status='joined') AS joined_count,
       (SELECT count(*)::integer FROM questions WHERE quiz_id=$2 AND is_active AND archived_at IS NULL) AS question_count`,
    [session.id, session.quiz_id]
  );
  let questionPosition = null;
  let pollResults = [];
  if (session.current_question_id) {
    const position = await pool.query(
      `SELECT count(*)::integer AS position FROM questions q
       WHERE q.quiz_id=$1 AND q.is_active AND q.archived_at IS NULL
         AND q.position <= (SELECT position FROM questions WHERE id=$2)`,
      [session.quiz_id, session.current_question_id]
    );
    questionPosition = position.rows[0]?.position ?? null;
    if (session.status === 'polling') {
      const polls = await pool.query(
        `SELECT ao.label,count(la.id)::integer AS response_count
         FROM answer_options ao LEFT JOIN live_answers la
           ON la.option_id=ao.id AND la.session_id=$1 AND la.question_id=$2
         WHERE ao.question_id=$2 GROUP BY ao.label ORDER BY ao.label`,
        [session.id, session.current_question_id]
      );
      pollResults = polls.rows;
    }
  }
  return { joined_count:counts.rows[0].joined_count,question_count:counts.rows[0].question_count,question_position:questionPosition,poll_results:pollResults };
}

async function livePodium(sessionId) {
  const ranking = await pool.query(
    `SELECT sp.podium_alias,
       COALESCE(sum(CASE WHEN answered_question.position <= current_question.position
         AND answered_question.is_active AND answered_question.archived_at IS NULL
         THEN CASE WHEN las.is_correct AND COALESCE(las.points_earned,0)=0 THEN 1 ELSE COALESCE(las.points_earned,0) END ELSE 0 END),0)::numeric AS earned_points,
       (SELECT count(*)::integer FROM questions completed_question
        WHERE completed_question.quiz_id=ls.quiz_id AND completed_question.position <= current_question.position
          AND completed_question.is_active AND completed_question.archived_at IS NULL) AS completed_count,
       sp.joined_at
     FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
     JOIN questions current_question ON current_question.id=ls.current_question_id
     LEFT JOIN live_answer_submissions las ON las.participant_id=sp.id AND las.session_id=sp.session_id
     LEFT JOIN questions answered_question ON answered_question.id=las.question_id
     WHERE sp.session_id=$1 AND sp.status='joined' AND sp.show_on_podium
       AND sp.podium_alias IS NOT NULL AND sp.podium_alias !~ '^Joueur-[A-F0-9]{6}$'
     GROUP BY sp.id,sp.podium_alias,sp.joined_at,ls.quiz_id,current_question.position
     ORDER BY earned_points DESC,sp.joined_at ASC`,
    [sessionId]
  );
  return ranking.rows.map((item,index) => {
    const earned=Number(item.earned_points||0),completed=Number(item.completed_count||0);
    return { rank:index+1,alias:item.podium_alias,score_percent:completed?Math.round(earned*1000/completed)/10:0 };
  });
}

export function registerDisplayRoutes(app) {
  app.get('/api/improvements/presentation-state', safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw httpError(400, 'Code de session invalide.');
    const found = await pool.query(`SELECT id,quiz_id,current_question_id,status FROM live_sessions WHERE code=$1 AND archived_at IS NULL`, [code]);
    const session = found.rows[0];
    if (!session) throw httpError(404, 'Session introuvable.');
    res.set('Cache-Control','no-store').json({ status:session.status,...await questionMetrics(session) });
  }));

  app.get('/api/improvements/learner-display', safe(async (req, res) => {
    const user = await sessionUser(req, 'learner');
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw httpError(400, 'Code de session invalide.');
    const found = await pool.query(
      `SELECT ls.id,ls.quiz_id,ls.status,ls.current_question_id,ls.podium_visible,sp.id AS participant_id,sp.status AS participant_status
       FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
       WHERE ls.code=$1 AND ls.archived_at IS NULL AND sp.user_id=$2`,
      [code,user.id]
    );
    const session = found.rows[0];
    if (!session) throw httpError(404, 'Participation introuvable.');
    const metrics = await questionMetrics(session);
    let answerStatus = null;
    if (session.current_question_id && session.status === 'waiting') {
      const [selected,correct] = await Promise.all([
        pool.query(
          `SELECT ao.id,ao.is_correct FROM live_answers la JOIN answer_options ao ON ao.id=la.option_id
           WHERE la.session_id=$1 AND la.question_id=$2 AND la.participant_id=$3`,
          [session.id,session.current_question_id,session.participant_id]
        ),
        pool.query('SELECT id FROM answer_options WHERE question_id=$1 AND is_correct',[session.current_question_id])
      ]);
      if (!selected.rows.length) answerStatus='none';
      else {
        const onlyCorrect=selected.rows.every(row=>row.is_correct===true);
        const selectedIds=new Set(selected.rows.map(row=>row.id));
        const correctIds=correct.rows.map(row=>row.id);
        if (onlyCorrect && selectedIds.size===correctIds.length && correctIds.every(id=>selectedIds.has(id))) answerStatus='correct';
        else if (onlyCorrect && selectedIds.size<correctIds.length) answerStatus='partial';
        else answerStatus='incorrect';
      }
    }
    const podium = session.podium_visible && session.current_question_id ? await livePodium(session.id) : [];
    res.set('Cache-Control','no-store').json({
      status:session.status,participant_status:session.participant_status,podium_visible:Boolean(session.podium_visible),podium,
      ...metrics,answer_status:answerStatus
    });
  }));
}
