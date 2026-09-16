const statisticsState = {
  open:false,
  catalog:null,
  kind:'quiz',
  themeId:'',
  groupId:'',
  evaluationId:'',
  search:'',
  result:null,
  detail:null,
  participantPage:0,
  questionPage:0,
  loading:false
};

const participantPageSize = 10;
const questionPageSize = 5;
const statisticsEsc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

async function statisticsApi(path, options={}) {
  const response = await fetch(`/api/statistics${path}`, {
    credentials:'same-origin',
    ...options,
    headers:{'Content-Type':'application/json',...(options.headers||{})}
  });
  const payload = await response.json().catch(()=>null);
  if (!response.ok) throw new Error(payload?.message || `Erreur (${response.status})`);
  return payload;
}

function statisticsDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short'}).format(date) : '—';
}

function statisticsTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return 'Non disponible';
  const seconds = Math.max(0,Math.round(Number(ms)/1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds/60),rest=seconds%60;
  return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
}

function statisticsScore(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'En cours';
  const rounded=Math.round(Number(value)*10)/10;
  return `${String(rounded).replace('.',',')} %`;
}

function statisticsStatus(question) {
  if (question.status === 'correct') return {label:'Correcte',icon:'✓',cls:'is-correct'};
  if (question.status === 'partial') return {label:'Partielle',icon:'◐',cls:'is-partial'};
  if (question.status === 'incorrect') return {label:'Incorrecte',icon:'✕',cls:'is-incorrect'};
  return {label:'Non répondue',icon:'—',cls:'is-unanswered'};
}

function ensureStatisticsPanel() {
  const sidebar=document.querySelector('.sidebar');
  const section=document.querySelector('.layout>section');
  if (!sidebar || !section) return;

  let button=document.querySelector('[data-statistics-nav="true"]');
  if (!button) {
    button=document.createElement('button');
    button.type='button';
    button.className='nav-button';
    button.dataset.statisticsNav='true';
    button.textContent='📊 Statistiques';
    button.addEventListener('click',()=>openStatisticsPanel());
    const performance=[...sidebar.querySelectorAll('.nav-button')].find(item=>item.getAttribute('onclick')?.includes("'performance'"));
    if (performance) performance.insertAdjacentElement('afterend',button);
    else {
      const logout=[...sidebar.querySelectorAll('.nav-button')].find(item=>item.getAttribute('onclick')?.includes('logout'));
      sidebar.insertBefore(button,logout||null);
    }
  }

  if (!document.querySelector('#statistics')) {
    section.insertAdjacentHTML('beforeend',`<div id="statistics" class="panel statistics-panel"><div class="row statistics-title-row"><div><p class="eyebrow">Analyse détaillée</p><h1>Statistiques</h1><p class="muted">Consultez les réponses de chaque apprenant, question par question.</p></div><button class="button secondary" type="button" id="statisticsRefresh">↻ Actualiser</button></div><div id="statisticsContent"></div></div>`);
    document.querySelector('#statisticsRefresh')?.addEventListener('click',()=>statisticsRefresh(true));
  }
  if (statisticsState.open) activateStatisticsPanel();
}

function activateStatisticsPanel() {
  document.querySelectorAll('.panel').forEach(panel=>panel.classList.toggle('active',panel.id==='statistics'));
  document.querySelectorAll('.nav-button').forEach(button=>button.classList.remove('active'));
  document.querySelector('[data-statistics-nav="true"]')?.classList.add('active');
}

async function openStatisticsPanel() {
  statisticsState.open=true;
  ensureStatisticsPanel();
  activateStatisticsPanel();
  if (!statisticsState.catalog) await statisticsRefresh(false);
  else renderStatistics();
}

function statisticsEvaluations() {
  const source=statisticsState.kind==='exam' ? (statisticsState.catalog?.exams||[]) : (statisticsState.catalog?.sessions||[]);
  return source.filter(item => (!statisticsState.themeId || item.theme_id===statisticsState.themeId) && (!statisticsState.groupId || item.group_id===statisticsState.groupId));
}

