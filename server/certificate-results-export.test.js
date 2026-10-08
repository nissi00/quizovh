import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrainingResultsPdf,createTrainingResultsXlsx } from './certificate-results-export.js';

function fixture() {
  const quizzes = Array.from({length:7},(_,index) => ({id:`quiz-${index + 1}`,chapter_title:`Chapitre complet ${index + 1}`}));
  return {
    group:{name:'Groupe test',theme_name:'Formation test',passing_score:70},
    policy:{include_quizzes:true,quiz_weight:50,include_practice:true,practice_weight:12.5,include_experience_exam:true,experience_exam_weight:12.5,include_exam:true,exam_weight:25},
    quizzes,
    participants:[{
      id:'11111111-1111-1111-1111-111111111111',first_name:'Élodie',last_name:'Dupré',participant_code:'TS-TEST',
      quiz_scores:quizzes.map((quiz,index) => ({quiz_id:quiz.id,score:70 + index,taken:index !== 6,manual_override:index === 1 ? {score_percent:71} : null})),
      quiz_score:72,practice_score:80,experience_count:1,practice_manual_override:null,
      experience_exam_score:75,experience_exam_submitted:true,experience_exam_manual_override:null,
      exam_score:85,exam_submitted:true,exam_manual_override:null,global_score:77,eligible:true,
      certificate:{status:'issued'},comment:'Participation sérieuse et régulière.'
    }]
  };
}

test('certificate results PDF splits quiz columns by groups of five and includes comments', () => {
  const pdf = createTrainingResultsPdf(fixture()).toString('latin1');
  assert.match(pdf,/^%PDF-1\.4/);
  assert.ok((pdf.match(/\/Type \/Page /g) || []).length >= 4);
  assert.match(pdf,/Participation sérieuse et régulière\./);
  assert.match(pdf,/Chapitre complet 7/);
  assert.doesNotMatch(pdf,/Note Exp\./);
});

test('certificate results Excel contains every result column and the saved comment', () => {
  const workbook = createTrainingResultsXlsx(fixture()).toString('utf8');
  assert.match(workbook,/PK/);
  assert.match(workbook,/Chapitre complet 7/);
  assert.match(workbook,/Statut du certificat/);
  assert.match(workbook,/Participation sérieuse et régulière\./);
  assert.doesNotMatch(workbook,/Note Expérience/);
});
