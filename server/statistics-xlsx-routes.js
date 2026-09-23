import { pool, safe, sessionUser, isUuid, httpError } from './lot-improvements-common.js';

const xmlEscape = value => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const safeSheetName = (value, fallback, used) => {
  const base = String(value || fallback || 'Feuille').replace(/[\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || fallback;
  let name = base;
  let index = 2;
  while (used.has(name)) {
    const suffix = ` ${index++}`;
    name = `${base.slice(0, Math.max(1, 31 - suffix.length))}${suffix}`;
  }
  used.add(name);
  return name;
};

const columnName = index => {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
};

function worksheetXml(rows) {
  const normalized = Array.isArray(rows) ? rows : [];
  const columnCount = normalized.reduce((max, row) => Math.max(max, Array.isArray(row) ? row.length : 0), 0);
  const widths = Array.from({ length:columnCount }, (_, columnIndex) => {
    const longest = normalized.reduce((max, row) => {
      const value = Array.isArray(row) ? row[columnIndex] : '';
      return Math.max(max, String(value ?? '').length);
    }, 0);
    return Math.min(45, Math.max(10, longest + 2));
  });
  const cols = widths.length
    ? `<cols>${widths.map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`).join('')}</cols>`
    : '';
  const sheetRows = normalized.map((row, rowIndex) => {
    const cells = (Array.isArray(row) ? row : []).map((value, columnIndex) => {
      const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
      if (typeof value === 'number' && Number.isFinite(value)) {
        return `<c r="${ref}"${rowIndex === 0 ? ' s="1"' : ''}><v>${value}</v></c>`;
      }
      const text = xmlEscape(value ?? '');
      return `<c r="${ref}" t="inlineStr"${rowIndex === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${text}</t></is></c>`;
    }).join('');
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join('');
  const filter = normalized.length > 1 && columnCount > 0
    ? `<autoFilter ref="A1:${columnName(columnCount - 1)}${normalized.length}"/>`
    : '';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${sheetRows}</sheetData>${filter}</worksheet>`;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const { time, day } = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, end]);
}

function xlsxBuffer(sheets) {
  const used = new Set();
  const normalized = sheets.map((sheet, index) => ({
    name: safeSheetName(sheet.name, `Feuille ${index + 1}`, used),
    rows: sheet.rows || []
  }));
  const sheetOverrides = normalized.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetOverrides}</Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;
  const workbookSheets = normalized.map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${workbookSheets}</sheets></workbook>`;
  const workbookRelationships = normalized.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('');
  const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbookRelationships}<Relationship Id="rId${normalized.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`;
  const files = [
    { name:'[Content_Types].xml', data:contentTypes },
    { name:'_rels/.rels', data:rootRels },
    { name:'xl/workbook.xml', data:workbook },
    { name:'xl/_rels/workbook.xml.rels', data:workbookRels },
    { name:'xl/styles.xml', data:styles },
    ...normalized.map((sheet, index) => ({ name:`xl/worksheets/sheet${index + 1}.xml`, data:worksheetXml(sheet.rows) }))
  ];
  return zipStore(files);
}

