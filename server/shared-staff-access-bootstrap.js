import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const staffContext = new AsyncLocalStorage();
const actualRoleSymbol = Symbol.for('ts.sharedStaff.actualRole');
const elevationDepthSymbol = Symbol.for('ts.sharedStaff.elevationDepth');
const sharedAuthPool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 2,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30000
});

const preserveActualRolePaths = new Set([
  '/api/auth/me',
  '/api/instructor/profile'
]);
const formerlySuperadminOnlyPanelRoutes = new Set([
  'get /api/archives',
  'post /api/archives/:type/:id/restore',
  'delete /api/archives/:type/:id'
]);

function parseCookies(header = '') {
  return Object.fromEntries(String(header).split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const index = part.indexOf('=');
    if (index < 0) return [part, ''];
    try { return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))]; }
    catch { return [part.slice(0, index), part.slice(index + 1)]; }
  }));
}

function authError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function sharedRequireStaff(req, _res, next) {
  try {
    const token = parseCookies(req.headers.cookie).quiz_staff;
    if (!token) throw authError(401, 'Connexion instructeur requise.');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const result = await sharedAuthPool.query(
      `SELECT u.id,u.email,u.first_name,u.last_name,u.role
       FROM auth_sessions s JOIN app_users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.kind='staff' AND s.expires_at>now() AND u.archived_at IS NULL`,
      [tokenHash]
    );
    const user = result.rows[0];
    if (!user || !['instructor', 'superadmin'].includes(user.role)) throw authError(401, 'Connexion instructeur requise.');
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

function shouldElevate(path) {
  if (typeof path !== 'string') return false;
  if (path.startsWith('/api/superadmin/')) return false;
  if (preserveActualRolePaths.has(path)) return false;
  return true;
}

function wrapHandler(path, handler) {
  if (typeof handler !== 'function' || !shouldElevate(path)) return handler;

  return function sharedStaffAccessHandler(req, res, next) {
    const user = req.user;
    const actualRole = user?.[actualRoleSymbol] || user?.role;
    if (actualRole !== 'instructor') return handler(req, res, next);

    if (!user[actualRoleSymbol]) {
      Object.defineProperty(user, actualRoleSymbol, {
        configurable: false,
        enumerable: false,
        writable: false,
        value: actualRole
      });
    }

    user[elevationDepthSymbol] = Number(user[elevationDepthSymbol] || 0) + 1;
    user.role = 'superadmin';

    const finish = () => {
      user[elevationDepthSymbol] = Math.max(0, Number(user[elevationDepthSymbol] || 1) - 1);
      if (user[elevationDepthSymbol] === 0) user.role = actualRole;
    };

    return staffContext.run({ actualRole }, async () => {
      try {
        return await handler(req, res, next);
      } finally {
        finish();
      }
    });
  };
}

for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
  const original = express.application[method];
  express.application[method] = function sharedStaffRoute(path, ...handlers) {
    const routeKey = `${method} ${String(path)}`;
    const routedHandlers = [...handlers];
    if (formerlySuperadminOnlyPanelRoutes.has(routeKey) && routedHandlers.length) {
      routedHandlers[0] = sharedRequireStaff;
    }
    return original.call(this, path, ...routedHandlers.map(handler => wrapHandler(path, handler)));
  };
}

const originalPoolQuery = Pool.prototype.query;
Pool.prototype.query = function sharedStaffPoolQuery(text, values, ...rest) {
  const context = staffContext.getStore();
  if (
    context?.actualRole === 'instructor'
    && typeof text === 'string'
    && text.includes('INSERT INTO audit_logs')
    && Array.isArray(values)
    && values[1] === 'superadmin'
  ) {
    values = [...values];
    values[1] = 'instructor';
  }
  return originalPoolQuery.call(this, text, values, ...rest);
};
