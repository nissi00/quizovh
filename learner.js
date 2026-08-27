import { signInAnonymously, rpc } from './api.js';

const app = document.querySelector('#app');
const requested = new URLSearchParams(location.search).get('session') || '';
let code = '';
let poller = null;
let submitted = false;
let viewKey = '';
const esc = value => String(value || '').replace(/[&<>"']/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));

function screen(body) {
  app.innerHTML = `<div class="learner-shell animate-in"><header class="learner-header"><span>🎓 TS Formation</span><small>Quiz THE/HEPA</small></header><main class="learner-main">${body}</main></div>`;
}

function join() {
  screen(`<div class="login"><p class="eyebrow">Bienvenue</p><h1>Rejoindre la session</h1><div class="card"><span class="icon-orb">📱</span><label>Prénom</label><input id="firstName" autocomplete="given-name" placeholder="Prénom"><label>Nom</label><input id="lastName" autocomplete="family-name" placeholder="Nom"><label>Code de session</label><input id="code" value="${esc(requested)}"><p><button class="button" onclick="enter()">Entrer dans la salle d’attente →</button></p></div></div>`);
}

async function enter() {
  const first = document.querySelector('#firstName').value.trim();
  const last = document.querySelector('#lastName').value.trim();
  code = document.querySelector('#code').value.trim().toUpperCase();
  if (!first || !last || !code) return alert('Renseignez nom, prénom et code.');
  try {
    await signInAnonymously();
    await rpc('join_live_by_code', { p_code: code, p_first_name: first, p_last_name: last });
    waiting();
    poller = setInterval(refresh, 1000);
  } catch (error) {
    alert(error.message);
  }
}

function waiting() {
  viewKey = 'waiting-list';
  screen(`<div class="login center"><p class="eyebrow">Salle d’attente</p><div class="card"><div class="waiting-animation"><span></span><span></span><span></span></div><h1>Demande envoyée</h1><p class="muted">Votre instructeur doit accepter votre participation. Vous serez dirigé·e automatiquement vers le quiz.</p><span class="tag">⌛ En attente de validation</span></div></div>`);
}

function readyForNext() {
  if (viewKey === 'ready-next') return;
  viewKey = 'ready-next';
  screen(`<div class="login center"><p class="eyebrow">Session en cours</p><div class="card"><div class="waiting-animation"><span></span><span></span><span></span></div><h1>Préparez-vous</h1><p class="muted">Votre instructeur prépare la prochaine question.</p><span class="tag">⌛ En attente du lancement</span></div></div>`);
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
    if (state.participant_status !== 'joined') return;
    if (state.status === 'polling' && state.question) return poll(state);
    if (state.status === 'live' && state.question) {
      if (state.question_ends_at && new Date(state.question_ends_at) <= new Date()) return poll(state);
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

function poll(state) {
  const q = state.question;
  const results = state.poll_results || [];
  const total = results.reduce((sum, result) => sum + Number(result.response_count || 0), 0);
  const signature = results.map(result => `${result.label}:${result.response_count}`).join(',');
  const outcome = state.question_expired ? (state.answer_result ? 'bravo' : 'dommage') : 'pending';
  const key = `poll:${q.id}:${signature}:${outcome}`;
  if (viewKey === key) return;
  viewKey = key;
  const byLabel = Object.fromEntries(results.map(result => [result.label, Number(result.response_count || 0)]));
  const resultMessage = state.question_expired ? `<div class="feedback ${state.answer_result ? 'success' : 'bad'}"><b>${state.answer_result ? 'Bravo !' : 'Dommage.'}</b> ${state.answer_result ? 'Vous avez trouvé.' : 'Vous n’avez pas trouvé.'}</div>` : '';
  const countLabel = q.multiple_answers ? 'sélection' : 'réponse';
  screen(`<div class="login"><p class="eyebrow">Sondage de la question ${q.position}</p><div class="question-head"><h1>Résultats en direct 📊</h1><span class="tag">${total} ${countLabel}${total > 1 ? 's' : ''}</span></div><div class="card poll-card"><p class="question">${esc(q.body)}</p><p class="muted">Répartition anonyme des réponses. Attendez le lancement de la question suivante.</p><div class="poll-results">${q.options.map(option => { const count = byLabel[option.label] || 0; const percent = total ? Math.round(count * 100 / total) : 0; return `<div class="poll-row"><div class="poll-label"><span class="answer-letter">${option.label}</span><span>${esc(option.body)}</span><b>${percent}%</b></div><div class="poll-bar"><span style="width:${percent}%"></span></div><small>${count} ${countLabel}${count > 1 ? 's' : ''}</small></div>`; }).join('')}</div>${resultMessage}</div></div>`);
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
