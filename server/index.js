import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import QRCode from 'qrcode';
import { createCertificatesPdf } from './certificate-pdf.js';

const { Pool } = pg;
const scrypt = promisify(crypto.scrypt);
const port = Number(process.env.PORT || 3000);
const publicDir = process.env.PUBLIC_DIR || path.resolve('public');
const cookieSecure = String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true';
const setupToken = process.env.SETUP_TOKEN || '';

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 10,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (status, message) => { throw new HttpError(status, message); };
// PostgreSQL accepts canonical UUIDs independently of their RFC version bits.
// The demo catalogue uses deterministic UUIDs, so validate the canonical shape
// here and let the database type perform the final validation.
const isUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || ''));
const requiredText = (value, label, max = 500) => {
  const normalized = String(value || '').trim();
  if (!normalized) fail(400, `${label} requis.`);
  if (normalized.length > max) fail(400, `${label} trop long.`);
  return normalized;
};
const assertUuid = (value, label = 'Identifiant') => {
  if (!isUuid(value)) fail(400, `${label} invalide.`);
  return value;
};
const tokenHash = token => crypto.createHash('sha256').update(token).digest('hex');
const participantAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const cookieOptions = maxAge => ({
  httpOnly: true,
  secure: cookieSecure,
  sameSite: 'strict',
  path: '/',
  maxAge
});

async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12) {
    fail(400, 'Le mot de passe doit contenir au moins 12 caractères.');
  }
  if (password.length > 200) fail(400, 'Mot de passe trop long.');
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('hex')}$${Buffer.from(derived).toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [algorithm, n, r, p, saltHex, hashHex] = String(stored || '').split('$');
    if (algorithm !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024
    }));
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function safeTokenMatch(received, expected) {
  const a = Buffer.from(String(received || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

async function issueSession(res, userId, kind) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const hours = kind === 'staff' ? 8 : 5 * 24;
  await pool.query(
    `INSERT INTO auth_sessions(token_hash,user_id,kind,expires_at)
     VALUES($1,$2,$3,now()+($4 || ' hours')::interval)`,
    [tokenHash(raw), userId, kind, String(hours)]
  );
  const cookieName = kind === 'staff' ? 'quiz_staff' : 'quiz_learner';
  res.cookie(cookieName, raw, cookieOptions(hours * 60 * 60 * 1000));
}

async function findSession(req, kind) {
  const cookieName = kind === 'staff' ? 'quiz_staff' : 'quiz_learner';
  const raw = req.cookies?.[cookieName];
  if (!raw) return null;
  const result = await pool.query(
    `SELECT u.id,u.email,u.participant_code,u.first_name,u.last_name,u.role,s.id AS auth_session_id
     FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind=$2 AND s.expires_at>now() AND u.archived_at IS NULL`,
    [tokenHash(raw), kind]
  );
  return result.rows[0] || null;
}

function normalizeParticipantCode(value) {
  const compact = String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^TS[A-Z0-9]{8}$/.test(compact)) fail(400, 'Code personnel invalide.');
  return `TS-${compact.slice(2, 6)}-${compact.slice(6)}`;
}

async function generateParticipantCode(client = pool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    const randomPart = Array.from(bytes, byte => participantAlphabet[byte % participantAlphabet.length]).join('');
    const code = `TS-${randomPart.slice(0, 4)}-${randomPart.slice(4)}`;
    const existing = await client.query('SELECT 1 FROM app_users WHERE participant_code=$1', [code]);
    if (!existing.rows[0]) return code;
  }
  throw new Error('Impossible de générer un code personnel unique.');
}

async function generateExamCode(client = pool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, byte => participantAlphabet[byte % participantAlphabet.length]).join('');
    const existing = await client.query('SELECT 1 FROM final_exams WHERE code=$1', [code]);
    if (!existing.rows[0]) return code;
  }
  throw new Error('Impossible de générer un code d’examen unique.');
}

async function generatePodiumAlias(client, sessionId) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const alias = `Joueur-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const existing = await client.query('SELECT 1 FROM session_participants WHERE session_id=$1 AND podium_alias=$2', [sessionId, alias]);
    if (!existing.rows[0]) return alias;
  }
  throw new Error('Impossible de générer un pseudonyme de podium unique.');
}

const requireStaff = asyncRoute(async (req, _res, next) => {
  const user = await findSession(req, 'staff');
  if (!user || !['instructor', 'superadmin'].includes(user.role)) fail(401, 'Connexion instructeur requise.');
  req.user = user;
  next();
});

const requireLearner = asyncRoute(async (req, _res, next) => {
  const user = await findSession(req, 'learner');
  if (!user || user.role !== 'learner') fail(401, 'Session apprenant expirée. Rejoignez à nouveau le quiz.');
  req.user = user;
  next();
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

async function closeExpiredQuestions() {
  const candidate = await pool.query(
    `SELECT 1 FROM live_sessions
     WHERE status='live' AND current_question_id IS NOT NULL
       AND question_ends_at IS NOT NULL AND question_ends_at<=now()
     LIMIT 1`
  );
  if (!candidate.rows[0]) return;
  await withTransaction(async client => {
    const expired = await client.query(
      `SELECT id,current_question_id FROM live_sessions
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
        `INSERT INTO live_answer_submissions(session_id,question_id,participant_id,is_correct)
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
           )
         FROM session_participants sp
         WHERE sp.session_id=$1 AND sp.status='joined'
           AND EXISTS (
             SELECT 1 FROM live_answer_drafts d
             WHERE d.session_id=$1 AND d.question_id=$2 AND d.participant_id=sp.id
           )
         ON CONFLICT(session_id,question_id,participant_id) DO NOTHING`,
        [session.id, session.current_question_id]
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

function staffScope(user, startIndex = 1) {
  return user.role === 'superadmin'
    ? { clause: '', values: [] }
    : { clause: ` WHERE instructor_id=$${startIndex}`, values: [user.id] };
}

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  hsts: false,
  frameguard: false,
  crossOriginOpenerPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://appsforoffice.microsoft.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: [
        "'self'",
        'https://*.office.com',
        'https://*.office.net',
        'https://*.officeapps.live.com',
        'https://*.microsoft365.com',
        'https://*.sharepoint.com'
      ],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(cookieParser());
app.use(express.json({ limit: '100kb' }));

app.use('/api', (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const expectedHost = req.get('x-forwarded-host') || req.get('host');
    if (new URL(origin).host !== expectedHost) fail(403, 'Origine de la requête refusée.');
  } catch (error) {
    return next(error);
  }
  next();
});

const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false });
const joinLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false });
const presentationLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false });

app.get('/api/health', asyncRoute(async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ status: 'ok' });
}));

app.get('/api/setup/status', asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT count(*)::integer AS count FROM app_users WHERE role IN ('instructor','superadmin') AND password_hash IS NOT NULL");
  res.json({ required: result.rows[0].count === 0 });
}));

app.post('/api/setup', sensitiveLimiter, asyncRoute(async (req, res) => {
  if (!setupToken || !safeTokenMatch(req.body?.token, setupToken)) fail(403, 'Jeton d’installation invalide.');
  const email = requiredText(req.body?.email, 'Adresse e-mail', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'Adresse e-mail invalide.');
  const firstName = requiredText(req.body?.first_name, 'Prénom', 100);
  const lastName = requiredText(req.body?.last_name, 'Nom', 100);
  const passwordHash = await hashPassword(req.body?.password);
  const user = await withTransaction(async client => {
    await client.query('LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE');
    const count = await client.query("SELECT count(*)::integer AS count FROM app_users WHERE role IN ('instructor','superadmin') AND password_hash IS NOT NULL");
    if (count.rows[0].count > 0) fail(409, 'Le compte administrateur existe déjà.');
    const created = await client.query(
      `INSERT INTO app_users(email,first_name,last_name,role,password_hash)
       VALUES($1,$2,$3,'superadmin',$4)
       ON CONFLICT(email) DO UPDATE SET
         first_name=EXCLUDED.first_name,
         last_name=EXCLUDED.last_name,
         role='superadmin',
         password_hash=EXCLUDED.password_hash
       RETURNING id,email,first_name,last_name,role`,
      [email, firstName, lastName, passwordHash]
    );
    return created.rows[0];
  });
  await issueSession(res, user.id, 'staff');
  res.status(201).json({ user });
}));

app.post('/api/auth/login', sensitiveLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const result = await pool.query(
    `SELECT id,email,first_name,last_name,role,password_hash FROM app_users
     WHERE email=$1 AND role IN ('instructor','superadmin')`,
    [email]
  );
  const user = result.rows[0];
  if (!user || !(await verifyPassword(password, user.password_hash))) fail(401, 'Adresse e-mail ou mot de passe incorrect.');
  await pool.query('DELETE FROM auth_sessions WHERE expires_at<=now()');
  await issueSession(res, user.id, 'staff');
  delete user.password_hash;
  res.json({ user });
}));

app.post('/api/auth/logout', asyncRoute(async (req, res) => {
  const raw = req.cookies?.quiz_staff;
  if (raw) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash(raw)]);
  res.clearCookie('quiz_staff', { path: '/', sameSite: 'strict', secure: cookieSecure });
  res.status(204).end();
}));

app.get('/api/auth/me', requireStaff, (req, res) => res.json({ user: req.user }));
app.get('/api/instructor/profile', requireStaff, (req, res) => res.json(req.user));

