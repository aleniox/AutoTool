#!/usr/bin/env node
/**
 * E2E cho engine dang bai (src/core/flow.js) tren mot trang "nhom" gia lap chay cuc bo.
 * KHONG cham vao bat ky nen tang that nao.
 *
 *   node scripts/flow-e2e.mjs
 *
 * Kiem tra:
 *   - fill() vao contenteditable (co dau tieng Viet, nhieu dong)
 *   - upload anh qua input[type=file]
 *   - thu lan luot nhieu selector du phong
 *   - CHE DO THU: dien + dinh anh nhung KHONG bam nut Dang  <-- tinh nang an toan quan trong nhat
 *   - che do that: bam Dang va server nhan dung noi dung
 *   - phat hien blocker (thong bao bi chan)
 *   - buoc `when` / `ifFound` re nhieu
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import config, { ensureDirs } from '../src/config.js';
import { launchOptions } from '../src/core/browser.js';
import { runFlow, buildContext, detectBlocker, resolveStartUrl } from '../src/core/flow.js';

ensureDirs();

let pass = 0;
let fail = 0;
const ok = (m, d = '') => { pass += 1; console.log(`  \x1b[32m✓\x1b[0m ${m}${d ? ` \x1b[90m${d}\x1b[0m` : ''}`); };
const bad = (m, e) => { fail += 1; console.log(`  \x1b[31m✗\x1b[0m ${m}\n      \x1b[31m${e}\x1b[0m`); };

/* -------------------------------------------------------------------------- */
/* Trang "nhom" gia lap                                                       */
/* -------------------------------------------------------------------------- */

const submissions = [];

const PAGE = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>Nhom gia lap</title>
<style>body{font:14px sans-serif;padding:20px}[hidden]{display:none}
[role=dialog]{border:1px solid #999;padding:12px;margin-top:10px}
#editor{min-height:60px;border:1px solid #ccc;padding:8px}</style></head>
<body>
  <h1>Nhóm giả lập</h1>
  <button role="button" aria-label="Viết gì đó" id="trigger">Bạn viết gì đi...</button>

  <div id="dlg" role="dialog" hidden>
    <div id="editor" contenteditable="true" role="textbox" aria-label="Nội dung"></div>
    <input type="file" accept="image/*" multiple />
    <div role="button" aria-label="Đăng" id="postBtn" tabindex="0">Đăng</div>
  </div>

  <div id="done" hidden>Đã đăng thành công</div>

  <script>
    const trigger = document.getElementById('trigger');
    const dlg = document.getElementById('dlg');
    const done = document.getElementById('done');
    trigger.addEventListener('click', () => { dlg.hidden = false; document.getElementById('editor').focus(); });
    document.getElementById('postBtn').addEventListener('click', async () => {
      const files = [...document.querySelector('input[type=file]').files].map(f => f.name);
      const text = document.getElementById('editor').innerText;
      await fetch('/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, files }),
      });
      dlg.hidden = true;
      done.hidden = false;
    });
  </script>
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/submit') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      try {
        submissions.push(JSON.parse(body));
      } catch {
        submissions.push({ parseError: body });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`\n=== E2E engine dang bai @ ${base} ===\n`);

/* -------------------------------------------------------------------------- */

const profileDir = path.join(config.paths.profiles, '_flow-e2e');
const tmpDir = path.join(config.dataDir, '_flow-e2e-tmp');
fs.mkdirSync(tmpDir, { recursive: true });

const imgA = path.join(tmpDir, 'anh-mot.png');
const imgB = path.join(tmpDir, 'anh-hai.png');
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
fs.writeFileSync(imgA, PNG);
fs.writeFileSync(imgB, PNG);

const CAPTION = 'Khuyến mãi tháng 12 — giảm 50%\nLiên hệ: 0900 000 000\n#khuyenmai';

