import re
from backend.platforms._shared import define_platform, RATE_LIMIT_BLOCKERS
from backend.core.flow import compose_text

instagram_platform = define_platform({
    'id': 'instagram',
    'name': 'Instagram',
    'color': '#E1306C',
    'loginUrl': 'https://www.instagram.com/accounts/login/',
    'homeUrl': 'https://www.instagram.com/',
    'verified': False,
    'experimental': True,
    'notes': (
        'THU NGHIEM. Instagram web phat hien automation rat tot va thuong xuyen yeu cau xac minh. '
        'Chi dang duoc len trang ca nhan cua chinh ban (khong co khai niem "nhom"). '
        'Caption bat buoc voi bai co anh trong mot so truong hop.'
    ),
    'caps': {'text': False, 'image': True, 'video': True, 'link': False, 'kinds': ['profile']},
    'limits': {'maxChars': 2200, 'maxImages': 10, 'maxVideos': 1},
    'targetKinds': [],
    'session': {
        'probeUrl': 'https://www.instagram.com/',
        'loggedIn': [
            'svg[aria-label="Home"]',
            'svg[aria-label="Trang chủ"]',
            'a[href="/direct/inbox/"]',
            'svg[aria-label="New post"]',
            'svg[aria-label="Bài viết mới"]',
        ],
        'loggedOut': ['input[name="username"]', 'form#loginForm', 'input[name="password"]'],
    },
    'blockers': [
        *RATE_LIMIT_BLOCKERS,
        {
            'when': [{'text': re.compile(r'we restrict certain activity|chúng tôi hạn chế một số hoạt động', re.I)}],
            'message': 'Instagram tam khoa hoat dong. Can doi vai gio.',
            'kind': 'blocked',
        },
    ],
    'prepare': lambda ctx: {'text': compose_text(ctx['post'], include_link=False)},
    'flows': {
        'profile': {
            'startUrl': lambda *args: 'https://www.instagram.com/',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3500},
                {
                    'click': [
                        'svg[aria-label="New post"]',
                        'svg[aria-label="Bài viết mới"]',
                        'svg[aria-label="Create"]',
                        'a[href="#"]:has-text("Create")',
                        'div[role="button"]:has-text("Create")',
                    ],
                    'timeout': 20000,
                },
                {'wait': 1500},
                {
                    'upload': [
                        'input[type="file"][accept*="image"]',
                        'input[type="file"][accept*="video"]',
                        'input[type="file"]',
                    ],
                    'files': '{{mediaPaths}}',
                    'timeout': 60000,
                },
                {
                    'click': [
                        'div[role="dialog"] div[role="button"]:has-text("Next")',
                        'div[role="dialog"] div[role="button"]:has-text("Tiếp")',
                        {'role': 'button', 'name': re.compile(r'^(Next|Tiếp)$', re.I)},
                    ],
                    'timeout': 40000,
                },
                {'wait': 1500},
                {
                    'click': [
                        'div[role="dialog"] div[role="button"]:has-text("Next")',
                        'div[role="dialog"] div[role="button"]:has-text("Tiếp")',
                        {'role': 'button', 'name': re.compile(r'^(Next|Tiếp)$', re.I)},
                    ],
                    'timeout': 40000,
                },
                {'wait': 2000},
                {
                    'fill': [
                        'div[contenteditable="true"][aria-label*="caption"]',
                        'textarea[aria-label*="caption"]',
                        'div[contenteditable="true"][aria-label*="chú thích"]',
                    ],
                    'value': '{{text}}',
                    'timeout': 20000,
                    'optional': True,
                },
                {'wait': 1000},
                {
                    'click': [
                        'div[role="dialog"] div[role="button"]:has-text("Share")',
                        'div[role="dialog"] div[role="button"]:has-text("Chia sẻ")',
                        {'role': 'button', 'name': re.compile(r'^(Share|Chia sẻ)$', re.I)},
                    ],
                    'timeout': 40000,
                    'submit': True,
                },
                {'waitForGone': 'div[role="dialog"]', 'timeout': 120000, 'optional': True},
                {'wait': 3000},
            ],
        },
    },
})
