const root = document.querySelector('#powerpointApp');
const settingKey = 'tsQuizSessionCode';
let sessionCode = '';
let activeScreen = '';
let poller = null;
let officeAvailable = false;
let editingView = false;
let configurationOpen = false;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function setScreen(key, body) {
  if (activeScreen === key) return;
  activeScreen = key;
  root.innerHTML = body;
  document.querySelector('[data-configure]')?.addEventListener('click', () => configuration());
}

function header(state, label) {
  return `<header class="presentation-header">
    <div class="presentation-brand"><span class="brand-mark">TS</span><b>Formation</b></div>
    <div class="presentation-context">
      <span>${esc(state?.theme_name || 'TS Quiz')}</span>
      <b>${esc(state?.chapter_title || state?.quiz_title || '')}</b>
    </div>
    <div class="header-actions">
      <span class="phase-label">${esc(label)}</span>
      ${editingView ? '<button class="configure-button" type="button" data-configure aria-label="Changer de session">⚙</button>' : ''}
    </div>
  </header>`;
}

function configuration(message = '') {
  configurationOpen = true;
  setScreen(`configuration:${message}`, `<section class="stage stage-center configuration-stage">
    <div class="configuration-card">
      <span class="brand-mark large">TS</span>
      <p class="eyebrow">Configuration PowerPoint</p>
      <h1>Associer la présentation</h1>
      <p class="muted">Saisissez le code de la session créée dans l’espace instructeur.</p>
      <form id="sessionForm" class="session-form">
        <label for="sessionCode">Code de session</label>
        <input id="sessionCode" maxlength="8" autocomplete="off" spellcheck="false" placeholder="Ex. THE1R3A4" value="${esc(sessionCode)}" required>
        <div class="configuration-actions">
          <button type="submit">Associer la session</button>
          ${sessionCode ? '<button class="configuration-cancel" type="button" data-cancel-configuration>Annuler</button>' : ''}
        </div>
      </form>
      ${message ? `<p class="configuration-error">${esc(message)}</p>` : ''}
      <p class="configuration-note">Ce formulaire de préparation n’est pas affiché pendant le quiz.</p>
    </div>
  </section>`);
  document.querySelector('#sessionForm')?.addEventListener('submit', saveConfiguration);
  document.querySelector('[data-cancel-configuration]')?.addEventListener('click', cancelConfiguration);
  document.querySelector('#sessionCode')?.focus();
}

async function cancelConfiguration() {
  if (!sessionCode) return;
  configurationOpen = false;
  activeScreen = '';
  await refresh();
}

function waiting(state) {
  setScreen(`waiting:${state.code}`, `${header(state, 'Salle d’attente')}
    <section class="stage waiting-stage">
      <div class="waiting-copy">
        <p class="eyebrow">La session est ouverte</p>
        <h1>Rejoignez le quiz</h1>
        <p>Scannez le QR code avec votre téléphone. L’instructeur vous acceptera ensuite dans la session.</p>
        <div class="session-code"><span>Code</span><b>${esc(state.code)}</b></div>
        <div class="participant-summary">
          <strong id="joinedCount">${Number(state.joined_count || 0)}</strong>
          <span>participant(s) admis</span>
        </div>
      </div>
      <div class="qr-card">
        <img src="/api/qr?code=${encodeURIComponent(state.code)}" alt="QR code pour rejoindre la session ${esc(state.code)}">
        <p>Scannez pour participer</p>
      </div>
    </section>`);
  const count = document.querySelector('#joinedCount');
  if (count) count.textContent = Number(state.joined_count || 0);
}

function ready(state) {
  setScreen(`ready:${state.code}`, `${header(state, 'Session en cours')}
    <section class="stage stage-center ready-stage">
      <div class="ready-symbol">⌛</div>
      <p class="eyebrow">Prochaine question</p>
      <h1>Préparez-vous</h1>
      <p>L’instructeur prépare la suite du quiz.</p>
    </section>`);
}

