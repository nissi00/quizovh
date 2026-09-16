import express from 'express';
import { registerExamAttemptArchiveRoutes } from './exam-attempt-archive-routes.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.exam.attempt.archive.routes.installed');

express.application.listen = function patchedExamAttemptArchiveListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerExamAttemptArchiveRoutes(this);
  }
  return previousListen.apply(this, args);
};
