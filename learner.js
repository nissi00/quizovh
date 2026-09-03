import { signInAnonymously, rpc } from './api.js';

const app = document.querySelector('#app');
const requested = (new URLSearchParams(location.search).get('session') || '').trim().toUpperCase();
let code = requested;
let poller = null;
let submitted = false;
let viewKey = '';
let learnerProfile = null;
let draftQueue = Promise.resolve();
const esc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function screen(body) {
  const identity = learnerProfile
    ? `<span class="learner-identity"><span>Connecté·e en tant que <b>${esc(learnerProfile.first_name)} ${esc(learnerProfile.last_name)}</b></span><button type="button" onclick="changeParticipant()">Changer de participant</button></span>`
    : '<small>Quiz THE/HEPA</small>';
  app.innerHTML = `<div class="learner-shell animate-in"><header class="learner-header"><span>🎓 TS Formation</span>${identity}</header><main class="learner-main">${body}</main></div>`;
}

function missingSession() {
  screen(`<div class="login center"><p class="eyebrow">Accès à la session</p><div class="card"><span class="icon-orb join-icon">📱</span><h1>Lien de session manquant</h1><p class="muted">Scannez le QR code affiché par votre instructeur pour rejoindre le quiz.</p></div></div>`);
}

function participationChoice() {
  learnerProfile = null;
  viewKey = 'participation-choice';
  screen(`<div class="login"><p class="eyebrow">Bienvenue</p><h1>Rejoindre la session</h1><div class="card participation-choice"><span class="icon-orb">📱</span><p class="muted">La session a été reconnue depuis le QR code. Choisissez votre situation.</p><button class="choice participation-choice-button" type="button" onclick="firstParticipation()"><span class="choice-icon">👋</span><b>C’est ma première participation</b><small>Créer mon identité avec mon nom et mon prénom</small></button><button class="choice participation-choice-button" type="button" onclick="knownParticipation()"><span class="choice-icon">🔑</span><b>J’ai déjà un code personnel</b><small>Retrouver mon identité et ma progression</small></button></div></div>`);
}

function firstParticipation() {
  viewKey = 'first-participation';
  screen(`<div class="login"><p class="eyebrow">Première participation</p><h1>Créer votre identité</h1><div class="card"><label>Prénom</label><input id="firstName" autocomplete="given-name" placeholder="Prénom"><label>Nom</label><input id="lastName" autocomplete="family-name" placeholder="Nom"><label class="competition-consent"><input id="podiumConsent" type="checkbox" checked><span><b>J’accepte d’apparaître dans le podium</b><small>Seul un pseudonyme sera projeté. Votre résultat reste enregistré si vous refusez.</small></span></label><p class="session-detected"><span>✓</span> Session reconnue depuis le QR code</p><div class="join-actions"><button class="button" type="button" onclick="enter()">Entrer dans la salle d’attente →</button><button class="button secondary" type="button" onclick="participationChoice()">Retour</button></div></div></div>`);
}

function knownParticipation() {
  viewKey = 'known-participation';
  screen(`<div class="login"><p class="eyebrow">Participant déjà inscrit</p><h1>Retrouver votre progression</h1><div class="card"><label for="participantCode">Code personnel</label><input id="participantCode" class="participant-code-input" autocomplete="off" spellcheck="false" maxlength="12" placeholder="TS-7K4M-9P2Q"><p class="muted">Utilisez le code affiché lors de votre première participation.</p><label class="competition-consent"><input id="podiumConsent" type="checkbox" checked><span><b>J’accepte d’apparaître dans le podium</b><small>Seul un pseudonyme sera projeté.</small></span></label><div class="join-actions"><button class="button" type="button" onclick="enterWithCode()">Continuer →</button><button class="button secondary" type="button" onclick="participationChoice()">Retour</button></div></div></div>`);
}

async function startPolling() {
  clearInterval(poller);
  await refresh();
  poller = setInterval(refresh, 1000);
}

async function enter() {
  const first = document.querySelector('#firstName')?.value.trim();
  const last = document.querySelector('#lastName')?.value.trim();
  if (!first || !last) return alert('Renseignez votre prénom et votre nom.');
  if (!code) return alert('Le lien de session est invalide. Scannez à nouveau le QR code.');
  try {
    await signInAnonymously();
    const joined = await rpc('join_live_by_code', { p_code: code, p_first_name: first, p_last_name: last, p_show_on_podium: document.querySelector('#podiumConsent')?.checked !== false });
    learnerProfile = joined.learner;
    viewKey = '';
    await startPolling();
  } catch (error) {
    alert(error.message);
  }
}

