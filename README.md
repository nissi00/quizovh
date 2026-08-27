# Quiz Tech Systèmes — OVHcloud

Application de quiz interactif destinée aux formateurs et aux apprenants.

Cette version fonctionne sans Supabase et sans Vercel. L’interface, l’API,
PostgreSQL et les QR codes sont hébergés sur le VPS OVHcloud.

## Architecture

- Caddy : HTTP/HTTPS et certificat automatique lorsque le domaine est configuré ;
- Node.js : interface web et API sécurisée ;
- PostgreSQL : utilisateurs, questions, sessions, réponses et scores ;
- Docker Compose : lancement et mise à jour de l’ensemble.

PostgreSQL n’est pas publié sur Internet. Seuls les ports 80 et 443 du serveur
web sont exposés.

## Premier déploiement sur le VPS

Le projet doit être copié dans `/opt/quiz-app`, puis installé avec :

```bash
cd /opt/quiz-app
sudo bash deploy.sh
```

Le script crée des secrets aléatoires, démarre les conteneurs et affiche :

- l’adresse de l’application ;
- l’adresse de la page d’installation ;
- le jeton permettant de créer le premier compte administrateur.

Pour un déploiement de production, renseignez un domaine pointant vers le VPS.
Caddy demandera automatiquement un certificat HTTPS.

## Sauvegarder PostgreSQL

```bash
sudo bash ops/backup.sh
```

La sauvegarde locale est conservée dans `backups/`. Une copie doit ensuite être
envoyée vers un stockage distinct du VPS.

## Vérifier l’état

```bash
sudo docker compose ps
sudo docker compose logs --tail=100 api
```

La page `/health.html` vérifie également que l’application et PostgreSQL
répondent correctement.

## Mise à jour

Après le transfert d’une nouvelle version du code :

```bash
cd /opt/quiz-app
sudo docker compose up -d --build
```

Le volume PostgreSQL est conservé pendant la reconstruction de l’application.
Ne lancez pas `docker compose down -v`, car l’option `-v` supprimerait la base.

## Déploiement automatique depuis GitHub

Le workflow `.github/workflows/deploy-ovh.yml` met à jour le VPS après chaque
publication sur la branche `main`. Il reste inactif tant que la variable GitHub
`OVH_DEPLOY_ENABLED` ne vaut pas `true`.

Il utilise une clé SSH dédiée et quatre secrets GitHub : `OVH_HOST`, `OVH_USER`,
`OVH_SSH_PRIVATE_KEY` et `OVH_KNOWN_HOSTS`. Le fichier `.env`, les sauvegardes
PostgreSQL et les journaux sont exclus du dépôt.
