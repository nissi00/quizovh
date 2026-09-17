import express from 'express';
import { pool } from './lot-improvements-common.js';
import { registerMultiExamRoutes } from './multi-exam-routes.js';

const previousListen = express.application.listen;
const routeInstalled = Symbol.for('ts.multi.exam.routes.installed');
const responseInstalled = Symbol.for('ts.multi.exam.response.installed');
const originalJson = express.response.json;

const round2 = value => Math.round(Number(value || 0) * 100) / 100;

async function enrichTrainingGroupResults(body) {
  const groupId = body?.group?.id;
  const participants = Array.isArray(body?.participants) ? body.participants : [];
  if (!groupId || !participants.length && !body?.group) return body;

  const examsResult = await pool.query(
    `SELECT id,title,status,created_at
     FROM final_exams
     WHERE group_id=$1 AND archived_at IS NULL
     ORDER BY created_at,id`,
    [groupId]
  );
  const exams = examsResult.rows;
  const examIds = exams.map(exam => exam.id);
  let attemptRows = [];

  if (examIds.length) {
    const attemptsResult = await pool.query(
      `SELECT DISTINCT ON (a.exam_id,a.user_id)
        a.exam_id,a.user_id,a.score_percent,a.submitted_at,a.started_at
       FROM final_exam_attempts a
       WHERE a.exam_id=ANY($1::uuid[]) AND a.archived_at IS NULL
       ORDER BY a.exam_id,a.user_id,(a.submitted_at IS NOT NULL) DESC,
         COALESCE(a.submitted_at,a.started_at) DESC,a.started_at DESC`,
      [examIds]
    );
    attemptRows = attemptsResult.rows;
  }

  const attempts = new Map(attemptRows.map(item => [`${item.user_id}:${item.exam_id}`, item]));
  const policy = body.policy || {};

  const enrichedParticipants = participants.map(participant => {
    const examScores = exams.map((exam, index) => {
      const attempt = attempts.get(`${participant.id}:${exam.id}`) || null;
      const submitted = Boolean(attempt?.submitted_at);
      return {
        exam_id: exam.id,
        title: exam.title,
        position: index + 1,
        status: exam.status,
        submitted,
        score: submitted ? Number(attempt?.score_percent || 0) : 0
      };
    });
    const examScore = examScores.length
      ? round2(examScores.reduce((sum, item) => sum + Number(item.score || 0), 0) / examScores.length)
      : 0;
    const completedCount = examScores.filter(item => item.submitted).length;
    const quizScore = Number(participant.quiz_score || 0);
    const experienceScore = Number(participant.experience_score || 0);
    const globalScore = round2((
      (policy.include_quizzes ? quizScore * Number(policy.quiz_weight || 0) : 0) +
      (policy.include_exam ? examScore * Number(policy.exam_weight || 0) : 0) +
      (policy.include_experience ? experienceScore * Number(policy.experience_weight || 0) : 0)
    ) / 100);

    return {
      ...participant,
      exam_scores: examScores,
      exam_score: examScore,
      exam_count: examScores.length,
      exam_completed_count: completedCount,
      exam_submitted: examScores.length > 0 && completedCount === examScores.length,
      global_score: globalScore,
      eligible: globalScore >= Number(body.group?.passing_score || 0)
    };
  });

  return {
    ...body,
    final_exam: exams[0] || null,
    final_exams: exams.map((exam, index) => ({ ...exam, position:index + 1 })),
    participants: enrichedParticipants
  };
}

if (!express.response[responseInstalled]) {
  express.response[responseInstalled] = true;
  express.response.json = function multiExamJson(body) {
    const req = this.req;
    const path = req?.path || '';
    const target = req?.method === 'GET' && /^\/api\/training-groups\/[^/]+\/results$/.test(path);
    if (!target || !body?.group) return originalJson.call(this, body);

    const response = this;
    enrichTrainingGroupResults(body)
      .then(payload => originalJson.call(response, payload))
      .catch(error => {
        console.error('[multi-exam-results]', error);
        if (!response.headersSent) originalJson.call(response, body);
      });
    return response;
  };
}

express.application.listen = function patchedMultiExamListen(...args) {
  if (!this[routeInstalled]) {
    this[routeInstalled] = true;
    registerMultiExamRoutes(this);
  }
  return previousListen.apply(this, args);
};
