CREATE TABLE visitors (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  visitor_id uuid NOT NULL REFERENCES visitors(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  current_version_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_owner_updated_idx ON projects(visitor_id, updated_at DESC);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  base_version_id uuid,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  stage text NOT NULL CHECK (stage IN ('planning', 'generating', 'checking', 'saving', 'done')),
  error_code text,
  idempotency_key text NOT NULL,
  retry_of_id uuid REFERENCES tasks(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, idempotency_key),
  UNIQUE(id, project_id)
);
CREATE UNIQUE INDEX tasks_one_running_per_project ON tasks(project_id) WHERE status = 'running';

CREATE TABLE versions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  sequence integer NOT NULL CHECK (sequence > 0),
  html text NOT NULL,
  summary text NOT NULL,
  task_id uuid REFERENCES tasks(id),
  restored_from_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, sequence),
  UNIQUE(id, project_id),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id),
  FOREIGN KEY (restored_from_id, project_id) REFERENCES versions(id, project_id)
);
ALTER TABLE projects ADD CONSTRAINT projects_current_version_fk
  FOREIGN KEY (current_version_id, id) REFERENCES versions(id, project_id);
ALTER TABLE tasks ADD CONSTRAINT tasks_base_version_fk
  FOREIGN KEY (base_version_id, project_id) REFERENCES versions(id, project_id);

CREATE TABLE messages (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  task_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (task_id, project_id) REFERENCES tasks(id, project_id)
);
CREATE INDEX messages_project_created_idx ON messages(project_id, created_at);