async function enterWithCode() {
  const participantCode = document.querySelector('#participantCode')?.value.trim();
  if (!participantCode) return alert('Saisissez votre code personnel.');
  try {
    const joined = await rpc('join_live_by_participant_code', { p_code: code, p_participant_code: participantCode, p_show_on_podium: document.querySelector('#podiumConsent')?.checked !== false });
    learnerProfile = joined.learner;
    viewKey = '';
    await startPolling();
  } catch (error) {
    alert(error.message);
  }
}

async function changeParticipant() {
  if (!confirm('Changer de participant sur cet appareil ?\n\nLes résultats déjà enregistrés seront conservés.')) return;
  try { await rpc('logout_learner'); }
  catch (error) { console.error(error); }
  clearInterval(poller);
  poller = null;
  learnerProfile = null;
  submitted = false;
  viewKey = '';
  participationChoice();
}

async function copyParticipantCode() {
  const participantCode = learnerProfile?.participant_code;
  if (!participantCode) return;
  try {
    await navigator.clipboard.writeText(participantCode);
    const button = document.querySelector('#copyParticipantCode');
    if (button) {
      button.textContent = 'Code copié ✓';
      setTimeout(() => { if (button) button.textContent = 'Copier le code'; }, 1800);
    }
  } catch {
    alert(`Votre code personnel est : ${participantCode}`);
  }
}

function waiting(state) {
  const participants = state?.waiting_participants || [];
  const participantCode = state?.learner?.participant_code || learnerProfile?.participant_code || '';
  const signature = participants.map(person => `${person.id}:${person.status}`).join(',');
  const key = `waiting-list:${signature}:${participantCode}`;
  if (viewKey === key) return;
  viewKey = key;
  const people = participants.map(person => `<div class="waiting-person ${person.is_current?'is-current':''}"><b>${esc(person.first_name)} ${esc(person.last_name)}</b>${person.is_current?'<span class="you-badge">vous</span>':''}</div>`).join('');
  screen(`<div class="login"><p class="eyebrow center">Salle d’attente</p><div class="card waiting-room-card"><div class="row"><div><p class="eyebrow">Vous avez rejoint le quiz</p><h1>Les participants en attente</h1></div><span class="count-badge">${participants.length}</span></div><p class="muted">Votre instructeur validera bientôt les entrées. Vous serez dirigé·e automatiquement vers le quiz.</p><section class="personal-code-card"><p>Votre code personnel pour toute la formation</p><strong>${esc(participantCode)}</strong><p>Faites une capture d’écran ou conservez ce code dans un endroit sûr.</p><button id="copyParticipantCode" class="button secondary" type="button" onclick="copyParticipantCode()">Copier le code</button></section>${state.show_podium&&state.show_on_podium?`<p class="podium-consent-note">🏆 Votre pseudonyme pour le podium : <b>${esc(state.podium_alias)}</b></p>`:''}<div class="waiting-people">${people||'<p class="muted center">Votre demande a bien été envoyée.</p>'}</div></div></div>`);
}

function readyForNext() {
  if (viewKey === 'ready-next') return;
  viewKey = 'ready-next';
  screen(`<div class="login center"><p class="eyebrow">Session en cours</p><div class="card ready-card"><h1>Préparez-vous</h1><p class="muted">Votre instructeur prépare la prochaine question.</p><span class="tag">⌛ En attente du lancement</span></div></div>`);
}

async function refresh() {
  try {
    const state = await rpc('live_learner_state', { p_code: code });
    if (!state) return;
    if (state.learner) learnerProfile = state.learner;
    if (state.status === 'finished') {
      clearInterval(poller);
      if (viewKey !== 'finished') {
        viewKey = 'finished';
        const score = state.final_score;
        const scoreText = score ? `<p class="score-final">Votre score : <b>${Number(score.percent || 0)}%</b><span>${Number(score.correct_answers || 0)} / ${Number(score.question_count || 0)} bonne(s) réponse(s)</span></p>` : '';
        screen(`<div class="login center"><div class="card"><h1>Quiz terminé 🎉</h1>${scoreText}<p>Merci pour votre participation.</p></div></div>`);
      }
      return;
    }
    if (state.participant_status !== 'joined') return waiting(state);
    if (state.status === 'polling' && state.question) return poll(state);
    if (state.status === 'live' && state.question) return question(state);
    if (state.status === 'waiting' && state.reviewing && state.question) return questionReview(state);
    if (state.status === 'waiting') readyForNext();
  } catch (error) {
    if (error.status === 401) {
      clearInterval(poller);
      participationChoice();
      return;
    }
    console.error(error);
  }
}

