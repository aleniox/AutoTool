import asyncio
import json
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Request, HTTPException, Response
from backend.config import config
from backend.db import all_rows, get, run, insert, update, now_iso, parse_json, get_setting
from backend.platforms import get_platform, has_platform, parse_target_url, kind_label
from backend.core.browser import open_login_window, probe_session, close_account, profile_dir_for, is_open
from backend.logger import create_logger

router = APIRouter()
log = create_logger('api:accounts')

# --------------------------------------------------------------------------- #
# Accounts                                                                    #
# --------------------------------------------------------------------------- #

@router.get('/accounts')
async def list_accounts(projectId: Optional[int] = None):
    where = "WHERE a.project_id = ?" if projectId else ""
    params = [projectId] if projectId else []

    today_dt = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    today_iso = today_dt.isoformat().replace('+00:00', 'Z')

    sql = f"""
        SELECT a.*,
               p.name AS project_name,
               (SELECT COUNT(*) FROM targets t WHERE t.account_id = a.id) AS target_count,
               (SELECT COUNT(*) FROM targets t WHERE t.account_id = a.id AND t.enabled = 1) AS enabled_target_count,
               (SELECT COUNT(*) FROM job_items i
                 WHERE i.account_id = a.id AND i.status = 'success' AND i.finished_at >= ?) AS posted_today
          FROM accounts a
          LEFT JOIN projects p ON p.id = a.project_id
          {where}
         ORDER BY a.id DESC
    """
    rows = all_rows(sql, today_iso, *params)

    result = []
    for r in rows:
        plat_id = r.get('platform')
        has_plat = has_platform(plat_id)
        plat = get_platform(plat_id) if has_plat else None
        item = dict(r)
        item['meta'] = parse_json(r.get('meta'), {})
        item['browserOpen'] = is_open(r['id'])
        item['platformName'] = plat['name'] if plat else plat_id
        item['platformColor'] = plat['color'] if plat else '#888'
        result.append(item)

    return {'accounts': result}

@router.post('/accounts', status_code=201)
async def create_account(req: Request):
    body = await req.json()
    platform_id = str(body.get('platform') or '').lower()
    label = str(body.get('label') or '').strip()

    if not platform_id or not label:
        raise HTTPException(status_code=400, detail="Thieu truong bat buoc: platform, label")

    if not has_platform(platform_id):
        raise HTTPException(status_code=400, detail=f"Nen tang khong duoc ho tro: {platform_id}")

    platform = get_platform(platform_id)
    dupe = get("SELECT id FROM accounts WHERE platform = ? AND label = ?", platform_id, label)
    if dupe:
        raise HTTPException(status_code=400, detail=f"Da ton tai tai khoan '{label}' tren {platform['name']}")

    settings = get_setting('settings', {}) or {}
    acc_id = insert('accounts', {
        'project_id': body.get('projectId'),
        'platform': platform_id,
        'label': label,
        'profile_dir': '',
        'status': 'new',
        'status_message': 'Chua dang nhap',
        'daily_limit': body.get('dailyLimit') or settings.get('defaultDailyLimit') or config.worker.default_daily_limit,
        'min_delay_sec': body.get('minDelaySec') or settings.get('defaultMinDelaySec') or config.worker.default_min_delay_sec,
        'max_delay_sec': body.get('maxDelaySec') or settings.get('defaultMaxDelaySec') or config.worker.default_max_delay_sec,
        'enabled': 0 if body.get('enabled') is False else 1,
        'meta': json.dumps(body.get('meta') or {}),
        'created_at': now_iso(),
    })

    account = get("SELECT * FROM accounts WHERE id = ?", acc_id)
    run("UPDATE accounts SET profile_dir = ? WHERE id = ?", profile_dir_for(account), acc_id)

    created_target = None
    if not platform.get('targetKinds'):
        tid = insert('targets', {
            'project_id': body.get('projectId'),
            'account_id': acc_id,
            'platform': platform_id,
            'kind': 'profile',
            'external_id': '',
            'name': label,
            'url': platform.get('homeUrl', ''),
            'enabled': 1,
            'meta': '{}',
            'created_at': now_iso(),
        })
        created_target = get("SELECT * FROM targets WHERE id = ?", tid)

    log.info(f"Tao tai khoan #{acc_id} {platform['name']}/{label}")
    return {
        'account': get("SELECT * FROM accounts WHERE id = ?", acc_id),
        'target': created_target,
    }

