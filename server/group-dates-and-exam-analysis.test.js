import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import pg from 'pg';
import { consolidateParticipants, consolidatedParticipantId, latestRecord } from './participant-consolidation.js';

const server = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8');
const statistics = fs.readFileSync(new URL('./statistics-routes.js', import.meta.url), 'utf8');
const client = fs.readFileSync(new URL('../statistics.js', import.meta.url), 'utf8');
const groupId = '11111111-1111-4111-8111-111111111111';
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };

function between(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, 'source block exists');
  return source.slice(first, last);
}

function groupRoute(hasResults = false) {
  let handler;
  const updates = [];
  const parseDate = pg.types.getTypeParser(1082, 'text');
  const group = { id:groupId, has_results:hasResults, start_date:parseDate('2027-02-25'), end_date:parseDate('2027-02-27') };
  vm.runInNewContext(between(server, "app.patch('/api/training-groups/:id',", "app.get('/api/training-groups/:id/results',"), {
    Date, fail, assertUuid:value => value, requiredText:value => value,
    app:{ patch:(_path, _auth, route) => { handler = route; } },
    requireStaff:() => {}, asyncRoute:route => route,
    trainingGroupForStaff:async () => group,
    pool:{ query:async (sql, values) => { updates.push({ sql, values:Array.from(values) }); return { rowCount:1 }; } }
  });
  return async body => {
    updates.length = 0;
    const response = { statusCode:200, status(code) { this.statusCode = code; return this; }, end() {} };
    try {
      await handler({ params:{ id:groupId }, user:{ id:groupId, role:'instructor' }, body }, response);
      return { status:response.statusCode, updates:[...updates] };
    } catch (error) {
      return { status:error.status, message:error.message, updates:[...updates] };
    }
  };
}

async function inTimezones(run) {
  const previous = process.env.TZ;
  try {
    for (const timezone of ['UTC', 'Europe/Paris', 'America/New_York']) {
      process.env.TZ = timezone;
      await run(timezone);
    }
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('g3 can change state without changing its dates, including when results lock the dates', async () => {
  await inTimezones(async timezone => {
    const patch = groupRoute(true);
    for (const status of ['active', 'finished']) {
      const result = await patch({ status });
      assert.equal(result.status, 204, `${timezone}: ${status}`);
      assert.equal(result.updates.length, 1);
      assert.deepEqual(result.updates[0].values, [status, groupId]);
    }
  });
});

test('editing one date preserves the stored calendar day and still rejects reversed periods', async () => {
  await inTimezones(async timezone => {
    const patch = groupRoute();
    for (const [body, expected] of [
      [{ start_date:'2027-02-27' }, 204],
      [{ end_date:'2027-02-25' }, 204],
      [{ start_date:'2027-02-28' }, 400],
      [{ end_date:'2027-02-24' }, 400],
      [{ start_date:'2027-02-26', end_date:'2027-02-25' }, 400]
    ]) {
      const result = await patch(body);
      assert.equal(result.status, expected, `${timezone}: ${JSON.stringify(body)}`);
      assert.equal(result.updates.length, expected === 204 ? 1 : 0);
    }
  });
});

test('date edits remain locked after results and invalid group states are still rejected', async () => {
  const locked = await groupRoute(true)({ start_date:'2027-02-26' });
  assert.equal(locked.status, 409);
  assert.equal(locked.updates.length, 0);
  const invalid = await groupRoute()({ status:'unknown' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.updates.length, 0);
});

async function review(rows, examType) {
  const responses = [
    [{ id:'exam', exam_type:examType, question_count:rows.length, total_points:rows.length }], [], rows
  ];
  const ctx = vm.createContext({
    Date, consolidateParticipants, consolidatedParticipantId, latestRecord,
    httpError:(status, message) => Object.assign(new Error(message), { status }),
    pool:{ query:async () => { assert.ok(responses.length); return { rows:responses.shift() }; } }
  });
  vm.runInContext(
    between(statistics, 'const asNumber', 'async function consolidatedLearner(') +
    between(statistics, 'async function examParticipantResults(', 'async function quizDetail('), ctx
  );
  return ctx.examParticipantResults('exam', examType);
}

function renderReview(result, kind) {
  const ctx = vm.createContext({ result, kind });
  vm.runInContext(
    client.slice(0, client.indexOf('async function statsApi(')) +
    between(client, 'function examQuestionReview(', 'function evaluationSummary('), ctx
  );
  return vm.runInContext('stats.kind=kind; stats.result=result; examQuestionReview()', ctx);
}

test('both exam types show a gray card for one unanswered copy and two cards for a mixed question', async () => {
  const rows = [
    { id:'correct', body:'Question correcte', answered_count:3, incorrect_count:0, unanswered_count:0 },
    { id:'gray', body:'Question avec une absence', answered_count:2, incorrect_count:0, unanswered_count:1 },
    { id:'mixed', body:'Question mixte', answered_count:2, incorrect_count:1, unanswered_count:1 },
    { id:'red', body:'Question avec erreurs', answered_count:3, incorrect_count:2, unanswered_count:0 },
    { id:'empty', body:'Question sans réponses', answered_count:0, incorrect_count:0, unanswered_count:3 }
  ];
  for (const [examType, kind] of [['final', 'exam'], ['experience', 'experience_exam']]) {
    const result = await review(rows, examType);
    assert.deepEqual(Array.from(result.questions_to_review, row => `${row.id}:${row.status}`), [
      'gray:unanswered', 'mixed:incorrect', 'mixed:unanswered', 'red:incorrect', 'empty:unanswered'
    ]);
    const html = renderReview(result, kind);
    assert.equal((html.match(/statistics-review-item is-unanswered/g) || []).length, 3);
    assert.equal((html.match(/statistics-review-item is-incorrect/g) || []).length, 2);
    assert.equal((html.match(/Question mixte/g) || []).length, 2);
    assert.match(html, />1 sans réponse</);
    assert.match(html, />3 sans réponse</);
    assert.match(html, />1 mauvaise réponse</);
    assert.match(html, />2 mauvaises réponses</);
    assert.doesNotMatch(html, /Question correcte/);
  }
});

test('an exam without copies creates no fictitious unanswered card', async () => {
  const result = await review([{ id:'question', body:'Question', answered_count:0, incorrect_count:0, unanswered_count:0 }], 'final');
  assert.equal(result.questions_to_review.length, 0);
  assert.match(renderReview(result, 'exam'), /Aucune question à revoir sur les copies enregistrées\./);
});
