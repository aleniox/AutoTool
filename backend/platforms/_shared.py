import re
from typing import Any, Dict, List

def define_platform(def_dict: dict) -> dict:
    platform = {
        'verified': False,
        'experimental': False,
        'notes': '',
        'caps': {'text': True, 'image': False, 'video': False, 'link': True, 'kinds': ['profile']},
        'limits': {'maxChars': 0, 'maxImages': 0, 'maxVideos': 0},
        'targetKinds': [],
        'blockers': [],
        'session': {},
    }
    platform.update(def_dict)

    if not platform.get('id'):
        raise ValueError('Platform thieu id')
    if not platform.get('flows') or not isinstance(platform['flows'], dict):
        raise ValueError(f"Platform {platform['id']} thieu flows")
    return platform

def truncate(text: Any, max_len: int) -> str:
    s = str(text or '')
    if not max_len or len(s) <= max_len:
        return s
    return f"{s[:max(0, max_len - 1)].rstrip()}…"

RATE_LIMIT_BLOCKERS = [
    {
        'when': [
            {'text': re.compile(r"you'?re temporarily blocked|temporarily blocked|tạm thời bị chặn", re.I)},
            {'text': re.compile(r"we limit how often you can post|giới hạn tần suất", re.I)},
            {'text': re.compile(r"try again later|thử lại sau", re.I)},
            {'text': re.compile(r"something went wrong|đã xảy ra lỗi", re.I)},
        ],
        'message': 'Nen tang bao bi chan / gioi han tan suat. Nen dung lai vai gio.',
        'kind': 'rate_limit',
    },
    {
        'when': [
            {'text': re.compile(r"action was blocked|hành động bị chặn", re.I)},
            {'text': re.compile(r"you can'?t post right now|bạn không thể đăng", re.I)},
            {'text': re.compile(r"bạn đã bị chặn", re.I)},
        ],
        'message': 'Tai khoan bi chan thao tac dang bai.',
        'kind': 'blocked',
    },
    {
        'when': [
            {'text': re.compile(r"session expired|phiên đăng nhập đã hết hạn", re.I)},
            {'text': re.compile(r"log ?in to continue|đăng nhập để tiếp tục", re.I)},
            {'text': re.compile(r"please log in|vui lòng đăng nhập", re.I)},
        ],
        'message': 'Phien dang nhap het han. Can dang nhap lai.',
        'kind': 'auth',
    },
]

def optional_click(desc: Any, timeout: int = 4000) -> dict:
    return {'ifFound': desc, 'timeout': timeout, 'then': [{'click': desc, 'optional': True}]}
