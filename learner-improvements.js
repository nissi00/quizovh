const sessionCode = (new URLSearchParams(location.search).get('session') || '').trim().toUpperCase();
let latest = null;
let poller = null;
const pseudoSavedKey = `ts-podium-saved:${sessionCode}`;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

async function fetchDisplayState() {
  if (!sessionCode) return null;
  const response = await fetch(`/api/improvements/learner-display?code=${encodeURIComponent(sessionCode)}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) return null;
  return response.json();
}

function removePodiumOverlay() {
  document.querySelector('#learnerPodiumOverlay')?.remove();
}

function renderPodiumOverlay(state) {
  if (!state?.podium_visible) return removePodiumOverlay();
  const shell = document.querySelector('.learner-shell') || document.body;
  let overlay = document.querySelector('#learnerPodiumOverlay');
  if (!overlay) {
    overlay = document.createElement('section');
    overlay.id = 'learnerPodiumOverlay';
    overlay.className = 'learner-podium-overlay';
    shell.appendChild(overlay);
  }
  const ranking = state.podium || [];
  const signature = ranking.map((item, index) => `${index}:${item.alias}:${item.score_percent}`).join('|');
  if (overlay.dataset.signature === signature) return;
  overlay.dataset.signature = signature;
  overlay.innerHTML = `<div class="learner-podium-card"><p class="eyebrow">Classement du quiz</p><h1>Podium</h1><p class="muted">Seuls les pseudonymes ayant accepté d'apparaître sont affichés.</p><div class="learner-podium-grid">${ranking.map((item, index) => `<article class="learner-podium-entry"><span>${index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : `${index + 1}.`}</span><strong>${esc(item.alias)}</strong><b>${Number(item.score_percent || 0).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} %</b></article>`).join('') || '<p class="muted">Aucun participant n’a choisi d’apparaître dans le classement.</p>'}</div></div>`;
}

function updateQuestionProgress(state) {
  const position = Number(state?.question_position || 0);
  const total = Number(state?.question_count || 0);
  if (!position || !total) return;
  const title = document.querySelector('.question-head h1');
  const label = `Question ${position} / ${total}`;
  if (title && /^Question\s+\d+/i.test(title.textContent.trim()) && title.textContent !== label) title.textContent = label;
}

function updatePoll(state) {
  if (!document.querySelector('.poll-results')) return;
  const totalParticipants = Number(state?.joined_count || 0);
  const byLabel = Object.fromEntries((state?.poll_results || []).map(item => [String(item.label), Number(item.response_count || 0)]));
  for (const row of document.querySelectorAll('.poll-row')) {
    const label = row.querySelector('.answer-letter')?.textContent.trim();
    if (!label) continue;
    const count = byLabel[label] || 0;
    const percent = totalParticipants ? Math.round(count * 100 / totalParticipants) : 0;
    const value = row.querySelector('.poll-label b');
    const bar = row.querySelector('.poll-bar span');
    const small = row.querySelector('small');
    if (value && value.textContent !== `${percent}%`) value.textContent = `${percent}%`;
    if (bar && bar.style.width !== `${Math.min(100, percent)}%`) bar.style.width = `${Math.min(100, percent)}%`;
    const detail = `${count} participant${count > 1 ? 's' : ''} sur ${totalParticipants}`;
    if (small && small.textContent !== detail) small.textContent = detail;
  }
  const tag = document.querySelector('.poll-results')?.closest('.login')?.querySelector('.question-head .tag');
  const summary = `${totalParticipants} participant${totalParticipants > 1 ? 's' : ''}`;
  if (tag && tag.textContent !== summary) tag.textContent = summary;
}

function updatePartialFeedback(state) {
  if (state?.answer_status !== 'partial') return;
  const feedback = document.querySelector('.review-result');
  if (!feedback || feedback.dataset.partialApplied === '1') return;
  feedback.dataset.partialApplied = '1';
  feedback.classList.remove('success', 'bad');
  feedback.classList.add('warning');
  feedback.innerHTML = '<b>Dommage, ce n’est pas totalement exact.</b> Vous avez trouvé une partie des bonnes réponses.';
}

function waitingMessage() {
  if (sessionStorage.getItem(pseudoSavedKey) !== '1') return;
  if (latest?.status === 'live') {
    sessionStorage.removeItem(pseudoSavedKey);
    document.querySelector('#podiumWaitingMessage')?.remove();
    return;
  }
  const podiumCard = document.querySelector('.podium-waiting-card');
  if (!podiumCard || document.querySelector('#podiumWaitingMessage')) return;
  podiumCard.insertAdjacentHTML('beforeend', '<p id="podiumWaitingMessage" class="podium-waiting-message">⌛ En attente de question</p>');
}

function applyEnhancements() {
  if (!latest) return;
  renderPodiumOverlay(latest);
  updateQuestionProgress(latest);
  updatePoll(latest);
  updatePartialFeedback(latest);
  waitingMessage();
}

async function refreshEnhancements() {
  try {
    latest = await fetchDisplayState();
    if (!latest) return;
    applyEnhancements();
  } catch (error) {
    console.debug('[learner-improvements]', error.message);
  }
}

function installPodiumSaveHook() {
  if (window.__tsPodiumSaveHook || typeof window.savePodiumPreference !== 'function') return false;
  const original = window.savePodiumPreference;
  window.savePodiumPreference = async function(...args) {
    const result = await original(...args);
    sessionStorage.setItem(pseudoSavedKey, '1');
    setTimeout(waitingMessage, 0);
    return result;
  };
  window.__tsPodiumSaveHook = true;
  return true;
}

const hookTimer = setInterval(() => {
  if (installPodiumSaveHook()) clearInterval(hookTimer);
}, 300);
installPodiumSaveHook();

if (sessionCode) {
  refreshEnhancements();
  poller = setInterval(refreshEnhancements, 1200);
}
window.addEventListener('beforeunload', () => {
  clearInterval(poller);
  clearInterval(hookTimer);
});
