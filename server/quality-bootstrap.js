import express from 'express';
import { registerQualityRoutes, presentationState, closeExpiredQuestions } from './quality-routes.js';
import { registerQualityExamRoutes } from './quality-exam-routes.js';
import { registerParticipantQualityRoutes } from './participant-quality-routes.js';
import { registerPresentationStreamRoutes } from './presentation-stream.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.quality.routes.installed');

express.application.listen = function patchedQualityListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerQualityRoutes(this);
    registerQualityExamRoutes(this);
    registerParticipantQualityRoutes(this);
    registerPresentationStreamRoutes(this, { presentationState, closeExpiredQuestions });
  }
  return previousListen.apply(this, args);
};
