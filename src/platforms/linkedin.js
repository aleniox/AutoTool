import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* LinkedIn                                                                   */
/* -------------------------------------------------------------------------- */

const DIALOG_EDITOR = [
  'div[role="dialog"] div.ql-editor[contenteditable="true"]',
  'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
  'div[role="dialog"] .ql-editor',
];

const POST_BUTTON = [
  'div[role="dialog"] button.share-actions__primary-action',
  'div[role="dialog"] button[aria-label="Post"]',
  { role: 'button', name: /^(Post|Đăng|Đǎng)$/i },
  'div[role="dialog"] button:has-text("Post")',
  'div[role="dialog"] button:has-text("Đăng")',
];

/** Flow dang bai co ban: mo composer -> nhap -> (anh) -> Post. */
const SHARE_FLOW = [
  { waitFor: 'div[role="dialog"]', timeout: 20000 },
  { wait: 1200 },
  { fill: DIALOG_EDITOR, value: '{{text}}', timeout: 20000 },
  { wait: 600 },

  // Anh: LinkedIn bat buoc qua trinh "Next -> Done" cho tung anh.
  {
    ifFound: ['div[role="dialog"] input[type="file"]'],
    timeout: 4000,
    then: [
      {
        click: [
          'div[role="dialog"] button[aria-label="Add media"]',
          'div[role="dialog"] button[aria-label="Thêm nội dung"]',
          'div[role="dialog"] button:has-text("Photo")',
          { role: 'button', name: /add media|thêm nội dung|photo|ảnh/i },
        ],
        optional: true,
      },
      { wait: 600 },
      { upload: ['div[role="dialog"] input[type="file"][accept*="image"]', 'div[role="dialog"] input[type="file"]'], files: '{{imagePaths}}', optional: true },
      { wait: 4000 },
      {
        retry: 3,
        backoff: 1500,
        steps: [
          {
            click: [
              'button[aria-label="Next"]',
              { role: 'button', name: /^(Next|Tiếp|Tiếp theo)$/i },
              'div[role="dialog"] button:has-text("Next")',
            ],
            timeout: 15000,
          },
          { wait: 1500 },
        ],
      },
      {
        click: [
          'button[aria-label="Done"]',
          { role: 'button', name: /^(Done|Xong)$/i },
          'div[role="dialog"] button:has-text("Done")',
        ],
        timeout: 15000,
      },
      { wait: 1500 },
    ],
  },

  { click: POST_BUTTON, timeout: 30000, submit: true },
  { waitForGone: 'div[role="dialog"]', timeout: 90000, optional: true },
  { wait: 2500 },
];

export default definePlatform({
  id: 'linkedin',
  name: 'LinkedIn',
  color: '#0A66C2',
  loginUrl: 'https://www.linkedin.com/login',
  homeUrl: 'https://www.linkedin.com/feed/',
  verified: false,
  notes:
    'Ho tro dang len trang ca nhan (feed) va nhom ban la thanh vien. LinkedIn gioi han manh: ' +
    'nen giu tan suat thap. Anh bat buoc qua buoc Next/Done.',
  caps: { text: true, image: true, video: true, link: true, kinds: ['profile', 'group', 'page'] },
  limits: { maxChars: 3000, maxImages: 9, maxVideos: 1 },

  targetKinds: [
    {
      kind: 'group',
      label: 'Nhóm LinkedIn',
      match: [/linkedin\.com\/groups\/([^/?#]+)/i],
      buildUrl: (t) => `https://www.linkedin.com/groups/${t.external_id || t.externalId}/`,
    },
    {
      kind: 'page',
      label: 'Trang công ty',
      match: [/linkedin\.com\/company\/([^/?#]+)/i],
      buildUrl: (t) => `https://www.linkedin.com/company/${t.external_id || t.externalId}/admin/dashboard/`,
    },
  ],

  session: {
    probeUrl: 'https://www.linkedin.com/feed/',
    loggedIn: [
      'img.global-nav__me-photo',
      'button.global-nav__primary-link-me-menu-trigger',
      'div.feed-identity-module',
      '.scaffold-layout__sidebar',
      'nav[aria-label="Primary"]',
    ],
    loggedOut: ['form.login__form', 'input#username', 'input#password', '.login__form'],
  },

  blockers: RATE_LIMIT_BLOCKERS,

  prepare({ post }) {
    return { text: composeText(post) };
  },

  flows: {
    profile: {
      startUrl: () => 'https://www.linkedin.com/feed/',
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 2500 },
        {
          click: [
            'button.share-mb-processor-button',
            'button.share-box-feed-entry__trigger',
            { role: 'button', name: /start a post|tạo bài viết|bắt đầu một bài viết/i },
            'button:has-text("Start a post")',
            'button:has-text("Tạo bài viết")',
          ],
          timeout: 25000,
        },
        ...SHARE_FLOW,
      ],
    },

    group: {
      startUrl: (t) => `https://www.linkedin.com/groups/${t.externalId || t.external_id}/`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3000 },
        {
          click: [
            { role: 'button', name: /start a post|bắt đầu (một )?(bài viết|thảo luận)|create a post/i },
            'button:has-text("Start a post")',
            'button:has-text("Bắt đầu")',
            '.groups-post-trigger',
          ],
          timeout: 25000,
        },
        ...SHARE_FLOW,
      ],
    },

    page: {
      startUrl: (t) => `https://www.linkedin.com/company/${t.externalId || t.external_id}/admin/page-posts/published/`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3000 },
        {
          click: [
            { role: 'button', name: /create post|tạo bài viết/i },
            'button:has-text("Create post")',
          ],
          timeout: 25000,
        },
        ...SHARE_FLOW,
      ],
    },
  },
});
