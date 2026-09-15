import { crypto, pool, safe, sessionUser, isUuid, httpError } from './lot-improvements-common.js';

const participantAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function requiredName(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) throw httpError(400, `${label} requis.`);
  if (normalized.length > 100) throw httpError(400, `${label} trop long.`);
  return normalized;
}

async function generateParticipantCode() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const bytes = crypto.randomBytes(4);
    const randomPart = Array.from(bytes, byte => participantAlphabet[byte % participantAlphabet.length]).join('');
    const code = `TS-${randomPart}`;
    const existing = await pool.query('SELECT 1 FROM app_users WHERE participant_code=$1', [code]);
    if (!existing.rows[0]) return code;
  }
  throw httpError(500, 'Impossible de générer un code personnel unique.');
}

async function participantAllowed(id, user) {
  if (!isUuid(id)) throw httpError(400, 'Participant invalide.');
  const result = await pool.query(
    `SELECT u.id
     FROM app_users u
     WHERE u.id=$1 AND u.role='learner' AND u.archived_at IS NULL
       AND ($2::boolean
         OR EXISTS (
           SELECT 1 FROM session_participants sp
           JOIN live_sessions ls ON ls.id=sp.session_id
           WHERE sp.user_id=u.id AND ls.instructor_id=$3
         )
         OR EXISTS (
           SELECT 1 FROM training_group_participants tgp
           JOIN training_groups tg ON tg.id=tgp.group_id
           WHERE tgp.user_id=u.id AND tg.archived_at IS NULL AND tg.instructor_id=$3
         ))`,
    [id, user.role === 'superadmin', user.id]
  );
  if (!result.rows[0]) throw httpError(404, 'Participant introuvable ou non autorisé.');
  return result.rows[0];
}

