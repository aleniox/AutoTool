import { definePlatform, RATE_LIMIT_BLOCKERS } from './_shared.js';
import { composeText } from '../core/flow.js';

/* -------------------------------------------------------------------------- */
/* Reddit                                                                     */
/* -------------------------------------------------------------------------- */

const TITLE_INPUT = [
  'textarea[name="title"]',
  'input[name="title"]',
  '#post-title',
  'textarea[placeholder*="Title"]',
  'textarea[placeholder*="Tiêu đề"]',
  'faceplate-textarea-input textarea',
];

const BODY_INPUT = [
  'div[contenteditable="true"][name="body"]',
  'shreddit-composer div[contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  'textarea[name="text"]',
  'textarea[placeholder*="Text"]',
  'textarea[placeholder*="nội dung"]',
];

export default definePlatform({
  id: 'reddit',
  name: 'Reddit',
  color: '#FF4500',
  loginUrl: 'https://www.reddit.com/login/',
  homeUrl: 'https://www.reddit.com/',
  verified: false,
  notes:
    'Dang bai dang text vao subreddit. Moi subreddit co rules rieng - dang sai rules se bi xoa va co the bi ban. ' +
    'Reddit yeu cau tieu de (title) bat buoc.',
  caps: { text: true, image: true, video: false, link: true, kinds: ['subreddit', 'profile'] },
  limits: { maxChars: 40000, maxImages: 20, maxVideos: 0 },

  targetKinds: [
    {
      kind: 'subreddit',
      label: 'Subreddit',
      match: [/reddit\.com\/r\/([^/?#]+)/i],
      buildUrl: (t) => `https://www.reddit.com/r/${t.external_id || t.externalId}/submit`,
    },
    {
      kind: 'profile',
      label: 'Trang cá nhân',
      match: [/reddit\.com\/u(?:ser)?\/([^/?#]+)/i],
      buildUrl: (t) => `https://www.reddit.com/user/${t.external_id || t.externalId}/submit`,
    },
  ],

  session: {
    probeUrl: 'https://www.reddit.com/',
    loggedIn: [
      '#expand-user-drawer-button',
      'faceplate-tracker[noun="user_drawer"]',
      'a[href^="/user/"][aria-label]',
      'shreddit-app[user-logged-in="true"]',
    ],
    loggedOut: ['a[href*="/login"]', 'faceplate-tracker[noun="login"]', 'a[href="/register/"]'],
  },

  blockers: RATE_LIMIT_BLOCKERS,

  prepare({ post }) {
    const title = (post.title || composeText(post).split('\n')[0] || 'Bài viết').slice(0, 295);
    const body = post.caption || '';
    const extra = [post.hashtags, post.link].filter(Boolean).join('\n');
    return { title, text: [body, extra].filter(Boolean).join('\n\n') };
  },

  flows: {
    subreddit: {
      startUrl: (t) => `https://www.reddit.com/r/${t.externalId || t.external_id}/submit`,
      steps: [
        { goto: '{{startUrl}}' },
        { wait: 3500 },

        // Neu co anh -> chuyen sang tab Images
        {
          ifFound: ['input[type="file"]'],
          timeout: 5000,
          then: [
            {
              click: [
                { role: 'tab', name: /images|hình ảnh|ảnh/i },
                'button:has-text("Images")',
                'a:has-text("Images")',
              ],
              optional: true,
            },
            { wait: 1200 },
            { upload: ['input[type="file"][accept*="image"]', 'input[type="file"]'], files: '{{imagePaths}}', optional: true },
            { wait: 5000 },
          ],
        },

        { fill: TITLE_INPUT, value: '{{title}}', timeout: 25000 },
        { wait: 500 },
        { fill: BODY_INPUT, value: '{{text}}', timeout: 20000, optional: true },
        { wait: 800 },

        {
          click: [
            'button[type="submit"]:has-text("Post")',
            { role: 'button', name: /^(Post|Đăng)$/i },
            'button:has-text("Post")',
            '#submit-post-button',
          ],
          timeout: 30000,
          submit: true,
        },
        { waitForUrl: /reddit\.com\/(r|user)\//, timeout: 60000, optional: true },
        { wait: 3000 },
      ],
    },
  },
});
