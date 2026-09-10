import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import QRCode from 'qrcode';

const { Pool } = pg;
const originalListen = express.application.listen;
const installed = Symbol.for('ts.satisfaction.routes.installed');
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const surveyPool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 4,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

const satisfactionReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const satisfactionSubmitLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

const choiceQuestions = {
  organization_information: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  organization_schedule: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  organization_facilities: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  content_expectations: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  content_theory: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  content_exercises: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  content_materials: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  trainer_mastery: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  trainer_availability: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  trainer_exercises: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  trainer_dynamics: ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'],
  objectives_achieved: ['Oui, tout à fait', 'En grande partie', 'Partiellement', 'Pas du tout'],
  objectives_apply: ['Oui, tout à fait', 'En grande partie', 'Partiellement', 'Pas du tout']
};

const labels = {
  organization_information: 'Information préalable (programme, convocation, accès)',
  organization_schedule: 'Respect des horaires et du déroulement de la session',
  organization_facilities: 'Qualité des locaux, équipements et moyens matériels',
  content_expectations: 'Adéquation du programme avec vos attentes',
  content_theory: 'Clarté des explications théoriques',
  content_exercises: 'Qualité et utilité des exercices',
  content_materials: 'Qualité des supports de cours remis',
  trainer_mastery: "Maîtrise du sujet par l'intervenant",
  trainer_availability: 'Disponibilité, écoute et réponse aux questions',
  trainer_exercises: 'Qualité et utilité des exercices',
  trainer_dynamics: 'Dynamisme et rythme de la formation',
  objectives_achieved: 'Estimé-vous avoir atteint les objectifs de la formation ?',
  objectives_apply: 'Allez-vous pouvoir appliquer ces acquis dans votre travail ?',
  recommendation: 'Recommanderiez-vous cette formation à un collègue ou professionnel du secteur ?',
  strengths: 'Points forts de la formation',
  improvements: "Axes d'amélioration ou remarques complémentaires"
};

function decodeCookiePart(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeCookiePart(part.slice(index + 1))];
  }));
}

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const httpError = (status, message) => Object.assign(new Error(message), { status });

async function staffUser(req) {
  const token = parseCookies(req.headers.cookie).quiz_staff;
  if (!token) throw httpError(401, 'Connexion instructeur requise.');
  const result = await surveyPool.query(
    `SELECT u.id,u.first_name,u.last_name,u.role
     FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind='staff' AND s.expires_at>now()
       AND u.archived_at IS NULL AND u.role IN ('instructor','superadmin')`,
    [sha256(token)]
  );
  if (!result.rows[0]) throw httpError(401, 'Connexion instructeur requise.');
  req.user = result.rows[0];
  return result.rows[0];
}

function safe(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      let status = Number(error?.status) || 500;
      let message = error?.message || 'Erreur interne du serveur.';
      if (error?.code === '23505') {
        status = 409;
        if (error.constraint === 'satisfaction_surveys_one_open_per_group_idx') {
          message = 'Une enquête est déjà ouverte pour ce groupe.';
        } else if (error.constraint === 'satisfaction_responses_survey_id_response_token_hash_key') {
          message = 'Une réponse a déjà été enregistrée depuis cet appareil pour cette enquête.';
        } else {
          message = 'Cette valeur existe déjà.';
        }
      }
      if (error?.code === '23503') {
        status = 409;
        message = 'Cet élément est encore utilisé.';
      }
      if (status >= 500) console.error('[satisfaction]', error);
      if (!res.headersSent) res.status(status).json({ message: status >= 500 ? 'Erreur interne du serveur.' : message });
    }
  };
}

async function groupForStaff(groupId, user) {
  if (!/^[0-9a-f-]{36}$/i.test(String(groupId || ''))) throw httpError(400, 'Groupe invalide.');
  const result = await surveyPool.query(
    `SELECT tg.id,tg.name,tg.start_date,tg.end_date,tg.instructor_id,t.name AS formation_title,
      concat_ws(' ',i.first_name,i.last_name) AS trainer_name
     FROM training_groups tg JOIN themes t ON t.id=tg.theme_id JOIN app_users i ON i.id=tg.instructor_id
     WHERE tg.id=$1 AND tg.archived_at IS NULL AND ($2::boolean OR tg.instructor_id=$3)`,
    [groupId, user.role === 'superadmin', user.id]
  );
  if (!result.rows[0]) throw httpError(404, 'Groupe de formation introuvable ou non autorisé.');
  return result.rows[0];
}

async function surveyForStaff(id, user) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw httpError(400, 'Enquête invalide.');
  const result = await surveyPool.query(
    `SELECT s.*,tg.name AS group_name,tg.start_date,tg.end_date,t.name AS formation_title,
      concat_ws(' ',i.first_name,i.last_name) AS trainer_name
     FROM satisfaction_surveys s
     JOIN training_groups tg ON tg.id=s.group_id
     JOIN themes t ON t.id=tg.theme_id
     JOIN app_users i ON i.id=tg.instructor_id
     WHERE s.id=$1 AND tg.archived_at IS NULL AND ($2::boolean OR tg.instructor_id=$3)`,
    [id, user.role === 'superadmin', user.id]
  );
  if (!result.rows[0]) throw httpError(404, 'Enquête introuvable ou non autorisée.');
  return result.rows[0];
}

