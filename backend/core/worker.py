import asyncio
import random
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Dict, List, Optional, Set
from backend.config import config
from backend.db import all_rows, get, run, now_iso
from backend.logger import create_logger
from backend.core.runner import run_item, BlockerError
from backend.core.recurring import compute_next_run

log = create_logger('worker')

_in_flight: Dict[int, asyncio.Task] = {}
_worker_task: Optional[asyncio.Task] = None
_stopping = False
_last_tick_at: Optional[str] = None
_started_at: Optional[str] = None

def rand_int(min_val: int, max_val: int) -> int:
    lo = min(min_val, max_val)
    hi = max(min_val, max_val)
    return random.randint(lo, hi)

def worker_status() -> dict:
    return {
        'running': len(_in_flight),
        'concurrency': config.worker.concurrency,
        'lastTickAt': _last_tick_at,
        'startedAt': _started_at,
        'items': list(_in_flight.keys()),
    }

def start_worker():
    global _worker_task, _stopping, _started_at
    if _worker_task and not _worker_task.done():
        return
    _stopping = False
    _started_at = now_iso()
    _worker_task = asyncio.create_task(_worker_loop())
    log.info(f"Worker khoi dong (concurrency={config.worker.concurrency}, tick={config.worker.tick_ms}ms)")

async def stop_worker(drain: bool = True, timeout_ms: int = 60000):
    global _stopping, _worker_task
    _stopping = True
    if _worker_task:
        _worker_task.cancel()
        try:
            await _worker_task
        except asyncio.CancelledError:
            pass
        _worker_task = None

    if drain and _in_flight:
        log.info(f"Cho {len(_in_flight)} tac vu dang chay hoan tat...")
        tasks = list(_in_flight.values())
        if tasks:
            done, pending = await asyncio.wait(tasks, timeout=timeout_ms / 1000.0)
            for t in pending:
                t.cancel()

async def _worker_loop():
    while not _stopping:
        try:
            await _tick()
        except asyncio.CancelledError:
            break
        except Exception as err:
            log.error(f"Loi trong tick: {err}")
        await asyncio.sleep(config.worker.tick_ms / 1000.0)

async def _tick():
    global _last_tick_at
    if _stopping:
        return
    now = now_iso()
    _last_tick_at = now

    activated = run(
        """UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?)
           WHERE status = 'scheduled' AND scheduled_at <= ?""",
        now,
        now,
    )
    if activated.changes:
        log.info(f"Kich hoat {activated.changes} chien dich den han")

    slots = config.worker.concurrency - len(_in_flight)
    if slots <= 0:
        return

    items = _claim_items(slots, now)
    for item in items:
        item_id = item['id']
        task = asyncio.create_task(_execute_wrapper(item))
        _in_flight[item_id] = task

async def _execute_wrapper(item: dict):
    item_id = item['id']
    try:
        await _execute(item)
    except Exception as err:
        log.error(f"Item #{item_id} loi khong xu ly duoc: {err}")
    finally:
        _in_flight.pop(item_id, None)

def _claim_items(limit: int, now: str) -> List[dict]:
    rows = all_rows(
        """SELECT i.*, j.dry_run, j.min_delay_sec AS job_min_delay, j.max_delay_sec AS job_max_delay,
                  j.max_attempts AS job_max_attempts, j.status AS job_status
             FROM job_items i
             JOIN jobs j     ON j.id = i.job_id
             JOIN accounts a ON a.id = i.account_id
            WHERE i.status = 'pending'
              AND i.run_at <= ?
              AND j.status = 'running'
              AND a.enabled = 1
              AND i.account_id NOT IN (SELECT account_id FROM job_items WHERE status = 'running')
            ORDER BY i.run_at ASC, i.id ASC
            LIMIT ?""",
        now,
        limit,
    )

    if not rows:
        return []

    stmt = "UPDATE job_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'"
    claimed = []
    for row in rows:
        res = run(stmt, now, row['id'])
        if res.changes == 1:
            claimed.append(row)
    return claimed

