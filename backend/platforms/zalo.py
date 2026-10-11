import re
from backend.platforms._shared import define_platform
from backend.core.flow import compose_text

zalo_platform = define_platform({
    'id': 'zalo',
    'name': 'Zalo',
    'color': '#0068FF',
    'loginUrl': 'https://id.zalo.me/account?continue=https%3A%2F%2Fchat.zalo.me%2F',
    'homeUrl': 'https://chat.zalo.me/',
    'verified': False,
    'experimental': True,
    'notes': (
        'THU NGHIEM. Zalo Web khong co API dang bai cong khai; tool gui tin nhan vao nhom/ca nhan. '
        'Selector cua Zalo bi obfuscate va doi rat nhanh - hay chay che do thu de kiem tra. '
        'Nhom phai nam trong danh sach hoi thoai (ten nhom phai khop).'
    ),
    'caps': {'text': True, 'image': True, 'video': False, 'link': True, 'kinds': ['group', 'profile']},
    'limits': {'maxChars': 2000, 'maxImages': 10, 'maxVideos': 0},
    'targetKinds': [],
    'session': {
        'probeUrl': 'https://chat.zalo.me/',
        'loggedIn': ['#contact-search-input', '#richInput', '.chat-box', '#chatView', '.conv-list'],
        'loggedOut': ['#login-page', '.login-container', 'input[name="phonenumber"]', '#qrcode'],
    },
    'blockers': [
        {
            'when': [{'text': re.compile(r'tài khoản đã bị khóa|vui lòng đăng nhập lại', re.I)}],
            'message': 'Zalo yeu cau dang nhap lai.',
            'kind': 'auth',
        },
    ],
    'prepare': lambda ctx: {'text': compose_text(ctx['post'])},
    'flows': {
        'group': {
            'startUrl': lambda *args: 'https://chat.zalo.me/',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 6000},
                {'waitFor': ['#contact-search-input', '.conv-list', '#chatView'], 'timeout': 40000},
                {'click': ['#contact-search-input', 'input[placeholder*="Tìm kiếm"]', '.search-input input'], 'timeout': 20000},
                {'wait': 600},
                {'type': ['#contact-search-input', 'input[placeholder*="Tìm kiếm"]', '.search-input input'], 'value': '{{target.name}}', 'clear': True, 'delay': 60},
                {'wait': 3000},
                {
                    'click': [
                        '.conv-item:first-of-type',
                        '#searchList .conv-item',
                        '.search-result .conv-item',
                        'div[data-id]:first-of-type',
                    ],
                    'timeout': 20000,
                },
                {'wait': 2500},
                {'waitFor': ['#richInput', 'div[contenteditable="true"]'], 'timeout': 25000},
                {'click': ['#richInput', 'div[contenteditable="true"]'], 'timeout': 15000},
                {'insertText': ['#richInput', 'div[contenteditable="true"]'], 'value': '{{text}}'},
                {'wait': 1000},
                {
                    'ifFound': ['input[type="file"]'],
                    'timeout': 3000,
                    'then': [
                        {'upload': ['input[type="file"][accept*="image"]', 'input[type="file"]'], 'files': '{{imagePaths}}', 'optional': True},
                        {'wait': 5000},
                    ],
                },
                {'press': 'Enter', 'timeout': 15000},
                {'wait': 2500},
            ],
        },
        'profile': {
            'startUrl': lambda *args: 'https://chat.zalo.me/',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 6000},
                {'waitFor': ['#contact-search-input', '.conv-list'], 'timeout': 40000},
                {'click': ['#contact-search-input', 'input[placeholder*="Tìm kiếm"]'], 'timeout': 20000},
                {'type': ['#contact-search-input', 'input[placeholder*="Tìm kiếm"]'], 'value': '{{target.name}}', 'clear': True, 'delay': 60},
                {'wait': 3000},
                {'click': ['.conv-item:first-of-type', '#searchList .conv-item'], 'timeout': 20000},
                {'wait': 2500},
                {'click': ['#richInput', 'div[contenteditable="true"]'], 'timeout': 15000},
                {'insertText': ['#richInput', 'div[contenteditable="true"]'], 'value': '{{text}}'},
                {'wait': 800},
                {'press': 'Enter', 'timeout': 15000},
                {'wait': 2500},
            ],
        },
    },
})
