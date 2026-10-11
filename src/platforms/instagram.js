import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* Instagram (web)                                                            */
/* -------------------------------------------------------------------------- */

export default definePlatform({
  id: 'instagram',
  name: 'Instagram',
  color: '#E1306C',
  loginUrl: 'https://www.instagram.com/accounts/login/',
  homeUrl: 'https://www.instagram.com/',
  verified: false,
  experimental: true,
  notes:
    'THU NGHIEM. Instagram web phat hien automation rat tot va thuong xuyen yeu cau xac minh. ' +
    'Chi dang duoc len trang ca nhan cua chinh ban (khong co khai niem "nhom"). ' +
    'Caption bat buoc voi bai co anh trong mot so truong hop.',
  caps: { text: false, image: true, video: true, link: false, kinds: ['profile'] },
  limits: { maxChars: 2200, maxImages: 10, maxVideos: 1 },

  targetKinds: [],

  session: {
    probeUrl: 'https://www.instagram.com/',
    loggedIn: [
      'svg[aria-label="Home"]',
      'svg[aria-label="Trang chủ"]',
      'a[href="/direct/inbox/"]',
      'svg[aria-label="New post"]',
      'svg[aria-label="Bài viết mới"]',
    ],
    loggedOut: ['input[name="username"]', 'form#loginForm', 'input[name="password"]'],
  },

  blockers: [
    ...RATE_LIMIT_BLOCKERS,
    {
      when: [{ text: /we restrict certain activity|chúng tôi hạn chế một số hoạt động/i }],
      message: 'Instagram tam khoa hoat dong. Can doi vai gio.',
      kind: 'blocked',
    },
  ],

  prepare({ post }) {
    return { text: composeText(post, { includeLink: false }) };
  },

  flows: {
    profile: {
      startUrl: () => 'https://www.instagram.com/',
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3500 },

        {
          click: [
            'svg[aria-label="New post"]',
            'svg[aria-label="Bài viết mới"]',
            'svg[aria-label="Create"]',
            'a[href="#"]:has-text("Create")',
            'div[role="button"]:has-text("Create")',
          ],
          timeout: 20000,
        },
        { wait: 1500 },

        { upload: ['input[type="file"][accept*="image"]', 'input[type="file"][accept*="video"]', 'input[type="file"]'], files: '{{mediaPaths}}', timeout: 60000 },

        // Buoc 1: crop
        {
          click: [
            'div[role="dialog"] div[role="button"]:has-text("Next")',
            'div[role="dialog"] div[role="button"]:has-text("Tiếp")',
            { role: 'button', name: /^(Next|Tiếp)$/i },
          ],
          timeout: 40000,
        },
        { wait: 1500 },
        // Buoc 2: filter/edit
        {
          click: [
            'div[role="dialog"] div[role="button"]:has-text("Next")',
            'div[role="dialog"] div[role="button"]:has-text("Tiếp")',
            { role: 'button', name: /^(Next|Tiếp)$/i },
          ],
          timeout: 40000,
        },
        { wait: 2000 },

        { fill: ['div[contenteditable="true"][aria-label*="caption"]', 'textarea[aria-label*="caption"]', 'div[contenteditable="true"][aria-label*="chú thích"]'], value: '{{text}}', timeout: 20000, optional: true },
        { wait: 1000 },

        {
          click: [
            'div[role="dialog"] div[role="button"]:has-text("Share")',
            'div[role="dialog"] div[role="button"]:has-text("Chia sẻ")',
            { role: 'button', name: /^(Share|Chia sẻ)$/i },
          ],
          timeout: 40000,
          submit: true,
        },
        { waitForGone: 'div[role="dialog"]', timeout: 120000, optional: true },
        { wait: 3000 },
      ],
    },
  },
});