async function participantsForStaff(user) {
  const ownershipClause = user.role === 'superadmin' ? '' : ' AND ls.instructor_id=$1';
  const ownershipValues = user.role === 'superadmin' ? [] : [user.id];
  const usersResult = await pool.query(
    `SELECT u.id,u.first_name,u.last_name,u.participant_code,u.created_at
     FROM app_users u
     WHERE u.role='learner' AND u.archived_at IS NULL AND EXISTS (
       SELECT 1 FROM session_participants sp
       JOIN live_sessions ls ON ls.id=sp.session_id
       WHERE sp.user_id=u.id${ownershipClause}
     )
     ORDER BY lower(u.last_name),lower(u.first_name),u.created_at`,
    ownershipValues
  );
  if (!usersResult.rows.length) return [];
  const userIds = usersResult.rows.map(row => row.id);
  const detailOwnershipClause = user.role === 'superadmin' ? '' : ' AND ls.instructor_id=$2';
  const detailValues = user.role === 'superadmin' ? [userIds] : [userIds, user.id];
  const participationsResult = await pool.query(
    `SELECT sp.user_id,sp.joined_at,ls.id AS session_id,ls.code AS session_code,
      qz.id AS quiz_id,qz.title AS quiz_title,c.id AS chapter_id,c.title AS chapter_title,
      t.id AS theme_id,t.name AS theme_name,
      COALESCE(max(las.submitted_at),sp.joined_at) AS last_activity
     FROM session_participants sp
     JOIN live_sessions ls ON ls.id=sp.session_id
     JOIN quizzes qz ON qz.id=ls.quiz_id
     JOIN chapters c ON c.id=qz.chapter_id
     JOIN themes t ON t.id=c.theme_id
     LEFT JOIN live_answer_submissions las ON las.participant_id=sp.id
     WHERE sp.user_id=ANY($1::uuid[])${detailOwnershipClause}
     GROUP BY sp.user_id,sp.joined_at,ls.id,ls.code,qz.id,qz.title,c.id,c.title,t.id,t.name
     ORDER BY sp.joined_at DESC`,
    detailValues
  );
  return usersResult.rows.map(learner => {
    const participations = participationsResult.rows.filter(row => row.user_id === learner.id);
    const activityDates = [learner.created_at, ...participations.map(row => row.last_activity)].filter(Boolean).map(value => new Date(value).getTime());
    return {
      ...learner,
      last_activity: new Date(Math.max(...activityDates)).toISOString(),
      participations
    };
  });
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

async function trainingGroupForStaff(groupId, user) {
  const values = user.role === 'superadmin' ? [groupId] : [groupId, user.id];
  const ownership = user.role === 'superadmin' ? '' : ' AND tg.instructor_id=$2';
  const result = await pool.query(
    `SELECT tg.*,t.name AS theme_name,concat_ws(' ',i.first_name,i.last_name) AS instructor_name
     FROM training_groups tg JOIN themes t ON t.id=tg.theme_id JOIN app_users i ON i.id=tg.instructor_id
     WHERE tg.id=$1 AND tg.archived_at IS NULL${ownership}`,
    values
  );
  if (!result.rows[0]) fail(404, 'Groupe de formation introuvable ou non autorisé.');
  return result.rows[0];
}

async function trainingGroupResults(groupId, user) {
  const group = await trainingGroupForStaff(groupId, user);
  const [quizzesResult, learnersResult, attemptsResult, certificatesResult, policyResult, examResult, experiencesResult] = await Promise.all([
    pool.query(
      `SELECT q.id,q.title,c.title AS chapter_title,c.position,
        count(qu.id)::integer AS question_count
       FROM chapters c JOIN quizzes q ON q.chapter_id=c.id LEFT JOIN questions qu ON qu.quiz_id=q.id
       WHERE c.theme_id=$1 AND c.is_active AND q.is_active
       GROUP BY q.id,q.title,c.title,c.position ORDER BY c.position,q.title`,
      [group.theme_id]
    ),
    pool.query(
      `SELECT u.id,u.first_name,u.last_name,u.participant_code,tgp.joined_at
       FROM training_group_participants tgp JOIN app_users u ON u.id=tgp.user_id
       WHERE tgp.group_id=$1 ORDER BY lower(u.last_name),lower(u.first_name)`,
      [groupId]
    ),
    pool.query(
      `SELECT sp.user_id,ls.quiz_id,ls.id AS session_id,ls.created_at,
        (count(las.id) FILTER (WHERE las.is_correct))::integer AS correct_count
       FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
       LEFT JOIN live_answer_submissions las ON las.session_id=ls.id AND las.participant_id=sp.id
       WHERE ls.group_id=$1
       GROUP BY sp.user_id,ls.quiz_id,ls.id,ls.created_at ORDER BY ls.created_at DESC`,
      [groupId]
    ),
    pool.query(
      `SELECT id,user_id,certificate_number,public_token,global_score,status,issued_at,revoked_at,grading_snapshot
       FROM certificates WHERE training_group_id=$1 AND archived_at IS NULL`,
      [groupId]
    ),
    pool.query('SELECT * FROM training_group_grading WHERE group_id=$1', [groupId]),
    pool.query(
      `SELECT fe.id,fe.title,fe.status,fea.user_id,fea.score_percent,fea.submitted_at
       FROM final_exams fe LEFT JOIN final_exam_attempts fea ON fea.exam_id=fe.id
       WHERE fe.group_id=$1`,
      [groupId]
    ),
    pool.query(
      `SELECT user_id,sum(score)::numeric AS score_total,sum(max_score)::numeric AS max_total,count(*)::integer AS evaluation_count
       FROM practical_experiences WHERE group_id=$1 GROUP BY user_id`,
      [groupId]
    )
  ]);
  const quizzes = quizzesResult.rows;
  const policy = policyResult.rows[0] || {
    group_id: groupId, include_quizzes: true, quiz_weight: 100,
    include_exam: false, exam_weight: 0, include_experience: false, experience_weight: 0
  };
  const attemptsByLearnerQuiz = new Map();
  for (const attempt of attemptsResult.rows) {
    const key = `${attempt.user_id}:${attempt.quiz_id}`;
    if (!attemptsByLearnerQuiz.has(key)) attemptsByLearnerQuiz.set(key, attempt);
  }
  const certificatesByLearner = new Map(certificatesResult.rows.map(item => [item.user_id, item]));
  const examsByLearner = new Map(examResult.rows.filter(item => item.user_id).map(item => [item.user_id, item]));
  const experiencesByLearner = new Map(experiencesResult.rows.map(item => [item.user_id, item]));
  const participants = learnersResult.rows.map(learner => {
    const quiz_scores = quizzes.map(quiz => {
      const attempt = attemptsByLearnerQuiz.get(`${learner.id}:${quiz.id}`);
      const questionCount = Number(quiz.question_count || 0);
      const correctCount = Number(attempt?.correct_count || 0);
      return {
        quiz_id: quiz.id, chapter_title: quiz.chapter_title, question_count: questionCount,
        correct_count: correctCount, taken: Boolean(attempt),
        score: questionCount ? Math.round(correctCount * 10000 / questionCount) / 100 : 0
      };
    });
    const quizScore = quizzes.length
      ? Math.round(quiz_scores.reduce((sum, quiz) => sum + quiz.score, 0) * 100 / quizzes.length) / 100
      : 0;
    const examAttempt = examsByLearner.get(learner.id);
    const examScore = Number(examAttempt?.score_percent || 0);
    const experience = experiencesByLearner.get(learner.id);
    const experienceScore = Number(experience?.max_total || 0)
      ? Math.round(Number(experience.score_total) * 10000 / Number(experience.max_total)) / 100
      : 0;
    const globalScore = Math.round((
      (policy.include_quizzes ? quizScore * Number(policy.quiz_weight) : 0) +
      (policy.include_exam ? examScore * Number(policy.exam_weight) : 0) +
      (policy.include_experience ? experienceScore * Number(policy.experience_weight) : 0)
    )) / 100;
    return {
      ...learner, quiz_scores, quiz_score: quizScore,
      exam_score: examScore, exam_submitted: Boolean(examAttempt?.submitted_at),
      experience_score: experienceScore, experience_count: Number(experience?.evaluation_count || 0),
      global_score: globalScore,
      eligible: globalScore >= Number(group.passing_score),
      certificate: certificatesByLearner.get(learner.id) || null
    };
  });
  return { group, quizzes, policy, final_exam: examResult.rows[0] || null, participants };
}

function verificationBaseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

function certificateFileData(row, req) {
  return { ...row, verification_url: `${verificationBaseUrl(req)}/certificate.html?token=${encodeURIComponent(row.public_token)}` };
}

async function certificatesForGroup(groupId, user, req, certificateId = null) {
  await trainingGroupForStaff(groupId, user);
  const values = certificateId ? [groupId, certificateId] : [groupId];
  const filter = certificateId ? ' AND cert.id=$2' : '';
  const result = await pool.query(
    `SELECT cert.*,u.first_name,u.last_name,tg.name AS group_name,tg.start_date,tg.end_date,
      t.name AS theme_name,concat_ws(' ',issuer.first_name,issuer.last_name) AS issuer_name
     FROM certificates cert JOIN app_users u ON u.id=cert.user_id
     JOIN training_groups tg ON tg.id=cert.training_group_id JOIN themes t ON t.id=tg.theme_id
     JOIN app_users issuer ON issuer.id=cert.issued_by
     WHERE cert.training_group_id=$1 AND cert.status='issued' AND cert.archived_at IS NULL${filter}
     ORDER BY lower(u.last_name),lower(u.first_name)`,
    values
  );
  return result.rows.map(row => certificateFileData(row, req));
}

app.get('/api/training-groups', requireStaff, asyncRoute(async (req, res) => {
  const ownership = req.user.role === 'superadmin' ? ' WHERE tg.archived_at IS NULL' : ' WHERE tg.archived_at IS NULL AND tg.instructor_id=$1';
  const values = req.user.role === 'superadmin' ? [] : [req.user.id];
  const result = await pool.query(
    `SELECT tg.*,t.name AS theme_name,concat_ws(' ',i.first_name,i.last_name) AS instructor_name,
      count(DISTINCT tgp.user_id)::integer AS participant_count,count(DISTINCT ls.id)::integer AS session_count
     FROM training_groups tg JOIN themes t ON t.id=tg.theme_id JOIN app_users i ON i.id=tg.instructor_id
     LEFT JOIN training_group_participants tgp ON tgp.group_id=tg.id LEFT JOIN live_sessions ls ON ls.group_id=tg.id AND ls.archived_at IS NULL
     ${ownership} GROUP BY tg.id,t.name,i.first_name,i.last_name ORDER BY tg.start_date DESC,tg.created_at DESC`,
    values
  );
  res.json(result.rows);
}));

app.post('/api/training-groups', requireStaff, asyncRoute(async (req, res) => {
  const themeId = assertUuid(req.body?.theme_id, 'Thème');
  const name = requiredText(req.body?.name, 'Nom du groupe', 200);
  const startDate = requiredText(req.body?.start_date, 'Date de début', 10);
  const endDate = requiredText(req.body?.end_date, 'Date de fin', 10);
  const passingScore = Number(req.body?.passing_score ?? 70);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate < startDate) fail(400, 'Période de formation invalide.');
  if (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 100) fail(400, 'Seuil de réussite invalide.');
  const theme = await pool.query('SELECT id FROM themes WHERE id=$1 AND is_active', [themeId]);
  if (!theme.rows[0]) fail(404, 'Thème introuvable.');
  const created = await pool.query(
    `INSERT INTO training_groups(theme_id,instructor_id,name,client_name,start_date,end_date,location,modality,passing_score,status)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'planned') RETURNING *`,
    [themeId, req.user.id, name, String(req.body?.client_name || '').trim() || null, startDate, endDate,
      String(req.body?.location || '').trim() || null, String(req.body?.modality || '').trim() || null, passingScore]
  );
  res.status(201).json(created.rows[0]);
}));

app.patch('/api/training-groups/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Groupe');
  const group = await trainingGroupForStaff(id, req.user);
  const allowed = ['name', 'client_name', 'start_date', 'end_date', 'location', 'modality', 'passing_score', 'status'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in (req.body || {}))) continue;
    let value = req.body[key];
    if (key === 'name') value = requiredText(value, 'Nom du groupe', 200);
    if (['client_name', 'location', 'modality'].includes(key)) value = String(value || '').trim() || null;
    if (key === 'status' && !['planned', 'active', 'finished'].includes(value)) fail(400, 'État du groupe invalide.');
    if (key === 'passing_score') {
      value = Number(value);
      if (!Number.isFinite(value) || value < 0 || value > 100) fail(400, 'Seuil de réussite invalide.');
    }
    if (['start_date', 'end_date'].includes(key) && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) fail(400, 'Date invalide.');
    values.push(value);
    fields.push(`${key}=$${values.length}`);
  }
  if (!fields.length) fail(400, 'Aucune modification valide.');
  const nextStart = req.body?.start_date || String(group.start_date).slice(0, 10);
  const nextEnd = req.body?.end_date || String(group.end_date).slice(0, 10);
  if (nextEnd < nextStart) fail(400, 'La date de fin doit suivre la date de début.');
  values.push(id);
  await pool.query(`UPDATE training_groups SET ${fields.join(',')} WHERE id=$${values.length}`, values);
  res.status(204).end();
}));

app.get('/api/training-groups/:id/results', requireStaff, asyncRoute(async (req, res) => {
  res.json(await trainingGroupResults(assertUuid(req.params.id, 'Groupe'), req.user));
}));

