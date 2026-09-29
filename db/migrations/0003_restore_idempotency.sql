ALTER TABLE versions ADD COLUMN restore_idempotency_key text;
CREATE UNIQUE INDEX versions_restore_key_idx
  ON versions(project_id, restore_idempotency_key)
  WHERE restore_idempotency_key IS NOT NULL;
