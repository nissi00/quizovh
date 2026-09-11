import crypto from 'node:crypto';
import pg from 'pg';

const { Pool } = pg;
export const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

export const httpError = (status, message) => Object.assign(new Error(message), { status });
export const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    try { return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }
    catch { return [part.slice(0, index), part.slice(index + 1)]; }
  }));
}

export async function sessionUser(req, kind) {
  const cookieName = kind === 'staff' ? 'quiz_staff' : 'quiz_learner';
  const token = parseCookies(req.headers.cookie)[cookieName];
  if (!token) throw httpError(401, kind === 'staff' ? 'Connexion instructeur requise.' : 'Session apprenant expirée.');
  const result = await pool.query(
    `SELECT u.id,u.first_name,u.last_name,u.participant_code,u.role
     FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind=$2 AND s.expires_at>now() AND u.archived_at IS NULL`,
    [sha256(token), kind]
  );
  const user = result.rows[0];
  if (!user) throw httpError(401, kind === 'staff' ? 'Connexion instructeur requise.' : 'Session apprenant expirée.');
  if (kind === 'staff' && !['instructor', 'superadmin'].includes(user.role)) throw httpError(403, 'Accès instructeur requis.');
  if (kind === 'learner' && user.role !== 'learner') throw httpError(403, 'Accès apprenant requis.');
  req.user = user;
  return user;
}

export function safe(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      const status = Number(error?.status) || 500;
      if (status >= 500) console.error('[lot-improvements]', error);
      if (!res.headersSent) res.status(status).json({ message: status >= 500 ? 'Erreur interne du serveur.' : error.message });
    }
  };
}

export async function groupForStaff(groupId, user) {
  if (!isUuid(groupId)) throw httpError(400, 'Groupe invalide.');
  const result = await pool.query(
    `SELECT tg.*,t.name AS theme_name
     FROM training_groups tg JOIN themes t ON t.id=tg.theme_id
     WHERE tg.id=$1 AND tg.archived_at IS NULL AND ($2::boolean OR tg.instructor_id=$3)`,
    [groupId, user.role === 'superadmin', user.id]
  );
  if (!result.rows[0]) throw httpError(404, 'Groupe de formation introuvable ou non autorisé.');
  return result.rows[0];
}

export async function learnerScoreWithBonus(group, userId) {
  const [quizzesResult, attemptsResult, policyResult, examResult, experienceResult, bonusResult] = await Promise.all([
    pool.query(
      `SELECT q.id,count(qu.id)::integer AS question_count
       FROM chapters c JOIN quizzes q ON q.chapter_id=c.id LEFT JOIN questions qu ON qu.quiz_id=q.id
       WHERE c.theme_id=$1 AND c.is_active AND q.is_active
       GROUP BY q.id,c.position ORDER BY c.position,q.id`,
      [group.theme_id]
    ),
    pool.query(
      `SELECT ls.quiz_id,ls.id,ls.created_at,(count(las.id) FILTER (WHERE las.is_correct))::integer AS correct_count
       FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
       LEFT JOIN live_answer_submissions las ON las.session_id=ls.id AND las.participant_id=sp.id
       WHERE ls.group_id=$1 AND sp.user_id=$2
       GROUP BY ls.quiz_id,ls.id,ls.created_at ORDER BY ls.created_at DESC`,
      [group.id, userId]
    ),
    pool.query('SELECT * FROM training_group_grading WHERE group_id=$1', [group.id]),
    pool.query(
      `SELECT fea.score_percent,fea.submitted_at FROM final_exams fe
       JOIN final_exam_attempts fea ON fea.exam_id=fe.id
       WHERE fe.group_id=$1 AND fea.user_id=$2 ORDER BY fea.submitted_at DESC NULLS LAST LIMIT 1`,
      [group.id, userId]
    ),
    pool.query(
      `SELECT sum(score)::numeric AS score_total,sum(max_score)::numeric AS max_total,count(*)::integer AS evaluation_count
       FROM practical_experiences WHERE group_id=$1 AND user_id=$2`,
      [group.id, userId]
    ),
    pool.query('SELECT bonus_points FROM training_group_bonus_points WHERE group_id=$1 AND user_id=$2', [group.id, userId])
  ]);
  const policy = policyResult.rows[0] || { include_quizzes:true,quiz_weight:100,include_exam:false,exam_weight:0,include_experience:false,experience_weight:0 };
  const latestByQuiz = new Map();
  for (const attempt of attemptsResult.rows) if (!latestByQuiz.has(attempt.quiz_id)) latestByQuiz.set(attempt.quiz_id, attempt);
  const quizScores = quizzesResult.rows.map(quiz => {
    const attempt = latestByQuiz.get(quiz.id);
    const count = Number(quiz.question_count || 0);
    return count ? Math.round(Number(attempt?.correct_count || 0) * 10000 / count) / 100 : 0;
  });
  const quizScore = quizScores.length ? Math.round(quizScores.reduce((sum, value) => sum + value, 0) * 100 / quizScores.length) / 100 : 0;
  const examScore = Number(examResult.rows[0]?.score_percent || 0);
  const experience = experienceResult.rows[0] || {};
  const experienceScore = Number(experience.max_total || 0) ? Math.round(Number(experience.score_total || 0) * 10000 / Number(experience.max_total)) / 100 : 0;
  const baseGlobalScore = Math.round((
    (policy.include_quizzes ? quizScore * Number(policy.quiz_weight) : 0) +
    (policy.include_exam ? examScore * Number(policy.exam_weight) : 0) +
    (policy.include_experience ? experienceScore * Number(policy.experience_weight) : 0)
  )) / 100;
  const bonusPoints = Number(bonusResult.rows[0]?.bonus_points || 0);
  const globalScore = Math.min(100, Math.round((baseGlobalScore + bonusPoints) * 100) / 100);
  return { policy,quiz_score:quizScore,exam_score:examScore,experience_score:experienceScore,base_global_score:baseGlobalScore,bonus_points:bonusPoints,global_score:globalScore,eligible:globalScore >= Number(group.passing_score) };
}

export { crypto };
