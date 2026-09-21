import { createSynchronizedClock } from './synchronized-clock.js';

const root = document.querySelector('#powerpointApp');
const slideContextStorageKey = 'tsQuizPowerpointSlideContextV2';
let sessionCode = '';
let examCode = '';
let displayMode = 'session';
let activeScreen = '';
let poller = null;
let eventSource = null;
let streamFailures = 0;
let officeAvailable = false;
let editingView = false;
let configurationOpen = false;
const serverClock = createSynchronizedClock();
let countdownTicker = null;
let countdownDeadline = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const brandMark = classes => `<span class="${classes} brand-logo">TS<img src="/api/branding/logo" alt="Logo de l’organisme"></span>`;

function normalizeCode(value) {
  return String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function stopCountdown() {
  if (countdownTicker) window.clearInterval(countdownTicker);
  countdownTicker = null;
  countdownDeadline = null;
}

function renderCountdown() {
  const timer = document.querySelector('#questionTimer');
  if (timer && countdownDeadline) timer.textContent = `${serverClock.remainingSeconds(countdownDeadline)}s`;
}

function setScreen(key, body) {
  if (activeScreen === key) return;
  stopCountdown();
  activeScreen = key;
  root.innerHTML = body;
  document.querySelector('[data-configure]')?.addEventListener('click', () => configuration());
  document.querySelector('[data-exam-configure]')?.addEventListener('click', () => examConfiguration());
  window.dispatchEvent(new CustomEvent('ts:presentation-rendered'));
}

function questionMedia(question) {
  if (!question?.image_url) return '';
  return `<figure class="question-media"><img src="${esc(question.image_url)}" alt="Illustration de la question"></figure>`;
}

function questionContent(question, content) {
  const media = questionMedia(question);
  return `<div class="question-content${media ? ' has-image' : ''}"><div class="question-content-main">${content}</div>${media}</div>`;
}

function header(state, label) {
  return `<header class="presentation-header">
    <div class="presentation-brand">${brandMark('brand-mark')}<b>Formation</b></div>
    <div class="presentation-context">
      <span>${esc(state?.theme_name || 'TS Quiz')}</span>
      <b>${esc(state?.chapter_title || state?.quiz_title || '')}</b>
    </div>
    <div class="header-actions">
      <span class="phase-label">${esc(label)}</span>
      ${editingView ? '<button class="configure-button" type="button" data-exam-configure aria-label="Afficher le QR code d’un examen" title="QR code d’examen">▦</button><button class="configure-button" type="button" data-configure aria-label="Changer de session" title="Configurer la session">⚙</button>' : ''}
    </div>
  </header>`;
}

function configuration(message = '') {
  configurationOpen = true;
  stopSessionStream();
  setScreen(`configuration:${message}`, `<section class="stage stage-center configuration-stage">
    <div class="configuration-card">
      ${brandMark('brand-mark large')}
      <p class="eyebrow">Configuration PowerPoint</p>
      <h1>Associer cette diapo</h1>
      <p class="muted">Saisissez le code du quiz que cette diapo doit afficher. Les autres diapos restent indépendantes.</p>
      <form id="sessionForm" class="session-form">
        <label for="sessionCode">Code de session</label>
        <input id="sessionCode" maxlength="8" autocomplete="off" spellcheck="false" placeholder="Ex. THE1R3A4" value="${esc(sessionCode)}" required>
        <div class="configuration-actions">
          <button type="submit">Associer la session</button>
          ${sessionCode ? '<button class="configuration-cancel" type="button" data-cancel-configuration>Annuler</button>' : ''}
        </div>
      </form>
      ${message ? `<p class="configuration-error">${esc(message)}</p>` : ''}
      <p class="configuration-note">Cette association concerne uniquement cette diapo PowerPoint.</p>
      <button class="configuration-switch" type="button" data-exam-configure>▦ Configurer plutôt un examen final</button>
    </div>
  </section>`);
  document.querySelector('#sessionForm')?.addEventListener('submit', saveConfiguration);
  document.querySelector('[data-cancel-configuration]')?.addEventListener('click', cancelConfiguration);
  document.querySelector('#sessionCode')?.focus();
}

function examConfiguration(message = '') {
  configurationOpen = true;
  stopSessionStream();
  setScreen(`exam-configuration:${message}`, `<section class="stage stage-center configuration-stage">
    <div class="configuration-card">
      ${brandMark('brand-mark large')}
      <p class="eyebrow">Configuration PowerPoint</p>
      <h1>Afficher l’examen final</h1>
      <p class="muted">Saisissez le code de l’examen. PowerPoint affichera uniquement son QR code, jamais ses questions.</p>
      <form id="examForm" class="session-form">
        <label for="examCode">Code de l’examen</label>
        <input id="examCode" maxlength="8" autocomplete="off" spellcheck="false" placeholder="Ex. EXA1B2C3" value="${esc(examCode)}" required>
        <div class="configuration-actions"><button type="submit">Afficher le QR code</button><button class="configuration-cancel" type="button" data-configure>Retour au quiz</button></div>
      </form>
      ${message ? `<p class="configuration-error">${esc(message)}</p>` : ''}
      <p class="configuration-note">Les apprenants réaliseront l’examen individuellement sur leur téléphone ou leur ordinateur.</p>
    </div>
  </section>`);
  document.querySelector('#examForm')?.addEventListener('submit', saveExamConfiguration);
  document.querySelector('#examCode')?.focus();
}

async function cancelConfiguration() {
  if (!sessionCode) return home();
  configurationOpen = false;
  activeScreen = '';
  startSessionStream();
}

function home() {
  configurationOpen = false;
  stopSessionStream();
  setScreen('home', `<section class="stage stage-center ready-stage">
    ${brandMark('brand-mark large')}
    <p class="eyebrow">TS Quiz</p>
    <h1>Diapo prête</h1>
    <p>Cette diapo reste sur l’accueil tant qu’aucun quiz ne lui est associé.</p>
    ${editingView ? '<button class="configuration-switch" type="button" data-configure>Associer un quiz à cette diapo</button>' : ''}
  </section>`);
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
      ${questionContent(question, `<div class="answer-grid">
        ${question.options.map(option => `<div class="answer-card"><span>${esc(option.label)}</span><b>${esc(option.body)}</b></div>`).join('')}
      </div>`)}
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
  countdownDeadline = state.question_ends_at || null;
  if (countdownDeadline && !countdownTicker) countdownTicker = window.setInterval(renderCountdown, 200);
  renderCountdown();
  const answeredBox = document.querySelector('#answeredCount');
  const joinedBox = document.querySelector('#joinedCount');
  const progress = document.querySelector('#responseProgress');
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
      ${questionContent(question, `<div class="poll-list">
        ${question.options.map(option => {
          const count = byLabel[option.label] || 0;
          const percent = total ? Math.round(count * 100 / total) : 0;
          return `<div class="poll-item">
            <div class="poll-copy"><span class="answer-letter">${esc(option.label)}</span><b>${esc(option.body)}</b><strong>${percent}%</strong></div>
            <div class="poll-track"><span style="width:${percent}%"></span></div>
          </div>`;
        }).join('')}
      </div>`)}
      <p class="poll-note">La correction sera affichée lorsque l’instructeur la déclenchera.</p>
    </section>`);
}

function correction(state) {
  const question = state.question;
  setScreen(`correction:${question.id}`, `${header(state, `Correction · Question ${question.position}`)}
    <section class="stage correction-stage">
      <div><p class="eyebrow">Réponse dévoilée</p><h1>Correction</h1></div>
      <h2>${esc(question.body)}</h2>
      ${questionContent(question, `<div class="answer-grid correction-grid">
        ${question.options.map(option => `<div class="answer-card ${option.is_correct ? 'correct' : 'incorrect'}">
          <span>${esc(option.label)}</span><b>${esc(option.body)}</b><strong>${option.is_correct ? '✓' : '×'}</strong>
        </div>`).join('')}
      </div>`)}
      <p class="correction-note">La prochaine question sera lancée par l’instructeur.</p>
    </section>`);
}

function podium(state) {
  const ranking = state.podium || [];
  const medals = ['🥇', '🥈', '🥉'];
  const signature = ranking.map(item => `${item.alias}:${item.score_percent}`).join('|');
  const density = ranking.length > 24 ? 'ranking-four-columns' : ranking.length > 12 ? 'ranking-three-columns' : ranking.length > 5 ? 'ranking-two-columns' : '';
  setScreen(`podium:${signature}`, `${header(state, 'Classement')}
    <section class="stage podium-stage ${density}">
      <div class="podium-heading"><p class="eyebrow">Classement facultatif</p><h1>Classement du quiz</h1><p>Seuls les pseudonymes des participants ayant donné leur accord sont affichés.</p></div>
      <div class="podium-list">
        ${ranking.map((item, index) => `<article class="podium-place place-${index + 1}"><span class="podium-medal">${medals[index] || `${index + 1}.`}</span><strong>${esc(item.alias)}</strong><b>${Number(item.score_percent || 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</b></article>`).join('') || '<p class="muted">Aucun participant n’a choisi d’apparaître dans le classement.</p>'}
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
    ${brandMark('brand-mark large')}
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

function readSlideContext() {
  const storage = officeAvailable ? sessionStorage : localStorage;
  try {
    const runtimeValue = JSON.parse(storage.getItem(slideContextStorageKey) || '{}');
    const savedSetting = officeAvailable ? window.Office.context.document.settings.get(slideContextStorageKey) : null;
    const persistedValue = typeof savedSetting === 'string' ? JSON.parse(savedSetting || '{}') : (savedSetting || {});
    const parsed = runtimeValue.assigned ? runtimeValue : (persistedValue?.assigned ? persistedValue : {});
    if (parsed.assigned && !runtimeValue.assigned) {
      sessionStorage.setItem(slideContextStorageKey, JSON.stringify(parsed));
    }
    return {
      sessionCode:normalizeCode(parsed.sessionCode),
      examCode:normalizeCode(parsed.examCode),
      displayMode:parsed.displayMode === 'exam' ? 'exam' : 'session'
    };
  } catch {
    return { sessionCode:'', examCode:'', displayMode:'session' };
  }
}

async function saveSlideContext() {
  const storage = officeAvailable ? sessionStorage : localStorage;
  const value = { assigned:true, sessionCode, examCode, displayMode };
  storage.setItem(slideContextStorageKey, JSON.stringify(value));
  if (officeAvailable) {
    window.Office.context.document.settings.set(slideContextStorageKey, value);
    await new Promise((resolve, reject) => {
      window.Office.context.document.settings.saveAsync(result => {
        if (result.status === window.Office.AsyncResultStatus.Succeeded) resolve();
        else reject(new Error(result.error?.message || 'Impossible d’enregistrer l’association de cette diapo.'));
      });
    });
  }
  window.dispatchEvent(new CustomEvent('ts:presentation-context', { detail:currentContext() }));
}

function currentContext() {
  return { mode:displayMode, code:displayMode === 'exam' ? examCode : sessionCode };
}

window.tsQuizPowerpointContext = currentContext;

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
    sessionCode = code;
    displayMode = 'session';
    await saveSlideContext();
    configurationOpen = false;
    activeScreen = '';
    startSessionStream();
  } catch (error) {
    configuration(error.message);
  }
}

