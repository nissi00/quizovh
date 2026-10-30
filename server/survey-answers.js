import { getSurveyQuestionnaire, surveyAnswerColumns, surveyQuestionVisible } from '../survey-questionnaires.js';

const invalid = message => { throw Object.assign(new Error(message), { status:400 }); };
function calendarDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function normalizeSurveyAnswers(type, input) {
  const questionnaire = getSurveyQuestionnaire(type);
  if (!questionnaire) invalid('Type de questionnaire invalide.');
  const answers = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const normalized = {};
  for (const item of [...questionnaire.fields, ...questionnaire.questions]) {
    if (!surveyQuestionVisible(item, answers)) continue;
    if (item.type === 'multiple') {
      const selected = answers[item.id];
      if (!Array.isArray(selected) || !selected.length || selected.some(value => !item.options.includes(value))) invalid(`Réponse requise : ${item.label}`);
      const values = [...new Set(selected)];
      if (values.includes(item.exclusive) && values.length > 1) invalid(`Choisissez « ${item.exclusive} » seul : ${item.label}`);
      normalized[item.id] = item.options.filter(option => values.includes(option));
      if (item.otherKey) {
        const other = String(answers[item.otherKey] || '').trim();
        if (other.length > 2000) invalid('La précision « Autre » est limitée à 2 000 caractères.');
        if (values.includes('Autre') && !other) invalid(`Précisez votre réponse « Autre » : ${item.label}`);
        normalized[item.otherKey] = values.includes('Autre') ? other : '';
      }
    } else if (item.type === 'choice') {
      const value = String(answers[item.id] || '').trim();
      if (!item.options.includes(value)) invalid(`Réponse requise : ${item.label}`);
      normalized[item.id] = value;
    } else if (item.type === 'rating') {
      const value = Number(answers[item.id]);
      if (!Number.isInteger(value) || !item.options.includes(value)) invalid('Choisissez une note de recommandation entre 1 et 10.');
      normalized[item.id] = value;
    } else {
      const value = String(answers[item.id] || '').trim();
      if (item.required && !value) invalid(`Champ requis : ${item.label}`);
      if (value.length > item.maxLength) invalid(`${item.label} : ${item.maxLength.toLocaleString('fr-FR')} caractères maximum.`);
      if (item.type === 'date' && !calendarDate(value)) invalid(`Date invalide : ${item.label}`);
      normalized[item.id] = value;
    }
  }
  if (normalized.period_start && normalized.period_end && normalized.period_end < normalized.period_start) invalid('La fin de la période évaluée doit suivre son début.');
  return normalized;
}

export function surveyCsv(type, responses) {
  const questionnaire = getSurveyQuestionnaire(type);
  if (!questionnaire) invalid('Type de questionnaire invalide.');
  const columns = surveyAnswerColumns(questionnaire);
  const cell = value => {
    let content = String(Array.isArray(value) ? value.join(' | ') : value ?? '').replace(/[\r\n]+/g, ' ');
    if (type !== 'trainee' && /^\s*[=+\-@]/.test(content)) content = `'${content}`;
    return `"${content.replace(/"/g, '""')}"`;
  };
  const rows = [['Réponse', ...columns.map(item => item.label.replace(/\s*:\s*$/, ''))], ...responses.map((row, index) => [index + 1, ...columns.map(item => row.answers?.[item.id] ?? '')])];
  return `\uFEFF${rows.map(row => row.map(cell).join(';')).join('\r\n')}\r\n`;
}
