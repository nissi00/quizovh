import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import pg from 'pg';
import QRCode from 'qrcode';
import { getSurveyQuestionnaire } from '../survey-questionnaires.js';
import { normalizeSurveyAnswers, surveyCsv } from './survey-answers.js';

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

async function staffUser(req, db = surveyPool) {
  const token = parseCookies(req.headers.cookie).quiz_staff;
  if (!token) throw httpError(401, 'Connexion instructeur requise.');
  const result = await db.query(
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
        if (['satisfaction_surveys_one_open_per_group_idx', 'satisfaction_surveys_one_open_per_group_type_idx'].includes(error.constraint)) {
          message = 'Une enquête de ce type est déjà ouverte pour ce groupe.';
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

async function groupForStaff(groupId, user, db = surveyPool) {
  if (!/^[0-9a-f-]{36}$/i.test(String(groupId || ''))) throw httpError(400, 'Groupe invalide.');
  const result = await db.query(
    `SELECT tg.id,tg.name,tg.start_date,tg.end_date,tg.instructor_id,t.name AS formation_title,
      concat_ws(' ',i.first_name,i.last_name) AS trainer_name
     FROM training_groups tg JOIN themes t ON t.id=tg.theme_id JOIN app_users i ON i.id=tg.instructor_id
     WHERE tg.id=$1 AND tg.archived_at IS NULL AND ($2::boolean OR tg.instructor_id=$3)`,
    [groupId, user.role === 'superadmin', user.id]
  );
  if (!result.rows[0]) throw httpError(404, 'Groupe de formation introuvable ou non autorisé.');
  return result.rows[0];
}

async function surveyForStaff(id, user, db = surveyPool) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) throw httpError(400, 'Enquête invalide.');
  const result = await db.query(
    `SELECT s.*,tg.name AS group_name,tg.start_date,tg.end_date,t.name AS formation_title,
      concat_ws(' ',i.first_name,i.last_name) AS trainer_name
     FROM satisfaction_surveys s
     JOIN training_groups tg ON tg.id=s.group_id
     JOIN themes t ON t.id=tg.theme_id
     JOIN app_users i ON i.id=tg.instructor_id
     WHERE s.id=$1 AND s.archived_at IS NULL AND tg.archived_at IS NULL AND ($2::boolean OR tg.instructor_id=$3)`,
    [id, user.role === 'superadmin', user.id]
  );
  if (!result.rows[0]) throw httpError(404, 'Enquête introuvable ou non autorisée.');
  return result.rows[0];
}

async function generateSurveyCode(db = surveyPool) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    const existing = await db.query('SELECT 1 FROM satisfaction_surveys WHERE code=$1', [code]);
    if (!existing.rows[0]) return code;
  }
  throw new Error("Impossible de générer un code d'enquête unique.");
}

function baseUrl(req) {
  const protocol = req.get('x-forwarded-proto') || req.protocol;
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${protocol}://${host}`;
}

function publicSurveyPayload(row) {
  return {
    survey_type: row.survey_type || 'trainee',
    questionnaire_title: getSurveyQuestionnaire(row.survey_type || 'trainee')?.title,
    code: row.code,
    status: row.status,
    formation_title: row.formation_title,
    group_name: row.group_name,
    start_date: row.start_date,
    end_date: row.end_date,
    trainer_name: row.trainer_name
  };
}

