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
    applyExamEnhancements();
  } catch {}
}

function applyExamEnhancements() {
  const score = document.querySelector('.exam-result-card .score-final');
  score?.remove();
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
  identity.innerHTML = `Connecté·e en tant que <b>${esc(learner.first_name)} ${esc(learner.last_name)}</b>`;
}

const observer = new MutationObserver(applyExamEnhancements);
observer.observe(document.documentElement, { childList: true, subtree: true });
applyExamEnhancements();
refreshIdentity();
poller = setInterval(() => { refreshIdentity(); applyExamEnhancements(); }, 1200);
window.addEventListener('beforeunload', () => clearInterval(poller));
