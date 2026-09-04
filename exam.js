const app = document.querySelector('#examApp');
const examCode = (new URLSearchParams(location.search).get('exam') || '').trim().toUpperCase();
let currentState = null;
let saveQueue = Promise.resolve();
let clock = null;
let currentQuestionIndex = 0;
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function shell(body) {
  app.innerHTML = `<div class="learner-shell animate-in"><header class="learner-header"><span class="learner-brand"><span class="logo brand-logo">TS<img src="/api/branding/logo" alt="Logo de l’organisme"></span><b>Formation</b></span><small>Examen final</small></header><main class="exam-main">${body}</main></div>`;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, { credentials:'same-origin', ...options, headers:{ 'Content-Type':'application/json', ...(options.headers||{}) } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) { const error = new Error(payload?.message || `Erreur (${response.status})`); error.status=response.status; throw error; }
  return payload;
}

function accessChoice() {
  shell(`<div class="login"><p class="eyebrow">Accès individuel</p><h1>Rejoindre l’examen final</h1><div class="card participation-choice"><p class="muted">Votre examen n’est pas projeté sur PowerPoint. Vos réponses sont enregistrées individuellement.</p><button class="choice participation-choice-button" onclick="showKnown()"><span class="choice-icon">🔑</span><b>J’ai un code personnel</b><small>Utiliser mon identité de formation</small></button><button class="choice participation-choice-button" onclick="showNew()"><span class="choice-icon">👋</span><b>C’est ma première participation</b><small>Créer une identité</small></button></div></div>`);
}

function privacyAcknowledgements() {
  return `<fieldset class="privacy-acknowledgements"><legend>Protection de vos données</legend><label class="privacy-choice"><input id="dataProcessingInformed" type="checkbox"><span>Je reconnais avoir été informé(e) du traitement de mes données personnelles nécessaire au suivi et à l’évaluation de ma formation.</span></label><label class="privacy-choice"><input id="privacyPolicyAcknowledged" type="checkbox"><span>Je reconnais avoir pris connaissance de la <a href="/privacy-policy.pdf" target="_blank" rel="noopener">Politique de confidentialité</a>.</span></label></fieldset>`;
}

function privacyPayload() {
  const data_processing_informed=document.querySelector('#dataProcessingInformed')?.checked===true;
  const privacy_policy_acknowledged=document.querySelector('#privacyPolicyAcknowledged')?.checked===true;
  if(!data_processing_informed){alert('Confirmez avoir été informé(e) du traitement de vos données personnelles.');return null}
  if(!privacy_policy_acknowledged){alert('Confirmez avoir pris connaissance de la Politique de confidentialité.');return null}
  return{data_processing_informed,privacy_policy_acknowledged};
}

function showPrivacyConfirmation() {
  shell(`<div class="login"><p class="eyebrow">Mise à jour de l’information</p><h1>Protection de vos données</h1><div class="card"><p class="muted">Votre identité a été reconnue sur cet appareil. Confirmez ces deux informations pour accéder à l’examen.</p>${privacyAcknowledgements()}<p><button class="button" onclick="confirmExamPrivacy()">Continuer →</button></p></div></div>`);
}

function showKnown() {
  shell(`<div class="login"><p class="eyebrow">Identité apprenant</p><h1>Votre code personnel</h1><div class="card"><label>Code personnel</label><input id="personalCode" class="participant-code-input" maxlength="12" placeholder="TS-7K4M-9P2Q">${privacyAcknowledgements()}<p><button class="button" onclick="joinKnown()">Accéder à l’examen →</button></p><button class="button secondary" onclick="accessChoice()">Retour</button></div></div>`);
}

function showNew() {
  shell(`<div class="login"><p class="eyebrow">Première participation</p><h1>Créer votre identité</h1><div class="card"><label>Prénom</label><input id="firstName" autocomplete="given-name"><label>Nom</label><input id="lastName" autocomplete="family-name">${privacyAcknowledgements()}<p><button class="button" onclick="joinNew()">Accéder à l’examen →</button></p><button class="button secondary" onclick="accessChoice()">Retour</button></div></div>`);
}

