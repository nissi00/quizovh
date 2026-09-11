const examCode = (new URLSearchParams(location.search).get('exam') || '').trim().toUpperCase();
let learner = null;
let poller = null;

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

async function refreshIdentity() {
  if (!examCode || learner) return;
  try {
    const response = await fetch(`/api/final-exams/${encodeURIComponent(examCode)}/state`, { credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) return;
    const state = await response.json();
    learner = state?.learner || null;
  } catch {}
}

function applyExamEnhancements() {
  document.querySelector('.exam-result-card .score-final')?.remove();

  const resultCard = document.querySelector('.exam-result-card');
  if (resultCard && !resultCard.querySelector('.exam-result-confirmation')) {
    resultCard.insertAdjacentHTML('beforeend', '<p class="muted exam-result-confirmation">Votre examen a bien été enregistré. Votre résultat sera communiqué par l’instructeur.</p>');
  }

  if (!learner) return;
  const header = document.querySelector('.learner-header');
  if (!header) return;

  let identity = header.querySelector('.exam-connected-as');
  if (!identity) {
    header.querySelector('small')?.remove();
    identity = document.createElement('span');
    identity.className = 'exam-connected-as';
    header.appendChild(identity);
  }

  const identityKey = `${learner.first_name || ''}|${learner.last_name || ''}`;
  if (identity.dataset.identityKey !== identityKey) {
    identity.dataset.identityKey = identityKey;
    identity.innerHTML = `Connecté·e en tant que <b>${esc(learner.first_name)} ${esc(learner.last_name)}</b>`;
  }
}

async function tick() {
  if (!learner) await refreshIdentity();
  applyExamEnhancements();
}

tick();
poller = setInterval(tick, 1200);
window.addEventListener('beforeunload', () => clearInterval(poller));