function liveQuestion(state) {
  const question = state.question;
  const mode = question.multiple_answers ? 'Réponses multiples' : 'Réponse unique';
  setScreen(`live:${question.id}`, `${header(state, `Question ${question.position}`)}
    <section class="stage question-stage">
      <div class="question-topline">
        <div>
          <p class="eyebrow">${esc(mode)}</p>
          <h1>Question ${Number(question.position || 1)}</h1>
        </div>
        <div id="questionTimer" class="countdown">—</div>
      </div>
      <h2>${esc(question.body)}</h2>
      <div class="answer-grid">
        ${question.options.map(option => `<div class="answer-card"><span>${esc(option.label)}</span><b>${esc(option.body)}</b></div>`).join('')}
      </div>
      <div class="response-footer">
        <div><span id="answeredCount">${Number(state.answered_count || 0)}</span> / <span id="joinedCount">${Number(state.joined_count || 0)}</span> réponses reçues</div>
        <div class="response-track"><span id="responseProgress"></span></div>
      </div>
    </section>`);
  updateLiveMetrics(state);
}

function updateLiveMetrics(state) {
  const joined = Number(state.joined_count || 0);
  const answered = Number(state.answered_count || 0);
  const remaining = state.question_ends_at
    ? Math.max(0, Math.ceil((new Date(state.question_ends_at).getTime() - Date.now()) / 1000))
    : 0;
  const timer = document.querySelector('#questionTimer');
  const answeredBox = document.querySelector('#answeredCount');
  const joinedBox = document.querySelector('#joinedCount');
  const progress = document.querySelector('#responseProgress');
  if (timer) timer.textContent = `${remaining}s`;
  if (answeredBox) answeredBox.textContent = answered;
  if (joinedBox) joinedBox.textContent = joined;
  if (progress) progress.style.width = `${joined ? Math.min(100, Math.round(answered * 100 / joined)) : 0}%`;
}

function poll(state) {
  const question = state.question;
  const results = state.poll_results || [];
  const byLabel = Object.fromEntries(results.map(result => [result.label, Number(result.response_count || 0)]));
  const total = results.reduce((sum, result) => sum + Number(result.response_count || 0), 0);
  const signature = results.map(result => `${result.label}:${result.response_count}`).join('|');
  setScreen(`poll:${question.id}:${signature}`, `${header(state, `Sondage · Question ${question.position}`)}
    <section class="stage poll-stage">
      <div class="poll-title">
        <div><p class="eyebrow">Répartition anonyme</p><h1>Résultats en direct</h1></div>
        <span>${total} sélection(s)</span>
      </div>
      <h2>${esc(question.body)}</h2>
      <div class="poll-list">
        ${question.options.map(option => {
          const count = byLabel[option.label] || 0;
          const percent = total ? Math.round(count * 100 / total) : 0;
          return `<div class="poll-item">
            <div class="poll-copy"><span class="answer-letter">${esc(option.label)}</span><b>${esc(option.body)}</b><strong>${percent}%</strong></div>
            <div class="poll-track"><span style="width:${percent}%"></span></div>
          </div>`;
        }).join('')}
      </div>
      <p class="poll-note">La correction sera affichée lorsque l’instructeur la déclenchera.</p>
    </section>`);
}

function correction(state) {
  const question = state.question;
  setScreen(`correction:${question.id}`, `${header(state, `Correction · Question ${question.position}`)}
    <section class="stage correction-stage">
      <div><p class="eyebrow">Réponse dévoilée</p><h1>Correction</h1></div>
      <h2>${esc(question.body)}</h2>
      <div class="answer-grid correction-grid">
        ${question.options.map(option => `<div class="answer-card ${option.is_correct ? 'correct' : 'incorrect'}">
          <span>${esc(option.label)}</span><b>${esc(option.body)}</b><strong>${option.is_correct ? '✓' : '×'}</strong>
        </div>`).join('')}
      </div>
      <p class="correction-note">La prochaine question sera lancée par l’instructeur.</p>
    </section>`);
}

function podium(state) {
  const ranking = state.podium || [];
  const medals = ['🥇', '🥈', '🥉'];
  const signature = ranking.map(item => `${item.alias}:${item.correct_answers}`).join('|');
  setScreen(`podium:${signature}`, `${header(state, 'Podium')}
    <section class="stage podium-stage">
      <div class="podium-heading"><p class="eyebrow">Classement facultatif</p><h1>Le podium du quiz</h1><p>Seuls les participants ayant accepté le classement sont affichés.</p></div>
      <div class="podium-list">
        ${ranking.map((item, index) => `<article class="podium-place place-${index + 1}"><span class="podium-medal">${medals[index]}</span><strong>${esc(item.alias)}</strong><b>${Number(item.correct_answers || 0)} bonne(s) réponse(s)</b></article>`).join('') || '<p class="muted">Aucun participant n’a choisi d’apparaître dans le podium.</p>'}
      </div>
    </section>`);
}

