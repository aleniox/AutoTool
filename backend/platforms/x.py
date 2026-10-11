import re
from backend.platforms._shared import define_platform, RATE_LIMIT_BLOCKERS, truncate
from backend.core.flow import compose_text

x_platform = define_platform({
    'id': 'x',
    'name': 'X (Twitter)',
    'color': '#000000',
    'loginUrl': 'https://x.com/i/flow/login',
    'homeUrl': 'https://x.com/home',
    'verified': False,
    'notes': (
        'Gioi han 280 ky tu cho tai khoan thuong. Neu caption dai hon se bi cat bot. '
        'X rat hay yeu cau xac minh lai (email/phone) khi dang nhap tu trinh duyet moi.'
    ),
    'caps': {'text': True, 'image': True, 'video': True, 'link': True, 'kinds': ['profile']},
    'limits': {'maxChars': 280, 'maxImages': 4, 'maxVideos': 1},
    'targetKinds': [],
    'session': {
        'probeUrl': 'https://x.com/home',
        'loggedIn': [
            '[data-testid="SideNav_AccountSwitcher_Button"]',
            '[data-testid="AppTabBar_Profile_Link"]',
            'a[aria-label="Post"]',
            'a[data-testid="AppTabBar_Home_Link"]',
        ],
        'loggedOut': [
            '[data-testid="loginButton"]',
            '[data-testid="signupButton"]',
            'input[name="text"][autocomplete="username"]',
        ],
    },
    'blockers': [
        *RATE_LIMIT_BLOCKERS,
        {
            'when': [{'text': re.compile(r'you are over the daily limit|daily update limit', re.I)}],
            'message': 'Da het gioi han dang bai trong ngay cua X.',
            'kind': 'rate_limit',
        },
    ],
    'prepare': lambda ctx: {
        'text': truncate(compose_text(ctx['post']), 280),
        'truncated': len(compose_text(ctx['post'])) > 280,
    },
    'flows': {
        'profile': {
            'startUrl': lambda *args: 'https://x.com/compose/post',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 2500},
                {
                    'waitFor': [
                        'div[role="dialog"] div[data-testid="tweetTextarea_0"]',
                        'div[data-testid="tweetTextarea_0"]',
                    ],
                    'timeout': 25000,
                },
                {
                    'fill': [
                        'div[data-testid="tweetTextarea_0"]',
                        'div[role="textbox"][data-testid="tweetTextarea_0"]',
                    ],
                    'value': '{{text}}',
                    'timeout': 20000,
                },
                {'wait': 800},
                {
                    'ifFound': ['input[data-testid="fileInput"]'],
                    'timeout': 3000,
                    'then': [
                        {'upload': ['input[data-testid="fileInput"]'], 'files': '{{mediaPaths}}', 'optional': True},
                        {'wait': 6000},
                    ],
                },
                {
                    'click': [
                        'div[role="dialog"] button[data-testid="tweetButton"]',
                        'button[data-testid="tweetButton"]',
                        'button[data-testid="tweetButtonInline"]',
                    ],
                    'timeout': 30000,
                    'submit': True,
                },
                {
                    'waitForGone': ['div[data-testid="tweetTextarea_0"]'],
                    'timeout': 90000,
                    'optional': True,
                },
                {'wait': 2500},
            ],
        },
    },
})