function statisticsGroups() {
  const groups=statisticsState.catalog?.groups||[];
  if (!statisticsState.themeId) return groups;
  return groups.filter(group=>group.theme_id===statisticsState.themeId);
}

function statisticsEvaluationLabel(item) {
  if (statisticsState.kind==='exam') return `${item.title} · ${item.group_name}`;
  const date=new Date(item.created_at);
  const short=Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('fr-FR').format(date) : '';
  return `${item.chapter_title} · ${item.quiz_title} · ${item.group_name||'Sans groupe'}${short?` · ${short}`:''}`;
}

function renderStatisticsFilters() {
  const themes=statisticsState.catalog?.themes||[];
  const groups=statisticsGroups();
  const evaluations=statisticsEvaluations();
  if (statisticsState.evaluationId && !evaluations.some(item=>item.id===statisticsState.evaluationId)) statisticsState.evaluationId='';
  return `<section class="card statistics-filters"><div class="statistics-filter-grid">
    <label><span>Type de résultat</span><select id="statisticsKind"><option value="quiz" ${statisticsState.kind==='quiz'?'selected':''}>Quiz standard</option><option value="exam" ${statisticsState.kind==='exam'?'selected':''}>Examen final</option></select></label>
    <label><span>Thème</span><select id="statisticsTheme"><option value="">Tous les thèmes</option>${themes.map(theme=>`<option value="${theme.id}" ${statisticsState.themeId===theme.id?'selected':''}>${statisticsEsc(theme.name)}</option>`).join('')}</select></label>
    <label><span>Groupe</span><select id="statisticsGroup"><option value="">Tous les groupes</option>${groups.map(group=>`<option value="${group.id}" ${statisticsState.groupId===group.id?'selected':''}>${statisticsEsc(group.name)}</option>`).join('')}</select></label>
    <label class="statistics-evaluation-filter"><span>${statisticsState.kind==='exam'?'Examen':'Session / quiz'}</span><select id="statisticsEvaluation"><option value="">Sélectionnez ${statisticsState.kind==='exam'?'un examen':'une session'}</option>${evaluations.map(item=>`<option value="${item.id}" ${statisticsState.evaluationId===item.id?'selected':''}>${statisticsEsc(statisticsEvaluationLabel(item))}</option>`).join('')}</select></label>
    <label class="statistics-search-filter"><span>Apprenant</span><input id="statisticsSearch" type="search" value="${statisticsEsc(statisticsState.search)}" placeholder="Nom, prénom ou code personnel"></label>
  </div></section>`;
}

function bindStatisticsFilters() {
  const kind=document.querySelector('#statisticsKind');
  const theme=document.querySelector('#statisticsTheme');
  const group=document.querySelector('#statisticsGroup');
  const evaluation=document.querySelector('#statisticsEvaluation');
  const search=document.querySelector('#statisticsSearch');
  kind?.addEventListener('change',()=>{
    statisticsState.kind=kind.value;
    statisticsState.themeId='';statisticsState.groupId='';statisticsState.evaluationId='';statisticsState.result=null;statisticsState.detail=null;statisticsState.participantPage=0;
    renderStatistics();
  });
  theme?.addEventListener('change',()=>{
    statisticsState.themeId=theme.value;statisticsState.groupId='';statisticsState.evaluationId='';statisticsState.result=null;statisticsState.detail=null;statisticsState.participantPage=0;
    renderStatistics();
  });
  group?.addEventListener('change',()=>{
    statisticsState.groupId=group.value;statisticsState.evaluationId='';statisticsState.result=null;statisticsState.detail=null;statisticsState.participantPage=0;
    renderStatistics();
  });
  evaluation?.addEventListener('change',()=>{
    statisticsState.evaluationId=evaluation.value;statisticsState.result=null;statisticsState.detail=null;statisticsState.participantPage=0;
    if (evaluation.value) loadStatisticsResults(); else renderStatistics();
  });
  search?.addEventListener('input',()=>{
    statisticsState.search=search.value;statisticsState.participantPage=0;renderStatisticsParticipantsOnly();
  });
}

