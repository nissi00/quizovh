const completionState = {
  catalog:null,groupData:null,history:[],selected:new Set(),search:'',page:0,pageSize:10,latestForm:null
};

const completionEsc = value => String(value ?? '').replace(/[&<>"']/g,char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const completionDate = value => value ? new Intl.DateTimeFormat('fr-FR',{dateStyle:'long'}).format(new Date(`${String(value).slice(0,10)}T12:00:00`)) : '—';

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
    const [catalog,history] = await Promise.all([
      completionRequest('/catalog'),completionRequest('/history')
    ]);
    completionState.catalog = catalog;
    completionState.history = history;
    completionState.latestForm = history[0]?.form_snapshot || null;
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
  box.innerHTML = `<section class="card completion-filter-card"><div><p class="eyebrow">Création groupée</p><h2>Choisir la formation</h2><p class="muted">Les attestations sont délivrées à tous les participants sélectionnés, sans condition de score.</p></div><div class="completion-filter-grid"><label><span>Thème ou formation</span><select id="completionTheme"><option value="">Tous les thèmes</option>${completionState.catalog.themes.map(theme=>`<option value="${theme.id}">${completionEsc(theme.name)}</option>`).join('')}</select></label><label><span>Groupe</span><select id="completionGroup"><option value="">Sélectionnez un groupe</option>${completionGroupOptions('')}</select></label></div></section><div id="completionWorkspace"><div class="card empty">Sélectionnez un groupe pour préparer les attestations.</div></div><section class="completion-history-section"><div class="row"><div><p class="eyebrow">Historique léger</p><h2>Attestations déjà générées</h2></div><button class="button secondary" id="refreshCompletionHistory" type="button">↻ Actualiser</button></div><div id="completionHistory">${completionHistoryHtml()}</div></section>`;
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
    workspace.innerHTML = '<div class="card empty">Sélectionnez un groupe pour préparer les attestations.</div>';
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
  return Number.isFinite(first) && Number.isFinite(last) ? Math.max(1,Math.round((last - first) / 86400000) + 1) : 1;
}

function formValue(key,fallback = '') {
  return completionEsc(completionState.latestForm?.[key] ?? fallback);
}

function renderCompletionWorkspace() {
  const workspace = document.querySelector('#completionWorkspace');
  const data = completionState.groupData;
  if (!workspace || !data) return;
  const group = data.group,today = new Date().toISOString().slice(0,10);
  workspace.innerHTML = `<form id="completionAttestationForm" class="completion-form"><section class="card"><div class="row"><div><p class="eyebrow">1. Organisme et signataire</p><h2>Informations permanentes</h2></div><span class="tag">Préremplies au prochain lot</span></div><div class="form-grid"><div><label>Nom de l’organisme</label><input name="organization_name" value="${formValue('organization_name','Tech Systèmes')}" required></div><div><label>SIRET</label><input name="organization_siret" value="${formValue('organization_siret')}"></div><div class="full"><label>Adresse de l’organisme</label><textarea name="organization_address" required>${formValue('organization_address')}</textarea></div><div><label>Numéro de TVA</label><input name="organization_vat" value="${formValue('organization_vat')}"></div><div><label>Numéro de déclaration d’activité</label><input name="declaration_number" value="${formValue('declaration_number')}"></div><div><label>Nom du signataire</label><input name="representative_name" value="${formValue('representative_name',completionState.catalog.signer?.name || '')}" required></div><div><label>Fonction du signataire</label><input name="representative_title" value="${formValue('representative_title','Responsable de formation')}" required></div><div class="full"><label>Signature ou cachet, facultatif</label><input name="signature" type="file" accept="image/png,image/jpeg"><small class="muted">PNG ou JPEG, 1 Mo maximum. L’image est enregistrée une seule fois pour ce lot.</small></div></div></section><section class="card"><p class="eyebrow">2. Formation</p><h2>Informations communes à toutes les attestations</h2><div class="form-grid"><div><label>Entreprise cliente</label><input name="client_name" value="${completionEsc(group.client_name || '')}"></div><div><label>Adresse de l’entreprise</label><input name="client_address"></div><div class="full"><label>Intitulé de la formation</label><input name="training_title" value="${completionEsc(group.theme_name)}" required></div><div class="full"><label>Objectif de la formation</label><textarea name="objective" maxlength="1200" required placeholder="À l’issue de la formation, le participant sera capable de…"></textarea></div><div><label>Date de début</label><input name="start_date" type="date" value="${String(group.start_date).slice(0,10)}" required></div><div><label>Date de fin</label><input name="end_date" type="date" value="${String(group.end_date).slice(0,10)}" required></div><div><label>Durée</label><input name="duration_value" type="number" min="0.1" max="10000" step="0.1" value="${inclusiveDays(group.start_date,group.end_date)}" required></div><div><label>Unité</label><select name="duration_unit"><option value="days">Jour(s)</option><option value="hours">Heure(s)</option></select></div><div><label>Lieu ou modalité de formation</label><input name="training_location" value="${completionEsc(group.location || group.modality || '')}"></div><div><label>Lieu d’émission</label><input name="issue_place" value="${formValue('issue_place')}" required></div><div><label>Date d’émission</label><input name="issue_date" type="date" value="${today}" required></div></div><fieldset class="completion-evidence"><legend>Justificatifs à mentionner</legend><label><input name="evidence_attendance" type="checkbox" checked> Attestation ou feuille de présence</label><label><input name="evidence_assessment" type="checkbox"> Évaluation des acquis</label><label><input name="evidence_satisfaction" type="checkbox"> Enquête de satisfaction</label></fieldset></section><section class="card"><div class="row"><div><p class="eyebrow">3. Participants</p><h2>Choisir les destinataires</h2></div><b id="completionSelectedCount">${completionState.selected.size} sélectionné(s)</b></div><div class="completion-participant-tools"><input id="completionParticipantSearch" type="search" placeholder="Rechercher un participant"><button class="button secondary" id="completionSelectAll" type="button">Tout sélectionner</button><button class="button ghost" id="completionClearAll" type="button">Tout désélectionner</button></div><div id="completionParticipantList"></div></section><section class="card completion-submit-card"><div><h2>Génération groupée</h2><p class="muted">Un instantané des informations sera conservé. Les fichiers PDF seront créés à la demande et ne seront pas stockés durablement.</p></div><button class="button" id="createCompletionAttestations" type="submit">Générer les attestations</button></section></form>`;
  document.querySelector('#completionAttestationForm')?.addEventListener('submit',submitCompletionBatch);
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

function fileAsBase64(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('Lecture de la signature impossible.'));
    reader.readAsDataURL(file);
  });
}

