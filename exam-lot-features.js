(() => {
  let currentState = null;
  let loading = false;
  let timer = null;

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));

  function examIdFromDetail() {
    const src = document.querySelector('#finalExamDetail .exam-detail .exam-qr img')?.getAttribute('src') || '';
    return src.match(/\/api\/final-exams\/([0-9a-f-]{36})\/qr/i)?.[1] || '';
  }

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

  function statusHelp(exam) {
    if (Number(exam.attempt_count || 0) > 0) return 'Option verrouillée : une copie a déjà commencé.';
    if (exam.status === 'closed') return 'Rouvrez l’examen avant de modifier cette option.';
    return 'Chaque participant conservera le même ordre personnel pendant toute sa copie.';
  }

  function injectShuffleControl(detail, state) {
    const actions = detail.querySelector('.exam-state-actions');
    if (!actions) return;
    let box = detail.querySelector('[data-exam-shuffle-control="true"]');
    if (!box) {
      box = document.createElement('div');
      box.dataset.examShuffleControl = 'true';
      box.className = 'exam-shuffle-control';
      actions.insertAdjacentElement('afterend', box);
    }
    const exam = state.exam;
    const disabled = Number(exam.attempt_count || 0) > 0 || exam.status === 'closed';
    box.innerHTML = `<label class="exam-shuffle-choice"><input type="checkbox" data-exam-shuffle ${exam.shuffle_questions?'checked':''} ${disabled?'disabled':''}><span><b>Mélanger l’ordre des questions pour chaque participant</b><small>${esc(statusHelp(exam))}</small></span></label>`;
    box.querySelector('[data-exam-shuffle]')?.addEventListener('change', async event => {
      const input = event.currentTarget;
      input.disabled = true;
      try {
        await request(`/api/quality/final-exams/${encodeURIComponent(exam.id)}/shuffle`, {
          method:'PATCH',
          body:JSON.stringify({ enabled:input.checked })
        });
        await refresh();
      } catch (error) {
        input.checked = !input.checked;
        alert(error.message);
        await refresh();
      }
    });
  }



  async function selectPresentationQuestion(questionId) {
    const exam = currentState?.exam;
    if (!exam) return;
    try {
      await request(`/api/quality/final-exams/${encodeURIComponent(exam.id)}/presentation-question`, {
        method:'PUT',
        body:JSON.stringify({ question_id:questionId || null })
      });
      await refresh();
    } catch (error) { alert(error.message); }
  }

  function injectQuestionActions(detail, state) {
    const section = detail.querySelector('.exam-questions');
    if (!section) return;
    const rows = [...section.querySelectorAll('.exam-question-summary')];
    const exam = state.exam;
    const canDisplay = exam.status === 'closed';

    rows.forEach((row, index) => {
      const question = state.questions[index];
      if (!question) return;
      let actions = row.querySelector('[data-exam-question-extra-actions="true"]');
      if (!canDisplay) {
        actions?.remove();
        return;
      }
      if (!actions) {
        actions = document.createElement('span');
        actions.dataset.examQuestionExtraActions = 'true';
        actions.className = 'exam-question-extra-actions';
        const optionSummary = row.querySelector('.exam-option-summary');
        row.insertBefore(actions, optionSummary || null);
      }
      const active = exam.presentation_question_id === question.id;
      actions.innerHTML = `<button class="icon-button exam-aff-button ${active?'active':''}" type="button" data-exam-question-display="${question.id}" title="${active?'Revenir au QR code':'Afficher cette question sur PowerPoint'}" aria-label="Afficher sur PowerPoint">${active?'Aff ✓':'Aff'}</button>`;
      actions.querySelector('[data-exam-question-display]')?.addEventListener('click', () => selectPresentationQuestion(active ? null : question.id));
    });

    let qrButton = section.querySelector('[data-exam-return-qr="true"]');
    const heading = section.querySelector('h3');
    if (canDisplay) {
      if (!qrButton) {
        qrButton = document.createElement('button');
        qrButton.type = 'button';
        qrButton.dataset.examReturnQr = 'true';
        qrButton.className = 'button secondary exam-return-qr';
        qrButton.textContent = '▦ Retour au QR';
        heading?.insertAdjacentElement('afterend', qrButton);
      }
      qrButton.disabled = !exam.presentation_question_id;
      qrButton.onclick = () => selectPresentationQuestion(null);
    } else {
      qrButton?.remove();
    }
  }

  function applyState(state) {
    const detail = document.querySelector('#finalExamDetail');
    const summary = detail?.querySelector('.exam-detail');
    if (!detail || !summary || !state?.exam) return;
    injectShuffleControl(summary, state);
    injectQuestionActions(detail, state);
  }

  async function refresh() {
    const examId = examIdFromDetail();
    if (!examId) {
      currentState = null;
      return;
    }
    if (loading) return;
    loading = true;
    try {
      const state = await request(`/api/quality/final-exams/${encodeURIComponent(examId)}/feature-state`);
      currentState = state;
      applyState(state);
    } catch (error) {
      console.warn('[exam-lot-features]', error);
    } finally {
      loading = false;
    }
  }

  timer = window.setInterval(refresh, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('beforeunload', () => window.clearInterval(timer));
  refresh();
})();
