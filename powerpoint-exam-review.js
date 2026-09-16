(() => {
  let poller = null;
  let lastSignature = '';
  const root = document.querySelector('#powerpointApp');

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));

  const normalizeCode = value => String(value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);

  async function officeSetting(key) {
    try {
      if (!window.Office?.onReady) return '';
      await Promise.race([
        window.Office.onReady().catch(() => undefined),
        new Promise(resolve => setTimeout(resolve, 300))
      ]);
      return window.Office.context?.document?.settings?.get(key) || '';
    } catch {
      return '';
    }
  }

  async function currentContext() {
    const localMode = localStorage.getItem('tsQuizDisplayMode') || '';
    const localCode = normalizeCode(localStorage.getItem('tsQuizExamCode') || '');
    if (localMode === 'exam' && localCode) return { mode:'exam', code:localCode };

    const [mode, code] = await Promise.all([
      officeSetting('tsQuizDisplayMode'),
      officeSetting('tsQuizExamCode')
    ]);
    return { mode:String(mode || localMode || ''), code:normalizeCode(code || localCode) };
  }

  function removeOverlay() {
    document.querySelector('#examReviewOverlay')?.remove();
    lastSignature = '';
  }

  function renderReview(payload) {
    const question = payload?.question;
    const exam = payload?.exam;
    if (!question || !exam) return removeOverlay();
    const signature = `${exam.id}:${question.id}:${question.body}:${(question.options||[]).map(option=>`${option.id}:${option.body}:${option.is_correct}`).join('|')}`;
    if (signature === lastSignature && document.querySelector('#examReviewOverlay')) return;
    lastSignature = signature;

    let overlay = document.querySelector('#examReviewOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'examReviewOverlay';
      overlay.className = 'presentation-shell exam-review-overlay';
      document.body.appendChild(overlay);
    }

    overlay.innerHTML = `<header class="presentation-header">
      <div class="presentation-brand"><span class="brand-mark brand-logo">TS<img src="/api/branding/logo" alt="Logo de l’organisme"></span><b>Formation</b></div>
      <div class="presentation-context"><span>${esc(exam.theme_name || 'Examen final')}</span><b>${esc(exam.title || '')}</b></div>
      <div class="header-actions"><span class="phase-label">Révision après examen</span></div>
    </header>
    <section class="stage correction-stage exam-review-stage">
      <div class="question-topline"><div><p class="eyebrow">Question à revoir</p><h1>Question ${Number(question.position || 1)}</h1></div><span class="tag orange">${Number(question.points || 0).toLocaleString('fr-FR')} point(s)</span></div>
      <h2>${esc(question.body)}</h2>
      <div class="question-content"><div class="question-content-main"><div class="answer-grid correction-grid">
        ${(question.options || []).map(option => `<div class="answer-card ${option.is_correct ? 'correct' : 'incorrect'}"><span>${esc(option.label)}</span><b>${esc(option.body)}</b><strong>${option.is_correct ? '✓' : '×'}</strong></div>`).join('')}
      </div></div></div>
      <p class="correction-note">Reprise pédagogique après l’examen · les bonnes réponses sont mises en évidence.</p>
    </section>`;
  }

  async function refresh() {
    const context = await currentContext();
    if (context.mode !== 'exam' || !context.code) return removeOverlay();
    try {
      const response = await fetch(`/api/quality/presentation/exam-review?code=${encodeURIComponent(context.code)}`, {
        credentials:'omit',
        cache:'no-store'
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.active) return removeOverlay();
      renderReview(payload);
    } catch {
      removeOverlay();
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    .exam-review-overlay{position:fixed;inset:0;z-index:10000;background:var(--surface,#fff);overflow:auto}
    .exam-review-stage{min-height:calc(100vh - 92px);box-sizing:border-box}
    .exam-review-stage .question-topline{display:flex;align-items:center;justify-content:space-between;gap:24px}
    .exam-review-stage .tag{font-size:1rem;padding:.55rem .8rem;border-radius:999px}
    .exam-review-stage .answer-card{min-height:86px}
  `;
  document.head.appendChild(style);

  poller = window.setInterval(refresh, 800);
  window.addEventListener('beforeunload', () => window.clearInterval(poller));
  refresh();
})();
