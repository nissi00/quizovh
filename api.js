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
    throw new Error(payload?.message || `Erreur du serveur (${response.status}).`);
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
    case 'live_learner_state':
      return request(`/learner/state?code=${encodeURIComponent(params.p_code)}`);
    case 'submit_live_answers':
      return request('/learner/answers', {
        method: 'POST',
        body: JSON.stringify({ code: params.p_code, option_ids: params.p_option_ids })
      });
    default:
      throw new Error(`Opération inconnue : ${name}`);
  }
}
