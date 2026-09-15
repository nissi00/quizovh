const examUiState = new Map();
const questionPageSize = 8;
const attemptPageSize = 10;
let qualityPoller = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
}[char]));

function stateFor(examId) {
  if (!examUiState.has(examId)) examUiState.set(examId, { questionPage:0, attemptPage:0, questionIndex:0 });
  return examUiState.get(examId);
}

function examIdFromDetail(detail) {
  const src = detail.querySelector('.exam-detail .exam-qr img')?.getAttribute('src') || '';
  return src.match(/\/api\/final-exams\/([0-9a-f-]{36})\/qr/i)?.[1] || '';
}

async function fetchQualityDetails(examId) {
  const response = await fetch(`/api/quality/final-exams/${encodeURIComponent(examId)}/details`, { credentials:'same-origin', cache:'no-store' });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Erreur (${response.status})`);
  return payload;
}

function pagination(label, page, total, size, onChange) {
  const pages = Math.max(1, Math.ceil(total / size));
  const start = total ? page * size + 1 : 0;
  const end = Math.min((page + 1) * size, total);
  const nav = document.createElement('nav');
  nav.className = 'quality-pagination';
  nav.setAttribute('aria-label', label);
  nav.innerHTML = `<span>${start}–${end} sur ${total}</span><button type="button" class="icon-button" ${page<=0?'disabled':''}>‹</button><button type="button" class="icon-button" ${page>=pages-1?'disabled':''}>›</button>`;
  const buttons = nav.querySelectorAll('button');
  buttons[0]?.addEventListener('click', () => onChange(Math.max(0, page - 1)));
  buttons[1]?.addEventListener('click', () => onChange(Math.min(pages - 1, page + 1)));
  return nav;
}

function renderQuestionPagination(section, payload, ui) {
  const questions = [...section.querySelectorAll('.exam-question-summary')];
  ui.questionPage = Math.min(ui.questionPage, Math.max(0, Math.ceil(questions.length / questionPageSize) - 1));
  const start = ui.questionPage * questionPageSize;
  questions.forEach((node, index) => {
    node.classList.toggle('quality-page-hidden', index < start || index >= start + questionPageSize);
    const title = node.querySelector('b');
    if (title && payload.questions[index]) title.innerHTML = `Q${index + 1}. ${esc(payload.questions[index].body)}`;
  });
  section.querySelectorAll('.quality-question-pagination').forEach(node => node.remove());
  if (questions.length > questionPageSize) {
    const topNav = pagination('Pagination des questions', ui.questionPage, questions.length, questionPageSize, nextPage => {
      ui.questionPage = nextPage;
      renderQuestionPagination(section, payload, ui);
    });
    topNav.classList.add('quality-question-pagination');
    section.querySelector('h3')?.insertAdjacentElement('afterend', topNav);

    const bottomNav = pagination('Pagination des questions', ui.questionPage, questions.length, questionPageSize, nextPage => {
      ui.questionPage = nextPage;
      renderQuestionPagination(section, payload, ui);
    });
    bottomNav.classList.add('quality-question-pagination');
    section.appendChild(bottomNav);
  }
}

function qCell(result, question) {
  if (!result?.answered) return '<td class="quality-q-result unanswered"><span>—</span><small>Non répondue</small></td>';
  if (result.is_correct) return `<td class="quality-q-result correct"><span>✓</span><small>${Number(result.points_earned || 0).toLocaleString('fr-FR')} / ${Number(question.points || 0).toLocaleString('fr-FR')} pt</small></td>`;
  return `<td class="quality-q-result incorrect"><span>✕</span><small>0 / ${Number(question.points || 0).toLocaleString('fr-FR')} pt</small></td>`;
}

function renderAttempts(section, payload, ui) {
  const questions = payload.questions || [];
  const attempts = payload.attempts || [];
  if (questions.length) ui.questionIndex = Math.min(Math.max(0, ui.questionIndex), questions.length - 1);
  else ui.questionIndex = 0;
  ui.attemptPage = Math.min(ui.attemptPage, Math.max(0, Math.ceil(attempts.length / attemptPageSize) - 1));
  const question = questions[ui.questionIndex] || null;
  const totalPoints = questions.reduce((sum, item) => sum + Number(item.points || 0), 0);
  const start = ui.attemptPage * attemptPageSize;
  const pageAttempts = attempts.slice(start, start + attemptPageSize);

  const qHeader = question ? `<th class="quality-q-column"><div class="quality-q-carousel"><button type="button" class="icon-button quality-q-prev" aria-label="Question précédente" ${ui.questionIndex===0?'disabled':''}>‹</button><span class="quality-q-label" title="${esc(question.body)}">Q${ui.questionIndex+1}</span><button type="button" class="icon-button quality-q-next" aria-label="Question suivante" ${ui.questionIndex>=questions.length-1?'disabled':''}>›</button></div></th>` : '';

  section.innerHTML = `<div class="quality-section-heading"><div><p class="eyebrow">Résultats individuels</p><h3>Copies des apprenants</h3></div>${question?`<span class="muted">Détail : Q${ui.questionIndex+1} sur ${questions.length}</span>`:''}</div><div class="table-wrap"><table class="quality-attempts-table"><thead><tr><th>Apprenant</th><th>Code</th><th>État</th><th>Points</th><th>Note</th>${qHeader}</tr></thead><tbody>${pageAttempts.map(attempt=>`<tr><td><b>${esc(attempt.first_name)} ${esc(attempt.last_name)}</b></td><td><code>${esc(attempt.participant_code)}</code></td><td>${attempt.submitted_at?'Rendue':'En cours'}</td><td>${attempt.submitted_at?Number(attempt.score_points||0).toLocaleString('fr-FR'):'—'} / ${totalPoints.toLocaleString('fr-FR')}</td><td>${attempt.submitted_at?`<b>${Number(attempt.score_percent||0).toLocaleString('fr-FR',{maximumFractionDigits:1})} %</b>`:'—'}</td>${question?qCell(attempt.question_results?.[question.id],question):''}</tr>`).join('')||`<tr><td colspan="${question?6:5}">Aucune copie pour le moment.</td></tr>`}</tbody></table></div>`;

  if (attempts.length > attemptPageSize) {
    const nav = pagination('Pagination des copies', ui.attemptPage, attempts.length, attemptPageSize, nextPage => {
      ui.attemptPage = nextPage;
      renderAttempts(section, payload, ui);
    });
    section.appendChild(nav);
  }
  section.querySelector('.quality-q-prev')?.addEventListener('click', () => {
    ui.questionIndex = Math.max(0, ui.questionIndex - 1);
    renderAttempts(section, payload, ui);
  });
  section.querySelector('.quality-q-next')?.addEventListener('click', () => {
    ui.questionIndex = Math.min(questions.length - 1, ui.questionIndex + 1);
    renderAttempts(section, payload, ui);
  });
}

function enhanceDetail(detail, payload, examId) {
  const summary = detail.querySelector('.exam-detail');
  if (!summary || summary.dataset.qualityExamId === examId) return;
  const questionSection = summary.querySelector('.exam-questions');
  const attemptsSection = summary.querySelector('.exam-attempts');
  if (!questionSection || !attemptsSection) return;

  summary.dataset.qualityExamId = examId;
  summary.classList.add('quality-exam-summary');
  questionSection.classList.add('card', 'quality-exam-section', 'quality-question-card');
  attemptsSection.classList.add('card', 'quality-exam-section', 'quality-attempt-card');

  summary.insertAdjacentElement('afterend', questionSection);
  questionSection.insertAdjacentElement('afterend', attemptsSection);

  const ui = stateFor(examId);
  renderQuestionPagination(questionSection, payload, ui);
  renderAttempts(attemptsSection, payload, ui);
}

async function applyQualityEnhancements() {
  const detail = document.querySelector('#finalExamDetail');
  const summary = detail?.querySelector('.exam-detail');
  if (!detail || !summary || summary.dataset.qualityLoading === 'true') return;
  const examId = examIdFromDetail(detail);
  if (!examId || summary.dataset.qualityExamId === examId) return;
  summary.dataset.qualityLoading = 'true';
  try {
    const payload = await fetchQualityDetails(examId);
    if (document.querySelector('#finalExamDetail .exam-detail') !== summary) return;
    enhanceDetail(detail, payload, examId);
  } catch (error) {
    console.error('[exam-quality]', error);
  } finally {
    if (summary.isConnected) summary.dataset.qualityLoading = 'false';
  }
}

applyQualityEnhancements();
qualityPoller = setInterval(applyQualityEnhancements, 700);
window.addEventListener('beforeunload', () => clearInterval(qualityPoller));