async function generateSurveyCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    const existing = await surveyPool.query('SELECT 1 FROM satisfaction_surveys WHERE code=$1', [code]);
    if (!existing.rows[0]) return code;
  }
  throw new Error("Impossible de générer un code d'enquête unique.");
}

function baseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

function normalizeAnswers(input) {
  const answers = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalized = {};
  for (const [key, allowed] of Object.entries(choiceQuestions)) {
    const value = String(answers[key] || '').trim();
    if (!allowed.includes(value)) throw httpError(400, `Réponse requise : ${labels[key]}`);
    normalized[key] = value;
  }
  const recommendation = Number(answers.recommendation);
  if (!Number.isInteger(recommendation) || recommendation < 1 || recommendation > 10) {
    throw httpError(400, 'Choisissez une note de recommandation entre 1 et 10.');
  }
  normalized.recommendation = recommendation;
  for (const key of ['strengths', 'improvements']) {
    const value = String(answers[key] || '').trim();
    if (value.length > 2000) throw httpError(400, `${labels[key]} : 2 000 caractères maximum.`);
    normalized[key] = value;
  }
  return normalized;
}

function publicSurveyPayload(row) {
  return {
    code: row.code,
    status: row.status,
    formation_title: row.formation_title,
    group_name: row.group_name,
    start_date: row.start_date,
    end_date: row.end_date,
    trainer_name: row.trainer_name
  };
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

function registerRoutes(app) {
  if (app[installed]) return;
  app[installed] = true;

  app.get('/api/satisfaction-surveys', safe(async (req, res) => {
    const user = await staffUser(req);
    const result = await surveyPool.query(
      `SELECT s.id,s.group_id,s.code,s.status,s.created_at,s.closed_at,tg.name AS group_name,
        tg.start_date,tg.end_date,t.name AS formation_title,concat_ws(' ',i.first_name,i.last_name) AS trainer_name,
        count(r.id)::integer AS response_count
       FROM satisfaction_surveys s
       JOIN training_groups tg ON tg.id=s.group_id
       JOIN themes t ON t.id=tg.theme_id
       JOIN app_users i ON i.id=tg.instructor_id
       LEFT JOIN satisfaction_responses r ON r.survey_id=s.id
       WHERE tg.archived_at IS NULL AND ($1::boolean OR tg.instructor_id=$2)
       GROUP BY s.id,tg.id,t.name,i.first_name,i.last_name
       ORDER BY s.created_at DESC`,
      [user.role === 'superadmin', user.id]
    );
    res.set('Cache-Control', 'no-store').json(result.rows);
  }));

  app.post('/api/satisfaction-surveys', safe(async (req, res) => {
    const user = await staffUser(req);
    const group = await groupForStaff(req.body?.group_id, user);
    const existing = await surveyPool.query(
      `SELECT id,code FROM satisfaction_surveys WHERE group_id=$1 AND status='open' ORDER BY created_at DESC LIMIT 1`,
      [group.id]
    );
    if (existing.rows[0]) throw httpError(409, `Une enquête est déjà ouverte pour ce groupe (code ${existing.rows[0].code}).`);
    const code = await generateSurveyCode();
    const created = await surveyPool.query(
      `INSERT INTO satisfaction_surveys(group_id,code,status,created_by)
       VALUES($1,$2,'open',$3) RETURNING *`,
      [group.id, code, user.id]
    );
    res.locals.audit = {
      action: 'satisfaction_survey.create',
      entityType: 'satisfaction_survey',
      entityId: created.rows[0].id,
      summary: `Création de l'enquête de satisfaction du groupe ${group.name}`,
      metadata: { group_id: group.id, survey_code: code }
    };
    res.status(201).json({ ...created.rows[0], ...group, group_name: group.name });
  }));

  app.patch('/api/satisfaction-surveys/:id', safe(async (req, res) => {
    const user = await staffUser(req);
    const survey = await surveyForStaff(req.params.id, user);
    const status = String(req.body?.status || '');
    if (!['open', 'closed'].includes(status)) throw httpError(400, "État de l'enquête invalide.");
    const updated = await surveyPool.query(
      `UPDATE satisfaction_surveys SET status=$1,closed_at=CASE WHEN $1='closed' THEN now() ELSE NULL END
       WHERE id=$2 RETURNING id,status,closed_at`,
      [status, survey.id]
    );
    res.locals.audit = {
      action: status === 'closed' ? 'satisfaction_survey.close' : 'satisfaction_survey.reopen',
      entityType: 'satisfaction_survey',
      entityId: survey.id,
      summary: `${status === 'closed' ? 'Clôture' : 'Réouverture'} de l'enquête de satisfaction ${survey.code}`,
      metadata: { group_id: survey.group_id, survey_code: survey.code }
    };
    res.json(updated.rows[0]);
  }));

  app.get('/api/satisfaction-surveys/:id/results', safe(async (req, res) => {
    const user = await staffUser(req);
    const survey = await surveyForStaff(req.params.id, user);
    const responses = await surveyPool.query(
      `SELECT answers FROM satisfaction_responses WHERE survey_id=$1 ORDER BY submitted_at DESC`,
      [survey.id]
    );
    res.set('Cache-Control', 'no-store').json({ survey, responses: responses.rows });
  }));

  app.get('/api/satisfaction-surveys/:id/qr', safe(async (req, res) => {
    const user = await staffUser(req);
    const survey = await surveyForStaff(req.params.id, user);
    const url = `${baseUrl(req)}/survey.html?survey=${encodeURIComponent(survey.code)}`;
    const png = await QRCode.toBuffer(url, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'no-store').type('png').send(png);
  }));

  app.get('/api/satisfaction-surveys/:id/export.csv', safe(async (req, res) => {
    const user = await staffUser(req);
    const survey = await surveyForStaff(req.params.id, user);
    const responses = await surveyPool.query(
      'SELECT answers FROM satisfaction_responses WHERE survey_id=$1 ORDER BY submitted_at',
      [survey.id]
    );
    const keys = [...Object.keys(choiceQuestions), 'recommendation', 'strengths', 'improvements'];
    const headers = ['Réponse', ...keys.map(key => labels[key])];
    const rows = [headers, ...responses.rows.map((row, index) => [index + 1, ...keys.map(key => row.answers?.[key] ?? '')])];
    const csv = `\uFEFF${rows.map(row => row.map(csvCell).join(';')).join('\r\n')}\r\n`;
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="enquete-satisfaction-${survey.code}.csv"`
    }).send(csv);
  }));

  app.get('/api/satisfaction-surveys/public/:code', satisfactionReadLimiter, safe(async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const result = await surveyPool.query(
      `SELECT s.code,s.status,tg.name AS group_name,tg.start_date,tg.end_date,t.name AS formation_title,
        concat_ws(' ',i.first_name,i.last_name) AS trainer_name
       FROM satisfaction_surveys s
       JOIN training_groups tg ON tg.id=s.group_id
       JOIN themes t ON t.id=tg.theme_id
       JOIN app_users i ON i.id=tg.instructor_id
       WHERE s.code=$1 AND tg.archived_at IS NULL`,
      [code]
    );
    if (!result.rows[0]) throw httpError(404, 'Enquête introuvable.');
    res.set('Cache-Control', 'no-store').json(publicSurveyPayload(result.rows[0]));
  }));

  app.post('/api/satisfaction-surveys/public/:code/responses', satisfactionSubmitLimiter, safe(async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const token = String(req.body?.response_token || '').trim();
    if (token.length < 16 || token.length > 200) throw httpError(400, 'Jeton de réponse invalide.');
    const survey = await surveyPool.query(
      `SELECT s.id,s.status FROM satisfaction_surveys s JOIN training_groups tg ON tg.id=s.group_id
       WHERE s.code=$1 AND tg.archived_at IS NULL`,
      [code]
    );
    if (!survey.rows[0]) throw httpError(404, 'Enquête introuvable.');
    if (survey.rows[0].status !== 'open') throw httpError(409, 'Cette enquête est clôturée.');
    const answers = normalizeAnswers(req.body?.answers);
    await surveyPool.query(
      `INSERT INTO satisfaction_responses(survey_id,response_token_hash,answers)
       VALUES($1,$2,$3::jsonb)`,
      [survey.rows[0].id, sha256(token), JSON.stringify(answers)]
    );
    res.locals.skipAudit = true;
    res.status(201).json({ submitted: true });
  }));

  app.get('/api/presentation/survey', satisfactionReadLimiter, safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const result = await surveyPool.query(
      `SELECT s.code,s.status,tg.name AS group_name,tg.start_date,tg.end_date,t.name AS formation_title,
        concat_ws(' ',i.first_name,i.last_name) AS trainer_name
       FROM satisfaction_surveys s
       JOIN training_groups tg ON tg.id=s.group_id
       JOIN themes t ON t.id=tg.theme_id
       JOIN app_users i ON i.id=tg.instructor_id
       WHERE s.code=$1 AND tg.archived_at IS NULL`,
      [code]
    );
    if (!result.rows[0]) throw httpError(404, 'Enquête introuvable.');
    res.set('Cache-Control', 'no-store').json(publicSurveyPayload(result.rows[0]));
  }));

  app.get('/api/presentation/survey-qr', satisfactionReadLimiter, safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const exists = await surveyPool.query(
      `SELECT s.id FROM satisfaction_surveys s JOIN training_groups tg ON tg.id=s.group_id
       WHERE s.code=$1 AND tg.archived_at IS NULL`,
      [code]
    );
    if (!exists.rows[0]) throw httpError(404, 'Enquête introuvable.');
    const url = `${baseUrl(req)}/survey.html?survey=${encodeURIComponent(code)}`;
    const png = await QRCode.toBuffer(url, { width: 320, margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'no-store').type('png').send(png);
  }));
}

express.application.listen = function patchedListen(...args) {
  registerRoutes(this);
  return originalListen.apply(this, args);
};