const flow = {
  startUrl: () => base,
  steps: [
    { goto: '{{startUrl}}' },
    // Phuong an 1,2 khong ton tai -> phai roi ve phuong an 3
    {
      click: [
        '#nut-khong-ton-tai',
        'button.khong-co-that',
        { role: 'button', name: /viết gì|write something/i },
      ],
    },
    { waitFor: 'div[role="dialog"]' },
    { fill: 'div[role="dialog"] div[contenteditable="true"]', value: '{{text}}' },
    { upload: 'div[role="dialog"] input[type="file"]', files: '{{imagePaths}}', optional: true },
    // Re nhanh: phai chay vao then
    {
      when: (ctx) => ctx.imagePaths.length > 0,
      then: [{ eval: (ctx) => { ctx.branchRan = 'then'; return true; }, saveAs: '_ignored' }],
      else: [{ eval: (ctx) => { ctx.branchRan = 'else'; return true; }, saveAs: '_ignored' }],
    },
    { click: 'div[role="dialog"] [aria-label="Đăng"]', submit: true },
    { waitForGone: 'div[role="dialog"]', timeout: 5000, optional: true },
  ],
};

const context = await chromium.launchPersistentContext(profileDir, launchOptions({ headless: true }));

function makeCtx() {
  const ctx = buildContext({
    account: { id: 1, label: 'test', platform: 'facebook' },
    target: { id: 1, name: 'Nhóm giả lập', kind: 'group', externalId: 'fake', url: base },
    post: { id: 1, title: '', caption: CAPTION, link: '', hashtags: '' },
    media: [
      { name: 'anh-mot.png', path: imgA, type: 'image' },
      { name: 'anh-hai.png', path: imgB, type: 'image' },
    ],
  });
  // Giong nhu runner.js lam truoc khi chay flow
  resolveStartUrl(flow, ctx.target, ctx, base);
  return ctx;
}

/* ------------------------- 0. Template resolution ------------------------ */

try {
  const ctx = makeCtx();
  const { resolveValue } = await import('../src/core/flow.js');

  const arr = resolveValue('{{imagePaths}}', ctx);
  if (!Array.isArray(arr)) throw new Error(`'{{imagePaths}}' tra ve ${typeof arr} (mong doi mang)`);
  if (arr.length !== 2) throw new Error(`mang co ${arr.length} phan tu (mong doi 2)`);
  ok('Placeholder dung mot minh giu nguyen kieu mang', `["${path.basename(arr[0])}", …]`);

  const mixed = resolveValue('Anh: {{imagePaths}}', ctx);
  if (typeof mixed !== 'string' || !mixed.startsWith('Anh: ')) throw new Error(`sai: ${mixed}`);
  ok('Placeholder trong chuoi hon hop duoc noi thanh chuoi');

  const missing = resolveValue('x{{khong.ton.tai}}y', ctx);
  if (missing !== 'xy') throw new Error(`sai: ${missing}`);
  ok('Placeholder khong ton tai -> chuoi rong (khong crash)');

  const fn = resolveValue((c) => c.imagePaths.length, ctx);
  if (fn !== 2) throw new Error(`ham tra ve ${fn}`);
  ok('Gia tri dang ham duoc goi voi ctx');
} catch (err) {
  bad('Phan giai template', err.message);
}

/* ------------------------- 1. CHE DO THU (dry-run) ------------------------ */

try {
  submissions.length = 0;
  const page = await context.newPage();
  const ctx = makeCtx();
  const steps = [];
  const result = await runFlow(page, flow.steps, ctx, {
    dryRun: true,
    onStep: (s) => steps.push(`${s.action}${s.detail ? `:${s.detail}` : ''}`),
    timeout: 15000,
  });

  if (result.skippedSubmit !== 1) throw new Error(`bo qua ${result.skippedSubmit} buoc submit (mong doi 1)`);
  ok('Che do thu: bo qua dung 1 buoc danh dau submit');

  if (submissions.length !== 0) throw new Error(`server da nhan ${submissions.length} bai dang!`);
  ok('Che do thu: KHONG gui bai nao len server', '0 submission');

  const dialogOpen = await page.locator('#dlg').isVisible();
  if (!dialogOpen) throw new Error('dialog da dong -> co ve da bam Dang');
  ok('Che do thu: dialog soan bai van mo');

  const text = await page.locator('#editor').innerText();
  if (!text.includes('Khuyến mãi tháng 12')) throw new Error(`noi dung sai: ${JSON.stringify(text)}`);
  if (!text.includes('0900 000 000')) throw new Error('mat dong thu 2');
  ok('Che do thu: noi dung tieng Viet nhieu dong duoc dien dung', JSON.stringify(text.slice(0, 32)) + '…');

  const fileCount = await page.locator('input[type="file"]').evaluate((el) => el.files.length);
  if (fileCount !== 2) throw new Error(`dinh kem ${fileCount} file (mong doi 2)`);
  const names = await page.locator('input[type="file"]').evaluate((el) => [...el.files].map((f) => f.name));
  if (!names.includes('anh-mot.png')) throw new Error(`ten file sai: ${names}`);
  ok('Che do thu: dinh kem dung 2 anh', names.join(', '));

  if (ctx.branchRan !== 'then') throw new Error(`re nhanh sai: ${ctx.branchRan}`);
  ok('Buoc `when` re nhanh dung (co anh -> then)');

  if (!steps.some((s) => s.startsWith('click:#nut-khong-ton-tai'))) throw new Error('thieu vet buoc click');
  ok('Ghi vet tung buoc (trace) de go loi', `${steps.length} buoc`);

  await page.close();
} catch (err) {
  bad('Che do thu (dry-run)', err.message);
}

