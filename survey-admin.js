const questionGroups = [
  { section:'1. Organisation et logistique', items:[
    ['organization_information','Information préalable (programme, convocation, accès)',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['organization_schedule','Respect des horaires et du déroulement de la session',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['organization_facilities','Qualité des locaux, équipements et moyens matériels',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']]
  ]},
  { section:'2. Contenu et pédagogie', items:[
    ['content_expectations','Adéquation du programme avec vos attentes',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['content_theory','Clarté des explications théoriques',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['content_exercises','Qualité et utilité des exercices',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['content_materials','Qualité des supports de cours remis',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']]
  ]},
  { section:'3. Animation par le formateur', items:[
    ['trainer_mastery',"Maîtrise du sujet par l'intervenant",['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['trainer_availability','Disponibilité, écoute et réponse aux questions',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['trainer_exercises','Qualité et utilité des exercices',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']],
    ['trainer_dynamics','Dynamisme et rythme de la formation',['Très satisfait','Satisfait','Peu satisfait','Insatisfait']]
  ]},
  { section:'4. Atteinte des objectifs et acquis de la formation', items:[
    ['objectives_achieved','Estimé-vous avoir atteint les objectifs de la formation ?',['Oui, tout à fait','En grande partie','Partiellement','Pas du tout']],
    ['objectives_apply','Allez-vous pouvoir appliquer ces acquis dans votre travail ?',['Oui, tout à fait','En grande partie','Partiellement','Pas du tout']]
  ]}
];

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00`).toLocaleDateString('fr-FR') : '—';

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials:'same-origin',
    ...options,
    headers:{'Content-Type':'application/json', ...(options.headers || {})}
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (!response.ok) {
    const error = new Error(payload?.message || `Erreur du serveur (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function surveyButton() {
  return document.querySelector('[data-satisfaction-nav]');
}

function installPanel() {
  const sidebar = document.querySelector('.sidebar');
  const section = document.querySelector('.layout > section');
  if (!sidebar || !section || surveyButton()) return;

  const button = document.createElement('button');
  button.className = 'nav-button';
  button.dataset.satisfactionNav = '1';
  button.type = 'button';
  button.textContent = '📝 Enquête de satisfaction';
  button.addEventListener('click', () => openSurveyPanel(button));

  const participantButton = [...sidebar.querySelectorAll('.nav-button')].find(item => item.textContent.includes('Participants'));
  sidebar.insertBefore(button, participantButton || sidebar.lastElementChild);

  const panel = document.createElement('div');
  panel.id = 'satisfaction';
  panel.className = 'panel';
  panel.innerHTML = '<p class="eyebrow">Retour d’expérience</p><h1>Enquête de satisfaction</h1><div id="satisfactionContent" class="card">Chargement…</div>';
  section.appendChild(panel);
}

async function openSurveyPanel(button = surveyButton()) {
  if (typeof window.panel === 'function') window.panel('satisfaction', button);
  else {
    document.querySelectorAll('.panel').forEach(item => item.classList.toggle('active', item.id === 'satisfaction'));
    document.querySelectorAll('.nav-button').forEach(item => item.classList.remove('active'));
    button?.classList.add('active');
  }
  await renderSurveyPanel();
}

async function renderSurveyPanel() {
  const box = document.querySelector('#satisfactionContent');
  if (!box) return;
  box.innerHTML = '<p class="muted">Chargement des enquêtes…</p>';
  try {
    const [groups, surveys] = await Promise.all([request('/training-groups'), request('/satisfaction-surveys')]);
    box.className = '';
    box.innerHTML = `<section class="card satisfaction-create-card"><div><p class="eyebrow">FOR-FORM-003</p><h2>Créer une enquête</h2><p class="muted">Le questionnaire officiel est utilisé sans modification. Les réponses sont anonymes et ne sont jamais projetées.</p></div><div class="satisfaction-create-row"><select id="satisfactionGroup"><option value="">Sélectionnez un groupe de formation</option>${groups.map(group=>`<option value="${group.id}">${esc(group.name)} · ${esc(group.theme_name)}</option>`).join('')}</select><button class="button" type="button" id="createSatisfactionSurvey">Générer le QR code</button></div></section><section><div class="row satisfaction-list-title"><div><p class="eyebrow">Enquêtes créées</p><h2>Suivi et résultats</h2></div><button class="button secondary" type="button" id="refreshSatisfaction">↻ Actualiser</button></div><div class="satisfaction-list">${surveys.map(surveyCard).join('') || '<div class="card empty">Aucune enquête de satisfaction créée.</div>'}</div></section>`;
    document.querySelector('#createSatisfactionSurvey')?.addEventListener('click', createSurvey);
    document.querySelector('#refreshSatisfaction')?.addEventListener('click', renderSurveyPanel);
    document.querySelectorAll('[data-survey-results]').forEach(btn => btn.addEventListener('click', () => showResults(btn.dataset.surveyResults)));
    document.querySelectorAll('[data-survey-toggle]').forEach(btn => btn.addEventListener('click', () => toggleStatus(btn.dataset.surveyToggle, btn.dataset.status)));
  } catch (error) {
    box.className = 'card';
    box.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
  }
}

function surveyCard(survey) {
  const open = survey.status === 'open';
  return `<article class="card satisfaction-card"><div class="satisfaction-card-main"><div><span class="tag ${open?'':'gray'}">${open?'Ouverte':'Clôturée'}</span><h2>${esc(survey.formation_title)}</h2><p class="muted">${esc(survey.group_name)} · du ${formatDate(survey.start_date)} au ${formatDate(survey.end_date)} · ${esc(survey.trainer_name)}</p><div class="satisfaction-metrics"><strong>${Number(survey.response_count || 0)}</strong><span>réponse(s) reçue(s)</span><code title="Code à saisir dans le complément PowerPoint">${esc(survey.code)}</code></div><small class="muted">Dans PowerPoint, saisissez ce code dans le complément « TS Formation · Enquête de satisfaction ».</small></div>${open?`<div class="satisfaction-qr-mini"><img src="/api/satisfaction-surveys/${survey.id}/qr" alt="QR code de l'enquête ${esc(survey.code)}"><small>QR code de l’enquête</small></div>`:''}</div><div class="actions"><button class="button" type="button" data-survey-results="${survey.id}">Voir les résultats</button><a class="button secondary" href="/api/satisfaction-surveys/${survey.id}/export.csv">Exporter CSV</a><a class="button secondary" href="./survey-powerpoint.html?survey=${encodeURIComponent(survey.code)}" target="_blank" rel="noopener">Aperçu de l’écran QR</a><button class="button ${open?'danger':'secondary'}" type="button" data-survey-toggle="${survey.id}" data-status="${open?'closed':'open'}">${open?'Clôturer':'Rouvrir'}</button></div><div id="survey-results-${survey.id}" class="satisfaction-results"></div></article>`;
}

async function createSurvey() {
  const groupId = document.querySelector('#satisfactionGroup')?.value;
  if (!groupId) return alert('Sélectionnez un groupe de formation.');
  const button = document.querySelector('#createSatisfactionSurvey');
  if (button) { button.disabled = true; button.textContent = 'Création…'; }
  try {
    const survey = await request('/satisfaction-surveys', { method:'POST', body:JSON.stringify({ group_id:groupId }) });
    await renderSurveyPanel();
    alert(`Enquête créée. Code : ${survey.code}`);
  } catch (error) {
    alert(error.message);
    if (button) { button.disabled = false; button.textContent = 'Générer le QR code'; }
  }
}

async function toggleStatus(id, status) {
  const verb = status === 'closed' ? 'clôturer' : 'rouvrir';
  if (!confirm(`Voulez-vous ${verb} cette enquête ?`)) return;
  try {
    await request(`/satisfaction-surveys/${encodeURIComponent(id)}`, { method:'PATCH', body:JSON.stringify({ status }) });
    await renderSurveyPanel();
  } catch (error) { alert(error.message); }
}

function distributionTable(label, options, responses, key) {
  const counts = Object.fromEntries(options.map(option => [option,0]));
  for (const response of responses) {
    const value = response.answers?.[key];
    if (Object.hasOwn(counts, value)) counts[value] += 1;
  }
  const total = responses.length || 0;
  return `<div class="satisfaction-result-question"><h4>${esc(label)}</h4><div class="table-wrap"><table><thead><tr>${options.map(option=>`<th>${esc(option)}</th>`).join('')}</tr></thead><tbody><tr>${options.map(option=>{const count=counts[option]||0;const pct=total?Math.round(count*100/total):0;return `<td><b>${count}</b><small>${pct}%</small></td>`}).join('')}</tr></tbody></table></div></div>`;
}

async function showResults(id) {
  const box = document.querySelector(`#survey-results-${CSS.escape(id)}`);
  if (!box) return;
  if (box.dataset.open === '1') { box.innerHTML = ''; box.dataset.open = '0'; return; }
  box.dataset.open = '1';
  box.innerHTML = '<p class="muted">Chargement des résultats…</p>';
  try {
    const data = await request(`/satisfaction-surveys/${encodeURIComponent(id)}/results`);
    const responses = data.responses || [];
    const recommendationValues = responses.map(row => Number(row.answers?.recommendation)).filter(value => Number.isFinite(value));
    const average = recommendationValues.length ? (recommendationValues.reduce((sum,value)=>sum+value,0)/recommendationValues.length).toFixed(1).replace('.',',') : '—';
    const recommendationOptions = [1,2,3,4,5,6,7,8,9,10].map(String);
    const recommendationResponses = responses.map(row => ({ answers:{ recommendation:String(row.answers?.recommendation ?? '') } }));
    const sections = questionGroups.map(group => `<section class="satisfaction-result-section"><h3>${esc(group.section)}</h3>${group.items.map(([key,label,options])=>distributionTable(label,options,responses,key)).join('')}</section>`).join('');
    const strengths = responses.map(row => String(row.answers?.strengths || '').trim()).filter(Boolean);
    const improvements = responses.map(row => String(row.answers?.improvements || '').trim()).filter(Boolean);
    box.innerHTML = `<div class="satisfaction-results-head"><div><b>${responses.length}</b><span>réponse(s) anonymes</span></div><div><b>${average}/10</b><span>note moyenne de recommandation</span></div></div>${sections}<section class="satisfaction-result-section"><h3>5. Appréciation globale et suggestions</h3>${distributionTable('Recommanderiez-vous cette formation à un collègue ou professionnel du secteur ?',recommendationOptions,recommendationResponses,'recommendation')}<div class="satisfaction-comments-grid"><div><h4>Points forts de la formation</h4>${strengths.map(comment=>`<blockquote>${esc(comment)}</blockquote>`).join('')||'<p class="muted">Aucun commentaire.</p>'}</div><div><h4>Axes d’amélioration ou remarques complémentaires</h4>${improvements.map(comment=>`<blockquote>${esc(comment)}</blockquote>`).join('')||'<p class="muted">Aucun commentaire.</p>'}</div></div></section>`;
  } catch (error) {
    box.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
  }
}

const observer = new MutationObserver(() => installPanel());
observer.observe(document.querySelector('#app') || document.body, { childList:true, subtree:true });
installPanel();
