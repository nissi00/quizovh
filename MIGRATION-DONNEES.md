# Transférer les données Supabase vers PostgreSQL OVH

La migration se fait après avoir validé l’application OVH avec les données de
démonstration. Le projet Supabase ne doit pas être supprimé avant la validation
des comptes, questions, sessions, réponses et scores sur OVH.

## 1. Exporter uniquement les données applicatives

Depuis un poste d’administration disposant de Supabase CLI, récupérez la chaîne
de connexion de la base dans le tableau de bord Supabase. Ne copiez jamais cette
chaîne dans une conversation ou dans le dépôt Git.

```bash
supabase db dump \
  --db-url "[CHAINE_DE_CONNEXION]" \
  --schema public \
  --data-only \
  --use-copy \
  -f supabase-public-data.sql
```

Le fichier contient les données du schéma `public`, mais pas la configuration
de la nouvelle API OVH.

## 2. Copier l’export vers le VPS

Depuis CMD 2 sous Windows :

```cmd
scp supabase-public-data.sql ubuntu@VOTRE_IP:/opt/quiz-app/
```

## 3. Importer sur OVH

Depuis CMD 1 connecté au VPS :

```bash
cd /opt/quiz-app
sudo bash ops/import-supabase-data.sh supabase-public-data.sql
```

Le script effectue d’abord une sauvegarde de la base OVH, remplace les données
de démonstration dans une transaction, puis importe les données existantes.

Les anciennes identités Supabase sont conservées uniquement comme références.
Les mots de passe Supabase ne sont pas transférés. Ouvrez ensuite `/setup.html`
avec le jeton d’installation pour créer ou réinitialiser le premier compte
administrateur OVH.

## 4. Contrôler avant la bascule

Vérifiez au minimum :

- le nombre de thèmes, chapitres et questions ;
- le nombre de sessions et de participants ;
- les réponses multiples ;
- le calcul des scores ;
- la connexion du formateur ;
- une session complète avec deux téléphones.

Supabase et Vercel ne doivent être désactivés qu’après ces contrôles et après la
création d’une sauvegarde externe du VPS.
