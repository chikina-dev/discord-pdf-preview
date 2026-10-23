PRAGMA foreign_keys = ON;
CREATE TABLE preview_jobs (
  source_message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  reply_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE preview_items (
  source_message_id TEXT NOT NULL REFERENCES preview_jobs(source_message_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  source_index INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  target_long_edge INTEGER NOT NULL DEFAULT 1200,
  interruptions INTEGER NOT NULL DEFAULT 0,
  discord_attachment_id TEXT,
  last_error_kind TEXT,
  PRIMARY KEY(source_message_id, attachment_id)
);
CREATE TABLE send_operations (
  operation_id TEXT PRIMARY KEY,
  source_message_id TEXT NOT NULL REFERENCES preview_jobs(source_message_id) ON DELETE CASCADE,
  attachment_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sending',
  started_at INTEGER NOT NULL,
  filename TEXT NOT NULL
);
CREATE UNIQUE INDEX one_pending_send ON send_operations(source_message_id) WHERE status = 'sending';
CREATE INDEX jobs_expiration ON preview_jobs(expires_at);
CREATE TABLE discord_cooldowns (scope TEXT PRIMARY KEY, until_at INTEGER NOT NULL);
CREATE TABLE discord_routes (channel_id TEXT NOT NULL, bucket TEXT NOT NULL, PRIMARY KEY(channel_id,bucket));
