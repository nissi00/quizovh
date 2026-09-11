const api = async (path, options = {}) => {
  const response = await fetch(path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Erreur (${response.status})`);
  return payload;
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const percent = value => `${Number(value || 0).toFixed(1).replace('.', ',')} %`;
let decorating = false;
let lastDecoratedSignature = '';

function certificateCell(group, learner) {
  const certificate = learner.certificate;
  if (certificate?.status === 'issued') {
    return `<div class="certificate-actions"><a class="button secondary" href="/api/certificates/${encodeURIComponent(certificate.id)}.pdf">PDF</a><button class="button danger" type="button" onclick="revokeLearnerCertificate('${group.id}','${certificate.id}')">Révoquer</button><button class="button secondary" type="button" onclick="issueCertificateWithBonus('${group.id}','${learner.id}',true)">Régénérer</button><button class="icon-button archive-button" type="button" onclick="archiveLearnerCertificate('${certificate.id}')" title="Archiver" aria-label="Archiver le certificat">📦</button></div>`;
  }
  if (certificate?.status === 'outdated') {
    if (!learner.eligible) return '<span class="result-pill incorrect">À régénérer · score insuffisant</span>';
    return `<div class="certificate-actions"><span class="result-pill pending">À régénérer</span><button class="button" type="button" onclick="issueCertificateWithBonus('${group.id}','${learner.id}',true)">Régénérer</button></div>`;
  }
  if (!learner.eligible) return '—';
  if (group.status !== 'finished') return '<small class="muted">Terminez le groupe</small>';
  return `<button class="button" type="button" onclick="issueCertificateWithBonus('${group.id}','${learner.id}',false)">Valider et délivrer</button>`;
}

async function decorateCertificateTable() {
  if (decorating) return;
  const select = document.querySelector('#certificateGroup');
  const table = document.querySelector('#certificateRows table.weighted-results');
  const groupId = select?.value;
  if (!table || !groupId) return;
  decorating = true;
  try {
    const [baseResult, bonusRows] = await Promise.all([
      api(`/api/training-groups/${encodeURIComponent(groupId)}/results`),
      api(`/api/improvements/training-groups/${encodeURIComponent(groupId)}/bonuses`)
    ]);
    const bonusByUser = new Map((bonusRows || []).map(item => [item.user_id, Number(item.bonus_points || 0)]));
    const learners = (baseResult.participants || []).map(item => {
      const bonusPoints = bonusByUser.get(item.id) || 0;
      const baseScore = Number(item.global_score || 0);
      const globalScore = Math.min(100, Math.round((baseScore + bonusPoints) * 100) / 100);
      return { ...item, base_global_score: baseScore, bonus_points: bonusPoints, global_score: globalScore, eligible: globalScore >= Number(baseResult.group.passing_score) };
    });
    const result = { ...baseResult, participants: learners };
    const signature = `${groupId}:${learners.map(item => `${item.id}:${item.bonus_points}:${item.global_score}:${item.certificate?.status || ''}`).join('|')}:${table.querySelectorAll('tbody tr').length}`;
    if (signature === lastDecoratedSignature && table.dataset.bonusReady === 'true') return;
    lastDecoratedSignature = signature;

    const headRow = table.querySelector('thead tr');
    const initialHeaders = [...headRow?.children || []];
    const existingGlobalHead = initialHeaders.find(cell => cell.textContent.trim() === 'Score global');
    const originalGlobalIndex = Math.max(0, initialHeaders.indexOf(existingGlobalHead));
    if (existingGlobalHead && !headRow.querySelector('[data-bonus-header]')) {
      const baseHead = document.createElement('th');
      baseHead.textContent = 'Score pondéré';
      baseHead.dataset.baseHeader = 'true';
      existingGlobalHead.before(baseHead);
      const bonusHead = document.createElement('th');
      bonusHead.textContent = 'Bonus';
      bonusHead.dataset.bonusHeader = 'true';
      existingGlobalHead.before(bonusHead);
    }

    const byCode = new Map(learners.map(item => [String(item.participant_code || '').trim(), item]));
    for (const row of table.querySelectorAll('tbody tr')) {
      const code = row.querySelector('td:first-child small')?.textContent.trim();
      const learner = byCode.get(code);
      if (!learner) continue;
      let globalCell = row.querySelector('[data-global-score]');
      if (!globalCell) {
        globalCell = row.children[originalGlobalIndex];
        if (!globalCell) continue;
        globalCell.dataset.globalScore = 'true';
      }
      if (!row.querySelector('[data-base-score]')) {
        const baseCell = document.createElement('td');
        baseCell.dataset.baseScore = 'true';
        globalCell.before(baseCell);
        const bonusCell = document.createElement('td');
        bonusCell.dataset.bonusScore = 'true';
        globalCell.before(bonusCell);
      }
      const baseCell = row.querySelector('[data-base-score]');
      const bonusCell = row.querySelector('[data-bonus-score]');
      baseCell.innerHTML = `<span class="result-pill">${percent(learner.base_global_score)}</span>`;
      bonusCell.innerHTML = `<label class="bonus-score-control"><input type="number" min="0" max="100" step="0.1" value="${Number(learner.bonus_points || 0)}" aria-label="Points bonus de ${esc(learner.first_name)} ${esc(learner.last_name)}" onchange="saveBonusPoints('${groupId}','${learner.id}',this.value)"><span>pt</span></label>`;
      globalCell.innerHTML = `<b>${percent(learner.global_score)}</b>`;
      const decisionCell = globalCell.nextElementSibling;
      if (decisionCell) decisionCell.innerHTML = `<span class="result-pill ${learner.eligible ? 'correct' : 'incorrect'}">${learner.eligible ? 'Éligible' : 'Non éligible'}</span>`;
      const certificateTd = decisionCell?.nextElementSibling;
      if (certificateTd) certificateTd.innerHTML = certificateCell(result.group, learner);
    }

    const summary = document.querySelector('#certificateRows .certificate-summary');
    if (summary && !summary.querySelector('.bonus-score-note')) {
      summary.insertAdjacentHTML('beforeend', '<p class="muted bonus-score-note"><b>Points bonus :</b> le score global = score pondéré + bonus, avec un plafond à 100 %.</p>');
    }
    table.dataset.bonusReady = 'true';
  } catch (error) {
    console.error('[bonus]', error);
  } finally {
    decorating = false;
  }
}

async function saveBonusPoints(groupId, userId, value) {
  const bonus = Number(value);
  if (!Number.isFinite(bonus) || bonus < 0 || bonus > 100) {
    alert('Le bonus doit être compris entre 0 et 100 points.');
    return;
  }
  try {
    await api(`/api/improvements/training-groups/${encodeURIComponent(groupId)}/bonus/${encodeURIComponent(userId)}`, {
      method: 'PUT', body: JSON.stringify({ bonus_points: bonus })
    });
    lastDecoratedSignature = '';
    await decorateCertificateTable();
  } catch (error) {
    alert(error.message);
  }
}

async function issueCertificateWithBonus(groupId, userId, regenerate = false) {
  if (regenerate && !confirm('Régénérer ce certificat ? Son ancien QR code ne sera plus valide.')) return;
  try {
    await api(`/api/improvements/training-groups/${encodeURIComponent(groupId)}/certificates/${encodeURIComponent(userId)}`, { method: 'POST', body: '{}' });
    const original = window.__tsOriginalCertificateSelect || window.selectCertificateGroup;
    if (typeof original === 'function') await original(groupId);
    lastDecoratedSignature = '';
    setTimeout(decorateCertificateTable, 0);
  } catch (error) {
    alert(error.message);
  }
}

function installCertificateHook() {
  if (window.__tsBonusHookInstalled || typeof window.selectCertificateGroup !== 'function') return false;
  const original = window.selectCertificateGroup;
  window.__tsOriginalCertificateSelect = original;
  window.selectCertificateGroup = async function(groupId) {
    const result = await original(groupId);
    lastDecoratedSignature = '';
    setTimeout(decorateCertificateTable, 0);
    return result;
  };
  window.__tsBonusHookInstalled = true;
  return true;
}

Object.assign(window, { saveBonusPoints, issueCertificateWithBonus });

const observer = new MutationObserver(() => {
  installCertificateHook();
  void decorateCertificateTable();
});
observer.observe(document.documentElement, { childList: true, subtree: true });

const installer = setInterval(() => {
  if (installCertificateHook()) clearInterval(installer);
  void decorateCertificateTable();
}, 500);
