(() => {
  let decorating = false;
  let cachedGroupId = '';
  let cachedResult = null;
  let cachedAt = 0;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));
  const percent = value => `${Number(value || 0).toFixed(1).replace('.', ',')} %`;

  async function request(path, options = {}) {
    const response = await fetch(path, {
      credentials:'same-origin',
      cache:'no-store',
      ...options,
      headers:{ 'Content-Type':'application/json', ...(options.headers || {}) }
    });
    const payload = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) throw new Error(payload?.message || `Erreur (${response.status})`);
    return payload;
  }

  async function groupResults(groupId, force = false) {
    const now = Date.now();
    if (!force && cachedGroupId === groupId && cachedResult && now - cachedAt < 1200) return cachedResult;
    const result = await request(`/api/training-groups/${encodeURIComponent(groupId)}/results`);
    cachedGroupId = groupId;
    cachedResult = result;
    cachedAt = now;
    return result;
  }

  function examIdFromDetail() {
    const src = document.querySelector('#finalExamDetail .exam-detail .exam-qr img')?.getAttribute('src') || '';
    return src.match(/\/api\/final-exams\/([0-9a-f-]{36})\/qr/i)?.[1] || '';
  }

  async function duplicateExam(examId) {
    try {
      const exam = await request(`/api/final-exams/${encodeURIComponent(examId)}`);
      const suggested = `${exam.title || 'Examen final'} - Copie`;
      const title = prompt('Titre du nouvel examen :', suggested);
      if (title === null) return;
      const cleanTitle = title.trim();
      if (!cleanTitle) return alert('Le titre du nouvel examen est requis.');
      if (!confirm(`Dupliquer cet examen sous le titre « ${cleanTitle} » ?\n\nLes questions et les bonnes réponses seront copiées. Aucune copie participant, réponse, note ou statistique ne sera reprise.`)) return;

      const created = await request(`/api/quality/final-exams/${encodeURIComponent(examId)}/duplicate`, {
        method:'POST',
        body:JSON.stringify({ title:cleanTitle })
      });
      cachedAt = 0;
      alert(`Examen dupliqué : ${created.question_count || 0} question(s) copiée(s).\nLe nouvel examen est en préparation et ne contient aucune copie participant.`);
      if (typeof window.openFinalPanel === 'function') window.openFinalPanel('finalExam');
      window.setTimeout(() => {
        if (typeof window.selectFinalExam === 'function') window.selectFinalExam(created.id, true);
      }, 350);
    } catch (error) {
      alert(error.message);
    }
  }

  function ensureDuplicateButton() {
    const detail = document.querySelector('#finalExamDetail .exam-detail');
    const actions = detail?.querySelector('.exam-state-actions');
    const examId = examIdFromDetail();
    if (!detail || !actions || !examId) return;
    let button = actions.querySelector('[data-exam-duplicate="true"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.dataset.examDuplicate = 'true';
      button.textContent = '⧉ Dupliquer';
      button.title = 'Créer un nouvel examen avec les mêmes questions, sans reprendre les copies ni les résultats';
      actions.appendChild(button);
    }
    if (button.dataset.examId !== examId) {
      button.dataset.examId = examId;
      button.onclick = () => duplicateExam(examId);
    }
  }

  function updateGradingExplanation() {
    const component = [...document.querySelectorAll('#certificateRows .grading-component')]
      .find(item => item.querySelector('b')?.textContent.trim() === 'Examen final');
    const small = component?.querySelector('small');
    if (small) small.textContent = 'Poids de l’examen cumulé dans la note finale';
  }

  async function decorateCertificateTable() {
    if (decorating) return;
    const groupId = document.querySelector('#certificateGroup')?.value || '';
    const table = document.querySelector('#certificateRows table.weighted-results');
    if (!groupId || !table) return;
    decorating = true;
    try {
      const result = await groupResults(groupId);
      const exams = Array.isArray(result.final_exams) ? result.final_exams : [];
      const learners = Array.isArray(result.participants) ? result.participants : [];
      const signature = `${groupId}:${exams.map(exam => `${exam.id}:${exam.title}`).join('|')}:${learners.map(item => `${item.id}:${item.exam_score}:${item.exam_completed_count}`).join('|')}`;
      if (table.dataset.multiExamSignature === signature) {
        updateGradingExplanation();
        return;
      }

      const headRow = table.querySelector('thead tr');
      if (!headRow) return;
      headRow.querySelectorAll('[data-exam-detail-header="true"]').forEach(node => node.remove());
      table.querySelectorAll('tbody [data-exam-detail-cell="true"]').forEach(node => node.remove());

      let cumulativeHead = headRow.querySelector('[data-exam-cumulative-header="true"]');
      if (!cumulativeHead) {
        cumulativeHead = [...headRow.children].find(cell => cell.textContent.trim() === 'Examen final');
      }
      if (!cumulativeHead) return;
      cumulativeHead.dataset.examCumulativeHeader = 'true';
      cumulativeHead.textContent = 'Examen cumulé';
      cumulativeHead.title = 'Moyenne de tous les examens finaux du groupe. Un examen non réalisé compte pour 0.';

      const cumulativeIndex = [...headRow.children].indexOf(cumulativeHead);
      exams.forEach((exam, index) => {
        const header = document.createElement('th');
        header.dataset.examDetailHeader = 'true';
        header.title = exam.title || `Examen final ${index + 1}`;
        header.innerHTML = `Examen final ${index + 1}<small>${esc(exam.title || '')}</small>`;
        cumulativeHead.before(header);
      });

      const byCode = new Map(learners.map(item => [String(item.participant_code || '').trim(), item]));
      for (const row of table.querySelectorAll('tbody tr')) {
        const code = row.querySelector('td:first-child small')?.textContent.trim() || '';
        const learner = byCode.get(code);
        if (!learner) continue;
        const cumulativeCell = row.children[cumulativeIndex];
        if (!cumulativeCell) continue;
        const scoresByExam = new Map((learner.exam_scores || []).map(item => [item.exam_id, item]));

        exams.forEach(exam => {
          const score = scoresByExam.get(exam.id) || { submitted:false, score:0 };
          const cell = document.createElement('td');
          cell.dataset.examDetailCell = 'true';
          cell.innerHTML = `<span class="result-pill ${score.submitted ? 'correct' : 'pending'}">${percent(score.score)}${score.submitted ? '' : ' · absent'}</span>`;
          cumulativeCell.before(cell);
        });

        const total = Number(learner.exam_count || exams.length || 0);
        const completed = Number(learner.exam_completed_count || 0);
        cumulativeCell.innerHTML = total
          ? `<b>${percent(learner.exam_score)}</b><small>${completed}/${total} examen(s) réalisé(s)</small>`
          : '<span class="muted">Aucun examen</span>';
      }

      const summary = document.querySelector('#certificateRows .certificate-summary');
      if (summary && !summary.querySelector('[data-multi-exam-note="true"]')) {
        summary.insertAdjacentHTML('beforeend', '<p class="muted" data-multi-exam-note="true"><b>Examen cumulé :</b> moyenne de tous les examens finaux du groupe. Chaque examen non réalisé compte pour 0 dans cette moyenne.</p>');
      }
      updateGradingExplanation();
      table.dataset.multiExamSignature = signature;
    } catch (error) {
      console.error('[multi-exam-ui]', error);
    } finally {
      decorating = false;
    }
  }

  const observer = new MutationObserver(() => {
    ensureDuplicateButton();
    void decorateCertificateTable();
  });
  observer.observe(document.documentElement, { childList:true, subtree:true });

  window.setInterval(() => {
    ensureDuplicateButton();
    void decorateCertificateTable();
  }, 900);

  ensureDuplicateButton();
  void decorateCertificateTable();
})();
