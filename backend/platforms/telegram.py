import re
from backend.platforms._shared import define_platform
from backend.core.flow import compose_text

MESSAGE_BOX = [
    'div.input-message-input[contenteditable="true"]',
    '.input-message-input[contenteditable="true"]',
    '#editable-message-text',
    'div[contenteditable="true"][data-placeholder]',
]

telegram_platform = define_platform({
    'id': 'telegram',
    'name': 'Telegram',
    'color': '#2AABEE',
    'loginUrl': 'https://web.telegram.org/k/',
    'homeUrl': 'https://web.telegram.org/k/',
    'verified': False,
    'notes': (
        'Dung Telegram Web K. Neu nhom co username cong khai, dien externalId dang "@ten" de mo truc tiep. '
        'Neu la nhom rieng, tool se tim theo ten nhom (phai la ten hien thi trong danh sach chat).'
    ),
    'caps': {'text': True, 'image': True, 'video': True, 'link': True, 'kinds': ['group', 'channel', 'profile']},
    'limits': {'maxChars': 4096, 'maxImages': 10, 'maxVideos': 1},
    'targetKinds': [
        {
            'kind': 'channel',
            'label': 'Kênh / Nhóm công khai',
            'match': [re.compile(r't\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/?$', re.I)],
            'buildUrl': lambda t: f"https://web.telegram.org/k/#@{str(t.get('external_id') or t.get('externalId')).lstrip('@')}",
        },
    ],
    'session': {
        'probeUrl': 'https://web.telegram.org/k/',
        'loggedIn': ['.chatlist', '#column-center', '.sidebar-header', '.chatlist-container'],
        'loggedOut': ['.auth-pages', '#auth-pages', '.page-sign', 'input[name="phone"]'],
    },
    'blockers': [
        {
            'when': [{'text': re.compile(r'flood wait|too many requests|quá nhiều yêu cầu', re.I)}],
            'message': 'Telegram yeu cau cho (flood wait).',
            'kind': 'rate_limit',
        },
    ],
    'prepare': lambda ctx: {'text': compose_text(ctx['post'])},
    'flows': {
        'channel': {
            'startUrl': lambda t, *args: f"https://web.telegram.org/k/#@{str(t.get('externalId') or t.get('external_id')).lstrip('@')}",
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 4000},
                {'waitFor': MESSAGE_BOX, 'timeout': 30000},
                {'click': MESSAGE_BOX, 'timeout': 15000},
                {'insertText': MESSAGE_BOX, 'value': '{{text}}'},
                {'wait': 800},
                {'press': 'Enter', 'submit': True},
                {'wait': 2500},
            ],
        },
        'group': {
            'startUrl': lambda *args: 'https://web.telegram.org/k/',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 4000},
                {'waitFor': ['.chatlist', '#column-center'], 'timeout': 30000},
                {'click': ['.input-search input', 'input.input-field-input', '#telegram-search-input'], 'timeout': 15000},
                {'wait': 500},
                {'type': ['.input-search input', 'input.input-field-input', '#telegram-search-input'], 'value': '{{target.name}}', 'clear': True, 'delay': 40},
                {'wait': 3000},
                {
                    'click': [
                        '.chatlist .chatlist-chat:first-of-type',
                        'ul.chatlist li a:first-of-type',
                        '.search-super .chatlist-chat',
                        '.dialog:first-of-type',
                    ],
                    'timeout': 20000,
                },
                {'wait': 2500},
                {'waitFor': MESSAGE_BOX, 'timeout': 25000},
                {'click': MESSAGE_BOX, 'timeout': 15000},
                {'insertText': MESSAGE_BOX, 'value': '{{text}}'},
                {'wait': 800},
                {
                    'when': lambda ctx: len(ctx.get('mediaPaths', [])) > 0,
                    'then': [
                        {
                            'click': ['.btn-icon.rp', 'button.btn-icon.rp', '[title="Attach"]'],
                            'optional': True,
                        },
                        {'wait': 800},
                        {
                            'click': [
                                '.menu-horizontal-div-item:has-text("Photo")',
                                '.menu-item:has-text("Photo")',
                                '.menu-horizontal-div-item:has-text("Ảnh")',
                            ],
                            'optional': True,
                        },
                        {'wait': 800},
                        {'upload': ['input[type="file"][accept*="image"]', 'input[type="file"]'], 'files': '{{imagePaths}}', 'optional': True},
                        {'wait': 4000},
                        {
                            'click': ['.btn-send', 'button.btn-send', '.new-message-wrapper .btn-send'],
                            'optional': True,
                        },
                    ],
                },
                {'press': 'Enter', 'timeout': 15000},
                {'wait': 2500},
            ],
        },
        'profile': {
            'startUrl': lambda *args: 'https://web.telegram.org/k/',
            'steps': [
                {'goto': '{{startUrl}}'},
                {'wait': 4000},
                {'waitFor': MESSAGE_BOX, 'timeout': 30000},
                {'click': MESSAGE_BOX, 'timeout': 15000},
                {'insertText': MESSAGE_BOX, 'value': '{{text}}'},
                {'wait': 800},
                {'press': 'Enter', 'submit': True},
                {'wait': 2500},
            ],
        },
    },
})
