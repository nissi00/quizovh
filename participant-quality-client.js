(() => {
  const nativeFetch = window.fetch.bind(window);
  let participants = [];
  let scheduled = false;

  function participantIdFromRow(row) {
    const action = row.querySelector('[onclick*="editParticipant("]')?.getAttribute('onclick') || '';
    return action.match(/editParticipant\('([0-9a-f-]{36})'\)/i)?.[1] || '';
  }

  function enhanceParticipantRegistry() {
    scheduled = false;
    const exportLink = document.querySelector('#participants a[href="/api/participants/export.csv"]');
    if (exportLink) exportLink.setAttribute('href', '/api/quality/participants/export.csv');

    const byId = new Map(participants.map(participant => [participant.id, participant]));
    document.querySelectorAll('#participantRows .participant-table tbody tr').forEach(row => {
      const id = participantIdFromRow(row);
      const participant = byId.get(id);
      if (!participant) return;
      const cells = row.querySelectorAll('td');
      if (cells[5] && cells[5].textContent !== String(participant.quality_quiz_count ?? 0)) {
        cells[5].textContent = String(participant.quality_quiz_count ?? 0);
      }
      row.dataset.examFirst = participant.quality_exam_first ? 'true' : 'false';
    });
  }

  function scheduleEnhancement() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(enhanceParticipantRegistry);
  }

  function rewrite(input, init) {
    if (typeof input !== 'string') return { input, trackedList: false };
    const method = String(init?.method || 'GET').toUpperCase();
    if (input === '/api/participants' && method === 'GET') {
      return { input: '/api/quality/participants', trackedList: true };
    }
    const editMatch = input.match(/^\/api\/participants\/([0-9a-f-]{36})$/i);
    if (editMatch && method === 'PATCH') {
      return { input: `/api/quality/participants/${editMatch[1]}`, trackedList: false };
    }
    const codeMatch = input.match(/^\/api\/participants\/([0-9a-f-]{36})\/regenerate-code$/i);
    if (codeMatch && method === 'POST') {
      return { input: `/api/quality/participants/${codeMatch[1]}/regenerate-code`, trackedList: false };
    }
    return { input, trackedList: false };
  }

  window.fetch = async (input, init) => {
    const rewritten = rewrite(input, init);
    const response = await nativeFetch(rewritten.input, init);
    if (rewritten.trackedList && response.ok) {
      response.clone().json().then(payload => {
        participants = Array.isArray(payload) ? payload : [];
        window.__qualityParticipants = participants;
        scheduleEnhancement();
      }).catch(() => undefined);
    }
    return response;
  };

  function installObserver() {
    const app = document.querySelector('#app');
    if (!app) return;
    new MutationObserver(scheduleEnhancement).observe(app, { childList: true, subtree: true });
    scheduleEnhancement();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installObserver, { once: true });
  else installObserver();
})();