async def _execute(item: dict):
    job = get('SELECT * FROM jobs WHERE id = ?', item['job_id'])
    account = get('SELECT * FROM accounts WHERE id = ?', item['account_id'])
    target = get('SELECT * FROM targets WHERE id = ?', item['target_id'])
    post = get('SELECT * FROM posts WHERE id = ?', item['post_id'])

    if not job or not account or not target or not post:
        _mark_failed(item, 'Du lieu khong con ton tai (job/account/target/post da bi xoa).')
        return

    if job['status'] != 'running':
        run("UPDATE job_items SET status = 'pending', started_at = NULL WHERE id = ?", item['id'])
        return

    capped = _check_daily_cap(account, item)
    if capped in ('deferred', 'exhausted'):
        return

    min_delay = item.get('job_min_delay') or account.get('min_delay_sec') or config.worker.default_min_delay_sec
    max_delay = item.get('job_max_delay') or account.get('max_delay_sec') or config.worker.default_max_delay_sec
    max_attempts = item.get('job_max_attempts') or item.get('max_attempts') or config.worker.default_max_attempts

    try:
        result = await run_item(
            account=account,
            target=target,
            post=post,
            job=job,
            dry_run=bool(job.get('dry_run')),
        )

        now_str = now_iso()
        run(
            "UPDATE job_items SET status='success', finished_at=?, remote_url=?, error='' WHERE id=?",
            now_str,
            result.get('remoteUrl') or '',
            item['id'],
        )
        run("UPDATE targets SET last_post_at=? WHERE id=?", now_str, target['id'])
        log.info(
            f"{'[THU] ' if job.get('dry_run') else ''}THANH CONG: bai #{post['id']} -> {target['name']} ({account['label']})",
            {'accountId': account['id'], 'jobId': job['id'], 'itemId': item['id']},
        )
        _pace_next_for_account(account['id'], min_delay, max_delay)
    except Exception as err:
        await _handle_failure(item, job, account, err, max_attempts, min_delay, max_delay)

    refresh_job(job['id'])

def _mark_failed(item: dict, message: str):
    run(
        "UPDATE job_items SET status='failed', finished_at=?, error=? WHERE id=?",
        now_iso(),
        message,
        item['id'],
    )
    refresh_job(item['job_id'])

async def _handle_failure(item: dict, job: dict, account: dict, err: Exception, max_attempts: int, min_delay: int, max_delay: int):
    attempts = item['attempts'] + 1
    message = str(err)[:1000]
    kind = getattr(err, 'kind', None) or _classify(message)

    if kind == 'auth':
        run(
            "UPDATE accounts SET status='expired', status_message=?, last_check_at=? WHERE id=?",
            message,
            now_iso(),
            account['id'],
        )
        log.error(f"Phien dang nhap het han voi {account['label']}: {message}", {
            'accountId': account['id'],
            'jobId': job['id'],
            'itemId': item['id'],
        })
        paused = run(
            """UPDATE jobs SET status='paused'
                WHERE status='running'
                  AND id IN (SELECT DISTINCT job_id FROM job_items WHERE account_id=? AND status='pending')""",
            account['id'],
        )
        if paused.changes:
            log.warn(f"Da tam dung {paused.changes} chien dich do account het phien dang nhap.")

    if kind == 'rate_limit':
        wait_sec = rand_int(15 * 60, 45 * 60)
        next_run = (datetime.now(timezone.utc) + timedelta(seconds=wait_sec)).isoformat().replace('+00:00', 'Z')
        run(
            "UPDATE job_items SET status='pending', attempts=?, started_at=NULL, run_at=?, error=? WHERE id=?",
            attempts,
            next_run,
            message,
            item['id'],
        )
        log.warn(f"Bi gioi han tan suat - hoan lai sau {round(wait_sec / 60)} phut: {message}", {
            'accountId': account['id'],
            'jobId': job['id'],
            'itemId': item['id'],
        })
        return

    if attempts < max_attempts and kind != 'blocked':
        backoff_sec = min(30 * 60, 60 * (2 ** (attempts - 1))) + rand_int(0, 30)
        next_run = (datetime.now(timezone.utc) + timedelta(seconds=backoff_sec)).isoformat().replace('+00:00', 'Z')
        run(
            "UPDATE job_items SET status='pending', attempts=?, started_at=NULL, run_at=?, error=? WHERE id=?",
            attempts,
            next_run,
            message,
            item['id'],
        )
        log.warn(
            f"That bai (lan {attempts}/{max_attempts}) - thu lai sau {round(backoff_sec / 60)} phut: {message}",
            {'accountId': account['id'], 'jobId': job['id'], 'itemId': item['id']},
        )
        _pace_next_for_account(account['id'], min_delay, max_delay)
        return

    now_str = now_iso()
    run(
        "UPDATE job_items SET status='failed', attempts=?, finished_at=?, error=? WHERE id=?",
        attempts,
        now_str,
        message,
        item['id'],
    )
    shot_match = re.search(r'\[anh loi: ([^\]]+)\]', message)
    if shot_match:
        run("UPDATE job_items SET screenshot=? WHERE id=?", shot_match.group(1), item['id'])

    log.error(f"THAT BAI: bai #{item['post_id']} -> target #{item['target_id']}: {message}", {
        'accountId': account['id'],
        'jobId': job['id'],
        'itemId': item['id'],
    })
    _pace_next_for_account(account['id'], min_delay, max_delay)

