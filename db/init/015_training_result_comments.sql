CREATE TABLE IF NOT EXISTS training_result_comments (
  group_id uuid NOT NULL REFERENCES training_groups(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  comment text NOT NULL DEFAULT '',
  updated_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (group_id,user_id),
  CHECK (char_length(comment) <= 2000)
);

CREATE INDEX IF NOT EXISTS training_result_comments_group_updated_idx
  ON training_result_comments(group_id,updated_at DESC);
