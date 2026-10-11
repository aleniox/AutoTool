import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import config from '../../config.js';
import { all, get, run, insert, update, nowIso, parseJson, getSetting, setSetting } from '../../db.js';
import { h, requireFields, toInt, badRequest, notFound } from '../http.js';
import { createLogger } from '../../logger.js';

const router = express.Router();
const log = createLogger('api:content');

/* -------------------------------------------------------------------------- */
/* Media                                                                      */
/* -------------------------------------------------------------------------- */

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);

export function mediaType(filename) {
  const ext = path.extname(filename).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (IMAGE_EXT.has(ext)) return 'image';
  return 'file';
}

export function sanitizeName(raw) {
  const base = path.basename(String(raw ?? '')).replace(/[^\w.\- ]+/g, '_').slice(-120);
  return base || `file-${Date.now()}`;
}

function mediaRecord(name) {
  const abs = path.join(config.paths.media, name);
  return {
    name,
    path: abs,
    url: `/media/${encodeURIComponent(name)}`,
    type: mediaType(name),
    size: fs.existsSync(abs) ? fs.statSync(abs).size : 0,
  };
}

/** Chuan hoa mang media tu client (ten file hoac object) thanh record day du. */
export function normalizeMedia(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => {
      const name = typeof item === 'string' ? item : item?.name;
      if (!name) return null;
      const safe = sanitizeName(name);
      if (!fs.existsSync(path.join(config.paths.media, safe))) return null;
      return mediaRecord(safe);
    })
    .filter(Boolean);
}

