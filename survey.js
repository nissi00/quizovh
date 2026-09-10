const app = document.querySelector('#surveyApp');
const code = (new URLSearchParams(location.search).get('survey') || '').trim().toUpperCase();

const questions = [
  { id:'organization_information', section:'1. ORGANISATION ET LOGISTIQUE', label:'Information préalable (programme, convocation, accès)', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'organization_schedule', section:'1. ORGANISATION ET LOGISTIQUE', label:'Respect des horaires et du déroulement de la session', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'organization_facilities', section:'1. ORGANISATION ET LOGISTIQUE', label:'Qualité des locaux, équipements et moyens matériels', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'content_expectations', section:'2. CONTENU ET PEDAGOGIE', label:'Adéquation du programme avec vos attentes', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'content_theory', section:'2. CONTENU ET PEDAGOGIE', label:'Clarté des explications théoriques', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'content_exercises', section:'2. CONTENU ET PEDAGOGIE', label:'Qualité et utilité des exercices', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'content_materials', section:'2. CONTENU ET PEDAGOGIE', label:'Qualité des supports de cours remis', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'trainer_mastery', section:'3. ANIMATION PAR LE FORMATEUR', label:"Maîtrise du sujet par l'intervenant", type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'trainer_availability', section:'3. ANIMATION PAR LE FORMATEUR', label:'Disponibilité, écoute et réponse aux questions', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'trainer_exercises', section:'3. ANIMATION PAR LE FORMATEUR', label:'Qualité et utilité des exercices', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'trainer_dynamics', section:'3. ANIMATION PAR LE FORMATEUR', label:'Dynamisme et rythme de la formation', type:'choice', options:['Très satisfait','Satisfait','Peu satisfait','Insatisfait'] },
  { id:'objectives_achieved', section:'4. ATTEINTE DES OBJECTIFS ET ACQUIS DE LA FORMATION', label:'Estimé-vous avoir atteint les objectifs de la formation ?', type:'choice', options:['Oui, tout à fait','En grande partie','Partiellement','Pas du tout'] },
  { id:'objectives_apply', section:'4. ATTEINTE DES OBJECTIFS ET ACQUIS DE LA FORMATION', label:'Allez-vous pouvoir appliquer ces acquis dans votre travail ?', type:'choice', options:['Oui, tout à fait','En grande partie','Partiellement','Pas du tout'] },
  { id:'recommendation', section:'5. APPRÉCIATION GLOBALE ET SUGGESTIONS', label:'Recommanderiez-vous cette formation à un collègue ou professionnel du secteur ?', note:'0 = Très peu probable / 10 = Très probable', type:'rating', options:[1,2,3,4,5,6,7,8,9,10] },
  { id:'strengths', section:'5. APPRÉCIATION GLOBALE ET SUGGESTIONS', label:'Points forts de la formation :', type:'text', placeholder:'Votre réponse (facultatif)' },
  { id:'improvements', section:'5. APPRÉCIATION GLOBALE ET SUGGESTIONS', label:"Axes d'amélioration ou remarques complémentaires :", type:'text', placeholder:'Votre réponse (facultatif)' }
];

let survey = null;
let index = Number(sessionStorage.getItem(`ts-survey-index-${code}`) || 0);
let answers = {};
try { answers = JSON.parse(sessionStorage.getItem(`ts-survey-draft-${code}`) || '{}'); } catch { answers = {}; }

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00`).toLocaleDateString('fr-FR') : '—';

function shell(body) {
  app.innerHTML = `<div class="survey-shell"><header class="survey-header"><span class="survey-brand"><span class="survey-logo">TS</span><b>Formation</b></span><span>Enquête de satisfaction</span></header><main class="survey-main">${body}</main></div>`;
}

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials:'omit',
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

function intro() {
  shell(`<section class="survey-intro card"><p class="eyebrow">QUESTIONNAIRE DE SATISFACTION</p><h1>Votre avis compte</h1><p>Ce questionnaire est à remplir à la fin du dernier jour de formation. Les réponses sont enregistrées de manière anonyme.</p>${metadata()}<p class="survey-note">16 questions · environ 3 minutes</p><button class="button survey-primary" id="startSurvey" type="button">Commencer</button></section>`);
  document.querySelector('#startSurvey')?.addEventListener('click', () => { index = Math.min(Math.max(index,0),questions.length-1); renderQuestion(); });
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
  return `<div class="survey-options">${question.options.map(value => `<label class="survey-option"><input type="radio" name="surveyAnswer" value="${esc(value)}" ${answers[question.id]===value?'checked':''}><span>${esc(value)}</span></label>`).join('')}</div>`;
}

function renderQuestion() {
  const question = questions[index];
  if (!question) return intro();
  const percent = Math.round(((index + 1) / questions.length) * 100);
  shell(`<section class="survey-question-card card"><div class="survey-progress-copy"><span>Question ${index + 1} sur ${questions.length}</span><b>${percent}%</b></div><div class="survey-progress"><span style="width:${percent}%"></span></div><p class="survey-section">${esc(question.section)}</p><h1>${esc(question.label)}</h1>${question.note?`<p class="muted">${esc(question.note)}</p>`:''}${answerHtml(question)}<div class="survey-actions"><button class="button secondary" id="surveyBack" type="button" ${index===0?'disabled':''}>← Retour</button><button class="button survey-primary" id="surveyNext" type="button">${index===questions.length-1?'Envoyer mon enquête':'Suivant →'}</button></div></section>`);
  document.querySelector('#surveyBack')?.addEventListener('click', () => {
    captureCurrent(false);
    index = Math.max(0,index-1); saveDraft(); renderQuestion();
  });
  document.querySelector('#surveyNext')?.addEventListener('click', next);
}

async function next() {
  if (!captureCurrent()) {
    alert('Choisissez une réponse avant de continuer.');
    return;
  }
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
  shell(`<section class="survey-intro card center"><div class="survey-thanks-icon">✓</div><p class="eyebrow">${already?'RÉPONSE DÉJÀ ENREGISTRÉE':'MERCI POUR VOTRE RETOUR'}</p><h1>${already?'Votre enquête a déjà été transmise.':'Votre réponse a bien été enregistrée.'}</h1><p>${already?'Une seule réponse est enregistrée depuis cet appareil pour cette enquête.':'Tech Systèmes vous remercie pour votre confiance et pour le temps accordé à ce retour d’expérience.'}</p></section>`);
}

async function start() {
  if (!code || !/^[A-Z0-9]{8}$/.test(code)) {
    return shell('<section class="card survey-intro"><h1>Lien d’enquête incomplet</h1><p>Scannez à nouveau le QR code affiché par votre instructeur.</p></section>');
  }
  try {
    survey = await request(`/satisfaction-surveys/public/${encodeURIComponent(code)}`);
    if (survey.status !== 'open') {
      return shell(`<section class="card survey-intro"><p class="eyebrow">ENQUÊTE DE SATISFACTION</p><h1>Cette enquête est clôturée.</h1>${metadata()}</section>`);
    }
    intro();
  } catch (error) {
    shell(`<section class="card survey-intro"><h1>Enquête indisponible</h1><p>${esc(error.message)}</p></section>`);
  }
}

start();