async function submitCompletionBatch(event) {
  event.preventDefault();
  if (!completionState.selected.size) return alert('Sélectionnez au moins un participant.');
  const form = event.currentTarget,button = document.querySelector('#createCompletionAttestations');
  const signatureFile = form.elements.signature.files?.[0] || null;
  if (signatureFile && !['image/png','image/jpeg'].includes(signatureFile.type)) return alert('Utilisez une signature PNG ou JPEG.');
  if (signatureFile && signatureFile.size > 1024 * 1024) return alert('La signature doit peser au maximum 1 Mo.');
  const payload = {
    group_id:completionState.groupData.group.id,
    participant_ids:[...completionState.selected],
    form:{
      organization_name:form.elements.organization_name.value,organization_address:form.elements.organization_address.value,
      organization_siret:form.elements.organization_siret.value,organization_vat:form.elements.organization_vat.value,
      declaration_number:form.elements.declaration_number.value,representative_name:form.elements.representative_name.value,
      representative_title:form.elements.representative_title.value,client_name:form.elements.client_name.value,
      client_address:form.elements.client_address.value,training_title:form.elements.training_title.value,
      objective:form.elements.objective.value,start_date:form.elements.start_date.value,end_date:form.elements.end_date.value,
      duration_value:Number(form.elements.duration_value.value),duration_unit:form.elements.duration_unit.value,
      training_location:form.elements.training_location.value,issue_place:form.elements.issue_place.value,
      issue_date:form.elements.issue_date.value,evidence_attendance:form.elements.evidence_attendance.checked,
      evidence_assessment:form.elements.evidence_assessment.checked,evidence_satisfaction:form.elements.evidence_satisfaction.checked
    },
    signature:signatureFile ? {mime_type:signatureFile.type,data_base64:await fileAsBase64(signatureFile)} : null
  };
  if (button) {button.disabled = true;button.textContent = 'Génération…';}
  try {
    const created = await completionRequest('/batches',{method:'POST',body:JSON.stringify(payload)});
    completionState.latestForm = payload.form;
    await refreshCompletionHistory();
    const result = document.createElement('div');
    result.className = 'notice completion-success';
    result.innerHTML = `<b>${created.participant_count} attestation(s) créée(s).</b><div class="actions"><a class="button" href="/api/completion-attestations/batches/${created.id}.pdf">Télécharger le PDF groupé</a><a class="button secondary" href="/api/completion-attestations/batches/${created.id}.zip">Télécharger le ZIP</a></div>`;
    form.prepend(result);
    result.scrollIntoView({behavior:'smooth',block:'center'});
  } catch (error) {alert(error.message);}
  finally {if (button) {button.disabled = false;button.textContent = 'Générer les attestations';}}
}

async function refreshCompletionHistory() {
  const groupId = completionState.groupData?.group?.id || '';
  try {
    completionState.history = await completionRequest(`/history${groupId?`?group_id=${encodeURIComponent(groupId)}`:''}`);
    if (completionState.history[0]?.form_snapshot) completionState.latestForm = completionState.history[0].form_snapshot;
    const box = document.querySelector('#completionHistory');
    if (box) box.innerHTML = completionHistoryHtml();
  } catch (error) {alert(error.message);}
}

function completionHistoryHtml() {
  return `<div class="completion-history-list">${completionState.history.map(batch=>{
    const form = batch.form_snapshot || {},participants = batch.participants || [];
    return `<article class="card completion-history-card"><div class="row"><div><span class="tag">${Number(batch.participant_count || 0)} attestation(s)</span><h3>${completionEsc(form.training_title || 'Formation')}</h3><p class="muted">${completionEsc(form.group_name || '')} · du ${completionDate(form.start_date)} au ${completionDate(form.end_date)} · généré le ${new Intl.DateTimeFormat('fr-FR',{dateStyle:'short',timeStyle:'short'}).format(new Date(batch.created_at))}</p></div><div class="actions"><a class="button secondary" href="/api/completion-attestations/batches/${batch.id}.pdf">PDF groupé</a><a class="button secondary" href="/api/completion-attestations/batches/${batch.id}.zip">ZIP</a></div></div><details><summary>Afficher les participants</summary><div class="completion-history-participants">${participants.map(participant=>`<a href="/api/completion-attestations/${participant.id}.pdf"><span>${completionEsc(participant.first_name)} ${completionEsc(participant.last_name)}</span><small>${completionEsc(participant.number)} · PDF</small></a>`).join('')}</div></details></article>`;
  }).join('') || '<div class="card empty">Aucune attestation générée pour le moment.</div>'}</div>`;
}

const completionObserver = new MutationObserver(() => installCompletionPanel());
completionObserver.observe(document.querySelector('#app') || document.body,{childList:true,subtree:true});
installCompletionPanel();
