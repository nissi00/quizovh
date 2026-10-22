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
  if (!token) throw httpError(401, kind === 'staff' ? 'Connexion instructeur requise.' : 'Session du stagiaire expirée.');
  const result = await pool.query(
    `SELECT u.id,u.first_name,u.last_name,u.participant_code,u.role
     FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
     WHERE s.token_hash=$1 AND s.kind=$2 AND s.expires_at>now() AND u.archived_at IS NULL`,
    [sha256(token), kind]
  );
  const user = result.rows[0];
  if (!user) throw httpError(401, kind === 'staff' ? 'Connexion instructeur requise.' : 'Session du stagiaire expirée.');
  if (kind === 'staff' && !['instructor', 'superadmin'].includes(user.role)) throw httpError(403, 'Accès instructeur requis.');
  if (kind === 'learner' && user.role !== 'learner') throw httpError(403, 'Accès stagiaire requis.');
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


export { crypto };
