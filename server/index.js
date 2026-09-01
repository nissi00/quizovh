import crypto from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import QRCode from 'qrcode';

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
  const hours = kind === 'staff' ? 8 : 12;
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
    `SELECT u.id,u.email,u.first_name,u.last_name,u.role,s.id AS auth_session_id
     FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind=$2 AND s.expires_at>now()`,
    [tokenHash(raw), kind]
  );
  return result.rows[0] || null;
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
  await pool.query(
    `UPDATE live_sessions SET status='polling'
     WHERE status='live' AND question_ends_at IS NOT NULL AND question_ends_at<=now()`
  );
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

app.get('/api/catalog', requireStaff, asyncRoute(async (_req, res) => {
  const [themesResult, chaptersResult, quizzesResult, questionsResult, optionsResult] = await Promise.all([
    pool.query('SELECT id,name,description,position FROM themes WHERE is_active ORDER BY position,id'),
    pool.query('SELECT id,theme_id,title,description,position FROM chapters WHERE is_active ORDER BY position,id'),
    pool.query('SELECT id,chapter_id,title,default_duration_seconds FROM quizzes WHERE is_active ORDER BY title,id'),
    pool.query('SELECT id,quiz_id,body,duration_seconds,position,explanation,difficulty,subtopic FROM questions WHERE is_active ORDER BY position,id'),
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
  const sessionsResult = await pool.query(
    `SELECT id,code,quiz_id,status,current_question_id,question_started_at,question_ends_at,capacity,created_at,ended_at
     FROM live_sessions${scope.clause} ORDER BY created_at DESC`,
    scope.values
  );
  const sessions = sessionsResult.rows;
  if (!sessions.length) return res.json([]);
  const ids = sessions.map(session => session.id);
  const [participantsResult, answersResult, submissionsResult] = await Promise.all([
    pool.query(
      `SELECT sp.id,sp.session_id,sp.status,sp.user_id,u.first_name,u.last_name
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
  const quiz = await pool.query('SELECT id FROM quizzes WHERE id=$1 AND is_active', [quizId]);
  if (!quiz.rows[0]) fail(404, 'Quiz introuvable.');
  const created = await pool.query(
    `INSERT INTO live_sessions(code,quiz_id,instructor_id,status) VALUES($1,$2,$3,'waiting') RETURNING *`,
    [code, quizId, req.user.id]
  );
  res.status(201).json(created.rows[0]);
}));

app.patch('/api/live-sessions/:id', requireStaff, asyncRoute(async (req, res) => {
  const id = assertUuid(req.params.id, 'Session');
  const ownership = await pool.query('SELECT id,quiz_id,instructor_id FROM live_sessions WHERE id=$1', [id]);
  const session = ownership.rows[0];
  if (!session) fail(404, 'Session introuvable.');
  if (req.user.role !== 'superadmin' && session.instructor_id !== req.user.id) fail(403, 'Session non autorisée.');
  const allowed = ['status', 'current_question_id', 'question_started_at', 'question_ends_at', 'ended_at'];
  const fields = [];
  const values = [];
  for (const key of allowed) {
    if (!(key in (req.body || {}))) continue;
    let value = req.body[key];
    if (key === 'status' && !['waiting', 'live', 'polling', 'finished'].includes(value)) fail(400, 'État de session invalide.');
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
      qz.title AS quiz_title,c.title AS chapter_title,t.name AS theme_name
     FROM live_sessions ls
     JOIN quizzes qz ON qz.id=ls.quiz_id
     JOIN chapters c ON c.id=qz.chapter_id
     JOIN themes t ON t.id=c.theme_id
     WHERE ls.code=$1`,
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
    reviewing,
    question,
    poll_results: pollResults,
    joined_count: participantCounts.joined_count,
    waiting_count: participantCounts.waiting_count,
    answered_count: answeredCount
  });
}));

app.post('/api/learner/join', joinLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  const firstName = requiredText(req.body?.first_name, 'Prénom', 100);
  const lastName = requiredText(req.body?.last_name, 'Nom', 100);
  const previous = await findSession(req, 'learner');
  const joined = await withTransaction(async client => {
    const sessionResult = await client.query('SELECT id,status FROM live_sessions WHERE code=$1 FOR UPDATE', [code]);
    const session = sessionResult.rows[0];
    if (!session || session.status === 'finished') fail(404, 'Session introuvable ou terminée.');
    let userId = previous?.id;
    if (userId) {
      const updated = await client.query(
        "UPDATE app_users SET first_name=$1,last_name=$2 WHERE id=$3 AND role='learner' RETURNING id",
        [firstName, lastName, userId]
      );
      if (!updated.rows[0]) userId = null;
    }
    if (!userId) {
      const created = await client.query(
        "INSERT INTO app_users(first_name,last_name,role) VALUES($1,$2,'learner') RETURNING id",
        [firstName, lastName]
      );
      userId = created.rows[0].id;
    }
    const participant = await client.query(
      `INSERT INTO session_participants(session_id,user_id,status) VALUES($1,$2,'waiting_list')
       ON CONFLICT(session_id,user_id) DO UPDATE
       SET status=CASE WHEN session_participants.status='joined' THEN 'joined'::participation_status ELSE 'waiting_list'::participation_status END
       RETURNING id,status`,
      [session.id, userId]
    );
    return { userId, participant: participant.rows[0] };
  });
  const oldRaw = req.cookies?.quiz_learner;
  if (oldRaw) await pool.query('DELETE FROM auth_sessions WHERE token_hash=$1', [tokenHash(oldRaw)]);
  await issueSession(res, joined.userId, 'learner');
  res.json(joined.participant);
}));

app.get('/api/learner/state', requireLearner, asyncRoute(async (req, res) => {
  await closeExpiredQuestions();
  const code = requiredText(req.query?.code, 'Code', 8).toUpperCase();
  const base = await pool.query(
    `SELECT ls.*,sp.id AS participant_id,sp.status AS participant_status
     FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
     WHERE ls.code=$1 AND sp.user_id=$2`,
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
      if (revealAnswers) {
        const [answer, selected] = await Promise.all([
          pool.query(
            'SELECT is_correct FROM live_answer_submissions WHERE session_id=$1 AND question_id=$2 AND participant_id=$3',
            [session.id, question.id, session.participant_id]
          ),
          pool.query(
            'SELECT option_id FROM live_answers WHERE session_id=$1 AND question_id=$2 AND participant_id=$3 ORDER BY option_id',
            [session.id, question.id, session.participant_id]
          )
        ]);
        answerResult = answer.rows[0]?.is_correct ?? null;
        selectedOptionIds = selected.rows.map(row => row.option_id);
      }
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
    question_started_at: session.question_started_at,
    question_ends_at: session.question_ends_at,
    question_expired: expired,
    question,
    waiting_participants: waitingParticipantsResult.rows,
    poll_results: pollResults,
    answer_result: answerResult,
    selected_option_ids: selectedOptionIds,
    reviewing,
    final_score: finalScore
  });
}));

app.post('/api/learner/answers', requireLearner, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  const optionIds = Array.isArray(req.body?.option_ids) ? [...new Set(req.body.option_ids)] : [];
  if (!optionIds.length || optionIds.length > 4 || optionIds.some(id => !isUuid(id))) fail(400, 'Proposition invalide.');
  await withTransaction(async client => {
    const result = await client.query(
      `SELECT ls.id AS session_id,ls.current_question_id,ls.status,ls.question_ends_at,sp.id AS participant_id,sp.status AS participant_status
       FROM live_sessions ls JOIN session_participants sp ON sp.session_id=ls.id
       WHERE ls.code=$1 AND sp.user_id=$2 FOR UPDATE OF ls,sp`,
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
