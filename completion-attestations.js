const completionState = {
  catalog:null,groupData:null,history:[],selected:new Set(),search:'',page:0,pageSize:10,latestForm:null,groupForm:null
};

const completionDefaults = {
  organization_name:'Tech Systèmes',
  representative_title:'Responsable de formation',
  language:'FRANÇAIS',
  action_nature:'Action de formation',
  evaluation_result:'Objectifs atteints - Oui',
  validity_duration:'4 ans',
  retention_duration:'3 ans',
  attestation_header_text:'{formation}',
  attestation_intro_text:'Je soussigné(e), {signataire},',
  attestation_certification_text:"certifie que {participant}\na suivi l’intégralité du stage :",
  attestation_compliance_text:'Formation réalisée conformément au programme et aux objectifs définis par l’organisme de formation.',
  attestation_result_text:"et a obtenu un avis « favorable » à l’issue de la validation des acquis.",
  attestation_rights_text:'délivrée pour faire valoir ce que de droit.',
  realization_intro_text:"Je soussigné(e) {signataire}, représentant(e) légal(e) du dispensateur de formation {organisme}, organisme déclaré sous le numéro d’activité {declaration} auprès du Préfet de {prefecture}, atteste que :",
  realization_training_text:"a suivi l’action de formation : {formation}",
  realization_framework_text:"dans le cadre de la formation professionnelle continue relevant de l’article L6313-1 du Code du travail.",
  realization_objectives_intro_text:'À l’issue de la formation, le stagiaire sera en capacité de :',
  realization_evaluation_text:'Avis du formateur : {evaluation_result}',
  retention_text:"Sans préjudice des délais imposés par les règles fiscales, comptables ou commerciales, l’organisme s’engage à conserver l’ensemble des pièces justificatives ayant permis d’établir le présent certificat pendant une durée de {retention_duration} à compter de la fin de l’année du dernier paiement. En cas de cofinancement par des fonds européens, la durée de conservation est étendue conformément aux obligations conventionnelles spécifiques.",
  signature_caption:'Cachet et signature\ndu responsable du dispensateur de formation'
};

const completionEsc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const completionDate = value => value ? new Intl.DateTimeFormat('fr-FR',{dateStyle:'long'}).format(new Date(`${String(value).slice(0,10)}T12:00:00`)) : 'date non renseignée';
const completionPeriod = form => form.start_date && form.end_date ? `du ${completionDate(form.start_date)} au ${completionDate(form.end_date)}` : form.start_date ? `à partir du ${completionDate(form.start_date)}` : form.end_date ? `jusqu’au ${completionDate(form.end_date)}` : 'dates non renseignées';

async function completionRequest(path,options = {}) {
  const response = await fetch(`/api/completion-attestations${path}`,{
    credentials:'same-origin',...options,
    headers:{'Content-Type':'application/json',...(options.headers || {})}
  });
  const text = await response.text();
  let payload = null;
  try {payload = text ? JSON.parse(text) : null;} catch {payload = text;}
  if (!response.ok) throw new Error(payload?.message || `Erreur du serveur (${response.status}).`);
  return payload;
}

function completionButton() {
  return document.querySelector('[data-completion-attestation-nav]');
}

function installCompletionPanel() {
  const sidebar = document.querySelector('.sidebar');
  const section = document.querySelector('.layout > section');
  if (!sidebar || !section || completionButton()) return;
  const button = document.createElement('button');
  button.className = 'nav-button';
  button.type = 'button';
  button.dataset.completionAttestationNav = '1';
  button.textContent = '📄 Attestations de fin de formation';
  button.addEventListener('click',() => openCompletionPanel(button));
  const certificateButton = [...sidebar.querySelectorAll('.nav-button')].find(item => item.textContent.trim().includes('Certificats'));
  sidebar.insertBefore(button,certificateButton || sidebar.lastElementChild);
  const panel = document.createElement('div');
  panel.id = 'completionAttestations';
  panel.className = 'panel';
  panel.innerHTML = '<p class="eyebrow">Documents de fin de formation</p><h1>Attestations de fin de formation</h1><div id="completionAttestationContent" class="card">Chargement…</div>';
  section.appendChild(panel);
}

