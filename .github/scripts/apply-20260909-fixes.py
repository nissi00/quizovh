from pathlib import Path
import re


def read(path):
    return Path(path).read_text(encoding='utf-8')


def write(path, text):
    Path(path).write_text(text, encoding='utf-8')


def replace_once(path, old, new):
    text = read(path)
    if old not in text:
        raise SystemExit(f'Motif introuvable dans {path}: {old[:120]!r}')
    write(path, text.replace(old, new, 1))


def sub_once(path, pattern, repl):
    text = read(path)
    new, count = re.subn(pattern, repl, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f'Remplacement regex impossible dans {path}: {pattern[:120]!r} ({count})')
    write(path, new)


clock = """export function createSynchronizedClock() {
  let offsetMs = 0;
  let synchronized = false;

  function markRequest() {
    return Date.now();
  }

  function sync(serverNow, requestStartedAt = Date.now()) {
    const serverMs = new Date(serverNow).getTime();
    if (!Number.isFinite(serverMs)) return;
    const receivedAt = Date.now();
    const midpoint = requestStartedAt + Math.max(0, receivedAt - requestStartedAt) / 2;
    const candidate = serverMs - midpoint;
    if (!synchronized || Math.abs(candidate - offsetMs) > 1500) offsetMs = candidate;
    else offsetMs = offsetMs * 0.7 + candidate * 0.3;
    synchronized = true;
  }

  function now() {
    return Date.now() + offsetMs;
  }

  function remainingSeconds(deadline) {
    const end = new Date(deadline).getTime();
    if (!Number.isFinite(end)) return 0;
    return Math.max(0, Math.ceil((end - now()) / 1000));
  }

  return { markRequest, sync, now, remainingSeconds };
}
"""
write('synchronized-clock.js', clock)

replace_once('Dockerfile',
    'COPY app.js superadmin.js learner.js exam.js api.js style.css powerpoint.js powerpoint.css certificate.js ./public/',
    'COPY app.js superadmin.js learner.js exam.js api.js synchronized-clock.js style.css powerpoint.js powerpoint.css certificate.js ./public/')

# API navigateur
replace_once('api.js',
"""export async function updateLiveParticipantPodium(id, showOnPodium) {
  return request(`/live-participants/${encodeURIComponent(id)}/podium`, {
    method: 'PATCH',
    body: JSON.stringify({ show_on_podium: showOnPodium, oral_confirmation: true })
  });
}
""",
"""export async function updateLiveParticipantPodium(id, showOnPodium, podiumAlias = null) {
  return request(`/live-participants/${encodeURIComponent(id)}/podium`, {
    method: 'PATCH',
    body: JSON.stringify({ show_on_podium: showOnPodium, podium_alias: podiumAlias, oral_confirmation: true })
  });
}
""")
replace_once('api.js',
"""          show_on_podium: params.p_show_on_podium,
          data_processing_informed: params.p_data_processing_informed,
""",
"""          show_on_podium: params.p_show_on_podium,
          podium_alias: params.p_podium_alias,
          data_processing_informed: params.p_data_processing_informed,
""")
# deuxième occurrence pour join-by-code
replace_once('api.js',
"""          show_on_podium: params.p_show_on_podium,
          data_processing_informed: params.p_data_processing_informed,
""",
"""          show_on_podium: params.p_show_on_podium,
          podium_alias: params.p_podium_alias,
          data_processing_informed: params.p_data_processing_informed,
""")
replace_once('api.js',
"""    case 'logout_learner':
      return request('/learner/logout', { method: 'POST', body: '{}' });
""",
"""    case 'update_learner_podium_preference':
      return request('/learner/podium-preference', {
        method: 'PATCH',
        body: JSON.stringify({
          code: params.p_code,
          show_on_podium: params.p_show_on_podium,
          podium_alias: params.p_podium_alias
        })
      });
    case 'logout_learner':
      return request('/learner/logout', { method: 'POST', body: '{}' });
""")

# Interface apprenant
replace_once('learner.js',
"import { signInAnonymously, rpc } from './api.js';\n",
"import { signInAnonymously, rpc } from './api.js';\nimport { createSynchronizedClock } from './synchronized-clock.js';\n")
replace_once('learner.js',
"""let activeQuestionImageUrl = '';
let serverTimeOffsetMs = 0;
let pendingParticipantCode = '';
let pendingPodiumChoice = false;
""",
"""let activeQuestionImageUrl = '';
let pendingParticipantCode = '';
const serverClock = createSynchronizedClock();
""")

