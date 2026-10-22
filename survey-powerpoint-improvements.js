function addSurveyLink() {
  const box = document.querySelector('.survey-projection-qr');
  const image = box?.querySelector('img');
  if (!image) return;
  const source = new URL(image.getAttribute('src') || '', location.origin);
  if (source.pathname !== '/api/presentation/survey-qr') return;
  const code = (source.searchParams.get('code') || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(code)) return;
  const url = `${location.origin}/survey.html?survey=${encodeURIComponent(code)}`;
  let link = box.querySelector('.survey-qr-direct-link');
  if (!link) {
    link = document.createElement('a');
    link.className = 'survey-qr-direct-link';
    link.target = '_blank';
    link.rel = 'noopener';
    image.after(link);
  }
  if (link.href !== url) link.href = url;
  if (link.textContent !== url) link.textContent = url;
}

addSurveyLink();
const surveyLinkTimer = setInterval(addSurveyLink, 1500);
window.addEventListener('beforeunload', () => clearInterval(surveyLinkTimer));
