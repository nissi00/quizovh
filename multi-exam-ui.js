(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));

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

  function examIdFromDetail() {
    const src = document.querySelector('#finalExamDetail .exam-detail .exam-qr img')?.getAttribute('src') || '';
    return src.match(/\/api\/final-exams\/([0-9a-f-]{36})\/qr/i)?.[1] || '';
  }

  async function duplicateExam(examId) {
    try {
      const [exam, groupList, examList] = await Promise.all([
        request(`/api/final-exams/${encodeURIComponent(examId)}`),
        request('/api/training-groups'),
        request('/api/final-exams?type=final')
      ]);
      const usedGroupIds = new Set((Array.isArray(examList) ? examList : []).map(item => item.group_id));
      const availableGroups = (Array.isArray(groupList) ? groupList : []).filter(group => !usedGroupIds.has(group.id));
      if (!availableGroups.length) return alert('Aucun groupe de formation disponible.');

      document.querySelector('#duplicateExamDialog')?.remove();
      const dialog = document.createElement('dialog');
      dialog.id = 'duplicateExamDialog';
      dialog.style.width = 'min(640px, calc(100vw - 32px))';
      dialog.style.maxWidth = '640px';
      dialog.style.border = '0';
      dialog.style.padding = '0';
      dialog.style.background = 'transparent';
      const suggested = `${exam.title || 'Examen final'} - Copie`;
      dialog.innerHTML = `<form class="card" data-duplicate-exam-form><p class="eyebrow">Réutiliser le contenu</p><h3>Dupliquer l’examen</h3><p class="muted">Les questions, propositions, bonnes réponses, points, consignes et durée seront copiés. Seuls les groupes sans examen final sont proposés.</p><label>Titre du nouvel examen</label><input data-duplicate-title value="${esc(suggested)}" required maxlength="250"><label>Groupe de formation</label><select data-duplicate-group required><option value="">Sélectionnez un groupe</option>${availableGroups.map(group=>`<option value="${esc(group.id)}">${esc(group.name)} · ${esc(group.theme_name || '')}</option>`).join('')}</select><div class="actions"><button class="button" type="submit">Dupliquer</button><button class="button secondary" type="button" data-duplicate-cancel>Annuler</button></div></form>`;
      document.body.appendChild(dialog);
      dialog.querySelector('[data-duplicate-cancel]')?.addEventListener('click', () => dialog.close());
      dialog.addEventListener('close', () => dialog.remove(), { once:true });
      dialog.querySelector('[data-duplicate-exam-form]')?.addEventListener('submit', async event => {
        event.preventDefault();
        const title = dialog.querySelector('[data-duplicate-title]')?.value.trim() || '';
        const groupId = dialog.querySelector('[data-duplicate-group]')?.value || '';
        if (!title || !groupId) return alert('Renseignez le titre et le groupe de formation.');
        const submit = dialog.querySelector('button[type="submit"]');
        if (submit) submit.disabled = true;
        try {
          const created = await request(`/api/quality/final-exams/${encodeURIComponent(examId)}/duplicate`, {
            method:'POST',
            body:JSON.stringify({ title, group_id:groupId })
          });
          dialog.close();
          alert(`Examen dupliqué : ${created.question_count || 0} question(s) copiée(s).\\nLe nouvel examen est en préparation et rattaché au groupe sélectionné. Aucune donnée participant n’a été copiée.`);
          if (typeof window.openFinalPanel === 'function') window.openFinalPanel('finalExam');
          window.setTimeout(() => {
            if (typeof window.selectFinalExam === 'function') window.selectFinalExam(created.id, true);
          }, 350);
        } catch (error) {
          if (submit) submit.disabled = false;
          alert(error.message);
        }
      });
      dialog.showModal();
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

  const observer = new MutationObserver(ensureDuplicateButton);
  observer.observe(document.documentElement, { childList:true, subtree:true });
  window.setInterval(ensureDuplicateButton, 900);

  ensureDuplicateButton();
})();