function statisticsFilteredParticipants() {
  const participants=statisticsState.result?.participants||[];
  const needle=statisticsState.search.trim().toLocaleLowerCase('fr');
  if (!needle) return participants;
  return participants.filter(item=>`${item.first_name||''} ${item.last_name||''} ${item.participant_code||''}`.toLocaleLowerCase('fr').includes(needle));
}

function statisticsParticipantPagination(total) {
  if (total<=participantPageSize) return '';
  const pages=Math.max(1,Math.ceil(total/participantPageSize));
  statisticsState.participantPage=Math.min(statisticsState.participantPage,pages-1);
  return `<nav class="statistics-pagination" aria-label="Pagination des apprenants"><span>Page ${statisticsState.participantPage+1} sur ${pages}</span><button type="button" class="icon-button" onclick="statisticsParticipantPage(-1)" ${statisticsState.participantPage===0?'disabled':''}>‹</button><button type="button" class="icon-button" onclick="statisticsParticipantPage(1)" ${statisticsState.participantPage>=pages-1?'disabled':''}>›</button></nav>`;
}

function statisticsEvaluationSummary() {
  const evaluation=statisticsState.result?.evaluation;
  if (!evaluation) return '';
  const title=statisticsState.kind==='exam' ? evaluation.title : `${evaluation.chapter_title} · ${evaluation.quiz_title}`;
  const subtitle=`${evaluation.theme_name}${evaluation.group_name?` · ${evaluation.group_name}`:''}`;
  return `<section class="card statistics-evaluation-summary"><div><span class="tag">${statisticsState.kind==='exam'?'Examen final':'Quiz standard'}</span><h2>${statisticsEsc(title)}</h2><p class="muted">${statisticsEsc(subtitle)}</p></div><div class="statistics-summary-side"><b>${(statisticsState.result.participants||[]).length}</b><span>apprenant(s)</span></div></section>`;
}

function statisticsParticipantsHtml() {
  if (!statisticsState.result) return `<div class="card empty statistics-empty">Sélectionnez ${statisticsState.kind==='exam'?'un examen':'une session'} pour afficher les résultats.</div>`;
  const filtered=statisticsFilteredParticipants();
  const pages=Math.max(1,Math.ceil(filtered.length/participantPageSize));
  statisticsState.participantPage=Math.min(statisticsState.participantPage,pages-1);
  const start=statisticsState.participantPage*participantPageSize;
  const visible=filtered.slice(start,start+participantPageSize);
  return `${statisticsEvaluationSummary()}<div class="statistics-list-head"><div><h2>Participants</h2><p class="muted">${filtered.length} résultat(s) correspondant aux filtres.</p></div>${statisticsParticipantPagination(filtered.length)}</div><div class="statistics-participant-list">${visible.map(item=>{
    const score=statisticsScore(item.score_percent);
    const answered=Number(item.answered_count||0),total=Number(item.question_count||0);
    return `<article class="card statistics-participant-row"><div class="statistics-person"><b>${statisticsEsc(item.first_name)} ${statisticsEsc(item.last_name)}</b><small>${statisticsEsc(item.participant_code||'')}</small></div><div class="statistics-metric"><small>Score</small><strong>${score}</strong></div><div class="statistics-metric"><small>Réponses</small><strong>${answered}/${total}</strong></div><div class="statistics-metric statistics-date"><small>Activité</small><span>${statisticsDate(item.activity_at)}</span></div><button class="button secondary statistics-detail-button" type="button" onclick="statisticsViewDetail('${item.user_id}')">Voir le détail →</button></article>`;
  }).join('')||'<div class="card empty">Aucun apprenant ne correspond à cette recherche.</div>'}</div>${statisticsParticipantPagination(filtered.length)}`;
}

function renderStatisticsParticipantsOnly() {
  const target=document.querySelector('#statisticsResults');
  if (target) target.innerHTML=statisticsParticipantsHtml();
}

