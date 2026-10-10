CREATE TABLE workflows (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, title TEXT, status TEXT NOT NULL DEFAULT 'queued', plan JSONB, progress INT NOT NULL DEFAULT 0, stats JSONB NOT NULL DEFAULT '{}', error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ);
CREATE TABLE workflow_events (id BIGSERIAL PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, step TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE records (id BIGSERIAL PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, data JSONB NOT NULL, source_name TEXT NOT NULL, source_url TEXT, confidence REAL NOT NULL DEFAULT 0.5, dedupe_key TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (workflow_id, dedupe_key));
CREATE TABLE sources (id BIGSERIAL PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, connector TEXT NOT NULL, query TEXT, url TEXT, status TEXT NOT NULL, items INT NOT NULL DEFAULT 0, duration_ms INT, error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX ON workflow_events (workflow_id, id);
CREATE INDEX ON records (workflow_id);
CREATE INDEX ON sources (workflow_id);

-- per-user ownership (Neon Auth user id); NULL = shared read-only example
ALTER TABLE workflows ADD COLUMN IF NOT EXISTS owner_id TEXT;
CREATE INDEX IF NOT EXISTS workflows_owner_created_idx ON workflows (owner_id, created_at DESC);

-- result page links per source step, shown in the Sources tab
ALTER TABLE sources ADD COLUMN IF NOT EXISTS pages JSONB;

-- per-user hourly caps on runs and Ask / AI-column calls (credits are limited)
CREATE TABLE IF NOT EXISTS usage_events (id BIGSERIAL PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS usage_events_user_kind_idx ON usage_events (user_id, kind, created_at DESC);