async function qualityParticipantsForStaff(user) {
  const superadmin = user.role === 'superadmin';
  const usersResult = superadmin
    ? await pool.query(
      `SELECT u.id,u.first_name,u.last_name,u.participant_code,u.created_at
       FROM app_users u
       WHERE u.role='learner' AND u.archived_at IS NULL AND (
         EXISTS (SELECT 1 FROM session_participants sp WHERE sp.user_id=u.id)
         OR EXISTS (
           SELECT 1 FROM training_group_participants tgp
           JOIN training_groups tg ON tg.id=tgp.group_id
           WHERE tgp.user_id=u.id AND tg.archived_at IS NULL
         )
       )
       ORDER BY lower(u.last_name),lower(u.first_name),u.created_at`)
    : await pool.query(
      `SELECT u.id,u.first_name,u.last_name,u.participant_code,u.created_at
       FROM app_users u
       WHERE u.role='learner' AND u.archived_at IS NULL AND (
         EXISTS (
           SELECT 1 FROM session_participants sp
           JOIN live_sessions ls ON ls.id=sp.session_id
           WHERE sp.user_id=u.id AND ls.instructor_id=$1
         )
         OR EXISTS (
           SELECT 1 FROM training_group_participants tgp
           JOIN training_groups tg ON tg.id=tgp.group_id
           WHERE tgp.user_id=u.id AND tg.archived_at IS NULL AND tg.instructor_id=$1
         )
       )
       ORDER BY lower(u.last_name),lower(u.first_name),u.created_at`,
      [user.id]
    );

  if (!usersResult.rows.length) return [];
  const userIds = usersResult.rows.map(row => row.id);

  const participationValues = superadmin ? [userIds] : [userIds, user.id];
  const participationOwnership = superadmin ? '' : ' AND ls.instructor_id=$2';
  const participationsResult = await pool.query(
    `SELECT sp.user_id,sp.joined_at,ls.id AS session_id,ls.code AS session_code,ls.group_id,
      qz.id AS quiz_id,qz.title AS quiz_title,c.id AS chapter_id,c.title AS chapter_title,
      t.id AS theme_id,t.name AS theme_name,
      COALESCE(max(las.submitted_at),sp.joined_at) AS last_activity
     FROM session_participants sp
     JOIN live_sessions ls ON ls.id=sp.session_id
     JOIN quizzes qz ON qz.id=ls.quiz_id
     JOIN chapters c ON c.id=qz.chapter_id
     JOIN themes t ON t.id=c.theme_id
     LEFT JOIN live_answer_submissions las ON las.participant_id=sp.id
     WHERE sp.user_id=ANY($1::uuid[])${participationOwnership}
     GROUP BY sp.user_id,sp.joined_at,ls.id,ls.code,ls.group_id,qz.id,qz.title,c.id,c.title,t.id,t.name
     ORDER BY sp.joined_at DESC`,
    participationValues
  );

  const membershipValues = superadmin ? [userIds] : [userIds, user.id];
  const membershipOwnership = superadmin ? '' : ' AND tg.instructor_id=$2';
  const membershipsResult = await pool.query(
    `SELECT tgp.user_id,tgp.joined_at,tg.id AS group_id,tg.name AS group_name,
      tg.theme_id,t.name AS theme_name,
      max(COALESCE(fea.submitted_at,fea.started_at)) AS exam_activity
     FROM training_group_participants tgp
     JOIN training_groups tg ON tg.id=tgp.group_id
     JOIN themes t ON t.id=tg.theme_id
     LEFT JOIN final_exams fe ON fe.group_id=tg.id AND fe.archived_at IS NULL
     LEFT JOIN final_exam_attempts fea ON fea.exam_id=fe.id AND fea.user_id=tgp.user_id
     WHERE tgp.user_id=ANY($1::uuid[]) AND tg.archived_at IS NULL${membershipOwnership}
     GROUP BY tgp.user_id,tgp.joined_at,tg.id,tg.name,tg.theme_id,t.name
     ORDER BY tgp.joined_at DESC`,
    membershipValues
  );

  return usersResult.rows.map(learner => {
    const quizParticipations = participationsResult.rows.filter(row => row.user_id === learner.id);
    const memberships = membershipsResult.rows.filter(row => row.user_id === learner.id);
    const membershipMarkers = memberships.map(item => ({
      user_id: learner.id,
      joined_at: item.joined_at,
      last_activity: item.exam_activity || item.joined_at,
      group_id: item.group_id,
      group_name: item.group_name,
      theme_id: item.theme_id,
      theme_name: item.theme_name,
      chapter_id: null,
      chapter_title: null,
      session_id: null,
      session_code: null,
      quiz_id: null,
      quiz_title: null,
      quality_membership_only: true
    }));
    const participations = [...quizParticipations, ...membershipMarkers];
    const activityDates = [
      learner.created_at,
      ...quizParticipations.map(row => row.last_activity),
      ...memberships.map(row => row.exam_activity || row.joined_at)
    ].filter(Boolean).map(value => new Date(value).getTime()).filter(Number.isFinite);
    return {
      ...learner,
      last_activity: new Date(Math.max(...activityDates)).toISOString(),
      quality_quiz_count: new Set(quizParticipations.map(item => item.quiz_id).filter(Boolean)).size,
      quality_exam_first: quizParticipations.length === 0 && memberships.length > 0,
      participations
    };
  });
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

export function registerParticipantQualityRoutes(app) {
  app.get('/api/quality/participants', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    res.set('Cache-Control', 'no-store').json(await qualityParticipantsForStaff(user));
  }));

  app.get('/api/quality/participants/export.csv', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const participants = await qualityParticipantsForStaff(user);
    const rows = [
      ['Nom', 'Prénom', 'Code personnel', 'Date de création', 'Dernière activité', 'Quiz participés'],
      ...participants.map(participant => [
        participant.last_name,
        participant.first_name,
        participant.participant_code,
        participant.created_at,
        participant.last_activity,
        [...new Set((participant.participations || []).map(item => item.quiz_title).filter(Boolean))].join(' | ')
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

  app.patch('/api/quality/participants/:id', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const id = String(req.params.id || '');
    await participantAllowed(id, user);
    const firstName = requiredName(req.body?.first_name, 'Prénom');
    const lastName = requiredName(req.body?.last_name, 'Nom');
    const result = await pool.query(
      `UPDATE app_users SET first_name=$1,last_name=$2 WHERE id=$3
       RETURNING id,first_name,last_name`,
      [firstName, lastName, id]
    );
    res.json(result.rows[0]);
  }));

  app.post('/api/quality/participants/:id/regenerate-code', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const id = String(req.params.id || '');
    await participantAllowed(id, user);
    const code = await generateParticipantCode();
    await pool.query('UPDATE app_users SET participant_code=$1 WHERE id=$2', [code, id]);
    res.json({ participant_code: code });
  }));

  app.post('/api/quality/archives/participant/:id', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const id = String(req.params.id || '');
    await participantAllowed(id, user);
    await pool.query(
      'UPDATE app_users SET archived_at=now(),archived_by=$1 WHERE id=$2',
      [user.id, id]
    );
    res.status(204).end();
  }));
}
