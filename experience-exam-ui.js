import {
  getTrainingGroups,getExperienceExams,getFinalExam,createExperienceExam,updateFinalExam,
  createFinalExamQuestion,updateFinalExamQuestion,deleteFinalExamQuestion,finalExamQrUrl,archiveItem
} from './api.js';

let activeExperienceExamId = '';
const statusLabels = { draft:'En préparation',open:'Ouvert',closed:'Clôturé' };
const answerLabels = 'ABCDEF';
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const percent = value => `${Number(value || 0).toFixed(1).replace('.', ',')} %`;

function panelButton() { return document.querySelector('[data-experience-exam-nav]'); }

function install() {
  const sidebar = document.querySelector('.sidebar');
  const section = document.querySelector('.layout > section');
  if (!sidebar || !section || panelButton()) return;
  const button = document.createElement('button');
  button.className = 'nav-button';
  button.type = 'button';
  button.dataset.experienceExamNav = '1';
  button.textContent = '🧪 Examen Expérience';
  button.addEventListener('click', openPanel);
  const experienceButton = [...sidebar.querySelectorAll('.nav-button')].find(item => item.textContent.includes('Expériences'));
  sidebar.insertBefore(button, experienceButton || sidebar.lastElementChild);
  const panel = document.createElement('div');
  panel.id = 'experienceExam';
  panel.className = 'panel';
  panel.innerHTML = '<p class="eyebrow">Évaluation de l’expérience</p><h1>Examen Expérience</h1><p class="muted">Cet examen complète la note pratique. La note Expérience est la moyenne de ces deux évaluations.</p><div id="experienceExamRows"><div class="card empty">Ouvrez cette rubrique pour charger les examens.</div></div>';
  section.appendChild(panel);
}

async function openPanel() {
  const button = panelButton();
  if (typeof window.panel === 'function') window.panel('experienceExam', button);
  else {
    document.querySelectorAll('.panel').forEach(item => item.classList.toggle('active', item.id === 'experienceExam'));
    document.querySelectorAll('.nav-button').forEach(item => item.classList.remove('active'));
    button?.classList.add('active');
  }
  await renderList();
}

async function renderList() {
  const box = document.querySelector('#experienceExamRows');
  if (!box) return;
  box.innerHTML = '<div class="card empty">Chargement des examens…</div>';
  try {
    const [groups, exams] = await Promise.all([getTrainingGroups(), getExperienceExams()]);
    box.innerHTML = `<form class="card exam-builder" data-experience-exam-create><h2>Créer l’examen Expérience d’un groupe</h2><div class="form-grid"><div><label>Groupe de formation</label><select name="group_id" required><option value="">Sélectionnez un groupe</option>${groups.map(group=>{const used=exams.some(exam=>exam.group_id===group.id);return `<option value="${esc(group.id)}" ${used?'disabled':''}>${esc(group.name)} · ${esc(group.theme_name)}${used?' · examen déjà créé':''}</option>`}).join('')}</select></div><div><label>Durée (minutes)</label><input name="duration_minutes" type="number" min="5" max="480" value="60" required></div><div class="full"><label>Titre</label><input name="title" required placeholder="Ex. Examen Expérience"></div><div class="full"><label>Consignes</label><textarea name="instructions" placeholder="Consignes visibles avant et pendant l’examen"></textarea></div></div><p><button class="button" type="submit">Créer l’examen</button></p></form><div class="exam-list">${exams.map(exam=>`<div class="exam-list-row"><button class="card exam-list-item ${activeExperienceExamId===exam.id?'selected':''}" type="button" data-open-experience-exam="${esc(exam.id)}"><span><span class="tag">${esc(statusLabels[exam.status]||exam.status)}</span><b>${esc(exam.title)}</b><small>${esc(exam.group_name)} · ${Number(exam.question_count||0)} question(s) · ${Number(exam.total_points||0)} point(s)</small></span><strong>${Number(exam.submission_count||0)} copie(s) →</strong></button><div class="row-actions">${Number(exam.attempt_count||0)===0?`<button class="icon-button" type="button" data-edit-experience-exam="${esc(exam.id)}" title="Modifier l’examen">✏️</button>`:''}<button class="icon-button archive-button" type="button" data-archive-experience-exam="${esc(exam.id)}" title="Archiver l’examen">📦</button></div></div>`).join('')||'<div class="card empty">Aucun examen Expérience créé.</div>'}</div><div id="experienceExamDetail"></div>`;
    box.querySelector('[data-experience-exam-create]')?.addEventListener('submit', createExam);
    box.querySelectorAll('[data-open-experience-exam]').forEach(button=>button.addEventListener('click',()=>showExam(button.dataset.openExperienceExam)));
    box.querySelectorAll('[data-edit-experience-exam]').forEach(button=>button.addEventListener('click',()=>editExam(button.dataset.editExperienceExam)));
    box.querySelectorAll('[data-archive-experience-exam]').forEach(button=>button.addEventListener('click',()=>archiveExam(button.dataset.archiveExperienceExam)));
    if (activeExperienceExamId && exams.some(exam=>exam.id===activeExperienceExamId)) await showExam(activeExperienceExamId, false);
  } catch (error) { box.innerHTML = `<div class="notice">${esc(error.message)}</div>`; }
}

