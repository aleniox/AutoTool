import facebook from './facebook.js';
import linkedin from './linkedin.js';
import x from './x.js';
import telegram from './telegram.js';
import reddit from './reddit.js';
import instagram from './instagram.js';
import threads from './threads.js';
import tiktok from './tiktok.js';
import zalo from './zalo.js';

const list = [facebook, linkedin, x, telegram, reddit, instagram, threads, tiktok, zalo];
const ACTIVE_PLATFORMS = new Set(['facebook']);

export const platforms = new Map(list.map((p) => [p.id, p]));

export function getPlatform(id) {
  const p = platforms.get(String(id ?? '').toLowerCase());
  if (!p) throw new Error(`Nen tang khong duoc ho tro: ${id}`);
  return p;
}

export function hasPlatform(id) {
  return platforms.has(String(id ?? '').toLowerCase());
}

export function allPlatforms(activeOnly = false) {
  if (activeOnly) {
    return list.filter((p) => ACTIVE_PLATFORMS.has(p.id));
  }
  return [...platforms.values()];
}

/** Ban rut gon de tra ve qua API (bo cac ham). */
export function platformView(p) {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    loginUrl: p.loginUrl,
    homeUrl: p.homeUrl,
    verified: !!p.verified,
    experimental: !!p.experimental,
    notes: p.notes ?? '',
    caps: p.caps,
    limits: p.limits,
    kinds: (p.caps?.kinds ?? ['profile']).map((k) => ({
      kind: k,
      label: (p.targetKinds ?? []).find((t) => t.kind === k)?.label ?? KIND_LABELS[k] ?? k,
    })),
    targetKinds: (p.targetKinds ?? []).map((t) => ({ kind: t.kind, label: t.label })),
    flows: Object.keys(p.flows ?? {}),
  };
}

export function listPlatforms(activeOnly = true) {
  return allPlatforms(activeOnly).map(platformView);
}

const KIND_LABELS = {
  group: 'Nhóm',
  page: 'Trang',
  profile: 'Trang cá nhân',
  channel: 'Kênh',
  subreddit: 'Subreddit',
};

export const kindLabel = (k) => KIND_LABELS[k] ?? k;

/* -------------------------------------------------------------------------- */
/* Phan tich URL -> (platform, kind, externalId)                              */
/* -------------------------------------------------------------------------- */

/**
 * Doan nhan dang nhom/trang tu URL nguoi dung dan vao.
 * @returns {{platform:string, kind:string, externalId:string, url:string}|null}
 */
export function parseTargetUrl(rawUrl, { platformHint } = {}) {
  const url = String(rawUrl ?? '').trim();
  if (!url) return null;

  const candidates = platformHint ? [getPlatform(platformHint)] : allPlatforms();

  for (const p of candidates) {
    for (const tk of p.targetKinds ?? []) {
      for (const re of tk.match ?? []) {
        const m = url.match(re);
        if (m) {
          const id = (m[1] ?? m[2] ?? '').trim();
          if (!id) continue;
          return {
            platform: p.id,
            kind: tk.kind,
            externalId: id,
            url,
          };
        }
      }
    }
  }

  // Telegram: @username hoac t.me/...
  if (!platformHint || platformHint === 'telegram') {
    const m = url.match(/^(?:https?:\/\/(?:t\.me|telegram\.me)\/)?@?([A-Za-z0-9_]{4,32})$/);
    if (m) return { platform: 'telegram', kind: 'channel', externalId: `@${m[1]}`, url };
  }

  return null;
}

export { KIND_LABELS };
export default platforms;
