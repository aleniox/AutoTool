/**
 * Tien ich chung cho cac dinh nghia nen tang.
 *
 * MOT NEN TANG = mot object khai bao (xem docs/PLATFORM-SPEC.md).
 * Khong co logic rieng: tat ca deu chay qua bo may flow o src/core/flow.js
 */

export function definePlatform(def) {
  const platform = {
    verified: false,
    experimental: false,
    notes: '',
    caps: { text: true, image: false, video: false, link: true, kinds: ['profile'] },
    limits: { maxChars: 0, maxImages: 0, maxVideos: 0 },
    targetKinds: [],
    blockers: [],
    session: {},
    ...def,
  };

  if (!platform.id) throw new Error('Platform thieu id');
  if (!platform.flows || typeof platform.flows !== 'object') {
    throw new Error(`Platform ${platform.id} thieu flows`);
  }
  return platform;
}

export function truncate(text, max) {
  const s = String(text ?? '');
  if (!max || s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/* -------------------------------------------------------------------------- */
/* Blocker dung chung: cac thong bao bi chan / gioi han tan suat              */
/* -------------------------------------------------------------------------- */

export const RATE_LIMIT_BLOCKERS = [
  {
    when: [
      { text: /you'?re temporarily blocked|temporarily blocked|tạm thời bị chặn/i },
      { text: /we limit how often you can post|giới hạn tần suất/i },
      { text: /try again later|thử lại sau/i },
      { text: /something went wrong|đã xảy ra lỗi/i },
    ],
    message: 'Nen tang bao bi chan / gioi han tan suat. Nen dung lai vai gio.',
    kind: 'rate_limit',
  },
  {
    when: [
      { text: /action was blocked|hành động bị chặn/i },
      { text: /you can'?t post right now|bạn không thể đăng/i },
      { text: /bạn đã bị chặn/i },
    ],
    message: 'Tai khoan bi chan thao tac dang bai.',
    kind: 'blocked',
  },
  {
    when: [
      { text: /session expired|phiên đăng nhập đã hết hạn/i },
      { text: /log ?in to continue|đăng nhập để tiếp tục/i },
      { text: /please log in|vui lòng đăng nhập/i },
    ],
    message: 'Phien dang nhap het han. Can dang nhap lai.',
    kind: 'auth',
  },
];

/* -------------------------------------------------------------------------- */
/* Manh flow dung lai                                                         */
/* -------------------------------------------------------------------------- */

/** Chon tab "Anh/Photo" neu co (LinkedIn, Reddit, ...) */
export function optionalClick(desc, timeout = 4000) {
  return { ifFound: desc, timeout, then: [{ click: desc, optional: true }] };
}

export default { definePlatform, truncate, RATE_LIMIT_BLOCKERS, optionalClick };
