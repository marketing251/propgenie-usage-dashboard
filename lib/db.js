import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = process.env.DB_PATH || join(root, 'data', 'usage.db');

// Vercel's filesystem is read-only: serve the bundled demo database as-is and disable ingest.
export const READ_ONLY = !!process.env.VERCEL || process.env.READ_ONLY === '1';

export const db = READ_ONLY ? new DatabaseSync(file, { readOnly: true }) : open();

function open() {
  mkdirSync(dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec(`
    PRAGMA journal_mode = DELETE;
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      plan TEXT,
      email TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      client_id TEXT NOT NULL REFERENCES clients(id),
      tool TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      images INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL,
      credits INTEGER NOT NULL DEFAULT 0,
      request_id TEXT UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON usage_events(ts);
    CREATE INDEX IF NOT EXISTS idx_events_client_ts ON usage_events(client_id, ts);
  `);
  return d;
}
