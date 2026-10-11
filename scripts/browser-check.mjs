#!/usr/bin/env node
/**
 * Kiem tra tang trinh duyet (Playwright + Edge/Chrome) ma KHONG dung tai khoan that.
 *
 *   node scripts/browser-check.mjs [--headed]
 *
 * Kiem tra:
 *   1. Mo duoc persistent context voi cau hinh trong .env
 *   2. Dieu huong + chup anh 1 trang tinh
 *   3. Engine locator (findVisible) hoat dong dung
 *   4. (neu co mang) Doi chieu selector phien dang nhap voi trang login that
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import config, { ensureDirs } from '../src/config.js';
import { launchOptions } from '../src/core/browser.js';
import { findVisible } from '../src/core/locator.js';
import { getPlatform } from '../src/platforms/index.js';

ensureDirs();

const headed = process.argv.includes('--headed');
const profileDir = path.join(config.paths.profiles, '_browser-check');
const shotDir = config.paths.screenshots;

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const bad = (m, e) => { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${m}\n      \x1b[31m${e}\x1b[0m`); };
const warn = (m, e) => console.log(`  \x1b[33m!\x1b[0m ${m}${e ? ` \x1b[90m${e}\x1b[0m` : ''}`);

console.log(`\n=== Kiem tra trinh duyet (${config.browser.channel}, headless=${!headed}) ===\n`);

let context;
try {
  context = await chromium.launchPersistentContext(profileDir, launchOptions({ headless: !headed }));
  const version = context.browser()?.version?.() ?? '?';
  ok('Mo persistent context', `channel=${config.browser.channel}, chromium ${version}`);
} catch (err) {
  bad('Mo persistent context', err.message);
  console.log('\nGoi y: doi BROWSER_CHANNEL trong .env sang `msedge` hoac `chrome`,');
  console.log('hoac chay: npx playwright install chromium\n');
  process.exit(1);
}

const page = await context.newPage();
page.setDefaultTimeout(20000);

try {
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  const title = await page.title();
  if (!title) throw new Error('tieu de trang rong');
  ok('Dieu huong toi example.com', `title="${title}"`);
} catch (err) {
  bad('Dieu huong toi example.com', err.message);
}

try {
  await page.setContent(`
    <button role="button" aria-label="Đăng">Đăng</button>
    <div role="dialog"><div contenteditable="true" role="textbox">san sang</div></div>
    <input type="file" accept="image/*" hidden />
  `);

  const byRole = await findVisible(page, [{ role: 'button', name: /^(Post|Đăng)$/ }], { timeout: 3000 });
  if (!byRole) throw new Error('khong tim thay theo role+name');
  ok('Locator theo role + ten (regex)', 'tim thay nut "Đăng"');

  const byCss = await findVisible(page, ['div[role="dialog"] div[contenteditable="true"]'], { timeout: 3000 });
  if (!byCss) throw new Error('khong tim thay contenteditable trong dialog');
  ok('Locator CSS long nhau', 'dialog > contenteditable');

  const fallback = await findVisible(
    page,
    ['button.khong-ton-tai', 'input.khong-co', { role: 'button', name: 'Đăng' }],
    { timeout: 5000 },
  );
  if (!fallback) throw new Error('khong roi ve duoc phuong an cuoi');
  ok('Thu lan luot nhieu selector du phong', 'phuong an 1,2 that bai -> phuong an 3 thanh cong');

  const none = await findVisible(page, ['button.hoan-toan-khong-co'], { timeout: 1200 });
  if (none !== null) throw new Error('le ra phai tra ve null');
  ok('Tra ve null dung khi khong co phan tu', 'sau 1.2s');

  const fileInputs = await page.locator('input[type="file"]').count();
  ok('Dem duoc input file (dung cho upload anh)', `${fileInputs} input`);
} catch (err) {
  bad('Kiem tra engine locator', err.message);
}

try {
  fs.mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `browser-check-${Date.now()}.png`);
  await page.screenshot({ path: shot });
  const size = fs.statSync(shot).size;
  ok('Chup anh man hinh', `${path.basename(shot)} (${(size / 1024).toFixed(1)} KB)`);
} catch (err) {
  bad('Chup anh man hinh', err.message);
}

/* ---- Doi chieu selector voi trang that (khong bat buoc) ---- */
try {
  const fb = getPlatform('facebook');
  await page.goto(fb.session.probeUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2500);

  const loginForm = await findVisible(page, fb.session.loggedOut, { timeout: 6000 });
  if (loginForm) {
    ok('Doi chieu selector phien dang nhap Facebook', 'thay form dang nhap -> profile chua dang nhap (dung nhu mong doi)');
  } else {
    const loggedIn = await findVisible(page, fb.session.loggedIn, { timeout: 4000 });
    warn(
      'Doi chieu selector phien dang nhap Facebook',
      loggedIn ? 'co dau hieu da dang nhap' : 'khong khop selector nao - can cap nhat lai selector',
    );
  }
} catch (err) {
  warn('Doi chieu selector voi trang that', `bo qua (${err.message.split('\n')[0]})`);
}

await context.close();

try {
  fs.rmSync(profileDir, { recursive: true, force: true });
  ok('Don dep profile tam', path.basename(profileDir));
} catch {
  warn('Khong xoa duoc profile tam', profileDir);
}

console.log(`\n=== Ket qua: ${pass} pass, ${fail} fail ===\n`);
process.exit(fail ? 1 : 0);
