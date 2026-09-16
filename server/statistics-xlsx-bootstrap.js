import express from 'express';
import { registerStatisticsXlsxRoutes } from './statistics-xlsx-routes.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.statistics.xlsx.routes.installed');

express.application.listen = function patchedStatisticsXlsxListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerStatisticsXlsxRoutes(this);
  }
  return previousListen.apply(this, args);
};
