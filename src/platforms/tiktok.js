import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* TikTok (TikTok Studio upload)                                              */
/* -------------------------------------------------------------------------- */

export default definePlatform({
  id: 'tiktok',
  name: 'TikTok',
  color: '#FE2C55',
  loginUrl: 'https://www.tiktok.com/login',
  homeUrl: 'https://www.tiktok.com/tiktokstudio',
  verified: false,
  experimental: true,
  notes:
    'THU NGHIEM. Bat buoc phai co video (TikTok khong cho dang anh qua web). ' +
    'Qua trinh upload + xu ly video mat nhieu thoi gian, nen dat timeout lon.',
  caps: { text: true, image: false, video: true, link: false, kinds: ['profile'] },
  limits: { maxChars: 2200, maxImages: 0, maxVideos: 1 },

  targetKinds: [],

  session: {
    probeUrl: 'https://www.tiktok.com/tiktokstudio',
    loggedIn: [
      '[data-e2e="profile-icon"]',
      'a[href*="/profile"]',
      '[data-e2e="upload-icon"]',
      'div[data-e2e="nav-upload"]',
    ],
    loggedOut: ['div[data-e2e="login-button"]', 'a[href*="/login"]', '#loginContainer'],
  },

  blockers: RATE_LIMIT_BLOCKERS,

  prepare({ post }) {
    return { text: composeText(post, { includeLink: false }) };
  },

  flows: {
    profile: {
      startUrl: () => 'https://www.tiktok.com/tiktokstudio/upload?from=webapp',
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 5000 },
        { waitFor: 'input[type="file"]', timeout: 40000 },

        // Uu tien video, neu khong co thi lay bat ky media nao
        {
          when: (ctx) => ctx.videoPaths.length > 0,
          then: [{ upload: 'input[type="file"]', files: '{{videoPaths}}', timeout: 120000 }],
          else: [{ upload: 'input[type="file"]', files: '{{mediaPaths}}', timeout: 120000 }],
        },
        { wait: 10000 },

        { fill: ['div[contenteditable="true"]', '.public-DraftEditor-content', 'div[data-e2e="caption-input"]'], value: '{{text}}', timeout: 40000, optional: true },
        { wait: 2000 },

        {
          click: [
            'button[data-e2e="post_video_button"]',
            'button:has-text("Post")',
            'button:has-text("Đăng")',
            { role: 'button', name: /^(Post|Đăng)$/i },
          ],
          timeout: 60000,
          submit: true,
        },
        { wait: 8000 },
      ],
    },
  },
});