app.put('/api/training-groups/:id/grading-policy', requireStaff, asyncRoute(async (req, res) => {
  const groupId = assertUuid(req.params.id, 'Groupe');
  await trainingGroupForStaff(groupId, req.user);
  const includeQuizzes = Boolean(req.body?.include_quizzes);
  const includeExam = Boolean(req.body?.include_exam);
  const includeExperience = Boolean(req.body?.include_experience);
  const quizWeight = includeQuizzes ? Number(req.body?.quiz_weight || 0) : 0;
  const examWeight = includeExam ? Number(req.body?.exam_weight || 0) : 0;
  const experienceWeight = includeExperience ? Number(req.body?.experience_weight || 0) : 0;
  const weights = [quizWeight, examWeight, experienceWeight];
  if (![includeQuizzes, includeExam, includeExperience].some(Boolean)) fail(400, 'Sélectionnez au moins un type d’évaluation.');
  if (weights.some(value => !Number.isFinite(value) || value < 0 || value > 100)) fail(400, 'Poids invalide.');
  if (Math.abs(weights.reduce((sum, value) => sum + value, 0) - 100) > 0.001) fail(400, 'La somme des poids doit être égale à 100 %.');
  const result = await pool.query(
    `INSERT INTO training_group_grading(group_id,include_quizzes,quiz_weight,include_exam,exam_weight,include_experience,experience_weight,updated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(group_id) DO UPDATE SET include_quizzes=EXCLUDED.include_quizzes,quiz_weight=EXCLUDED.quiz_weight,
       include_exam=EXCLUDED.include_exam,exam_weight=EXCLUDED.exam_weight,
       include_experience=EXCLUDED.include_experience,experience_weight=EXCLUDED.experience_weight,
       updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,
    [groupId, includeQuizzes, quizWeight, includeExam, examWeight, includeExperience, experienceWeight, req.user.id]
  );
  res.json(result.rows[0]);
}));

async function finalExamForStaff(examId, user) {
  const values = user.role === 'superadmin' ? [examId] : [examId, user.id];
  const ownership = user.role === 'superadmin' ? '' : ' AND tg.instructor_id=$2';
  const result = await pool.query(
    `SELECT fe.*,tg.theme_id,tg.name AS group_name,t.name AS theme_name
     FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id JOIN themes t ON t.id=tg.theme_id
     WHERE fe.id=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL${ownership}`,
    values
  );
  if (!result.rows[0]) fail(404, 'Examen final introuvable ou non autorisé.');
  return result.rows[0];
}

async function finalExamDetails(examId, user) {
  const exam = await finalExamForStaff(examId, user);
  const [questionsResult, optionsResult, attemptsResult] = await Promise.all([
    pool.query('SELECT id,exam_id,body,points,position FROM final_exam_questions WHERE exam_id=$1 ORDER BY position,id', [examId]),
    pool.query(
      `SELECT o.id,o.question_id,o.label,o.body,o.is_correct FROM final_exam_options o
       JOIN final_exam_questions q ON q.id=o.question_id WHERE q.exam_id=$1 ORDER BY q.position,o.label`,
      [examId]
    ),
    pool.query(
      `SELECT a.id,a.user_id,a.started_at,a.expires_at,a.submitted_at,a.score_points,a.score_percent,
        u.first_name,u.last_name,u.participant_code
       FROM final_exam_attempts a JOIN app_users u ON u.id=a.user_id WHERE a.exam_id=$1
       ORDER BY lower(u.last_name),lower(u.first_name)`,
      [examId]
    )
  ]);
  exam.questions = questionsResult.rows.map(question => ({
    ...question,
    options: optionsResult.rows.filter(option => option.question_id === question.id)
  }));
  exam.attempts = attemptsResult.rows;
  return exam;
}

app.get('/api/final-exams', requireStaff, asyncRoute(async (req, res) => {
  const ownership = req.user.role === 'superadmin' ? ' WHERE fe.archived_at IS NULL AND tg.archived_at IS NULL' : ' WHERE fe.archived_at IS NULL AND tg.archived_at IS NULL AND tg.instructor_id=$1';
  const values = req.user.role === 'superadmin' ? [] : [req.user.id];
  const result = await pool.query(
    `SELECT fe.*,tg.name AS group_name,t.name AS theme_name,
      (SELECT count(*)::integer FROM final_exam_questions q WHERE q.exam_id=fe.id) AS question_count,
      (SELECT COALESCE(sum(q.points),0)::numeric FROM final_exam_questions q WHERE q.exam_id=fe.id) AS total_points,
      (SELECT count(*)::integer FROM final_exam_attempts a WHERE a.exam_id=fe.id AND a.submitted_at IS NOT NULL) AS submission_count
     FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id JOIN themes t ON t.id=tg.theme_id
     ${ownership} ORDER BY fe.created_at DESC`,
    values
  );
  res.json(result.rows);
}));

app.post('/api/final-exams', requireStaff, asyncRoute(async (req, res) => {
  const groupId = assertUuid(req.body?.group_id, 'Groupe');
  await trainingGroupForStaff(groupId, req.user);
  const title = requiredText(req.body?.title, 'Titre de l’examen', 250);
  const duration = Number(req.body?.duration_minutes || 60);
  if (!Number.isInteger(duration) || duration < 5 || duration > 480) fail(400, 'Durée d’examen invalide.');
  const code = await generateExamCode();
  const result = await pool.query(
    `INSERT INTO final_exams(group_id,code,title,instructions,duration_minutes,status,created_by)
     VALUES($1,$2,$3,$4,$5,'draft',$6) RETURNING *`,
    [groupId, code, title, String(req.body?.instructions || '').trim() || null, duration, req.user.id]
  );
  res.status(201).json(result.rows[0]);
}));

app.get('/api/final-exams/:id', requireStaff, asyncRoute(async (req, res) => {
  res.json(await finalExamDetails(assertUuid(req.params.id, 'Examen'), req.user));
}));

app.patch('/api/final-exams/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Examen');
  const exam = await finalExamForStaff(id, req.user);
  const fields = [];
  const values = [];
  if ('status' in (req.body || {})) {
    if (!['draft', 'open', 'closed'].includes(req.body.status)) fail(400, 'État d’examen invalide.');
    if (req.body.status === 'open') {
      const count = await pool.query('SELECT count(*)::integer AS count FROM final_exam_questions WHERE exam_id=$1', [id]);
      if (!count.rows[0].count) fail(409, 'Ajoutez au moins une question avant d’ouvrir l’examen.');
    }
    fields.push(`status=$${fields.length + 1}`); values.push(req.body.status);
  }
  if ('title' in (req.body || {})) { fields.push(`title=$${fields.length + 1}`); values.push(requiredText(req.body.title, 'Titre', 250)); }
  if ('instructions' in (req.body || {})) { fields.push(`instructions=$${fields.length + 1}`); values.push(String(req.body.instructions || '').trim() || null); }
  if ('duration_minutes' in (req.body || {})) {
    const duration = Number(req.body.duration_minutes);
    if (!Number.isInteger(duration) || duration < 5 || duration > 480) fail(400, 'Durée invalide.');
    if (exam.status !== 'draft') fail(409, 'La durée ne peut plus être modifiée après ouverture.');
    fields.push(`duration_minutes=$${fields.length + 1}`); values.push(duration);
  }
  if (!fields.length) fail(400, 'Aucune modification valide.');
  values.push(id);
  await pool.query(`UPDATE final_exams SET ${fields.join(',')} WHERE id=$${values.length}`, values);
  if (req.body?.status === 'closed') {
    await withTransaction(async client => {
      const attempts = await client.query('SELECT id FROM final_exam_attempts WHERE exam_id=$1 AND submitted_at IS NULL ORDER BY started_at FOR UPDATE', [id]);
      for (const attempt of attempts.rows) await finalizeExamAttempt(client, attempt.id);
    });
  }
  res.status(204).end();
}));

app.post('/api/final-exams/:id/questions', requireStaff, asyncRoute(async (req, res) => {
  const examId = assertUuid(req.params.id, 'Examen');
  const exam = await finalExamForStaff(examId, req.user);
  if (exam.status !== 'draft') fail(409, 'Les questions ne sont modifiables que lorsque l’examen est en préparation.');
  const body = requiredText(req.body?.body, 'Question', 2000);
  const answers = Array.isArray(req.body?.answers) ? req.body.answers.map((answer, index) => requiredText(answer, `Proposition ${index + 1}`, 500)) : [];
  const correct = Array.isArray(req.body?.correct) ? [...new Set(req.body.correct.map(Number))] : [];
  const points = Number(req.body?.points);
  if (answers.length !== 4) fail(400, 'Quatre propositions sont requises.');
  if (!correct.length || correct.some(index => !Number.isInteger(index) || index < 0 || index > 3)) fail(400, 'Bonne réponse invalide.');
  if (!Number.isFinite(points) || points <= 0 || points > 1000) fail(400, 'Nombre de points invalide.');
  const question = await withTransaction(async client => {
    const created = await client.query(
      `INSERT INTO final_exam_questions(exam_id,body,points,position)
       VALUES($1,$2,$3,(SELECT COALESCE(max(position),0)+1 FROM final_exam_questions WHERE exam_id=$1)) RETURNING *`,
      [examId, body, points]
    );
    for (let index = 0; index < 4; index += 1) {
      await client.query(
        'INSERT INTO final_exam_options(question_id,label,body,is_correct) VALUES($1,$2,$3,$4)',
        [created.rows[0].id, 'ABCD'[index], answers[index], correct.includes(index)]
      );
    }
    return created.rows[0];
  });
  res.status(201).json(question);
}));

app.delete('/api/final-exam-questions/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Question');
  const result = await pool.query(
    `DELETE FROM final_exam_questions q USING final_exams fe,training_groups tg
     WHERE q.exam_id=fe.id AND fe.group_id=tg.id AND q.id=$1 AND fe.status='draft'
       AND ($2::boolean OR tg.instructor_id=$3) RETURNING q.id`,
    [id, req.user.role === 'superadmin', req.user.id]
  );
  if (!result.rows[0]) fail(404, 'Question introuvable, non autorisée ou examen déjà ouvert.');
  res.status(204).end();
}));

app.get('/api/final-exams/:id/qr', requireStaff, asyncRoute(async (req, res) => {
  const exam = await finalExamForStaff(assertUuid(req.params.id, 'Examen'), req.user);
  const url = `${verificationBaseUrl(req)}/exam.html?exam=${encodeURIComponent(exam.code)}`;
  const png = await QRCode.toBuffer(url, { width: 240, margin: 1, errorCorrectionLevel: 'M' });
  res.set('Cache-Control', 'no-store').type('png').send(png);
}));

async function finalExamByCode(client, code) {
  const result = await client.query(
    `SELECT fe.*,tg.theme_id,tg.name AS group_name,t.name AS theme_name
     FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id JOIN themes t ON t.id=tg.theme_id
     WHERE fe.code=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [code]
  );
  if (!result.rows[0]) fail(404, 'Examen final introuvable.');
  return result.rows[0];
}

async function finalizeExamAttempt(client, attemptId) {
  const attemptResult = await client.query(
    `SELECT a.*,fe.id AS exam_id FROM final_exam_attempts a JOIN final_exams fe ON fe.id=a.exam_id
     WHERE a.id=$1 FOR UPDATE OF a`,
    [attemptId]
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) fail(404, 'Tentative d’examen introuvable.');
  if (attempt.submitted_at) return attempt;
  const questions = await client.query('SELECT id,points FROM final_exam_questions WHERE exam_id=$1 ORDER BY position', [attempt.exam_id]);
  let earned = 0;
  let maximum = 0;
  for (const question of questions.rows) {
    maximum += Number(question.points);
    const [correctResult, selectedResult] = await Promise.all([
      client.query('SELECT id FROM final_exam_options WHERE question_id=$1 AND is_correct ORDER BY id', [question.id]),
      client.query('SELECT option_id AS id FROM final_exam_answers WHERE attempt_id=$1 AND question_id=$2 ORDER BY option_id', [attemptId, question.id])
    ]);
    const correct = correctResult.rows.map(row => row.id);
    const selected = selectedResult.rows.map(row => row.id);
    if (correct.length === selected.length && correct.every((id, index) => id === selected[index])) earned += Number(question.points);
  }
  const percent = maximum ? Math.round(earned * 10000 / maximum) / 100 : 0;
  const updated = await client.query(
    `UPDATE final_exam_attempts SET submitted_at=now(),score_points=$1,score_percent=$2 WHERE id=$3 RETURNING *`,
    [earned, percent, attemptId]
  );
  return updated.rows[0];
}

app.post('/api/final-exams/:code/join', joinLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.params.code, 'Code d’examen', 8).toUpperCase();
  const current = await findSession(req, 'learner');
  const joined = await withTransaction(async client => {
    const exam = await finalExamByCode(client, code);
    if (exam.status !== 'open') fail(409, 'Cet examen n’est pas ouvert.');
    let learner = current;
    if (!learner && req.body?.participant_code) {
      const participantCode = normalizeParticipantCode(req.body.participant_code);
      const result = await client.query(
        "SELECT id,first_name,last_name,participant_code,role FROM app_users WHERE role='learner' AND archived_at IS NULL AND participant_code=$1 FOR UPDATE",
        [participantCode]
      );
      learner = result.rows[0];
      if (!learner) fail(404, 'Code personnel introuvable.');
    }
    if (!learner) {
      const firstName = requiredText(req.body?.first_name, 'Prénom', 100);
      const lastName = requiredText(req.body?.last_name, 'Nom', 100);
      const participantCode = await generateParticipantCode(client);
      const created = await client.query(
        `INSERT INTO app_users(first_name,last_name,participant_code,role)
         VALUES($1,$2,$3,'learner') RETURNING id,first_name,last_name,participant_code,role`,
        [firstName, lastName, participantCode]
      );
      learner = created.rows[0];
    }
    await client.query(
      `INSERT INTO training_group_participants(group_id,user_id) VALUES($1,$2)
       ON CONFLICT(group_id,user_id) DO NOTHING`,
      [exam.group_id, learner.id]
    );
    const attempt = await client.query(
      `INSERT INTO final_exam_attempts(exam_id,user_id,expires_at)
       VALUES($1,$2,now()+($3 || ' minutes')::interval)
       ON CONFLICT(exam_id,user_id) DO UPDATE SET exam_id=EXCLUDED.exam_id RETURNING *`,
      [exam.id, learner.id, String(exam.duration_minutes)]
    );
    return { exam, learner, attempt: attempt.rows[0] };
  });
  if (!current) await replaceLearnerCookie(req, res, joined.learner.id);
  res.json({ learner: { id: joined.learner.id, first_name: joined.learner.first_name, last_name: joined.learner.last_name, participant_code: joined.learner.participant_code }, attempt: joined.attempt });
}));

