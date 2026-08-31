import { signInAnonymously, rpc } from './api.js';

const app = document.querySelector('#app');
const requested = (new URLSearchParams(location.search).get('session') || '').trim().toUpperCase();
let code = requested;
let poller = null;
let submitted = false;
let viewKey = '';
let reviewedQuestionId = '';
let reviewUntil = 0;
const esc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function screen(body) {
  app.innerHTML = `<div class="learner-shell animate-in"><header class="learner-header"><span>🎓 TS Formation</span><small>Quiz THE/HEPA</small></header><main class="learner-main">${body}</main></div>`;
}

function join() {
  if (!code) {
    screen(`<div class="login center"><p class="eyebrow">Accès à la session</p><div class="card"><span class="icon-orb join-icon">📱</span><h1>Lien de session manquant</h1><p class="muted">Scannez le QR code affiché par votre instructeur pour rejoindre le quiz.</p></div></div>`);
    return;
  }
  screen(`<div class="login"><p class="eyebrow">Bienvenue</p><h1>Rejoindre la session</h1><div class="card"><span class="icon-orb">📱</span><label>Prénom</label><input id="firstName" autocomplete="given-name" placeholder="Prénom"><label>Nom</label><input id="lastName" autocomplete="family-name" placeholder="Nom"><p class="session-detected"><span>✓</span> Session reconnue depuis le QR code</p><p><button class="button" onclick="enter()">Entrer dans la salle d’attente →</button></p></div></div>`);
}

async function enter() {
  const first = document.querySelector('#firstName').value.trim();
  const last = document.querySelector('#lastName').value.trim();
  if (!first || !last) return alert('Renseignez votre prénom et votre nom.');
  if (!code) return alert('Le lien de session est invalide. Scannez à nouveau le QR code.');
  try {
    await signInAnonymously();
    await rpc('join_live_by_code', { p_code: code, p_first_name: first, p_last_name: last });
    await refresh();
    poller = setInterval(refresh, 1000);
  } catch (error) {
    alert(error.message);
  }
}

function waiting(state) {
  const participants = state?.waiting_participants || [];
  const signature = participants.map(person => `${person.id}:${person.status}`).join(',');
  const key = `waiting-list:${signature}`;
  if (viewKey === key) return;
  viewKey = key;
  const people = participants.map(person => `<div class="waiting-person ${person.is_current?'is-current':''}"><b>${esc(person.first_name)} ${esc(person.last_name)}</b>${person.is_current?'<span class="you-badge">vous</span>':''}</div>`).join('');
  screen(`<div class="login"><p class="eyebrow center">Salle d’attente</p><div class="card waiting-room-card"><div class="row"><div><p class="eyebrow">Vous avez rejoint le quiz</p><h1>Les participants en attente</h1></div><span class="count-badge">${participants.length}</span></div><p class="muted">Votre instructeur validera bientôt les entrées. Vous serez dirigé·e automatiquement vers le quiz.</p><div class="waiting-people">${people||'<p class="muted center">Votre demande a bien été envoyée.</p>'}</div></div></div>`);
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
    if (state.status === 'polling' && state.question) {
      if (reviewedQuestionId !== state.question.id) {
        reviewedQuestionId = state.question.id;
        reviewUntil = Date.now() + 3000;
        return questionReview(state);
      }
      if (Date.now() < reviewUntil) return;
      return poll(state);
    }
    if (state.status === 'live' && state.question) {
      if (state.question_expired) {
        reviewedQuestionId = state.question.id;
        reviewUntil = 0;
        return questionReview(state);
      }
      return question(state);
    }
    if (state.status === 'waiting') readyForNext();
  } catch (error) {
    console.error(error);
  }
}