helpers = r'''function podiumChoiceFields(alias = '', checked = false) {
  return `<fieldset class="podium-preference"><legend>Classement du quiz</legend><label class="competition-consent"><input id="podiumConsent" type="checkbox" ${checked?'checked':''} onchange="togglePodiumAlias()"><span><b>J’accepte que mon pseudonyme apparaisse dans le classement projeté</b><small>Ce choix est facultatif et pourra être modifié dans la salle d’attente.</small></span></label><label for="podiumAlias">Mon pseudonyme</label><input id="podiumAlias" maxlength="40" autocomplete="nickname" placeholder="Ex. Rania92" value="${esc(alias)}" ${checked?'':'disabled'}><small>Votre nom et votre prénom ne sont jamais affichés sur PowerPoint.</small></fieldset>`;
}

function togglePodiumAlias() {
  const checked = document.querySelector('#podiumConsent')?.checked === true;
  const input = document.querySelector('#podiumAlias');
  if (!input) return;
  input.disabled = !checked;
  if (checked) input.focus();
}

function podiumValues() {
  const showOnPodium = document.querySelector('#podiumConsent')?.checked === true;
  const alias = document.querySelector('#podiumAlias')?.value.trim().replace(/\s+/g, ' ') || '';
  if (showOnPodium && (alias.length < 2 || alias.length > 40)) {
    alert('Choisissez un pseudonyme contenant entre 2 et 40 caractères.');
    return null;
  }
  return { showOnPodium, alias };
}

'''
replace_once('learner.js', 'function firstParticipation() {', helpers + 'function firstParticipation() {')
sub_once('learner.js', r"function firstParticipation\(\) \{.*?\n\}\n\nfunction knownParticipation\(\) \{.*?\n\}\n\nfunction knownPrivacyConfirmation", r'''function firstParticipation() {
  viewKey = 'first-participation';
  screen(`<div class="login"><p class="eyebrow">Première participation</p><h1>Créer votre identité</h1><div class="card"><label>Prénom</label><input id="firstName" autocomplete="given-name" placeholder="Prénom"><label>Nom</label><input id="lastName" autocomplete="family-name" placeholder="Nom">${privacyAcknowledgements()}${podiumChoiceFields()}<p class="session-detected"><span>✓</span> Session reconnue depuis le QR code</p><div class="join-actions"><button class="button" type="button" onclick="enter()">Entrer dans la salle d’attente →</button><button class="button secondary" type="button" onclick="participationChoice()">Retour</button></div></div></div>`);
}

function knownParticipation() {
  viewKey = 'known-participation';
  screen(`<div class="login"><p class="eyebrow">Participant déjà inscrit</p><h1>Retrouver votre progression</h1><div class="card"><label for="participantCode">Code personnel</label><input id="participantCode" class="participant-code-input" autocomplete="off" spellcheck="false" maxlength="12" placeholder="TS-8LZJ"><p class="muted">Votre préférence de classement déjà enregistrée sera réutilisée. Vous pourrez la modifier dans la salle d’attente.</p><div class="join-actions"><button class="button" type="button" onclick="enterWithCode()">Continuer →</button><button class="button secondary" type="button" onclick="participationChoice()">Retour</button></div></div></div>`);
}

function knownPrivacyConfirmation''')

sub_once('learner.js', r"async function enter\(\) \{.*?\n\}\n\nasync function enterWithCode", r'''async function enter() {
  const first = document.querySelector('#firstName')?.value.trim();
  const last = document.querySelector('#lastName')?.value.trim();
  if (!first || !last) return alert('Renseignez votre prénom et votre nom.');
  if (!code) return alert('Le lien de session est invalide. Scannez à nouveau le QR code.');
  const privacy = validPrivacyAcknowledgements();
  if (!privacy) return;
  const podium = podiumValues();
  if (!podium) return;
  try {
    await signInAnonymously();
    const joined = await rpc('join_live_by_code', { p_code: code, p_first_name: first, p_last_name: last, p_show_on_podium: podium.showOnPodium, p_podium_alias: podium.alias, p_data_processing_informed: privacy.dataProcessingInformed, p_privacy_policy_acknowledged: privacy.privacyPolicyAcknowledged });
    learnerProfile = joined.learner;
    viewKey = '';
    await startPolling();
  } catch (error) {
    alert(error.message);
  }
}

async function enterWithCode''')