export function registerRoutes(app, db = surveyPool) {
  if (app[installed]) return;
  app[installed] = true;

  app.get('/api/satisfaction-surveys', safe(async (req, res) => {
    const user = await staffUser(req, db);
    const result = await db.query(
      `SELECT s.id,s.group_id,s.survey_type,s.code,s.status,s.created_at,s.closed_at,tg.name AS group_name,
        tg.start_date,tg.end_date,t.name AS formation_title,concat_ws(' ',i.first_name,i.last_name) AS trainer_name,
        count(r.id)::integer AS response_count
       FROM satisfaction_surveys s
       JOIN training_groups tg ON tg.id=s.group_id
       JOIN themes t ON t.id=tg.theme_id
       JOIN app_users i ON i.id=tg.instructor_id
       LEFT JOIN satisfaction_responses r ON r.survey_id=s.id
       WHERE s.archived_at IS NULL AND tg.archived_at IS NULL AND ($1::boolean OR tg.instructor_id=$2)
       GROUP BY s.id,tg.id,t.name,i.first_name,i.last_name
       ORDER BY s.created_at DESC`,
      [user.role === 'superadmin', user.id]
    );
    res.set('Cache-Control', 'no-store').json(result.rows);
  }));

  app.post('/api/satisfaction-surveys', safe(async (req, res) => {
    const user = await staffUser(req, db);
    const group = await groupForStaff(req.body?.group_id, user, db);
    const type = req.body?.survey_type ?? 'trainee';
    const questionnaire = getSurveyQuestionnaire(type);
    if (!questionnaire) throw httpError(400, 'Type de questionnaire invalide.');
    const existing = await db.query(
      `SELECT id,code FROM satisfaction_surveys WHERE group_id=$1 AND survey_type=$2 AND status='open' ORDER BY created_at DESC LIMIT 1`,
      [group.id, type]
    );
    if (existing.rows[0]) throw httpError(409, `Une enquête de ce type est déjà ouverte pour ce groupe (code ${existing.rows[0].code}).`);
    const code = await generateSurveyCode(db);
    const created = await db.query(
      `INSERT INTO satisfaction_surveys(group_id,code,status,created_by,survey_type)
       VALUES($1,$2,'open',$3,$4) RETURNING *`,
      [group.id, code, user.id, type]
    );
    res.locals.audit = {
      action: 'satisfaction_survey.create',
      entityType: 'satisfaction_survey',
      entityId: created.rows[0].id,
      summary: `Création de l’enquête « ${questionnaire.title} » du groupe ${group.name}`,
      metadata: { group_id: group.id, survey_code: code, survey_type:type }
    };
    res.status(201).json({ ...group, ...created.rows[0], group_name: group.name });
  }));

  app.patch('/api/satisfaction-surveys/:id', safe(async (req, res) => {
    const user = await staffUser(req, db);
    const survey = await surveyForStaff(req.params.id, user, db);
    const status = String(req.body?.status || '');
    if (!['open', 'closed'].includes(status)) throw httpError(400, "État de l'enquête invalide.");
    const updated = await db.query(
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
    const user = await staffUser(req, db);
    const survey = await surveyForStaff(req.params.id, user, db);
    const responses = await db.query(
      `SELECT answers FROM satisfaction_responses WHERE survey_id=$1 ORDER BY submitted_at DESC`,
      [survey.id]
    );
    res.set('Cache-Control', 'no-store').json({ survey, responses: responses.rows });
  }));

  app.get('/api/satisfaction-surveys/:id/qr', safe(async (req, res) => {
    const user = await staffUser(req, db);
    const survey = await surveyForStaff(req.params.id, user, db);
    const url = `${baseUrl(req)}/survey.html?survey=${encodeURIComponent(survey.code)}`;
    const png = await QRCode.toBuffer(url, { width: 280, margin: 1, errorCorrectionLevel: 'M' });
    res.set('Cache-Control', 'no-store').type('png').send(png);
  }));

  app.get('/api/satisfaction-surveys/:id/export.csv', safe(async (req, res) => {
    const user = await staffUser(req, db);
    const survey = await surveyForStaff(req.params.id, user, db);
    const responses = await db.query(
      'SELECT answers FROM satisfaction_responses WHERE survey_id=$1 ORDER BY submitted_at',
      [survey.id]
    );
    const csv = surveyCsv(survey.survey_type || 'trainee', responses.rows);
    res.set({
      'Cache-Control': 'no-store',
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="enquete-satisfaction-${survey.code}.csv"`
    }).send(csv);
  }));

  app.get('/api/satisfaction-surveys/public/:code', satisfactionReadLimiter, safe(async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const result = await db.query(
      `SELECT s.code,s.status,s.survey_type,s.group_id,tg.name AS group_name,tg.start_date,tg.end_date,t.name AS formation_title,
        concat_ws(' ',i.first_name,i.last_name) AS trainer_name
       FROM satisfaction_surveys s
       JOIN training_groups tg ON tg.id=s.group_id
       JOIN themes t ON t.id=tg.theme_id
       JOIN app_users i ON i.id=tg.instructor_id
       WHERE s.code=$1 AND s.archived_at IS NULL AND tg.archived_at IS NULL`,
      [code]
    );
    if (!result.rows[0]) throw httpError(404, 'Enquête introuvable.');
    if (getSurveyQuestionnaire(result.rows[0].survey_type || 'trainee')?.staffOnly) {
      const user = await staffUser(req, db);
      await groupForStaff(result.rows[0].group_id, user, db);
    }
    res.set('Cache-Control', 'no-store').json(publicSurveyPayload(result.rows[0]));
  }));

  app.post('/api/satisfaction-surveys/public/:code/responses', satisfactionSubmitLimiter, safe(async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const token = String(req.body?.response_token || '').trim();
    if (token.length < 16 || token.length > 200) throw httpError(400, 'Jeton de réponse invalide.');
    const survey = await db.query(
      `SELECT s.id,s.status,s.survey_type,s.group_id FROM satisfaction_surveys s JOIN training_groups tg ON tg.id=s.group_id
       WHERE s.code=$1 AND s.archived_at IS NULL AND tg.archived_at IS NULL`,
      [code]
    );
    if (!survey.rows[0]) throw httpError(404, 'Enquête introuvable.');
    if (survey.rows[0].status !== 'open') throw httpError(409, 'Cette enquête est clôturée.');
    const type = survey.rows[0].survey_type || 'trainee';
    if (getSurveyQuestionnaire(type)?.staffOnly) {
      const user = await staffUser(req, db);
      await groupForStaff(survey.rows[0].group_id, user, db);
    }
    const answers = normalizeSurveyAnswers(type, req.body?.answers);
    await db.query(
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
    const result = await db.query(
      `SELECT s.code,s.status,s.survey_type,s.group_id,tg.name AS group_name,tg.start_date,tg.end_date,t.name AS formation_title,
        concat_ws(' ',i.first_name,i.last_name) AS trainer_name
       FROM satisfaction_surveys s
       JOIN training_groups tg ON tg.id=s.group_id
       JOIN themes t ON t.id=tg.theme_id
       JOIN app_users i ON i.id=tg.instructor_id
       WHERE s.code=$1 AND s.archived_at IS NULL AND tg.archived_at IS NULL`,
      [code]
    );
    if (!result.rows[0]) throw httpError(404, 'Enquête introuvable.');
    res.set('Cache-Control', 'no-store').json(publicSurveyPayload(result.rows[0]));
  }));

  app.get('/api/presentation/survey-qr', satisfactionReadLimiter, safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(code)) throw httpError(400, "Code d'enquête invalide.");
    const exists = await db.query(
      `SELECT s.id FROM satisfaction_surveys s JOIN training_groups tg ON tg.id=s.group_id
       WHERE s.code=$1 AND s.archived_at IS NULL AND tg.archived_at IS NULL`,
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
