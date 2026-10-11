import json
import math
import random
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Request, HTTPException
from backend.config import config
from backend.db import all_rows, get, run, insert, now_iso, tx
from backend.core.worker import refresh_job
from backend.core.recurring import compute_next_run, get_projected_runs
from backend.logger import create_logger

router = APIRouter()
log = create_logger('api:jobs')

STRATEGIES = {
    'cross': 'Moi bai -> moi nhom (cartesian, nhieu luot nhat)',
    'zip': 'Ghep 1-1 theo thu tu (bai i -> nhom i)',
    'round_robin': 'Chia deu: xoay vong bai cho tung nhom, khong lap trong cung nhom',
}

def rand_int(min_val: int, max_val: int) -> int:
    return random.randint(min(min_val, max_val), max(min_val, max_val))

def build_pairs(strategy: str, posts: List[dict], targets: List[dict]) -> List[dict]:
    pairs = []
    if strategy == 'cross':
        for t in targets:
            for p in posts:
                pairs.append({'account_id': t['account_id'], 'target_id': t['id'], 'post_id': p['id']})
        return pairs

    if strategy == 'zip':
        n = min(len(posts), len(targets))
        for i in range(n):
            pairs.append({'account_id': targets[i]['account_id'], 'target_id': targets[i]['id'], 'post_id': posts[i]['id']})
        return pairs

    # round_robin
    per_target = max(1, math.ceil(len(posts) / len(targets)))
    for ti, t in enumerate(targets):
        for k in range(per_target):
            p = posts[(ti + k * len(targets)) % len(posts)]
            pairs.append({'account_id': t['account_id'], 'target_id': t['id'], 'post_id': p['id']})

    seen = set()
    unique_pairs = []
    for p in pairs:
        key = f"{p['target_id']}:{p['post_id']}"
        if key not in seen:
            seen.add(key)
            unique_pairs.append(p)
    return unique_pairs