sub_once('learner.js', r"async function enterWithCode\(confirmPrivacyDocuments = false\) \{.*?\n\}\n\nasync function changeParticipant", r'''async function enterWithCode(confirmPrivacyDocuments = false) {
  const participantCode = document.querySelector('#participantCode')?.value.trim() || pendingParticipantCode;
  if (!participantCode) return alert('Saisissez votre code personnel.');
  const privacy = confirmPrivacyDocuments ? validPrivacyAcknowledgements() : null;
  if (confirmPrivacyDocuments && !privacy) return;
  try {
    const joined = await rpc('join_live_by_participant_code', { p_code: code, p_participant_code: participantCode, p_data_processing_informed: privacy?.dataProcessingInformed, p_privacy_policy_acknowledged: privacy?.privacyPolicyAcknowledged });
    learnerProfile = joined.learner;
    pendingParticipantCode = '';
    viewKey = '';
    await startPolling();
  } catch (error) {
    if (error.status === 428) {
      pendingParticipantCode = participantCode;
      return knownPrivacyConfirmation();
    }
    alert(error.message);
  }
}

async function changeParticipant''')

sub_once('learner.js', r"function waiting\(state\) \{.*?\n\}\n\nfunction readyForNext", r'''function waiting(state) {
  const participants = state?.waiting_participants || [];
  const participantCode = state?.learner?.participant_code || learnerProfile?.participant_code || '';
  const signature = participants.map(person => `${person.id}:${person.status}`).join(',');
  const key = `waiting-list:${signature}:${participantCode}:${state.show_on_podium?'1':'0'}:${state.podium_alias||''}`;
  if (viewKey === key) return;
  viewKey = key;
  const people = participants.map(person => `<div class="waiting-person ${person.is_current?'is-current':''}"><b>${esc(person.first_name)} ${esc(person.last_name)}</b>${person.is_current?'<span class="you-badge">vous</span>':''}</div>`).join('');
  const podiumSection = state.show_podium ? `<section class="personal-code-card podium-waiting-card"><p><b>Classement facultatif</b></p>${podiumChoiceFields(state.podium_alias || '', state.show_on_podium === true)}<button class="button secondary" type="button" onclick="savePodiumPreference()">Enregistrer mon choix</button></section>` : '';
  screen(`<div class="login"><p class="eyebrow center">Salle d’attente</p><div class="card waiting-room-card"><div class="row"><div><p class="eyebrow">Vous avez rejoint le quiz</p><h1>Les participants en attente</h1></div><span class="count-badge">${participants.length}</span></div><p class="muted">Votre instructeur validera bientôt les entrées. Vous serez dirigé·e automatiquement vers le quiz.</p><section class="personal-code-card"><p>Votre code personnel pour toute la formation</p><strong>${esc(participantCode)}</strong><p>Faites une capture d’écran ou conservez ce code dans un endroit sûr.</p><button id="copyParticipantCode" class="button secondary" type="button" onclick="copyParticipantCode()">Copier le code</button></section>${podiumSection}<div class="waiting-people">${people||'<p class="muted center">Votre demande a bien été envoyée.</p>'}</div></div></div>`);
}

async function savePodiumPreference() {
  const podium = podiumValues();
  if (!podium) return;
  try {
    await rpc('update_learner_podium_preference', { p_code: code, p_show_on_podium: podium.showOnPodium, p_podium_alias: podium.alias });
    viewKey = '';
    await refresh();
  } catch (error) {
    alert(error.message);
  }
}

function readyForNext''')

