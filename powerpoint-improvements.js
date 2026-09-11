const sessionSettingKey = 'tsQuizSessionCode';
const examSettingKey = 'tsQuizExamCode';
const modeSettingKey = 'tsQuizDisplayMode';
let latest = null;
let poller = null;

const normalize = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function currentSetting(key) {
  try {
    return normalize(window.Office?.context?.document?.settings?.get?.(key) || localStorage.getItem(key));
  } catch {
    return normalize(localStorage.getItem(key));
  }
}

function currentMode() {
  try {
    return window.Office?.context?.document?.settings?.get?.(modeSettingKey) || localStorage.getItem(modeSettingKey) || 'session';
  } catch {
    return localStorage.getItem(modeSettingKey) || 'session';
  }
}

function directUrl() {
  const mode = currentMode();
  const code = mode === 'exam' ? currentSetting(examSettingKey) : currentSetting(sessionSettingKey);
  if (!code) return '';
  return mode === 'exam'
    ? `${location.origin}/exam.html?exam=${encodeURIComponent(code)}`
    : `${location.origin}/learner.html?session=${encodeURIComponent(code)}`;
}

function addQrLink() {
  const card = document.querySelector('.qr-card');
  const url = directUrl();
  if (!card || !url) return;
  let link = card.querySelector('.qr-direct-link');
  if (!link) {
    link = document.createElement('a');
    link.className = 'qr-direct-link';
    link.target = '_blank';
    link.rel = 'noopener';
    card.appendChild(link);
  }
  link.href = url;
  link.textContent = url;
}

function updateProgress(state) {
  const position = Number(state?.question_position || 0);
  const total = Number(state?.question_count || 0);
  if (!position || !total) return;
  const liveTitle = document.querySelector('.question-topline h1');
  if (liveTitle) liveTitle.textContent = `Question ${position} / ${total}`;
  const phase = document.querySelector('.phase-label');
  if (phase && /Question\s+\d+/i.test(phase.textContent)) {
    phase.textContent = phase.textContent.replace(/Question\s+\d+(?:\s*\/\s*\d+)?/i, `Question ${position} / ${total}`);
  }
}

function updatePoll(state) {
  const list = document.querySelector('.poll-list');
  if (!list) return;
  const totalParticipants = Number(state?.joined_count || 0);
  const byLabel = Object.fromEntries((state?.poll_results || []).map(item => [String(item.label), Number(item.response_count || 0)]));
  for (const item of list.querySelectorAll('.poll-item')) {
    const label = item.querySelector('.answer-letter')?.textContent.trim();
    if (!label) continue;
    const count = byLabel[label] || 0;
    const percent = totalParticipants ? Math.round(count * 100 / totalParticipants) : 0;
    const value = item.querySelector('.poll-copy strong');
    const bar = item.querySelector('.poll-track span');
    if (value) value.textContent = `${percent}%`;
    if (bar) bar.style.width = `${Math.min(100, percent)}%`;
  }
  const summary = document.querySelector('.poll-title > span');
  if (summary) summary.textContent = `${totalParticipants} participant${totalParticipants > 1 ? 's' : ''} au total`;
}

function ensurePodiumDensity() {
  const stage = document.querySelector('.podium-stage');
  if (!stage) return;
  const count = stage.querySelectorAll('.podium-place').length;
  if (count > 3 && count <= 12 && !stage.classList.contains('ranking-two-columns')) stage.classList.add('ranking-two-columns');
  if (count > 12 && count <= 24 && !stage.classList.contains('ranking-three-columns')) stage.classList.add('ranking-three-columns');
  if (count > 24 && !stage.classList.contains('ranking-four-columns')) stage.classList.add('ranking-four-columns');
}

function apply() {
  addQrLink();
  ensurePodiumDensity();
  if (latest) {
    updateProgress(latest);
    updatePoll(latest);
  }
}

async function refresh() {
  apply();
  if (currentMode() !== 'session') return;
  const code = currentSetting(sessionSettingKey);
  if (!code) return;
  try {
    const response = await fetch(`/api/improvements/presentation-state?code=${encodeURIComponent(code)}`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return;
    latest = await response.json();
    apply();
  } catch {}
}

const observer = new MutationObserver(apply);
observer.observe(document.documentElement, { childList: true, subtree: true });
refresh();
poller = setInterval(refresh, 1300);
window.addEventListener('beforeunload', () => clearInterval(poller));
