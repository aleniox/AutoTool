import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* Threads (Meta)                                                             */
/* -------------------------------------------------------------------------- */

export default definePlatform({
  id: 'threads',
  name: 'Threads',
  color: '#000000',
  loginUrl: 'https://www.threads.net/login',
  homeUrl: 'https://www.threads.net/',
  verified: false,
  experimental: true,
  notes:
    'THU NGHIEM. Dang len trang ca nhan Threads. Gioi han 500 ky tu/bai. ' +
    'Threads cho phep dang qua web voi cung phien Instagram/Facebook.',
  caps: { text: true, image: true, video: true, link: true, kinds: ['profile'] },
  limits: { maxChars: 500, maxImages: 10, maxVideos: 1 },

  targetKinds: [],

  session: {
    probeUrl: 'https://www.threads.net/',
    loggedIn: [
      'svg[aria-label="Create"]',
      'svg[aria-label="Tạo"]',
      'a[href="/settings"]',
      'div[role="button"]:has-text("Start a thread")',
      'svg[aria-label="Profile"]',
    ],
    loggedOut: ['input[name="username"]', 'a[href="/login"]', 'div:has-text("Log in with Instagram")'],
  },

  blockers: RATE_LIMIT_BLOCKERS,

  prepare({ post }) {
    const full = composeText(post);
    return { text: full.length > 500 ? `${full.slice(0, 499)}…` : full };
  },

  flows: {
    profile: {
      startUrl: () => 'https://www.threads.net/',
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3500 },

        {
          click: [
            'svg[aria-label="Create"]',
            'svg[aria-label="Tạo"]',
            'div[role="button"]:has-text("Start a thread")',
            'div[role="button"]:has-text("Bắt đầu")',
            'div[role="button"]:has-text("Thread mới")',
          ],
          timeout: 20000,
        },
        { wait: 1800 },

        {
          waitFor: [
            'div[role="dialog"] div[contenteditable="true"]',
            'div[contenteditable="true"][data-lexical-editor="true"]',
          ],
          timeout: 20000,
        },
        { fill: ['div[role="dialog"] div[contenteditable="true"]', 'div[contenteditable="true"][data-lexical-editor="true"]'], value: '{{text}}', timeout: 20000 },
        { wait: 800 },

        {
          ifFound: ['div[role="dialog"] input[type="file"]', 'input[type="file"][accept*="image"]'],
          timeout: 4000,
          then: [
            { upload: ['div[role="dialog"] input[type="file"]', 'input[type="file"][accept*="image"]'], files: '{{mediaPaths}}', optional: true },
            { wait: 5000 },
          ],
        },

        {
          click: [
            'div[role="dialog"] div[role="button"]:has-text("Post")',
            'div[role="dialog"] div[role="button"]:has-text("Đăng")',
            { role: 'button', name: /^(Post|Đăng)$/i },
          ],
          timeout: 30000,
          submit: true,
        },
        { waitForGone: 'div[role="dialog"]', timeout: 90000, optional: true },
        { wait: 2500 },
      ],
    },
  },
});
