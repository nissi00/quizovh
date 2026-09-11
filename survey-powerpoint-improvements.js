const surveyQueryCode = (new URLSearchParams(location.search).get('survey') || '').trim().toUpperCase();
const surveySettingKey = 'tsSatisfactionSurveyCode';

function surveyCode() {
  if (/^[A-Z0-9]{8}$/.test(surveyQueryCode)) return surveyQueryCode;
  try {
    return String(window.Office?.context?.document?.settings?.get?.(surveySettingKey) || localStorage.getItem(surveySettingKey) || '').trim().toUpperCase();
  } catch {
    return String(localStorage.getItem(surveySettingKey) || '').trim().toUpperCase();
  }
}

function addSurveyLink() {
  const code = surveyCode();
  const box = document.querySelector('.survey-projection-qr');
  if (!box || !/^[A-Z0-9]{8}$/.test(code)) return;
  const url = `${location.origin}/survey.html?survey=${encodeURIComponent(code)}`;
  let link = box.querySelector('.survey-qr-direct-link');
  if (!link) {
    link = document.createElement('a');
    link.className = 'survey-qr-direct-link';
    link.target = '_blank';
    link.rel = 'noopener';
    box.appendChild(link);
  }
  if (link.href !== url) link.href = url;
  if (link.textContent !== url) link.textContent = url;
}

addSurveyLink();
const surveyLinkTimer = setInterval(addSurveyLink, 1500);
window.addEventListener('beforeunload', () => clearInterval(surveyLinkTimer));
