import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consolidateParticipants,
  groupPerformedQuizIds,
  groupQuizAverage,
  identityComponents,
  latestRecord,
  participantIdentityKey
} from './participant-consolidation.js';

test('six profiles including two duplicate pairs become four learners', () => {
  const rows = [
    { id:'1',first_name:'Benjamin',last_name:'Fara',participant_code:'TS-AAAA',created_at:'2026-09-01' },
    { id:'2',first_name:' benjamin ',last_name:'FARA',participant_code:'TS-BBBB',created_at:'2026-09-02' },
    { id:'3',first_name:'Maxime',last_name:'Hott',participant_code:'TS-CCCC',created_at:'2026-09-01' },
    { id:'4',first_name:'MAXIME',last_name:'Hótt',participant_code:'TS-DDDD',created_at:'2026-09-03' },
    { id:'5',first_name:'Alice',last_name:'Martin',participant_code:'TS-EEEE',created_at:'2026-09-01' },
    { id:'6',first_name:'Karim',last_name:'Diallo',participant_code:'TS-FFFF',created_at:'2026-09-01' }
  ];
  const learners = consolidateParticipants(rows);
  assert.equal(learners.length, 4);
  const benjamin = learners.find(item => participantIdentityKey(item) === participantIdentityKey(rows[0]));
  assert.equal(benjamin.id, '1');
  assert.equal(benjamin.participant_code, 'TS-AAAA');
  assert.deepEqual(benjamin.profile_ids, ['1','2']);
});

test('identical names are only merged in the registry when they share a group', () => {
  const rows = [
    { id:'1',first_name:'Alex',last_name:'Martin',created_at:'2026-09-01',group_ids:['g1'] },
    { id:'2',first_name:'Alex',last_name:'Martin',created_at:'2026-09-02',group_ids:['g1'] },
    { id:'3',first_name:'Alex',last_name:'Martin',created_at:'2026-09-03',group_ids:['g2'] }
  ];
  const learners = identityComponents(rows);
  assert.equal(learners.length, 2);
  assert.deepEqual(learners.find(item => item.id === '1').profile_ids, ['1','2']);
});

test('the latest completed evaluation wins when duplicate profiles share an evaluation', () => {
  const selected = latestRecord([
    { id:'old',submitted_at:'2026-09-20T10:00:00Z',score:40 },
    { id:'new',submitted_at:'2026-09-21T10:00:00Z',score:80 }
  ], ['submitted_at']);
  assert.equal(selected.id, 'new');
  assert.equal(selected.score, 80);
});

test('quiz averages use every quiz performed by the group and exclude untouched quizzes', () => {
  const attempts = Array.from({ length:7 }, (_, index) => ({
    user_id:'learner-a',quiz_id:`quiz-${index + 1}`
  }));
  const performedQuizIds = groupPerformedQuizIds(attempts, []);
  const learnerWithFourAttempts = Array.from({ length:8 }, (_, index) => ({
    quiz_id:`quiz-${index + 1}`,
    score:index < 4 ? 100 : 0
  }));

  assert.equal(performedQuizIds.size, 7);
  assert.equal(groupQuizAverage(learnerWithFourAttempts, performedQuizIds), 57.14);
});

test('a manual quiz score makes the quiz count as performed for the group', () => {
  const performedQuizIds = groupPerformedQuizIds([], [{ evaluation_key:'quiz:quiz-1' }]);
  assert.deepEqual([...performedQuizIds], ['quiz-1']);
  assert.equal(groupQuizAverage([
    { quiz_id:'quiz-1',score:80 },
    { quiz_id:'quiz-2',score:0 }
  ], performedQuizIds), 80);
});