app.get('/api/final-exams/:code/state', requireLearner, asyncRoute(async (req, res) => {
  const code = requiredText(req.params.code, 'Code d’examen', 8).toUpperCase();
  let payload = await withTransaction(async client => {
    const exam = await finalExamByCode(client, code);
    let attemptResult = await client.query('SELECT * FROM final_exam_attempts WHERE exam_id=$1 AND user_id=$2 FOR UPDATE', [exam.id, req.user.id]);
    let attempt = attemptResult.rows[0];
    if (!attempt) fail(404, 'Vous n’avez pas encore rejoint cet examen.');
    if (!attempt.submitted_at && (exam.status === 'closed' || new Date(attempt.expires_at) <= new Date())) {
      attempt = await finalizeExamAttempt(client, attempt.id);
    }
    const questions = await client.query(
      `SELECT q.id,q.body,q.points,q.position,
        (SELECT count(*)>1 FROM final_exam_options o WHERE o.question_id=q.id AND o.is_correct) AS multiple_answers
       FROM final_exam_questions q WHERE q.exam_id=$1 ORDER BY q.position,q.id`,
      [exam.id]
    );
    const options = await client.query(
      `SELECT o.id,o.question_id,o.label,o.body FROM final_exam_options o
       JOIN final_exam_questions q ON q.id=o.question_id WHERE q.exam_id=$1 ORDER BY q.position,o.label`,
      [exam.id]
    );
    const selected = await client.query('SELECT question_id,option_id FROM final_exam_answers WHERE attempt_id=$1', [attempt.id]);
    return {
      exam: { id: exam.id, code: exam.code, title: exam.title, instructions: exam.instructions, duration_minutes: exam.duration_minutes, status: exam.status, theme_name: exam.theme_name, group_name: exam.group_name },
      attempt,
      learner: { first_name: req.user.first_name, last_name: req.user.last_name, participant_code: req.user.participant_code },
      questions: questions.rows.map(question => ({ ...question, options: options.rows.filter(option => option.question_id === question.id), selected_option_ids: selected.rows.filter(item => item.question_id === question.id).map(item => item.option_id) }))
    };
  });
  res.set('Cache-Control', 'no-store').json(payload);
}));

app.put('/api/final-exams/:code/answers', requireLearner, asyncRoute(async (req, res) => {
  const code = requiredText(req.params.code, 'Code d’examen', 8).toUpperCase();
  const questionId = assertUuid(req.body?.question_id, 'Question');
  const optionIds = Array.isArray(req.body?.option_ids) ? [...new Set(req.body.option_ids)] : [];
  if (optionIds.length > 4 || optionIds.some(id => !isUuid(id))) fail(400, 'Réponse invalide.');
  await withTransaction(async client => {
    const exam = await finalExamByCode(client, code);
    const attemptResult = await client.query(
      `SELECT * FROM final_exam_attempts WHERE exam_id=$1 AND user_id=$2 FOR UPDATE`,
      [exam.id, req.user.id]
    );
    const attempt = attemptResult.rows[0];
    if (!attempt || attempt.submitted_at || exam.status !== 'open' || new Date(attempt.expires_at) <= new Date()) fail(409, 'L’examen est terminé ou le délai est dépassé.');
    const question = await client.query('SELECT id FROM final_exam_questions WHERE id=$1 AND exam_id=$2', [questionId, exam.id]);
    if (!question.rows[0]) fail(400, 'Question invalide.');
    if (optionIds.length) {
      const valid = await client.query('SELECT id FROM final_exam_options WHERE question_id=$1 AND id=ANY($2::uuid[])', [questionId, optionIds]);
      if (valid.rows.length !== optionIds.length) fail(400, 'Proposition invalide.');
      const correctCount = await client.query('SELECT count(*)::integer AS count FROM final_exam_options WHERE question_id=$1 AND is_correct', [questionId]);
      if (correctCount.rows[0].count <= 1 && optionIds.length > 1) fail(400, 'Une seule réponse est autorisée.');
    }
    await client.query('DELETE FROM final_exam_answers WHERE attempt_id=$1 AND question_id=$2', [attempt.id, questionId]);
    for (const optionId of optionIds) {
      await client.query('INSERT INTO final_exam_answers(attempt_id,question_id,option_id) VALUES($1,$2,$3)', [attempt.id, questionId, optionId]);
    }
  });
  res.json({ saved: true });
}));

app.post('/api/final-exams/:code/submit', requireLearner, asyncRoute(async (req, res) => {
  const code = requiredText(req.params.code, 'Code d’examen', 8).toUpperCase();
  const result = await withTransaction(async client => {
    const exam = await finalExamByCode(client, code);
    const attempt = await client.query('SELECT id FROM final_exam_attempts WHERE exam_id=$1 AND user_id=$2', [exam.id, req.user.id]);
    if (!attempt.rows[0]) fail(404, 'Tentative introuvable.');
    return finalizeExamAttempt(client, attempt.rows[0].id);
  });
  res.json(result);
}));

app.get('/api/practical-experiences', requireStaff, asyncRoute(async (req, res) => {
  const groupId = assertUuid(req.query?.group_id, 'Groupe');
  await trainingGroupForStaff(groupId, req.user);
  const result = await pool.query(
    `SELECT pe.*,u.first_name,u.last_name,u.participant_code
     FROM practical_experiences pe JOIN app_users u ON u.id=pe.user_id
     WHERE pe.group_id=$1 AND pe.archived_at IS NULL ORDER BY pe.evaluated_at DESC`,
    [groupId]
  );
  res.json(result.rows);
}));

app.post('/api/practical-experiences', requireStaff, asyncRoute(async (req, res) => {
  const groupId = assertUuid(req.body?.group_id, 'Groupe');
  const userId = assertUuid(req.body?.user_id, 'Participant');
  await trainingGroupForStaff(groupId, req.user);
  const member = await pool.query('SELECT 1 FROM training_group_participants WHERE group_id=$1 AND user_id=$2', [groupId, userId]);
  if (!member.rows[0]) fail(404, 'Cet apprenant n’appartient pas au groupe sélectionné.');
  const name = requiredText(req.body?.name, 'Nom de l’expérience', 250);
  const score = Number(req.body?.score);
  const maxScore = Number(req.body?.max_score || 20);
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0 || score < 0 || score > maxScore) fail(400, 'Note ou barème invalide.');
  const result = await pool.query(
    `INSERT INTO practical_experiences(group_id,user_id,name,comment,score,max_score,evaluated_by)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [groupId, userId, name, String(req.body?.comment || '').trim() || null, score, maxScore, req.user.id]
  );
  res.status(201).json(result.rows[0]);
}));

app.patch('/api/practical-experiences/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Évaluation');
  const name = requiredText(req.body?.name, 'Nom de l’expérience', 250);
  const score = Number(req.body?.score);
  const maxScore = Number(req.body?.max_score || 20);
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0 || score < 0 || score > maxScore) fail(400, 'Note ou barème invalide.');
  const result = await pool.query(
    `UPDATE practical_experiences pe SET name=$1,comment=$2,score=$3,max_score=$4,evaluated_at=now(),evaluated_by=$5
     FROM training_groups tg WHERE pe.group_id=tg.id AND pe.id=$6 AND pe.archived_at IS NULL
       AND ($7::boolean OR tg.instructor_id=$5) RETURNING pe.*`,
    [name, String(req.body?.comment || '').trim() || null, score, maxScore, req.user.id, id, req.user.role === 'superadmin']
  );
  if (!result.rows[0]) fail(404, 'Évaluation introuvable ou non autorisée.');
  res.json(result.rows[0]);
}));

app.delete('/api/practical-experiences/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Évaluation');
  const result = await pool.query(
    `DELETE FROM practical_experiences pe USING training_groups tg
     WHERE pe.group_id=tg.id AND pe.id=$1 AND ($2::boolean OR tg.instructor_id=$3) RETURNING pe.id`,
    [id, req.user.role === 'superadmin', req.user.id]
  );
  if (!result.rows[0]) fail(404, 'Évaluation introuvable ou non autorisée.');
  res.status(204).end();
}));

app.post('/api/training-groups/:id/certificates/:userId', requireStaff, asyncRoute(async (req, res) => {
  const groupId = assertUuid(req.params.id, 'Groupe');
  const userId = assertUuid(req.params.userId, 'Participant');
  const results = await trainingGroupResults(groupId, req.user);
  if (results.group.status !== 'finished') fail(409, 'Terminez le groupe avant de délivrer les certificats.');
  const learner = results.participants.find(item => item.id === userId);
  if (!learner) fail(404, 'Participant introuvable dans ce groupe.');
  if (!learner.eligible) fail(409, 'Le score global est inférieur au seuil de réussite.');
  const number = `TS-CERT-${new Date().getUTCFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  const token = crypto.randomBytes(24).toString('base64url');
  const gradingSnapshot = JSON.stringify({
    policy: results.policy,
    quiz_score: learner.quiz_score,
    exam_score: learner.exam_score,
    experience_score: learner.experience_score,
    global_score: learner.global_score
  });
  const result = await pool.query(
    `INSERT INTO certificates(training_group_id,user_id,certificate_number,public_token,global_score,status,issued_by,grading_snapshot)
     VALUES($1,$2,$3,$4,$5,'issued',$6,$7::jsonb)
     ON CONFLICT(training_group_id,user_id) DO UPDATE SET
       certificate_number=EXCLUDED.certificate_number,public_token=EXCLUDED.public_token,
       global_score=EXCLUDED.global_score,status='issued',issued_by=EXCLUDED.issued_by,
       grading_snapshot=EXCLUDED.grading_snapshot,issued_at=now(),revoked_at=NULL,archived_at=NULL,archived_by=NULL RETURNING *`,
    [groupId, userId, number, token, learner.global_score, req.user.id, gradingSnapshot]
  );
  res.status(201).json(result.rows[0]);
}));

app.post('/api/certificates/:id/revoke', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Certificat');
  const values = req.user.role === 'superadmin' ? [id] : [id, req.user.id];
  const ownership = req.user.role === 'superadmin' ? '' : ' AND tg.instructor_id=$2';
  const result = await pool.query(
    `UPDATE certificates cert SET status='revoked',revoked_at=now()
     FROM training_groups tg WHERE cert.training_group_id=tg.id AND cert.id=$1${ownership} RETURNING cert.id`,
    values
  );
  if (!result.rows[0]) fail(404, 'Certificat introuvable ou non autorisé.');
  res.status(204).end();
}));