function statisticsQuestionPagination(total) {
  if (total<=questionPageSize) return '';
  const pages=Math.max(1,Math.ceil(total/questionPageSize));
  statisticsState.questionPage=Math.min(statisticsState.questionPage,pages-1);
  return `<nav class="statistics-pagination statistics-question-pagination" aria-label="Pagination des questions"><span>Questions ${statisticsState.questionPage*questionPageSize+1}–${Math.min((statisticsState.questionPage+1)*questionPageSize,total)} sur ${total}</span><button type="button" class="icon-button" onclick="statisticsQuestionPage(-1)" ${statisticsState.questionPage===0?'disabled':''}>‹</button><button type="button" class="icon-button" onclick="statisticsQuestionPage(1)" ${statisticsState.questionPage>=pages-1?'disabled':''}>›</button></nav>`;
}

function statisticsQuestionCard(question) {
  const state=statisticsStatus(question);
  const selected=new Set(question.selected_option_ids||[]);
  return `<details class="card statistics-question ${state.cls}"><summary><span class="statistics-question-state">${state.icon}</span><span class="statistics-question-title"><b>Q${question.display_position}</b><small>${statisticsEsc(state.label)}</small></span><span class="statistics-question-points">${Number(question.points_earned||0)} / ${Number(question.possible_points||0)} pt</span><span class="statistics-question-time">⏱ ${statisticsTime(question.response_time_ms)}</span><span class="statistics-chevron">⌄</span></summary><div class="statistics-question-content"><p class="statistics-question-body">${statisticsEsc(question.body)}</p><div class="statistics-answer-list">${(question.options||[]).map(option=>{
    const chosen=selected.has(option.id),correct=option.is_correct===true;
    const cls=[chosen?'is-selected':'',correct?'is-answer-correct':'',chosen&&!correct?'is-selected-wrong':''].filter(Boolean).join(' ');
    return `<div class="statistics-answer ${cls}"><span class="statistics-answer-letter">${statisticsEsc(option.label)}</span><span class="statistics-answer-body">${statisticsEsc(option.body)}</span><span class="statistics-answer-flags">${chosen?'<em>Réponse choisie</em>':''}${correct?'<em class="correct-flag">Bonne réponse</em>':''}</span></div>`;
  }).join('')}</div><div class="statistics-question-footer"><span><b>Résultat :</b> ${statisticsEsc(state.label)}</span><span><b>Temps pour répondre :</b> ${statisticsTime(question.response_time_ms)}</span></div></div></details>`;
}

function statisticsDetailHtml() {
  const detail=statisticsState.detail;
  if (!detail) return '';
  const questions=detail.questions||[];
  const pages=Math.max(1,Math.ceil(questions.length/questionPageSize));
  statisticsState.questionPage=Math.min(statisticsState.questionPage,pages-1);
  const start=statisticsState.questionPage*questionPageSize;
  const visible=questions.slice(start,start+questionPageSize);
  const learner=detail.learner||{},summary=detail.summary||{},evaluation=detail.evaluation||{};
  const evaluationTitle=evaluation.kind==='exam' ? evaluation.title : `${evaluation.chapter_title} · ${evaluation.quiz_title}`;
  return `<div class="statistics-detail"><button type="button" class="button secondary statistics-back" onclick="statisticsBackToParticipants()">← Retour aux participants</button><section class="card statistics-copy-header"><div><p class="eyebrow">${statisticsEsc(evaluationTitle)}</p><h2>${statisticsEsc(learner.first_name)} ${statisticsEsc(learner.last_name)}</h2><p class="muted">${statisticsEsc(learner.participant_code||'')} · ${statisticsEsc(evaluation.group_name||'')}</p></div><div class="statistics-copy-metrics"><div><small>Score</small><strong>${statisticsScore(summary.score_percent)}</strong></div><div><small>Bonnes réponses</small><strong>${Number(summary.correct_count||0)}/${Number(summary.question_count||0)}</strong></div><div><small>Répondues</small><strong>${Number(summary.answered_count||0)}/${Number(summary.question_count||0)}</strong></div></div></section><div class="statistics-questions-head"><div><h2>Détail des réponses</h2><p class="muted">Ouvrez une question pour voir les choix de l’apprenant et la bonne réponse.</p></div>${statisticsQuestionPagination(questions.length)}</div><div class="statistics-question-list">${visible.map(statisticsQuestionCard).join('')||'<div class="card empty">Aucune question disponible.</div>'}</div>${statisticsQuestionPagination(questions.length)}</div>`;
}