@router.post('/jobs', status_code=201)
async def create_job(req: Request):
    body = await req.json()
    name = str(body.get('name') or '').strip()
    if not name:
        raise HTTPException(status_code=400, detail="Thieu truong bat buoc: name")

    dry_run = bool(body.get('dryRun', False))
    if dry_run and not config.allow_dry_run:
        raise HTTPException(status_code=400, detail="Che do thu dang bi tat (ALLOW_DRY_RUN=false)")

    project_id = body.get('projectId')

    # Select posts
    if body.get('postIds'):
        ids = [int(i) for i in body['postIds'] if i]
        ph = ','.join(['?'] * len(ids))
        posts = all_rows(f"SELECT * FROM posts WHERE id IN ({ph}) ORDER BY id", *ids)
        if len(posts) != len(ids):
            raise HTTPException(status_code=400, detail="Mot so bai viet khong ton tai")
    elif body.get('useAllPosts'):
        posts = all_rows(
            f"SELECT * FROM posts {'WHERE project_id = ?' if project_id else ''} ORDER BY id",
            *([project_id] if project_id else [])
        )
    else:
        raise HTTPException(status_code=400, detail="Chua chon bai viet nao")

    if not posts:
        raise HTTPException(status_code=400, detail="Khong co bai viet nao de dang")

    # Select targets
    if body.get('targetIds'):
        ids = [int(i) for i in body['targetIds'] if i]
        ph = ','.join(['?'] * len(ids))
        targets = all_rows(
            f"""SELECT t.* FROM targets t JOIN accounts a ON a.id = t.account_id
                 WHERE t.id IN ({ph}) AND t.enabled = 1 AND a.enabled = 1 ORDER BY t.account_id, t.id""",
            *ids,
        )
        if not targets:
            raise HTTPException(status_code=400, detail="Khong co nhom nao hop le (da bat) trong danh sach chon")
    elif body.get('useAllTargets'):
        account_id = body.get('accountId')
        where = ['t.enabled = 1', 'a.enabled = 1']
        params = []
        if project_id:
            where.append('t.project_id = ?')
            params.append(project_id)
        if account_id:
            where.append('t.account_id = ?')
            params.append(account_id)
        targets = all_rows(
            f"""SELECT t.* FROM targets t JOIN accounts a ON a.id = t.account_id
                 WHERE {' AND '.join(where)} ORDER BY t.account_id, t.id""",
            *params,
        )
    else:
        raise HTTPException(status_code=400, detail="Chua chon nhom nao")

    if not targets:
        raise HTTPException(status_code=400, detail="Khong co nhom nao de dang")

    strategy = str(body.get('strategy') or 'cross')
    if strategy not in STRATEGIES:
        raise HTTPException(status_code=400, detail=f"Chien luoc khong hop le: {strategy}")

    pairs = build_pairs(strategy, posts, targets)
    if not pairs:
        raise HTTPException(status_code=400, detail="Khong tao duoc luot dang nao tu lua chon nay")

    scheduled_at_str = body.get('scheduledAt')
    if scheduled_at_str:
        try:
            scheduled_dt = datetime.fromisoformat(scheduled_at_str.replace('Z', '+00:00'))
        except Exception:
            raise HTTPException(status_code=400, detail="scheduledAt khong hop le")
    else:
        scheduled_dt = datetime.now(timezone.utc)

    max_attempts = max(1, int(body.get('maxAttempts') or config.worker.default_max_attempts))

    recurring_type = str(body.get('recurringType') or 'none').lower()
    if recurring_type not in ('none', 'daily', 'weekly', 'monthly'):
        recurring_type = 'none'

    recurring_time = str(body.get('recurringTime') or '').strip()
    if not recurring_time and scheduled_dt:
        local_sched = scheduled_dt.astimezone(timezone(timedelta(hours=7)))
        recurring_time = f"{local_sched.hour:02d}:{local_sched.minute:02d}"

    recurring_days = json.dumps(body.get('recurringDays') or [])
    recurring_end_at = body.get('recurringEndAt') or None
    max_cycles = max(0, int(body.get('maxCycles') or 0))

    account_index = {}
    for t in targets:
        if t['account_id'] not in account_index:
            account_index[t['account_id']] = len(account_index)

    ordered = sorted(pairs, key=lambda p: account_index.get(p['account_id'], 0))
    now_dt = datetime.now(timezone.utc)
    is_due = scheduled_dt <= (now_dt + timedelta(seconds=1))

    def _create_tx():
        jid = insert('jobs', {
            'project_id': project_id,
            'name': name,
            'strategy': strategy,
            'status': 'running' if is_due else 'scheduled',
            'dry_run': 1 if dry_run else 0,
            'scheduled_at': scheduled_dt.isoformat().replace('+00:00', 'Z'),
            'min_delay_sec': int(body['minDelaySec']) if body.get('minDelaySec') not in (None, '') else None,
            'max_delay_sec': int(body['maxDelaySec']) if body.get('maxDelaySec') not in (None, '') else None,
            'max_attempts': max_attempts,
            'total': len(ordered),
            'recurring_type': recurring_type,
            'recurring_time': recurring_time,
            'recurring_days': recurring_days,
            'recurring_end_at': recurring_end_at,
            'max_cycles': max_cycles,
            'recurring_count': 0,
            'created_at': now_iso(),
            'started_at': now_iso() if is_due else None,
        })

        for pair in ordered:
            offset_sec = account_index.get(pair['account_id'], 0) * rand_int(5, 45)
            item_run_at = scheduled_dt + timedelta(seconds=offset_sec)
            insert('job_items', {
                'job_id': jid,
                'account_id': pair['account_id'],
                'target_id': pair['target_id'],
                'post_id': pair['post_id'],
                'status': 'pending',
                'attempts': 0,
                'max_attempts': max_attempts,
                'defers': 0,
                'run_at': item_run_at.isoformat().replace('+00:00', 'Z'),
            })
        return jid

    job_id = tx(_create_tx)
    refresh_job(job_id)
    log.info(
        f"Tao chien dich #{job_id} '{name}': {len(ordered)} luot dang ({len(posts)} bai x {len(targets)} nhom, {strategy}){' [CHE DO THU]' if dry_run else ''}"
    )

    return {
        'job': get("SELECT * FROM jobs WHERE id = ?", job_id),
        'preview': {
            'posts': len(posts),
            'targets': len(targets),
            'items': len(ordered),
            'accounts': len(account_index),
            'strategy': strategy,
        },
    }