app.get('/api/certificates/:id.pdf', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Certificat');
  const lookup = await pool.query('SELECT training_group_id FROM certificates WHERE id=$1', [id]);
  if (!lookup.rows[0]) fail(404, 'Certificat introuvable.');
  const certificates = await certificatesForGroup(lookup.rows[0].training_group_id, req.user, req, id);
  if (!certificates.length) fail(404, 'Ce certificat a été révoqué ou n’existe plus.');
  res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${certificates[0].certificate_number}.pdf"` });
  res.send(createCertificatesPdf(certificates));
}));

app.get('/api/training-groups/:id/certificates.pdf', requireStaff, asyncRoute(async (req, res) => {
  const groupId = assertUuid(req.params.id, 'Groupe');
  const certificates = await certificatesForGroup(groupId, req.user, req);
  if (!certificates.length) fail(404, 'Aucun certificat valide à télécharger pour ce groupe.');
  res.set({ 'Cache-Control': 'no-store', 'Content-Type': 'application/pdf', 'Content-Disposition': 'attachment; filename="certificats-groupe.pdf"' });
  res.send(createCertificatesPdf(certificates));
}));

app.get('/api/certificates/verify/:token', presentationLimiter, asyncRoute(async (req, res) => {
  const token = requiredText(req.params.token, 'Jeton de vérification', 100);
  const result = await pool.query(
    `SELECT cert.certificate_number,cert.global_score,cert.status,cert.issued_at,cert.revoked_at,
      u.first_name,u.last_name,t.name AS theme_name,tg.name AS group_name,tg.start_date,tg.end_date,
      concat_ws(' ',issuer.first_name,issuer.last_name) AS issuer_name
     FROM certificates cert JOIN app_users u ON u.id=cert.user_id
     JOIN training_groups tg ON tg.id=cert.training_group_id JOIN themes t ON t.id=tg.theme_id
     JOIN app_users issuer ON issuer.id=cert.issued_by WHERE cert.public_token=$1 AND cert.archived_at IS NULL`,
    [token]
  );
  if (!result.rows[0]) fail(404, 'Certificat introuvable.');
  res.set('Cache-Control', 'no-store').json(result.rows[0]);
}));

app.get('/api/participants', requireStaff, asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await participantsForStaff(req.user));
}));

app.get('/api/participants/export.csv', requireStaff, asyncRoute(async (req, res) => {
  const participants = await participantsForStaff(req.user);
  const rows = [
    ['Nom', 'Prénom', 'Code personnel', 'Date de création', 'Dernière activité', 'Quiz participés'],
    ...participants.map(participant => [
      participant.last_name,
      participant.first_name,
      participant.participant_code,
      participant.created_at,
      participant.last_activity,
      [...new Set(participant.participations.map(item => item.quiz_title))].join(' | ')
    ])
  ];
  const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
  res.set({
    'Cache-Control': 'no-store',
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="participants-quiz.csv"'
  });
  res.send(csv);
}));

app.post('/api/participants/:id/regenerate-code', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Participant');
  const ownershipClause = req.user.role === 'superadmin' ? '' : ' AND ls.instructor_id=$2';
  const ownershipValues = req.user.role === 'superadmin' ? [id] : [id, req.user.id];
  const allowed = await pool.query(
    `SELECT u.id FROM app_users u WHERE u.id=$1 AND u.role='learner' AND EXISTS (
       SELECT 1 FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
       WHERE sp.user_id=u.id${ownershipClause}
     )`,
    ownershipValues
  );
  if (!allowed.rows[0]) fail(404, 'Participant introuvable ou non autorisé.');
  const code = await generateParticipantCode();
  await pool.query('UPDATE app_users SET participant_code=$1 WHERE id=$2', [code, id]);
  res.json({ participant_code: code });
}));

app.patch('/api/participants/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Participant');
  const firstName = requiredText(req.body?.first_name, 'Prénom', 100);
  const lastName = requiredText(req.body?.last_name, 'Nom', 100);
  const result = await pool.query(
    `UPDATE app_users u SET first_name=$1,last_name=$2
     WHERE u.id=$3 AND u.role='learner' AND u.archived_at IS NULL AND ($4::boolean OR EXISTS (
       SELECT 1 FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
       WHERE sp.user_id=u.id AND ls.instructor_id=$5
     )) RETURNING u.id,u.first_name,u.last_name`,
    [firstName, lastName, id, req.user.role === 'superadmin', req.user.id]
  );
  if (!result.rows[0]) fail(404, 'Participant introuvable ou non autorisé.');
  res.json(result.rows[0]);
}));

app.get('/api/catalog', requireStaff, asyncRoute(async (_req, res) => {
  const [themesResult, chaptersResult, quizzesResult, questionsResult, optionsResult] = await Promise.all([
    pool.query('SELECT id,name,description,position FROM themes WHERE is_active ORDER BY position,id'),
    pool.query('SELECT id,theme_id,title,description,position FROM chapters WHERE is_active ORDER BY position,id'),
    pool.query('SELECT id,chapter_id,title,default_duration_seconds FROM quizzes WHERE is_active ORDER BY title,id'),
    pool.query('SELECT id,quiz_id,body,duration_seconds,position,explanation,difficulty,subtopic FROM questions WHERE is_active AND archived_at IS NULL ORDER BY position,id'),
    pool.query('SELECT id,question_id,label,body,is_correct FROM answer_options ORDER BY label')
  ]);
  const optionsByQuestion = new Map();
  for (const option of optionsResult.rows) {
    if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
    optionsByQuestion.get(option.question_id).push(option);
  }
  const questionsByQuiz = new Map();
  for (const question of questionsResult.rows) {
    question.answer_options = optionsByQuestion.get(question.id) || [];
    if (!questionsByQuiz.has(question.quiz_id)) questionsByQuiz.set(question.quiz_id, []);
    questionsByQuiz.get(question.quiz_id).push(question);
  }
  const quizzesByChapter = new Map();
  for (const quiz of quizzesResult.rows) {
    quiz.questions = questionsByQuiz.get(quiz.id) || [];
    if (!quizzesByChapter.has(quiz.chapter_id)) quizzesByChapter.set(quiz.chapter_id, []);
    quizzesByChapter.get(quiz.chapter_id).push(quiz);
  }
  const chaptersByTheme = new Map();
  for (const chapter of chaptersResult.rows) {
    chapter.quizzes = quizzesByChapter.get(chapter.id) || [];
    if (!chaptersByTheme.has(chapter.theme_id)) chaptersByTheme.set(chapter.theme_id, []);
    chaptersByTheme.get(chapter.theme_id).push(chapter);
  }
  res.json(themesResult.rows.map(theme => ({ ...theme, chapters: chaptersByTheme.get(theme.id) || [] })));
}));

app.post('/api/themes', requireStaff, asyncRoute(async (req, res) => {
  const name = requiredText(req.body?.name, 'Nom du thème', 200);
  const existing = await pool.query('SELECT id,name FROM themes WHERE lower(name)=lower($1)', [name]);
  if (existing.rows[0]) return res.json(existing.rows[0]);
  const created = await pool.query(
    `INSERT INTO themes(name,position) VALUES($1,(SELECT COALESCE(max(position),0)+1 FROM themes)) RETURNING id,name`,
    [name]
  );
  res.status(201).json(created.rows[0]);
}));

app.post('/api/themes/:id/chapters', requireStaff, asyncRoute(async (req, res) => {
  const themeId = assertUuid(req.params.id, 'Thème');
  const title = requiredText(req.body?.title, 'Titre du chapitre', 250);
  const result = await withTransaction(async client => {
    const theme = await client.query('SELECT id FROM themes WHERE id=$1 FOR UPDATE', [themeId]);
    if (!theme.rows[0]) fail(404, 'Thème introuvable.');
    const chapter = await client.query(
      `INSERT INTO chapters(theme_id,title,position)
       VALUES($1,$2,(SELECT COALESCE(max(position),0)+1 FROM chapters WHERE theme_id=$1)) RETURNING *`,
      [themeId, title]
    );
    const quiz = await client.query(
      `INSERT INTO quizzes(chapter_id,title,default_duration_seconds) VALUES($1,$2,30) RETURNING *`,
      [chapter.rows[0].id, `Quiz · ${title}`]
    );
    return { chapter: chapter.rows[0], quiz: quiz.rows[0] };
  });
  res.status(201).json(result);
}));

app.post('/api/quizzes/:id/questions', requireStaff, asyncRoute(async (req, res) => {
  const quizId = assertUuid(req.params.id, 'Quiz');
  const body = requiredText(req.body?.body, 'Question', 2000);
  const answers = Array.isArray(req.body?.answers) ? req.body.answers.map((answer, index) => requiredText(answer, `Proposition ${index + 1}`, 500)) : [];
  const correct = Array.isArray(req.body?.correct) ? [...new Set(req.body.correct.map(Number))] : [];
  const seconds = Number(req.body?.seconds || 30);
  if (answers.length !== 4) fail(400, 'Quatre propositions sont requises.');
  if (!correct.length || correct.some(index => !Number.isInteger(index) || index < 0 || index > 3)) fail(400, 'Bonne réponse invalide.');
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600) fail(400, 'Durée invalide.');
  const questionId = await withTransaction(async client => {
    const quiz = await client.query('SELECT id FROM quizzes WHERE id=$1 FOR UPDATE', [quizId]);
    if (!quiz.rows[0]) fail(404, 'Quiz introuvable.');
    const question = await client.query(
      `INSERT INTO questions(quiz_id,body,duration_seconds,position,explanation,difficulty,subtopic)
       VALUES($1,$2,$3,(SELECT COALESCE(max(position),0)+1 FROM questions WHERE quiz_id=$1),$4,1,'Général') RETURNING id`,
      [quizId, body, seconds, req.body?.explanation || null]
    );
    for (let index = 0; index < answers.length; index += 1) {
      await client.query(
        'INSERT INTO answer_options(question_id,label,body,is_correct) VALUES($1,$2,$3,$4)',
        [question.rows[0].id, 'ABCD'[index], answers[index], correct.includes(index)]
      );
    }
    return question.rows[0].id;
  });
  res.status(201).json({ id: questionId });
}));

