import os
import sys
import time
from datetime import datetime, timezone
from typing import Optional, List, Dict, Any
from fastapi import APIRouter, Request, HTTPException, Query
from backend.config import config
from backend.db import all_rows, get, run, now_iso, get_setting, set_setting
from backend.platforms import list_platforms, all_platforms, parse_target_url
from backend.core.worker import worker_status
from backend.core.browser import detect_browsers, is_open

router = APIRouter()
_start_time = time.time()

@router.get('/health')
async def get_health():
    db_ok = True
    try:
        get('SELECT 1 AS ok')
    except Exception:
        db_ok = False

    return {
        'ok': db_ok,
        'version': '0.1.0',
        'time': now_iso(),
        'uptimeSec': round(time.time() - _start_time),
        'node': f"Python {sys.version.split()[0]}",
        'dataDir': str(config.data_dir),
        'browser': {
            'channel': config.browser.channel,
            'headless': config.browser.headless,
            'installed': detect_browsers(),
        },
        'worker': worker_status(),
    }

@router.get('/platforms')
async def get_platforms():
    return {'platforms': list_platforms()}

@router.post('/platforms/resolve')
async def resolve_platforms(req: Request):
    body = await req.json()
    urls = body.get('urls', []) if isinstance(body.get('urls'), list) else []
    platform_hint = body.get('platform')
    results = [
        {'url': url, 'parsed': parse_target_url(url, platform_hint=platform_hint)}
        for url in urls
    ]
    return {'results': results}

@router.get('/stats')
async def get_stats():
    counts = get("""
        SELECT
          (SELECT COUNT(*) FROM accounts)  AS accounts,
          (SELECT COUNT(*) FROM targets)   AS targets,
          (SELECT COUNT(*) FROM posts)     AS posts,
          (SELECT COUNT(*) FROM jobs)      AS jobs
    """) or {}

    items = get("""
        SELECT
          COALESCE(SUM(status='pending'),0)  AS pending,
          COALESCE(SUM(status='running'),0)  AS running,
          COALESCE(SUM(status='success'),0)  AS success,
          COALESCE(SUM(status='failed'),0)   AS failed,
          COALESCE(SUM(status='skipped'),0)  AS skipped,
          COALESCE(SUM(status='canceled'),0) AS canceled
        FROM job_items
    """) or {}

    today_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_iso = today_dt.isoformat().replace('+00:00', 'Z')
    today_row = get(
        """SELECT
             COALESCE(SUM(status='success'),0) AS success,
             COALESCE(SUM(status='failed'),0)  AS failed
           FROM job_items WHERE COALESCE(finished_at, started_at) >= ?""",
        today_iso,
    ) or {'success': 0, 'failed': 0}

    by_platform = all_rows("""
        SELECT a.platform,
               COUNT(*) AS total,
               COALESCE(SUM(i.status='success'),0) AS success,
               COALESCE(SUM(i.status='failed'),0)  AS failed
          FROM job_items i
          JOIN accounts a ON a.id = i.account_id
         GROUP BY a.platform
         ORDER BY total DESC
    """)

    accounts = all_rows(
        """SELECT a.id, a.platform, a.label, a.status, a.enabled, a.daily_limit,
                (SELECT COUNT(*) FROM targets t WHERE t.account_id = a.id) AS targets,
                (SELECT COUNT(*) FROM job_items i
                  WHERE i.account_id = a.id AND i.status='success' AND i.finished_at >= ?) AS posted_today
           FROM accounts a
          ORDER BY a.id""",
        today_iso,
    )

    upcoming = all_rows("""
        SELECT j.id, j.name, j.status, j.scheduled_at, j.total, j.success_count, j.failed_count,
               j.dry_run
          FROM jobs j
         WHERE j.status IN ('scheduled','running','paused')
         ORDER BY j.scheduled_at ASC
         LIMIT 10
    """)

    recent = all_rows("""
        SELECT i.id, i.status, i.finished_at, i.error, i.remote_url,
               p.title AS post_title, t.name AS target_name, a.label AS account_label,
               a.platform
          FROM job_items i
          JOIN posts p    ON p.id = i.post_id
          JOIN targets t  ON t.id = i.target_id
          JOIN accounts a ON a.id = i.account_id
         WHERE i.status IN ('success','failed')
         ORDER BY COALESCE(i.finished_at, i.started_at) DESC
         LIMIT 15
    """)

    return {
        'counts': {**counts, **items, 'today': today_iso},
        'today': today_row,
        'byPlatform': by_platform,
        'accounts': accounts,
        'upcoming': upcoming,
        'recent': recent,
    }

