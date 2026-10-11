import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from backend.config import config

LEVELS = {'debug': 10, 'info': 20, 'warn': 30, 'error': 40}
LOG_LEVEL_NAME = os.getenv('LOG_LEVEL', 'info').lower()
MIN_LEVEL = LEVELS.get(LOG_LEVEL_NAME, LEVELS['info'])

COLORS = {
    'debug': '\x1b[90m',
    'info': '\x1b[36m',
    'warn': '\x1b[33m',
    'error': '\x1b[31m',
    'reset': '\x1b[0m',
}

log_sinks = set()

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

def _write_log(line: str):
    try:
        log_dir = Path(config.paths['logs'])
        log_dir.mkdir(parents=True, exist_ok=True)
        date_str = datetime.now().strftime('%Y-%m-%d')
        file_path = log_dir / f"autotool-{date_str}.log"
        with open(file_path, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass

def emit(level: str, scope: str, message: str, extra: dict = None):
    lvl = LEVELS.get(level, 20)
    if lvl < MIN_LEVEL:
        return
    ts = now_iso()
    scope_str = f"({scope}) " if scope else ""
    line = f"[{ts}] {level.upper():<5} {scope_str}{message}"
    
    color = COLORS.get(level, '')
    reset = COLORS['reset']
    out = sys.stderr if level in ('error', 'warn') else sys.stdout
    try:
        out.write(f"{color}{line}{reset}\n")
        out.flush()
    except Exception:
        pass

    _write_log(line)

    payload = {'ts': ts, 'level': level, 'scope': scope, 'message': message}
    if extra:
        payload.update(extra)

    for sink in list(log_sinks):
        try:
            sink(payload)
        except Exception:
            pass

class ScopedLogger:
    def __init__(self, scope: str = ''):
        self.scope = scope

    def debug(self, msg: str, extra: dict = None, **kwargs):
        data = {**(extra or {}), **kwargs}
        emit('debug', self.scope, str(msg), data)

    def info(self, msg: str, extra: dict = None, **kwargs):
        data = {**(extra or {}), **kwargs}
        emit('info', self.scope, str(msg), data)

    def warn(self, msg: str, extra: dict = None, **kwargs):
        data = {**(extra or {}), **kwargs}
        emit('warn', self.scope, str(msg), data)

    def error(self, msg: str, extra: dict = None, **kwargs):
        data = {**(extra or {}), **kwargs}
        emit('error', self.scope, str(msg), data)

    def child(self, sub: str) -> 'ScopedLogger':
        new_scope = f"{self.scope}:{sub}" if self.scope else sub
        return ScopedLogger(new_scope)

def create_logger(scope: str = '') -> ScopedLogger:
    return ScopedLogger(scope)

logger = create_logger('app')
