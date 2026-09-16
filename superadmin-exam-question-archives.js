(() => {
  let page = 0;
  const pageSize = 10;
  let loading = false;
  let cache = [];

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));

  const formatDate = value => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat('fr-FR', { dateStyle:'short', timeStyle:'short' }).format(date)
      : '—';
  };

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

  function pagination(total) {
    if (!total) return '';
    const pages = Math.max(1, Math.ceil(total / pageSize));
    page = Math.min(page, pages - 1);
    const start = page * pageSize + 1;
    const end = Math.min((page + 1) * pageSize, total);
    return `<nav class="list-pagination" aria-label="Pagination des questions d’examen archivées"><span>${start}–${end} sur ${total}</span><button class="icon-button" type="button" data-exam-question-archive-page="-1" ${page===0?'disabled':''}>‹</button><button class="icon-button" type="button" data-exam-question-archive-page="1" ${page>=pages-1?'disabled':''}>›</button></nav>`;
  }

  function render(host) {
    const pages = Math.max(1, Math.ceil(cache.length / pageSize));
    page = Math.min(page, pages - 1);
    const start = page * pageSize;
    const items = cache.slice(start, start + pageSize);
    const nav = pagination(cache.length);
    host.innerHTML = `<section class="exam-question-archives-extension"><div class="row"><div><p class="eyebrow">Questions d’examen</p><h2>Questions d’examen archivées</h2></div><span class="tag">${cache.length} question(s)</span></div><p class="muted">Une question archivée peut être restaurée uniquement si l’examen est encore en préparation et qu’aucune copie n’a commencé.</p>${nav}<div class="card table-wrap"><table><thead><tr><th>Examen</th><th>Groupe</th><th>Question</th><th>Points</th><th>Archivée le</th><th>Actions</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.exam_title)}</b><small>${esc(item.exam_status||'')}</small></td><td>${esc(item.group_name)}</td><td>Q${Number(item.position||0)} · ${esc(item.body)}</td><td>${Number(item.points||0).toLocaleString('fr-FR')}</td><td>${formatDate(item.archived_at)}</td><td><div class="row-actions"><button class="icon-button" type="button" data-exam-question-restore="${item.id}" title="Restaurer" aria-label="Restaurer">↩️</button><button class="icon-button danger" type="button" data-exam-question-delete="${item.id}" title="Supprimer définitivement" aria-label="Supprimer définitivement">🗑️</button></div></td></tr>`).join('')||'<tr><td colspan="6">Aucune question d’examen archivée.</td></tr>'}</tbody></table></div>${nav}</section>`;
  }

  async function load(host) {
    if (loading) return;
    loading = true;
    host.innerHTML = '<div class="card empty">Chargement des questions d’examen archivées…</div>';
    try {
      const payload = await request('/api/quality/archived-final-exam-questions');
      cache = payload?.questions || [];
      render(host);
    } catch (error) {
      host.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  function ensure() {
    const panel = document.querySelector('#archives');
    if (!panel) return;
    let host = panel.querySelector('#examQuestionArchivesExtension');
    if (host) return;
    host = document.createElement('div');
    host.id = 'examQuestionArchivesExtension';
    host.style.marginTop = '24px';
    panel.appendChild(host);
    load(host);
  }

  async function refresh() {
    const host = document.querySelector('#examQuestionArchivesExtension');
    if (!host) return ensure();
    await load(host);
  }

  document.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-exam-question-archive-page]');
    if (pageButton) {
      page = Math.max(0, page + Number(pageButton.dataset.examQuestionArchivePage || 0));
      const host = document.querySelector('#examQuestionArchivesExtension');
      if (host) render(host);
      return;
    }

    const restoreButton = event.target.closest('[data-exam-question-restore]');
    if (restoreButton) {
      if (!confirm('Restaurer cette question dans son examen ?')) return;
      try {
        await request(`/api/quality/final-exam-question-archives/${encodeURIComponent(restoreButton.dataset.examQuestionRestore)}/restore`, { method:'POST', body:'{}' });
        await refresh();
      } catch (error) { alert(error.message); }
      return;
    }

    const deleteButton = event.target.closest('[data-exam-question-delete]');
    if (deleteButton) {
      if (!confirm('Supprimer définitivement cette question archivée ? Cette action est irréversible.')) return;
      try {
        await request(`/api/quality/final-exam-question-archives/${encodeURIComponent(deleteButton.dataset.examQuestionDelete)}`, { method:'DELETE' });
        await refresh();
      } catch (error) { alert(error.message); }
    }
  });

  const observer = new MutationObserver(() => ensure());
  observer.observe(document.documentElement, { childList:true, subtree:true });
  ensure();
})();
