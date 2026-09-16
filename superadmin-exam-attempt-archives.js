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

  const formatScore = value => value === null || value === undefined
    ? '—'
    : `${Number(value).toLocaleString('fr-FR', { maximumFractionDigits:1 })} %`;

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
    return `<nav class="list-pagination" aria-label="Pagination des copies archivées"><span>${start}–${end} sur ${total}</span><button class="icon-button" type="button" data-attempt-page="-1" ${page===0?'disabled':''}>‹</button><button class="icon-button" type="button" data-attempt-page="1" ${page>=pages-1?'disabled':''}>›</button></nav>`;
  }

  function renderHost(host) {
    const pages = Math.max(1, Math.ceil(cache.length / pageSize));
    page = Math.min(page, pages - 1);
    const start = page * pageSize;
    const items = cache.slice(start, start + pageSize);
    const nav = pagination(cache.length);
    host.innerHTML = `<section class="exam-attempt-archives-extension"><div class="row"><div><p class="eyebrow">Copies d’examen</p><h2>Copies d’examen archivées</h2></div><span class="tag">${cache.length} copie(s)</span></div><p class="muted">Ces copies ont été retirées des résultats actifs. Vous pouvez les restaurer ou les supprimer définitivement.</p>${nav}<div class="card table-wrap"><table><thead><tr><th>Apprenant</th><th>Examen</th><th>Groupe</th><th>Note</th><th>Archivée le</th><th>Actions</th></tr></thead><tbody>${items.map(item=>`<tr><td><b>${esc(item.first_name)} ${esc(item.last_name)}</b><small>${esc(item.participant_code||'')}</small></td><td>${esc(item.exam_title)}</td><td>${esc(item.group_name)}</td><td>${formatScore(item.score_percent)}</td><td>${formatDate(item.archived_at)}</td><td><div class="row-actions"><button class="icon-button" type="button" data-attempt-restore="${item.id}" title="Restaurer" aria-label="Restaurer">↩️</button><button class="icon-button danger" type="button" data-attempt-delete="${item.id}" title="Supprimer définitivement" aria-label="Supprimer définitivement">🗑️</button></div></td></tr>`).join('')||'<tr><td colspan="6">Aucune copie d’examen archivée.</td></tr>'}</tbody></table></div>${nav}</section>`;
  }

  async function load(host) {
    if (loading) return;
    loading = true;
    host.innerHTML = '<div class="card empty">Chargement des copies archivées…</div>';
    try {
      const payload = await request('/api/quality/archived-final-exam-attempts');
      cache = payload?.attempts || [];
      renderHost(host);
    } catch (error) {
      host.innerHTML = `<div class="notice">${esc(error.message)}</div>`;
    } finally {
      loading = false;
    }
  }

  function ensure() {
    const panel = document.querySelector('#archives');
    if (!panel) return;
    let host = panel.querySelector('#examAttemptArchivesExtension');
    if (host) return;
    host = document.createElement('div');
    host.id = 'examAttemptArchivesExtension';
    host.style.marginTop = '24px';
    panel.appendChild(host);
    load(host);
  }

  async function refresh() {
    const host = document.querySelector('#examAttemptArchivesExtension');
    if (!host) return ensure();
    await load(host);
  }

  document.addEventListener('click', async event => {
    const pageButton = event.target.closest('[data-attempt-page]');
    if (pageButton) {
      page = Math.max(0, page + Number(pageButton.dataset.attemptPage || 0));
      const host = document.querySelector('#examAttemptArchivesExtension');
      if (host) renderHost(host);
      return;
    }

    const restoreButton = event.target.closest('[data-attempt-restore]');
    if (restoreButton) {
      if (!confirm('Restaurer cette copie dans les résultats actifs ?')) return;
      try {
        await request(`/api/quality/final-exam-attempts/${encodeURIComponent(restoreButton.dataset.attemptRestore)}/restore`, { method:'POST', body:'{}' });
        await refresh();
      } catch (error) { alert(error.message); }
      return;
    }

    const deleteButton = event.target.closest('[data-attempt-delete]');
    if (deleteButton) {
      if (!confirm('Supprimer définitivement cette copie et toutes ses réponses ? Cette action est irréversible.')) return;
      try {
        await request(`/api/quality/final-exam-attempts/${encodeURIComponent(deleteButton.dataset.attemptDelete)}`, { method:'DELETE' });
        await refresh();
      } catch (error) { alert(error.message); }
    }
  });

  const observer = new MutationObserver(() => ensure());
  observer.observe(document.documentElement, { childList:true, subtree:true });
  ensure();
})();
