#!/usr/bin/env node
/**
 * Kiem tra dashboard that trong trinh duyet: bat loi console, xac nhan tung trang render.
 *
 *   node scripts/dashboard-check.mjs [baseUrl]
 *
 * Tu tao du lieu mau qua API, duyet het cac trang, chup anh vao data/screenshots/ui-*,
 * roi don dep du lieu mau.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import config, { ensureDirs } from '../src/config.js';
import { launchOptions } from '../src/core/browser.js';

ensureDirs();

const BASE = process.argv[2] || `http://${config.host}:${config.port}`;
const TAG = `uidemo-${Date.now()}`;

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const bad = (m, e) => { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${m}\n      \x1b[31m${e}\x1b[0m`); };

async function call(method, url, body, raw) {
  const init = { method, headers: {} };
  if (raw) init.body = raw;
  else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${url}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

console.log(`\n=== Kiem tra dashboard @ ${BASE} ===\n`);

/* ----------------------------- Du lieu mau ------------------------------- */

const seed = { account: null, posts: [], job: null, media: null };
try {
  const a = await call('POST', '/api/accounts', {
    platform: 'facebook', label: TAG, dailyLimit: 12, minDelaySec: 90, maxDelaySec: 240,
  });
  seed.account = a.account.id;
  await call('POST', '/api/accounts', { platform: 'telegram', label: `${TAG}-tg` });
  await call('POST', '/api/targets/import', {
    accountId: seed.account,
    text: [
      'https://www.facebook.com/groups/100000001 | Nhóm Mua Bán Đồ Cũ',
      'https://www.facebook.com/groups/100000002 | Nhóm Rao Vặt Tổng Hợp',
      'https://www.facebook.com/groups/100000003 | Nhóm Chợ Online 24h',
    ].join('\n'),
  });

  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  const m = await call('POST', `/api/media?name=${TAG}.png`, undefined, PNG);
  seed.media = m.file.name;

  for (const i of [1, 2]) {
    const p = await call('POST', '/api/posts', {
      title: `Bài viết mẫu số ${i}`,
      caption: `Nội dung minh hoạ cho bài số ${i}.\nDòng thứ hai của nội dung.`,
      hashtags: '#muaban #khuyenmai',
      link: 'https://example.com',
      media: [seed.media],
    });
    seed.posts.push(p.post.id);
  }

  const j = await call('POST', '/api/jobs', {
    name: `Chiến dịch minh hoạ ${TAG}`,
    postIds: seed.posts,
    targetIds: (await call('GET', `/api/targets?accountId=${seed.account}`)).targets.map((t) => t.id),
    strategy: 'cross',
    scheduledAt: new Date(Date.now() + 3600_000).toISOString(),
    dryRun: true,
  });
  seed.job = j.job.id;
  ok('Tạo dữ liệu mẫu qua API', `2 tài khoản, 3 nhóm, 2 bài, ${j.preview.items} lượt đăng`);
} catch (err) {
  bad('Tạo dữ liệu mẫu', err.message);
}

/* ------------------------------ Trinh duyet ------------------------------ */

const profileDir = path.join(config.paths.profiles, '_ui-check');
const context = await chromium.launchPersistentContext(profileDir, launchOptions({ headless: true }));
const page = await context.newPage();

const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`PAGEERROR: ${err.message}`));

const routes = [
  ['dashboard', 'Tổng quan', 'Tài khoản'],
  ['accounts', 'Tài khoản', 'Thêm tài khoản'],
  ['targets', 'Nhóm & Trang', 'Nhóm Mua Bán Đồ Cũ'],
  ['posts', 'Bài viết', 'Bài viết mẫu số 1'],
  ['jobs', 'Chiến dịch', TAG],
  ['reports', 'Báo cáo', 'Tổng lượt đăng'],
  ['logs', 'Nhật ký', 'Mức độ'],
  ['help', 'Hướng dẫn', 'Bắt đầu trong 4 bước'],
];

fs.mkdirSync(config.paths.screenshots, { recursive: true });