def _classify(message: str) -> str:
    m = message.lower()
    if re.search(r'het han|expired|dang nhap|log ?in|login', m):
        return 'auth'
    if re.search(r'gioi han|rate|temporarily blocked|flood|too many', m):
        return 'rate_limit'
    if re.search(r'bi chan|blocked', m):
        return 'blocked'
    return 'error'

def _check_daily_cap(account: dict, item: dict) -> Optional[str]:
    limit = account.get('daily_limit') or config.worker.default_daily_limit
    if not limit or limit <= 0:
        return None

    today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat().replace('+00:00', 'Z')
    row = get(
        "SELECT COUNT(*) AS c FROM job_items WHERE account_id = ? AND status = 'success' AND finished_at >= ?",
        account['id'],
        today_start,
    )
    if (row.get('c') or 0) < limit:
        return None

    if item.get('defers', 0) >= config.worker.max_defers:
        run(
            "UPDATE job_items SET status='skipped', finished_at=?, error=? WHERE id=?",
            now_iso(),
            f"Da dat gioi han {limit} bai/ngay cua account.",
            item['id'],
        )
        log.warn(f"Bo qua item #{item['id']}: account {account['label']} da dat gioi han {limit} bai/ngay", {
            'accountId': account['id'],
            'jobId': item['job_id'],
            'itemId': item['id'],
        })
        return 'exhausted'

    tomorrow = datetime.now(timezone.utc) + timedelta(days=1)
    tomorrow = tomorrow.replace(hour=7, minute=rand_int(0, 59), second=0, microsecond=0)
    run(
        "UPDATE job_items SET status='pending', defers=defers+1, run_at=?, started_at=NULL, error=? WHERE id=?",
        tomorrow.isoformat().replace('+00:00', 'Z'),
        f"Hoan sang ngay mai: da dat gioi han {limit} bai/ngay.",
        item['id'],
    )
    log.info(f"Hoan item #{item['id']} sang {tomorrow} (gioi han ngay)", {
        'accountId': account['id'],
        'jobId': item['job_id'],
        'itemId': item['id'],
    })
    return 'deferred'

def _pace_next_for_account(account_id: int, min_delay: int, max_delay: int):
    next_item = get(
        "SELECT id, run_at FROM job_items WHERE account_id = ? AND status = 'pending' ORDER BY run_at ASC, id ASC LIMIT 1",
        account_id,
    )
    if not next_item:
        return
    delay = rand_int(min_delay, max_delay)
    earliest = (datetime.now(timezone.utc) + timedelta(seconds=delay)).isoformat().replace('+00:00', 'Z')
    if next_item['run_at'] < earliest:
        run("UPDATE job_items SET run_at = ? WHERE id = ?", earliest, next_item['id'])

