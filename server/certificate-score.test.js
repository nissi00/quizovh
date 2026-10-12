import test from 'node:test';
import assert from 'node:assert/strict';
import { certificateScoreSnapshot } from './certificate-score.js';
import { createCertificatesPdf } from './certificate-pdf.js';

const results = {group:{passing_score:70},policy:{quiz_weight:11,practice_weight:67,experience_exam_weight:11,exam_weight:11},performed_quiz_count:6};
const learner = {
  id:'canonical',profile_ids:['canonical','duplicate'],global_score:73.75,
  quiz_score:35.64,practice_score:85.75,experience_exam_score:67.5,
  experience_exam_submitted:true,exam_score:45,
  // Nine displayed quiz columns must not trigger a new nine-quiz average.
  quiz_scores:[0,57.14,16.67,42.86,57.14,40,0,0,0].map((score,index) => ({quiz_id:`q${index}`,score}))
};

test('certificate keeps the consolidated table score and existing double rounding', () => {
  const score = certificateScoreSnapshot(results,learner);
  assert.equal(score.quiz_score,35.64);
  assert.equal(score.global_score,73.75);
  assert.equal(score.global_score.toFixed(1),'73.8');
  assert.equal(score.performed_quiz_count,6);
  assert.deepEqual(score.quiz_scores,learner.quiz_scores);
});

test('certificate uses the table bonus, canonical profile and 100 percent cap', () => {
  const score = certificateScoreSnapshot(results,learner,'5.50');
  assert.equal(score.global_score,79.25);
  assert.equal(score.canonical_user_id,'canonical');
  assert.deepEqual(score.profile_ids,['canonical','duplicate']);
  assert.equal(certificateScoreSnapshot(results,learner,50).global_score,100);
});

test('eligibility uses the same score including bonus as the table', () => {
  assert.equal(certificateScoreSnapshot(results,{...learner,global_score:69},0).eligible,false);
  assert.equal(certificateScoreSnapshot(results,{...learner,global_score:69},1).eligible,true);
});

test('generated PDF displays the table score at one decimal', () => {
  const score = certificateScoreSnapshot(results,learner);
  const pdf = createCertificatesPdf([{
    ...score,first_name:'Alex',last_name:'Martin',issued_at:'2026-10-12',start_date:'2026-10-01',end_date:'2026-10-10',
    theme_name:'Formation',group_name:'Groupe',certificate_number:'CERT-TEST',
    verification_url:'https://example.test/certificate'
  }]).toString('latin1');
  assert.match(pdf,/Score global : 73,8 %/);
});
