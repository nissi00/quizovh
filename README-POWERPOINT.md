# TS Quiz dans PowerPoint — prototype

Ce prototype ajoute un complément de contenu PowerPoint. La diapositive affiche uniquement les informations collectives : QR code, question, chronomètre, progression globale, sondage anonyme et correction.

Le panneau instructeur reste dans `instructor.html`. Aucun nom d’apprenant et aucune réponse individuelle ne sont transmis à PowerPoint.

## Fichiers

- `office-manifest.xml` : manifeste à charger dans Microsoft 365.
- `powerpoint.html`, `powerpoint.js`, `powerpoint.css` : affichage collectif intégré à la diapositive.
- `GET /api/presentation/state?code=...` : état public collectif, sans données personnelles.

## Test après déploiement du prototype

1. Vérifier `https://serveur-quizz.tech-systemes.fr/powerpoint.html`.
2. Charger `office-manifest.xml` comme complément personnalisé.
3. Insérer **TS Quiz · Affichage en direct** dans une diapositive.
4. Saisir le code d’une session créée par l’instructeur.
5. Lancer le diaporama et piloter la session depuis l’espace instructeur privé.