@router.get('/logs')
async def get_logs(limit: int = 200, level: Optional[str] = None, jobId: Optional[int] = None):
    limit_clamped = min(1000, max(1, limit))
    where = []
    params = []
    if level and level != 'all':
        where.append('level = ?')
        params.append(level)
    if jobId:
        where.append('job_id = ?')
        params.append(jobId)

    where_clause = f"WHERE {' AND '.join(where)}" if where else ''
    sql = f"SELECT * FROM logs {where_clause} ORDER BY id DESC LIMIT ?"
    return {'logs': all_rows(sql, *params, limit_clamped)}

@router.delete('/logs')
async def clear_logs():
    run('DELETE FROM logs')
    return {'ok': True}

DEFAULTS = {
    'defaultDailyLimit': config.worker.default_daily_limit,
    'defaultMinDelaySec': config.worker.default_min_delay_sec,
    'defaultMaxDelaySec': config.worker.default_max_delay_sec,
    'defaultMaxAttempts': config.worker.default_max_attempts,
    'headless': config.browser.headless,
}

@router.get('/settings')
async def get_settings():
    saved = get_setting('settings', {}) or {}
    return {
        'settings': {**DEFAULTS, **saved},
        'runtime': {
            'concurrency': config.worker.concurrency,
            'browserChannel': config.browser.channel,
            'dataDir': str(config.data_dir),
            'allowDryRun': config.allow_dry_run,
            'allowLoginWindow': config.allow_login_window,
        },
    }

@router.put('/settings')
async def update_settings(req: Request):
    incoming = await req.json()
    saved = get_setting('settings', {}) or {}
    next_settings = dict(saved)

    for k in DEFAULTS.keys():
        if k in incoming:
            try:
                val = float(incoming[k])
                if val < 0:
                    raise ValueError()
                next_settings[k] = int(val) if val.is_integer() else val
            except (ValueError, TypeError):
                raise HTTPException(status_code=400, detail=f"Gia tri khong hop le cho {k}")

    set_setting('settings', next_settings)
    return {'settings': {**DEFAULTS, **next_settings}}

@router.get('/worker')
async def get_worker():
    return worker_status()

@router.get('/browsers')
async def get_browsers():
    accounts = all_rows('SELECT id, platform, label FROM accounts ORDER BY id')
    return {
        'installed': detect_browsers(),
        'configuredChannel': config.browser.channel,
        'open': [a['id'] for a in accounts if is_open(a['id'])],
    }

@router.get('/platforms/{platform_id}/flow')
async def get_platform_flow(platform_id: str):
    platform = next((p for p in all_platforms() if p['id'] == platform_id), None)
    if not platform:
        raise HTTPException(status_code=400, detail=f"Nen tang khong ton tai: {platform_id}")

    def summarize(steps):
        step_list = steps if isinstance(steps, list) else [steps]
        res = []
        for i, s in enumerate(step_list):
            if not isinstance(s, dict):
                continue
            key = next((k for k in s.keys() if k not in ('optional', 'timeout', 'submit', 'label', 'after')), 'unknown')
            val = s.get(key)
            detail = '(ham dong)' if callable(val) else (str(val) if isinstance(val, (str, int, float)) else str(val))
            res.append({
                'index': i,
                'action': key,
                'submit': bool(s.get('submit')),
                'optional': bool(s.get('optional')),
                'detail': detail[:300],
            })
        return res

    flows_summary = {
        k: summarize(f.get('steps', []))
        for k, f in platform.get('flows', {}).items()
    }

    return {
        'id': platform['id'],
        'name': platform['name'],
        'verified': platform.get('verified', False),
        'experimental': platform.get('experimental', False),
        'notes': platform.get('notes', ''),
        'flows': flows_summary,
    }
