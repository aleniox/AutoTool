import sqlite3
import json
import threading
from datetime import datetime, timezone, timedelta
from typing import Any, Callable, Dict, List, Optional
from backend.config import config, ensure_dirs
from backend.logger import log_sinks, now_iso

ensure_dirs()

_lock = threading.RLock()
_conn = sqlite3.connect(
    config.paths['db'],
    check_same_thread=False,
    timeout=10.0,
    isolation_level=None  # autocommit mode, transactions handled explicitly
)
_conn.row_factory = sqlite3.Row

# WAL mode and pragmas
with _lock:
    _conn.execute('PRAGMA journal_mode = WAL')
    _conn.execute('PRAGMA foreign_keys = ON')
    _conn.execute('PRAGMA busy_timeout = 5000')

SCHEMA = """
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
"""

with _lock:
    _conn.executescript(SCHEMA)

    # Migrations for recurring schedule fields
    cur = _conn.execute("PRAGMA table_info(jobs)")
    cols = {row['name'] for row in cur.fetchall()}
    if 'recurring_type' not in cols:
        _conn.execute("ALTER TABLE jobs ADD COLUMN recurring_type TEXT NOT NULL DEFAULT 'none'")
    if 'recurring_time' not in cols:
        _conn.execute("ALTER TABLE jobs ADD COLUMN recurring_time TEXT NOT NULL DEFAULT ''")
    if 'recurring_days' not in cols:
        _conn.execute("ALTER TABLE jobs ADD COLUMN recurring_days TEXT NOT NULL DEFAULT '[]'")
    if 'recurring_end_at' not in cols:
        _conn.execute("ALTER TABLE jobs ADD COLUMN recurring_end_at TEXT")
    if 'recurring_count' not in cols:
        _conn.execute("ALTER TABLE jobs ADD COLUMN recurring_count INTEGER NOT NULL DEFAULT 0")
    if 'max_cycles' not in cols:
        _conn.execute("ALTER TABLE jobs ADD COLUMN max_cycles INTEGER NOT NULL DEFAULT 0")

def _norm(v: Any) -> Any:
    if v is None:
        return None
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, datetime):
        return v.isoformat()
    return v

def all_rows(sql: str, *params: Any) -> List[Dict[str, Any]]:
    norm_params = [_norm(p) for p in params]
    with _lock:
        cur = _conn.execute(sql, norm_params)
        rows = cur.fetchall()
        return [dict(r) for r in rows]

# Alias `all` matching JS export `all`
all = all_rows

def get(sql: str, *params: Any) -> Optional[Dict[str, Any]]:
    norm_params = [_norm(p) for p in params]
    with _lock:
        cur = _conn.execute(sql, norm_params)
        row = cur.fetchone()
        return dict(row) if row else None

class RunResult:
    def __init__(self, changes: int, last_insert_rowid: int):
        self.changes = changes
        self.lastInsertRowid = last_insert_rowid

def run(sql: str, *params: Any) -> RunResult:
    norm_params = [_norm(p) for p in params]
    with _lock:
        cur = _conn.execute(sql, norm_params)
        return RunResult(changes=cur.rowcount if cur.rowcount >= 0 else 0, last_insert_rowid=cur.lastrowid or 0)

def insert(table: str, data: Dict[str, Any]) -> int:
    keys = list(data.keys())
    placeholders = ', '.join(['?'] * len(keys))
    sql = f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({placeholders})"
    res = run(sql, *[data[k] for k in keys])
    return res.lastInsertRowid

def update(table: str, id_val: int, data: Dict[str, Any]) -> int:
    keys = list(data.keys())
    if not keys:
        return 0
    assignments = ', '.join([f"{k} = ?" for k in keys])
    sql = f"UPDATE {table} SET {assignments} WHERE id = ?"
    res = run(sql, *[data[k] for k in keys], id_val)
    return res.changes

def tx(fn: Callable[[], Any]) -> Any:
    with _lock:
        _conn.execute('BEGIN IMMEDIATE')
        try:
            out = fn()
            _conn.execute('COMMIT')
            return out
        except Exception:
            try:
                _conn.execute('ROLLBACK')
            except Exception:
                pass
            raise

def parse_json(value: Any, fallback: Any = None) -> Any:
    if value is None or value == '':
        return fallback
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except Exception:
        return fallback

def get_setting(key: str, fallback: Any = None) -> Any:
    row = get('SELECT value FROM settings WHERE key = ?', key)
    if row:
        return parse_json(row['value'], fallback)
    return fallback

def set_setting(key: str, value: Any):
    run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        json.dumps(value if value is not None else None),
    )

def _log_sink_to_db(entry: dict):
    with _lock:
        _conn.execute(
            'INSERT INTO logs (ts, level, scope, job_id, item_id, account_id, message) VALUES (?, ?, ?, ?, ?, ?, ?)',
            (
                entry.get('ts') or now_iso(),
                entry.get('level') or 'info',
                entry.get('scope') or '',
                entry.get('jobId') or entry.get('job_id'),
                entry.get('itemId') or entry.get('item_id'),
                entry.get('accountId') or entry.get('account_id'),
                str(entry.get('message') or '')[:4000],
            ),
        )

log_sinks.add(_log_sink_to_db)

def prune_logs(days: int = 14) -> int:
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat().replace('+00:00', 'Z')
    return run('DELETE FROM logs WHERE ts < ?', cutoff).changes
