import crypto from 'node:crypto';
import { pool, safe, sessionUser, isUuid, httpError, groupForStaff } from './lot-improvements-common.js';

const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function generateExamCode(client) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const bytes = crypto.randomBytes(8);
    const code = Array.from(bytes, byte => alphabet[byte % alphabet.length]).join('');
    const existing = await client.query('SELECT 1 FROM final_exams WHERE code=$1', [code]);
    if (!existing.rows[0]) return code;
  }
  throw httpError(500, 'Impossible de générer un code d’examen unique.');
}

async function withTransaction(handler) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function registerMultiExamRoutes(app) {
  app.post('/api/quality/final-exams/:id/duplicate', safe(async (req, res) => {
    const user = await sessionUser(req, 'staff');
    const sourceId = String(req.params.id || '');
    if (!isUuid(sourceId)) throw httpError(400, 'Examen invalide.');

    const created = await withTransaction(async client => {
      const sourceResult = await client.query(
        `SELECT fe.id,fe.group_id,fe.title,fe.instructions,fe.duration_minutes,fe.exam_type
         FROM final_exams fe
         JOIN training_groups tg ON tg.id=fe.group_id
         WHERE fe.id=$1 AND fe.archived_at IS NULL AND tg.archived_at IS NULL
           AND ($2::boolean OR tg.instructor_id=$3)
         FOR UPDATE OF fe`,
        [sourceId, user.role === 'superadmin', user.id]
      );
      const source = sourceResult.rows[0];
      if (!source) throw httpError(404, 'Examen introuvable.');

      const requestedTitle = String(req.body?.title || `${source.title} - Copie`).trim();
      const targetGroupId = String(req.body?.group_id || source.group_id);
      if (!isUuid(targetGroupId)) throw httpError(400, 'Groupe de formation invalide.');
      await groupForStaff(targetGroupId, user);
      if (!requestedTitle) throw httpError(400, 'Titre de l’examen requis.');
      if (requestedTitle.length > 250) throw httpError(400, 'Titre de l’examen trop long.');

      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${targetGroupId}:${source.exam_type}`]);
      const existing = await client.query(
        `SELECT id FROM final_exams
         WHERE group_id=$1 AND exam_type=$2 AND archived_at IS NULL
         LIMIT 1`,
        [targetGroupId, source.exam_type]
      );
      if (existing.rows[0]) throw httpError(409, source.exam_type === 'experience'
        ? 'Ce groupe possède déjà son examen Expérience.'
        : 'Ce groupe possède déjà son examen final.');

      const code = await generateExamCode(client);
      const examResult = await client.query(
        `INSERT INTO final_exams(group_id,exam_type,code,title,instructions,duration_minutes,status,created_by,shuffle_questions)
         VALUES($1,$2,$3,$4,$5,$6,'draft',$7,false)
         RETURNING id,group_id,exam_type,code,title,instructions,duration_minutes,status,shuffle_questions,created_at`,
        [targetGroupId, source.exam_type, code, requestedTitle, source.instructions, source.duration_minutes, user.id]
      );
      const exam = examResult.rows[0];

      const questionsResult = await client.query(
        `SELECT id,body,points,position
         FROM final_exam_questions
         WHERE exam_id=$1
         ORDER BY position,id`,
        [sourceId]
      );

      for (const question of questionsResult.rows) {
        const copiedQuestion = await client.query(
          `INSERT INTO final_exam_questions(exam_id,body,points,position)
           VALUES($1,$2,$3,$4)
           RETURNING id`,
          [exam.id, question.body, question.points, question.position]
        );
        await client.query(
          `INSERT INTO final_exam_options(question_id,label,body,is_correct)
           SELECT $1,label,body,is_correct
           FROM final_exam_options
           WHERE question_id=$2
           ORDER BY label`,
          [copiedQuestion.rows[0].id, question.id]
        );
      }

      await client.query(
        `UPDATE certificates
         SET status='outdated'
         WHERE training_group_id=$1 AND status='issued' AND archived_at IS NULL`,
        [targetGroupId]
      );

      return { ...exam, question_count: questionsResult.rows.length, source_exam_id: sourceId };
    });

    res.status(201).json(created);
  }));
}