async function openCompletionPanel(button = completionButton()) {
  if (typeof window.panel === 'function') window.panel('completionAttestations',button);
  else {
    document.querySelectorAll('.panel').forEach(item => item.classList.toggle('active',item.id === 'completionAttestations'));
    document.querySelectorAll('.nav-button').forEach(item => item.classList.remove('active'));
    button?.classList.add('active');
  }
  await loadCompletionPanel();
}

async function loadCompletionPanel() {
  const box = document.querySelector('#completionAttestationContent');
  if (!box) return;
  box.className = 'card';
  box.innerHTML = '<p class="muted">Chargement des groupes et de l’historique…</p>';
  try {
    const [catalog,history] = await Promise.all([completionRequest('/catalog'),completionRequest('/history')]);
    completionState.catalog = catalog;
    completionState.history = history;
    completionState.latestForm = history[0]?.form_snapshot || null;
    completionState.groupForm = null;
    completionState.groupData = null;
    completionState.selected = new Set();
    renderCompletionPanel();
  } catch (error) {
    box.innerHTML = `<div class="notice">${completionEsc(error.message)}</div>`;
  }
}

function renderCompletionPanel() {
  const box = document.querySelector('#completionAttestationContent');
  if (!box || !completionState.catalog) return;
  box.className = '';
  box.innerHTML = `<section class="card completion-filter-card"><div><p class="eyebrow">Création groupée</p><h2>Choisir la formation</h2><p class="muted">Un seul formulaire génère l’attestation de fin de formation et le certificat de réalisation pour chaque participant sélectionné.</p></div><div class="completion-filter-grid"><label><span>Thème ou formation</span><select id="completionTheme"><option value="">Tous les thèmes</option>${completionState.catalog.themes.map(theme=>`<option value="${theme.id}">${completionEsc(theme.name)}</option>`).join('')}</select></label><label><span>Groupe</span><select id="completionGroup"><option value="">Sélectionnez un groupe</option>${completionGroupOptions('')}</select></label></div></section><div id="completionWorkspace"><div class="card empty">Sélectionnez un groupe pour préparer les documents.</div></div><section class="completion-history-section"><div class="row"><div><p class="eyebrow">Historique léger</p><h2>Documents déjà générés</h2></div><button class="button secondary" id="refreshCompletionHistory" type="button">↻ Actualiser</button></div><div id="completionHistory">${completionHistoryHtml()}</div></section>`;
  document.querySelector('#completionTheme')?.addEventListener('change',event => {
    const group = document.querySelector('#completionGroup');
    group.innerHTML = `<option value="">Sélectionnez un groupe</option>${completionGroupOptions(event.target.value)}`;
    completionState.groupData = null;
    document.querySelector('#completionWorkspace').innerHTML = '<div class="card empty">Sélectionnez maintenant un groupe.</div>';
  });
  document.querySelector('#completionGroup')?.addEventListener('change',event => selectCompletionGroup(event.target.value));
  document.querySelector('#refreshCompletionHistory')?.addEventListener('click',refreshCompletionHistory);
}

function completionGroupOptions(themeId) {
  return completionState.catalog.groups.filter(group => !themeId || group.theme_id === themeId).map(group => `<option value="${group.id}">${completionEsc(group.name)} · ${completionEsc(group.theme_name)} · ${Number(group.participant_count || 0)} participant(s)</option>`).join('');
}

async function selectCompletionGroup(groupId) {
  const workspace = document.querySelector('#completionWorkspace');
  if (!workspace) return;
  if (!groupId) {
    completionState.groupData = null;
    workspace.innerHTML = '<div class="card empty">Sélectionnez un groupe pour préparer les documents.</div>';
    return;
  }
  workspace.innerHTML = '<div class="card empty">Chargement des participants…</div>';
  try {
    const [groupData,history] = await Promise.all([
      completionRequest(`/groups/${encodeURIComponent(groupId)}`),
      completionRequest(`/history?group_id=${encodeURIComponent(groupId)}`)
    ]);
    completionState.groupData = groupData;
    completionState.history = history;
    completionState.groupForm = history[0]?.form_snapshot || null;
    completionState.selected = new Set(groupData.participants.map(participant => participant.id));
    completionState.search = '';
    completionState.page = 0;
    renderCompletionWorkspace();
    document.querySelector('#completionHistory').innerHTML = completionHistoryHtml();
  } catch (error) {
    workspace.innerHTML = `<div class="notice">${completionEsc(error.message)}</div>`;
  }
}

