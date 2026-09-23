import express from 'express';
import { registerMultiExamRoutes } from './multi-exam-routes.js';

const previousListen = express.application.listen;
const routeInstalled = Symbol.for('ts.exam.duplicate.routes.installed');

express.application.listen = function patchedExamDuplicateListen(...args) {
  if (!this[routeInstalled]) {
    this[routeInstalled] = true;
    registerMultiExamRoutes(this);
  }
  return previousListen.apply(this, args);
};
