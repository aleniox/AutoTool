import { DatabaseSync } from 'node:sqlite';
import config, { ensureDirs } from './config.js';
import { logSinks } from './logger.js';

ensureDirs();

export const db = new DatabaseSync(config.paths.db);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color       TEXT NOT NULL DEFAULT '#4f8cff',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS accounts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  platform       TEXT NOT NULL,
  label          TEXT NOT NULL,
  profile_dir    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new',
  status_message TEXT NOT NULL DEFAULT '',
  last_check_at  TEXT,
  daily_limit    INTEGER NOT NULL DEFAULT 15,
  min_delay_sec  INTEGER NOT NULL DEFAULT 120,
  max_delay_sec  INTEGER NOT NULL DEFAULT 360,
  enabled        INTEGER NOT NULL DEFAULT 1,
  meta           TEXT NOT NULL DEFAULT '{}',
  created_at     TEXT NOT NULL,
  UNIQUE (platform, label)
);

CREATE TABLE IF NOT EXISTS targets (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform     TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'group',
  external_id  TEXT NOT NULL DEFAULT '',
  name         TEXT NOT NULL,
  url          TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 1,
  meta         TEXT NOT NULL DEFAULT '{}',
  last_post_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (account_id, url)
);

CREATE TABLE IF NOT EXISTS posts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  title      TEXT NOT NULL DEFAULT '',
  caption    TEXT NOT NULL DEFAULT '',
  link       TEXT NOT NULL DEFAULT '',
  hashtags   TEXT NOT NULL DEFAULT '',
  media      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  strategy       TEXT NOT NULL DEFAULT 'cross',
  status         TEXT NOT NULL DEFAULT 'scheduled',
  dry_run        INTEGER NOT NULL DEFAULT 0,
  scheduled_at   TEXT NOT NULL,
  min_delay_sec  INTEGER,
  max_delay_sec  INTEGER,
  max_attempts   INTEGER NOT NULL DEFAULT 3,
  total          INTEGER NOT NULL DEFAULT 0,
  success_count  INTEGER NOT NULL DEFAULT 0,
  failed_count   INTEGER NOT NULL DEFAULT 0,
  skipped_count  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE TABLE IF NOT EXISTS job_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_id    INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  post_id      INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  defers       INTEGER NOT NULL DEFAULT 0,
  run_at       TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT,
  remote_url   TEXT NOT NULL DEFAULT '',
  error        TEXT NOT NULL DEFAULT '',
  screenshot   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL,
  level      TEXT NOT NULL,
  scope      TEXT NOT NULL DEFAULT '',
  job_id     INTEGER,
  item_id    INTEGER,
  account_id INTEGER,
  message    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_items_due     ON job_items (status, run_at);
CREATE INDEX IF NOT EXISTS idx_items_job     ON job_items (job_id, id);
CREATE INDEX IF NOT EXISTS idx_items_account ON job_items (account_id, status);
CREATE INDEX IF NOT EXISTS idx_targets_acct  ON targets (account_id, enabled);
CREATE INDEX IF NOT EXISTS idx_logs_ts       ON logs (ts DESC);
`);

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

export const nowIso = () => new Date().toISOString();

export function all(sql, ...params) {
  return db.prepare(sql).all(...params.map(norm));
}

export function get(sql, ...params) {
  return db.prepare(sql).get(...params.map(norm)) ?? null;
}

export function run(sql, ...params) {
  const res = db.prepare(sql).run(...params.map(norm));
  return { changes: Number(res.changes), lastInsertRowid: Number(res.lastInsertRowid) };
}

export function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`;
  const res = run(sql, ...keys.map((k) => data[k]));
  return res.lastInsertRowid;
}

export function update(table, id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return 0;
  const sql = `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`;
  return run(sql, ...keys.map((k) => data[k]), id).changes;
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** node:sqlite chi chap nhan null/number/string/bigint/buffer -> chuan hoa truoc khi bind. */
function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  return v;
}

export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? parseJson(row.value, fallback) : fallback;
}

export function setSetting(key, value) {
  run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value ?? null),
  );
}

/* -------------------------------------------------------------------------- */
/* Log sink -> DB                                                             */
/* -------------------------------------------------------------------------- */

const insertLogStmt = db.prepare(
  'INSERT INTO logs (ts, level, scope, job_id, item_id, account_id, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
);

logSinks.add((entry) => {
  insertLogStmt.run(
    entry.ts ?? nowIso(),
    entry.level ?? 'info',
    entry.scope ?? '',
    entry.jobId ?? null,
    entry.itemId ?? null,
    entry.accountId ?? null,
    String(entry.message ?? '').slice(0, 4000),
  );
});

/** Giu bang log gon gang: xoa ban ghi cu hon N ngay. */
export function pruneLogs(days = 14) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  return run('DELETE FROM logs WHERE ts < ?', cutoff).changes;
}

export default db;
