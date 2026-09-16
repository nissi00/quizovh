import express from 'express';
import { registerStatisticsRoutes } from './statistics-routes.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.statistics.routes.installed');

express.application.listen = function patchedStatisticsListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerStatisticsRoutes(this);
  }
  return previousListen.apply(this, args);
};
