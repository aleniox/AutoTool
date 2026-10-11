import { definePlatform } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* Telegram (Web K)                                                           */
/* -------------------------------------------------------------------------- */

const MESSAGE_BOX = [
  'div.input-message-input[contenteditable="true"]',
  '.input-message-input[contenteditable="true"]',
  '#editable-message-text',
  'div[contenteditable="true"][data-placeholder]',
];

export default definePlatform({
  id: 'telegram',
  name: 'Telegram',
  color: '#2AABEE',
  loginUrl: 'https://web.telegram.org/k/',
  homeUrl: 'https://web.telegram.org/k/',
  verified: false,
  notes:
    'Dung Telegram Web K. Neu nhom co username cong khai, dien externalId dang "@ten" de mo truc tiep. ' +
    'Neu la nhom rieng, tool se tim theo ten nhom (phai la ten hien thi trong danh sach chat).',
  caps: { text: true, image: true, video: true, link: true, kinds: ['group', 'channel', 'profile'] },
  limits: { maxChars: 4096, maxImages: 10, maxVideos: 1 },

  targetKinds: [
    {
      kind: 'channel',
      label: 'Kênh / Nhóm công khai',
      match: [/t\.me\/(?:s\/)?([A-Za-z0-9_]{4,})\/?$/i],
      buildUrl: (t) => `https://web.telegram.org/k/#@${String(t.external_id || t.externalId).replace(/^@/, '')}`,
    },
  ],

  session: {
    probeUrl: 'https://web.telegram.org/k/',
    loggedIn: ['.chatlist', '#column-center', '.sidebar-header', '.chatlist-container'],
    loggedOut: ['.auth-pages', '#auth-pages', '.page-sign', 'input[name="phone"]'],
  },

  blockers: [
    {
      when: [{ text: /flood wait|too many requests|quá nhiều yêu cầu/i }],
      message: 'Telegram yeu cau cho (flood wait).',
      kind: 'rate_limit',
    },
  ],

  prepare({ post }) {
    return { text: composeText(post) };
  },

  flows: {
    // Mo chat bang username cong khai
    channel: {
      startUrl: (t) =>
        `https://web.telegram.org/k/#@${String(t.externalId || t.external_id).replace(/^@/, '')}`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 4000 },
        { waitFor: MESSAGE_BOX, timeout: 30000 },
        { click: MESSAGE_BOX, timeout: 15000 },
        { insertText: MESSAGE_BOX, value: '{{text}}' },
        { wait: 800 },
        { press: 'Enter', submit: true },
        { wait: 2500 },
      ],
    },

    // Tim chat theo ten trong danh sach hoi thoai
    group: {
      startUrl: () => 'https://web.telegram.org/k/',
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 4000 },
        { waitFor: ['.chatlist', '#column-center'], timeout: 30000 },

        { click: ['.input-search input', 'input.input-field-input', '#telegram-search-input'], timeout: 15000 },
        { wait: 500 },
        { type: ['.input-search input', 'input.input-field-input', '#telegram-search-input'], value: '{{target.name}}', clear: true, delay: 40 },
        { wait: 3000 },

        {
          click: [
            '.chatlist .chatlist-chat:first-of-type',
            'ul.chatlist li a:first-of-type',
            '.search-super .chatlist-chat',
            '.dialog:first-of-type',
          ],
          timeout: 20000,
        },
        { wait: 2500 },
        { waitFor: MESSAGE_BOX, timeout: 25000 },
        { click: MESSAGE_BOX, timeout: 15000 },
        { insertText: MESSAGE_BOX, value: '{{text}}' },
        { wait: 800 },

        {
          when: (ctx) => ctx.mediaPaths.length > 0,
          then: [
            {
              click: ['.btn-icon.rp', 'button.btn-icon.rp', '[title="Attach"]'],
              optional: true,
            },
            { wait: 800 },
            {
              click: [
                '.menu-horizontal-div-item:has-text("Photo")',
                '.menu-item:has-text("Photo")',
                '.menu-horizontal-div-item:has-text("Ảnh")',
              ],
              optional: true,
            },
            { wait: 800 },
            { upload: ['input[type="file"][accept*="image"]', 'input[type="file"]'], files: '{{imagePaths}}', optional: true },
            { wait: 4000 },
            {
              click: ['.btn-send', 'button.btn-send', '.new-message-wrapper .btn-send'],
              optional: true,
            },
          ],
        },

        { press: 'Enter', timeout: 15000 },
        { wait: 2500 },
      ],
    },

    profile: {
      startUrl: () => 'https://web.telegram.org/k/',
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 4000 },
        { waitFor: MESSAGE_BOX, timeout: 30000 },
        { click: MESSAGE_BOX, timeout: 15000 },
        { insertText: MESSAGE_BOX, value: '{{text}}' },
        { wait: 800 },
        { press: 'Enter', submit: true },
        { wait: 2500 },
      ],
    },
  },
});