const sameSet = (left, right) => left.length === right.length && left.every(value => new Set(right).has(value));
const fmtDate = value => value ? new Date(value).toISOString() : '';
const fmtDuration = value => {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'Non disponible';
  const total = Math.max(0, Math.round(Number(value) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} min ${seconds ? `${seconds} s` : ''}`.trim() : `${seconds} s`;
};

function liveResponseTime(timing, submission, durationSeconds) {
  if (!timing?.started_at || !submission?.submitted_at) return null;
  const started = new Date(timing.started_at).getTime();
  const submitted = new Date(submission.submitted_at).getTime();
  const ended = timing.ends_at ? new Date(timing.ends_at).getTime() : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(started) || !Number.isFinite(submitted)) return null;
  const measured = Math.max(0, Math.min(submitted, ended) - started);
  const maximum = Number(durationSeconds || 0) > 0 ? Number(durationSeconds) * 1000 : Number.POSITIVE_INFINITY;
  return Math.round(Math.min(measured, maximum));
}

function examResponseTime(timing, attempt) {
  if (!timing) return null;
  let value = Number(timing.accumulated_ms || 0);
  if (timing.active_started_at && !timing.answered_at) {
    const started = new Date(timing.active_started_at).getTime();
    const stops = [Date.now(), new Date(attempt.expires_at).getTime()];
    if (attempt.submitted_at) stops.push(new Date(attempt.submitted_at).getTime());
    const stop = Math.min(...stops.filter(Number.isFinite));
    if (Number.isFinite(started) && Number.isFinite(stop)) value += Math.max(0, stop - started);
  }
  return Math.round(value);
}

async function quizWorkbook(client, sessionId) {
  const metaResult = await client.query(
    `SELECT ls.id,ls.code,ls.status,ls.created_at,ls.ended_at,
      COALESCE(tg.name,'Sans groupe') AS group_name,t.name AS theme_name,
      c.title AS chapter_title,q.title AS quiz_title
     FROM live_sessions ls
     JOIN quizzes q ON q.id=ls.quiz_id
     JOIN chapters c ON c.id=q.chapter_id
     JOIN themes t ON t.id=c.theme_id
     LEFT JOIN training_groups tg ON tg.id=ls.group_id
     WHERE ls.id=$1 AND ls.archived_at IS NULL`,
    [sessionId]
  );
  const meta = metaResult.rows[0];
  if (!meta) throw httpError(404, 'Session de quiz introuvable.');

  const [participantsResult, questionsResult, optionsResult, submissionsResult, answersResult, timingsResult] = await Promise.all([
    client.query(
      `SELECT sp.id AS participant_id,u.id AS user_id,u.first_name,u.last_name,u.participant_code,sp.joined_at
       FROM session_participants sp
       JOIN app_users u ON u.id=sp.user_id
       WHERE sp.session_id=$1 AND (sp.status<>'waiting_list' OR EXISTS (
         SELECT 1 FROM live_answer_submissions las WHERE las.session_id=sp.session_id AND las.participant_id=sp.id
       ))
       ORDER BY lower(u.last_name),lower(u.first_name),sp.joined_at`,
      [sessionId]
    ),
    client.query(
      `SELECT q.id,q.body,q.position,q.duration_seconds
       FROM questions q
       JOIN live_sessions ls ON ls.quiz_id=q.quiz_id
       WHERE ls.id=$1 AND q.is_active AND q.archived_at IS NULL
       ORDER BY q.position,q.id`,
      [sessionId]
    ),
    client.query(
      `SELECT o.id,o.question_id,o.label,o.body,o.is_correct
       FROM answer_options o
       JOIN questions q ON q.id=o.question_id
       JOIN live_sessions ls ON ls.quiz_id=q.quiz_id
       WHERE ls.id=$1 AND q.is_active AND q.archived_at IS NULL
       ORDER BY q.position,o.label`,
      [sessionId]
    ),
    client.query(
      `SELECT participant_id,question_id,is_correct,points_earned::numeric AS points_earned,submitted_at
       FROM live_answer_submissions WHERE session_id=$1`,
      [sessionId]
    ),
    client.query(
      `SELECT participant_id,question_id,option_id FROM live_answers WHERE session_id=$1`,
      [sessionId]
    ),
    client.query(
      'SELECT question_id,started_at,ends_at FROM live_question_timings WHERE session_id=$1',
      [sessionId]
    )
  ]);

  const optionsByQuestion = new Map();
  for (const option of optionsResult.rows) {
    if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
    optionsByQuestion.get(option.question_id).push(option);
  }
  const timingByQuestion = new Map(timingsResult.rows.map(item => [item.question_id, item]));
  const summaryRows = [['Nom','Prénom','Code participant','État','Score (%)','Bonnes réponses','Répondues','Questions','Temps total']];
  const detailRows = [['Nom','Prénom','Code participant','Type','Évaluation','Groupe','Position','Question','Réponse(s) choisie(s)','Bonne(s) réponse(s)','Résultat','Points obtenus','Points possibles','Temps de réponse']];

  for (const participant of participantsResult.rows) {
    let correctCount = 0;
    let answeredCount = 0;
    let earned = 0;
    let totalTime = 0;
    let allTimes = true;
    questionsResult.rows.forEach((question, index) => {
      const submission = submissionsResult.rows.find(item => item.participant_id === participant.participant_id && item.question_id === question.id) || null;
      const selectedIds = answersResult.rows.filter(item => item.participant_id === participant.participant_id && item.question_id === question.id).map(item => item.option_id);
      const options = optionsByQuestion.get(question.id) || [];
      const selected = options.filter(option => selectedIds.includes(option.id));
      const correctOptions = options.filter(option => option.is_correct);
      const time = liveResponseTime(timingByQuestion.get(question.id), submission, question.duration_seconds);
      const points = Number(submission?.points_earned || 0);
      if (submission) {
        answeredCount += 1;
        if (submission.is_correct) correctCount += 1;
        earned += points;
      }
      if (time === null) allTimes = false; else totalTime += time;
      detailRows.push([
        participant.last_name, participant.first_name, participant.participant_code || '', 'Quiz standard',
        `${meta.chapter_title} · ${meta.quiz_title}`, meta.group_name, index + 1, question.body,
        selected.map(option => `${option.label} · ${option.body}`).join(' | '),
        correctOptions.map(option => `${option.label} · ${option.body}`).join(' | '),
        submission ? (submission.is_correct ? 'Correcte' : (points > 0 ? 'Partielle' : 'Incorrecte')) : 'Non répondue',
        points, 1, fmtDuration(time)
      ]);
    });
    const questionCount = questionsResult.rows.length;
    summaryRows.push([
      participant.last_name, participant.first_name, participant.participant_code || '',
      answeredCount ? 'Réponses enregistrées' : 'Aucune réponse',
      questionCount ? Math.round(earned * 10000 / questionCount) / 100 : 0,
      correctCount, answeredCount, questionCount, allTimes ? fmtDuration(totalTime) : 'Non disponible'
    ]);
  }

  return {
    filename: `statistiques-quiz-${meta.code}.xlsx`,
    sheets: [
      { name:'Synthèse', rows:[
        ['Export réalisé le', fmtDate(new Date())],
        ['Type','Quiz standard'],
        ['Évaluation',`${meta.chapter_title} · ${meta.quiz_title}`],
        ['Thème',meta.theme_name],
        ['Groupe',meta.group_name],
        ['Code',meta.code],
        [],
        ...summaryRows
      ]},
      { name:'Détail des réponses', rows:detailRows }
    ]
  };
}

async function examWorkbook(client, examId, examType) {
  const metaResult = await client.query(
    `SELECT fe.id,fe.exam_type,fe.code,fe.title,fe.status,fe.duration_minutes,fe.shuffle_questions,
      tg.name AS group_name,t.name AS theme_name
     FROM final_exams fe
     JOIN training_groups tg ON tg.id=fe.group_id
     JOIN themes t ON t.id=tg.theme_id
     WHERE fe.id=$1 AND fe.exam_type=$2 AND fe.archived_at IS NULL AND tg.archived_at IS NULL`,
    [examId, examType]
  );
  const meta = metaResult.rows[0];
  const typeLabel = examType === 'experience' ? 'Examen Expérience' : 'Examen final';
  if (!meta) throw httpError(404, `${typeLabel} introuvable.`);

  const [attemptsResult, questionsResult, optionsResult, answersResult, timingsResult, ordersResult] = await Promise.all([
    client.query(
      `SELECT a.id,a.user_id,a.started_at,a.expires_at,a.submitted_at,a.score_points::numeric AS score_points,
        a.score_percent::numeric AS score_percent,u.first_name,u.last_name,u.participant_code
       FROM final_exam_attempts a
       JOIN app_users u ON u.id=a.user_id
       WHERE a.exam_id=$1 AND a.archived_at IS NULL
       ORDER BY lower(u.last_name),lower(u.first_name),a.started_at`,
      [examId]
    ),
    client.query(
      'SELECT id,body,points::numeric AS points,position FROM final_exam_questions WHERE exam_id=$1 ORDER BY position,id',
      [examId]
    ),
    client.query(
      `SELECT o.id,o.question_id,o.label,o.body,o.is_correct
       FROM final_exam_options o
       JOIN final_exam_questions q ON q.id=o.question_id
       WHERE q.exam_id=$1 ORDER BY q.position,o.label`,
      [examId]
    ),
    client.query(
      `SELECT a.attempt_id,a.question_id,a.option_id
       FROM final_exam_answers a
       JOIN final_exam_attempts attempt ON attempt.id=a.attempt_id
       WHERE attempt.exam_id=$1 AND attempt.archived_at IS NULL`,
      [examId]
    ),
    client.query(
      `SELECT t.attempt_id,t.question_id,t.accumulated_ms,t.active_started_at,t.answered_at
       FROM final_exam_question_timings t
       JOIN final_exam_attempts a ON a.id=t.attempt_id
       WHERE a.exam_id=$1 AND a.archived_at IS NULL`,
      [examId]
    ),
    client.query(
      `SELECT o.attempt_id,o.question_id,o.display_position
       FROM final_exam_attempt_question_order o
       JOIN final_exam_attempts a ON a.id=o.attempt_id
       WHERE a.exam_id=$1 AND a.archived_at IS NULL`,
      [examId]
    )
  ]);

  const optionsByQuestion = new Map();
  for (const option of optionsResult.rows) {
    if (!optionsByQuestion.has(option.question_id)) optionsByQuestion.set(option.question_id, []);
    optionsByQuestion.get(option.question_id).push(option);
  }
  const summaryRows = [['Nom','Prénom','Code participant','État','Score (%)','Bonnes réponses','Répondues','Questions','Temps total']];
  const detailRows = [['Nom','Prénom','Code participant','Type','Évaluation','Groupe','Position vue','Question','Réponse(s) choisie(s)','Bonne(s) réponse(s)','Résultat','Points obtenus','Points possibles','Temps de réponse']];

  for (const attempt of attemptsResult.rows) {
    const order = new Map(ordersResult.rows.filter(item => item.attempt_id === attempt.id).map(item => [item.question_id, Number(item.display_position)]));
    const questions = [...questionsResult.rows].sort((left, right) => {
      if (!order.size) return Number(left.position) - Number(right.position);
      return (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
    });
    let correctCount = 0;
    let answeredCount = 0;
    let earned = 0;
    let total = 0;
    let totalTime = 0;
    let allTimes = true;

    questions.forEach((question, index) => {
      const options = optionsByQuestion.get(question.id) || [];
      const selectedIds = answersResult.rows.filter(item => item.attempt_id === attempt.id && item.question_id === question.id).map(item => item.option_id);
      const correctIds = options.filter(option => option.is_correct).map(option => option.id);
      const answered = selectedIds.length > 0;
      const correct = answered && sameSet(selectedIds, correctIds);
      const points = correct ? Number(question.points || 0) : 0;
      const possible = Number(question.points || 0);
      const timing = timingsResult.rows.find(item => item.attempt_id === attempt.id && item.question_id === question.id) || null;
      const time = examResponseTime(timing, attempt);
      if (answered) answeredCount += 1;
      if (correct) correctCount += 1;
      earned += points;
      total += possible;
      if (time === null) allTimes = false; else totalTime += time;
      detailRows.push([
        attempt.last_name, attempt.first_name, attempt.participant_code || '', typeLabel, meta.title, meta.group_name,
        index + 1, question.body,
        options.filter(option => selectedIds.includes(option.id)).map(option => `${option.label} · ${option.body}`).join(' | '),
        options.filter(option => option.is_correct).map(option => `${option.label} · ${option.body}`).join(' | '),
        answered ? (correct ? 'Correcte' : 'Incorrecte') : 'Non répondue',
        points, possible, fmtDuration(time)
      ]);
    });

    const state = attempt.submitted_at ? 'Rendue' : (new Date(attempt.expires_at).getTime() <= Date.now() ? 'Expirée' : 'En cours');
    const score = attempt.score_percent === null || attempt.score_percent === undefined
      ? (total ? Math.round(earned * 10000 / total) / 100 : 0)
      : Number(attempt.score_percent);
    summaryRows.push([
      attempt.last_name, attempt.first_name, attempt.participant_code || '', state, score,
      correctCount, answeredCount, questions.length, allTimes ? fmtDuration(totalTime) : 'Non disponible'
    ]);
  }

  return {
    filename: `statistiques-${examType === 'experience' ? 'examen-experience' : 'examen-final'}-${meta.code}.xlsx`,
    sheets: [
      { name:'Synthèse', rows:[
        ['Export réalisé le', fmtDate(new Date())],
        ['Type',typeLabel],
        ['Évaluation',meta.title],
        ['Thème',meta.theme_name],
        ['Groupe',meta.group_name],
        ['Code',meta.code],
        ['Mélange des questions',meta.shuffle_questions ? 'Oui' : 'Non'],
        [],
        ...summaryRows
      ]},
      { name:'Détail des réponses', rows:detailRows }
    ]
  };
}

export function registerStatisticsXlsxRoutes(app) {
  app.get('/api/quality/statistics/export.xlsx', safe(async (req, res) => {
    await sessionUser(req, 'staff');
    const kind = String(req.query?.kind || '');
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let workbook;
      if (kind === 'quiz') {
        const sessionId = String(req.query?.session_id || '');
        if (!isUuid(sessionId)) throw httpError(400, 'Session invalide.');
        workbook = await quizWorkbook(client, sessionId);
      } else if (kind === 'exam' || kind === 'experience_exam') {
        const examId = String(req.query?.exam_id || '');
        if (!isUuid(examId)) throw httpError(400, 'Examen invalide.');
        workbook = await examWorkbook(client, examId, kind === 'experience_exam' ? 'experience' : 'final');
      } else {
        throw httpError(400, 'Type d’évaluation invalide.');
      }
      await client.query('COMMIT');
      const buffer = xlsxBuffer(workbook.sheets);
      res.set('Cache-Control', 'no-store');
      res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.set('Content-Disposition', `attachment; filename="${workbook.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`);
      res.send(buffer);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));
}
