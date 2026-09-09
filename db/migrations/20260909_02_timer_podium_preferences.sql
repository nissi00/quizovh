ALTER TABLE app_users ADD COLUMN IF NOT EXISTS podium_alias text;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS podium_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS podium_preference_set_at timestamptz;

UPDATE session_participants
SET show_on_podium=false,
    podium_alias=NULL,
    podium_consent_at=NULL,
    podium_consent_changed_at=now(),
    podium_consent_source='learner_form'
WHERE podium_alias ~ '^Joueur-[A-F0-9]{6}$';