@router.get('/jobs')
async def list_jobs(status: Optional[str] = None, projectId: Optional[int] = None, limit: int = 50):
    where = []
    params = []
    if status and status != 'all':
        where.append("j.status = ?")
        params.append(status)
    if projectId:
        where.append("j.project_id = ?")
        params.append(projectId)

    limit_clamped = min(200, max(1, limit))
    where_clause = f"WHERE {' AND '.join(where)}" if where else ''
    sql = f"""
        SELECT j.*, p.name AS project_name
          FROM jobs j LEFT JOIN projects p ON p.id = j.project_id
          {where_clause}
         ORDER BY j.id DESC LIMIT ?
    """
    rows = all_rows(sql, *params, limit_clamped)
    summary = get("""
        SELECT
          COALESCE(SUM(status IN ('pending','running')),0) AS active_items,
          COALESCE(SUM(status='failed'),0) AS failed_items
        FROM job_items
    """) or {}

    return {
        'jobs': rows,
        'strategies': STRATEGIES,
        'summary': summary,
    }

@router.get('/jobs/{job_id}')
async def get_job(job_id: int):
    job = get("SELECT * FROM jobs WHERE id = ?", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")
    counts = get(
        """SELECT
             COALESCE(SUM(status='pending'),0)  AS pending,
             COALESCE(SUM(status='running'),0)  AS running,
             COALESCE(SUM(status='success'),0)  AS success,
             COALESCE(SUM(status='failed'),0)   AS failed,
             COALESCE(SUM(status='skipped'),0)  AS skipped,
             COALESCE(SUM(status='canceled'),0) AS canceled
           FROM job_items WHERE job_id = ?""",
        job_id,
    ) or {}
    return {'job': job, 'counts': counts}

@router.get('/jobs/{job_id}/items')
async def get_job_items(job_id: int, status: Optional[str] = None, limit: int = 100, offset: int = 0):
    if not get("SELECT id FROM jobs WHERE id = ?", job_id):
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")

    where = ["i.job_id = ?"]
    params = [job_id]
    if status and status != 'all':
        where.append("i.status = ?")
        params.append(status)

    limit_clamped = min(500, max(1, limit))
    offset_clamped = max(0, offset)

    sql = f"""
        SELECT i.*,
               p.title AS post_title, substr(p.caption, 1, 120) AS post_excerpt,
               t.name AS target_name, t.kind AS target_kind,
               a.label AS account_label, a.platform
          FROM job_items i
          JOIN posts p    ON p.id = i.post_id
          JOIN targets t  ON t.id = i.target_id
          JOIN accounts a ON a.id = i.account_id
         WHERE {' AND '.join(where)}
         ORDER BY i.run_at ASC, i.id ASC
         LIMIT ? OFFSET ?
    """
    items = all_rows(sql, *params, limit_clamped, offset_clamped)
    total_row = get(f"SELECT COUNT(*) AS c FROM job_items i WHERE {' AND '.join(where)}", *params) or {'c': 0}

    return {'items': items, 'total': total_row['c'], 'limit': limit_clamped, 'offset': offset_clamped}

@router.post('/jobs/{job_id}/pause')
async def pause_job(job_id: int):
    job = get("SELECT * FROM jobs WHERE id = ?", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")
    run("UPDATE jobs SET status = 'paused' WHERE id = ?", job_id)
    log.info(f"Tam dung chien dich #{job_id}")
    return {'job': get("SELECT * FROM jobs WHERE id = ?", job_id)}

@router.post('/jobs/{job_id}/resume')
async def resume_job(job_id: int):
    job = get("SELECT * FROM jobs WHERE id = ?", job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")
    if job['status'] in ('done', 'canceled'):
        raise HTTPException(status_code=400, detail="Chien dich da ket thuc, khong the tiep tuc")

    run(
        "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?",
        now_iso(),
        job_id,
    )
    refresh_job(job_id)
    log.info(f"Tiep tuc chien dich #{job_id}")
    return {'job': get("SELECT * FROM jobs WHERE id = ?", job_id)}

@router.post('/jobs/{job_id}/cancel')
async def cancel_job(job_id: int):
    if not get("SELECT id FROM jobs WHERE id = ?", job_id):
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")

    canceled = run(
        "UPDATE job_items SET status='canceled', finished_at=? WHERE job_id = ? AND status IN ('pending','running')",
        now_iso(),
        job_id,
    )
    run("UPDATE jobs SET status='canceled', finished_at=? WHERE id = ?", now_iso(), job_id)
    refresh_job(job_id)
    log.warn(f"Huy chien dich #{job_id} ({canceled.changes} luot dang bi huy)")
    return {'ok': True, 'canceled': canceled.changes}

@router.post('/jobs/{job_id}/run-now')
async def run_job_now(job_id: int):
    if not get("SELECT id FROM jobs WHERE id = ?", job_id):
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")

    now_str = now_iso()
    def _run_now_tx():
        r = run("UPDATE job_items SET run_at = ? WHERE job_id = ? AND status = 'pending'", now_str, job_id)
        run(
            "UPDATE jobs SET status='running', scheduled_at=?, started_at=COALESCE(started_at, ?) WHERE id=?",
            now_str,
            now_str,
            job_id,
        )
        return r.changes

    moved = tx(_run_now_tx)
    refresh_job(job_id)
    log.info(f"Chay ngay chien dich #{job_id} ({moved} luot dang)")
    return {'ok': True, 'moved': moved}

@router.post('/jobs/{job_id}/retry-failed')
async def retry_failed_job(job_id: int):
    if not get("SELECT id FROM jobs WHERE id = ?", job_id):
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")

    retried = run(
        """UPDATE job_items SET status='pending', attempts=0, error='', finished_at=NULL, run_at=?
            WHERE job_id = ? AND status = 'failed'""",
        now_iso(),
        job_id,
    )
    run("UPDATE jobs SET status='running', finished_at=NULL WHERE id = ?", job_id)
    refresh_job(job_id)
    log.info(f"Thu lai {retried.changes} luot dang that bai cua chien dich #{job_id}")
    return {'ok': True, 'retried': retried.changes}

@router.delete('/jobs/{job_id}')
async def delete_job(job_id: int):
    if not get("SELECT id FROM jobs WHERE id = ?", job_id):
        raise HTTPException(status_code=404, detail="Khong tim thay chien dich")
    run("DELETE FROM jobs WHERE id = ?", job_id)
    return {'ok': True}

@router.post('/jobs/preview')
async def preview_job(req: Request):
    body = await req.json()
    project_id = body.get('projectId')

    if body.get('postIds'):
        post_count = len(body['postIds'])
    else:
        row = get(
            f"SELECT COUNT(*) AS c FROM posts {'WHERE project_id = ?' if project_id else ''}",
            *([project_id] if project_id else [])
        )
        post_count = row['c'] if row else 0

    if body.get('targetIds'):
        target_count = len(body['targetIds'])
    else:
        where = ['t.enabled = 1', 'a.enabled = 1']
        params = []
        if project_id:
            where.append('t.project_id = ?')
            params.append(project_id)
        if body.get('accountId'):
            where.append('t.account_id = ?')
            params.append(int(body['accountId']))
        row = get(
            f"SELECT COUNT(*) AS c FROM targets t JOIN accounts a ON a.id = t.account_id WHERE {' AND '.join(where)}",
            *params,
        )
        target_count = row['c'] if row else 0

    strategy = str(body.get('strategy') or 'cross')
    if strategy == 'cross':
        items = post_count * target_count
    elif strategy == 'zip':
        items = min(post_count, target_count)
    else:
        items = min(post_count, target_count) * max(1, math.ceil(post_count / max(1, target_count)))

    return {
        'postCount': post_count,
        'targetCount': target_count,
        'strategy': strategy,
        'items': items,
    }

# --------------------------------------------------------------------------- #
# Reports                                                                     #
# --------------------------------------------------------------------------- #

@router.get('/reports/summary')
async def get_report_summary(days: int = 30):
    days_clamped = min(180, max(1, days))
    since = (datetime.now(timezone.utc) - timedelta(days=days_clamped)).isoformat().replace('+00:00', 'Z')

    overall = get(
        """SELECT
             COUNT(*) AS total,
             COALESCE(SUM(status='success'),0) AS success,
             COALESCE(SUM(status='failed'),0)  AS failed,
             COALESCE(SUM(status='skipped'),0) AS skipped,
             COALESCE(SUM(status IN ('pending','running')),0) AS pending
           FROM job_items WHERE COALESCE(finished_at, started_at, run_at) >= ?""",
        since,
    ) or {}

    by_day = all_rows(
        """SELECT substr(COALESCE(finished_at, started_at), 1, 10) AS day,
                  COALESCE(SUM(status='success'),0) AS success,
                  COALESCE(SUM(status='failed'),0)  AS failed
             FROM job_items
            WHERE COALESCE(finished_at, started_at) >= ?
            GROUP BY day ORDER BY day ASC""",
        since,
    )

    by_platform = all_rows(
        """SELECT a.platform,
                  COUNT(*) AS total,
                  COALESCE(SUM(i.status='success'),0) AS success,
                  COALESCE(SUM(i.status='failed'),0)  AS failed
             FROM job_items i JOIN accounts a ON a.id = i.account_id
            WHERE i.finished_at >= ?
            GROUP BY a.platform ORDER BY total DESC""",
        since,
    )

    by_account = all_rows(
        """SELECT a.id, a.label, a.platform,
                  COUNT(*) AS total,
                  COALESCE(SUM(i.status='success'),0) AS success,
                  COALESCE(SUM(i.status='failed'),0)  AS failed
             FROM job_items i JOIN accounts a ON a.id = i.account_id
            WHERE i.finished_at >= ?
            GROUP BY a.id ORDER BY total DESC""",
        since,
    )

    by_job = all_rows(
        """SELECT j.id, j.name, j.status, j.dry_run, j.scheduled_at, j.finished_at,
                  j.total, j.success_count, j.failed_count, j.skipped_count
             FROM jobs j
            WHERE j.created_at >= ?
            ORDER BY j.id DESC LIMIT 50""",
        since,
    )

    top_errors = all_rows(
        """SELECT substr(error, 1, 160) AS error, COUNT(*) AS count
             FROM job_items
            WHERE status = 'failed' AND error <> '' AND finished_at >= ?
            GROUP BY substr(error, 1, 160)
            ORDER BY count DESC LIMIT 15""",
        since,
    )

    return {
        'days': days_clamped,
        'since': since,
        'overall': overall,
        'byDay': by_day,
        'byPlatform': by_platform,
        'byAccount': by_account,
        'byJob': by_job,
        'topErrors': top_errors,
    }

# --------------------------------------------------------------------------- #
# Projects                                                                    #
# --------------------------------------------------------------------------- #

@router.get('/projects')
async def list_projects():
    projects = all_rows("""
        SELECT p.*,
               (SELECT COUNT(*) FROM accounts a WHERE a.project_id = p.id) AS accounts,
               (SELECT COUNT(*) FROM targets t WHERE t.project_id = p.id)  AS targets,
               (SELECT COUNT(*) FROM posts ps WHERE ps.project_id = p.id)  AS posts,
               (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id)     AS jobs
          FROM projects p ORDER BY p.id
    """)
    return {'projects': projects}

@router.post('/projects', status_code=201)
async def create_project(req: Request):
    body = await req.json()
    name = str(body.get('name') or '').strip()
    if not name:
        raise HTTPException(status_code=400, detail="Thieu truong bat buoc: name")

    if get("SELECT id FROM projects WHERE name = ?", name):
        raise HTTPException(status_code=400, detail="Ten du an da ton tai")

    pid = insert('projects', {
        'name': name,
        'description': str(body.get('description') or ''),
        'color': str(body.get('color') or '#4f8cff'),
        'created_at': now_iso(),
    })
    return {'project': get("SELECT * FROM projects WHERE id = ?", pid)}

@router.delete('/projects/{project_id}')
async def delete_project(project_id: int):
    if not get("SELECT id FROM projects WHERE id = ?", project_id):
        raise HTTPException(status_code=404, detail="Khong tim thay du an")
    run("DELETE FROM projects WHERE id = ?", project_id)
    return {'ok': True}

# --------------------------------------------------------------------------- #
# Calendar                                                                    #
# --------------------------------------------------------------------------- #

@router.get('/calendar')
async def get_calendar(
    month: Optional[str] = None,
    projectId: Optional[int] = None,
    accountId: Optional[int] = None,
    platform: Optional[str] = None
):
    if not month or not re.match(r'^\d{4}-\d{2}$', month):
        now_vn = datetime.now(timezone(timedelta(hours=7)))
        month = f"{now_vn.year:04d}-{now_vn.month:02d}"

    year, m = map(int, month.split('-'))
    tz_vn = timezone(timedelta(hours=7))
    start_local = datetime(year, m, 1, 0, 0, 0, tzinfo=tz_vn)
    if m == 12:
        end_local = datetime(year + 1, 1, 1, 0, 0, 0, tzinfo=tz_vn) - timedelta(seconds=1)
    else:
        end_local = datetime(year, m + 1, 1, 0, 0, 0, tzinfo=tz_vn) - timedelta(seconds=1)

    start_iso = start_local.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    end_iso = end_local.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')

    where = ["i.run_at >= ?", "i.run_at <= ?"]
    params = [start_iso, end_iso]

    if projectId:
        where.append("j.project_id = ?")
        params.append(projectId)
    if accountId:
        where.append("i.account_id = ?")
        params.append(accountId)
    if platform:
        where.append("a.platform = ?")
        params.append(platform)

    where_clause = f"WHERE {' AND '.join(where)}"
    sql = f"""
        SELECT i.id, i.job_id, i.status, i.run_at, i.started_at, i.finished_at, i.error, i.remote_url,
               p.id AS post_id, p.title AS post_title, p.caption AS post_caption, p.media AS post_media,
               t.id AS target_id, t.name AS target_name, t.kind AS target_kind,
               a.id AS account_id, a.label AS account_label, a.platform,
               j.name AS job_name, j.dry_run, j.recurring_type, j.recurring_time, j.recurring_days
          FROM job_items i
          JOIN jobs j     ON j.id = i.job_id
          JOIN posts p    ON p.id = i.post_id
          JOIN targets t  ON t.id = i.target_id
          JOIN accounts a ON a.id = i.account_id
         {where_clause}
         ORDER BY i.run_at ASC
    """
    items = all_rows(sql, *params)
    for it in items:
        try:
            it['post_media'] = json.loads(it['post_media']) if it.get('post_media') else []
        except Exception:
            it['post_media'] = []

    # Projected recurring runs for active recurring jobs in this month
    rec_jobs = all_rows("""
        SELECT j.*,
               (SELECT COUNT(*) FROM job_items WHERE job_id = j.id) AS pair_count
          FROM jobs j
         WHERE j.status IN ('scheduled', 'running')
           AND j.recurring_type IN ('daily', 'weekly', 'monthly')
    """)

    projections = []
    for rj in rec_jobs:
        if projectId and rj.get('project_id') != projectId:
            continue
        proj_dts = get_projected_runs(
            rj['recurring_type'],
            rj.get('recurring_time') or '',
            rj.get('recurring_days'),
            start_local.astimezone(timezone.utc),
            end_local.astimezone(timezone.utc),
            max_count=35
        )
        for pdt in proj_dts:
            p_iso = pdt.isoformat().replace('+00:00', 'Z')
            projections.append({
                'job_id': rj['id'],
                'job_name': rj['name'],
                'recurring_type': rj['recurring_type'],
                'recurring_time': rj['recurring_time'],
                'run_at': p_iso,
                'dry_run': rj['dry_run'],
                'projected': True
            })

    return {
        'month': month,
        'items': items,
        'projections': projections,
        'total': len(items)
    }

