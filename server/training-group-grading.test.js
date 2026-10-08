import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTrainingGroupGrading, weightedGlobalScore } from './training-group-grading.js';

test('une ancienne pondération expérience conserve son score global', () => {
  const policy = normalizeTrainingGroupGrading({
    include_quizzes:true, quiz_weight:50,
    include_exam:true, exam_weight:25,
    include_experience:true, experience_weight:25
  });
  assert.equal(policy.practice_weight, 12.5);
  assert.equal(policy.experience_exam_weight, 12.5);
  assert.equal(weightedGlobalScore(policy, { quizScore:80, practiceScore:80, experienceExamScore:40, examScore:60 }), 70);
});

test('les trois évaluations sont pondérées indépendamment', () => {
  const policy = normalizeTrainingGroupGrading({
    include_quizzes:true, quiz_weight:50,
    include_practice:true, practice_weight:20,
    include_experience_exam:true, experience_exam_weight:10,
    include_exam:true, exam_weight:20
  });
  assert.equal(weightedGlobalScore(policy, { quizScore:80, practiceScore:90, experienceExamScore:40, examScore:50 }), 72);
});

test('le partage d’un ancien poids décimal conserve exactement sa somme', () => {
  const policy = normalizeTrainingGroupGrading({ include_experience:true, experience_weight:33.33 });
  assert.equal(policy.practice_weight + policy.experience_exam_weight, 33.33);
});