async function createExam(event) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  try {
    const exam = await createExperienceExam({group_id:data.get('group_id'),title:String(data.get('title')||'').trim(),instructions:String(data.get('instructions')||'').trim(),duration_minutes:Number(data.get('duration_minutes'))});
    activeExperienceExamId = exam.id;
    await renderList();
  } catch (error) { alert(error.message); }
}

async function editExam(id) {
  try {
    const exam = await getFinalExam(id);
    if (exam.has_attempts) return alert('Cet examen possède déjà des copies et ne peut plus être modifié.');
    const title = prompt('Titre de l’examen Expérience :', exam.title); if (title === null) return;
    const instructions = prompt('Consignes :', exam.instructions || ''); if (instructions === null) return;
    const duration = prompt('Durée en minutes :', String(exam.duration_minutes)); if (duration === null) return;
    await updateFinalExam(id, {title:title.trim(),instructions:instructions.trim(),duration_minutes:Number(duration)});
    await renderList();
  } catch (error) { alert(error.message); }
}

async function archiveExam(id) {
  if (!confirm('Archiver cet examen Expérience ? Ses questions, copies et résultats seront conservés.')) return;
  try { await archiveItem('exam', id); activeExperienceExamId=''; await renderList(); }
  catch (error) { alert(error.message); }
}

function questionForm(examId) {
  return `<form class="exam-question-form" data-experience-question-form><h3>Ajouter une question</h3><div class="form-grid"><div class="full"><label>Question</label><textarea name="body" required></textarea></div><div><label>Nombre de propositions</label><select name="answer_count">${[2,3,4,5,6].map(count=>`<option value="${count}" ${count===4?'selected':''}>${count}</option>`).join('')}</select></div><div class="full" data-answer-fields></div><div><label>Points attribués</label><input name="points" type="number" min="0.1" max="1000" step="0.1" value="1" required></div></div><p><button class="button" type="submit">Ajouter au questionnaire</button></p><input type="hidden" name="exam_id" value="${esc(examId)}"></form>`;
}

function syncAnswerFields(form) {
  const count = Number(form.elements.answer_count.value || 4);
  form.querySelector('[data-answer-fields]').innerHTML = `<div class="form-grid">${Array.from({length:count},(_,index)=>`<div><label>Proposition ${answerLabels[index]}</label><input name="answer_${index}" required></div>`).join('')}</div><label>Bonne(s) réponse(s)</label><div class="correct-choices">${Array.from({length:count},(_,index)=>`<label class="inline-choice"><input name="correct" type="checkbox" value="${index}" ${index===0?'checked':''}> Proposition ${answerLabels[index]}</label>`).join('')}</div>`;
}

