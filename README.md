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
sudo bash ops/backup.sh
sudo bash ops/migrate.sh
sudo docker compose up -d --build
```

La sauvegarde est créée avant toute modification. Le script de migration met à
jour la structure PostgreSQL sans effacer les participants, les réponses ni les
scores. Le volume PostgreSQL est conservé pendant la reconstruction de
l’application.
Ne lancez pas `docker compose down -v`, car l’option `-v` supprimerait la base.

## Identité des apprenants

Lors de sa première participation, chaque apprenant reçoit un code personnel au
format `TS-XXXX`. Ce code permet de retrouver la même identité et la même
progression sur un autre appareil. Les anciens codes au format `TS-XXXX-XXXX`
restent valides. Sur le navigateur déjà utilisé, un cookie de session sécurisé
permet une reconnexion automatique pendant cinq jours.

L’instructeur peut consulter, filtrer et exporter ces identités depuis la
rubrique **Participants**. La régénération d’un code invalide immédiatement
l’ancien code, sans supprimer les résultats enregistrés.

Pendant une question, le dernier choix est enregistré provisoirement. Si le
chrono expire avant l’appui sur le bouton de validation, ce dernier choix est
automatiquement comptabilisé. Sans choix, la question reste sans réponse.

## Évaluations complémentaires

Le classement facultatif reste disponible dans chaque session live. Après la correction,
l’instructeur choisit s’il l’affiche dans PowerPoint. Le classement complet ne
contient que les pseudonymes des apprenants ayant donné leur accord. Sur demande
orale d’un apprenant, l’instructeur peut l’ajouter au classement ou l’en retirer ;
ce changement est inscrit dans le journal centralisé.

La rubrique **Examen final** crée un QCM individuel, chronométré et accessible
par QR code. Chaque question possède son propre nombre de points. Cet examen
n’est jamais projeté dans PowerPoint. Une seule question est affichée par page,
les choix sont enregistrés immédiatement et le compteur indique la progression.
Une page de consignes précède les questions : la tentative et le chronomètre ne
commencent qu’au clic sur **Commencer l’examen**.
PowerPoint peut afficher le QR code de l’examen grâce au bouton placé près de
l’icône de configuration.

Les questions des quiz standards et de l’examen final acceptent de deux à six
propositions. Les chronomètres apprenant et PowerPoint se calent sur l’heure du
serveur ; le lancement d’une question est également daté côté serveur.

La rubrique **Expériences** permet de noter les cas pratiques d’un apprenant et
d’ajouter un commentaire. Dans **Certificats**, l’instructeur choisit librement
les poids des quiz standards, de l’examen final et des expériences. Leur somme
doit être égale à 100 %. Une composante sélectionnée mais non réalisée compte
pour zéro.

La note, le barème et le commentaire d’une expérience restent modifiables à
tout moment. Chaque modification est historisée avec l’auteur et la date. Si la
note change après la délivrance d’un certificat, celui-ci devient non valide et
doit être régénéré. Le nom de l’expérience, son groupe et son apprenant restent
verrouillés afin de préserver l’identité de l’évaluation.

Les informations structurelles d’un groupe sont verrouillées dès qu’il possède
des résultats ; l’entreprise cliente et le lieu restent corrigeables. De même,
les informations d’un examen sont verrouillées dès qu’une première copie a été
commencée.

Le superadministrateur peut téléverser un logo PNG ou JPEG de 2 Mo maximum dans
la rubrique **Certificats**. Ce logo est affiché dans les interfaces et intégré
aux nouveaux certificats. Chaque certificat conserve une référence vers le logo
utilisé lors de sa délivrance, même si le logo global est remplacé ensuite. Les
images sont enregistrées dans PostgreSQL et sont donc incluses dans les
sauvegardes de la base.

## Archivage et pagination

L’archivage est toujours déclenché manuellement par l’instructeur. Il masque
l’élément des listes actives sans effacer les réponses ni modifier les scores
historiques. La rubrique **Archives** est déplacée dans la page de
superadministration : seul le superadministrateur peut consulter, restaurer,
exporter ou supprimer définitivement un élément archivé.

Les questions standards conservent exceptionnellement leur bouton de
suppression directe et disposent aussi d’un bouton d’archivage. Les principaux
tableaux et listes sont paginés par groupes de dix éléments.

## Superadministration, confidentialité et traçabilité

La page `/superadmin.html` est réservée au superadministrateur. Elle permet de
créer, désactiver ou réactiver jusqu’à cinq comptes instructeurs actifs et de
réinitialiser leur mot de passe. La désactivation ou la réinitialisation ferme
les sessions ouvertes du compte concerné.

Le journal centralisé enregistre les opérations de gestion réalisées depuis
l’application avec leur auteur, leur date et leur résultat. Les corps de requête,
les mots de passe, les réponses détaillées et les jetons de session ne sont pas
copiés dans ce journal.

À sa première participation, l’apprenant ouvre et confirme séparément la notice
relative au traitement de ses données et la politique de confidentialité. Chaque
PDF possède sa propre version. Le remplacement d’un document impose une nouvelle
prise de connaissance lors de la participation suivante. La rubrique
**Documents RGPD** de la superadministration permet de publier les PDF, de
consulter l’historique des versions et d’exporter les traces horodatées. Ces
traces sont conservées séparément du journal centralisé. Le contenu des deux
documents doit idéalement être validé par le référent RGPD ou le DPO avant sa
publication. Le consentement à
l’affichage d’un pseudonyme dans le classement reste facultatif.

## Déploiement automatique depuis GitHub

Le workflow `.github/workflows/deploy-ovh.yml` met à jour le VPS après chaque
publication sur la branche `main`. Il reste inactif tant que la variable GitHub
`OVH_DEPLOY_ENABLED` ne vaut pas `true`.

Il utilise une clé SSH dédiée et quatre secrets GitHub : `OVH_HOST`, `OVH_USER`,
`OVH_SSH_PRIVATE_KEY` et `OVH_KNOWN_HOSTS`. Le fichier `.env`, les sauvegardes
PostgreSQL et les journaux sont exclus du dépôt.
