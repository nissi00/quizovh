const dateValue = value => {
  const timestamp = value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY;
};

export function normalizeParticipantName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('fr-FR');
}

export function participantIdentityKey(participant) {
  return `${normalizeParticipantName(participant?.first_name)}\u0000${normalizeParticipantName(participant?.last_name)}`;
}

export function matchingParticipantProfiles(participants = [], identity = {}) {
  const identityKey = participantIdentityKey(identity);
  return participants.filter(participant => participantIdentityKey(participant) === identityKey);
}

function canonicalOrder(left, right) {
  const leftDate = dateValue(left.created_at || left.joined_at);
  const rightDate = dateValue(right.created_at || right.joined_at);
  if (leftDate !== rightDate) return leftDate - rightDate;
  return String(left.id || left.user_id || '').localeCompare(String(right.id || right.user_id || ''));
}

export function consolidateParticipants(participants = []) {
  const byIdentity = new Map();
  for (const participant of participants) {
    const key = participantIdentityKey(participant);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(participant);
  }
  return [...byIdentity.values()].map(profiles => {
    const ordered = [...profiles].sort(canonicalOrder);
    const canonical = ordered[0];
    return {
      ...canonical,
      profile_ids: ordered.map(profile => profile.id || profile.user_id).filter(Boolean),
      profiles: ordered
    };
  }).sort((left, right) => {
    const byLastName = normalizeParticipantName(left.last_name).localeCompare(normalizeParticipantName(right.last_name), 'fr');
    return byLastName || normalizeParticipantName(left.first_name).localeCompare(normalizeParticipantName(right.first_name), 'fr');
  });
}

export function latestRecord(records = [], dateFields = ['submitted_at', 'created_at', 'started_at', 'joined_at']) {
  const recordDate = record => {
    for (const field of dateFields) {
      const timestamp = record?.[field] ? new Date(record[field]).getTime() : Number.NaN;
      if (Number.isFinite(timestamp)) return timestamp;
    }
    return Number.NEGATIVE_INFINITY;
  };
  return [...records].sort((left, right) => {
    return recordDate(right) - recordDate(left);
  })[0] || null;
}

export function groupPerformedQuizIds(attempts = [], overrides = []) {
  const quizIds = new Set(attempts.map(attempt => attempt?.quiz_id).filter(Boolean));
  for (const override of overrides) {
    const match = /^quiz:(.+)$/.exec(String(override?.evaluation_key || ''));
    if (match?.[1]) quizIds.add(match[1]);
  }
  return quizIds;
}

export function groupQuizAverage(quizScores = [], performedQuizIds = new Set()) {
  const quizIds = performedQuizIds instanceof Set ? performedQuizIds : new Set(performedQuizIds);
  const includedScores = quizScores.filter(quiz => quizIds.has(quiz.quiz_id));
  if (!includedScores.length) return 0;
  return Math.round(includedScores.reduce((sum, quiz) => sum + Number(quiz.score || 0), 0) * 100 / includedScores.length) / 100;
}

export function identityComponents(participants = [], groupIdsFor = participant => participant.group_ids || []) {
  const byIdentity = new Map();
  participants.forEach(participant => {
    const key = participantIdentityKey(participant);
    if (!byIdentity.has(key)) byIdentity.set(key, []);
    byIdentity.get(key).push(participant);
  });
  const result = [];
  for (const sameName of byIdentity.values()) {
    const components = [];
    for (const participant of sameName) {
      const groups = new Set(groupIdsFor(participant).filter(Boolean));
      const touching = components.filter(component => groups.size && [...component.groups].some(group => groups.has(group)));
      if (!touching.length) {
        components.push({ participants:[participant], groups });
        continue;
      }
      const target = touching[0];
      target.participants.push(participant);
      groups.forEach(group => target.groups.add(group));
      for (const extra of touching.slice(1)) {
        target.participants.push(...extra.participants);
        extra.groups.forEach(group => target.groups.add(group));
        components.splice(components.indexOf(extra), 1);
      }
    }
    for (const component of components) result.push(consolidateParticipants(component.participants)[0]);
  }
  return result.sort((left, right) => {
    const byLastName = normalizeParticipantName(left.last_name).localeCompare(normalizeParticipantName(right.last_name), 'fr');
    return byLastName || normalizeParticipantName(left.first_name).localeCompare(normalizeParticipantName(right.first_name), 'fr');
  });
}