/** Upload raw binary: POST /api/media?name=anh.jpg  (body = bytes) */
router.post(
  '/media',
  express.raw({ type: () => true, limit: config.maxUploadBytes }),
  h(async (req, res) => {
    if (!req.body || !req.body.length) throw badRequest('File rong');
    const original = sanitizeName(req.query.name || `file-${Date.now()}`);
    const ext = path.extname(original);
    const stem = path.basename(original, ext);
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}-${stem}${ext}`;

    await fsp.writeFile(path.join(config.paths.media, name), req.body);
    log.info(`Upload ${name} (${req.body.length} byte)`);
    res.status(201).json({ file: mediaRecord(name) });
  }),
);

router.get(
  '/media',
  h(async (_req, res) => {
    const files = await fsp.readdir(config.paths.media).catch(() => []);
    const items = files
      .filter((f) => !f.startsWith('.'))
      .map(mediaRecord)
      .sort((a, b) => b.name.localeCompare(a.name));
    res.json({ files: items });
  }),
);

router.delete(
  '/media/:name',
  h(async (req, res) => {
    const name = sanitizeName(req.params.name);
    const abs = path.join(config.paths.media, name);
    if (!abs.startsWith(config.paths.media) || !fs.existsSync(abs)) throw notFound('Khong tim thay file');
    const inUse = all('SELECT id, media FROM posts')
      .filter((p) => parseJson(p.media, []).some((m) => m.name === name));
    if (inUse.length) throw badRequest(`File dang duoc dung trong ${inUse.length} bai viet`);
    await fsp.unlink(abs);
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Posts                                                                      */
/* -------------------------------------------------------------------------- */

function shapePost(row) {
  return { ...row, media: parseJson(row.media, []) };
}

function buildMediaPayload(list) {
  return JSON.stringify(normalizeMedia(list));
}

router.get(
  '/posts',
  h(async (req, res) => {
    const projectId = toInt(req.query.projectId);
    const q = req.query.q ? String(req.query.q).trim() : '';
    const where = [];
    const params = [];
    if (projectId) {
      where.push('project_id = ?');
      params.push(projectId);
    }
    if (q) {
      where.push('(title LIKE ? OR caption LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    const limit = Math.min(500, toInt(req.query.limit, 200));
    const rows = all(
      `SELECT * FROM posts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`,
      ...params,
      limit,
    );
    res.json({ posts: rows.map(shapePost), total: get('SELECT COUNT(*) AS c FROM posts').c });
  }),
);

router.get(
  '/posts/:id',
  h(async (req, res) => {
    const row = get('SELECT * FROM posts WHERE id = ?', toInt(req.params.id));
    if (!row) throw notFound('Khong tim thay bai viet');
    res.json({ post: shapePost(row) });
  }),
);

router.post(
  '/posts',
  h(async (req, res) => {
    const caption = String(req.body?.caption ?? '').trim();
    const title = String(req.body?.title ?? '').trim();
    if (!caption && !title) throw badRequest('Bai viet phai co tieu de hoac noi dung');

    const id = insert('posts', {
      project_id: toInt(req.body.projectId),
      title,
      caption,
      link: String(req.body.link ?? '').trim(),
      hashtags: String(req.body.hashtags ?? '').trim(),
      media: buildMediaPayload(req.body.media),
      created_at: nowIso(),
    });
    res.status(201).json({ post: shapePost(get('SELECT * FROM posts WHERE id = ?', id)) });
  }),
);

router.patch(
  '/posts/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM posts WHERE id = ?', id)) throw notFound('Khong tim thay bai viet');
    const patch = {};
    for (const key of ['title', 'caption', 'link', 'hashtags']) {
      if (req.body[key] !== undefined) patch[key] = String(req.body[key]).trim();
    }
    if (req.body.projectId !== undefined) patch.project_id = toInt(req.body.projectId);
    if (req.body.media !== undefined) patch.media = buildMediaPayload(req.body.media);
    if (Object.keys(patch).length) update('posts', id, patch);
    res.json({ post: shapePost(get('SELECT * FROM posts WHERE id = ?', id)) });
  }),
);

router.delete(
  '/posts/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM posts WHERE id = ?', id)) throw notFound('Khong tim thay bai viet');
    run('DELETE FROM posts WHERE id = ?', id);
    res.json({ ok: true });
  }),
);

router.post(
  '/posts/delete-bulk',
  h(async (req, res) => {
    const ids = (req.body?.ids ?? []).map((i) => toInt(i)).filter(Boolean);
    if (!ids.length) throw badRequest('Chua chon bai viet nao');
    const ph = ids.map(() => '?').join(',');
    res.json({ ok: true, deleted: run(`DELETE FROM posts WHERE id IN (${ph})`, ...ids).changes });
  }),
);

/**
 * Import nhieu bai tu text.
 *
 * Dinh dang: cac bai cach nhau bang dong `---`.
 * Trong moi bai:
 *   Tieu de: <tieu de>      (tuy chon)
 *   Link: <url>             (tuy chon)
 *   Anh: a.jpg, b.png       (tuy chon)
 *   #hashtag ...            (tuy chon)
 *   ...phan con lai la noi dung...
 */
router.post(
  '/posts/import',
  h(async (req, res) => {
    requireFields(req.body, ['text']);
    const projectId = toInt(req.body.projectId);
    const attachAll = req.body.attachMedia === 'all';
    const allMedia = normalizeMedia(req.body.media ?? []);

    const blocks = String(req.body.text)
      .split(/^\s*-{3,}\s*$/m)
      .map((b) => b.trim())
      .filter(Boolean);

    if (!blocks.length) throw badRequest('Khong tim thay bai viet nao trong noi dung');

    const created = [];
    for (const block of blocks) {
      const lines = block.split(/\r?\n/);
      let title = '';
      let link = '';
      let hashtags = '';
      let mediaNames = [];
      const body = [];

      for (const line of lines) {
        const m = /^(tiêu đề|tieu de|title)\s*:\s*(.+)$/i.exec(line);
        const l = /^(link|url)\s*:\s*(.+)$/i.exec(line);
        const a = /^(ảnh|anh|media|hình|hinh|image|images)\s*:\s*(.+)$/i.exec(line);
        const h = /^(hashtag|tags?)\s*:\s*(.+)$/i.exec(line);

        if (m) title = m[2].trim();
        else if (l) link = l[2].trim();
        else if (a) mediaNames = a[2].split(/[,;]/).map((s) => s.trim()).filter(Boolean);
        else if (h) hashtags = h[2].trim();
        else if (/^#[\w\u00C0-\u024F]+/.test(line.trim()) && !body.length) hashtags = line.trim();
        else body.push(line);
      }

      let caption = body.join('\n').trim();
      if (!title && !caption) continue;
      if (!title && caption.length <= 120 && !caption.includes('\n')) {
        title = caption;
      }

      let media = mediaNames.length ? normalizeMedia(mediaNames) : attachAll ? allMedia : [];

      const id = insert('posts', {
        project_id: projectId,
        title,
        caption,
        link,
        hashtags,
        media: JSON.stringify(media),
        created_at: nowIso(),
      });
      created.push(shapePost(get('SELECT * FROM posts WHERE id = ?', id)));
    }

    log.info(`Import ${created.length} bai viet`);
    res.json({ posts: created, total: blocks.length });
  }),
);

/* -------------------------------------------------------------------------- */
/* AI (Gemini) Assistant                                                      */
/* -------------------------------------------------------------------------- */

function maskKey(key) {
  if (!key) return '';
  const s = String(key).trim();
  if (s.length <= 8) return '********';
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

router.get(
  '/ai/settings',
  h(async (_req, res) => {
    const key = (getSetting('gemini_api_key', '') || process.env.GEMINI_API_KEY || '').trim();
    const model = (getSetting('gemini_model', '') || 'gemini-2.5-flash').trim();
    res.json({
      hasKey: !!key,
      maskedKey: maskKey(key),
      model,
    });
  }),
);

router.post(
  '/ai/settings',
  h(async (req, res) => {
    const apiKey = (req.body?.apiKey ?? '').trim();
    const model = (req.body?.model ?? '').trim() || 'gemini-2.5-flash';
    if (apiKey) {
      setSetting('gemini_api_key', apiKey);
    }
    setSetting('gemini_model', model);
    const key = (getSetting('gemini_api_key', '') || process.env.GEMINI_API_KEY || '').trim();
    res.json({
      ok: true,
      hasKey: !!key,
      maskedKey: maskKey(key),
      model,
    });
  }),
);

router.post(
  '/ai/generate',
  h(async (req, res) => {
    const passedKey = (req.body?.apiKey ?? '').trim();
    const apiKey = passedKey || (getSetting('gemini_api_key', '') || process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey) {
      throw badRequest('Chưa cấu hình Gemini API Key. Vui lòng nhập API Key trên giao diện.');
    }

    if (req.body?.saveKey && passedKey) {
      setSetting('gemini_api_key', passedKey);
    }

    const model = (req.body?.model ?? '').trim() || (getSetting('gemini_model', '') || 'gemini-2.5-flash').trim();
    const mode = req.body?.mode || 'generate';
    const topic = (req.body?.topic ?? '').trim();
    const existingContent = (req.body?.existingContent ?? '').trim();
    const platform = (req.body?.platform ?? 'đa nền tảng').trim();
    const tone = (req.body?.tone ?? 'bán hàng thu hút').trim();
    const instructions = (req.body?.instructions ?? '').trim();
    const count = Math.min(5, Math.max(1, Number(req.body?.count) || 1));

    let promptText = '';

    if (mode === 'rewrite') {
      if (!existingContent) throw badRequest('Vui lòng nhập nội dung cần viết lại');
      promptText = `Bạn là chuyên gia biên tập và tối ưu nội dung mạng xã hội.
Hãy viết lại bài viết sau đây theo phong cách: "${tone}".
Nền tảng hướng tới: ${platform}.
Yêu cầu thêm: ${instructions || 'Viết lại hấp dẫn hơn, thêm emoji phù hợp, ngắt dòng rõ ràng, bổ sung hashtag liên quan'}.

NỘI DUNG GỐC:
"""
${existingContent}
"""

Yêu cầu định dạng đầu ra:
Bạn PHẢI trả về JSON hợp lệ theo đúng cấu trúc sau (không thêm bất kỳ văn bản markdown hay giải thích nào ngoài JSON):
{
  "title": "Tiêu đề ngắn gọn, bắt mắt (nếu phù hợp)",
  "caption": "Nội dung bài viết hoàn chỉnh đã được viết lại, ngắt dòng đẹp mắt và có emoji...",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3",
  "variations": []
}`;
    } else {
      if (!topic && !instructions) throw badRequest('Vui lòng nhập chủ đề hoặc ý tưởng bài viết');
      promptText = `Bạn là chuyên gia sáng tạo nội dung mạng xã hội hàng đầu.
Hãy viết bài đăng cho nền tảng: "${platform}".
Chủ đề / Ý tưởng: "${topic}".
Giọng điệu / Phong cách: "${tone}".
Yêu cầu thêm: ${instructions || 'Nội dung hấp dẫn, bắt trend, có lời kêu gọi hành động (CTA), chèn emoji sinh động'}.
Số lượng bài viết cần tạo: ${count}.

Yêu cầu định dạng đầu ra:
Bạn PHẢI trả về JSON hợp lệ theo đúng cấu trúc sau (không thêm bất kỳ văn bản markdown hay giải thích nào ngoài JSON):
{
  "title": "Tiêu đề bài viết ngắn gọn, giật tít, hấp dẫn",
  "caption": "Nội dung bài viết hoàn chỉnh, ngắt dòng đẹp mắt, có icon/emoji và lời kêu gọi hành động (CTA)...",
  "hashtags": "#hashtag1 #hashtag2 #hashtag3",
  "variations": [
    ${
      count > 1
        ? `// Nếu count=${count}, hãy tạo thêm ${count - 1} bài viết khác (khác góc nhìn, cách mở đầu hoặc phong cách) trong mảng này:
    {
      "title": "Tiêu đề biến thể...",
      "caption": "Nội dung biến thể...",
      "hashtags": "#hashtag1 #hashtag2"
    }`
        : ''
    }
  ]
}`;
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: promptText }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            responseMimeType: 'application/json',
          },
        }),
      });
    } catch (netErr) {
      log.error(`Ket noi Gemini API that bai: ${netErr.message}`);
      throw badRequest(`Không thể kết nối đến Gemini API: ${netErr.message}`);
    }

    if (!response.ok) {
      const errJson = await response.json().catch(() => null);
      const errMsg = errJson?.error?.message || `Gemini API trả về mã lỗi HTTP ${response.status}`;
      log.warn(`Gemini API loi: ${errMsg}`);
      throw badRequest(errMsg);
    }

    const data = await response.json();
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw badRequest('Không nhận được nội dung từ Gemini');
    }

    let parsedResult;
    try {
      parsedResult = JSON.parse(rawText);
    } catch {
      const cleaned = rawText.replace(/```(?:json)?\n?|\n?```/g, '').trim();
      try {
        parsedResult = JSON.parse(cleaned);
      } catch (parseErr) {
        log.warn(`Khong parse duoc JSON tu Gemini: ${rawText}`);
        parsedResult = {
          title: '',
          caption: rawText,
          hashtags: '',
          variations: [],
        };
      }
    }

    res.json({
      ok: true,
      result: {
        title: parsedResult.title || '',
        caption: parsedResult.caption || '',
        hashtags: parsedResult.hashtags || '',
        variations: Array.isArray(parsedResult.variations) ? parsedResult.variations : [],
      },
    });
  }),
);

export default router;