async function saveExamConfiguration(event) {
  event.preventDefault();
  const code = normalizeCode(document.querySelector('#examCode')?.value);
  if (code.length < 4) return examConfiguration('Le code doit contenir entre 4 et 8 caractères.');
  try {
    const response = await fetch(`/api/presentation/exam?code=${encodeURIComponent(code)}`, { credentials:'omit', cache:'no-store' });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Erreur du serveur (${response.status}).`);
    examCode = code;
    displayMode = 'exam';
    await saveSlideContext();
    configurationOpen = false;
    activeScreen = '';
    await refresh();
    startExamPolling();
  } catch (error) {
    examConfiguration(error.message);
  }
}

function examQrScreen(state) {
  setScreen(`exam:${state.code}:${state.status}`, `${header({theme_name:state.theme_name,chapter_title:state.group_name}, 'Examen final')}
    <section class="stage waiting-stage exam-qr-stage">
      <div class="waiting-copy"><p class="eyebrow">Évaluation individuelle</p><h1>${esc(state.title)}</h1><p>Scannez ce QR code pour ouvrir l’examen sur votre téléphone ou votre ordinateur. Les questions ne sont pas projetées.</p><div class="session-code"><span>Code</span><b>${esc(state.code)}</b></div><p class="exam-meta">Durée : <b>${Number(state.duration_minutes)} minutes</b> · État : <b>${state.status === 'open' ? 'Ouvert' : state.status === 'closed' ? 'Clôturé' : 'En préparation'}</b></p></div>
      <div class="qr-card"><img src="/api/presentation/exam-qr?code=${encodeURIComponent(state.code)}" alt="QR code de l’examen ${esc(state.code)}"><p>Scannez pour passer l’examen</p></div>
    </section>`);
}

async function refresh() {
  if (configurationOpen) return;
  if (displayMode === 'exam') {
    if (!examCode) return examConfiguration();
    try {
      const response = await fetch(`/api/presentation/exam?code=${encodeURIComponent(examCode)}`, {credentials:'omit',cache:'no-store'});
      const state = await response.json().catch(() => null);
      if (!response.ok) throw new Error(state?.message || `Erreur du serveur (${response.status}).`);
      return examQrScreen(state);
    } catch (error) {
      if (editingView) return examConfiguration(error.message);
      return connectionError(error.message);
    }
  }
  if (!sessionCode) return home();
  return refreshSessionOnce();
}

function applySessionState(state, requestStartedAt = null) {
  if (state.server_now) serverClock.sync(state.server_now, requestStartedAt ?? Date.now());
  if (state.status === 'finished') finished(state);
  else if (state.podium_visible) podium(state);
  else if (state.status === 'live' && state.question) {
    liveQuestion(state);
    updateLiveMetrics(state);
  } else if (state.status === 'polling' && state.question) poll(state);
  else if (state.reviewing && state.question) correction(state);
  else if (state.status === 'waiting' && !state.question) waiting(state);
  else ready(state);
  window.dispatchEvent(new CustomEvent('ts:presentation-state', { detail:state }));
}

async function refreshSessionOnce() {
  try {
    const requestStartedAt = serverClock.markRequest();
    const response = await fetch(`/api/presentation/state?code=${encodeURIComponent(sessionCode)}`, {
      credentials: 'omit',
      cache: 'no-store'
    });
    const state = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 404 && editingView) return configuration(state?.message || 'Session introuvable.');
      throw new Error(state?.message || `Erreur du serveur (${response.status}).`);
    }
    applySessionState(state, requestStartedAt);
  } catch (error) {
    connectionError(error.message);
  }
}

function stopFallbackPolling() {
  if (poller) window.clearInterval(poller);
  poller = null;
}

function stopSessionStream() {
  eventSource?.close();
  eventSource = null;
  streamFailures = 0;
  stopFallbackPolling();
}

function startFallbackPolling() {
  if (poller || displayMode !== 'session' || !sessionCode || configurationOpen) return;
  void refreshSessionOnce();
  poller = window.setInterval(refreshSessionOnce, 5_000);
}

function startSessionStream() {
  stopSessionStream();
  stopFallbackPolling();
  if (displayMode !== 'session' || !sessionCode || configurationOpen) return;
  if (!window.EventSource) return startFallbackPolling();

  const source = new EventSource(`/api/quality/presentation/stream?code=${encodeURIComponent(sessionCode)}`);
  eventSource = source;
  source.addEventListener('open', () => {
    streamFailures = 0;
    stopFallbackPolling();
  });
  source.addEventListener('state', event => {
    try {
      streamFailures = 0;
      applySessionState(JSON.parse(event.data));
    } catch {
      startFallbackPolling();
    }
  });
  source.addEventListener('unavailable', event => {
    try {
      const payload = JSON.parse(event.data);
      if (Number(payload.status) === 404 && editingView) configuration(payload.message || 'Session introuvable.');
    } catch { /* The automatic reconnection remains active. */ }
  });
  source.onerror = () => {
    streamFailures += 1;
    if (streamFailures >= 3) {
      connectionError('La connexion en direct est interrompue. Une vérification de secours reste active.');
      startFallbackPolling();
    }
  };
}

function startExamPolling() {
  stopSessionStream();
  stopFallbackPolling();
  if (displayMode !== 'exam' || !examCode || configurationOpen) return;
  poller = window.setInterval(refresh, 1_200);
}

async function start() {
  await waitForOffice();
  await detectView();
  if (officeAvailable && window.Office.EventType?.ActiveViewChanged) {
    window.Office.context.document.addHandlerAsync(window.Office.EventType.ActiveViewChanged, async () => {
      await detectView();
      activeScreen = '';
      if (displayMode === 'session') startSessionStream();
      else {
        await refresh();
        startExamPolling();
      }
    });
  }
  const context = readSlideContext();
  sessionCode = context.sessionCode;
  examCode = context.examCode;
  displayMode = context.displayMode;
  window.dispatchEvent(new CustomEvent('ts:presentation-context', { detail:currentContext() }));
  if (displayMode === 'session' && sessionCode) startSessionStream();
  else if (displayMode === 'exam' && examCode) {
    await refresh();
    startExamPolling();
  } else home();
}

window.addEventListener('beforeunload', () => { stopSessionStream(); stopFallbackPolling(); stopCountdown(); });
start();
