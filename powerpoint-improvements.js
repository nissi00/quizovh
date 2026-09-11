const sessionSettingKey = 'tsQuizSessionCode';
let latest = null;
let poller = null;

const normalize = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

function currentSessionCode() {
  try {
    return normalize(window.Office?.context?.document?.settings?.get?.(sessionSettingKey) || localStorage.getItem(sessionSettingKey));
  } catch {
    return normalize(localStorage.getItem(sessionSettingKey));
  }
}

function renderedQrTarget() {
  const image = document.querySelector('.qr-card img');
  if (!image) return null;
  const src = image.getAttribute('src') || '';
  try {
    const parsed = new URL(src, location.origin);
    if (parsed.pathname === '/api/qr') {
      const code = normalize(parsed.searchParams.get('code'));
      return code ? { kind: 'session', code, url: `${location.origin}/learner.html?session=${encodeURIComponent(code)}` } : null;
    }
    if (parsed.pathname === '/api/presentation/exam-qr') {
      const code = normalize(parsed.searchParams.get('code'));
      return code ? { kind: 'exam', code, url: `${location.origin}/exam.html?exam=${encodeURIComponent(code)}` } : null;
    }
  } catch {}
  return null;
}

function addQrLink() {
  const card = document.querySelector('.qr-card');
  const target = renderedQrTarget();
  if (!card || !target) return;
  let link = card.querySelector('.qr-direct-link');
  if (!link) {
    link = document.createElement('a');
    link.className = 'qr-direct-link';
    link.target = '_blank';
    link.rel = 'noopener';
    card.appendChild(link);
  }
  if (link.href !== target.url) link.href = target.url;
  if (link.textContent !== target.url) link.textContent = target.url;
}

function updateProgress(state) {
  const position = Number(state?.question_position || 0);
  const total = Number(state?.question_count || 0);
  if (!position || !total) return;
  const liveTitle = document.querySelector('.question-topline h1');
  if (liveTitle && liveTitle.textContent !== `Question ${position} / ${total}`) liveTitle.textContent = `Question ${position} / ${total}`;
  const phase = document.querySelector('.phase-label');
  if (phase && /Question\s+\d+/i.test(phase.textContent)) {
    const next = phase.textContent.replace(/Question\s+\d+(?:\s*\/\s*\d+)?/i, `Question ${position} / ${total}`);
    if (phase.textContent !== next) phase.textContent = next;
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
    if (value && value.textContent !== `${percent}%`) value.textContent = `${percent}%`;
    if (bar && bar.style.width !== `${Math.min(100, percent)}%`) bar.style.width = `${Math.min(100, percent)}%`;
  }
  const summary = document.querySelector('.poll-title > span');
  const label = `${totalParticipants} participant${totalParticipants > 1 ? 's' : ''} au total`;
  if (summary && summary.textContent !== label) summary.textContent = label;
}

function ensurePodiumDensity() {
  const stage = document.querySelector('.podium-stage');
  if (!stage) return;
  const count = stage.querySelectorAll('.podium-place').length;
  stage.classList.remove('ranking-two-columns', 'ranking-three-columns', 'ranking-four-columns');
  if (count > 24) stage.classList.add('ranking-four-columns');
  else if (count > 12) stage.classList.add('ranking-three-columns');
  else if (count > 3) stage.classList.add('ranking-two-columns');
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
  if (document.querySelector('.exam-qr-stage')) return;
  const code = currentSessionCode();
  if (!code) return;
  try {
    const response = await fetch(`/api/improvements/presentation-state?code=${encodeURIComponent(code)}`, { credentials: 'omit', cache: 'no-store' });
    if (!response.ok) return;
    latest = await response.json();
    apply();
  } catch {}
}

refresh();
poller = setInterval(refresh, 1300);
window.addEventListener('beforeunload', () => clearInterval(poller));
