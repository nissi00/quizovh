// Reuse the consolidated result shown in the table, including its existing
// rounding, and apply the same bonus and cap as the table's bonus column.
export function certificateScoreSnapshot(results, learner, bonusPoints = 0) {
  const baseGlobalScore = Number(learner.global_score || 0);
  const bonus = Number(bonusPoints || 0);
  const globalScore = Math.min(100, Math.round((baseGlobalScore + bonus) * 100) / 100);
  return {
    canonical_user_id: learner.id,
    profile_ids: learner.profile_ids,
    policy: results.policy,
    quiz_score: learner.quiz_score,
    quiz_scores: learner.quiz_scores,
    performed_quiz_count: results.performed_quiz_count,
    exam_score: learner.exam_score,
    practice_score: learner.practice_score,
    experience_exam_score: learner.experience_exam_score,
    experience_exam_submitted: learner.experience_exam_submitted,
    experience_score: learner.experience_score,
    base_global_score: baseGlobalScore,
    bonus_points: bonus,
    global_score: globalScore,
    eligible: globalScore >= Number(results.group.passing_score)
  };
}
