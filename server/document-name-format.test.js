import test from 'node:test';
import assert from 'node:assert/strict';
import { createCertificatesPdf } from './certificate-pdf.js';
import { createCompletionDocumentsPdf } from './completion-attestation-pdf.js';

const participant = { first_name:'Élodie',last_name:'Dupré' };

test('completion documents display only the participant last name in uppercase', () => {
  const pdf = createCompletionDocumentsPdf([{
    attestation_number:'AFF-TEST',participant_snapshot:participant,
    form_snapshot:{training_title:'Formation test',representative_name:'Marie Durand'}
  }]).toString('latin1');

  assert.equal(pdf.match(/Élodie DUPRÉ/g)?.length, 2);
});

test('the result certificate displays only the participant last name in uppercase', () => {
  const pdf = createCertificatesPdf([{
    ...participant,global_score:80,issued_at:'2026-09-30',start_date:'2026-09-21',end_date:'2026-09-25',
    theme_name:'Formation test',group_name:'Groupe test',certificate_number:'CERT-TEST',
    verification_url:'https://example.test/certificate'
  }]).toString('latin1');

  assert.match(pdf,/Élodie DUPRÉ/);
});