def refresh_job(job_id: int):
    job = get('SELECT * FROM jobs WHERE id = ?', job_id)
    if not job:
        return

    c = get(
        """SELECT
             COALESCE(SUM(status='pending'),0)  AS pending,
             COALESCE(SUM(status='running'),0)  AS running,
             COALESCE(SUM(status='success'),0)  AS success,
             COALESCE(SUM(status='failed'),0)   AS failed,
             COALESCE(SUM(status='skipped'),0)  AS skipped,
             COALESCE(SUM(status='canceled'),0) AS canceled,
             COUNT(*) AS total
           FROM job_items WHERE job_id = ?""",
        job_id,
    )

    active = (c.get('pending') or 0) + (c.get('running') or 0)
    status = job['status']
    finished_at = job.get('finished_at')

    if active == 0:
        if job['status'] in ('running', 'scheduled'):
            # Check if this job has a recurring schedule configured
            rec_type = str(job.get('recurring_type') or 'none').lower()
            rec_end = job.get('recurring_end_at')
            max_cycles = job.get('max_cycles') or 0
            cur_count = (job.get('recurring_count') or 0) + 1

            should_recur = (
                rec_type in ('daily', 'weekly', 'monthly')
                and (max_cycles <= 0 or cur_count < max_cycles)
                and (not rec_end or now_iso() < rec_end)
            )

            if should_recur:
                next_dt = compute_next_run(
                    rec_type,
                    job.get('recurring_time') or '',
                    job.get('recurring_days'),
                    from_dt=datetime.now(timezone.utc)
                )

                if next_dt and (not rec_end or next_dt.isoformat().replace('+00:00', 'Z') <= rec_end):
                    next_iso = next_dt.isoformat().replace('+00:00', 'Z')
                    # Re-create distinct pairs from current job items
                    pairs = all_rows("""
                        SELECT DISTINCT account_id, target_id, post_id
                        FROM job_items WHERE job_id = ?
                    """, job_id)

                    account_index = {}
                    for p in pairs:
                        if p['account_id'] not in account_index:
                            account_index[p['account_id']] = len(account_index)

                    for pair in pairs:
                        offset_sec = account_index.get(pair['account_id'], 0) * rand_int(5, 30)
                        item_run_at = (next_dt + timedelta(seconds=offset_sec)).isoformat().replace('+00:00', 'Z')
                        run("""
                            INSERT INTO job_items (job_id, account_id, target_id, post_id, status, attempts, max_attempts, defers, run_at)
                            VALUES (?, ?, ?, ?, 'pending', 0, ?, 0, ?)
                        """, job_id, pair['account_id'], pair['target_id'], pair['post_id'], job.get('max_attempts') or 3, item_run_at)

                    new_counts = get("""
                        SELECT COUNT(*) AS total,
                               COALESCE(SUM(status='success'),0) AS success,
                               COALESCE(SUM(status='failed'),0) AS failed,
                               COALESCE(SUM(status='skipped'),0) AS skipped
                        FROM job_items WHERE job_id = ?
                    """, job_id) or {}

                    run("""
                        UPDATE jobs SET status = 'scheduled', scheduled_at = ?, recurring_count = ?, finished_at = NULL,
                                        total = ?, success_count = ?, failed_count = ?, skipped_count = ?
                        WHERE id = ?
                    """, next_iso, cur_count, new_counts.get('total') or 0, new_counts.get('success') or 0, new_counts.get('failed') or 0, new_counts.get('skipped') or 0, job_id)

                    log.info(
                        f"Chien dich #{job_id} '{job['name']}' da len lich chu ky #{cur_count + 1} ({rec_type}) vao luc {next_iso}"
                    )
                    return

            # Non-recurring or recurring completed
            status = 'done' if (c.get('success') or 0) > 0 or (c.get('failed') or 0) == 0 else 'failed'
            finished_at = now_iso()
            log.info(
                f"Chien dich #{job_id} '{job['name']}' ket thuc: {c.get('success')} thanh cong, {c.get('failed')} that bai, {c.get('skipped')} bo qua."
            )

    run(
        """UPDATE jobs SET status=?, total=?, success_count=?, failed_count=?, skipped_count=?, finished_at=? WHERE id=?""",
        status,
        c.get('total') or 0,
        c.get('success') or 0,
        c.get('failed') or 0,
        c.get('skipped') or 0,
        finished_at,
        job_id,
    )

def touch_job(job_id: int):
    refresh_job(job_id)
