CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE teams (
  id   BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE memberships (
  user_id BIGINT NOT NULL REFERENCES users(id),
  team_id BIGINT NOT NULL REFERENCES teams(id),
  role    TEXT   NOT NULL CHECK (role IN ('viewer','member','lead','admin')),
  PRIMARY KEY (user_id, team_id)
);

CREATE TABLE work_items (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL CHECK (type IN ('incident','customer_issue','payment','compliance','task')),
  priority    TEXT NOT NULL CHECK (priority IN ('low','medium','high','urgent')),
  status      TEXT NOT NULL DEFAULT 'open'
              CHECK (status IN ('open','in_progress','awaiting_approval','resolved','closed')),
  team_id     BIGINT NOT NULL REFERENCES teams(id),
  assignee_id BIGINT REFERENCES users(id),
  created_by  BIGINT NOT NULL REFERENCES users(id),
  due_date    TIMESTAMPTZ,
  version     INT NOT NULL DEFAULT 1,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  search_vec  TSVECTOR GENERATED ALWAYS AS
    (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(description,''))) STORED
);

CREATE INDEX idx_items_team_status_prio ON work_items (team_id, status, priority, id DESC);
CREATE INDEX idx_items_assignee ON work_items (assignee_id, status) WHERE assignee_id IS NOT NULL;
CREATE INDEX idx_items_unassigned ON work_items (team_id, priority) WHERE assignee_id IS NULL AND status <> 'closed';
CREATE INDEX idx_items_search ON work_items USING GIN (search_vec);

CREATE TABLE activity_events (
  id         BIGSERIAL PRIMARY KEY,
  item_id    BIGINT NOT NULL REFERENCES work_items(id),
  actor_id   BIGINT REFERENCES users(id),
  kind       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_item ON activity_events (item_id, id DESC);

CREATE TABLE idempotency_keys (
  key           TEXT NOT NULL,
  user_id       BIGINT NOT NULL REFERENCES users(id),
  request_hash  TEXT NOT NULL,
  status_code   INT,
  response_body JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, key)
);

CREATE TABLE outbox_jobs (
  id           BIGSERIAL PRIMARY KEY,
  type         TEXT NOT NULL,
  payload      JSONB NOT NULL,
  dedupe_key   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed')),
  attempts     INT NOT NULL DEFAULT 0,
  next_run_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_due ON outbox_jobs (next_run_at) WHERE status = 'pending';

CREATE TABLE notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id),
  item_id    BIGINT NOT NULL REFERENCES work_items(id),
  message    TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);