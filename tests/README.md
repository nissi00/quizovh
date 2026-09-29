# Tests de synchronisation du quiz en direct

La commande `npm run test:live` crée un environnement temporaire distinct de la production :

- une base PostgreSQL éphémère ;
- une API construite depuis le code courant ;
- quatre navigateurs apprenants isolés ;
- une page du complément PowerPoint exécutée dans Chromium.

Les scénarios vérifient le compteur de réponses, l’affichage automatique du sondage quand tout le monde a répondu, l’expiration du chrono avec une réponse manquante et la possibilité de réessayer après une panne réseau.

Prérequis : Docker avec la commande `docker compose`. La base et les conteneurs de test sont supprimés automatiquement à la fin. Aucun accès à la base de production n’est utilisé.

Le test couvre le code web du complément PowerPoint. Un contrôle ponctuel dans PowerPoint reste nécessaire pour valider l’intégration propre à Microsoft Office (chargement du complément et stockage associé à chaque diapo).
