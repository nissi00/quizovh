import express from 'express';
import { registerQualityRoutes } from './quality-routes.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.quality.routes.installed');

express.application.listen = function patchedQualityListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerQualityRoutes(this);
  }
  return previousListen.apply(this, args);
};