async function joinKnown() {
  const participant_code=document.querySelector('#personalCode')?.value.trim();
  if(!participant_code)return alert('Saisissez votre code personnel.');
  const privacy=privacyPayload();if(!privacy)return;
  try { await api(`/final-exams/${encodeURIComponent(examCode)}/join`,{method:'POST',body:JSON.stringify({participant_code,...privacy})}); await loadState(); }
  catch(error){alert(error.message)}
}

async function joinNew() {
  const first_name=document.querySelector('#firstName')?.value.trim(),last_name=document.querySelector('#lastName')?.value.trim();
  if(!first_name||!last_name)return alert('Renseignez votre prénom et votre nom.');
  const privacy=privacyPayload();if(!privacy)return;
  try { const joined=await api(`/final-exams/${encodeURIComponent(examCode)}/join`,{method:'POST',body:JSON.stringify({first_name,last_name,...privacy})}); alert(`Conservez votre code personnel : ${joined.learner.participant_code}`); await loadState(); }
  catch(error){alert(error.message)}
}

async function joinRecognized() {
  try { await api(`/final-exams/${encodeURIComponent(examCode)}/join`,{method:'POST',body:'{}'}); await loadState(); }
  catch(error){ if(error.status===428)return showPrivacyConfirmation();if(error.status===401||error.status===400)return accessChoice(); alert(error.message) }
}

async function confirmExamPrivacy(){const privacy=privacyPayload();if(!privacy)return;try{await api(`/final-exams/${encodeURIComponent(examCode)}/join`,{method:'POST',body:JSON.stringify(privacy)});await loadState()}catch(error){alert(error.message)}}

function renderExam(state) {
  currentState=state;
  const attempt=state.attempt;
  if(attempt.submitted_at)return renderResult(state);
  const questions=state.questions||[];
  if(!questions.length){shell('<div class="login"><div class="notice">Cet examen ne contient aucune question.</div></div>');return}
  currentQuestionIndex=Math.min(Math.max(0,currentQuestionIndex),questions.length-1);
  const question=questions[currentQuestionIndex],answered=questions.filter(item=>(item.selected_option_ids||[]).length).length,isLast=currentQuestionIndex===questions.length-1;
  shell(`<section class="exam-header-card card"><div><p class="eyebrow">${esc(state.exam.theme_name)} · ${esc(state.exam.group_name)}</p><h1>${esc(state.exam.title)}</h1><p class="muted">${esc(state.exam.instructions||'Chaque choix est enregistré automatiquement. Vous pouvez revenir sur une question tant que le temps n’est pas écoulé.')}</p></div><div><div id="examTimer" class="timer"></div><small id="answeredProgress" class="exam-answered">${answered}/${questions.length} répondue(s)</small></div></section><div class="exam-progress card"><div><b>Question ${currentQuestionIndex+1}/${questions.length}</b><span>${answered} réponse(s) enregistrée(s) sur ${questions.length}</span></div><div class="exam-progress-track"><span style="width:${Math.round((currentQuestionIndex+1)*100/questions.length)}%"></span></div></div><article class="card exam-question exam-question-page"><div class="row"><h2>Question ${Number(question.position)}</h2><span class="tag orange">${Number(question.points)} point(s)</span></div><p class="question">${esc(question.body)}</p><p class="muted">${question.multiple_answers?'Plusieurs réponses sont attendues.':'Une seule réponse est attendue.'}</p><div class="answers">${question.options.map(option=>`<label class="answer"><input type="${question.multiple_answers?'checkbox':'radio'}" name="q-${question.id}" value="${option.id}" ${(question.selected_option_ids||[]).includes(option.id)?'checked':''} onchange="saveAnswer('${question.id}')"><span class="answer-letter">${esc(option.label)}</span><span class="answer-body">${esc(option.body)}</span></label>`).join('')}</div><div id="save-${question.id}" class="exam-save-state">${(question.selected_option_ids||[]).length?'Réponse enregistrée ✓':'Votre choix sera enregistré automatiquement.'}</div></article><nav class="card exam-navigation" aria-label="Navigation entre les questions"><button class="button secondary" type="button" onclick="goToExamQuestion(-1)" ${currentQuestionIndex===0?'disabled':''}>← Retour</button><span>${currentQuestionIndex+1}/${questions.length}</span>${isLast?'<button class="button" type="button" onclick="submitExam()">Terminer l’examen</button>':'<button class="button" type="button" onclick="goToExamQuestion(1)">Suivant →</button>'}</nav>`);
  startTimer(attempt.expires_at);
}