function renderStatistics() {
  const content=document.querySelector('#statisticsContent');
  if (!content) return;
  if (statisticsState.detail) {
    content.innerHTML=statisticsDetailHtml();
    return;
  }
  content.innerHTML=`${renderStatisticsFilters()}<div id="statisticsResults">${statisticsState.loading?'<div class="card empty">Chargement des statistiques…</div>':statisticsParticipantsHtml()}</div>`;
  bindStatisticsFilters();
}

async function statisticsRefresh(reloadResults=true) {
  statisticsState.loading=true;
  renderStatistics();
  try {
    statisticsState.catalog=await statisticsApi('/catalog');
    if (reloadResults && statisticsState.evaluationId) await loadStatisticsResults(false);
  } catch(error) {
    const content=document.querySelector('#statisticsContent');
    if(content)content.innerHTML=`<div class="notice">${statisticsEsc(error.message)}</div>`;
  } finally {
    statisticsState.loading=false;
    renderStatistics();
  }
}

async function loadStatisticsResults(renderLoading=true) {
  if (!statisticsState.evaluationId) return;
  statisticsState.detail=null;
  statisticsState.loading=true;
  if(renderLoading)renderStatistics();
  try {
    const query=statisticsState.kind==='exam'?`?kind=exam&exam_id=${encodeURIComponent(statisticsState.evaluationId)}`:`?kind=quiz&session_id=${encodeURIComponent(statisticsState.evaluationId)}`;
    statisticsState.result=await statisticsApi(`/results${query}`);
  } catch(error) {
    statisticsState.result=null;
    const target=document.querySelector('#statisticsResults');
    if(target)target.innerHTML=`<div class="notice">${statisticsEsc(error.message)}</div>`;
  } finally {
    statisticsState.loading=false;
    renderStatistics();
  }
}

async function statisticsViewDetail(userId) {
  statisticsState.loading=true;
  const target=document.querySelector('#statisticsResults');
  if(target)target.innerHTML='<div class="card empty">Chargement de la copie détaillée…</div>';
  try {
    const query=statisticsState.kind==='exam'?`?kind=exam&exam_id=${encodeURIComponent(statisticsState.evaluationId)}&user_id=${encodeURIComponent(userId)}`:`?kind=quiz&session_id=${encodeURIComponent(statisticsState.evaluationId)}&user_id=${encodeURIComponent(userId)}`;
    statisticsState.detail=await statisticsApi(`/detail${query}`);
    statisticsState.questionPage=0;
  } catch(error) {
    alert(error.message);
  } finally {
    statisticsState.loading=false;
    renderStatistics();
    document.querySelector('#statistics')?.scrollIntoView({behavior:'smooth',block:'start'});
  }
}

function statisticsBackToParticipants() {
  statisticsState.detail=null;
  statisticsState.questionPage=0;
  renderStatistics();
}

function statisticsParticipantPage(direction) {
  const total=statisticsFilteredParticipants().length,pages=Math.max(1,Math.ceil(total/participantPageSize));
  statisticsState.participantPage=Math.min(Math.max(0,statisticsState.participantPage+direction),pages-1);
  renderStatisticsParticipantsOnly();
}

function statisticsQuestionPage(direction) {
  const total=statisticsState.detail?.questions?.length||0,pages=Math.max(1,Math.ceil(total/questionPageSize));
  statisticsState.questionPage=Math.min(Math.max(0,statisticsState.questionPage+direction),pages-1);
  renderStatistics();
  document.querySelector('.statistics-questions-head')?.scrollIntoView({behavior:'smooth',block:'start'});
}

Object.assign(window,{openStatisticsPanel,statisticsViewDetail,statisticsBackToParticipants,statisticsParticipantPage,statisticsQuestionPage});

let statisticsInjectScheduled=false;
const statisticsObserver=new MutationObserver(()=>{
  if(statisticsInjectScheduled)return;
  statisticsInjectScheduled=true;
  requestAnimationFrame(()=>{statisticsInjectScheduled=false;ensureStatisticsPanel()});
});
statisticsObserver.observe(document.documentElement,{childList:true,subtree:true});
ensureStatisticsPanel();