function question(state) {
  const q = state.question;
  const selectedIds = new Set(state.selected_option_ids || []);
  const key = `question:${q.id}:${state.answer_submitted ? 'submitted' : 'open'}:${[...selectedIds].sort().join(',')}`;
  if (viewKey === key) return;
  viewKey = key;
  submitted = Boolean(state.answer_submitted);
  const multiple = Boolean(q.multiple_answers);
  const answerType = multiple ? 'checkbox' : 'radio';
  const instruction = multiple ? 'Plusieurs réponses sont attendues : cochez toutes les propositions pertinentes.' : 'Une seule réponse est attendue.';
  const savedMessage = submitted
    ? '<div class="feedback">Réponse validée. Attendez le sondage ou la question suivante.</div>'
    : selectedIds.size
      ? '<div class="draft-feedback">Choix enregistré provisoirement. Vous pouvez encore le modifier ou le valider.</div>'
      : '';
  screen(`<div class="login"><input type="hidden" id="questionId" value="${q.id}"><div class="question-head"><h1>Question ${q.position}</h1><div id="timer" class="timer"></div></div><div class="card"><p class="question">${esc(q.body)}</p><p class="answer-instruction">${instruction}</p><div class="answers">${q.options.map(option => `<label class="answer ${submitted?'locked':''}"><input type="${answerType}" name="answer" value="${option.id}" ${selectedIds.has(option.id)?'checked':''} ${submitted?'disabled':''} onchange="saveDraftSelection()"><span class="answer-letter">${option.label}</span><span class="answer-body">${esc(option.body)}</span></label>`).join('')}</div><div id="draftStatus">${savedMessage}</div><div id="feedback"></div><p><button id="validate" class="button" onclick="answer()" ${submitted?'disabled':''}>${submitted?'Réponse validée':'Valider ma réponse'}</button></p></div></div>`);
  const tick = () => {
    if (!viewKey.startsWith(`question:${q.id}:`)) return clearInterval(clock);
    const left = Math.max(0, Math.ceil((new Date(state.question_ends_at) - Date.now()) / 1000));
    const timer = document.querySelector('#timer');
    if (timer) timer.textContent = `${left}s`;
    if (left <= 0) {
      clearInterval(clock);
      draftQueue.finally(() => {
        const selected = document.querySelectorAll('input[name=answer]:checked').length;
        lock(selected ? 'Temps écoulé : votre dernier choix a été enregistré automatiquement.' : 'Le temps est écoulé. Aucune réponse sélectionnée.');
        refresh();
      });
    }
  };
  const clock = setInterval(tick, 400);
  tick();
}

function selectedOptionIds() {
  return [...document.querySelectorAll('input[name=answer]:checked')].map(option => option.value);
}

function saveDraftSelection() {
  if (submitted) return;
  const questionId = document.querySelector('#questionId')?.value;
  const optionIds = selectedOptionIds();
  const status = document.querySelector('#draftStatus');
  if (status) status.innerHTML = '<div class="draft-feedback saving">Enregistrement du choix…</div>';
  draftQueue = draftQueue.catch(() => undefined).then(async () => {
    await rpc('save_live_answer_draft', { p_code: code, p_option_ids: optionIds });
    if (document.querySelector('#questionId')?.value !== questionId || submitted) return;
    const currentStatus = document.querySelector('#draftStatus');
    if (currentStatus) currentStatus.innerHTML = optionIds.length
      ? '<div class="draft-feedback">Choix enregistré provisoirement. Vous pouvez encore le modifier ou le valider.</div>'
      : '';
  }).catch(error => {
    const currentStatus = document.querySelector('#draftStatus');
    if (currentStatus) currentStatus.innerHTML = `<div class="draft-feedback error">${esc(error.message)}</div>`;
  });
}