function startTimer(expiresAt) {
  clearInterval(clock);
  const tick=()=>{const seconds=Math.max(0,Math.ceil((new Date(expiresAt)-Date.now())/1000)),minutes=Math.floor(seconds/60),rest=String(seconds%60).padStart(2,'0'),box=document.querySelector('#examTimer');if(box)box.textContent=`${minutes}:${rest}`;if(seconds<=0){clearInterval(clock);loadState()}};
  tick();clock=setInterval(tick,1000);
}

function selectedFor(questionId){return [...document.querySelectorAll(`[name="q-${questionId}"]:checked`)].map(input=>input.value)}
function saveAnswer(questionId){const selected=selectedFor(questionId),question=(currentState?.questions||[]).find(item=>item.id===questionId);if(question)question.selected_option_ids=selected;const box=document.querySelector(`#save-${questionId}`);if(box)box.textContent='Enregistrement…';const answered=(currentState?.questions||[]).filter(item=>(item.selected_option_ids||[]).length).length,progress=document.querySelector('#answeredProgress');if(progress)progress.textContent=`${answered}/${currentState.questions.length} répondue(s)`;saveQueue=saveQueue.catch(()=>undefined).then(()=>api(`/final-exams/${encodeURIComponent(examCode)}/answers`,{method:'PUT',body:JSON.stringify({question_id:questionId,option_ids:selected})})).then(()=>{const current=document.querySelector(`#save-${questionId}`);if(current)current.textContent='Réponse enregistrée ✓'}).catch(error=>{const current=document.querySelector(`#save-${questionId}`);if(current)current.textContent=error.message})}

async function goToExamQuestion(direction){await saveQueue.catch(()=>undefined);currentQuestionIndex=Math.min(Math.max(0,currentQuestionIndex+direction),(currentState?.questions||[]).length-1);renderExam(currentState);window.scrollTo({top:0,behavior:'smooth'})}

async function submitExam(event){event?.preventDefault?.();const total=currentState?.questions?.length||0,answered=currentState?.questions?.filter(question=>(question.selected_option_ids||[]).length).length||0;if(!confirm(`Terminer définitivement l’examen ?\n\n${answered} question(s) répondue(s) sur ${total}. Les questions sans réponse compteront pour 0.`))return;try{await saveQueue;await api(`/final-exams/${encodeURIComponent(examCode)}/submit`,{method:'POST',body:'{}'});await loadState()}catch(error){alert(error.message)}}

function renderResult(state){clearInterval(clock);shell(`<div class="login center"><p class="eyebrow">Examen terminé</p><div class="card exam-result-card"><span class="exam-result-icon">✓</span><h1>Copie enregistrée</h1><p class="score-final">Votre note : <b>${Number(state.attempt.score_percent||0).toFixed(1).replace('.',',')} %</b><span>${Number(state.attempt.score_points||0)} point(s) obtenu(s)</span></p><p class="muted">Ce résultat sera intégré au score global selon le barème défini par l’instructeur.</p></div></div>`)}

async function loadState(){try{const state=await api(`/final-exams/${encodeURIComponent(examCode)}/state`);renderExam(state)}catch(error){if(error.status===401||error.status===404)return joinRecognized();shell(`<div class="login"><div class="notice">${esc(error.message)}</div></div>`)}}
async function start(){if(!examCode){shell('<div class="login"><div class="notice">Lien d’examen incomplet.</div></div>');return}try{await loadState()}catch{accessChoice()}}

Object.assign(window,{accessChoice,showKnown,showNew,joinKnown,joinNew,confirmExamPrivacy,saveAnswer,goToExamQuestion,submitExam});
start();
