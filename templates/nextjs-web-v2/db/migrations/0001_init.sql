-- The app's first migration (node-pg-migrate SQL format, docs/rules/own-database.md). Forward-only: the platform
-- runs `up` before every rollout, in one transaction; a rollback never runs `down`. Expand first, contract later.

-- Up Migration
CREATE TABLE IF NOT EXISTS app_notes (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body       text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration
DROP TABLE IF EXISTS app_notes;
