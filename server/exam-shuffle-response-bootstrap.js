import express from 'express';
import { pool } from './lot-improvements-common.js';

const originalJson = express.response.json;
const installed = Symbol.for('ts.exam.shuffle.response.installed');

async function orderedQuestions(attemptId, questions) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const attemptResult = await client.query(
      `SELECT a.id,a.exam_id,fe.shuffle_questions
       FROM final_exam_attempts a
       JOIN final_exams fe ON fe.id=a.exam_id
       WHERE a.id=$1
       FOR UPDATE OF a`,
      [attemptId]
    );
    const attempt = attemptResult.rows[0];
    if (!attempt?.shuffle_questions) {
      await client.query('COMMIT');
      return questions;
    }

    const existing = await client.query(
      'SELECT count(*)::integer AS count FROM final_exam_attempt_question_order WHERE attempt_id=$1',
      [attemptId]
    );
    if (Number(existing.rows[0]?.count || 0) === 0) {
      await client.query(
        `INSERT INTO final_exam_attempt_question_order(attempt_id,question_id,display_position)
         SELECT $1,q.id,row_number() OVER (ORDER BY random())::integer
         FROM final_exam_questions q
         WHERE q.exam_id=$2
         ON CONFLICT DO NOTHING`,
        [attemptId, attempt.exam_id]
      );
    }

    const orderResult = await client.query(
      `SELECT question_id,display_position
       FROM final_exam_attempt_question_order
       WHERE attempt_id=$1
       ORDER BY display_position`,
      [attemptId]
    );
    await client.query('COMMIT');

    const order = new Map(orderResult.rows.map(row => [row.question_id, Number(row.display_position)]));
    if (!order.size) return questions;
    return [...questions]
      .sort((left, right) => (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER))
      .map((question, index) => ({ ...question, display_position:index + 1 }));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

if (!express.response[installed]) {
  express.response[installed] = true;
  express.response.json = function shuffledExamJson(body) {
    const req = this.req;
    const learnerState = req?.method === 'GET' && /^\/api\/final-exams\/[^/]+\/state$/.test(req.path || '');
    const statisticsDetail = req?.method === 'GET' && (req.path || '') === '/api/statistics/detail' && ['exam','experience_exam'].includes(body?.evaluation?.kind);
    const attemptId = learnerState ? body?.attempt?.id : statisticsDetail ? body?.attempt?.id : null;
    if (!attemptId || !Array.isArray(body?.questions)) return originalJson.call(this, body);

    const response = this;
    orderedQuestions(attemptId, body.questions)
      .then(questions => originalJson.call(response, { ...body, questions }))
      .catch(error => {
        console.error('[exam-shuffle]', error);
        if (!response.headersSent) originalJson.call(response, body);
      });
    return response;
  };
}
