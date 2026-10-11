import re
from backend.platforms._shared import define_platform, RATE_LIMIT_BLOCKERS
from backend.core.flow import compose_text

COMPOSER_STEPS = [
    {'waitFor': 'div[role="dialog"]', 'timeout': 20000},
    {'wait': 1200},
    {
        'click': [
            'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
            'div[role="dialog"] div[contenteditable="true"]',
        ],
        'timeout': 20000,
    },
    {
        'fill': [
            'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
            'div[role="dialog"] div[contenteditable="true"]',
        ],
        'value': '{{text}}',
        'timeout': 20000,
    },
    {'wait': 800},
    {
        'when': lambda ctx: len(ctx.get('mediaPaths', [])) > 0,
        'then': [
            {
                'click': [
                    'div[role="dialog"] div[aria-label="Ảnh/video"][role="button"]',
                    'div[role="dialog"] div[aria-label="Photo/video"][role="button"]',
                    'div[role="dialog"] [aria-label="Ảnh/video"]',
                    'div[role="dialog"] [aria-label="Photo/video"]',
                    'div[role="dialog"] div[role="button"]:has-text("Ảnh/video")',
                    'div[role="dialog"] div[role="button"]:has-text("Photo/video")',
                ],
                'optional': True,
                'timeout': 3000,
            },
            {'wait': 800},
            {
                'upload': [
                    'div[role="dialog"] input[type="file"][accept*="image"]',
                    'div[role="dialog"] input[type="file"]',
                    'input[type="file"][accept*="image"]',
                    'input[type="file"]',
                ],
                'files': '{{mediaPaths}}',
                'optional': True,
            },
            {'wait': 6000},
        ],
    },
    {
        'click': [
            'div[role="dialog"] div[aria-label="Post"][role="button"]',
            'div[role="dialog"] div[aria-label="Đăng"][role="button"]',
            'div[role="dialog"] [aria-label="Post"]',
            'div[role="dialog"] [aria-label="Đăng"]',
            {'role': 'button', 'name': re.compile(r'^(Post|Đăng|Đǎng)$')},
            'div[role="dialog"] div[role="button"]:has-text("Post")',
            'div[role="dialog"] div[role="button"]:has-text("Đăng")',
        ],
        'timeout': 30000,
        'submit': True,
    },
    {'waitForGone': 'div[role="dialog"]', 'timeout': 90000, 'optional': True},
    {'wait': 2000},
]

OPEN_COMPOSER = [
    {
        'click': [
            {'role': 'button', 'name': re.compile(r'write something|viết gì|bạn viết gì|tạo bài viết', re.I)},
            'div[role="button"]:has-text("Write something")',
            'div[role="button"]:has-text("Viết gì")',
            'div[role="button"]:has-text("Bạn viết gì")',
            '[aria-label="Write something..."]',
            '[aria-label="Viết gì đó..."]',
            'div[role="button"][tabindex="0"]:has-text("…")',
        ],
        'timeout': 25000,
    },
]

facebook_platform = define_platform({
    'id': 'facebook',
    'name': 'Facebook',
    'color': '#1877F2',
    'loginUrl': 'https://www.facebook.com/login',
    'homeUrl': 'https://www.facebook.com/',
    'verified': False,
    'notes': (
        'Dung giao dien web. Facebook thuong xuyen doi DOM va co the checkpoint khi dang qua nhanh. '
        'Nen dat delay >= 3 phut/bai. Chi dang vao nhom ban quan tri hoac noi cho phep.'
    ),
    'caps': {'text': True, 'image': True, 'video': True, 'link': True, 'kinds': ['group', 'page', 'profile']},
    'limits': {'maxChars': 60000, 'maxImages': 10, 'maxVideos': 1},
    'targetKinds': [
        {
            'kind': 'group',
            'label': 'Nhóm',
            'match': [re.compile(r'facebook\.com\/groups\/([^/?#]+)', re.I)],
            'buildUrl': lambda t: f"https://www.facebook.com/groups/{t.get('external_id') or t.get('externalId')}",
        },
        {
            'kind': 'page',
            'label': 'Trang',
            'match': [
                re.compile(r'facebook\.com\/profile\.php\?id=(\d+)', re.I),
                re.compile(r'facebook\.com\/pages\/[^/]+\/(\d+)', re.I),
            ],
            'buildUrl': lambda t: f"https://www.facebook.com/{t.get('external_id') or t.get('externalId')}",
        },
        {
            'kind': 'profile',
            'label': 'Trang cá nhân',
            'match': [re.compile(r'facebook\.com\/(?:people\/[^/]+\/)?(\d{6,})\/?$', re.I)],
            'buildUrl': lambda t: f"https://www.facebook.com/{t.get('external_id') or t.get('externalId')}",
        },
    ],
    'session': {
        'probeUrl': 'https://www.facebook.com/me',
        'loggedIn': [
            'div[role="navigation"] svg[aria-label="Your profile"]',
            'div[aria-label="Your profile"]',
            'a[href*="/friends"]',
            'div[role="banner"]',
        ],
        'loggedOut': ['input[name="email"]', 'input[name="pass"]', '#login_form', 'form[action*="login"]'],
    },
    'blockers': RATE_LIMIT_BLOCKERS,
    'prepare': lambda ctx: {'text': compose_text(ctx['post'])},
    'flows': {
        'group': {
            'startUrl': lambda t, *args: f"https://www.facebook.com/groups/{t.get('externalId') or t.get('external_id')}",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3000},
                *OPEN_COMPOSER,
                *COMPOSER_STEPS,
            ],
        },
        'page': {
            'startUrl': lambda t, *args: f"https://www.facebook.com/{t.get('externalId') or t.get('external_id')}",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3000},
                *OPEN_COMPOSER,
                *COMPOSER_STEPS,
            ],
        },
        'profile': {
            'startUrl': lambda t, *args: f"https://www.facebook.com/{t.get('externalId') or t.get('external_id')}",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3000},
                *OPEN_COMPOSER,
                *COMPOSER_STEPS,
            ],
        },
    },
})
