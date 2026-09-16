(() => {
  const formatTotalTime = ms => {
    if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return 'Non disponible';
    const seconds = Math.max(0, Math.round(Number(ms) / 1000));
    if (seconds < 60) return `${seconds} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest ? `${minutes} min ${rest} s` : `${minutes} min`;
  };

  function totalTimeValue() {
    if (typeof stats === 'undefined' || !stats.detail) return null;
    const questions = Array.isArray(stats.detail.questions) ? stats.detail.questions : [];
    if (!questions.length) return 0;
    const values = questions.map(question => question.response_time_ms);
    if (values.some(value => value === null || value === undefined || !Number.isFinite(Number(value)))) return null;
    return values.reduce((sum, value) => sum + Number(value), 0);
  }

  function enhanceTotalTimeCard() {
    const metrics = document.querySelector('#statistics .statistics-copy-metrics');
    if (!metrics) return;
    let card = metrics.querySelector('[data-statistics-total-time="true"]');
    if (!card) {
      card = document.createElement('div');
      card.dataset.statisticsTotalTime = 'true';
      card.innerHTML = '<small>Temps total</small><strong>—</strong>';
      metrics.appendChild(card);
    }
    const value = totalTimeValue();
    const strong = card.querySelector('strong');
    if (strong) strong.textContent = value === null ? 'Non disponible' : formatTotalTime(value);
  }

  async function removeArchivedExamAttemptsFromStatistics() {
    if (typeof stats === 'undefined' || stats.kind !== 'exam' || !stats.evaluationId || !stats.result) return;
    try {
      const response = await fetch(`/api/quality/final-exams/${encodeURIComponent(stats.evaluationId)}/archived-attempts`, {
        credentials:'same-origin',
        cache:'no-store'
      });
      if (!response.ok) return;
      const payload = await response.json();
      const archived = new Set(payload.attempt_ids || []);
      if (!archived.size) return;
      const before = stats.result.participants || [];
      const after = before.filter(participant => !archived.has(participant.attempt_id));
      if (after.length !== before.length) {
        stats.result = { ...stats.result, participants: after };
        stats.participantPage = 0;
        renderStats();
      }
    } catch (error) {
      console.warn('[statistics-archive-filter]', error);
    }
  }

  if (typeof loadResults === 'function') {
    const baseLoadResults = loadResults;
    loadResults = async function enhancedLoadResults(...args) {
      const result = await baseLoadResults(...args);
      await removeArchivedExamAttemptsFromStatistics();
      enhanceTotalTimeCard();
      return result;
    };
  }

  const observer = new MutationObserver(() => enhanceTotalTimeCard());
  observer.observe(document.body, { childList:true, subtree:true });
  enhanceTotalTimeCard();
})();
