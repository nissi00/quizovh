import { getSurveyQuestionnaire, surveyQuestionVisible } from './survey-questionnaires.js?v=survey-types-1';

const app = document.querySelector('#surveyApp');
const code = (new URLSearchParams(location.search).get('survey') || '').trim().toUpperCase();

let survey = null;
let questionnaire = null;
let questions = [];
let index = Number(sessionStorage.getItem(`ts-survey-index-${code}`) || 0);
let answers = {};
try { answers = JSON.parse(sessionStorage.getItem(`ts-survey-draft-${code}`) || '{}'); } catch { answers = {}; }

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00`).toLocaleDateString('fr-FR') : '—';

function shell(body) {
  app.innerHTML = `<div class="survey-shell"><header class="survey-header"><span class="survey-brand"><span class="survey-logo">TS</span><b>Formation</b></span><span>${esc(questionnaire?.title || 'Enquête de satisfaction')}</span></header><main class="survey-main">${body}</main></div>`;
}

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials:'same-origin',
    ...options,
    headers:{'Content-Type':'application/json', ...(options.headers || {})}
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.message || `Erreur du serveur (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function metadata() {
  return `<div class="survey-meta"><div><span>Intitulé de la formation</span><b>${esc(survey.formation_title)}</b></div><div><span>Dates de la session</span><b>Du ${formatDate(survey.start_date)} au ${formatDate(survey.end_date)}</b></div><div><span>Nom du formateur</span><b>${esc(survey.trainer_name)}</b></div></div>`;
}

function informationField(item) {
  let value = answers[item.id] || '';
  if (item.id === 'interview_date' && !value) {
    const now = new Date();
    value = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
  }
  const control = item.type === 'choice'
    ? `<select id="field-${item.id}" name="${item.id}" required><option value="">Sélectionnez votre statut</option>${item.options.map(option => `<option value="${esc(option)}" ${value===option?'selected':''}>${esc(option)}</option>`).join('')}</select>`
    : `<input id="field-${item.id}" name="${item.id}" type="${item.type==='date'?'date':'text'}" maxlength="${item.maxLength}" value="${esc(value)}" ${item.required?'required':''}>`;
  return `<label for="field-${item.id}">${esc(item.label)}${item.required?' *':''}${control}</label>`;
}

function intro() {
  questions = questionnaire.questions.filter(question => surveyQuestionVisible(question, answers));
  const note = questionnaire.type === 'trainee' ? '16 questions · environ 3 minutes' : questionnaire.staffOnly ? 'Un formulaire par entretien' : `${questionnaire.questions.length} questions`;
  shell(`<section class="survey-intro card"><p class="eyebrow">${esc(questionnaire.reference)} · QUESTIONNAIRE DE SATISFACTION</p><h1>${questionnaire.type==='trainee'?'Votre avis compte':esc(questionnaire.title)}</h1><p>${esc(questionnaire.introduction)}</p>${metadata()}<form id="surveyIntroForm"><div class="survey-information">${questionnaire.fields.map(informationField).join('')}</div>${questionnaire.fields.length?'<p class="muted">* Champs obligatoires. Les informations saisies sont accessibles à l’équipe chargée de cette formation.</p>':''}<p class="survey-note">${note}</p><button class="button survey-primary" id="startSurvey" type="submit">${questionnaire.staffOnly?'Commencer l’entretien':'Commencer'}</button></form></section>`);
  document.querySelector('#surveyIntroForm')?.addEventListener('submit', event => {
    event.preventDefault();
    for (const item of questionnaire.fields) answers[item.id] = document.querySelector(`#field-${item.id}`).value.trim();
    if (answers.period_start && answers.period_end && answers.period_end < answers.period_start) return alert('La fin de la période évaluée doit suivre son début.');
    saveDraft();
    index = Math.min(Math.max(index,0),questions.length-1);
    renderQuestion();
  });
}

function saveDraft() {
  sessionStorage.setItem(`ts-survey-draft-${code}`, JSON.stringify(answers));
  sessionStorage.setItem(`ts-survey-index-${code}`, String(index));
}

function captureCurrent(required = true) {
  const question = questions[index];
  if (!question) return true;
  if (question.type === 'text') {
    answers[question.id] = document.querySelector('#surveyText')?.value.trim() || '';
  } else if (question.type === 'multiple') {
    const values = [...document.querySelectorAll('input[name="surveyAnswer"]:checked')].map(input => input.value);
    if (!values.length && required) return false;
    answers[question.id] = values;
    answers[question.otherKey] = document.querySelector('#surveyOther')?.value.trim() || '';
    if (required && values.includes('Autre') && !answers[question.otherKey]) {
      return false;
    }
  } else {
    const selected = document.querySelector('input[name="surveyAnswer"]:checked');
    if (!selected) return !required;
    answers[question.id] = question.type === 'rating' ? Number(selected.value) : selected.value;
  }
  saveDraft();
  return true;
}

function answerHtml(question) {
  if (question.type === 'text') {
    return `<textarea id="surveyText" class="survey-textarea" maxlength="2000" rows="7" placeholder="${esc(question.placeholder || '')}">${esc(answers[question.id] || '')}</textarea><small class="muted">2 000 caractères maximum.</small>`;
  }
  if (question.type === 'rating') {
    return `<div class="survey-rating" role="radiogroup">${question.options.map(value => `<label><input type="radio" name="surveyAnswer" value="${value}" ${Number(answers[question.id])===value?'checked':''}><span>${value}</span></label>`).join('')}</div>`;
  }
  const multiple = question.type === 'multiple';
  const selected = answers[question.id];
  const options = `<div class="survey-options">${question.options.map(value => `<label class="survey-option"><input type="${multiple?'checkbox':'radio'}" name="surveyAnswer" value="${esc(value)}" ${(multiple?Array.isArray(selected)&&selected.includes(value):selected===value)?'checked':''}><span>${esc(value)}</span></label>`).join('')}</div>`;
  return options + (multiple ? `<p class="muted">Plusieurs choix possibles. « ${esc(question.exclusive)} » se sélectionne seul.</p><label class="survey-other" ${Array.isArray(selected)&&selected.includes('Autre')?'':'hidden'}>Précisez « Autre »<textarea id="surveyOther" class="survey-textarea" maxlength="2000" rows="3">${esc(answers[question.otherKey] || '')}</textarea></label>` : '');
}

function renderQuestion() {
  questions = questionnaire.questions.filter(question => surveyQuestionVisible(question, answers));
  const question = questions[index];
  if (!question) return intro();
  const percent = Math.round(((index + 1) / questions.length) * 100);
  shell(`<section class="survey-question-card card"><div class="survey-progress-copy"><span>Question ${index + 1} sur ${questions.length}</span><b>${percent}%</b></div><div class="survey-progress"><span style="width:${percent}%"></span></div><p class="survey-section">${esc(question.section)}</p><h1>${esc(question.label)}</h1>${question.note?`<p class="muted">${esc(question.note)}</p>`:''}${answerHtml(question)}<div class="survey-actions"><button class="button secondary" id="surveyBack" type="button" ${index===0 && !questionnaire.fields.length?'disabled':''}>${index===0?'← Informations':'← Retour'}</button><button class="button survey-primary" id="surveyNext" type="button">${index===questions.length-1?'Envoyer mon enquête':'Suivant →'}</button></div></section>`);
  document.querySelector('#surveyBack')?.addEventListener('click', () => {
    captureCurrent(false);
    if (index===0) return intro();
    index = Math.max(0,index-1); saveDraft(); renderQuestion();
  });
  document.querySelector('#surveyNext')?.addEventListener('click', next);
  if (question.type === 'multiple') document.querySelectorAll('input[name="surveyAnswer"]').forEach(input => input.addEventListener('change', () => {
    if (input.checked) document.querySelectorAll('input[name="surveyAnswer"]').forEach(other => {
      if (other !== input && (input.value===question.exclusive || other.value===question.exclusive)) other.checked = false;
    });
    document.querySelector('.survey-other').hidden = !document.querySelector('input[name="surveyAnswer"][value="Autre"]:checked');
  }));
}

async function next() {
  if (!captureCurrent()) {
    alert(questions[index]?.type === 'multiple' ? 'Choisissez une réponse et précisez « Autre » si vous le sélectionnez.' : 'Choisissez une réponse avant de continuer.');
    return;
  }
  questions = questionnaire.questions.filter(question => surveyQuestionVisible(question, answers));
  if (index < questions.length - 1) {
    index += 1; saveDraft(); renderQuestion(); return;
  }
  await submitSurvey();
}

function responseToken() {
  const key = `ts-survey-response-token-${code}`;
  let token = localStorage.getItem(key);
  if (!token) {
    if (crypto.randomUUID) token = crypto.randomUUID();
    else {
      const bytes = crypto.getRandomValues(new Uint8Array(24));
      token = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    }
    localStorage.setItem(key, token);
  }
  return token;
}

async function submitSurvey() {
  const button = document.querySelector('#surveyNext');
  if (button) { button.disabled = true; button.textContent = 'Envoi…'; }
  try {
    await request(`/satisfaction-surveys/public/${encodeURIComponent(code)}/responses`, {
      method:'POST',
      body:JSON.stringify({ response_token: responseToken(), answers })
    });
    sessionStorage.removeItem(`ts-survey-draft-${code}`);
    sessionStorage.removeItem(`ts-survey-index-${code}`);
    thanks(false);
  } catch (error) {
    if (error.status === 409 && /déjà/i.test(error.message)) return thanks(true);
    alert(error.message);
    if (button) { button.disabled = false; button.textContent = 'Envoyer mon enquête'; }
  }
}

function thanks(already) {
  const message = questionnaire.staffOnly ? 'L’entretien a bien été enregistré.' : 'Votre réponse a bien été enregistrée.';
  shell(`<section class="survey-intro card center"><div class="survey-thanks-icon">✓</div><p class="eyebrow">${already?'RÉPONSE DÉJÀ ENREGISTRÉE':'MERCI POUR VOTRE RETOUR'}</p><h1>${already?'Votre enquête a déjà été transmise.':message}</h1><p>${already?'Cette réponse a déjà été enregistrée.':'Tech Systèmes vous remercie pour votre confiance et pour le temps accordé à ce retour d’expérience.'}</p>${questionnaire.staffOnly?'<button class="button survey-primary" id="newSurveyInterview" type="button">Saisir un autre entretien</button>':''}</section>`);
  document.querySelector('#newSurveyInterview')?.addEventListener('click', () => {
    const interviewer = answers.interviewer_name;
    answers = { interviewer_name:interviewer || '' };
    index = 0;
    localStorage.removeItem(`ts-survey-response-token-${code}`);
    saveDraft();
    intro();
  });
}

async function start() {
  if (!code || !/^[A-Z0-9]{8}$/.test(code)) {
    return shell('<section class="card survey-intro"><h1>Lien d’enquête incomplet</h1><p>Utilisez le lien ou le QR code de l’enquête.</p></section>');
  }
  try {
    survey = await request(`/satisfaction-surveys/public/${encodeURIComponent(code)}`);
    questionnaire = getSurveyQuestionnaire(survey.survey_type || 'trainee');
    if (!questionnaire) throw new Error('Questionnaire indisponible.');
    if (survey.status !== 'open') {
      return shell(`<section class="card survey-intro"><p class="eyebrow">ENQUÊTE DE SATISFACTION</p><h1>Cette enquête est clôturée.</h1>${metadata()}</section>`);
    }
    intro();
  } catch (error) {
    shell(`<section class="card survey-intro"><h1>Enquête indisponible</h1><p>${esc(error.message)}</p>${error.status===401?'<p>Le suivi après formation est renseigné par l’équipe chargée des entretiens.</p><a class="button" href="./instructor.html" target="_blank" rel="noopener">Ouvrir l’espace instructeur</a><button class="button secondary" id="retrySurvey" type="button">Actualiser après connexion</button>':''}</section>`);
    document.querySelector('#retrySurvey')?.addEventListener('click', start);
  }
}

start();
