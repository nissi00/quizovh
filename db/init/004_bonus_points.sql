CREATE TABLE IF NOT EXISTS training_group_bonus_points (
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  bonus_points numeric(5,2) NOT NULL DEFAULT 0 CHECK (bonus_points >= 0 AND bonus_points <= 100),
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id,user_id)
);

CREATE INDEX IF NOT EXISTS training_group_bonus_points_user_idx
  ON training_group_bonus_points(user_id);
