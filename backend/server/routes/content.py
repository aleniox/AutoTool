import json
import os
import re
import time
import urllib.parse
from pathlib import Path
from typing import Any, Dict, List, Optional
from fastapi import APIRouter, Request, HTTPException, Response
import aiofiles
import asyncio
import urllib.request
import urllib.error
from backend.config import config
from backend.db import all_rows, get, run, insert, update, now_iso, parse_json, get_setting, set_setting
from backend.logger import create_logger

router = APIRouter()
log = create_logger('api:content')

IMAGE_EXT = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic'}
VIDEO_EXT = {'.mp4', '.mov', '.webm', '.mkv', '.avi'}

def media_type(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in VIDEO_EXT:
        return 'video'
    if ext in IMAGE_EXT:
        return 'image'
    return 'file'

def sanitize_name(raw: Any) -> str:
    base = Path(str(raw or '')).name
    base = re.sub(r'[^\w.\- ]+', '_', base)[-120:]
    return base or f"file-{int(time.time() * 1000)}"

def media_record(name: str) -> dict:
    abs_path = Path(config.paths['media']) / name
    size = abs_path.stat().st_size if abs_path.exists() else 0
    return {
        'name': name,
        'path': str(abs_path),
        'url': f"/media/{urllib.parse.quote(name)}",
        'type': media_type(name),
        'size': size,
    }

def normalize_media(items: Any) -> List[dict]:
    if not isinstance(items, list):
        return []
    res = []
    media_dir = Path(config.paths['media'])
    for item in items:
        name = item if isinstance(item, str) else (item.get('name') if isinstance(item, dict) else None)
        if not name:
            continue
        safe = sanitize_name(name)
        if (media_dir / safe).exists():
            res.append(media_record(safe))
    return res

# --------------------------------------------------------------------------- #
# Media                                                                       #
# --------------------------------------------------------------------------- #

@router.post('/media', status_code=201)
async def upload_media(req: Request, name: Optional[str] = None):
    body = await req.body()
    if not body:
        raise HTTPException(status_code=400, detail="File rong")

    original = sanitize_name(name or f"file-{int(time.time() * 1000)}")
    p = Path(original)
    stem = p.stem
    ext = p.suffix
    random_str = hex(int(time.time() * 100000))[2:7]
    unique_name = f"{int(time.time() * 1000)}-{random_str}-{stem}{ext}"

    dest = Path(config.paths['media']) / unique_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    async with aiofiles.open(dest, 'wb') as f:
        await f.write(body)

    log.info(f"Upload {unique_name} ({len(body)} byte)")
    return {'file': media_record(unique_name)}

@router.get('/media')
async def list_media():
    media_dir = Path(config.paths['media'])
    if not media_dir.exists():
        return {'files': []}

    files = [f.name for f in media_dir.iterdir() if f.is_file() and not f.name.startswith('.')]
    items = [media_record(f) for f in files]
    items.sort(key=lambda x: x['name'], reverse=True)
    return {'files': items}

@router.delete('/media/{file_name}')
async def delete_media(file_name: str):
    name = sanitize_name(file_name)
    media_dir = Path(config.paths['media']).resolve()
    abs_path = (media_dir / name).resolve()

    if not abs_path.is_relative_to(media_dir) or not abs_path.exists():
        raise HTTPException(status_code=404, detail="Khong tim thay file")

    posts = all_rows("SELECT id, media FROM posts")
    in_use = [
        p['id'] for p in posts
        if any(m.get('name') == name for m in parse_json(p.get('media'), []))
    ]
    if in_use:
        raise HTTPException(status_code=400, detail=f"File dang duoc dung trong {len(in_use)} bai viet")

    try:
        abs_path.unlink()
    except Exception as err:
        raise HTTPException(status_code=500, detail=str(err))

    return {'ok': True}

# --------------------------------------------------------------------------- #
# Posts                                                                       #
# --------------------------------------------------------------------------- #

def shape_post(row: dict) -> dict:
    if not row:
        return {}
    res = dict(row)
    res['media'] = parse_json(row.get('media'), [])
    return res

def build_media_payload(media_list: Any) -> str:
    return json.dumps(normalize_media(media_list))

@router.get('/posts')
async def list_posts(projectId: Optional[int] = None, q: Optional[str] = None, limit: int = 200):
    where = []
    params = []
    if projectId:
        where.append("project_id = ?")
        params.append(projectId)
    if q and q.strip():
        where.append("(title LIKE ? OR caption LIKE ?)")
        search_term = f"%{q.strip()}%"
        params.extend([search_term, search_term])

    limit_clamped = min(500, max(1, limit))
    where_clause = f"WHERE {' AND '.join(where)}" if where else ''
    sql = f"SELECT * FROM posts {where_clause} ORDER BY id DESC LIMIT ?"
    rows = all_rows(sql, *params, limit_clamped)
    total_count = get("SELECT COUNT(*) AS c FROM posts") or {'c': 0}

    return {'posts': [shape_post(r) for r in rows], 'total': total_count['c']}

@router.get('/posts/{post_id}')
async def get_post(post_id: int):
    row = get("SELECT * FROM posts WHERE id = ?", post_id)
    if not row:
        raise HTTPException(status_code=404, detail="Khong tim thay bai viet")
    return {'post': shape_post(row)}

@router.post('/posts', status_code=201)
async def create_post(req: Request):
    body = await req.json()
    caption = str(body.get('caption') or '').strip()
    title = str(body.get('title') or '').strip()

    if not caption and not title:
        raise HTTPException(status_code=400, detail="Bai viet phai co tieu de hoac noi dung")

    pid = insert('posts', {
        'project_id': body.get('projectId'),
        'title': title,
        'caption': caption,
        'link': str(body.get('link') or '').strip(),
        'hashtags': str(body.get('hashtags') or '').strip(),
        'media': build_media_payload(body.get('media')),
        'created_at': now_iso(),
    })
    return {'post': shape_post(get("SELECT * FROM posts WHERE id = ?", pid))}

@router.patch('/posts/{post_id}')
async def update_post(post_id: int, req: Request):
    if not get("SELECT id FROM posts WHERE id = ?", post_id):
        raise HTTPException(status_code=404, detail="Khong tim thay bai viet")

    body = await req.json()
    patch = {}
    for key in ['title', 'caption', 'link', 'hashtags']:
        if key in body:
            patch[key] = str(body[key] or '').strip()
    if 'projectId' in body:
        patch['project_id'] = body['projectId']
    if 'media' in body:
        patch['media'] = build_media_payload(body['media'])

    if patch:
        update('posts', post_id, patch)

    return {'post': shape_post(get("SELECT * FROM posts WHERE id = ?", post_id))}

@router.delete('/posts/{post_id}')
async def delete_post(post_id: int):
    if not get("SELECT id FROM posts WHERE id = ?", post_id):
        raise HTTPException(status_code=404, detail="Khong tim thay bai viet")
    run("DELETE FROM posts WHERE id = ?", post_id)
    return {'ok': True}

@router.post('/posts/delete-bulk')
async def delete_posts_bulk(req: Request):
    body = await req.json()
    ids = [int(i) for i in body.get('ids', []) if i]
    if not ids:
        raise HTTPException(status_code=400, detail="Chua chon bai viet nao")
    ph = ','.join(['?'] * len(ids))
    res = run(f"DELETE FROM posts WHERE id IN ({ph})", *ids)
    return {'ok': True, 'deleted': res.changes}

@router.post('/posts/import')
async def import_posts(req: Request):
    body = await req.json()
    text = str(body.get('text') or '').strip()
    if not text:
        raise HTTPException(status_code=400, detail="Thieu truong bat buoc: text")

    project_id = body.get('projectId')
    attach_all = body.get('attachMedia') == 'all'
    all_media = normalize_media(body.get('media', []))

    blocks = [b.strip() for b in re.split(r'^\s*-{3,}\s*$', text, flags=re.M) if b.strip()]
    if not blocks:
        raise HTTPException(status_code=400, detail="Khong tim thay bai viet nao trong noi dung")

    created = []
    for block in blocks:
        lines = block.splitlines()
        title = ''
        link = ''
        hashtags = ''
        media_names = []
        body_lines = []

        for line in lines:
            m = re.match(r'^(?:tiêu đề|tieu de|title)\s*:\s*(.+)$', line, re.I)
            l = re.match(r'^(?:link|url)\s*:\s*(.+)$', line, re.I)
            a = re.match(r'^(?:ảnh|anh|media|hình|hinh|image|images)\s*:\s*(.+)$', line, re.I)
            h = re.match(r'^(?:hashtag|tags?)\s*:\s*(.+)$', line, re.I)

            if m:
                title = m.group(1).strip()
            elif l:
                link = l.group(1).strip()
            elif a:
                media_names = [s.strip() for s in re.split(r'[,;]', a.group(1)) if s.strip()]
            elif h:
                hashtags = h.group(1).strip()
            elif re.match(r'^#[\w\u00C0-\u024F]+', line.strip()) and not body_lines:
                hashtags = line.strip()
            else:
                body_lines.append(line)

        caption = '\n'.join(body_lines).strip()
        if not title and not caption:
            continue
        if not title and len(caption) <= 120 and '\n' not in caption:
            title = caption

        media = normalize_media(media_names) if media_names else (all_media if attach_all else [])

        pid = insert('posts', {
            'project_id': project_id,
            'title': title,
            'caption': caption,
            'link': link,
            'hashtags': hashtags,
            'media': json.dumps(media),
            'created_at': now_iso(),
        })
        created.append(shape_post(get("SELECT * FROM posts WHERE id = ?", pid)))

    log.info(f"Import {len(created)} bai viet")
    return {'posts': created, 'total': len(blocks)}

# --------------------------------------------------------------------------- #
# --------------------------------------------------------------------------- #
# Multi-Provider AI Assistant (Gemini, ChatGPT, DeepSeek, Claude, Custom)    #
# --------------------------------------------------------------------------- #

from backend.core.ai_service import get_all_ai_settings, save_ai_settings, generate_content, mask_key

@router.get('/ai/settings')
async def get_ai_settings():
    return get_all_ai_settings()

@router.post('/ai/settings')
async def save_ai_settings_endpoint(req: Request):
    body = await req.json()
    provider = body.get('provider')
    api_key = body.get('apiKey')
    model = body.get('model')
    endpoint = body.get('endpoint')
    persona_prompt = body.get('personaPrompt')
    set_active = bool(body.get('setActive', True))
    return save_ai_settings(
        provider=provider,
        api_key=api_key,
        model=model,
        endpoint=endpoint,
        set_active=set_active,
        persona_prompt=persona_prompt,
    )

@router.post('/ai/generate')
async def generate_ai_post(req: Request):
    body = await req.json()
    provider = body.get('provider')
    passed_key = str(body.get('apiKey') or '').strip()
    model = body.get('model')
    endpoint = body.get('endpoint')
    persona_prompt = body.get('personaPrompt')
    save_key = bool(body.get('saveKey'))
    save_persona = bool(body.get('savePersona'))

    if (save_key and (passed_key or model or endpoint)) or (save_persona and persona_prompt is not None):
        save_ai_settings(
            provider=provider,
            api_key=passed_key if passed_key else None,
            model=model if model else None,
            endpoint=endpoint if endpoint else None,
            persona_prompt=persona_prompt if save_persona else None,
            set_active=bool(provider),
        )

    try:
        count = min(5, max(1, int(body.get('count') or 1)))
    except Exception:
        count = 1

    return await generate_content(
        provider_id=provider,
        api_key=passed_key,
        model=model,
        endpoint=endpoint,
        mode=str(body.get('mode') or 'generate'),
        topic=str(body.get('topic') or ''),
        existing_content=str(body.get('existingContent') or ''),
        platform=str(body.get('platform') or 'Facebook'),
        tone=str(body.get('tone') or 'bán hàng thu hút'),
        instructions=str(body.get('instructions') or ''),
        count=count,
        persona_prompt=persona_prompt,
    )

