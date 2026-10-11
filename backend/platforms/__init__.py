import re
from typing import Any, Dict, List, Optional
from backend.platforms.facebook import facebook_platform
from backend.platforms.linkedin import linkedin_platform
from backend.platforms.x import x_platform
from backend.platforms.telegram import telegram_platform
from backend.platforms.reddit import reddit_platform
from backend.platforms.instagram import instagram_platform
from backend.platforms.threads import threads_platform
from backend.platforms.tiktok import tiktok_platform
from backend.platforms.zalo import zalo_platform

_PLATFORMS_LIST = [
    facebook_platform,
    linkedin_platform,
    x_platform,
    telegram_platform,
    reddit_platform,
    instagram_platform,
    threads_platform,
    tiktok_platform,
    zalo_platform,
]

platforms = {p['id']: p for p in _PLATFORMS_LIST}

def get_platform(platform_id: str) -> dict:
    pid = str(platform_id or '').lower()
    p = platforms.get(pid)
    if not p:
        raise ValueError(f"Nen tang khong duoc ho tro: {platform_id}")
    return p

def has_platform(platform_id: str) -> bool:
    return str(platform_id or '').lower() in platforms

def all_platforms() -> List[dict]:
    return list(platforms.values())

KIND_LABELS = {
    'group': 'Nhóm',
    'page': 'Trang',
    'profile': 'Trang cá nhân',
    'channel': 'Kênh',
    'subreddit': 'Subreddit',
}

def kind_label(k: str) -> str:
    return KIND_LABELS.get(k, k)

def platform_view(p: dict) -> dict:
    target_kinds = p.get('targetKinds', [])
    caps_kinds = p.get('caps', {}).get('kinds', ['profile'])
    
    kinds = []
    for k in caps_kinds:
        label = next((t['label'] for t in target_kinds if t.get('kind') == k), KIND_LABELS.get(k, k))
        kinds.append({'kind': k, 'label': label})

    return {
        'id': p['id'],
        'name': p['name'],
        'color': p['color'],
        'loginUrl': p['loginUrl'],
        'homeUrl': p['homeUrl'],
        'verified': bool(p.get('verified')),
        'experimental': bool(p.get('experimental')),
        'notes': p.get('notes', ''),
        'caps': p.get('caps'),
        'limits': p.get('limits'),
        'kinds': kinds,
        'targetKinds': [{'kind': t['kind'], 'label': t['label']} for t in target_kinds],
        'flows': list(p.get('flows', {}).keys()),
    }

def list_platforms() -> List[dict]:
    return [platform_view(p) for p in all_platforms()]

def parse_target_url(raw_url: str, platform_hint: Optional[str] = None) -> Optional[dict]:
    url = str(raw_url or '').strip()
    if not url:
        return None

    candidates = [get_platform(platform_hint)] if platform_hint and has_platform(platform_hint) else all_platforms()

    for p in candidates:
        for tk in p.get('targetKinds', []):
            for pattern in tk.get('match', []):
                m = pattern.search(url) if hasattr(pattern, 'search') else re.search(str(pattern), url, re.I)
                if m:
                    groups = m.groups()
                    target_id = (groups[0] if len(groups) > 0 and groups[0] else (groups[1] if len(groups) > 1 else '')).strip()
                    if not target_id:
                        continue
                    return {
                        'platform': p['id'],
                        'kind': tk['kind'],
                        'externalId': target_id,
                        'url': url,
                    }

    # Telegram: @username hoac t.me/...
    if not platform_hint or platform_hint == 'telegram':
        m = re.match(r'^(?:https?:\/\/(?:t\.me|telegram\.me)\/)?@?([A-Za-z0-9_]{4,32})$', url)
        if m:
            return {
                'platform': 'telegram',
                'kind': 'channel',
                'externalId': f"@{m.group(1)}",
                'url': url,
            }

    return None