app.patch('/api/questions/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Question');
  const body = requiredText(req.body?.body, 'Question', 2000);
  const answers = Array.isArray(req.body?.answers)
    ? req.body.answers.map((answer, index) => requiredText(answer, `Proposition ${index + 1}`, 500))
    : null;
  const correct = Array.isArray(req.body?.correct) ? [...new Set(req.body.correct.map(Number))] : null;
  const seconds = req.body?.seconds === undefined ? null : Number(req.body.seconds);
  if (answers && answers.length !== 4) fail(400, 'Quatre propositions sont requises.');
  if (correct && (!correct.length || correct.some(index => !Number.isInteger(index) || index < 0 || index > 3))) {
    fail(400, 'Bonne réponse invalide.');
  }
  if (seconds !== null && (!Number.isInteger(seconds) || seconds < 5 || seconds > 3600)) fail(400, 'Durée invalide.');
  if ((answers && !correct) || (!answers && correct)) fail(400, 'Les propositions et les bonnes réponses doivent être enregistrées ensemble.');

  await withTransaction(async client => {
    const existing = await client.query('SELECT id,duration_seconds FROM questions WHERE id=$1 FOR UPDATE', [id]);
    if (!existing.rows[0]) fail(404, 'Question introuvable.');
    await client.query(
      'UPDATE questions SET body=$1,duration_seconds=$2,explanation=$3 WHERE id=$4',
      [body, seconds ?? existing.rows[0].duration_seconds, req.body?.explanation ?? null, id]
    );
    if (!answers) return;
    for (let index = 0; index < answers.length; index += 1) {
      const updated = await client.query(
        'UPDATE answer_options SET body=$1,is_correct=$2 WHERE question_id=$3 AND label=$4 RETURNING id',
        [answers[index], correct.includes(index), id, 'ABCD'[index]]
      );
      if (!updated.rows[0]) {
        await client.query(
          'INSERT INTO answer_options(question_id,label,body,is_correct) VALUES($1,$2,$3,$4)',
          [id, 'ABCD'[index], answers[index], correct.includes(index)]
        );
      }
    }
  });
  res.json({ id });
}));

app.delete('/api/questions/:id', requireStaff, asyncRoute(async (req, res) => {
  const result = await pool.query(
    'DELETE FROM questions WHERE id=$1 RETURNING id',
    [assertUuid(req.params.id, 'Question')]
  );
  if (!result.rows[0]) fail(404, 'Question introuvable.');
  res.status(204).end();
}));

app.patch('/api/options/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Proposition');
  const body = requiredText(req.body?.body, 'Proposition', 500);
  const result = await pool.query('UPDATE answer_options SET body=$1 WHERE id=$2 RETURNING id', [body, id]);
  if (!result.rows[0]) fail(404, 'Proposition introuvable.');
  res.status(204).end();
}));

app.delete('/api/themes/:id', requireStaff, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM themes WHERE id=$1 RETURNING id', [assertUuid(req.params.id, 'Thème')]);
  if (!result.rows[0]) fail(404, 'Thème introuvable.');
  res.status(204).end();
}));

app.delete('/api/chapters/:id', requireStaff, asyncRoute(async (req, res) => {
  const result = await pool.query('DELETE FROM chapters WHERE id=$1 RETURNING id', [assertUuid(req.params.id, 'Chapitre')]);
  if (!result.rows[0]) fail(404, 'Chapitre introuvable.');
  res.status(204).end();
}));

app.get('/api/live-sessions', requireStaff, asyncRoute(async (req, res) => {
  await closeExpiredQuestions();
  const scope = staffScope(req.user);
  const activeScope = `${scope.clause ? `${scope.clause} AND` : ' WHERE'} archived_at IS NULL
    AND (group_id IS NULL OR EXISTS (SELECT 1 FROM training_groups tg WHERE tg.id=live_sessions.group_id AND tg.archived_at IS NULL))`;
  const sessionsResult = await pool.query(
    `SELECT id,code,quiz_id,group_id,show_podium,podium_visible,status,current_question_id,question_started_at,question_ends_at,capacity,created_at,ended_at
     FROM live_sessions${activeScope} ORDER BY created_at DESC`,
    scope.values
  );
  const sessions = sessionsResult.rows;
  if (!sessions.length) return res.json([]);
  const ids = sessions.map(session => session.id);
  const [participantsResult, answersResult, submissionsResult] = await Promise.all([
    pool.query(
      `SELECT sp.id,sp.session_id,sp.status,sp.user_id,sp.show_on_podium,sp.podium_alias,u.first_name,u.last_name
       FROM session_participants sp JOIN app_users u ON u.id=sp.user_id WHERE sp.session_id=ANY($1::uuid[])`,
      [ids]
    ),
    pool.query('SELECT id,session_id,question_id,participant_id,option_id FROM live_answers WHERE session_id=ANY($1::uuid[])', [ids]),
    pool.query('SELECT id,session_id,question_id,participant_id,is_correct FROM live_answer_submissions WHERE session_id=ANY($1::uuid[])', [ids])
  ]);
  res.json(sessions.map(session => ({
    ...session,
    session_participants: participantsResult.rows.filter(p => p.session_id === session.id).map(p => ({
      id: p.id, session_id: p.session_id, status: p.status, user_id: p.user_id,
      show_on_podium: p.show_on_podium, podium_alias: p.podium_alias,
      app_users: { id: p.user_id, first_name: p.first_name, last_name: p.last_name }
    })),
    live_answers: answersResult.rows.filter(answer => answer.session_id === session.id),
    live_answer_submissions: submissionsResult.rows.filter(answer => answer.session_id === session.id)
  })));
}));

app.post('/api/live-sessions', requireStaff, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) fail(400, 'Code de session invalide.');
  const quizId = assertUuid(req.body?.quiz_id, 'Quiz');
  const groupId = assertUuid(req.body?.group_id, 'Groupe de formation');
  const group = await trainingGroupForStaff(groupId, req.user);
  if (group.status === 'finished') fail(409, 'Ce groupe est terminé.');
  const quiz = await pool.query(
    `SELECT q.id,c.theme_id FROM quizzes q JOIN chapters c ON c.id=q.chapter_id
     WHERE q.id=$1 AND q.is_active AND c.is_active`,
    [quizId]
  );
  if (!quiz.rows[0]) fail(404, 'Quiz introuvable.');
  if (quiz.rows[0].theme_id !== group.theme_id) fail(400, 'Ce quiz n’appartient pas au thème du groupe.');
  const created = await pool.query(
    `INSERT INTO live_sessions(code,quiz_id,group_id,instructor_id,show_podium,status)
     VALUES($1,$2,$3,$4,$5,'waiting') RETURNING *`,
    [code, quizId, groupId, req.user.id, Boolean(req.body?.show_podium)]
  );
  res.status(201).json(created.rows[0]);
}));

app.patch('/api/live-sessions/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Session');
  const ownership = await pool.query('SELECT id,quiz_id,instructor_id,show_podium FROM live_sessions WHERE id=$1', [id]);
  const session = ownership.rows[0];
  if (!session) fail(404, 'Session introuvable.');
  if (req.user.role !== 'superadmin' && session.instructor_id !== req.user.id) fail(403, 'Session non autorisée.');
  const allowed = ['status', 'current_question_id', 'question_started_at', 'question_ends_at', 'ended_at', 'podium_visible'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in (req.body || {}))) continue;
    let value = req.body[key];
    if (key === 'status' && !['waiting', 'live', 'polling', 'finished'].includes(value)) fail(400, 'État de session invalide.');
    if (key === 'podium_visible') {
      value = Boolean(value);
      if (value && !session.show_podium) fail(409, 'Le podium n’est pas activé pour cette session.');
    }
    if (key === 'current_question_id' && value !== null) {
      assertUuid(value, 'Question');
      const question = await pool.query('SELECT id FROM questions WHERE id=$1 AND quiz_id=$2', [value, session.quiz_id]);
      if (!question.rows[0]) fail(400, 'Cette question n’appartient pas au quiz.');
    }
    values.push(value);
    fields.push(`${key}=$${values.length}`);
  }
  if (!fields.length) fail(400, 'Aucune modification valide.');
  values.push(id);
  await pool.query(`UPDATE live_sessions SET ${fields.join(',')} WHERE id=$${values.length}`, values);
  res.status(204).end();
}));

app.delete('/api/live-sessions/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Session');
  const scope = req.user.role === 'superadmin' ? '' : ' AND instructor_id=$2';
  const values = req.user.role === 'superadmin' ? [id] : [id, req.user.id];
  const result = await pool.query(`DELETE FROM live_sessions WHERE id=$1${scope} RETURNING id`, values);
  if (!result.rows[0]) fail(404, 'Session introuvable ou non autorisée.');
  res.status(204).end();
}));

app.post('/api/live-participants/:id/approve', requireStaff, asyncRoute(async (req, res) => {
  const participantId = assertUuid(req.params.id, 'Participant');
  await withTransaction(async client => {
    const result = await client.query(
      `SELECT sp.id,sp.status,ls.id AS session_id,ls.capacity,ls.instructor_id
       FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
       WHERE sp.id=$1 FOR UPDATE OF sp,ls`,
      [participantId]
    );
    const participant = result.rows[0];
    if (!participant) fail(404, 'Participant introuvable.');
    if (req.user.role !== 'superadmin' && participant.instructor_id !== req.user.id) fail(403, 'Session non autorisée.');
    if (participant.status === 'joined') return;
    const joined = await client.query("SELECT count(*)::integer AS count FROM session_participants WHERE session_id=$1 AND status='joined'", [participant.session_id]);
    if (joined.rows[0].count >= participant.capacity) fail(409, 'La capacité de la session est atteinte.');
    await client.query("UPDATE session_participants SET status='joined' WHERE id=$1", [participantId]);
  });
  res.status(204).end();
}));

