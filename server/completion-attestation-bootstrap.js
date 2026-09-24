import express from 'express';
import { registerCompletionAttestationRoutes } from './completion-attestation-routes.js';

const previousListen = express.application.listen;
const installed = Symbol.for('ts.completionAttestation.routes.installed');

express.application.listen = function patchedCompletionAttestationListen(...args) {
  if (!this[installed]) {
    this[installed] = true;
    registerCompletionAttestationRoutes(this);
  }
  return previousListen.apply(this,args);
};
