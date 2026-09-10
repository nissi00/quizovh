const root = document.querySelector('#surveyPowerPoint');
const queryCode = (new URLSearchParams(location.search).get('survey') || '').trim().toUpperCase();
const settingKey = 'tsSatisfactionSurveyCode';
let officeAvailable = false;
let editingView = false;
let code = queryCode;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const formatDate = value => value ? new Date(`${String(value).slice(0,10)}T12:00:00`).toLocaleDateString('fr-FR') : '—';
const normalizeCode = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

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

function readSetting() {
  if (officeAvailable) return window.Office.context.document.settings.get(settingKey);
  return localStorage.getItem(settingKey);
}

async function writeSetting(value) {
  localStorage.setItem(settingKey, value);
  if (!officeAvailable) return;
  window.Office.context.document.settings.set(settingKey, value);
  await new Promise((resolve, reject) => {
    window.Office.context.document.settings.saveAsync(result => {
      if (result.status === window.Office.AsyncResultStatus.Succeeded) resolve();
      else reject(new Error(result.error?.message || "Impossible d’enregistrer le code de l’enquête dans la présentation."));
    });
  });
}

function configuration(message = '') {
  root.innerHTML = `<section class="survey-projection-card survey-projection-config">
    <p class="survey-section">Configuration PowerPoint</p>
    <h1>Associer l’enquête de satisfaction</h1>
    <p>Saisissez le code à 8 caractères affiché dans le panneau instructeur.</p>
    <form id="surveyPowerPointForm">
      <label for="surveyPowerPointCode">Code de l’enquête</label>
      <input id="surveyPowerPointCode" maxlength="8" autocomplete="off" spellcheck="false" value="${esc(code)}" placeholder="Ex. AB12CD34" required>
      <button class="survey-config-button" type="submit">Afficher le QR code</button>
    </form>
    ${message ? `<p class="survey-config-error">${esc(message)}</p>` : ''}
  </section>`;
  document.querySelector('#surveyPowerPointForm')?.addEventListener('submit', saveConfiguration);
  document.querySelector('#surveyPowerPointCode')?.focus();
}

async function saveConfiguration(event) {
  event.preventDefault();
  const nextCode = normalizeCode(document.querySelector('#surveyPowerPointCode')?.value);
  if (!/^[A-Z0-9]{8}$/.test(nextCode)) return configuration('Le code doit contenir 8 caractères.');
  try {
    const response = await fetch(`/api/presentation/survey?code=${encodeURIComponent(nextCode)}`, { cache:'no-store', credentials:'omit' });
    const survey = await response.json().catch(() => null);
    if (!response.ok) throw new Error(survey?.message || `Erreur du serveur (${response.status}).`);
    await writeSetting(nextCode);
    code = nextCode;
    renderSurvey(survey);
  } catch (error) {
    configuration(error.message);
  }
}

function renderSurvey(survey) {
  if (survey.status !== 'open') {
    root.innerHTML = `<section class="survey-projection-card"><p class="survey-section">Enquête de satisfaction</p><h1>Cette enquête est clôturée.</h1>${editingView?'<button class="survey-config-button" id="changeSurvey" type="button">Changer d’enquête</button>':''}</section>`;
    document.querySelector('#changeSurvey')?.addEventListener('click', () => configuration());
    return;
  }
  root.innerHTML = `<header class="survey-projection-header">
    <div class="survey-projection-brand"><span>TS</span><b>Formation</b></div>
    <div>${esc(survey.formation_title)}</div>
    ${editingView?'<button class="survey-projection-settings" id="changeSurvey" type="button" aria-label="Changer d’enquête" title="Changer d’enquête">⚙</button>':''}
  </header>
  <section class="survey-projection-body">
    <div class="survey-projection-copy">
      <p>ENQUÊTE DE SATISFACTION</p>
      <h1>Votre avis nous aide à améliorer nos formations.</h1>
      <h2>Scannez le QR code pour répondre</h2>
      <div class="survey-projection-meta">${formatDate(survey.start_date)} — ${formatDate(survey.end_date)} · ${esc(survey.trainer_name)}</div>
    </div>
    <div class="survey-projection-qr">
      <img src="/api/presentation/survey-qr?code=${encodeURIComponent(code)}" alt="QR code de l’enquête">
      <b>Scannez pour répondre</b>
    </div>
  </section>`;
  document.querySelector('#changeSurvey')?.addEventListener('click', () => configuration());
}

async function loadSurvey() {
  if (!/^[A-Z0-9]{8}$/.test(code)) return configuration();
  try {
    const response = await fetch(`/api/presentation/survey?code=${encodeURIComponent(code)}`, { cache:'no-store', credentials:'omit' });
    const survey = await response.json().catch(() => null);
    if (!response.ok) throw new Error(survey?.message || `Erreur du serveur (${response.status}).`);
    renderSurvey(survey);
  } catch (error) {
    if (editingView) return configuration(error.message);
    root.innerHTML = `<section class="survey-projection-card"><h1>Affichage temporairement indisponible</h1><p>${esc(error.message)}</p></section>`;
  }
}

async function start() {
  await waitForOffice();
  await detectView();
  if (!code) code = normalizeCode(readSetting());
  if (queryCode && /^[A-Z0-9]{8}$/.test(queryCode)) {
    code = queryCode;
    if (officeAvailable) await writeSetting(code).catch(() => undefined);
  }
  if (officeAvailable && window.Office.EventType?.ActiveViewChanged) {
    window.Office.context.document.addHandlerAsync(window.Office.EventType.ActiveViewChanged, async () => {
      await detectView();
      await loadSurvey();
    });
  }
  await loadSurvey();
}

start();