replace_once('learner.js',
"""  try {
    const state = await rpc('live_learner_state', { p_code: code });
    if (!state) return;
    if (state.server_now) serverTimeOffsetMs = new Date(state.server_now).getTime() - Date.now();
""",
"""  try {
    const requestStartedAt = serverClock.markRequest();
    const state = await rpc('live_learner_state', { p_code: code });
    if (!state) return;
    if (state.server_now) serverClock.sync(state.server_now, requestStartedAt);
""")
replace_once('learner.js',
"const left = Math.max(0, Math.ceil((new Date(state.question_ends_at) - (Date.now() + serverTimeOffsetMs)) / 1000));",
"const left = serverClock.remainingSeconds(state.question_ends_at);")
replace_once('learner.js', 'const clock = setInterval(tick, 400);', 'const clock = setInterval(tick, 200);')
replace_once('learner.js',
"""  copyParticipantCode,
  saveDraftSelection,
""",
"""  copyParticipantCode,
  togglePodiumAlias,
  savePodiumPreference,
  saveDraftSelection,
""")

# Examen final
write('exam.js', read('exam.js').replace("const app = document.querySelector('#examApp');", "import { createSynchronizedClock } from './synchronized-clock.js';\n\nconst app = document.querySelector('#examApp');", 1))
replace_once('exam.js', "let serverTimeOffsetMs = 0;", "const serverClock = createSynchronizedClock();")
replace_once('exam.js', "  if(state.server_now)serverTimeOffsetMs=new Date(state.server_now).getTime()-Date.now();\n", "")
replace_once('exam.js',
"function startTimer(expiresAt) {\n  clearInterval(clock);\n  const tick=()=>{const seconds=Math.max(0,Math.ceil((new Date(expiresAt)-(Date.now()+serverTimeOffsetMs))/1000)),minutes=Math.floor(seconds/60),rest=String(seconds%60).padStart(2,'0'),box=document.querySelector('#examTimer');if(box)box.textContent=`${minutes}:${rest}`;if(seconds<=0){clearInterval(clock);loadState()}};\n  tick();clock=setInterval(tick,1000);\n}",
"function startTimer(expiresAt) {\n  clearInterval(clock);\n  let expiryHandled=false;\n  const tick=()=>{const seconds=serverClock.remainingSeconds(expiresAt),minutes=Math.floor(seconds/60),rest=String(seconds%60).padStart(2,'0'),box=document.querySelector('#examTimer');if(box)box.textContent=`${minutes}:${rest}`;if(seconds<=0&&!expiryHandled){expiryHandled=true;clearInterval(clock);loadState()}};\n  tick();clock=setInterval(tick,200);\n}")
replace_once('exam.js',
"async function loadState(){try{const state=await api(`/final-exams/${encodeURIComponent(examCode)}/state`);renderExam(state)}catch(error){if(error.status===401||error.status===404)return joinRecognized();shell(`<div class=\"login\"><div class=\"notice\">${esc(error.message)}</div></div>`)}}",
"async function loadState(){const requestStartedAt=serverClock.markRequest();try{const state=await api(`/final-exams/${encodeURIComponent(examCode)}/state`);if(state?.server_now)serverClock.sync(state.server_now,requestStartedAt);renderExam(state)}catch(error){if(error.status===401||error.status===404)return joinRecognized();shell(`<div class=\"login\"><div class=\"notice\">${esc(error.message)}</div></div>`)}}")

# PowerPoint
write('powerpoint.js', read('powerpoint.js').replace("const root = document.querySelector('#powerpointApp');", "import { createSynchronizedClock } from './synchronized-clock.js';\n\nconst root = document.querySelector('#powerpointApp');", 1))
replace_once('powerpoint.js', "let serverTimeOffsetMs = 0;", "const serverClock = createSynchronizedClock();\nlet countdownTicker = null;\nlet countdownDeadline = null;")
replace_once('powerpoint.js',
"""function setScreen(key, body) {
  if (activeScreen === key) return;
  activeScreen = key;
""",
"""function stopCountdown() {
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
""")
sub_once('powerpoint.js', r"function updateLiveMetrics\(state\) \{.*?\n\}", r'''function updateLiveMetrics(state) {
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
}''')
replace_once('powerpoint.js',
"""  try {
    const response = await fetch(`/api/presentation/state?code=${encodeURIComponent(sessionCode)}`, {
""",
"""  try {
    const requestStartedAt = serverClock.markRequest();
    const response = await fetch(`/api/presentation/state?code=${encodeURIComponent(sessionCode)}`, {
""")
replace_once('powerpoint.js',
"""    if (state.server_now) serverTimeOffsetMs = new Date(state.server_now).getTime() - Date.now();
""",
"""    if (state.server_now) serverClock.sync(state.server_now, requestStartedAt);
""")
replace_once('powerpoint.js',
"window.addEventListener('beforeunload', () => window.clearInterval(poller));",
"window.addEventListener('beforeunload', () => { window.clearInterval(poller); stopCountdown(); });")