@router.patch('/accounts/{acc_id}')
async def update_account(acc_id: int, req: Request):
    account = get("SELECT * FROM accounts WHERE id = ?", acc_id)
    if not account:
        raise HTTPException(status_code=404, detail="Khong tim thay tai khoan")

    body = await req.json()
    patch = {}

    if 'label' in body:
        label = str(body['label']).strip()
        if not label:
            raise HTTPException(status_code=400, detail="Nhan tai khoan khong duoc de trong")
        dupe = get(
            "SELECT id FROM accounts WHERE platform = ? AND label = ? AND id <> ?",
            account['platform'],
            label,
            acc_id,
        )
        if dupe:
            raise HTTPException(status_code=400, detail=f"Da ton tai tai khoan '{label}'")
        patch['label'] = label

    if 'projectId' in body:
        patch['project_id'] = body['projectId']
    if 'dailyLimit' in body:
        patch['daily_limit'] = max(0, int(body['dailyLimit']))
    if 'minDelaySec' in body:
        patch['min_delay_sec'] = max(0, int(body['minDelaySec']))
    if 'maxDelaySec' in body:
        patch['max_delay_sec'] = max(0, int(body['maxDelaySec']))
    if 'enabled' in body:
        patch['enabled'] = 1 if body['enabled'] else 0
    if 'meta' in body:
        patch['meta'] = json.dumps(body['meta'] or {})

    min_delay = patch.get('min_delay_sec', account['min_delay_sec'])
    max_delay = patch.get('max_delay_sec', account['max_delay_sec'])
    if max_delay < min_delay:
        raise HTTPException(status_code=400, detail="maxDelaySec phai lon hon hoac bang minDelaySec")

    if patch:
        update('accounts', acc_id, patch)

    return {'account': get("SELECT * FROM accounts WHERE id = ?", acc_id)}

@router.delete('/accounts/{acc_id}')
async def delete_account(acc_id: int):
    account = get("SELECT * FROM accounts WHERE id = ?", acc_id)
    if not account:
        raise HTTPException(status_code=404, detail="Khong tim thay tai khoan")

    await close_account(acc_id)
    run("DELETE FROM accounts WHERE id = ?", acc_id)

    profile_removed = False
    dir_path = Path(account.get('profile_dir') or profile_dir_for(account))
    profiles_root = Path(config.paths['profiles']).resolve()

    if dir_path.is_relative_to(profiles_root) and dir_path.exists():
        for attempt in range(1, 6):
            try:
                shutil.rmtree(dir_path, ignore_errors=False)
                profile_removed = True
                break
            except Exception as err:
                if attempt == 5:
                    log.warn(f"Da xoa tai khoan #{acc_id} nhung khong xoa duoc profile {dir_path}: {err}")
                else:
                    await asyncio.sleep(0.25 * attempt)

    log.info(f"Xoa tai khoan #{acc_id}{' (kem profile trinh duyet)' if profile_removed else ''}")
    return {'ok': True, 'profileRemoved': profile_removed}