function inclusiveDays(start,end) {
  const first = new Date(`${String(start).slice(0,10)}T12:00:00Z`).getTime();
  const last = new Date(`${String(end).slice(0,10)}T12:00:00Z`).getTime();
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(1,Math.round((last - first) / 86400000) + 1) : '';
}

function datePlusYears(value,years) {
  const date = new Date(`${String(value || '').slice(0,10)}T12:00:00Z`);
  if (!Number.isFinite(date.getTime())) return '';
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date.toISOString().slice(0,10);
}

function storedValue(key,fallback = '') {
  return completionEsc(completionState.latestForm?.[key] ?? completionDefaults[key] ?? fallback);
}

function currentGroupValue(value,key,fallback = '') {
  return completionEsc(value || completionState.groupForm?.[key] || fallback);
}

function groupValue(key,fallback = '') {
  return completionEsc(completionState.groupForm?.[key] ?? fallback);
}

function field(label,name,value = '',options = {}) {
  const classes = options.full ? 'completion-field full' : 'completion-field';
  const attributes = `name="${name}" data-completion-check${options.maxlength?` maxlength="${options.maxlength}"`:''}${options.placeholder?` placeholder="${completionEsc(options.placeholder)}"`:''}`;
  const control = options.textarea
    ? `<textarea ${attributes}>${value}</textarea>`
    : `<input ${attributes}${options.type?` type="${options.type}"`:''}${options.step?` step="${options.step}"`:''} value="${value}">`;
  return `<div class="${classes}"><label>${label}<span class="completion-missing-label">À compléter</span></label>${control}${options.help?`<small class="muted">${options.help}</small>`:''}</div>`;
}