# Instructeur : demander le vrai pseudonyme lors d'un ajout
sub_once('app.js', r"async function changePodiumParticipant\(participantId,showOnPodium\)\{.*?\n\}", r'''async function changePodiumParticipant(participantId,showOnPodium){
  const message=showOnPodium?'Le participant vous a-t-il demandé oralement de l’ajouter au classement ?':'Le participant vous a-t-il demandé oralement de le retirer du classement ?';
  if(!confirm(message))return;
  let alias=null;
  if(showOnPodium){
    const participant=live.flatMap(session=>session.session_participants||[]).find(item=>item.id===participantId);
    const previous=/^Joueur-[A-F0-9]{6}$/i.test(participant?.podium_alias||'')?'':(participant?.podium_alias||'');
    alias=prompt('Quel pseudonyme le participant souhaite-t-il afficher ?',previous);
    if(alias===null)return;
    alias=alias.trim().replace(/\s+/g,' ');
    if(alias.length<2||alias.length>40)return alert('Le pseudonyme doit contenir entre 2 et 40 caractères.');
  }
  try{await updateLiveParticipantPodium(participantId,showOnPodium,alias);await refresh()}catch(error){alert(error.message)}
}''')

# Base de données initiale
replace_once('db/init/001_schema.sql',
"""  privacy_policy_version text,
  data_processing_notice_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
""",
"""  privacy_policy_version text,
  data_processing_notice_version text,
  podium_alias text,
  podium_opt_in boolean NOT NULL DEFAULT false,
  podium_preference_set_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
""")

migration = """ALTER TABLE app_users ADD COLUMN IF NOT EXISTS podium_alias text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS podium_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS podium_preference_set_at timestamptz;

UPDATE session_participants
SET show_on_podium=false,
    podium_alias=NULL,
    podium_consent_at=NULL,
    podium_consent_changed_at=now(),
    podium_consent_source='learner_form'
WHERE podium_alias ~ '^Joueur-[A-F0-9]{6}$';
"""
write('db/migrations/20260909_02_timer_podium_preferences.sql', migration)

# Serveur
replace_once('server/index.js',
"u.privacy_policy_version,u.data_processing_notice_version,\n      s.id AS auth_session_id",
"u.privacy_policy_version,u.data_processing_notice_version,u.podium_alias,u.podium_opt_in,u.podium_preference_set_at,\n      s.id AS auth_session_id")
sub_once('server/index.js', r"async function generatePodiumAlias\(client, sessionId\) \{.*?\n\}", r'''function normalizePodiumAlias(value, required = false) {
  const alias = String(value || '').trim().replace(/\s+/g, ' ');
  if (!alias) {
    if (required) fail(400, 'Choisissez un pseudonyme pour apparaître dans le classement.');
    return null;
  }
  if (alias.length < 2 || alias.length > 40) fail(400, 'Le pseudonyme doit contenir entre 2 et 40 caractères.');
  if (/^Joueur-[A-F0-9]{6}$/i.test(alias)) fail(400, 'Choisissez un pseudonyme personnel.');
  return alias;
}''')

