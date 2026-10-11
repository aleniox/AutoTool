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
# AI (Gemini) Assistant                                                       #
# --------------------------------------------------------------------------- #

def mask_key(key: str) -> str:
    if not key:
        return ''
    s = str(key).strip()
    if len(s) <= 8:
        return '********'
    return f"{s[:6]}...{s[-4:]}"

@router.get('/ai/settings')
async def get_ai_settings():
    key = str(get_setting('gemini_api_key', '') or os.environ.get('GEMINI_API_KEY', '')).strip()
    model = str(get_setting('gemini_model', '') or 'gemini-2.5-flash').strip()
    return {
        'hasKey': bool(key),
        'maskedKey': mask_key(key),
        'model': model,
    }

@router.post('/ai/settings')
async def save_ai_settings(req: Request):
    body = await req.json()
    api_key = str(body.get('apiKey') or '').strip()
    model = str(body.get('model') or '').strip() or 'gemini-2.5-flash'
    if api_key:
        set_setting('gemini_api_key', api_key)
    set_setting('gemini_model', model)
    key = str(get_setting('gemini_api_key', '') or os.environ.get('GEMINI_API_KEY', '')).strip()
    return {
        'ok': True,
        'hasKey': bool(key),
        'maskedKey': mask_key(key),
        'model': model,
    }

def _call_gemini_sync(url: str, payload: dict) -> dict:
    req_data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=req_data,
        headers={'Content-Type': 'application/json'},
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        err_body = e.read().decode('utf-8', errors='ignore')
        try:
            err_json = json.loads(err_body)
            msg = err_json.get('error', {}).get('message') or f"HTTP {e.code}"
        except Exception:
            msg = f"HTTP {e.code}: {err_body[:200]}"
        raise HTTPException(status_code=400, detail=f"Gemini API loi: {msg}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Khong the ket noi Gemini API: {str(e)}")

@router.post('/ai/generate')
async def generate_ai_post(req: Request):
    body = await req.json()
    passed_key = str(body.get('apiKey') or '').strip()
    api_key = passed_key or str(get_setting('gemini_api_key', '') or os.environ.get('GEMINI_API_KEY', '')).strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="Chưa cấu hình Gemini API Key. Vui lòng nhập API Key trên giao diện.")

    if body.get('saveKey') and passed_key:
        set_setting('gemini_api_key', passed_key)

    model = str(body.get('model') or '').strip() or str(get_setting('gemini_model', '') or 'gemini-2.5-flash').strip()
    mode = str(body.get('mode') or 'generate').strip()
    topic = str(body.get('topic') or '').strip()
    existing_content = str(body.get('existingContent') or '').strip()
    platform = str(body.get('platform') or 'đa nền tảng').strip()
    tone = str(body.get('tone') or 'bán hàng thu hút').strip()
    instructions = str(body.get('instructions') or '').strip()
    try:
        count = min(5, max(1, int(body.get('count') or 1)))
    except Exception:
        count = 1

    if mode == 'rewrite':
        if not existing_content:
            raise HTTPException(status_code=400, detail="Vui lòng nhập nội dung cần viết lại")
        prompt_text = f"""Bạn là chuyên gia biên tập và tối ưu nội dung mạng xã hội.
Hãy viết lại bài viết sau đây theo phong cách: "{tone}".
Nền tảng hướng tới: {platform}.
Yêu cầu thêm: {instructions or 'Viết lại hấp dẫn hơn, thêm emoji phù hợp, ngắt dòng rõ ràng, bổ sung hashtag liên quan'}.

NỘI DUNG GỐC:
\"\"\"
{existing_content}
\"\"\"

Yêu cầu định dạng đầu ra:
Bạn PHẢI trả về JSON hợp lệ theo đúng cấu trúc sau (không thêm bất kỳ văn bản markdown hay giải thích nào ngoài JSON):
{{
  "title": "Tiêu đề ngắn gọn, bắt mắt (nếu phù hợp)",
  "caption": "Nội dung bài viết hoàn chỉnh đã được viết lại, ngắt dòng đẹp mắt và có emoji...",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3",
  "variations": []
}}"""
    else:
        if not topic and not instructions:
            raise HTTPException(status_code=400, detail="Vui lòng nhập chủ đề hoặc ý tưởng bài viết")
        prompt_text = f"""Bạn là chuyên gia sáng tạo nội dung mạng xã hội hàng đầu.
Hãy viết bài đăng cho nền tảng: "{platform}".
Chủ đề / Ý tưởng: "{topic}".
Giọng điệu / Phong cách: "{tone}".
Yêu cầu thêm: {instructions or 'Nội dung hấp dẫn, bắt trend, có lời kêu gọi hành động (CTA), chèn emoji sinh động'}.
Số lượng bài viết cần tạo: {count}.

Yêu cầu định dạng đầu ra:
Bạn PHẢI trả về JSON hợp lệ theo đúng cấu trúc sau (không thêm bất kỳ văn bản markdown hay giải thích nào ngoài JSON):
{{
  "title": "Tiêu đề bài viết ngắn gọn, giật tít, hấp dẫn",
  "caption": "Nội dung bài viết hoàn chỉnh, ngắt dòng đẹp mắt, có icon/emoji và lời kêu gọi hành động (CTA)...",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3",
  "variations": [
    {'''
    {
      "title": "Tiêu đề biến thể...",
      "caption": "Nội dung biến thể...",
      "hashtags": "#hashtag1 #hashtag2"
    }''' if count > 1 else ''}
  ]
}}"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{urllib.parse.quote(model)}:generateContent?key={urllib.parse.quote(api_key)}"
    payload = {
        'contents': [{'parts': [{'text': prompt_text}]}],
        'generationConfig': {
            'temperature': 0.7,
            'responseMimeType': 'application/json',
        }
    }

    data = await asyncio.to_thread(_call_gemini_sync, url, payload)

    try:
        raw_text = data['candidates'][0]['content']['parts'][0]['text']
    except (KeyError, IndexError):
        raise HTTPException(status_code=400, detail="Không nhận được nội dung từ Gemini")

    try:
        parsed_result = json.loads(raw_text)
    except Exception:
        cleaned = re.sub(r'^```(?:json)?\s*|\s*```$', '', raw_text.strip(), flags=re.M).strip()
        try:
            parsed_result = json.loads(cleaned)
        except Exception:
            parsed_result = {
                'title': '',
                'caption': raw_text,
                'hashtags': '',
                'variations': [],
            }

    return {
        'ok': True,
        'result': {
            'title': parsed_result.get('title') or '',
            'caption': parsed_result.get('caption') or '',
            'hashtags': parsed_result.get('hashtags') or '',
            'variations': parsed_result.get('variations') if isinstance(parsed_result.get('variations'), list) else [],
        }
    }

