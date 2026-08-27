INSERT INTO themes (id,name,description,position) VALUES
 ('00000000-0000-0000-0000-000000000001','Essais des filtres THE/HEPA','Fondamentaux et pratiques de contrôle.',1)
ON CONFLICT DO NOTHING;

INSERT INTO chapters (id,theme_id,title,description,position) VALUES
 ('00000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','1. Principes des filtres THE','Comprendre le rôle et les points de contrôle.',1),
 ('00000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001','2. Essais d''intégrité','Préparer et interpréter un test à l’aérosol.',2),
 ('00000000-0000-0000-0000-000000000013','00000000-0000-0000-0000-000000000001','3. Traçabilité et maintenance','Sécuriser le suivi des opérations.',3)
ON CONFLICT DO NOTHING;

INSERT INTO quizzes (id,chapter_id,title,instructions) VALUES
 ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-000000000011','Quiz — Principes THE','Questions à choix unique ou multiple.'),
 ('00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-000000000012','Quiz — Essais d''intégrité','Questions à choix unique ou multiple.'),
 ('00000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-000000000013','Quiz — Traçabilité','Questions à choix unique ou multiple.')
ON CONFLICT DO NOTHING;

INSERT INTO questions (id,quiz_id,body,difficulty,subtopic,duration_seconds,explanation,position) VALUES
 ('00000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000021','Quel est l’objectif principal d’un filtre THE/HEPA ?',1,'Fonction du filtre',30,'Un filtre THE/HEPA retient les particules afin de limiter la contamination.',1),
 ('00000000-0000-0000-0000-000000000032','00000000-0000-0000-0000-000000000022','Pourquoi réalise-t-on un essai d’intégrité après installation ?',2,'Étanchéité',35,'L’essai permet de rechercher une fuite du média ou du montage.',1),
 ('00000000-0000-0000-0000-000000000033','00000000-0000-0000-0000-000000000023','Quel élément assure la traçabilité d’un essai ?',1,'Documentation',25,'Le rapport d’essai consigne les conditions, mesures et résultats.',1)
ON CONFLICT DO NOTHING;

INSERT INTO answer_options(question_id,label,body,is_correct) VALUES
 ('00000000-0000-0000-0000-000000000031','A','Réduire le bruit de l’installation',false),
 ('00000000-0000-0000-0000-000000000031','B','Retenir les particules ciblées',true),
 ('00000000-0000-0000-0000-000000000031','C','Augmenter le débit d’air',false),
 ('00000000-0000-0000-0000-000000000031','D','Refroidir le local',false),
 ('00000000-0000-0000-0000-000000000032','A','Vérifier la couleur du cadre',false),
 ('00000000-0000-0000-0000-000000000032','B','Détecter les fuites du média ou du montage',true),
 ('00000000-0000-0000-0000-000000000032','C','Mesurer uniquement la température',false),
 ('00000000-0000-0000-0000-000000000032','D','Nettoyer le caisson',false),
 ('00000000-0000-0000-0000-000000000033','A','Un rapport d’essai daté',true),
 ('00000000-0000-0000-0000-000000000033','B','Une photo sans commentaire',false),
 ('00000000-0000-0000-0000-000000000033','C','Un échange oral non consigné',false),
 ('00000000-0000-0000-0000-000000000033','D','Le planning du mois suivant',false)
ON CONFLICT DO NOTHING;

INSERT INTO grading_policies(name,passing_score,max_attempts)
SELECT 'Barème THE/HEPA v1',70,2
WHERE NOT EXISTS (SELECT 1 FROM grading_policies WHERE name='Barème THE/HEPA v1');
