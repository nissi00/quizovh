import express from 'express';
import { registerExamReviewRoutes } from './exam-review-routes.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.exam.review.routes.installed');

express.application.listen = function patchedExamReviewListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerExamReviewRoutes(this);
  }
  return previousListen.apply(this, args);
};