function question(state) {
  const q = state.question;
  const key = `question:${q.id}`;
  if (viewKey === key) return;
  viewKey = key;
  reviewedQuestionId = '';
  reviewUntil = 0;
  submitted = false;
  const multiple = Boolean(q.multiple_answers);
  const answerType = multiple ? 'checkbox' : 'radio';
  const instruction = multiple ? 'Plusieurs réponses sont attendues : cochez toutes les propositions pertinentes.' : 'Une seule réponse est attendue.';
  screen(`<div class="login"><input type="hidden" id="questionId" value="${q.id}"><div class="question-head"><h1>Question ${q.position}</h1><div id="timer" class="timer"></div></div><div class="card"><p class="question">${esc(q.body)}</p><p class="answer-instruction">${instruction}</p><div class="answers">${q.options.map(option => `<label class="answer"><input type="${answerType}" name="answer" value="${option.id}"><span class="answer-letter">${option.label}</span>${esc(option.body)}</label>`).join('')}</div><div id="feedback"></div><p><button id="validate" class="button" onclick="answer()">Valider ma réponse</button></p></div></div>`);
  const tick = () => {
    if (viewKey !== key) return clearInterval(clock);
    const left = Math.max(0, Math.ceil((new Date(state.question_ends_at) - Date.now()) / 1000));
    const timer = document.querySelector('#timer');
    if (timer) timer.textContent = `${left}s`;
    if (left <= 0) {
      clearInterval(clock);
      lock('Le temps est écoulé.');
      refresh();
    }
  };
  const clock = setInterval(tick, 400);
  tick();
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
  screen(`<div class="login"><div class="question-head"><div><h1>Question ${q.position}</h1><span class="tag answer-mode-tag">◉ ${multiple?'Réponses multiples':'Réponse unique'}</span></div><div class="timer">0s</div></div><div class="card"><p class="question">${esc(q.body)}</p><p class="answer-instruction">${instruction}</p><div class="answers review-answers">${q.options.map(option => {const selected=selectedIds.has(option.id),correct=Boolean(option.is_correct);return `<label class="answer answer-review ${correct?'is-correct':'is-incorrect'} ${selected?'is-selected':''}"><input type="${answerType}" name="answer" value="${option.id}" ${selected?'checked':''} disabled><span class="answer-letter">${option.label}</span><span class="answer-body">${esc(option.body)}</span><span class="review-mark" aria-label="${correct?'Bonne réponse':'Mauvaise réponse'}">${correct?'✓':'✕'}</span></label>`}).join('')}</div><div class="feedback review-time">${endMessage}</div>${resultMessage}<p><button class="button" disabled>${selectedIds.size?'Réponse validée':'Aucune réponse'}</button></p></div></div>`);
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
  screen(`<div class="login"><p class="eyebrow">Sondage de la question ${q.position}</p><div class="question-head"><h1>Résultats en direct 📊</h1><span class="tag">${total} ${countLabel}${total > 1 ? 's' : ''}</span></div><div class="card poll-card"><p class="question">${esc(q.body)}</p><p class="muted">Répartition anonyme des réponses. Attendez le lancement de la question suivante.</p><div class="poll-results">${q.options.map(option => { const count = byLabel[option.label] || 0; const percent = total ? Math.round(count * 100 / total) : 0; return `<div class="poll-row"><div class="poll-label"><span class="answer-letter">${option.label}</span><span>${esc(option.body)}</span><b>${percent}%</b></div><div class="poll-bar"><span style="width:${percent}%"></span></div><small>${count} ${countLabel}${count > 1 ? 's' : ''}</small></div>`; }).join('')}</div></div></div>`);
}

async function answer() {
  if (submitted) return;
  const options = [...document.querySelectorAll('input[name=answer]:checked')];
  if (!options.length) return alert('Choisissez au moins une proposition.');
  try {
    await rpc('submit_live_answers', { p_code: code, p_option_ids: options.map(option => option.value) });
    submitted = true;
    lock('Réponse enregistrée. Attendez le sondage ou la question suivante.');
  } catch (error) {
    lock(error.message);
  }
}

function lock(message) {
  document.querySelectorAll('input[name=answer]').forEach(input => input.disabled = true);
  const button = document.querySelector('#validate');
  if (button) {
    button.disabled = true;
    button.textContent = 'Réponse validée';
  }
  const feedback = document.querySelector('#feedback');
  if (feedback) feedback.innerHTML = `<div class="feedback">${esc(message)}</div>`;
}

Object.assign(window, { enter, answer });
join();