for (const [route, title, mustContain] of routes) {
  try {
    await page.goto(`${BASE}/#/${route}`, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1200);

    const heading = (await page.locator('#viewTitle').textContent())?.trim();
    if (heading !== title) throw new Error(`tieu de la "${heading}" (mong doi "${title}")`);

    // innerText tra ve chu HOA khi CSS co text-transform -> so sanh khong phan biet hoa/thuong
    const body = await page.locator('#view').innerText();
    const whole = await page.locator('body').innerText();

    if (body.includes('Không tải được trang')) {
      throw new Error(`trang bao loi: ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (!whole.toLowerCase().includes(mustContain.toLowerCase())) {
      throw new Error(
        `khong thay "${mustContain}". Noi dung #view (${body.length} ky tu): ` +
          `${body.replace(/\s+/g, ' ').slice(0, 220)}`,
      );
    }

    const shot = path.join(config.paths.screenshots, `ui-${route}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    ok(`Trang ${route}`, `"${title}" · ${body.length} ký tự · ${path.basename(shot)}`);
  } catch (err) {
    bad(`Trang ${route}`, err.message);
  }
}

/* --------------------------- Modal tao chien dich ------------------------- */

try {
  await page.goto(`${BASE}/#/jobs`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.click('#addJob');
  await page.waitForTimeout(1200);

  const modalVisible = await page.locator('.modal').isVisible();
  if (!modalVisible) throw new Error('modal khong mo');

  const firstPost = page.locator('.post-check').first();
  await firstPost.check();
  await page.locator('.target-check').first().check();
  await page.waitForTimeout(500);
  const postCount = (await page.locator('#postCount').textContent())?.trim();
  if (postCount !== '1') throw new Error(`#postCount = "${postCount}" (mong doi 1)`);
  const targetCount = (await page.locator('#targetCount').textContent())?.trim();
  if (targetCount !== '1') throw new Error(`#targetCount = "${targetCount}" (mong doi 1)`);

  const previewText = await page.locator('#j-preview').innerText();
  if (!previewText.includes('lượt đăng')) throw new Error(`xem truoc sai: ${previewText}`);
  if (!/Sẽ tạo\s+1\s+lượt đăng/.test(previewText)) throw new Error(`so luot sai: ${previewText}`);

  await page.screenshot({ path: path.join(config.paths.screenshots, 'ui-modal-chiendich.png') });
  ok('Modal tạo chiến dịch', `chọn 1 bài → xem trước: "${previewText.split('\n')[0].trim()}"`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  if (await page.locator('.modal').count()) throw new Error('modal khong dong khi bam Escape');
  ok('Đóng modal bằng phím Escape');
} catch (err) {
  bad('Modal tạo chiến dịch', err.message);
}

/* ------------------------------- Console -------------------------------- */

const realErrors = consoleErrors.filter((e) => !/favicon|ERR_INTERNET|net::ERR/i.test(e));
if (realErrors.length) {
  bad('Khong co loi console', `${realErrors.length} loi:\n      ${realErrors.slice(0, 5).join('\n      ')}`);
} else {
  ok('Khong co loi console', `${consoleErrors.length} thong bao (da loc favicon/mang)`);
}

await context.close();
fs.rmSync(profileDir, { recursive: true, force: true });

/* -------------------------------- Don dep -------------------------------- */

try {
  if (seed.job) await call('DELETE', `/api/jobs/${seed.job}`);
  for (const p of seed.posts) await call('DELETE', `/api/posts/${p}`);
  if (seed.media) await call('DELETE', `/api/media/${encodeURIComponent(seed.media)}`);
  const { accounts } = await call('GET', '/api/accounts');
  for (const a of accounts.filter((x) => x.label.startsWith(TAG))) {
    await call('DELETE', `/api/accounts/${a.id}`);
  }
  ok('Dọn dẹp dữ liệu mẫu');
} catch (err) {
  bad('Dọn dẹp dữ liệu mẫu', err.message);
}

console.log(`\n=== Ket qua: ${pass} pass, ${fail} fail ===\n`);
process.exit(fail ? 1 : 0);
