(() => {
  let currentState = null;
  let loading = false;
  let timer = null;
  const answerLabels = 'ABCDEF';

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

  function closeDialog() {
    document.querySelector('#examLotDialog')?.remove();
  }

  function openDialog(html) {
    closeDialog();
    const overlay = document.createElement('div');
    overlay.id = 'examLotDialog';
    overlay.className = 'exam-lot-dialog-overlay';
    overlay.innerHTML = `<div class="exam-lot-dialog card" role="dialog" aria-modal="true">${html}</div>`;
    overlay.addEventListener('click', event => {
      if (event.target === overlay) closeDialog();
    });
    document.body.appendChild(overlay);
    overlay.querySelector('[data-exam-dialog-close]')?.addEventListener('click', closeDialog);
    return overlay;
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

  async function openDuplicateDialog() {
    const exam = currentState?.exam;
    if (!exam) return;
    try {
      const [groupsPayload, examsPayload] = await Promise.all([
        request('/api/training-groups'),
        request('/api/final-exams')
      ]);
      const groups = Array.isArray(groupsPayload) ? groupsPayload : [];
      const exams = Array.isArray(examsPayload) ? examsPayload : [];
      const occupied = new Set(exams.map(item => item.group_id));
      const eligible = groups.filter(group => group.id !== exam.group_id && !occupied.has(group.id));

      const overlay = openDialog(`<div class="row"><div><p class="eyebrow">Nouvelle version</p><h2>Dupliquer l’examen</h2></div><button class="icon-button" type="button" data-exam-dialog-close aria-label="Fermer">×</button></div>
        <p class="muted">La copie sera créée en <b>Préparation</b>, sans participant, sans copie et sans résultat. Les questions, propositions, bonnes réponses, points, durée et consignes seront recopiés.</p>
        ${eligible.length ? `<form data-exam-duplicate-form><label>Groupe de destination</label><select data-exam-duplicate-group required><option value="">Sélectionnez un groupe sans examen</option>${eligible.map(group=>`<option value="${group.id}">${esc(group.name)}${group.theme_name?` · ${esc(group.theme_name)}`:''}</option>`).join('')}</select><label>Titre de la copie</label><input data-exam-duplicate-title maxlength="300" value="${esc(`${exam.title} - Copie`)}" required><div class="actions"><button class="button secondary" type="button" data-exam-dialog-close>Annuler</button><button class="button" type="submit">Créer la copie en préparation</button></div></form>` : `<div class="notice">Aucun groupe sans examen n’est disponible. Créez d’abord un groupe de test ou un nouveau groupe de formation, puis relancez la duplication.</div><div class="actions"><button class="button secondary" type="button" data-exam-dialog-close>Fermer</button></div>`}`);

      overlay.querySelectorAll('[data-exam-dialog-close]').forEach(button => button.addEventListener('click', closeDialog));
      const form = overlay.querySelector('[data-exam-duplicate-form]');
      form?.addEventListener('submit', async event => {
        event.preventDefault();
        const submit = form.querySelector('button[type="submit"]');
        submit.disabled = true;
        try {
          const created = await request(`/api/quality/final-exams/${encodeURIComponent(exam.id)}/duplicate`, {
            method:'POST',
            body:JSON.stringify({
              target_group_id:overlay.querySelector('[data-exam-duplicate-group]').value,
              title:overlay.querySelector('[data-exam-duplicate-title]').value.trim()
            })
          });
          closeDialog();
          alert(`Copie créée en préparation avec ${created.question_count || 0} question(s).`);
          if (typeof window.openFinalPanel === 'function') window.openFinalPanel('finalExam');
          let tries = 0;
          const wait = window.setInterval(() => {
            tries += 1;
            const row = [...document.querySelectorAll('#finalExamRows button')].find(button => button.getAttribute('onclick')?.includes(created.id));
            if (row || tries >= 50) {
              window.clearInterval(wait);
              if (typeof window.selectFinalExam === 'function') window.selectFinalExam(created.id, true);
            }
          }, 100);
        } catch (error) {
          alert(error.message);
          submit.disabled = false;
        }
      });
    } catch (error) {
      alert(error.message);
    }
  }

  function injectDuplicateControl(detail) {
    const actions = detail.querySelector('.exam-state-actions');
    if (!actions) return;
    let button = actions.querySelector('[data-exam-duplicate="true"]');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'button secondary';
      button.dataset.examDuplicate = 'true';
      button.textContent = '⧉ Dupliquer';
      button.title = 'Créer une copie indépendante en préparation';
      button.addEventListener('click', openDuplicateDialog);
      actions.appendChild(button);
    }
  }

  async function archiveQuestion(question) {
    const exam = currentState?.exam;
    if (!exam) return;
    if (!confirm(`Archiver « Q${question.position}. ${question.body} » ?\n\nLa question disparaîtra de l’examen actif mais pourra être restaurée depuis Superadministration → Archives.`)) return;
    try {
      await request(`/api/quality/final-exam-questions/${encodeURIComponent(question.id)}/archive`, { method:'POST', body:'{}' });
      currentState = null;
      if (typeof window.selectFinalExam === 'function') await window.selectFinalExam(exam.id, false);
      await refresh();
    } catch (error) { alert(error.message); }
  }

  function syncEditAnswerCount(overlay) {
    const count = Number(overlay.querySelector('[data-exam-edit-count]')?.value || 4);
    overlay.querySelectorAll('[data-exam-edit-option]').forEach(row => {
      const index = Number(row.dataset.examEditOption);
      const visible = index < count;
      row.hidden = !visible;
      row.querySelector('input[type="text"]').required = visible;
      const correct = row.querySelector('input[type="checkbox"]');
      correct.disabled = !visible;
      if (!visible) correct.checked = false;
    });
  }

  function openQuestionEditor(question) {
    const exam = currentState?.exam;
    if (!exam) return;
    if (exam.status !== 'draft' || Number(exam.attempt_count || 0) > 0) {
      return alert('La modification est disponible uniquement en préparation et avant la première copie.');
    }
    const options = Array.isArray(question.options) ? question.options : [];
    const count = Math.min(6, Math.max(2, options.length || 4));
    const overlay = openDialog(`<div class="row"><div><p class="eyebrow">Examen en préparation</p><h2>Modifier la question ${Number(question.position || 0)}</h2></div><button class="icon-button" type="button" data-exam-dialog-close aria-label="Fermer">×</button></div>
      <form data-exam-edit-form><label>Question</label><textarea data-exam-edit-body maxlength="2000" required>${esc(question.body)}</textarea><div class="form-grid"><div><label>Nombre de propositions</label><select data-exam-edit-count>${[2,3,4,5,6].map(value=>`<option value="${value}" ${value===count?'selected':''}>${value}</option>`).join('')}</select></div><div><label>Points</label><input data-exam-edit-points type="number" min="0.1" max="1000" step="0.1" value="${Number(question.points || 1)}" required></div></div><div class="exam-edit-options">${answerLabels.split('').map((label,index)=>{const option=options[index]||{};return `<div class="exam-edit-option" data-exam-edit-option="${index}" ${index>=count?'hidden':''}><label>Proposition ${label}</label><div class="exam-edit-answer-line"><input type="text" data-exam-edit-answer="${index}" maxlength="500" value="${esc(option.body||'')}" ${index<count?'required':''}><label class="inline-choice"><input type="checkbox" data-exam-edit-correct="${index}" ${option.is_correct?'checked':''} ${index>=count?'disabled':''}> Bonne réponse</label></div></div>`}).join('')}</div><div class="actions"><button class="button secondary" type="button" data-exam-dialog-close>Annuler</button><button class="button" type="submit">Enregistrer la question</button></div></form>`);

    overlay.querySelectorAll('[data-exam-dialog-close]').forEach(button => button.addEventListener('click', closeDialog));
    overlay.querySelector('[data-exam-edit-count]')?.addEventListener('change', () => syncEditAnswerCount(overlay));
    const form = overlay.querySelector('[data-exam-edit-form]');
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      const countValue = Number(overlay.querySelector('[data-exam-edit-count]').value);
      const answers = Array.from({ length:countValue }, (_, index) => overlay.querySelector(`[data-exam-edit-answer="${index}"]`).value.trim());
      const correct = Array.from({ length:countValue }, (_, index) => index).filter(index => overlay.querySelector(`[data-exam-edit-correct="${index}"]`).checked);
      if (answers.some(answer => !answer)) return alert('Toutes les propositions visibles doivent être renseignées.');
      if (!correct.length) return alert('Choisissez au moins une bonne réponse.');
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      try {
        await request(`/api/quality/final-exam-questions/${encodeURIComponent(question.id)}`, {
          method:'PATCH',
          body:JSON.stringify({
            body:overlay.querySelector('[data-exam-edit-body]').value.trim(),
            answers,
            correct,
            points:Number(overlay.querySelector('[data-exam-edit-points]').value)
          })
        });
        closeDialog();
        currentState = null;
        if (typeof window.selectFinalExam === 'function') await window.selectFinalExam(exam.id, false);
        await refresh();
      } catch (error) {
        alert(error.message);
        submit.disabled = false;
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
    const canEdit = exam.status === 'draft' && Number(exam.attempt_count || 0) === 0;
    const canArchive = canEdit;
    const canDisplay = exam.status === 'closed';

    rows.forEach((row, index) => {
      const question = state.questions[index];
      if (!question) return;
      let actions = row.querySelector('[data-exam-question-extra-actions="true"]');
      if (!actions) {
        actions = document.createElement('span');
        actions.dataset.examQuestionExtraActions = 'true';
        actions.className = 'exam-question-extra-actions';
        const optionSummary = row.querySelector('.exam-option-summary');
        row.insertBefore(actions, optionSummary || null);
      }
      const active = exam.presentation_question_id === question.id;
      actions.innerHTML = `<button class="icon-button" type="button" data-exam-question-edit="${question.id}" title="${canEdit?'Modifier la question':'Modification disponible uniquement en préparation avant la première copie'}" aria-label="Modifier la question" ${canEdit?'':'disabled'}>✏️</button><button class="icon-button archive-button" type="button" data-exam-question-archive="${question.id}" title="${canArchive?'Archiver la question':'Archivage disponible uniquement avant la première copie'}" aria-label="Archiver la question" ${canArchive?'':'disabled'}>📦</button><button class="icon-button exam-aff-button ${active?'active':''}" type="button" data-exam-question-display="${question.id}" title="${canDisplay?(active?'Revenir au QR code':'Afficher cette question sur PowerPoint'):'Disponible après clôture de l’examen'}" aria-label="Afficher sur PowerPoint" ${canDisplay?'':'disabled'}>${active?'Aff ✓':'Aff'}</button>`;
      actions.querySelector('[data-exam-question-edit]')?.addEventListener('click', () => openQuestionEditor(question));
      actions.querySelector('[data-exam-question-archive]')?.addEventListener('click', () => archiveQuestion(question));
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
    injectDuplicateControl(summary);
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

  const style = document.createElement('style');
  style.textContent = `
    .exam-lot-dialog-overlay{position:fixed;inset:0;z-index:10050;background:rgba(15,23,42,.62);display:grid;place-items:center;padding:20px;overflow:auto}
    .exam-lot-dialog{width:min(760px,100%);max-height:90vh;overflow:auto;margin:auto}
    .exam-lot-dialog h2{margin-top:0}
    .exam-lot-dialog form{display:grid;gap:12px}
    .exam-lot-dialog .actions{justify-content:flex-end;margin-top:8px}
    .exam-edit-options{display:grid;gap:10px}
    .exam-edit-option{padding:10px;border:1px solid #dbe4ee;border-radius:10px;background:#f8fafc}
    .exam-edit-answer-line{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;align-items:center}
    .exam-question-extra-actions{display:inline-flex;gap:6px;align-items:center;margin-left:auto}
    @media(max-width:720px){.exam-edit-answer-line{grid-template-columns:1fr}.exam-lot-dialog-overlay{padding:10px}}
  `;
  document.head.appendChild(style);

  timer = window.setInterval(refresh, 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('beforeunload', () => window.clearInterval(timer));
  refresh();
})();
