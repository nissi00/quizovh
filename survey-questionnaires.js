// Shared by the survey pages and their server validation. Existing trainee keys stay stable.
const satisfaction = ['Très satisfait', 'Satisfait', 'Peu satisfait', 'Insatisfait'];
const achievement = ['Oui, tout à fait', 'En grande partie', 'Partiellement', 'Pas du tout'];
const choice = (id, section, label, options = satisfaction, extra = {}) => ({ id, section, label, type:'choice', options, required:true, ...extra });
const text = (id, section, label, extra = {}) => ({ id, section, label, type:'text', required:false, maxLength:2000, ...extra });
const field = (id, label, type = 'text', extra = {}) => ({ id, label, type, required:true, maxLength:300, ...extra });
const rating = (label, section) => ({ id:'recommendation', section, label, note:'0 = Très peu probable / 10 = Très probable', type:'rating', options:[1,2,3,4,5,6,7,8,9,10], required:true });
const period = [field('period_start', 'Début de la période évaluée', 'date'), field('period_end', 'Fin de la période évaluée', 'date')];

export const surveyQuestionnaires = {
  trainee: {
    type:'trainee', reference:'FOR-FORM-003', title:'Satisfaction des stagiaires', anonymous:true,
    introduction:'Ce questionnaire est à remplir à la fin du dernier jour de formation. Les réponses sont enregistrées de manière anonyme.',
    fields:[],
    questions:[
      choice('organization_information', '1. Organisation et logistique', 'Information préalable (programme, convocation, accès)'),
      choice('organization_schedule', '1. Organisation et logistique', 'Respect des horaires et du déroulement de la session'),
      choice('organization_facilities', '1. Organisation et logistique', 'Qualité des locaux, équipements et moyens matériels'),
      choice('content_expectations', '2. Contenu et pédagogie', 'Adéquation du programme avec vos attentes'),
      choice('content_theory', '2. Contenu et pédagogie', 'Clarté des explications théoriques'),
      choice('content_exercises', '2. Contenu et pédagogie', 'Qualité et utilité des exercices'),
      choice('content_materials', '2. Contenu et pédagogie', 'Qualité des supports de cours remis'),
      choice('trainer_mastery', '3. Animation par le formateur', "Maîtrise du sujet par l'intervenant"),
      choice('trainer_availability', '3. Animation par le formateur', 'Disponibilité, écoute et réponse aux questions'),
      choice('trainer_exercises', '3. Animation par le formateur', 'Qualité et utilité des exercices'),
      choice('trainer_dynamics', '3. Animation par le formateur', 'Dynamisme et rythme de la formation'),
      choice('objectives_achieved', '4. Atteinte des objectifs et acquis de la formation', 'Estimé-vous avoir atteint les objectifs de la formation ?', achievement),
      choice('objectives_apply', '4. Atteinte des objectifs et acquis de la formation', 'Allez-vous pouvoir appliquer ces acquis dans votre travail ?', achievement),
      rating('Recommanderiez-vous cette formation à un collègue ou professionnel du secteur ?', '5. Appréciation globale et suggestions'),
      text('strengths', '5. Appréciation globale et suggestions', 'Points forts de la formation :'),
      text('improvements', '5. Appréciation globale et suggestions', "Axes d'amélioration ou remarques complémentaires :")
    ]
  },
  client: {
    type:'client', reference:'FOR-FORM-004', title:'Satisfaction client', anonymous:false,
    introduction:'À remplir par le responsable de formation, le manager ou le service RH. Ce questionnaire recueille le nom du contact et de son entreprise.',
    fields:[field('client_company', 'Entreprise client'), field('contact_name', 'Nom du contact')],
    questions:[
      choice('team_availability', '1. Avant la formation', 'Réactivité et disponibilité de nos équipes lors des échanges.'),
      choice('needs_understood', '1. Avant la formation', 'Compréhension de vos besoins et des enjeux de votre entreprise'),
      choice('proposal_quality', '1. Avant la formation', 'Clarté et pertinence de la proposition commerciale / convention'),
      choice('administrative_deadlines', '1. Avant la formation', 'Respect des délais administratifs (devis, programmes, convocation).'),
      choice('program_objectives', '2. Déroulement et qualité de la prestation', 'Adéquation du programme avec les objectifs visés'),
      choice('trainer_expertise', '2. Déroulement et qualité de la prestation', 'Expertise professionnelle et posture du formateur'),
      choice('logistics', '2. Déroulement et qualité de la prestation', 'Organisation logistique et respect des modalités d’intervention'),
      choice('job_needs', '3. Retombées et impact opérationnel', 'Les compétences visées correspondent-elles aux besoins du poste ?', achievement),
      choice('operational_impact', '3. Retombées et impact opérationnel', 'Constatez-vous un impact positif sur l’activité de vos collaborateurs ?', achievement),
      choice('overall_satisfaction', '4. Appréciation globale et suggestions', 'Quel est votre niveau de satisfaction globale concernant cette prestation ?'),
      // These are the four choices supplied in FOR-FORM-004, including its original wording.
      choice('recommendation', '4. Appréciation globale et suggestions', 'Recommanderiez-vous Tech Systèmes comme organisme de formation ?', ['Oui, tout à fait', 'Oui, probablement', 'Peu satisfait', 'Insatisfait']),
      text('comments', '4. Appréciation globale et suggestions', 'Remarques, points forts ou axes d’amélioration de la formation :'),
      text('future_needs', '4. Appréciation globale et suggestions', 'Avez-vous d’autres besoins en formation à venir pour vos équipes ?')
    ]
  },
  follow_up: {
    type:'follow_up', reference:'FOR-FORM-012', title:'Suivi après formation à 3 à 6 mois', anonymous:false, staffOnly:true,
    introduction:'Ce questionnaire est complété par la personne chargée du suivi lors d’un entretien téléphonique avec le stagiaire, réalisé 3 à 6 mois après la formation. Poser les questions au stagiaire, cocher les réponses correspondantes et noter ses commentaires.',
    fields:[field('interview_date', 'Date de l’entretien', 'date'), field('learner_name', 'Nom et prénom du stagiaire'), field('company', 'Entreprise'), field('interviewer_name', 'Nom de la personne réalisant l’entretien')],
    questions:[
      choice('application_frequency', 'Suivi à 3 à 6 mois', '1. Avez-vous utilisé ce que vous avez appris pendant la formation ?', ['Régulièrement', 'Occasionnellement', 'Pas encore']),
      text('application_comments', 'Suivi à 3 à 6 mois', 'Commentaires sur la mise en pratique'),
      text('application_example', 'Suivi à 3 à 6 mois', '2. Si oui, donnez un exemple de mise en pratique.', { visibleWhen:{ id:'application_frequency', not:'Pas encore' } }),
      choice('usefulness', 'Suivi à 3 à 6 mois', '3. La formation vous est-elle utile dans votre travail ?', ['Oui', 'En partie', 'Non', 'Pas encore assez de recul']),
      text('usefulness_comments', 'Suivi à 3 à 6 mois', 'Commentaires sur l’utilité de la formation'),
      choice('autonomy', 'Suivi à 3 à 6 mois', '4. Vous sentez-vous plus autonome pour réaliser les tâches abordées ?', ['Oui', 'En partie', 'Non', 'Pas encore de mise en pratique']),
      text('autonomy_comments', 'Suivi à 3 à 6 mois', 'Commentaires sur l’autonomie'),
      { ...choice('barriers', 'Suivi à 3 à 6 mois', '5. Qu’est-ce qui freine la mise en pratique ?', ['Aucune difficulté', 'Manque de pratique', 'Manque de moyens', 'Certains points restent à clarifier', 'Autre']), type:'multiple', exclusive:'Aucune difficulté', otherKey:'barriers_other' },
      { ...choice('additional_needs', 'Suivi à 3 à 6 mois', '6. Avez-vous besoin d’un complément ?', ['Non', 'Rappel des notions', 'Exercices pratiques', 'Échange avec le formateur', 'Autre']), type:'multiple', exclusive:'Non', otherKey:'additional_needs_other' },
      text('improvements', 'Suivi à 3 à 6 mois', '7. Quels points souhaitez-vous revoir ou améliorer dans la formation ?')
    ]
  },
  trainer: {
    type:'trainer', reference:'FOR-FORM-013', title:'Satisfaction des formateurs', anonymous:true,
    introduction:'À remplir par le formateur, une fois par an. Indiquez la période évaluée et votre statut. Aucun nom n’est demandé.',
    fields:[...period, field('employment_status', 'Statut', 'choice', { options:['Salarié', 'Sous-traitant'] })],
    questions:[
      choice('prior_information', '1. Préparation des interventions', 'Clarté des informations transmises avant la session (programme, public)'),
      choice('specific_needs', '1. Préparation des interventions', 'Information sur les besoins spécifiques des stagiaires (dont situation de handicap)'),
      choice('planning', '1. Préparation des interventions', 'Délais de planification et de confirmation des sessions'),
      choice('facilities', '2. Conditions d’intervention', 'Qualité des locaux et des équipements'),
      choice('materials', '2. Conditions d’intervention', 'Disponibilité du matériel pédagogique et informatique'),
      choice('application', '2. Conditions d’intervention', 'Fonctionnement de l’application « TS Formation »'),
      choice('team_availability', '3. Relation avec Tech Systèmes', 'Réactivité et disponibilité de l’équipe'),
      choice('feedback', '3. Relation avec Tech Systèmes', 'Prise en compte de vos remarques et suggestions'),
      choice('professional_development', '3. Relation avec Tech Systèmes', 'Accès aux actions de développement de vos compétences (formation, veille)'),
      choice('teaching_resources', '4. Moyens et retours pédagogiques', 'Disposez-vous des moyens nécessaires pour atteindre les objectifs pédagogiques ?', achievement),
      choice('results_shared', '4. Moyens et retours pédagogiques', 'Les résultats des évaluations et de la satisfaction des stagiaires vous sont-ils communiqués ?', achievement),
      rating('Recommanderiez-vous Tech Systèmes à un confrère formateur ?', '5. Appréciation globale et suggestions'),
      text('strengths', '5. Appréciation globale et suggestions', 'Points forts de la collaboration avec Tech Systèmes :'),
      text('improvements', '5. Appréciation globale et suggestions', 'Axes d’amélioration, besoins (outils, formation, accompagnement) ou remarques :')
    ]
  },
  opco: {
    type:'opco', reference:'FOR-FORM-015', title:'Satisfaction OPCO', anonymous:false,
    introduction:'À remplir par le conseiller ou le gestionnaire de l’OPCO, une fois par an. Ce questionnaire recueille les coordonnées du contact et la période concernée.',
    fields:[field('opco_name', 'OPCO'), field('contact_name', 'Nom et fonction du contact'), field('funded_training', 'Entreprise(s) et formation(s) financée(s)', 'text', { maxLength:2000 }), ...period],
    questions:[
      choice('team_availability', '1. Gestion administrative des dossiers', 'Réactivité et disponibilité de nos équipes lors des échanges'),
      choice('funding_documents', '1. Gestion administrative des dossiers', 'Qualité et complétude des dossiers de demande de prise en charge (programme, devis, convention)'),
      choice('deadlines', '1. Gestion administrative des dossiers', 'Respect des délais de transmission des pièces demandées'),
      choice('invoicing', '1. Gestion administrative des dossiers', 'Clarté et conformité de la facturation'),
      choice('program_compliance', '2. Conformité de la prestation', 'Conformité de la formation réalisée au programme financé (durée, contenu, modalités)'),
      choice('completion_documents', '2. Conformité de la prestation', 'Qualité des justificatifs de réalisation (émargements, certificats de réalisation, attestations)'),
      choice('session_changes', '2. Conformité de la prestation', 'Information transmise en cas d’absence, d’abandon ou de modification d’une session'),
      choice('skill_needs', '3. Résultats et pertinence', 'Les formations financées répondent-elles aux besoins en compétences des entreprises de votre branche ?', achievement),
      choice('results_usefulness', '3. Résultats et pertinence', 'Les résultats transmis par Tech Systèmes (satisfaction, réalisation, évaluations) vous sont-ils utiles ?', achievement),
      choice('overall_satisfaction', '4. Appréciation globale et suggestions', 'Quel est votre niveau de satisfaction globale concernant votre collaboration avec Tech Systèmes ?'),
      choice('continued_funding', '4. Appréciation globale et suggestions', 'Envisagez-vous de continuer à financer des formations réalisées par Tech Systèmes ?', ['Oui, tout à fait', 'Oui, probablement', 'Probablement pas', 'Non']),
      text('comments', '4. Appréciation globale et suggestions', 'Remarques, points forts ou axes d’amélioration :'),
      text('expectations', '4. Appréciation globale et suggestions', 'Avez-vous des attentes ou des exigences particulières pour nos prochains dossiers ?')
    ]
  }
};

export function getSurveyQuestionnaire(type = 'trainee') {
  return typeof type === 'string' && Object.hasOwn(surveyQuestionnaires, type) ? surveyQuestionnaires[type] : null;
}

export function surveyQuestionVisible(question, answers) {
  return !question.visibleWhen || answers[question.visibleWhen.id] !== question.visibleWhen.not;
}

export function surveyAnswerColumns(questionnaire) {
  return [...questionnaire.fields, ...questionnaire.questions].flatMap(item => [item, ...(item.otherKey ? [{ id:item.otherKey, label:`${item.label} — Autre (précisions)` }] : [])]);
}