@router.post('/accounts/{acc_id}/login', status_code=202)
async def login_account(acc_id: int):
    if not config.allow_login_window:
        raise HTTPException(status_code=400, detail="Chuc nang mo cua so dang nhap dang bi tat (ALLOW_LOGIN_WINDOW=false)")

    account = get("SELECT * FROM accounts WHERE id = ?", acc_id)
    if not account:
        raise HTTPException(status_code=404, detail="Khong tim thay tai khoan")
    platform = get_platform(account['platform'])

    run(
        "UPDATE accounts SET status = 'pending_login', status_message = ?, last_check_at = ? WHERE id = ?",
        'Dang cho dang nhap trong cua so trinh duyet...',
        now_iso(),
        acc_id,
    )

    async def _async_open():
        try:
            r = await open_login_window(account, url=platform.get('loginUrl'))
            run(
                "UPDATE accounts SET status = 'awaiting_login', status_message = ? WHERE id = ?",
                'Cua so dang nhap da mo (dung lai)' if r.get('reused') else 'Da mo cua so dang nhap. Hay dang nhap roi bam "Kiem tra phien".',
                acc_id,
            )
        except Exception as err:
            run("UPDATE accounts SET status = 'error', status_message = ? WHERE id = ?", str(err), acc_id)
            log.error(f"Khong mo duoc cua so dang nhap: {err}")

    asyncio.create_task(_async_open())

    return {
        'ok': True,
        'message': f"Dang mo trinh duyet toi {platform.get('loginUrl')}. Hay dang nhap trong cua so vua mo, roi bam 'Kiem tra phien'.",
        'loginUrl': platform.get('loginUrl'),
    }

@router.post('/accounts/{acc_id}/check')
async def check_account_session(acc_id: int):
    account = get("SELECT * FROM accounts WHERE id = ?", acc_id)
    if not account:
        raise HTTPException(status_code=404, detail="Khong tim thay tai khoan")
    platform = get_platform(account['platform'])

    result = await probe_session(account, platform)
    status = 'expired' if result.get('status') == 'logged_out' else result.get('status')
    run(
        "UPDATE accounts SET status = ?, status_message = ?, last_check_at = ? WHERE id = ?",
        status,
        result.get('message', ''),
        now_iso(),
        acc_id,
    )
    log.info(f"Kiem tra phien {account['label']}: {result.get('status')} - {result.get('message')}")
    return {'result': result, 'account': get("SELECT * FROM accounts WHERE id = ?", acc_id)}

@router.post('/accounts/{acc_id}/close')
async def close_account_session(acc_id: int):
    closed = await close_account(acc_id)
    return {'ok': True, 'closed': closed}

# --------------------------------------------------------------------------- #
# Targets                                                                     #
# --------------------------------------------------------------------------- #

@router.get('/targets')
async def list_targets(accountId: Optional[int] = None, projectId: Optional[int] = None, kind: Optional[str] = None):
    where = []
    params = []
    if accountId:
        where.append("t.account_id = ?")
        params.append(accountId)
    if projectId:
        where.append("t.project_id = ?")
        params.append(projectId)
    if kind and kind != 'all':
        where.append("t.kind = ?")
        params.append(kind)

    where_clause = f"WHERE {' AND '.join(where)}" if where else ''
    sql = f"""
        SELECT t.*, a.label AS account_label, a.platform AS account_platform, a.status AS account_status
          FROM targets t
          JOIN accounts a ON a.id = t.account_id
          {where_clause}
         ORDER BY t.account_id, t.name COLLATE NOCASE
    """
    rows = all_rows(sql, *params)
    targets = []
    for r in rows:
        item = dict(r)
        item['meta'] = parse_json(r.get('meta'), {})
        item['kindLabel'] = kind_label(r.get('kind', 'group'))
        targets.append(item)

    return {'targets': targets}

@router.post('/targets', status_code=201)
async def create_target(req: Request):
    body = await req.json()
    account_id = body.get('accountId')
    name = str(body.get('name') or '').strip()

    if not account_id or not name:
        raise HTTPException(status_code=400, detail="Thieu truong bat buoc: accountId, name")

    account = get("SELECT * FROM accounts WHERE id = ?", int(account_id))
    if not account:
        raise HTTPException(status_code=404, detail="Khong tim thay tai khoan")

    url = str(body.get('url') or '').strip()
    parsed = parse_target_url(url, platform_hint=account['platform']) if url else None

    tid = insert('targets', {
        'project_id': body.get('projectId') or account.get('project_id'),
        'account_id': account['id'],
        'platform': account['platform'],
        'kind': str(body.get('kind') or (parsed.get('kind') if parsed else 'group')),
        'external_id': str(body.get('externalId') or (parsed.get('externalId') if parsed else '')),
        'name': name,
        'url': url,
        'enabled': 0 if body.get('enabled') is False else 1,
        'meta': json.dumps(body.get('meta') or {}),
        'created_at': now_iso(),
    })

    return {'target': get("SELECT * FROM targets WHERE id = ?", tid), 'parsed': parsed}

