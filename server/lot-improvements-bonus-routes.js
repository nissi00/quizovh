import { crypto, pool, safe, sessionUser, groupForStaff, isUuid, httpError, learnerScoreWithBonus } from './lot-improvements-common.js';

export function registerBonusRoutes(app) {
  app.get('/api/improvements/training-groups/:id/bonuses', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const group = await groupForStaff(req.params.id, user);
    const result = await pool.query('SELECT user_id,bonus_points,updated_at FROM training_group_bonus_points WHERE group_id=$1', [group.id]);
    res.set('Cache-Control', 'no-store').json(result.rows);
  }));

  app.put('/api/improvements/training-groups/:groupId/bonus/:userId', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const group = await groupForStaff(req.params.groupId, user);
    if (!isUuid(req.params.userId)) throw httpError(400, 'Participant invalide.');
    const member = await pool.query('SELECT 1 FROM training_group_participants WHERE group_id=$1 AND user_id=$2', [group.id, req.params.userId]);
    if (!member.rows[0]) throw httpError(404, 'Participant introuvable dans ce groupe.');
    const bonus = Number(req.body?.bonus_points ?? 0);
    if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) throw httpError(400, 'Le bonus doit être compris entre 0 et 100 points.');
    const previous = await pool.query('SELECT bonus_points FROM training_group_bonus_points WHERE group_id=$1 AND user_id=$2', [group.id, req.params.userId]);
    const result = await pool.query(
      `INSERT INTO training_group_bonus_points(group_id,user_id,bonus_points,updated_by,updated_at)
       VALUES($1,$2,$3,$4,now())
       ON CONFLICT(group_id,user_id) DO UPDATE SET bonus_points=EXCLUDED.bonus_points,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING group_id,user_id,bonus_points,updated_at`,
      [group.id, req.params.userId, Math.round(bonus * 100) / 100, user.id]
    );
    if (Number(previous.rows[0]?.bonus_points || 0) !== Number(result.rows[0].bonus_points || 0)) {
      await pool.query(`UPDATE certificates SET status='outdated' WHERE training_group_id=$1 AND user_id=$2 AND status='issued'`, [group.id, req.params.userId]);
    }
    res.json(result.rows[0]);
  }));

  app.post('/api/improvements/training-groups/:groupId/certificates/:userId', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const group = await groupForStaff(req.params.groupId, user);
    if (!isUuid(req.params.userId)) throw httpError(400, 'Participant invalide.');
    const member = await pool.query('SELECT 1 FROM training_group_participants WHERE group_id=$1 AND user_id=$2', [group.id, req.params.userId]);
    if (!member.rows[0]) throw httpError(404, 'Participant introuvable dans ce groupe.');
    if (group.status !== 'finished') throw httpError(409, 'Terminez le groupe avant de délivrer les certificats.');
    const score = await learnerScoreWithBonus(group, req.params.userId);
    if (!score.eligible) throw httpError(409, 'Le score global, bonus inclus, est inférieur au seuil de réussite.');
    const number = `TS-CERT-${new Date().getUTCFullYear()}-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
    const token = crypto.randomBytes(24).toString('base64url');
    const snapshot = JSON.stringify(score);
    const saved = await pool.query(
      `INSERT INTO certificates(training_group_id,user_id,certificate_number,public_token,global_score,status,issued_by,grading_snapshot,logo_asset_id)
       VALUES($1,$2,$3,$4,$5,'issued',$6,$7::jsonb,(SELECT logo_asset_id FROM organization_settings WHERE id=1))
       ON CONFLICT(training_group_id,user_id) DO UPDATE SET
         certificate_number=EXCLUDED.certificate_number,public_token=EXCLUDED.public_token,global_score=EXCLUDED.global_score,
         status='issued',issued_by=EXCLUDED.issued_by,grading_snapshot=EXCLUDED.grading_snapshot,logo_asset_id=EXCLUDED.logo_asset_id,
         issued_at=now(),revoked_at=NULL,archived_at=NULL,archived_by=NULL RETURNING *`,
      [group.id, req.params.userId, number, token, score.global_score, user.id, snapshot]
    );
    res.status(201).json(saved.rows[0]);
  }));
}