// Public, collective-only state used by the PowerPoint content add-in.
// It intentionally excludes participant identities and individual answers.
app.get('/api/presentation/state', presentationLimiter, asyncRoute(async (req, res) => {
  await closeExpiredQuestions();
  const code = requiredText(req.query?.code, 'Code', 8).toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) fail(400, 'Code de session invalide.');

  const base = await pool.query(
    `SELECT ls.id,ls.code,ls.status,ls.current_question_id,ls.question_started_at,ls.question_ends_at,
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
  if (!session) fail(404, 'Session introuvable.');

  const reviewing = session.status === 'waiting' && Boolean(session.current_question_id && session.question_started_at);
  const counts = await pool.query(
    `SELECT
      count(*) FILTER (WHERE status='joined')::integer AS joined_count,
      count(*) FILTER (WHERE status='waiting_list')::integer AS waiting_count
     FROM session_participants WHERE session_id=$1`,
    [session.id]
  );

  let question = null;
  let pollResults = [];
  let podium = [];
  let answeredCount = 0;
  if (session.current_question_id) {
    const questionResult = await pool.query(
      `SELECT q.id,q.body,q.duration_seconds,q.position,
        (SELECT count(*)>1 FROM answer_options c WHERE c.question_id=q.id AND c.is_correct) AS multiple_answers
       FROM questions q WHERE q.id=$1`,
      [session.current_question_id]
    );
    question = questionResult.rows[0] || null;
    if (question) {
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

  if (session.show_podium && session.podium_visible) {
    const ranking = await pool.query(
      `SELECT sp.podium_alias,(count(las.id) FILTER (WHERE las.is_correct))::integer AS correct_answers
       FROM session_participants sp
       LEFT JOIN live_answer_submissions las ON las.participant_id=sp.id AND las.session_id=sp.session_id
       WHERE sp.session_id=$1 AND sp.status='joined' AND sp.show_on_podium
       GROUP BY sp.id,sp.podium_alias
       ORDER BY correct_answers DESC,sp.joined_at ASC LIMIT 3`,
      [session.id]
    );
    podium = ranking.rows.map((item, index) => ({ rank: index + 1, alias: item.podium_alias, correct_answers: item.correct_answers }));
  }

  const participantCounts = counts.rows[0];
  res.set('Cache-Control', 'no-store');
  res.json({
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
    answered_count: answeredCount
  });
}));

async function attachLearnerToLiveSession(client, code, userId, showOnPodium) {
  const sessionResult = await client.query(
    `SELECT ls.id,ls.status,ls.group_id FROM live_sessions ls LEFT JOIN training_groups tg ON tg.id=ls.group_id
     WHERE ls.code=$1 AND ls.archived_at IS NULL AND (tg.id IS NULL OR tg.archived_at IS NULL) FOR UPDATE OF ls`,
    [code]
  );
  const session = sessionResult.rows[0];
  if (!session) fail(404, 'Session introuvable.');
  const existing = await client.query(
    'SELECT id,status FROM session_participants WHERE session_id=$1 AND user_id=$2',
    [session.id, userId]
  );
  if (session.status === 'finished') {
    if (!existing.rows[0]) fail(404, 'Cette session est terminée.');
    return existing.rows[0];
  }
  if (session.group_id) {
    await client.query(
      `INSERT INTO training_group_participants(group_id,user_id) VALUES($1,$2)
       ON CONFLICT(group_id,user_id) DO NOTHING`,
      [session.group_id, userId]
    );
  }
  if (existing.rows[0]) {
    if (typeof showOnPodium === 'boolean') {
      const updated = await client.query(
        'UPDATE session_participants SET show_on_podium=$1 WHERE id=$2 RETURNING id,status,show_on_podium,podium_alias',
        [showOnPodium, existing.rows[0].id]
      );
      return updated.rows[0];
    }
    return existing.rows[0];
  }
  const participant = await client.query(
    `INSERT INTO session_participants(session_id,user_id,status,show_on_podium,podium_alias)
     VALUES($1,$2,'waiting_list',$3,$4) RETURNING id,status,show_on_podium,podium_alias`,
    [session.id, userId, showOnPodium !== false, await generatePodiumAlias(client, session.id)]
  );
  return participant.rows[0];
}

async function replaceLearnerCookie(req, res, userId) {
  const oldRaw = req.cookies?.quiz_learner;
  if (oldRaw) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash(oldRaw)]);
  await issueSession(res, userId, 'learner');
}

app.post('/api/learner/join', joinLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  const firstName = requiredText(req.body?.first_name, 'Prénom', 100);
  const lastName = requiredText(req.body?.last_name, 'Nom', 100);
  const joined = await withTransaction(async client => {
    const participantCode = await generateParticipantCode(client);
    const created = await client.query(
      `INSERT INTO app_users(first_name,last_name,participant_code,role)
       VALUES($1,$2,$3,'learner') RETURNING id,first_name,last_name,participant_code`,
      [firstName, lastName, participantCode]
    );
    const learner = created.rows[0];
    const participant = await attachLearnerToLiveSession(client, code, learner.id, req.body?.show_on_podium !== false);
    return { learner, participant };
  });
  await replaceLearnerCookie(req, res, joined.learner.id);
  res.status(201).json(joined);
}));

app.post('/api/learner/join-by-code', joinLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code de session', 8).toUpperCase();
  const participantCode = normalizeParticipantCode(req.body?.participant_code);
  const joined = await withTransaction(async client => {
    const result = await client.query(
      "SELECT id,first_name,last_name,participant_code FROM app_users WHERE role='learner' AND archived_at IS NULL AND participant_code=$1 FOR UPDATE",
      [participantCode]
    );
    const learner = result.rows[0];
    if (!learner) fail(404, 'Code personnel introuvable. Vérifiez le code ou demandez de l’aide à l’instructeur.');
    const participant = await attachLearnerToLiveSession(client, code, learner.id, req.body?.show_on_podium !== false);
    return { learner, participant };
  });
  await replaceLearnerCookie(req, res, joined.learner.id);
  res.json(joined);
}));

app.post('/api/learner/resume', joinLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code de session', 8).toUpperCase();
  const learner = await findSession(req, 'learner');
  if (!learner || learner.role !== 'learner') fail(401, 'Aucun participant reconnu sur ce navigateur.');
  const podiumChoice = typeof req.body?.show_on_podium === 'boolean' ? req.body.show_on_podium : undefined;
  const participant = await withTransaction(client => attachLearnerToLiveSession(client, code, learner.id, podiumChoice));
  const raw = req.cookies?.quiz_learner;
  await pool.query("UPDATE auth_sessions SET expires_at=now()+interval '5 days' WHERE id=$1", [learner.auth_session_id]);
  res.cookie('quiz_learner', raw, cookieOptions(5 * 24 * 60 * 60 * 1000));
  res.json({
    learner: {
      id: learner.id,
      first_name: learner.first_name,
      last_name: learner.last_name,
      participant_code: learner.participant_code
    },
    participant
  });
}));

app.post('/api/learner/logout', asyncRoute(async (req, res) => {
  const raw = req.cookies?.quiz_learner;
  if (raw) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash(raw)]);
  res.clearCookie('quiz_learner', { path: '/', sameSite: 'strict', secure: cookieSecure });
  res.status(204).end();
}));

app.get('/api/learner/state', requireLearner, asyncRoute(async (req, res) => {
  await closeExpiredQuestions();
  const code = requiredText(req.query?.code, 'Code', 8).toUpperCase();
  const base = await pool.query(
    `SELECT ls.*,sp.id AS participant_id,sp.status AS participant_status,sp.show_on_podium,sp.podium_alias
     FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
     WHERE ls.code=$1 AND ls.archived_at IS NULL AND sp.user_id=$2`,
    [code, req.user.id]
  );
  const session = base.rows[0];
  if (!session) fail(404, 'Participation introuvable.');
  const waitingParticipantsResult = await pool.query(
    `SELECT sp.id,sp.status,u.first_name,u.last_name,(sp.user_id=$2) AS is_current
     FROM session_participants sp JOIN app_users u ON u.id=sp.user_id
     WHERE sp.session_id=$1 AND sp.status='waiting_list'
     ORDER BY sp.joined_at,sp.id`,
    [session.id, req.user.id]
  );
  let question = null;
  let pollResults = [];
  let answerResult = null;
  let selectedOptionIds = [];
  let answerSubmitted = false;
  const expired = Boolean(session.question_ends_at && new Date(session.question_ends_at) <= new Date());
  const reviewing = session.status === 'waiting' && Boolean(session.current_question_id && session.question_started_at);
  if (session.current_question_id) {
    const questionResult = await pool.query(
      `SELECT q.id,q.body,q.duration_seconds,q.position,
        (SELECT count(*)>1 FROM answer_options c WHERE c.question_id=q.id AND c.is_correct) AS multiple_answers
       FROM questions q WHERE q.id=$1`,
      [session.current_question_id]
    );
    question = questionResult.rows[0] || null;
    if (question) {
      const revealAnswers = reviewing;
      const options = await pool.query('SELECT id,label,body,is_correct FROM answer_options WHERE question_id=$1 ORDER BY label', [question.id]);
      question.options = options.rows.map(option => revealAnswers
        ? option
        : { id: option.id, label: option.label, body: option.body });
      const [answer, selected, draft] = await Promise.all([
        pool.query(
          'SELECT is_correct FROM live_answer_submissions WHERE session_id=$1 AND question_id=$2 AND participant_id=$3',
          [session.id, question.id, session.participant_id]
        ),
        pool.query(
          'SELECT option_id FROM live_answers WHERE session_id=$1 AND question_id=$2 AND participant_id=$3 ORDER BY option_id',
          [session.id, question.id, session.participant_id]
        ),
        pool.query(
          'SELECT option_id FROM live_answer_drafts WHERE session_id=$1 AND question_id=$2 AND participant_id=$3 ORDER BY option_id',
          [session.id, question.id, session.participant_id]
        )
      ]);
      answerSubmitted = Boolean(answer.rows[0]);
      if (revealAnswers) answerResult = answer.rows[0]?.is_correct ?? null;
      selectedOptionIds = answerSubmitted
        ? selected.rows.map(row => row.option_id)
        : draft.rows.map(row => row.option_id);
      if (session.status === 'polling') {
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
  let finalScore = null;
  if (session.status === 'finished') {
    const score = await pool.query(
      `SELECT count(*) FILTER (WHERE las.is_correct)::integer AS correct_answers,
        (SELECT count(*)::integer FROM questions WHERE quiz_id=$1) AS question_count
       FROM live_answer_submissions las WHERE las.session_id=$2 AND las.participant_id=$3`,
      [session.quiz_id, session.id, session.participant_id]
    );
    const row = score.rows[0];
    finalScore = {
      correct_answers: row.correct_answers,
      question_count: row.question_count,
      percent: row.question_count ? Math.round(100 * row.correct_answers / row.question_count) : 0
    };
  }
  res.json({
    session_id: session.id,
    status: session.status,
    participant_status: session.participant_status,
    show_podium: session.show_podium,
    show_on_podium: session.show_on_podium,
    podium_alias: session.podium_alias,
    question_started_at: session.question_started_at,
    question_ends_at: session.question_ends_at,
    question_expired: expired,
    question,
    waiting_participants: waitingParticipantsResult.rows,
    poll_results: pollResults,
    answer_result: answerResult,
    answer_submitted: answerSubmitted,
    selected_option_ids: selectedOptionIds,
    reviewing,
    final_score: finalScore,
    learner: {
      id: req.user.id,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
      participant_code: req.user.participant_code
    }
  });
}));

app.put('/api/learner/answers/draft', requireLearner, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  const optionIds = Array.isArray(req.body?.option_ids) ? [...new Set(req.body.option_ids)] : [];
  if (optionIds.length > 4 || optionIds.some(id => !isUuid(id))) fail(400, 'Proposition invalide.');
  await withTransaction(async client => {
    const result = await client.query(
      `SELECT ls.id AS session_id,ls.current_question_id,ls.status,ls.question_ends_at,
        sp.id AS participant_id,sp.status AS participant_status
       FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
       WHERE ls.code=$1 AND ls.archived_at IS NULL AND sp.user_id=$2 FOR UPDATE OF ls,sp`,
      [code, req.user.id]
    );
    const current = result.rows[0];
    if (!current || current.participant_status !== 'joined' || current.status !== 'live' || !current.current_question_id || !current.question_ends_at || new Date(current.question_ends_at) <= new Date()) {
      fail(403, 'Sélection non autorisée ou délai dépassé.');
    }
    const submitted = await client.query(
      'SELECT 1 FROM live_answer_submissions WHERE session_id=$1 AND question_id=$2 AND participant_id=$3',
      [current.session_id, current.current_question_id, current.participant_id]
    );
    if (submitted.rows[0]) fail(409, 'Cette réponse est déjà validée.');
    if (optionIds.length) {
      const valid = await client.query(
        'SELECT id FROM answer_options WHERE question_id=$1 AND id=ANY($2::uuid[])',
        [current.current_question_id, optionIds]
      );
      if (valid.rows.length !== optionIds.length) fail(400, 'Proposition invalide.');
      const mode = await client.query(
        'SELECT count(*)::integer AS correct_count FROM answer_options WHERE question_id=$1 AND is_correct',
        [current.current_question_id]
      );
      if (mode.rows[0].correct_count <= 1 && optionIds.length > 1) fail(400, 'Une seule réponse est autorisée.');
    }
    await client.query(
      'DELETE FROM live_answer_drafts WHERE session_id=$1 AND question_id=$2 AND participant_id=$3',
      [current.session_id, current.current_question_id, current.participant_id]
    );
    for (const optionId of optionIds) {
      await client.query(
        `INSERT INTO live_answer_drafts(session_id,question_id,participant_id,option_id,updated_at)
         VALUES($1,$2,$3,$4,now())`,
        [current.session_id, current.current_question_id, current.participant_id, optionId]
      );
    }
  });
  res.json({ saved: true });
}));

app.post('/api/learner/answers', requireLearner, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  const optionIds = Array.isArray(req.body?.option_ids) ? [...new Set(req.body.option_ids)] : [];
  if (!optionIds.length || optionIds.length > 4 || optionIds.some(id => !isUuid(id))) fail(400, 'Proposition invalide.');
  await withTransaction(async client => {
    const result = await client.query(
      `SELECT ls.id AS session_id,ls.current_question_id,ls.status,ls.question_ends_at,sp.id AS participant_id,sp.status AS participant_status
       FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
       WHERE ls.code=$1 AND ls.archived_at IS NULL AND sp.user_id=$2 FOR UPDATE OF ls,sp`,
      [code, req.user.id]
    );
    const current = result.rows[0];
    if (!current || current.participant_status !== 'joined' || current.status !== 'live' || !current.current_question_id || !current.question_ends_at || new Date(current.question_ends_at) <= new Date()) {
      fail(403, 'Réponse non autorisée ou délai dépassé.');
    }
    const valid = await client.query(
      'SELECT id,is_correct FROM answer_options WHERE question_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
      [current.current_question_id, optionIds]
    );
    if (valid.rows.length !== optionIds.length) fail(400, 'Proposition invalide.');
    const correct = await client.query('SELECT id FROM answer_options WHERE question_id=$1 AND is_correct ORDER BY id', [current.current_question_id]);
    if (correct.rows.length <= 1 && optionIds.length > 1) fail(400, 'Une seule réponse est autorisée.');
    const selectedIds = valid.rows.map(row => row.id).sort();
    const correctIds = correct.rows.map(row => row.id).sort();
    const isCorrect = selectedIds.length === correctIds.length && selectedIds.every((id, index) => id === correctIds[index]);
    const submission = await client.query(
      `INSERT INTO live_answer_submissions(session_id,question_id,participant_id,is_correct)
       VALUES($1,$2,$3,$4) ON CONFLICT(session_id,question_id,participant_id) DO NOTHING RETURNING id`,
      [current.session_id, current.current_question_id, current.participant_id, isCorrect]
    );
    if (!submission.rows[0]) return;
    for (const optionId of optionIds) {
      await client.query(
        'INSERT INTO live_answers(session_id,question_id,participant_id,option_id) VALUES($1,$2,$3,$4)',
        [current.session_id, current.current_question_id, current.participant_id, optionId]
      );
    }
    await client.query(
      'DELETE FROM live_answer_drafts WHERE session_id=$1 AND question_id=$2 AND participant_id=$3',
      [current.session_id, current.current_question_id, current.participant_id]
    );
    const completion = await client.query(
      `SELECT
        (SELECT count(*)::integer FROM session_participants WHERE session_id=$1 AND status='joined') AS joined_count,
        (SELECT count(*)::integer
         FROM live_answer_submissions las
         JOIN session_participants sp ON sp.id=las.participant_id
         WHERE las.session_id=$1 AND las.question_id=$2 AND sp.status='joined') AS answered_count`,
      [current.session_id, current.current_question_id]
    );
    const { joined_count: joinedCount, answered_count: answeredCount } = completion.rows[0];
    if (joinedCount > 0 && answeredCount >= joinedCount) {
      await client.query(
        "UPDATE live_sessions SET status='polling' WHERE id=$1 AND status='live'",
        [current.session_id]
      );
    }
  });
  res.json({ accepted: true });
}));

async function setArchiveState(type, id, user, archived) {
  const values = [id, archived, user.id, user.role === 'superadmin'];
  const assignments = `archived_at=CASE WHEN $2::boolean THEN now() ELSE NULL END,
    archived_by=CASE WHEN $2::boolean THEN $3::uuid ELSE NULL END`;
  let query;
  if (type === 'question') {
    query = `UPDATE questions SET ${assignments},is_active=NOT $2::boolean WHERE id=$1 RETURNING id`;
  } else if (type === 'session') {
    query = `UPDATE live_sessions SET ${assignments} WHERE id=$1 AND ($4::boolean OR instructor_id=$3) RETURNING id`;
  } else if (type === 'group') {
    query = `UPDATE training_groups SET ${assignments} WHERE id=$1 AND ($4::boolean OR instructor_id=$3) RETURNING id`;
  } else if (type === 'exam') {
    query = `UPDATE final_exams fe SET ${assignments} FROM training_groups tg
      WHERE fe.id=$1 AND fe.group_id=tg.id AND ($4::boolean OR tg.instructor_id=$3) RETURNING fe.id`;
  } else if (type === 'experience') {
    query = `UPDATE practical_experiences pe SET ${assignments} FROM training_groups tg
      WHERE pe.id=$1 AND pe.group_id=tg.id AND ($4::boolean OR tg.instructor_id=$3) RETURNING pe.id`;
  } else if (type === 'certificate') {
    query = `UPDATE certificates cert SET ${assignments} FROM training_groups tg
      WHERE cert.id=$1 AND cert.training_group_id=tg.id AND ($4::boolean OR tg.instructor_id=$3) RETURNING cert.id`;
  } else if (type === 'participant') {
    query = `UPDATE app_users u SET ${assignments} WHERE u.id=$1 AND u.role='learner' AND ($4::boolean OR EXISTS (
      SELECT 1 FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
      WHERE sp.user_id=u.id AND ls.instructor_id=$3
    )) RETURNING u.id`;
  } else {
    fail(400, 'Type d’archive invalide.');
  }
  const result = await pool.query(query, type === 'question' ? values.slice(0, 3) : values);
  if (!result.rows[0]) fail(404, 'Élément introuvable ou non autorisé.');
  return result.rows[0];
}

app.get('/api/archives', requireStaff, asyncRoute(async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM (
      SELECT 'session'::text AS type,ls.id,('Session '||ls.code)::text AS label,
        (t.name||' · '||c.title)::text AS details,ls.archived_at
      FROM live_sessions ls JOIN quizzes q ON q.id=ls.quiz_id JOIN chapters c ON c.id=q.chapter_id JOIN themes t ON t.id=c.theme_id
      WHERE ls.archived_at IS NOT NULL AND ($1::boolean OR ls.instructor_id=$2)
      UNION ALL
      SELECT 'group',tg.id,tg.name,(t.name||' · '||tg.start_date::text||' au '||tg.end_date::text),tg.archived_at
      FROM training_groups tg JOIN themes t ON t.id=tg.theme_id
      WHERE tg.archived_at IS NOT NULL AND ($1::boolean OR tg.instructor_id=$2)
      UNION ALL
      SELECT 'exam',fe.id,fe.title,(tg.name||' · code '||fe.code),fe.archived_at
      FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id
      WHERE fe.archived_at IS NOT NULL AND ($1::boolean OR tg.instructor_id=$2)
      UNION ALL
      SELECT 'experience',pe.id,pe.name,(u.first_name||' '||u.last_name||' · '||pe.score::text||'/'||pe.max_score::text),pe.archived_at
      FROM practical_experiences pe JOIN training_groups tg ON tg.id=pe.group_id JOIN app_users u ON u.id=pe.user_id
      WHERE pe.archived_at IS NOT NULL AND ($1::boolean OR tg.instructor_id=$2)
      UNION ALL
      SELECT 'certificate',cert.id,cert.certificate_number,(u.first_name||' '||u.last_name||' · '||cert.global_score::text||' %'),cert.archived_at
      FROM certificates cert JOIN training_groups tg ON tg.id=cert.training_group_id JOIN app_users u ON u.id=cert.user_id
      WHERE cert.archived_at IS NOT NULL AND ($1::boolean OR tg.instructor_id=$2)
      UNION ALL
      SELECT 'participant',u.id,(u.first_name||' '||u.last_name),COALESCE(u.participant_code,'Sans code'),u.archived_at
      FROM app_users u WHERE u.role='learner' AND u.archived_at IS NOT NULL AND ($1::boolean OR EXISTS (
        SELECT 1 FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
        WHERE sp.user_id=u.id AND ls.instructor_id=$2
      ))
      UNION ALL
      SELECT 'question',qu.id,qu.body,(t.name||' · '||c.title||' · question '||qu.position::text),qu.archived_at
      FROM questions qu JOIN quizzes q ON q.id=qu.quiz_id JOIN chapters c ON c.id=q.chapter_id JOIN themes t ON t.id=c.theme_id
      WHERE qu.archived_at IS NOT NULL
    ) archived ORDER BY archived_at DESC,label`,
    [req.user.role === 'superadmin', req.user.id]
  );
  res.set('Cache-Control', 'no-store').json(result.rows);
}));

