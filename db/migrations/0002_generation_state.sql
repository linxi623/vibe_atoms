ALTER TABLE tasks ADD COLUMN plan jsonb;
ALTER TABLE tasks ADD COLUMN deadline_at timestamptz;
ALTER TABLE tasks ADD COLUMN prompt_hash text;
ALTER TABLE tasks ADD COLUMN error_detail text;
