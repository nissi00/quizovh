(() => {
  const pageSize = 5;
  let page = 0;
  let currentMap = null;

  function refreshCarousel() {
    const map = document.querySelector('#examQuestionMap');
    if (!map) {
      currentMap = null;
      page = 0;
      return;
    }

    if (map !== currentMap) {
      currentMap = map;
      page = 0;

      const questionButtons = [...map.querySelectorAll('.question-jump')];
      const heading = document.createElement('div');
      heading.className = 'exam-missing-heading';
      heading.textContent = 'Questions à vérifier';

      const controls = document.createElement('div');
      controls.className = 'exam-missing-controls';

      const previous = document.createElement('button');
      previous.type = 'button';
      previous.className = 'icon-button exam-missing-arrow exam-missing-prev';
      previous.setAttribute('aria-label', 'Questions précédentes');
      previous.textContent = '‹';

      const track = document.createElement('div');
      track.className = 'exam-missing-track';
      questionButtons.forEach(button => track.appendChild(button));

      const next = document.createElement('button');
      next.type = 'button';
      next.className = 'icon-button exam-missing-arrow exam-missing-next';
      next.setAttribute('aria-label', 'Questions suivantes');
      next.textContent = '›';

      previous.addEventListener('click', () => {
        page = Math.max(0, page - 1);
        refreshCarousel();
      });
      next.addEventListener('click', () => {
        page += 1;
        refreshCarousel();
      });

      controls.append(previous, track, next);
      map.replaceChildren(heading, controls);
      map.classList.add('exam-missing-carousel');
    }

    const track = map.querySelector('.exam-missing-track');
    const previous = map.querySelector('.exam-missing-prev');
    const next = map.querySelector('.exam-missing-next');
    if (!track || !previous || !next) return;

    const allButtons = [...track.querySelectorAll('.question-jump')];
    const missingButtons = allButtons.filter(button => button.classList.contains('unanswered'));
    if (!missingButtons.length) {
      map.style.display = 'none';
      page = 0;
      return;
    }
    map.style.display = '';

    const pageCount = Math.max(1, Math.ceil(missingButtons.length / pageSize));
    page = Math.min(page, pageCount - 1);
    const start = page * pageSize;
    const visible = new Set(missingButtons.slice(start, start + pageSize));

    allButtons.forEach(button => {
      button.style.display = visible.has(button) ? 'inline-flex' : 'none';
    });

    const hasMultiplePages = missingButtons.length > pageSize;
    previous.hidden = !hasMultiplePages;
    next.hidden = !hasMultiplePages;
    previous.disabled = page === 0;
    next.disabled = page >= pageCount - 1;
  }

  function scheduleRefresh() {
    queueMicrotask(refreshCarousel);
  }

  function install() {
    const app = document.querySelector('#examApp');
    if (!app) return;
    new MutationObserver(scheduleRefresh).observe(app, { childList: true });
    document.addEventListener('change', event => {
      if (event.target?.matches('.exam-question input')) scheduleRefresh();
    });
    refreshCarousel();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once: true });
  else install();
})();