function renderCompletionWorkspace() {
  const workspace = document.querySelector('#completionWorkspace');
  const data = completionState.groupData;
  if (!workspace || !data) return;
  const group = data.group,today = new Date().toISOString().slice(0,10);
  const groupStart = String(group.start_date || '').slice(0,10);
  const groupEnd = String(group.end_date || '').slice(0,10);
  workspace.innerHTML = `<form id="completionAttestationForm" class="completion-form" novalidate>
    <section class="card"><div class="row"><div><p class="eyebrow">1. Organisme et signataire</p><h2>Informations permanentes</h2></div><span class="tag">Réutilisées au prochain lot</span></div><div class="form-grid">
      ${field('Nom de l’organisme','organization_name',storedValue('organization_name'))}
      ${field('SIRET','organization_siret',storedValue('organization_siret'))}
      ${field('Adresse de l’organisme','organization_address',storedValue('organization_address'),{textarea:true,full:true,maxlength:700})}
      ${field('Numéro de TVA','organization_vat',storedValue('organization_vat'))}
      ${field('Numéro de déclaration d’activité','declaration_number',storedValue('declaration_number'))}
      ${field('Préfecture de déclaration','declaration_prefecture',storedValue('declaration_prefecture'))}
      ${field('Nom du signataire','representative_name',storedValue('representative_name',completionState.catalog.signer?.name || ''))}
      ${field('Fonction du signataire','representative_title',storedValue('representative_title'))}
      <div class="completion-field full"><label>Signature ou cachet<span class="completion-missing-label">À compléter</span></label><input name="signature" data-completion-check type="file" accept="image/png,image/jpeg"><small class="muted">PNG ou JPEG, 1 Mo maximum. L’image est enregistrée une seule fois pour ce lot.</small></div>
    </div></section>
    <section class="card"><p class="eyebrow">2. Formation</p><h2>Informations communes aux deux documents</h2><div class="form-grid">
      ${field('Intitulé de la formation','training_title',currentGroupValue(group.theme_name,'training_title'),{full:true,maxlength:300})}
      ${field('Objectifs de la formation','objective',groupValue('objective'),{textarea:true,full:true,maxlength:2400,placeholder:'- Premier objectif\n- Deuxième objectif',help:'Chaque ligne commençant par un tiret sera présentée comme un objectif distinct dans le certificat.'})}
      ${field('Date de début','start_date',currentGroupValue(groupStart,'start_date'),{type:'date'})}
      ${field('Date de fin','end_date',currentGroupValue(groupEnd,'end_date'),{type:'date'})}
      ${field('Durée totale','duration_value',currentGroupValue(inclusiveDays(group.start_date,group.end_date),'duration_value'),{type:'number',step:'0.1'})}
      <div class="completion-field"><label>Unité de durée<span class="completion-missing-label">À compléter</span></label><select name="duration_unit" data-completion-check><option value="">Choisir</option><option value="hours" ${(completionState.latestForm?.duration_unit||'')==='hours'?'selected':''}>Heure(s)</option><option value="days" ${(completionState.latestForm?.duration_unit||'days')==='days'?'selected':''}>Jour(s)</option></select></div>
      ${field('Lieu de formation','training_location',currentGroupValue(group.location || group.modality || '','training_location'))}
      ${field('Langue','language',storedValue('language'))}
      ${field('Numéro de session','session_number',groupValue('session_number'))}
      <div class="completion-field"><label>Nature de l’action<span class="completion-missing-label">À compléter</span></label><select name="action_nature" data-completion-check>${['','Action de formation','Bilan de compétences','Action de VAE','Action de formation par apprentissage'].map(value=>`<option value="${completionEsc(value)}" ${String(completionState.latestForm?.action_nature ?? completionDefaults.action_nature)===value?'selected':''}>${completionEsc(value || 'Choisir')}</option>`).join('')}</select></div>
      ${field('Détail des présences','attendance_details',groupValue('attendance_details'),{textarea:true,full:true,maxlength:1600,placeholder:'05/03/2025 | 7:00\n06/03/2025 | 7:00',help:'Une ligne par jour, sous la forme « date | durée ». Si ce champ reste vide, seule la période globale sera affichée.'})}
      ${field('Résultat de l’évaluation','evaluation_result',storedValue('evaluation_result'),{full:true})}
      ${field('Durée de validité de l’attestation','validity_duration',storedValue('validity_duration'))}
      ${field('Date de fin de validité','valid_until',groupValue('valid_until',datePlusYears(group.end_date,4)),{type:'date'})}
      ${field('Durée de conservation des justificatifs ou données','retention_duration',storedValue('retention_duration'))}
      ${field('Lieu d’émission','issue_place',storedValue('issue_place'))}
      ${field('Date d’émission','issue_date',today,{type:'date'})}
    </div></section>
    <section class="card"><details class="completion-text-settings"><summary><span><b>3. Textes des documents</b><small>Valeurs préremplies et modifiables</small></span></summary><p class="muted">Variables disponibles : <code>{participant}</code>, <code>{formation}</code>, <code>{signataire}</code>, <code>{organisme}</code>, <code>{declaration}</code>, <code>{prefecture}</code>, <code>{evaluation_result}</code>, <code>{retention_duration}</code>.</p><div class="form-grid">
      ${field('Titre supérieur de l’attestation','attestation_header_text',storedValue('attestation_header_text'),{textarea:true,full:true,maxlength:800})}
      ${field('Introduction de l’attestation','attestation_intro_text',storedValue('attestation_intro_text'),{textarea:true,full:true,maxlength:800})}
      ${field('Phrase de certification','attestation_certification_text',storedValue('attestation_certification_text'),{textarea:true,full:true,maxlength:1000})}
      ${field('Phrase de conformité','attestation_compliance_text',storedValue('attestation_compliance_text'),{textarea:true,full:true,maxlength:1400})}
      ${field('Résultat sur l’attestation','attestation_result_text',storedValue('attestation_result_text'),{textarea:true,full:true,maxlength:1000})}
      ${field('Mention de validité','attestation_rights_text',storedValue('attestation_rights_text'),{textarea:true,full:true,maxlength:800})}
      ${field('Introduction du certificat de réalisation','realization_intro_text',storedValue('realization_intro_text'),{textarea:true,full:true,maxlength:1800})}
      ${field('Phrase relative à la formation suivie','realization_training_text',storedValue('realization_training_text'),{textarea:true,full:true,maxlength:1200})}
      ${field('Cadre de la formation professionnelle','realization_framework_text',storedValue('realization_framework_text'),{textarea:true,full:true,maxlength:1400})}
      ${field('Introduction des objectifs','realization_objectives_intro_text',storedValue('realization_objectives_intro_text'),{textarea:true,full:true,maxlength:800})}
      ${field('Formulation du résultat','realization_evaluation_text',storedValue('realization_evaluation_text'),{textarea:true,full:true,maxlength:1000})}
      ${field('Clause de conservation','retention_text',storedValue('retention_text'),{textarea:true,full:true,maxlength:2400})}
      ${field('Légende de signature','signature_caption',storedValue('signature_caption'),{textarea:true,full:true,maxlength:500})}
    </div></details></section>
    <section class="card"><div class="row"><div><p class="eyebrow">4. Participants</p><h2>Choisir les destinataires</h2></div><b id="completionSelectedCount">${completionState.selected.size} sélectionné(s)</b></div><div class="completion-participant-tools"><input id="completionParticipantSearch" type="search" placeholder="Rechercher un participant"><button class="button secondary" id="completionSelectAll" type="button">Tout sélectionner</button><button class="button ghost" id="completionClearAll" type="button">Tout désélectionner</button></div><div id="completionParticipantList"></div></section>
    <section class="card completion-submit-card"><div><h2>Générer les deux documents</h2><p class="muted">Les PDF sont régénérés à la demande. Seuls les informations et textes du lot sont conservés dans l’historique.</p></div><button class="button" id="createCompletionAttestations" type="submit">Générer les deux documents</button></section>
  </form>`;
  const form = document.querySelector('#completionAttestationForm');
  form?.addEventListener('submit',submitCompletionBatch);
  form?.addEventListener('input',event => clearCompletionMissing(event.target));
  form?.addEventListener('change',event => clearCompletionMissing(event.target));
  const objective = form?.elements.objective;
  objective?.addEventListener('input',() => {
    const normalized = objective.value.replace(/([^\n])\s+-\s+(?=\S)/g,'$1\n- ');
    if (normalized !== objective.value) objective.value = normalized;
  });
  objective?.addEventListener('keydown',event => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const start = objective.selectionStart,end = objective.selectionEnd;
    const currentLine = objective.value.slice(0,start).split('\n').at(-1) || '';
    if (!/^\s*-\s*/.test(currentLine)) return;
    event.preventDefault();
    objective.setRangeText('\n- ',start,end,'end');
  });
  document.querySelector('#completionParticipantSearch')?.addEventListener('input',event => {completionState.search = event.target.value;completionState.page = 0;renderCompletionParticipants();});
  document.querySelector('#completionSelectAll')?.addEventListener('click',() => {data.participants.forEach(participant => completionState.selected.add(participant.id));renderCompletionParticipants();});
  document.querySelector('#completionClearAll')?.addEventListener('click',() => {completionState.selected.clear();renderCompletionParticipants();});
  renderCompletionParticipants();
}

