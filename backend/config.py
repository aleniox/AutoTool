import os
import sys
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')

def env_str(name: str, default: str) -> str:
    v = os.getenv(name)
    return default if v is None or v == '' else str(v)

def env_int(name: str, default: int) -> int:
    v = os.getenv(name)
    if v is None or v == '':
        return default
    try:
        return int(v)
    except ValueError:
        return default

def env_bool(name: str, default: bool) -> bool:
    v = os.getenv(name)
    if v is None or v == '':
        return default
    return str(v).strip().lower() in ('1', 'true', 'yes', 'on')

data_dir_env = env_str('AUTOTOOL_DATA_DIR', str(ROOT / 'data'))
data_dir = Path(data_dir_env).resolve()

class Config:
    root: Path = ROOT
    data_dir: Path = data_dir
    paths = {
        'data_dir': str(data_dir),
        'db': str(data_dir / 'autotool.sqlite'),
        'media': str(data_dir / 'media'),
        'profiles': str(data_dir / 'profiles'),
        'screenshots': str(data_dir / 'screenshots'),
        'logs': str(data_dir / 'logs'),
        'web': str(ROOT / 'src' / 'web'),
    }

    host: str = env_str('HOST', '127.0.0.1')
    port: int = env_int('PORT', 8787)

    class browser:
        channel: str = env_str('BROWSER_CHANNEL', 'msedge')
        headless: bool = env_bool('HEADLESS', False)
        locale: str = env_str('BROWSER_LOCALE', 'vi-VN')
        timezone_id: str = env_str('BROWSER_TIMEZONE', 'Asia/Ho_Chi_Minh')
        viewport = {
            'width': env_int('BROWSER_VIEWPORT_WIDTH', 1440),
            'height': env_int('BROWSER_VIEWPORT_HEIGHT', 900),
        }
        step_timeout_ms: int = env_int('BROWSER_STEP_TIMEOUT_MS', 30000)
        item_timeout_ms: int = env_int('BROWSER_ITEM_TIMEOUT_MS', 240000)

    class worker:
        concurrency: int = max(1, env_int('WORKER_CONCURRENCY', 2))
        tick_ms: int = max(500, env_int('WORKER_TICK_MS', 3000))
        default_daily_limit: int = env_int('DEFAULT_DAILY_LIMIT', 15)
        default_min_delay_sec: int = env_int('DEFAULT_MIN_DELAY_SEC', 120)
        default_max_delay_sec: int = env_int('DEFAULT_MAX_DELAY_SEC', 360)
        default_max_attempts: int = env_int('DEFAULT_MAX_ATTEMPTS', 3)
        max_defers: int = env_int('WORKER_MAX_DEFERS', 3)

    allow_dry_run: bool = env_bool('ALLOW_DRY_RUN', True)
    allow_login_window: bool = env_bool('ALLOW_LOGIN_WINDOW', True)
    max_upload_bytes: int = env_int('MAX_UPLOAD_MB', 64) * 1024 * 1024

config = Config()

def ensure_dirs():
    for key in ['data_dir', 'media', 'profiles', 'screenshots', 'logs']:
        d = Path(config.paths[key])
        d.mkdir(parents=True, exist_ok=True)
