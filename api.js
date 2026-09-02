const sessionKey = 'ts-quiz-staff-session';

export function getSession() {
  try { return JSON.parse(localStorage.getItem(sessionKey) || 'null'); }
  catch { return null; }
}

async function request(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; }
  catch { payload = text; }
  if (!response.ok) {
    if (response.status === 401) localStorage.removeItem(sessionKey);
    const error = new Error(payload?.message || `Erreur du serveur (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export async function signIn(email, password) {
  const payload = await request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password })
  });
  localStorage.setItem(sessionKey, JSON.stringify(payload));
  return payload.user;
}

export async function signOut() {
  try { await request('/auth/logout', { method: 'POST', body: '{}' }); }
  finally { localStorage.removeItem(sessionKey); }
}

export async function signInAnonymously() {
  return true;
}

export async function getInstructorProfile() {
  return request('/instructor/profile');
}

export async function getCatalog() {
  return request('/catalog');
}

export async function createTheme(name) {
  return request('/themes', { method: 'POST', body: JSON.stringify({ name }) });
}

export async function createChapterAndQuiz(themeId, title) {
  return request(`/themes/${encodeURIComponent(themeId)}/chapters`, {
    method: 'POST', body: JSON.stringify({ title })
  });
}

export async function createQuestion(quizId, question) {
  const result = await request(`/quizzes/${encodeURIComponent(quizId)}/questions`, {
    method: 'POST', body: JSON.stringify(question)
  });
  return result.id;
}

export async function updateQuestion(id, payload) {
  await request(`/questions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function deleteQuestionById(id) {
  await request(`/questions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function updateAnswerOption(id, payload) {
  await request(`/options/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function deleteThemeById(id) {
  await request(`/themes/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function deleteChapterById(id) {
  await request(`/chapters/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function createLiveSession(payload) {
  return request('/live-sessions', { method: 'POST', body: JSON.stringify(payload) });
}

export async function getLiveSessions() {
  return request('/live-sessions');
}

export async function getParticipants() {
  return request('/participants');
}

export async function getTrainingGroups() {
  return request('/training-groups');
}

export async function createTrainingGroup(payload) {
  return request('/training-groups', { method: 'POST', body: JSON.stringify(payload) });
}

export async function updateTrainingGroup(id, payload) {
  return request(`/training-groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function getTrainingGroupResults(id) {
  return request(`/training-groups/${encodeURIComponent(id)}/results`);
}

export async function issueCertificate(groupId, userId) {
  return request(`/training-groups/${encodeURIComponent(groupId)}/certificates/${encodeURIComponent(userId)}`, { method: 'POST', body: '{}' });
}

export async function revokeCertificate(id) {
  return request(`/certificates/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: '{}' });
}

export function certificatePdfUrl(id) {
  return `/api/certificates/${encodeURIComponent(id)}.pdf`;
}

export function groupCertificatesPdfUrl(id) {
  return `/api/training-groups/${encodeURIComponent(id)}/certificates.pdf`;
}

export async function regenerateParticipantCode(id) {
  return request(`/participants/${encodeURIComponent(id)}/regenerate-code`, { method: 'POST', body: '{}' });
}

export function participantsExportUrl() {
  return '/api/participants/export.csv';
}

export async function updateLiveSession(id, payload) {
  await request(`/live-sessions/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
}

export async function deleteLiveSession(id) {
  await request(`/live-sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function rpc(name, params = {}) {
  switch (name) {
    case 'approve_live_participant':
      return request(`/live-participants/${encodeURIComponent(params.p_participant_id)}/approve`, { method: 'POST', body: '{}' });
    case 'join_live_by_code':
      return request('/learner/join', {
        method: 'POST',
        body: JSON.stringify({ code: params.p_code, first_name: params.p_first_name, last_name: params.p_last_name })
      });
    case 'join_live_by_participant_code':
      return request('/learner/join-by-code', {
        method: 'POST',
        body: JSON.stringify({ code: params.p_code, participant_code: params.p_participant_code })
      });
    case 'resume_live_by_code':
      return request('/learner/resume', {
        method: 'POST',
        body: JSON.stringify({ code: params.p_code })
      });
    case 'logout_learner':
      return request('/learner/logout', { method: 'POST', body: '{}' });
    case 'live_learner_state':
      return request(`/learner/state?code=${encodeURIComponent(params.p_code)}`);
    case 'submit_live_answers':
      return request('/learner/answers', {
        method: 'POST',
        body: JSON.stringify({ code: params.p_code, option_ids: params.p_option_ids })
      });
    case 'save_live_answer_draft':
      return request('/learner/answers/draft', {
        method: 'PUT',
        body: JSON.stringify({ code: params.p_code, option_ids: params.p_option_ids })
      });
    default:
      throw new Error(`Opération inconnue : ${name}`);
  }
}