function filteredCompletionParticipants() {
  const needle = completionState.search.trim().toLocaleLowerCase('fr-FR');
  return completionState.groupData.participants.filter(participant => !needle || `${participant.first_name} ${participant.last_name} ${participant.participant_code || ''} ${participant.email || ''}`.toLocaleLowerCase('fr-FR').includes(needle));
}

function renderCompletionParticipants() {
  const box = document.querySelector('#completionParticipantList');
  if (!box || !completionState.groupData) return;
  const participants = filteredCompletionParticipants(),pages = Math.max(1,Math.ceil(participants.length / completionState.pageSize));
  completionState.page = Math.min(completionState.page,pages - 1);
  const start = completionState.page * completionState.pageSize,visible = participants.slice(start,start + completionState.pageSize);
  box.innerHTML = `<div class="completion-participant-list">${visible.map(participant=>`<label class="completion-participant-row"><input type="checkbox" data-completion-participant="${participant.id}" ${completionState.selected.has(participant.id)?'checked':''}><span><b>${completionEsc(participant.first_name)} ${completionEsc(participant.last_name)}</b><small>${completionEsc(participant.participant_code || '')}${participant.email?` · ${completionEsc(participant.email)}`:''}</small></span></label>`).join('') || '<div class="empty">Aucun participant ne correspond à la recherche.</div>'}</div>${participants.length > completionState.pageSize?`<nav class="list-pagination"><span>${start + 1}–${Math.min(start + completionState.pageSize,participants.length)} sur ${participants.length}</span><button class="icon-button" id="completionPreviousPage" type="button" ${completionState.page===0?'disabled':''}>‹</button><button class="icon-button" id="completionNextPage" type="button" ${completionState.page>=pages-1?'disabled':''}>›</button></nav>`:''}`;
  box.querySelectorAll('[data-completion-participant]').forEach(input => input.addEventListener('change',() => {
    if (input.checked) completionState.selected.add(input.dataset.completionParticipant);
    else completionState.selected.delete(input.dataset.completionParticipant);
    updateCompletionSelectedCount();
  }));
  document.querySelector('#completionPreviousPage')?.addEventListener('click',() => {completionState.page = Math.max(0,completionState.page - 1);renderCompletionParticipants();});
  document.querySelector('#completionNextPage')?.addEventListener('click',() => {completionState.page = Math.min(pages - 1,completionState.page + 1);renderCompletionParticipants();});
  updateCompletionSelectedCount();
}