app.post('/api/archives/:type/:id', requireStaff, asyncRoute(async (req, res) => {
  await setArchiveState(req.params.type, assertUuid(req.params.id, 'Élément'), req.user, true);
  res.status(204).end();
}));

app.post('/api/archives/:type/:id/restore', requireStaff, asyncRoute(async (req, res) => {
  await setArchiveState(req.params.type, assertUuid(req.params.id, 'Élément'), req.user, false);
  res.status(204).end();
}));

app.delete('/api/archives/:type/:id', requireStaff, asyncRoute(async (req, res) => {
  if (req.user.role !== 'superadmin') fail(403, 'Seul le superadministrateur peut supprimer définitivement une archive.');
  const id = assertUuid(req.params.id, 'Élément');
  const tables = {
    question: 'questions', session: 'live_sessions', group: 'training_groups', exam: 'final_exams',
    experience: 'practical_experiences', certificate: 'certificates', participant: 'app_users'
  };
  const table = tables[req.params.type];
  if (!table) fail(400, 'Type d’archive invalide.');
  const result = await pool.query(`DELETE FROM ${table} WHERE id=$1 AND archived_at IS NOT NULL RETURNING id`, [id]);
  if (!result.rows[0]) fail(404, 'Archive introuvable.');
  res.status(204).end();
}));

app.get('/api/presentation/exam', presentationLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.query?.code, 'Code', 8).toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) fail(400, 'Code d’examen invalide.');
  const result = await pool.query(
    `SELECT fe.code,fe.title,fe.duration_minutes,fe.status,tg.name AS group_name,t.name AS theme_name
     FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id JOIN themes t ON t.id=tg.theme_id
     WHERE fe.code=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [code]
  );
  if (!result.rows[0]) fail(404, 'Examen final introuvable.');
  res.set('Cache-Control', 'no-store').json(result.rows[0]);
}));

app.get('/api/presentation/exam-qr', presentationLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.query?.code, 'Code', 8).toUpperCase();
  const exists = await pool.query(
    `SELECT fe.id FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id
     WHERE fe.code=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [code]
  );
  if (!exists.rows[0]) fail(404, 'Examen final introuvable.');
  const url = `${verificationBaseUrl(req)}/exam.html?exam=${encodeURIComponent(code)}`;
  const png = await QRCode.toBuffer(url, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
  res.set('Cache-Control', 'no-store').type('png').send(png);
}));

app.get('/api/qr', asyncRoute(async (req, res) => {
  const code = requiredText(req.query?.code, 'Code', 8).toUpperCase();
  if (!/^[A-Z0-9]{4,8}$/.test(code)) fail(400, 'Code invalide.');
  const forwardedProto = req.get('x-forwarded-proto') || req.protocol;
  const forwardedHost = req.get('x-forwarded-host') || req.get('host');
  const learnerUrl = `${forwardedProto}://${forwardedHost}/learner.html?session=${encodeURIComponent(code)}`;
  const png = await QRCode.toBuffer(learnerUrl, { width: 220, margin: 1, errorCorrectionLevel: 'M' });
  res.set('Cache-Control', 'no-store');
  res.type('png').send(png);
}));

// Keep application files revalidated so a deployment is visible immediately.
app.use(express.static(publicDir, { extensions: ['html'], maxAge: 0, etag: true }));

app.use((error, req, res, _next) => {
  if (error?.code === '23505') error = new HttpError(409, 'Cette valeur existe déjà.');
  if (error?.code === '23503') error = new HttpError(409, 'Cet élément est encore utilisé et ne peut pas être supprimé.');
  const status = Number(error.status) || 500;
  if (status >= 500) console.error(`[${req.method} ${req.originalUrl}]`, error);
  res.status(status).json({ message: status >= 500 ? 'Erreur interne du serveur.' : error.message });
});

const server = app.listen(port, () => console.log(`Quiz API listening on port ${port}`));

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