/* --------------------------- 2. CHE DO THAT ------------------------------ */

try {
  submissions.length = 0;
  const page = await context.newPage();
  const ctx = makeCtx();
  await runFlow(page, flow.steps, ctx, { dryRun: false, onStep: () => {}, timeout: 15000 });

  if (submissions.length !== 1) throw new Error(`server nhan ${submissions.length} bai (mong doi 1)`);
  const s = submissions[0];
  if (!s.text.includes('Khuyến mãi tháng 12')) throw new Error(`noi dung gui sai: ${JSON.stringify(s.text)}`);
  if (!s.text.includes('0900 000 000')) throw new Error('thieu dong 2');
  ok('Che do that: server nhan dung 1 bai', `"${s.text.split('\n')[0]}"`);

  if (s.files.length !== 2) throw new Error(`nhan ${s.files.length} file (mong doi 2)`);
  ok('Che do that: server nhan dung 2 anh', s.files.join(', '));

  const gone = !(await page.locator('#dlg').isVisible());
  if (!gone) throw new Error('dialog khong dong sau khi dang');
  ok('Che do that: dialog dong sau khi dang (waitForGone hoat dong)');

  await page.close();
} catch (err) {
  bad('Che do that', err.message);
}

/* --------------------------- 3. Blocker ---------------------------------- */

try {
  const page = await context.newPage();
  await page.setContent(`
    <div>You're temporarily blocked</div>
    <div>We limit how often you can post right now.</div>
  `);
  const blocker = await detectBlocker(page, [
    { when: [{ text: /temporarily blocked/i }], message: 'Bi chan tam thoi', kind: 'rate_limit' },
  ]);
  if (!blocker) throw new Error('khong phat hien duoc blocker');
  ok('Phat hien thong bao bi chan', `"${blocker}"`);

  await page.setContent('<div>Mọi thứ bình thường</div>');
  const none = await detectBlocker(page, [
    { when: [{ text: /temporarily blocked/i }], message: 'x', kind: 'rate_limit' },
  ]);
  if (none !== null) throw new Error(`bao dong gia: ${none}`);
  ok('Khong bao dong gia khi trang binh thuong');

  await page.close();
} catch (err) {
  bad('Phat hien blocker', err.message);
}

/* --------------------------- 4. Loi co chu dich --------------------------- */

try {
  const page = await context.newPage();
  const ctx = makeCtx();
  let threw = false;
  try {
    await runFlow(page, [{ goto: '{{startUrl}}' }, { click: '#khong-bao-gio-ton-tai' }], ctx, {
      timeout: 1500,
    });
  } catch (err) {
    threw = true;
    if (!/Khong tim thay phan tu/.test(err.message)) throw new Error(`thong bao loi la: ${err.message}`);
  }
  if (!threw) throw new Error('le ra phai nem loi');
  ok('Nem loi ro rang khi khong tim thay phan tu (khong treo)', 'sau 1.5s');

  const optionalOk = await runFlow(
    page,
    [{ goto: '{{startUrl}}' }, { click: '#khong-bao-gio-ton-tai', optional: true }],
    ctx,
    { timeout: 800 },
  );
  ok('Buoc optional=true bo qua loi em', JSON.stringify(optionalOk));
  await page.close();
} catch (err) {
  bad('Xu ly loi', err.message);
}

/* ----------------------------- Don dep ----------------------------------- */

await context.close();
server.close();
fs.rmSync(profileDir, { recursive: true, force: true });
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log(`\n=== Ket qua: ${pass} pass, ${fail} fail ===\n`);
process.exit(fail ? 1 : 0);