function updateCompletionSelectedCount() {
  const count = document.querySelector('#completionSelectedCount');
  if (count) count.textContent = `${completionState.selected.size} sélectionné(s)`;
}

function completionFieldEmpty(control) {
  if (control.type === 'file') return !(control.files?.length);
  return !String(control.value ?? '').trim();
}

function clearCompletionMissing(control) {
  if (!control?.matches?.('[data-completion-check]') || completionFieldEmpty(control)) return;
  control.closest('.completion-field')?.classList.remove('is-missing');
}

function markCompletionMissingFields(form) {
  const controls = [...form.querySelectorAll('[data-completion-check]')];
  controls.forEach(control => control.closest('.completion-field')?.classList.remove('is-missing'));
  const missing = controls.filter(completionFieldEmpty);
  missing.forEach(control => control.closest('.completion-field')?.classList.add('is-missing'));
  return missing;
}

function showCompletionWarning(form,missing) {
  document.querySelector('#completionMissingDialog')?.remove();
  missing[0]?.closest('details')?.setAttribute('open','');
  missing[0]?.scrollIntoView({behavior:'smooth',block:'center'});
  const overlay = document.createElement('div');
  overlay.id = 'completionMissingDialog';
  overlay.className = 'modal completion-warning-modal';
  overlay.setAttribute('role','dialog');
  overlay.setAttribute('aria-modal','true');
  overlay.innerHTML = `<div class="card"><p class="eyebrow">Vérification avant génération</p><h2>Certains champs sont incomplets</h2><p>Les champs concernés sont indiqués en rouge dans le formulaire. Vous pouvez les compléter ou générer volontairement les documents avec les informations disponibles.</p><div class="actions"><button class="button secondary" type="button" data-completion-return>Compléter les champs</button><button class="button danger" type="button" data-completion-force>Générer malgré tout</button></div></div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('[data-completion-return]')?.addEventListener('click',() => {overlay.remove();missing[0]?.focus();});
  overlay.querySelector('[data-completion-force]')?.addEventListener('click',() => {overlay.remove();createCompletionBatch(form);});
}

function fileAsBase64(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('Lecture de la signature impossible.'));
    reader.readAsDataURL(file);
  });
}

function formPayload(form) {
  const value = name => form.elements[name]?.value ?? '';
  return {
    organization_name:value('organization_name'),organization_address:value('organization_address'),
    organization_siret:value('organization_siret'),organization_vat:value('organization_vat'),
    declaration_number:value('declaration_number'),declaration_prefecture:value('declaration_prefecture'),
    representative_name:value('representative_name'),representative_title:value('representative_title'),
    training_title:value('training_title'),objective:value('objective'),start_date:value('start_date'),end_date:value('end_date'),
    duration_value:value('duration_value'),duration_unit:value('duration_unit'),training_location:value('training_location'),
    language:value('language'),session_number:value('session_number'),action_nature:value('action_nature'),
    attendance_details:value('attendance_details'),evaluation_result:value('evaluation_result'),validity_duration:value('validity_duration'),
    valid_until:value('valid_until'),retention_duration:value('retention_duration'),issue_place:value('issue_place'),issue_date:value('issue_date'),
    attestation_header_text:value('attestation_header_text'),attestation_intro_text:value('attestation_intro_text'),
    attestation_certification_text:value('attestation_certification_text'),attestation_compliance_text:value('attestation_compliance_text'),
    attestation_result_text:value('attestation_result_text'),attestation_rights_text:value('attestation_rights_text'),
    realization_intro_text:value('realization_intro_text'),realization_training_text:value('realization_training_text'),
    realization_framework_text:value('realization_framework_text'),realization_objectives_intro_text:value('realization_objectives_intro_text'),
    realization_evaluation_text:value('realization_evaluation_text'),retention_text:value('retention_text'),signature_caption:value('signature_caption')
  };
}

async function submitCompletionBatch(event) {
  event.preventDefault();
  if (!completionState.selected.size) return alert('Sélectionnez au moins un participant.');
  const form = event.currentTarget;
  const signatureFile = form.elements.signature.files?.[0] || null;
  if (signatureFile && !['image/png','image/jpeg'].includes(signatureFile.type)) return alert('Utilisez une signature PNG ou JPEG.');
  if (signatureFile && signatureFile.size > 1024 * 1024) return alert('La signature doit peser au maximum 1 Mo.');
  const missing = markCompletionMissingFields(form);
  if (missing.length) return showCompletionWarning(form,missing);
  await createCompletionBatch(form);
}

async function createCompletionBatch(form) {
  const button = document.querySelector('#createCompletionAttestations');
  const signatureFile = form.elements.signature.files?.[0] || null;
  const payload = {
    group_id:completionState.groupData.group.id,
    participant_ids:[...completionState.selected],
    form:formPayload(form),
    signature:signatureFile ? {mime_type:signatureFile.type,data_base64:await fileAsBase64(signatureFile)} : null
  };
  if (button) {button.disabled = true;button.textContent = 'Génération…';}
  try {
    const created = await completionRequest('/batches',{method:'POST',body:JSON.stringify(payload)});
    completionState.latestForm = payload.form;
    completionState.groupForm = payload.form;
    await refreshCompletionHistory();
    form.querySelector('.completion-success')?.remove();
    const result = document.createElement('div');
    result.className = 'notice completion-success';
    result.innerHTML = `<b>${created.participant_count} participant(s) · ${created.participant_count * 2} document(s) créé(s).</b><div class="actions"><a class="button" href="/api/completion-attestations/batches/${created.id}.pdf">PDF groupé · les deux documents</a><a class="button secondary" href="/api/completion-attestations/batches/${created.id}.zip">ZIP · fichiers individuels</a></div>`;
    form.prepend(result);
    result.scrollIntoView({behavior:'smooth',block:'center'});
  } catch (error) {alert(error.message);}
  finally {if (button) {button.disabled = false;button.textContent = 'Générer les deux documents';}}
}

async function refreshCompletionHistory() {
  const groupId = completionState.groupData?.group?.id || '';
  try {
    completionState.history = await completionRequest(`/history${groupId?`?group_id=${encodeURIComponent(groupId)}`:''}`);
    if (completionState.history[0]?.form_snapshot) completionState.latestForm = completionState.history[0].form_snapshot;
    if (groupId) completionState.groupForm = completionState.history[0]?.form_snapshot || completionState.groupForm;
    const box = document.querySelector('#completionHistory');
    if (box) box.innerHTML = completionHistoryHtml();
  } catch (error) {alert(error.message);}
}

function completionHistoryHtml() {
  return `<div class="completion-history-list">${completionState.history.map(batch=>{
    const form = batch.form_snapshot || {},participants = batch.participants || [];
    return `<article class="card completion-history-card"><div class="row"><div><span class="tag">${Number(batch.participant_count || 0) * 2} document(s)</span><h3>${completionEsc(form.training_title || 'Formation')}</h3><p class="muted">${completionEsc(form.group_name || '')} · ${completionPeriod(form)} · généré le ${new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short'}).format(new Date(batch.created_at))}</p></div><div class="actions"><a class="button secondary" href="/api/completion-attestations/batches/${batch.id}.pdf">PDF groupé</a><a class="button secondary" href="/api/completion-attestations/batches/${batch.id}.zip">ZIP</a></div></div><details><summary>Afficher les participants et leurs documents</summary><div class="completion-history-participants">${participants.map(participant=>`<div class="completion-history-person"><span><b>${completionEsc(participant.first_name)} ${completionEsc(participant.last_name)}</b><small>${completionEsc(participant.number)}</small></span><div class="actions"><a href="/api/completion-attestations/${participant.id}.pdf?document=attestation">Attestation</a><a href="/api/completion-attestations/${participant.id}.pdf?document=realisation">Certificat de réalisation</a></div></div>`).join('')}</div></details></article>`;
  }).join('') || '<div class="card empty">Aucun document généré pour le moment.</div>'}</div>`;
}

const completionObserver = new MutationObserver(() => installCompletionPanel());
completionObserver.observe(document.querySelector('#app') || document.body,{childList:true,subtree:true});
installCompletionPanel();