function questionReview(state) {
  const q = state.question;
  const selectedIds = new Set(state.selected_option_ids || []);
  const result = state.answer_result;
  const key = `review:${q.id}:${result === null ? 'none' : result}`;
  if (viewKey === key) return;
  viewKey = key;
  submitted = true;
  const multiple = Boolean(q.multiple_answers);
  const answerType = multiple ? 'checkbox' : 'radio';
  const instruction = multiple ? 'Plusieurs réponses étaient attendues.' : 'Une seule réponse était attendue.';
  const resultMessage = result === true
    ? '<div class="feedback success review-result"><b>Bravo ! ✓</b> Vous avez trouvé la bonne réponse.</div>'
    : result === false
      ? '<div class="feedback bad review-result"><b>Dommage ! ✕</b> Vous n’avez pas trouvé la bonne réponse.</div>'
      : '<div class="feedback bad review-result"><b>Dommage !</b> Aucune réponse n’a été enregistrée.</div>';
  const endMessage = state.question_expired ? 'Le temps est écoulé.' : 'La question est terminée.';
  screen(`<div class="login"><div class="question-head"><div><h1>Question ${q.position}</h1><span class="tag answer-mode-tag">◉ ${multiple?'Réponses multiples':'Réponse unique'}</span></div><div class="timer">0s</div></div><div class="card"><p class="question">${esc(q.body)}</p><p class="answer-instruction">${instruction}</p><div class="answers review-answers">${q.options.map(option => {const selected=selectedIds.has(option.id),correct=Boolean(option.is_correct);return `<label class="answer answer-review ${correct?'is-correct':'is-incorrect'} ${selected?'is-selected':''}"><input type="${answerType}" name="answer" value="${option.id}" ${selected?'checked':''} disabled><span class="answer-letter">${option.label}</span><span class="answer-body">${esc(option.body)}</span><span class="review-mark" aria-label="${correct?'Bonne réponse':'Mauvaise réponse'}">${correct?'✓':'✕'}</span></label>`}).join('')}</div><div class="feedback review-time">${endMessage}</div>${resultMessage}<p><button class="button" disabled>${selectedIds.size?'Réponse enregistrée':'Aucune réponse'}</button></p></div></div>`);
}

function poll(state) {
  const q = state.question;
  const results = state.poll_results || [];
  const total = results.reduce((sum, result) => sum + Number(result.response_count || 0), 0);
  const signature = results.map(result => `${result.label}:${result.response_count}`).join(',');
  const key = `poll:${q.id}:${signature}`;
  if (viewKey === key) return;
  viewKey = key;
  const byLabel = Object.fromEntries(results.map(result => [result.label, Number(result.response_count || 0)]));
  const countLabel = q.multiple_answers ? 'sélection' : 'réponse';
  screen(`<div class="login"><p class="eyebrow">Sondage de la question ${q.position}</p><div class="question-head"><h1>Résultats en direct 📊</h1><span class="tag">${total} ${countLabel}${total > 1 ? 's' : ''}</span></div><div class="card poll-card"><p class="question">${esc(q.body)}</p><p class="muted">Répartition anonyme des réponses. Attendez l’affichage de la correction.</p><div class="poll-results">${q.options.map(option => { const count = byLabel[option.label] || 0; const percent = total ? Math.round(count * 100 / total) : 0; return `<div class="poll-row"><div class="poll-label"><span class="answer-letter">${option.label}</span><span>${esc(option.body)}</span><b>${percent}%</b></div><div class="poll-bar"><span style="width:${percent}%"></span></div><small>${count} ${countLabel}${count > 1 ? 's' : ''}</small></div>`; }).join('')}</div></div></div>`);
}

async function answer() {
  if (submitted) return;
  const optionIds = selectedOptionIds();
  if (!optionIds.length) return alert('Choisissez au moins une proposition.');
  try {
    await draftQueue;
    await rpc('submit_live_answers', { p_code: code, p_option_ids: optionIds });
    submitted = true;
    lock('Réponse enregistrée. Attendez le sondage ou la question suivante.');
  } catch (error) {
    lock(error.message);
    if (error.status === 403) refresh();
  }
}

function lock(message) {
  document.querySelectorAll('input[name=answer]').forEach(input => input.disabled = true);
  const button = document.querySelector('#validate');
  if (button) {
    button.disabled = true;
    button.textContent = 'Réponse enregistrée';
  }
  const feedback = document.querySelector('#feedback');
  if (feedback) feedback.innerHTML = `<div class="feedback">${esc(message)}</div>`;
}

async function start() {
  if (!code) return missingSession();
  try {
    const resumed = await rpc('resume_live_by_code', { p_code: code });
    learnerProfile = resumed.learner;
    await startPolling();
  } catch (error) {
    if (error.status === 401) return participationChoice();
    screen(`<div class="login center"><p class="eyebrow">Accès à la session</p><div class="card"><h1>Impossible de rejoindre le quiz</h1><p class="muted">${esc(error.message)}</p></div></div>`);
  }
}

Object.assign(window, {
  participationChoice,
  firstParticipation,
  knownParticipation,
  enter,
  enterWithCode,
  changeParticipant,
  copyParticipantCode,
  saveDraftSelection,
  answer
});

start();
