const timerTargets = ['timer', 'examTimer'];

function pinnedTimer(id) {
  return [...document.querySelectorAll(`#${id}[data-timer-pinned="true"]`)];
}

function placeholderFor(id) {
  return document.querySelector(`[data-timer-pin-placeholder="${id}"]`);
}

function pinTimer(id) {
  const freshTimer = [...document.querySelectorAll(`#${id}:not([data-timer-pinned="true"])`)]
    .find(node => node.closest('#app, #examApp'));

  if (freshTimer) {
    pinnedTimer(id).forEach(node => node.remove());

    const placeholder = document.createElement('span');
    placeholder.className = 'timer-pin-placeholder';
    placeholder.dataset.timerPinPlaceholder = id;
    placeholder.setAttribute('aria-hidden', 'true');
    freshTimer.before(placeholder);

    freshTimer.dataset.timerPinned = 'true';
    freshTimer.classList.add('timer-pin-floating');
    document.body.appendChild(freshTimer);
  }

  if (!placeholderFor(id)) {
    pinnedTimer(id).forEach(node => node.remove());
  }
}

function syncPinnedTimers() {
  timerTargets.forEach(pinTimer);
}

const observer = new MutationObserver(syncPinnedTimers);
observer.observe(document.documentElement, { childList: true, subtree: true });
syncPinnedTimers();
