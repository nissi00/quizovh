# TS Quiz dans PowerPoint — prototype

Ce prototype ajoute un complément de contenu PowerPoint. La diapositive affiche uniquement les informations collectives : QR code, question, chronomètre, progression globale, sondage anonyme et correction.

Le panneau instructeur reste dans `instructor.html`. Aucun nom d’apprenant et aucune réponse individuelle ne sont transmis à PowerPoint.

## Fichiers

- `office-manifest.xml` : manifeste à charger dans Microsoft 365.
- `powerpoint.html`, `powerpoint.js`, `powerpoint.css` : affichage collectif intégré à la diapositive.
- `GET /api/quality/presentation/stream?code=...` : flux SSE public collectif, sans données personnelles.
- `GET /api/presentation/state?code=...` : lecture ponctuelle utilisée pour la validation et le repli en cas d’indisponibilité du SSE.

## Diapositives indépendantes

Chaque complément possède sa propre association de quiz. Une diapo non associée reste sur l’accueil et n’ouvre aucun flux. Une diapo associée reçoit uniquement l’état du code qui lui a été attribué. Deux diapositives n’affichent donc la même chose que si le même code leur est volontairement attribué.

Le serveur conserve une seule lecture d’état par code et diffuse les changements aux connexions SSE concernées. La fermeture automatique des questions expirées est exécutée côté serveur et ne dépend plus des requêtes répétées de PowerPoint.

## Test après déploiement du prototype

1. Vérifier `https://serveur-quizz.tech-systemes.fr/powerpoint.html`.
2. Charger `office-manifest.xml` comme complément personnalisé.
3. Insérer **TS Quiz · Affichage en direct** dans une diapositive.
4. Saisir sur cette diapo le code de la session qu’elle doit afficher.
5. Lancer le diaporama et piloter la session depuis l’espace instructeur privé.
6. Vérifier qu’une autre diapo non associée reste sur la page d’accueil.
