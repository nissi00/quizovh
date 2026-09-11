import express from 'express';
import { registerBonusRoutes } from './lot-improvements-bonus-routes.js';
import { registerDisplayRoutes } from './lot-improvements-display-routes.js';

const originalListen = express.application.listen;
const installed = Symbol.for('ts.lot.improvements.routes.installed');

express.application.listen = function patchedLotImprovementsListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerBonusRoutes(this);
    registerDisplayRoutes(this);
  }
  return originalListen.apply(this, args);
};
