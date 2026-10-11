import re
from backend.platforms._shared import define_platform, RATE_LIMIT_BLOCKERS
from backend.core.flow import compose_text

DIALOG_EDITOR = [
    'div[role="dialog"] div.ql-editor[contenteditable="true"]',
    'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
    'div[role="dialog"] .ql-editor',
]

POST_BUTTON = [
    'div[role="dialog"] button.share-actions__primary-action',
    'div[role="dialog"] button[aria-label="Post"]',
    {'role': 'button', 'name': re.compile(r'^(Post|Đăng|Đǎng)$', re.I)},
    'div[role="dialog"] button:has-text("Post")',
    'div[role="dialog"] button:has-text("Đăng")',
]

SHARE_FLOW = [
    {'waitFor': 'div[role="dialog"]', 'timeout': 20000},
    {'wait': 1200},
    {'fill': DIALOG_EDITOR, 'value': '{{text}}', 'timeout': 20000},
    {'wait': 600},
    {
        'ifFound': ['div[role="dialog"] input[type="file"]'],
        'timeout': 4000,
        'then': [
            {
                'click': [
                    'div[role="dialog"] button[aria-label="Add media"]',
                    'div[role="dialog"] button[aria-label="Thêm nội dung"]',
                    'div[role="dialog"] button:has-text("Photo")',
                    {'role': 'button', 'name': re.compile(r'add media|thêm nội dung|photo|ảnh', re.I)},
                ],
                'optional': True,
            },
            {'wait': 600},
            {
                'upload': [
                    'div[role="dialog"] input[type="file"][accept*="image"]',
                    'div[role="dialog"] input[type="file"]',
                ],
                'files': '{{imagePaths}}',
                'optional': True,
            },
            {'wait': 4000},
            {
                'retry': 3,
                'backoff': 1500,
                'steps': [
                    {
                        'click': [
                            'button[aria-label="Next"]',
                            {'role': 'button', 'name': re.compile(r'^(Next|Tiếp|Tiếp theo)$', re.I)},
                            'div[role="dialog"] button:has-text("Next")',
                        ],
                        'timeout': 15000,
                    },
                    {'wait': 1500},
                ],
            },
            {
                'click': [
                    'button[aria-label="Done"]',
                    {'role': 'button', 'name': re.compile(r'^(Done|Xong)$', re.I)},
                    'div[role="dialog"] button:has-text("Done")',
                ],
                'timeout': 15000,
            },
            {'wait': 1500},
        ],
    },
    {'click': POST_BUTTON, 'timeout': 30000, 'submit': True},
    {'waitForGone': 'div[role="dialog"]', 'timeout': 90000, 'optional': True},
    {'wait': 2500},
]

linkedin_platform = define_platform({
    'id': 'linkedin',
    'name': 'LinkedIn',
    'color': '#0A66C2',
    'loginUrl': 'https://www.linkedin.com/login',
    'homeUrl': 'https://www.linkedin.com/feed/',
    'verified': False,
    'notes': (
        'Ho tro dang len trang ca nhan (feed) va nhom ban la thanh vien. LinkedIn gioi han manh: '
        'nen giu tan suat thap. Anh bat buoc qua buoc Next/Done.'
    ),
    'caps': {'text': True, 'image': True, 'video': True, 'link': True, 'kinds': ['profile', 'group', 'page']},
    'limits': {'maxChars': 3000, 'maxImages': 9, 'maxVideos': 1},
    'targetKinds': [
        {
            'kind': 'group',
            'label': 'Nhóm LinkedIn',
            'match': [re.compile(r'linkedin\.com\/groups\/([^/?#]+)', re.I)],
            'buildUrl': lambda t: f"https://www.linkedin.com/groups/{t.get('external_id') or t.get('externalId')}/",
        },
        {
            'kind': 'page',
            'label': 'Trang công ty',
            'match': [re.compile(r'linkedin\.com\/company\/([^/?#]+)', re.I)],
            'buildUrl': lambda t: f"https://www.linkedin.com/company/{t.get('external_id') or t.get('externalId')}/admin/dashboard/",
        },
    ],
    'session': {
        'probeUrl': 'https://www.linkedin.com/feed/',
        'loggedIn': [
            'img.global-nav__me-photo',
            'button.global-nav__primary-link-me-menu-trigger',
            'div.feed-identity-module',
            '.scaffold-layout__sidebar',
            'nav[aria-label="Primary"]',
        ],
        'loggedOut': ['form.login__form', 'input#username', 'input#password', '.login__form'],
    },
    'blockers': RATE_LIMIT_BLOCKERS,
    'prepare': lambda ctx: {'text': compose_text(ctx['post'])},
    'flows': {
        'profile': {
            'startUrl': lambda t, *args: 'https://www.linkedin.com/feed/',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 2500},
                {
                    'click': [
                        'button.share-mb-processor-button',
                        'button.share-box-feed-entry__trigger',
                        {'role': 'button', 'name': re.compile(r'start a post|tạo bài viết|bắt đầu một bài viết', re.I)},
                        'button:has-text("Start a post")',
                        'button:has-text("Tạo bài viết")',
                    ],
                    'timeout': 25000,
                },
                *SHARE_FLOW,
            ],
        },
        'group': {
            'startUrl': lambda t, *args: f"https://www.linkedin.com/groups/{t.get('externalId') or t.get('external_id')}/",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3000},
                {
                    'click': [
                        {'role': 'button', 'name': re.compile(r'start a post|bắt đầu (một )?(bài viết|thảo luận)|create a post', re.I)},
                        'button:has-text("Start a post")',
                        'button:has-text("Bắt đầu")',
                        '.groups-post-trigger',
                    ],
                    'timeout': 25000,
                },
                *SHARE_FLOW,
            ],
        },
        'page': {
            'startUrl': lambda t, *args: f"https://www.linkedin.com/company/{t.get('externalId') or t.get('external_id')}/admin/page-posts/published/",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3000},
                {
                    'click': [
                        {'role': 'button', 'name': re.compile(r'create post|tạo bài viết', re.I)},
                        'button:has-text("Create post")',
                    ],
                    'timeout': 25000,
                },
                *SHARE_FLOW,
            ],
        },
    },
})
