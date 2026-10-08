const numeric = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// Les deux champs historiques « expérience » restent intacts. Cette normalisation
// permet aux groupes existants de conserver exactement le même score global :
// leur poids expérience est réparti à 50/50 entre la pratique et l'examen.
export function normalizeTrainingGroupGrading(row = null, groupId = null) {
  const source = row || {};
  const legacyExperienceIncluded = Boolean(source.include_experience);
  const legacyExperienceWeight = numeric(source.experience_weight);
  const legacyPracticeWeight = legacyExperienceIncluded ? Math.round(legacyExperienceWeight * 50) / 100 : 0;
  const legacyExperienceExamWeight = legacyExperienceIncluded ? legacyExperienceWeight - legacyPracticeWeight : 0;
  return {
    ...source,
    group_id: source.group_id ?? groupId,
    include_quizzes: source.include_quizzes ?? true,
    quiz_weight: numeric(source.quiz_weight, 100),
    include_exam: source.include_exam ?? false,
    exam_weight: numeric(source.exam_weight),
    include_practice: source.include_practice ?? legacyExperienceIncluded,
    practice_weight: numeric(source.practice_weight, legacyPracticeWeight),
    include_experience_exam: source.include_experience_exam ?? legacyExperienceIncluded,
    experience_exam_weight: numeric(source.experience_exam_weight, legacyExperienceExamWeight)
  };
}

export function weightedGlobalScore(policy, { quizScore = 0, practiceScore = 0, experienceExamScore = 0, examScore = 0 } = {}) {
  const value =
    (policy.include_quizzes ? numeric(quizScore) * numeric(policy.quiz_weight) : 0) +
    (policy.include_practice ? numeric(practiceScore) * numeric(policy.practice_weight) : 0) +
    (policy.include_experience_exam ? numeric(experienceExamScore) * numeric(policy.experience_exam_weight) : 0) +
    (policy.include_exam ? numeric(examScore) * numeric(policy.exam_weight) : 0);
  return Math.round(value) / 100;
}
