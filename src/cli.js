#!/usr/bin/env node
/**
 * CLI tien ich: npm run cli -- <lenh>
 *   doctor     Kiem tra moi truong (node, sqlite, playwright, browser, cong)
 *   platforms  Liet ke nen tang va flow ho tro
 *   stats      Thong ke nhanh tu DB
 *   reset      Xoa toan bo du lieu (can --yes)
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import config, { ensureDirs } from './config.js';
import { all, get } from './db.js';
import { listPlatforms, allPlatforms } from './platforms/index.js';
import { detectBrowsers } from './core/browser.js';

const [, , command = 'help', ...rest] = process.argv;
const args = new Set(rest);

const OK = '\x1b[32m OK \x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const WARN = '\x1b[33mWARN\x1b[0m';

const line = (mark, label, detail = '') =>
  console.log(`[${mark}] ${label.padEnd(34)} ${detail}`);

async function doctor() {
  ensureDirs();
  console.log('\n=== AutoTool doctor ===\n');

  const major = Number(process.versions.node.split('.')[0]);
  line(major >= 22 ? OK : FAIL, 'Node.js >= 22', `v${process.versions.node}`);

  try {
    await import('node:sqlite');
    line(OK, 'node:sqlite', 'kha dung');
  } catch (err) {
    line(FAIL, 'node:sqlite', err.message);
  }

  try {
    get('SELECT 1 AS ok');
    line(OK, 'Database', config.paths.db);
  } catch (err) {
    line(FAIL, 'Database', err.message);
  }

  let playwrightOk = false;
  try {
    const pw = await import('playwright');
    playwrightOk = !!pw.chromium;
    line(OK, 'Playwright', 'da cai');
  } catch {
    line(FAIL, 'Playwright', 'chua cai - chay: npm install');
  }

  const browsers = detectBrowsers();
  if (browsers.length) {
    line(OK, 'Browser he thong', browsers.map((b) => b.channel).join(', '));
  } else {
    line(WARN, 'Browser he thong', 'khong thay Chrome/Edge - se phai tai Chromium');
  }

  if (playwrightOk) {
    try {
      const { chromium } = await import('playwright');
      const ok = fs.existsSync(chromium.executablePath());
      line(ok ? OK : WARN, 'Chromium cua Playwright', ok ? 'da tai' : 'chua tai (khong bat buoc neu dung msedge/chrome)');
    } catch {
      line(WARN, 'Chromium cua Playwright', 'khong xac dinh duoc');
    }
  }

  await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', (err) => {
      line(err.code === 'EADDRINUSE' ? WARN : FAIL, `Cong ${config.port}`, err.code);
      resolve();
    });
    srv.once('listening', () => {
      line(OK, `Cong ${config.port}`, 'dang trong');
      srv.close(() => resolve());
    });
    srv.listen(config.port, config.host);
  });

  for (const dir of ['dataDir', 'media', 'profiles', 'screenshots']) {
    const p = config.paths[dir];
    line(fs.existsSync(p) ? OK : FAIL, `Thu muc ${dir}`, p);
  }

  console.log('\nCau hinh:');
  console.log(`  BROWSER_CHANNEL = ${config.browser.channel}`);
  console.log(`  HEADLESS        = ${config.browser.headless}`);
  console.log(`  Concurrency     = ${config.worker.concurrency}`);
  console.log(`  Delay mac dinh  = ${config.worker.defaultMinDelaySec}-${config.worker.defaultMaxDelaySec}s`);
  console.log(`  Gioi han/ngay   = ${config.worker.defaultDailyLimit} bai/account`);
  console.log('');
}

function platforms() {
  console.log('\n=== Nen tang ho tro ===\n');
  for (const p of allPlatforms()) {
    const flags = [p.verified ? 'da kiem chung' : 'chua kiem chung', p.experimental ? 'THU NGHIEM' : null]
      .filter(Boolean)
      .join(', ');
    console.log(`${p.name} (${p.id})  [${flags}]`);
    console.log(`  Dang nhap : ${p.loginUrl}`);
    console.log(`  Ho tro    : ${(p.caps?.kinds ?? []).join(', ') || 'profile'}`);
    console.log(`  Gioi han  : ${JSON.stringify(p.limits)}`);
    console.log(`  Flow      : ${Object.keys(p.flows).join(', ')}`);
    if (p.notes) console.log(`  Ghi chu   : ${p.notes}`);
    console.log('');
  }
}

function stats() {
  const counts = get(`
    SELECT
      (SELECT COUNT(*) FROM accounts) AS accounts,
      (SELECT COUNT(*) FROM targets)  AS targets,
      (SELECT COUNT(*) FROM posts)    AS posts,
      (SELECT COUNT(*) FROM jobs)     AS jobs
  `);
  const items = get(`
    SELECT
      COALESCE(SUM(status='pending'),0) AS pending,
      COALESCE(SUM(status='success'),0) AS success,
      COALESCE(SUM(status='failed'),0)  AS failed
    FROM job_items
  `);
  console.log('\n=== Thong ke ===\n');
  console.log({ ...counts, ...items });
  const recent = all(
    `SELECT i.id, i.status, i.error, t.name AS target, a.label AS account
       FROM job_items i JOIN targets t ON t.id=i.target_id JOIN accounts a ON a.id=i.account_id
      WHERE i.status IN ('success','failed') ORDER BY i.id DESC LIMIT 10`,
  );
  if (recent.length) {
    console.log('\n10 luot dang gan nhat:');
    for (const r of recent) {
      console.log(`  #${r.id} [${r.status}] ${r.account} -> ${r.target}${r.error ? ` :: ${r.error.slice(0, 80)}` : ''}`);
    }
  }
  console.log('');
}

function reset() {
  if (!args.has('--yes')) {
    console.error('Lenh nay se XOA TOAN BO du lieu (accounts, nhom, bai viet, chien dich, media).');
    console.error('Them --yes de xac nhan:  npm run cli -- reset --yes');
    process.exit(1);
  }
  for (const p of [config.paths.db, `${config.paths.db}-wal`, `${config.paths.db}-shm`]) {
    if (fs.existsSync(p)) fs.rmSync(p, { force: true });
  }
  for (const dir of [config.paths.media, config.paths.profiles, config.paths.screenshots]) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('Da xoa toan bo du lieu.');
}

function help() {
  console.log(`
AutoTool CLI

  npm run cli -- doctor       Kiem tra moi truong
  npm run cli -- platforms    Liet ke nen tang ho tro
  npm run cli -- stats        Thong ke tu database
  npm run cli -- reset --yes  Xoa toan bo du lieu
`);
}

const commands = { doctor, platforms, stats, reset, help };
const fn = commands[command] ?? help;
Promise.resolve(fn()).catch((err) => {
  console.error(err);
  process.exit(1);
});