sub_once('server/index.js', r"app\.patch\('/api/live-participants/:id/podium'.*?\n\}\)\);\n\n// Public, collective-only state", r'''app.patch('/api/live-participants/:id/podium', requireStaff, asyncRoute(async (req, res) => {
  const participantId = assertUuid(req.params.id, 'Participant');
  const showOnPodium = req.body?.show_on_podium;
  if (typeof showOnPodium !== 'boolean') fail(400, 'Choix de classement invalide.');
  if (req.body?.oral_confirmation !== true) fail(400, 'Confirmez que ce changement est demandé oralement par le participant.');
  const updated = await withTransaction(async client => {
    const result = await client.query(
      `SELECT sp.id,sp.session_id,sp.podium_alias,sp.show_on_podium,sp.user_id,ls.instructor_id,u.first_name,u.last_name,u.podium_alias AS saved_podium_alias
       FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
       JOIN app_users u ON u.id=sp.user_id WHERE sp.id=$1 FOR UPDATE OF sp,u`,
      [participantId]
    );
    const participant = result.rows[0];
    if (!participant) fail(404, 'Participant introuvable.');
    if (req.user.role !== 'superadmin' && participant.instructor_id !== req.user.id) fail(403, 'Session non autorisée.');
    const alias = showOnPodium
      ? normalizePodiumAlias(req.body?.podium_alias || participant.saved_podium_alias, true)
      : normalizePodiumAlias(participant.podium_alias || participant.saved_podium_alias, false);
    const saved = await client.query(
      `UPDATE session_participants SET show_on_podium=$1,podium_alias=$2,
       podium_consent_at=CASE WHEN $1 THEN now() ELSE NULL END,
       podium_consent_changed_at=now(),podium_consent_changed_by=$4,podium_consent_source='instructor_oral'
       WHERE id=$3 RETURNING id,show_on_podium,podium_alias`,
      [showOnPodium, alias, participantId, req.user.id]
    );
    await client.query(
      `UPDATE app_users SET podium_opt_in=$1,podium_alias=COALESCE($2,podium_alias),podium_preference_set_at=now() WHERE id=$3`,
      [showOnPodium, alias, participant.user_id]
    );
    return { ...participant, ...saved.rows[0] };
  });
  res.locals.audit = {
    action: showOnPodium ? 'podium.consent_enable' : 'podium.consent_withdraw',
    entityType: 'session_participant', entityId: participantId,
    summary: `${showOnPodium ? 'Ajout' : 'Retrait'} de ${updated.first_name} ${updated.last_name} au classement à sa demande orale`,
    metadata: { podium_alias: updated.podium_alias }
  };
  res.json({ id: updated.id, show_on_podium: updated.show_on_podium, podium_alias: updated.podium_alias });
}));

// Public, collective-only state''')

replace_once('server/index.js',
"WHERE sp.session_id=$1 AND sp.status='joined' AND sp.show_on_podium\n       GROUP BY",
"WHERE sp.session_id=$1 AND sp.status='joined' AND sp.show_on_podium\n         AND sp.podium_alias IS NOT NULL AND sp.podium_alias !~ '^Joueur-[A-F0-9]{6}$'\n       GROUP BY")

