import re
from backend.platforms._shared import define_platform, RATE_LIMIT_BLOCKERS
from backend.core.flow import compose_text

tiktok_platform = define_platform({
    'id': 'tiktok',
    'name': 'TikTok',
    'color': '#FE2C55',
    'loginUrl': 'https://www.tiktok.com/login',
    'homeUrl': 'https://www.tiktok.com/tiktokstudio',
    'verified': False,
    'experimental': True,
    'notes': (
        'THU NGHIEM. Bat buoc phai co video (TikTok khong cho dang anh qua web). '
        'Qua trinh upload + xu ly video mat nhieu thoi gian, nen dat timeout lon.'
    ),
    'caps': {'text': True, 'image': False, 'video': True, 'link': False, 'kinds': ['profile']},
    'limits': {'maxChars': 2200, 'maxImages': 0, 'maxVideos': 1},
    'targetKinds': [],
    'session': {
        'probeUrl': 'https://www.tiktok.com/tiktokstudio',
        'loggedIn': [
            '[data-e2e="profile-icon"]',
            'a[href*="/profile"]',
            '[data-e2e="upload-icon"]',
            'div[data-e2e="nav-upload"]',
        ],
        'loggedOut': ['div[data-e2e="login-button"]', 'a[href*="/login"]', '#loginContainer'],
    },
    'blockers': RATE_LIMIT_BLOCKERS,
    'prepare': lambda ctx: {'text': compose_text(ctx['post'], include_link=False)},
    'flows': {
        'profile': {
            'startUrl': lambda *args: 'https://www.tiktok.com/tiktokstudio/upload?from=webapp',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 5000},
                {'waitFor': 'input[type="file"]', 'timeout': 40000},
                {
                    'when': lambda ctx: len(ctx.get('videoPaths', [])) > 0,
                    'then': [{'upload': 'input[type="file"]', 'files': '{{videoPaths}}', 'timeout': 120000}],
                    'else': [{'upload': 'input[type="file"]', 'files': '{{mediaPaths}}', 'timeout': 120000}],
                },
                {'wait': 10000},
                {
                    'fill': [
                        'div[contenteditable="true"]',
                        '.public-DraftEditor-content',
                        'div[data-e2e="caption-input"]',
                    ],
                    'value': '{{text}}',
                    'timeout': 40000,
                    'optional': True,
                },
                {'wait': 2000},
                {
                    'click': [
                        'button[data-e2e="post_video_button"]',
                        'button:has-text("Post")',
                        'button:has-text("Đăng")',
                        {'role': 'button', 'name': re.compile(r'^(Post|Đăng)$', re.I)},
                    ],
                    'timeout': 60000,
                    'submit': True,
                },
                {'wait': 8000},
            ],
        },
    },
})