async function showExam(id, scroll = true) {
  activeExperienceExamId = id;
  const box = document.querySelector('#experienceExamDetail');
  if (!box) return;
  box.innerHTML = '<div class="card empty">Chargement de l’examen…</div>';
  try {
    const exam = await getFinalExam(id);
    const editable = exam.status === 'draft' && !exam.has_attempts;
    const total = (exam.questions||[]).reduce((sum,item)=>sum+Number(item.points||0),0);
    const examUrl = `${location.origin}/exam.html?exam=${encodeURIComponent(exam.code)}`;
    box.innerHTML = `<article class="card exam-detail"><div class="row"><div><span class="tag">${esc(statusLabels[exam.status]||exam.status)}</span><h2>${esc(exam.title)}</h2><p class="muted">${esc(exam.group_name)} · ${Number(exam.duration_minutes)} min · ${total} point(s)</p></div><div class="exam-qr"><img src="${finalExamQrUrl(exam.id)}" alt="QR code de l’examen Expérience"><code>${esc(exam.code)}</code></div></div><div class="actions exam-state-actions">${exam.status==='draft'?'<button class="button" type="button" data-experience-status="open">Ouvrir l’examen</button>':''}${exam.status==='open'?'<button class="button danger" type="button" data-experience-status="closed">Clôturer l’examen</button>':''}${exam.status==='closed'?'<button class="button secondary" type="button" data-experience-status="open">Rouvrir l’examen</button>':''}<button class="button secondary" type="button" data-copy-experience-link>Copier le lien</button></div>${editable?questionForm(exam.id):''}<section class="exam-questions"><h3>Questions et barème</h3>${(exam.questions||[]).map(question=>`<article class="exam-question-summary"><div><b>Q${question.position}. ${esc(question.body)}</b><small>${Number(question.points)} point(s)</small></div>${editable?`<div class="row-actions"><button class="icon-button" type="button" data-edit-experience-question="${esc(question.id)}">✏️</button><button class="icon-button danger" type="button" data-delete-experience-question="${esc(question.id)}">🗑️</button></div>`:''}<div class="exam-option-summary">${(question.options||[]).map(option=>`<span class="${option.is_correct?'correct':''}">${esc(option.label)} · ${esc(option.body)}${option.is_correct?' ✓':''}</span>`).join('')}</div></article>`).join('')||'<div class="empty">Ajoutez au moins une question.</div>'}</section><section class="exam-attempts"><h3>Copies des apprenants</h3><div class="table-wrap"><table><thead><tr><th>Apprenant</th><th>Code</th><th>État</th><th>Points</th><th>Note</th></tr></thead><tbody>${(exam.attempts||[]).map(attempt=>`<tr><td><b>${esc(attempt.first_name)} ${esc(attempt.last_name)}</b></td><td><code>${esc(attempt.participant_code)}</code></td><td>${attempt.submitted_at?'Rendue':'En cours'}</td><td>${attempt.submitted_at?Number(attempt.score_points||0):'—'} / ${total}</td><td>${attempt.submitted_at?`<b>${percent(attempt.score_percent)}</b>`:'—'}</td></tr>`).join('')||'<tr><td colspan="5">Aucune copie pour le moment.</td></tr>'}</tbody></table></div></section></article>`;
    const form = box.querySelector('[data-experience-question-form]');
    if (form) { syncAnswerFields(form); form.elements.answer_count.addEventListener('change',()=>syncAnswerFields(form)); form.addEventListener('submit',addQuestion); }
    box.querySelector('[data-copy-experience-link]')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(examUrl);alert('Lien copié.')}catch{prompt('Copiez ce lien :',examUrl)}});
    box.querySelector('[data-experience-status]')?.addEventListener('click',event=>changeStatus(exam.id,event.currentTarget.dataset.experienceStatus));
    box.querySelectorAll('[data-edit-experience-question]').forEach(button=>button.addEventListener('click',()=>editQuestion(exam,button.dataset.editExperienceQuestion)));
    box.querySelectorAll('[data-delete-experience-question]').forEach(button=>button.addEventListener('click',()=>removeQuestion(exam.id,button.dataset.deleteExperienceQuestion)));
    if (scroll) box.scrollIntoView({behavior:'smooth',block:'start'});
  } catch (error) { box.innerHTML=`<div class="notice">${esc(error.message)}</div>`; }
}

async function addQuestion(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const count = Number(form.elements.answer_count.value);
  const correct = [...form.querySelectorAll('[name="correct"]:checked')].map(input=>Number(input.value));
  if (!correct.length) return alert('Choisissez au moins une bonne réponse.');
  try {
    await createFinalExamQuestion(form.elements.exam_id.value,{body:form.elements.body.value.trim(),points:Number(form.elements.points.value),correct,answers:Array.from({length:count},(_,index)=>form.elements[`answer_${index}`].value.trim())});
    await showExam(form.elements.exam_id.value,false);
  } catch (error) { alert(error.message); }
}

async function editQuestion(exam, questionId) {
  const question = (exam.questions||[]).find(item=>item.id===questionId);
  if (!question) return;
  const options = [...(question.options||[])].sort((a,b)=>String(a.label).localeCompare(String(b.label)));
  const body = prompt('Question :',question.body); if (body===null) return;
  const points = prompt('Points :',String(question.points)); if (points===null) return;
  const answers = [];
  for (const option of options) { const answer=prompt(`Proposition ${option.label} :`,option.body); if(answer===null)return; answers.push(answer.trim()); }
  const initial = options.filter(option=>option.is_correct).map(option=>option.label).join(',');
  const correctText = prompt('Bonne(s) réponse(s), séparées par des virgules (ex. A,C) :',initial); if(correctText===null)return;
  const correct = correctText.toUpperCase().split(/[^A-F]+/).filter(Boolean).map(label=>answerLabels.indexOf(label)).filter(index=>index>=0&&index<answers.length);
  if (!correct.length) return alert('Indiquez au moins une bonne réponse.');
  try { await updateFinalExamQuestion(questionId,{body:body.trim(),points:Number(points),answers,correct}); await showExam(exam.id,false); }
  catch (error) { alert(error.message); }
}

async function removeQuestion(examId, questionId) {
  if (!confirm('Supprimer cette question ?')) return;
  try { await deleteFinalExamQuestion(questionId); await showExam(examId,false); }
  catch (error) { alert(error.message); }
}

async function changeStatus(examId, status) {
  const message = status === 'open' ? 'Ouvrir cet examen Expérience aux apprenants ?' : 'Clôturer cet examen Expérience ?';
  if (!confirm(message)) return;
  try { await updateFinalExam(examId,{status}); await renderList(); }
  catch (error) { alert(error.message); }
}

const observer = new MutationObserver(install);
observer.observe(document.querySelector('#app') || document.body,{childList:true,subtree:true});
install();