sub_once('server/index.js', r"async function attachLearnerToLiveSession\(client, code, userId, showOnPodium\) \{.*?\n\}\n\nasync function replaceLearnerCookie", r'''async function attachLearnerToLiveSession(client, code, userId, showOnPodium, podiumAlias) {
  const preferenceResult = await client.query(
    'SELECT podium_alias,podium_opt_in,podium_preference_set_at FROM app_users WHERE id=$1 FOR UPDATE',
    [userId]
  );
  const preference = preferenceResult.rows[0];
  if (!preference) fail(404, 'Participant introuvable.');
  const explicitChoice = typeof showOnPodium === 'boolean';
  const providedAlias = normalizePodiumAlias(podiumAlias, false);
  const effectiveChoice = explicitChoice ? showOnPodium : (preference.podium_preference_set_at ? preference.podium_opt_in : false);
  const effectiveAlias = effectiveChoice
    ? normalizePodiumAlias(providedAlias || preference.podium_alias, true)
    : (providedAlias || normalizePodiumAlias(preference.podium_alias, false));

  if (explicitChoice || providedAlias) {
    await client.query(
      `UPDATE app_users SET podium_opt_in=$1,podium_alias=COALESCE($2,podium_alias),podium_preference_set_at=now() WHERE id=$3`,
      [effectiveChoice, effectiveAlias, userId]
    );
  }

  const sessionResult = await client.query(
    `SELECT ls.id,ls.status,ls.group_id FROM live_sessions ls LEFT JOIN training_groups tg ON tg.id=ls.group_id
     WHERE ls.code=$1 AND ls.archived_at IS NULL AND (tg.id IS NULL OR tg.archived_at IS NULL) FOR UPDATE OF ls`,
    [code]
  );
  const session = sessionResult.rows[0];
  if (!session) fail(404, 'Session introuvable.');
  const existing = await client.query(
    'SELECT id,status FROM session_participants WHERE session_id=$1 AND user_id=$2',
    [session.id, userId]
  );
  if (session.status === 'finished') {
    if (!existing.rows[0]) fail(404, 'Cette session est terminée.');
    return existing.rows[0];
  }
  if (session.group_id) {
    await client.query(
      `INSERT INTO training_group_participants(group_id,user_id) VALUES($1,$2)
       ON CONFLICT(group_id,user_id) DO NOTHING`,
      [session.group_id, userId]
    );
  }
  if (existing.rows[0]) {
    const updated = await client.query(
      `UPDATE session_participants SET show_on_podium=$1,podium_alias=$2,
        podium_consent_at=CASE WHEN $1 THEN COALESCE(podium_consent_at,now()) ELSE NULL END,
        podium_consent_changed_at=CASE WHEN show_on_podium IS DISTINCT FROM $1 OR podium_alias IS DISTINCT FROM $2 THEN now() ELSE podium_consent_changed_at END,
        podium_consent_changed_by=CASE WHEN show_on_podium IS DISTINCT FROM $1 OR podium_alias IS DISTINCT FROM $2 THEN $3 ELSE podium_consent_changed_by END,
        podium_consent_source=CASE WHEN show_on_podium IS DISTINCT FROM $1 OR podium_alias IS DISTINCT FROM $2 THEN 'learner_form' ELSE podium_consent_source END
       WHERE id=$4 RETURNING id,status,show_on_podium,podium_alias`,
      [effectiveChoice, effectiveAlias, userId, existing.rows[0].id]
    );
    return updated.rows[0];
  }
  const participant = await client.query(
    `INSERT INTO session_participants(session_id,user_id,status,show_on_podium,podium_alias,
       podium_consent_at,podium_consent_changed_at,podium_consent_changed_by,podium_consent_source)
     VALUES($1,$2,'waiting_list',$3,$4,CASE WHEN $3 THEN now() ELSE NULL END,now(),$2,'learner_form')
     RETURNING id,status,show_on_podium,podium_alias`,
    [session.id, userId, effectiveChoice, effectiveAlias]
  );
  return participant.rows[0];
}

async function replaceLearnerCookie''')

sub_once('server/index.js', r"app\.post\('/api/learner/join',.*?\n\}\)\);\n\napp\.post\('/api/learner/join-by-code'", r'''app.post('/api/learner/join', joinLimiter, asyncRoute(async (req, res) => {
  requirePrivacyAcknowledgements(req.body);
  const documentVersions = await currentPrivacyDocumentVersions();
  const code = requiredText(req.body?.code, 'Code', 8).toUpperCase();
  const firstName = requiredText(req.body?.first_name, 'Prénom', 100);
  const lastName = requiredText(req.body?.last_name, 'Nom', 100);
  const showOnPodium = req.body?.show_on_podium === true;
  const podiumAlias = showOnPodium ? normalizePodiumAlias(req.body?.podium_alias, true) : null;
  const joined = await withTransaction(async client => {
    const participantCode = await generateParticipantCode(client);
    const created = await client.query(
      `INSERT INTO app_users(first_name,last_name,participant_code,role,podium_alias,podium_opt_in,podium_preference_set_at)
       VALUES($1,$2,$3,'learner',$4,$5,now()) RETURNING id,first_name,last_name,participant_code,podium_alias,podium_opt_in,podium_preference_set_at`,
      [firstName, lastName, participantCode, podiumAlias, showOnPodium]
    );
    const learner = created.rows[0];
    await recordPrivacyAcknowledgements(client, learner.id, documentVersions);
    const participant = await attachLearnerToLiveSession(client, code, learner.id, showOnPodium, podiumAlias);
    return { learner, participant };
  });
  await replaceLearnerCookie(req, res, joined.learner.id);
  await writeAudit({
    req, actor: { id: joined.learner.id, role: 'learner' }, action: 'learner.privacy_acknowledged',
    entityType: 'participant', entityId: joined.learner.id, summary: 'Première information RGPD et prise de connaissance de la politique',
    metadata: { document_versions: documentVersions, podium_consent: joined.participant.show_on_podium, podium_alias: joined.participant.podium_alias }
  });
  res.status(201).json(joined);
}));

app.post('/api/learner/join-by-code''')