@router.post('/targets/import')
async def import_targets(req: Request):
    body = await req.json()
    account_id = body.get('accountId')
    text = str(body.get('text') or '').strip()

    if not account_id or not text:
        raise HTTPException(status_code=400, detail="Thieu truong bat buoc: accountId, text")

    account = get("SELECT * FROM accounts WHERE id = ?", int(account_id))
    if not account:
        raise HTTPException(status_code=404, detail="Khong tim thay tai khoan")

    project_id = body.get('projectId') or account.get('project_id')
    kind_override = str(body['kind']) if body.get('kind') and body['kind'] != 'auto' else None

    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.strip().startswith('#')]
    imported = []
    skipped = []

    for line in lines:
        parts = [p.strip() for p in line.split('|')]
        url = next((p for p in parts if p.lower().startswith(('http://', 'https://')) or p.startswith('@')), '')
        name = next((p for p in parts if p != url), '')

        if not url and len(parts) == 1:
            name = parts[0]

        parsed = parse_target_url(url, platform_hint=account['platform']) if url else None
        if url and not parsed:
            skipped.append({'line': line, 'reason': 'Khong nhan dang duoc URL cho nen tang nay'})
            continue
        if not url and not name:
            skipped.append({'line': line, 'reason': 'Dong trong'})
            continue

        final_url = url or f"local:{account['platform']}:{name}"
        if get("SELECT id FROM targets WHERE account_id = ? AND url = ?", account['id'], final_url):
            skipped.append({'line': line, 'reason': 'Da ton tai'})
            continue

        tid = insert('targets', {
            'project_id': project_id,
            'account_id': account['id'],
            'platform': account['platform'],
            'kind': kind_override or (parsed.get('kind') if parsed else 'group'),
            'external_id': parsed.get('externalId', '') if parsed else '',
            'name': name or (parsed.get('externalId') if parsed else url),
            'url': final_url,
            'enabled': 1,
            'meta': '{}',
            'created_at': now_iso(),
        })
        imported.append(get("SELECT * FROM targets WHERE id = ?", tid))

    log.info(f"Import {len(imported)} nhom vao tai khoan {account['label']} (bo qua {len(skipped)})")
    return {'imported': imported, 'skipped': skipped, 'total': len(lines)}

@router.patch('/targets/{target_id}')
async def update_target(target_id: int, req: Request):
    if not get("SELECT id FROM targets WHERE id = ?", target_id):
        raise HTTPException(status_code=404, detail="Khong tim thay nhom")

    body = await req.json()
    patch = {}
    if 'name' in body:
        patch['name'] = str(body['name']).strip()
    if 'kind' in body:
        patch['kind'] = str(body['kind'])
    if 'url' in body:
        patch['url'] = str(body['url']).strip()
    if 'externalId' in body:
        patch['external_id'] = str(body['externalId'])
    if 'projectId' in body:
        patch['project_id'] = body['projectId']
    if 'enabled' in body:
        patch['enabled'] = 1 if body['enabled'] else 0
    if 'meta' in body:
        patch['meta'] = json.dumps(body['meta'] or {})

    if patch:
        update('targets', target_id, patch)

    return {'target': get("SELECT * FROM targets WHERE id = ?", target_id)}

@router.delete('/targets/{target_id}')
async def delete_target(target_id: int):
    if not get("SELECT id FROM targets WHERE id = ?", target_id):
        raise HTTPException(status_code=404, detail="Khong tim thay nhom")
    run("DELETE FROM targets WHERE id = ?", target_id)
    return {'ok': True}

@router.post('/targets/delete-bulk')
async def delete_targets_bulk(req: Request):
    body = await req.json()
    ids = [int(i) for i in body.get('ids', []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="Chua chon nhom nao")
    ph = ','.join(['?'] * len(ids))
    res = run(f"DELETE FROM targets WHERE id IN ({ph})", *ids)
    return {'ok': True, 'deleted': res.changes}
