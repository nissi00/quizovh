import { rateLimit } from 'express-rate-limit';
import { pool, safe, httpError } from './lot-improvements-common.js';

const examPresentationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 500,
  standardHeaders: 'draft-8',
  legacyHeaders: false
});

export function registerQualityExamRoutes(app) {
  app.get('/api/quality/presentation/exam', examPresentationLimiter, safe(async (req, res) => {
    const code = String(req.query?.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(code)) throw httpError(400, 'Code d’examen invalide.');
    const result = await pool.query(
      `SELECT fe.code,fe.title,fe.duration_minutes,fe.status,tg.name AS group_name,t.name AS theme_name
       FROM final_exams fe JOIN training_groups tg ON tg.id=fe.group_id JOIN themes t ON t.id=tg.theme_id
       WHERE fe.code=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
      [code]
    );
    if (!result.rows[0]) throw httpError(404, 'Examen final introuvable.');
    res.set('Cache-Control', 'no-store').json(result.rows[0]);
  }));
}