replace_once('server/index.js',
"const participant = await attachLearnerToLiveSession(client, code, learner.id, req.body?.show_on_podium === true);",
"const podiumChoice = typeof req.body?.show_on_podium === 'boolean' ? req.body.show_on_podium : undefined;\n    const participant = await attachLearnerToLiveSession(client, code, learner.id, podiumChoice, req.body?.podium_alias);")
replace_once('server/index.js',
"metadata: { document_versions: documentVersions, podium_consent: req.body?.show_on_podium === true }",
"metadata: { document_versions: documentVersions, podium_consent: joined.participant.show_on_podium, podium_alias: joined.participant.podium_alias }")
replace_once('server/index.js',
"const participant = await withTransaction(client => attachLearnerToLiveSession(client, code, learner.id, podiumChoice));",
"const participant = await withTransaction(client => attachLearnerToLiveSession(client, code, learner.id, podiumChoice, req.body?.podium_alias));")

insert_route = r'''
app.patch('/api/learner/podium-preference', requireLearner, joinLimiter, asyncRoute(async (req, res) => {
  const code = requiredText(req.body?.code, 'Code de session', 8).toUpperCase();
  const showOnPodium = req.body?.show_on_podium;
  if (typeof showOnPodium !== 'boolean') fail(400, 'Choix de classement invalide.');
  const alias = showOnPodium ? normalizePodiumAlias(req.body?.podium_alias, true) : normalizePodiumAlias(req.body?.podium_alias, false);
  const updated = await withTransaction(async client => {
    const participant = await client.query(
      `SELECT sp.id,sp.session_id,ls.status FROM session_participants sp JOIN live_sessions ls ON ls.id=sp.session_id
       WHERE ls.code=$1 AND ls.archived_at IS NULL AND sp.user_id=$2 FOR UPDATE OF sp`,
      [code, req.user.id]
    );
    if (!participant.rows[0]) fail(404, 'Participation introuvable.');
    if (participant.rows[0].status === 'finished') fail(409, 'Cette session est terminée.');
    await client.query(
      `UPDATE app_users SET podium_opt_in=$1,podium_alias=COALESCE($2,podium_alias),podium_preference_set_at=now() WHERE id=$3`,
      [showOnPodium, alias, req.user.id]
    );
    const saved = await client.query(
      `UPDATE session_participants SET show_on_podium=$1,podium_alias=CASE WHEN $1 THEN $2 ELSE COALESCE($2,podium_alias) END,
       podium_consent_at=CASE WHEN $1 THEN now() ELSE NULL END,podium_consent_changed_at=now(),
       podium_consent_changed_by=$3,podium_consent_source='learner_form'
       WHERE id=$4 RETURNING id,show_on_podium,podium_alias`,
      [showOnPodium, alias, req.user.id, participant.rows[0].id]
    );
    return saved.rows[0];
  });
  await writeAudit({
    req, actor: req.user, action: showOnPodium ? 'podium.consent_enable' : 'podium.consent_withdraw',
    entityType: 'session_participant', entityId: updated.id,
    summary: showOnPodium ? 'Activation du classement par l’apprenant' : 'Retrait du classement par l’apprenant',
    metadata: { podium_alias: updated.podium_alias }
  });
  res.json(updated);
}));

'''
replace_once('server/index.js', "app.post('/api/learner/logout',", insert_route + "app.post('/api/learner/logout',")

replace_once('server/index.js',
"""    learner: {
      id: req.user.id,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
      participant_code: req.user.participant_code
    }
""",
"""    learner: {
      id: req.user.id,
      first_name: req.user.first_name,
      last_name: req.user.last_name,
      participant_code: req.user.participant_code,
      podium_alias: req.user.podium_alias,
      podium_opt_in: req.user.podium_opt_in,
      podium_preference_set_at: req.user.podium_preference_set_at
    }
""")

# Styles minimaux
with open('style.css', 'a', encoding='utf-8') as f:
    f.write("\n.podium-preference{margin:1rem 0;padding:1rem;border:1px solid rgba(0,84,119,.18);border-radius:14px}.podium-preference legend{font-weight:700;padding:0 .35rem}.podium-preference small{display:block;margin-top:.35rem}.podium-waiting-card .podium-preference{background:transparent}.podium-waiting-card input[disabled]{opacity:.55}\n")

print('Correctifs appliqués aux fichiers de travail.')
