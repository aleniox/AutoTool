import re
from backend.platforms._shared import define_platform, RATE_LIMIT_BLOCKERS
from backend.core.flow import compose_text

TITLE_INPUT = [
    'textarea[name="title"]',
    'input[name="title"]',
    '#post-title',
    'textarea[placeholder*="Title"]',
    'textarea[placeholder*="Tiêu đề"]',
    'faceplate-textarea-input textarea',
]

BODY_INPUT = [
    'div[contenteditable="true"][name="body"]',
    'shreddit-composer div[contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[name="text"]',
    'textarea[placeholder*="Text"]',
    'textarea[placeholder*="nội dung"]',
]

def prepare_reddit(ctx: dict) -> dict:
    post = ctx['post']
    composed = compose_text(post)
    first_line = composed.split('\n')[0] if composed else 'Bài viết'
    title = (post.get('title') or first_line or 'Bài viết')[:295]
    body = post.get('caption') or ''
    extra = '\n'.join([x for x in [post.get('hashtags'), post.get('link')] if x])
    text = '\n\n'.join([x for x in [body, extra] if x])
    return {'title': title, 'text': text}

reddit_platform = define_platform({
    'id': 'reddit',
    'name': 'Reddit',
    'color': '#FF4500',
    'loginUrl': 'https://www.reddit.com/login/',
    'homeUrl': 'https://www.reddit.com/',
    'verified': False,
    'notes': (
        'Dang bai dang text vao subreddit. Moi subreddit co rules rieng - dang sai rules se bi xoa va co the bi ban. '
        'Reddit yeu cau tieu de (title) bat buoc.'
    ),
    'caps': {'text': True, 'image': True, 'video': False, 'link': True, 'kinds': ['subreddit', 'profile']},
    'limits': {'maxChars': 40000, 'maxImages': 20, 'maxVideos': 0},
    'targetKinds': [
        {
            'kind': 'subreddit',
            'label': 'Subreddit',
            'match': [re.compile(r'reddit\.com\/r\/([^/?#]+)', re.I)],
            'buildUrl': lambda t: f"https://www.reddit.com/r/{t.get('external_id') or t.get('externalId')}/submit",
        },
        {
            'kind': 'profile',
            'label': 'Trang cá nhân',
            'match': [re.compile(r'reddit\.com\/u(?:ser)?\/([^/?#]+)', re.I)],
            'buildUrl': lambda t: f"https://www.reddit.com/user/{t.get('external_id') or t.get('externalId')}/submit",
        },
    ],
    'session': {
        'probeUrl': 'https://www.reddit.com/',
        'loggedIn': [
            '#expand-user-drawer-button',
            'faceplate-tracker[noun="user_drawer"]',
            'a[href^="/user/"][aria-label]',
            'shreddit-app[user-logged-in="true"]',
        ],
        'loggedOut': ['a[href*="/login"]', 'faceplate-tracker[noun="login"]', 'a[href="/register/"]'],
    },
    'blockers': RATE_LIMIT_BLOCKERS,
    'prepare': prepare_reddit,
    'flows': {
        'subreddit': {
            'startUrl': lambda t, *args: f"https://www.reddit.com/r/{t.get('externalId') or t.get('external_id')}/submit",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 3500},
                {
                    'ifFound': ['input[type="file"]'],
                    'timeout': 5000,
                    'then': [
                        {
                            'click': [
                                {'role': 'tab', 'name': re.compile(r'images|hình ảnh|ảnh', re.I)},
                                'button:has-text("Images")',
                                'a:has-text("Images")',
                            ],
                            'optional': True,
                        },
                        {'wait': 1200},
                        {'upload': ['input[type="file"][accept*="image"]', 'input[type="file"]'], 'files': '{{imagePaths}}', 'optional': True},
                        {'wait': 5000},
                    ],
                },
                {'fill': TITLE_INPUT, 'value': '{{title}}', 'timeout': 25000},
                {'wait': 500},
                {'fill': BODY_INPUT, 'value': '{{text}}', 'timeout': 20000, 'optional': True},
                {'wait': 800},
                {
                    'click': [
                        'button[type="submit"]:has-text("Post")',
                        {'role': 'button', 'name': re.compile(r'^(Post|Đăng)$', re.I)},
                        'button:has-text("Post")',
                        '#submit-post-button',
                    ],
                    'timeout': 30000,
                    'submit': True,
                },
                {'waitForUrl': re.compile(r'reddit\.com\/(r|user)\/'), 'timeout': 60000, 'optional': True},
                {'wait': 3000},
            ],
        },
    },
})