function finished(state) {
  setScreen(`finished:${state.code}`, `${header(state, 'Session terminée')}
    <section class="stage stage-center finished-stage">
      <div class="finished-symbol">✓</div>
      <p class="eyebrow">Quiz terminé</p>
      <h1>Merci pour votre participation</h1>
      <p>Les résultats détaillés sont disponibles auprès de l’instructeur.</p>
    </section>`);
}

function connectionError(message) {
  setScreen(`error:${message}`, `<section class="stage stage-center error-stage">
    <span class="brand-mark large">TS</span>
    <p class="eyebrow">Connexion interrompue</p>
    <h1>Affichage temporairement indisponible</h1>
    <p>${esc(message)}</p>
  </section>`);
}

async function waitForOffice() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (window.Office?.onReady) {
      await Promise.race([
        window.Office.onReady().catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 2500))
      ]);
      officeAvailable = Boolean(window.Office.context?.document);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

function readSetting() {
  if (officeAvailable) return normalizeCode(window.Office.context.document.settings.get(settingKey));
  return normalizeCode(localStorage.getItem(settingKey));
}

async function writeSetting(code) {
  localStorage.setItem(settingKey, code);
  if (!officeAvailable) return;
  window.Office.context.document.settings.set(settingKey, code);
  await new Promise((resolve, reject) => {
    window.Office.context.document.settings.saveAsync(result => {
      if (result.status === window.Office.AsyncResultStatus.Succeeded) resolve();
      else reject(new Error(result.error?.message || 'Impossible d’enregistrer le code dans la présentation.'));
    });
  });
}

async function detectView() {
  if (!officeAvailable || !window.Office.context.document.getActiveViewAsync) {
    editingView = !officeAvailable;
    return;
  }
  await new Promise(resolve => {
    window.Office.context.document.getActiveViewAsync(result => {
      editingView = result.status === window.Office.AsyncResultStatus.Succeeded && result.value === 'edit';
      resolve();
    });
  });
}

async function saveConfiguration(event) {
  event.preventDefault();
  const code = normalizeCode(document.querySelector('#sessionCode')?.value);
  if (code.length < 4) return configuration('Le code doit contenir entre 4 et 8 caractères.');
  try {
    const response = await fetch(`/api/presentation/state?code=${encodeURIComponent(code)}`, { credentials: 'omit', cache: 'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Erreur du serveur (${response.status}).`);
    await writeSetting(code);
    sessionCode = code;
    configurationOpen = false;
    activeScreen = '';
    await refresh();
  } catch (error) {
    configuration(error.message);
  }
}

async function refresh() {
  if (configurationOpen) return;
  if (!sessionCode) return configuration();
  try {
    const response = await fetch(`/api/presentation/state?code=${encodeURIComponent(sessionCode)}`, {
      credentials: 'omit',
      cache: 'no-store'
    });
    const state = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404 && editingView) return configuration(state?.message || 'Session introuvable.');
      throw new Error(state?.message || `Erreur du serveur (${response.status}).`);
    }
    if (state.status === 'finished') return finished(state);
    if (state.podium_visible) return podium(state);
    if (state.status === 'live' && state.question) {
      liveQuestion(state);
      return updateLiveMetrics(state);
    }
    if (state.status === 'polling' && state.question) return poll(state);
    if (state.reviewing && state.question) return correction(state);
    if (state.status === 'waiting' && !state.question) return waiting(state);
    return ready(state);
  } catch (error) {
    connectionError(error.message);
  }
}

async function start() {
  await waitForOffice();
  await detectView();
  if (officeAvailable && window.Office.EventType?.ActiveViewChanged) {
    window.Office.context.document.addHandlerAsync(window.Office.EventType.ActiveViewChanged, async () => {
      await detectView();
      activeScreen = '';
      await refresh();
    });
  }
  sessionCode = readSetting();
  await refresh();
  poller = window.setInterval(refresh, 1200);
}

window.addEventListener('beforeunload', () => window.clearInterval(poller));
start();
