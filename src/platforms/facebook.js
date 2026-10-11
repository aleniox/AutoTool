import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* Facebook                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Composer cua Facebook (ca Group va Page) deu mo ra mot dialog voi
 * contenteditable + input file an. Dung chung mot doan flow.
 */
const COMPOSER_STEPS = [
  { waitFor: 'div[role="dialog"]', timeout: 20000 },
  { wait: 1200 },

  // O nhap noi dung chinh
  {
    click: [
      'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
      'div[role="dialog"] div[contenteditable="true"]',
    ],
    timeout: 20000,
  },
  {
    fill: [
      'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
      'div[role="dialog"] div[contenteditable="true"]',
    ],
    value: '{{text}}',
    timeout: 20000,
  },
  { wait: 800 },

  // Anh / video (input file nam an trong dialog)
  {
    ifFound: [
      'div[role="dialog"] input[type="file"][accept*="image"]',
      'div[role="dialog"] input[type="file"]',
    ],
    timeout: 5000,
    then: [
      {
        upload: [
          'div[role="dialog"] input[type="file"][accept*="image"]',
          'div[role="dialog"] input[type="file"]',
        ],
        files: '{{mediaPaths}}',
        optional: true,
      },
      // Cho thumbnail render xong
      { wait: 6000 },
    ],
  },

  // Nut Dang
  {
    click: [
      'div[role="dialog"] div[aria-label="Post"][role="button"]',
      'div[role="dialog"] div[aria-label="Đăng"][role="button"]',
      'div[role="dialog"] [aria-label="Post"]',
      'div[role="dialog"] [aria-label="Đăng"]',
      { role: 'button', name: /^(Post|Đăng|Đǎng)$/ },
      'div[role="dialog"] div[role="button"]:has-text("Post")',
      'div[role="dialog"] div[role="button"]:has-text("Đăng")',
    ],
    timeout: 30000,
    submit: true,
  },
  { waitForGone: 'div[role="dialog"]', timeout: 90000, optional: true },
  { wait: 2000 },
];

const OPEN_COMPOSER = [
  {
    click: [
      { role: 'button', name: /write something|viết gì|bạn viết gì|tạo bài viết/i },
      'div[role="button"]:has-text("Write something")',
      'div[role="button"]:has-text("Viết gì")',
      'div[role="button"]:has-text("Bạn viết gì")',
      '[aria-label="Write something..."]',
      '[aria-label="Viết gì đó..."]',
      'div[role="button"][tabindex="0"]:has-text("…")',
    ],
    timeout: 25000,
  },
];

export default definePlatform({
  id: 'facebook',
  name: 'Facebook',
  color: '#1877F2',
  loginUrl: 'https://www.facebook.com/login',
  homeUrl: 'https://www.facebook.com/',
  verified: false,
  notes:
    'Dung giao dien web. Facebook thuong xuyen doi DOM va co the checkpoint khi dang qua nhanh. ' +
    'Nen dat delay >= 3 phut/bai. Chi dang vao nhom ban quan tri hoac noi cho phep.',
  caps: { text: true, image: true, video: true, link: true, kinds: ['group', 'page', 'profile'] },
  limits: { maxChars: 60000, maxImages: 10, maxVideos: 1 },

  targetKinds: [
    {
      kind: 'group',
      label: 'Nhóm',
      match: [/facebook\.com\/groups\/([^/?#]+)/i],
      buildUrl: (t) => `https://www.facebook.com/groups/${t.external_id || t.externalId}`,
    },
    {
      kind: 'page',
      label: 'Trang',
      match: [
        /facebook\.com\/profile\.php\?id=(\d+)/i,
        /facebook\.com\/pages\/[^/]+\/(\d+)/i,
      ],
      buildUrl: (t) => `https://www.facebook.com/${t.external_id || t.externalId}`,
    },
    {
      kind: 'profile',
      label: 'Trang cá nhân',
      match: [/facebook\.com\/(?:people\/[^/]+\/)?(\d{6,})\/?$/i],
      buildUrl: (t) => `https://www.facebook.com/${t.external_id || t.externalId}`,
    },
  ],

  session: {
    probeUrl: 'https://www.facebook.com/me',
    loggedIn: [
      'div[role="navigation"] svg[aria-label="Your profile"]',
      'div[aria-label="Your profile"]',
      'a[href*="/friends"]',
      'div[role="banner"]',
    ],
    loggedOut: ['input[name="email"]', 'input[name="pass"]', '#login_form', 'form[action*="login"]'],
  },

  blockers: RATE_LIMIT_BLOCKERS,

  prepare({ post }) {
    // Facebook khong ho tro hashtag "an": de nguyen nhu nguoi dung nhap.
    return { text: composeText(post) };
  },

  flows: {
    group: {
      startUrl: (t) => `https://www.facebook.com/groups/${t.externalId || t.external_id}`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3000 },
        ...OPEN_COMPOSER,
        ...COMPOSER_STEPS,
      ],
    },
    page: {
      startUrl: (t) => `https://www.facebook.com/${t.externalId || t.external_id}`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3000 },
        ...OPEN_COMPOSER,
        ...COMPOSER_STEPS,
      ],
    },
    profile: {
      startUrl: (t) => `https://www.facebook.com/${t.externalId || t.external_id}`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3000 },
        ...OPEN_COMPOSER,
        ...COMPOSER_STEPS,
      ],
    },
  },
});
