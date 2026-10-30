import test from 'node:test';
import assert from 'node:assert/strict';
import { getSurveyQuestionnaire, surveyQuestionnaires } from '../survey-questionnaires.js';
import { normalizeSurveyAnswers, surveyCsv } from './survey-answers.js';

function complete(type) {
  const questionnaire = getSurveyQuestionnaire(type);
  return Object.fromEntries([...questionnaire.fields, ...questionnaire.questions].flatMap(item => {
    const value = item.type === 'date' ? '2026-10-30'
      : item.type === 'multiple' ? [item.options[0]]
      : item.options ? item.options[0]
      : item.required ? 'Texte renseigné' : '';
    return [[item.id, value], ...(item.otherKey ? [[item.otherKey, '']] : [])];
  }));
}

test('all five questionnaire types accept their complete answers independently', () => {
  assert.deepEqual(Object.keys(surveyQuestionnaires), ['trainee', 'client', 'follow_up', 'trainer', 'opco']);
  for (const type of Object.keys(surveyQuestionnaires)) {
    const result = normalizeSurveyAnswers(type, complete(type));
    assert.ok(Object.keys(result).length > 10, type);
  }
});

test('legacy trainee survey keeps its 16 answer keys, rating range and anonymity', () => {
  const questionnaire = getSurveyQuestionnaire();
  assert.equal(questionnaire.questions.length, 16);
  assert.equal(questionnaire.fields.length, 0);
  assert.equal(questionnaire.anonymous, true);
  assert.deepEqual(Object.keys(normalizeSurveyAnswers('trainee', { ...complete('trainee'), learner_name:'Ignored', contact_name:'Ignored', hidden:'Ignored' })), [
    'organization_information', 'organization_schedule', 'organization_facilities',
    'content_expectations', 'content_theory', 'content_exercises', 'content_materials',
    'trainer_mastery', 'trainer_availability', 'trainer_exercises', 'trainer_dynamics',
    'objectives_achieved', 'objectives_apply', 'recommendation', 'strengths', 'improvements'
  ]);
  for (const recommendation of [0,11,2.5,'invalid',null]) {
    assert.throws(() => normalizeSurveyAnswers('trainee', { ...complete('trainee'), recommendation }), { status:400 });
  }
  assert.equal(normalizeSurveyAnswers('trainee', { ...complete('trainee'), recommendation:'10' }).recommendation, 10);
});

test('each survey validates its own questionnaire and rejects foreign or incomplete answers', () => {
  assert.throws(() => normalizeSurveyAnswers('client', complete('trainee')), { status:400 });
  assert.throws(() => normalizeSurveyAnswers('opco', { ...complete('opco'), opco_name:' ' }), { status:400 });
  assert.throws(() => normalizeSurveyAnswers('follow_up', { ...complete('follow_up'), interviewer_name:'' }), { status:400 });
  assert.throws(() => normalizeSurveyAnswers('trainer', { ...complete('trainer'), employment_status:'Other' }), { status:400 });
  for (const type of ['missing','__proto__', ['client'], null, 5]) assert.equal(getSurveyQuestionnaire(type), null);
});

test('annual evaluation periods reject reversed and nonexistent dates', () => {
  for (const type of ['trainer','opco']) {
    assert.throws(() => normalizeSurveyAnswers(type, { ...complete(type), period_start:'2026-11-01', period_end:'2026-10-30' }), { status:400 });
    assert.throws(() => normalizeSurveyAnswers(type, { ...complete(type), period_start:'2026-02-30' }), { status:400 });
    assert.throws(() => normalizeSurveyAnswers(type, { ...complete(type), period_end:'30/10/2026' }), { status:400 });
    assert.equal(normalizeSurveyAnswers(type, complete(type)).period_end, '2026-10-30');
  }
});

test('follow-up supports multiple selections, exclusive choices and required other details', () => {
  const answers = { ...complete('follow_up'), barriers:['Manque de moyens','Manque de pratique','Autre','Manque de pratique'], barriers_other:'Un outil adapté' };
  const normalized = normalizeSurveyAnswers('follow_up', answers);
  assert.deepEqual(normalized.barriers, ['Manque de pratique','Manque de moyens','Autre']);
  assert.equal(normalized.barriers_other, 'Un outil adapté');
  for (const barriers of [[], 'Manque de moyens', ['Unknown'], ['Aucune difficulté','Manque de moyens'], ['Autre']]) {
    assert.throws(() => normalizeSurveyAnswers('follow_up', { ...complete('follow_up'), barriers }), { status:400 });
  }
  assert.throws(() => normalizeSurveyAnswers('follow_up', { ...complete('follow_up'), additional_needs:['Non','Exercices pratiques'] }), { status:400 });
});

test('conditional follow-up example and stale other details are omitted when not applicable', () => {
  const result = normalizeSurveyAnswers('follow_up', { ...complete('follow_up'), application_frequency:'Pas encore', application_example:'Stale example', barriers_other:'Stale detail' });
  assert.equal(Object.hasOwn(result, 'application_example'), false);
  assert.equal(result.barriers_other, '');
});

test('free comments stay optional and long text is rejected before saving', () => {
  for (const type of Object.keys(surveyQuestionnaires)) {
    const answers = complete(type);
    for (const item of getSurveyQuestionnaire(type).questions.filter(item => item.type==='text')) delete answers[item.id];
    assert.doesNotThrow(() => normalizeSurveyAnswers(type, answers));
    const comment = getSurveyQuestionnaire(type).questions.find(item => item.type==='text');
    assert.throws(() => normalizeSurveyAnswers(type, { ...answers, [comment.id]:'x'.repeat(2001) }), { status:400 });
  }
});

test('CSV includes the correct identity and multi-choice columns without mixing questionnaires', () => {
  const answers = normalizeSurveyAnswers('follow_up', { ...complete('follow_up'), learner_name:'Alice "Test"', barriers:['Manque de pratique','Autre'], barriers_other:'Outil\nspécifique' });
  const csv = surveyCsv('follow_up', [{ answers }]);
  assert.ok(csv.startsWith('\uFEFF"Réponse";"Date de l’entretien";"Nom et prénom du stagiaire"'));
  assert.ok(csv.includes('"Alice ""Test"""'));
  assert.ok(csv.includes('"Manque de pratique | Autre"'));
  assert.ok(csv.includes('"Outil spécifique"'));
  assert.ok(!csv.includes('Réactivité et disponibilité de nos équipes'));
  const legacy = surveyCsv('trainee', [{ answers:complete('trainee') }]);
  assert.ok(!legacy.includes('Nom du contact'));
  assert.ok(legacy.includes('"Points forts de la formation";"Axes d\'amélioration ou remarques complémentaires"'));
});

test('new questionnaire CSV exports keep spreadsheet formulas as literal text', () => {
  const csv = surveyCsv('client', [{ answers:{ ...complete('client'), contact_name:'=1+1', comments:'@SUM(1;2)' } }]);
  assert.ok(csv.includes('"\'=1+1"'));
  assert.ok(csv.includes('"\'@SUM(1;2)"'));
});
