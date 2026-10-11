#!/usr/bin/env node
/**
 * Smoke test API: chay qua toan bo vong doi du lieu ma KHONG mo trinh duyet.
 *
 *   node scripts/smoke-test.mjs [baseUrl]
 *
 * Kiem tra: health -> platforms -> tao account -> import nhom -> upload media
 *           -> tao bai viet -> tao chien dich (hen tuong lai) -> doc items -> don dep.
 */
import fs from 'node:fs';
import path from 'node:path';
import config from '../src/config.js';

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const TAG = `smoke-${Date.now()}`;

let passed = 0;
let failed = 0;
const created = { account: null, post: null, job: null, media: null };

function ok(name, detail = '') {
  passed += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}${detail ? ` \x1b[90m${detail}\x1b[0m` : ''}`);
}
function bad(name, err) {
  failed += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}\n      \x1b[31m${err}\x1b[0m`);
}

async function call(method, path, body, raw) {
  const init = { method, headers: {} };
  if (raw) {
    init.body = raw;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, init);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${data?.error ?? text}`);
  return data;
}

async function step(name, fn) {
  try {
    const detail = await fn();
    ok(name, detail);
  } catch (err) {
    bad(name, err.message);
  }
}

/** PNG 1x1 trong suot */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

console.log(`\n=== AutoTool smoke test @ ${BASE} ===\n`);

await step('GET /api/health', async () => {
  const h = await call('GET', '/api/health');
  if (!h.ok) throw new Error('health tra ve ok=false');
  return `node ${h.node}, browser ${h.browser.channel}, worker ${h.worker.concurrency} slot`;
});

let platforms;
await step('GET /api/platforms', async () => {
  const r = await call('GET', '/api/platforms');
  platforms = r.platforms;
  if (platforms.length < 5) throw new Error(`chi co ${platforms.length} nen tang`);
  return `${platforms.length} nen tang: ${platforms.map((p) => p.id).join(', ')}`;
});

await step('POST /api/platforms/resolve (phan tich URL)', async () => {
  const r = await call('POST', '/api/platforms/resolve', {
    urls: [
      'https://www.facebook.com/groups/123456789',
      'https://www.linkedin.com/groups/98765/',
      'https://www.reddit.com/r/banhang',
      'https://t.me/kenh_test',
      'https://example.com/khong-nhan-dien-duoc',
    ],
  });
  const recognised = r.results.filter((x) => x.parsed);
  if (recognised.length !== 4) throw new Error(`nhan dien ${recognised.length}/4 (mong doi 4)`);
  return recognised.map((x) => `${x.parsed.platform}:${x.parsed.kind}`).join(', ');
});

await step('POST /api/accounts (tao tai khoan)', async () => {
  const r = await call('POST', '/api/accounts', {
    platform: 'facebook',
    label: TAG,
    dailyLimit: 3,
    minDelaySec: 10,
    maxDelaySec: 20,
  });
  created.account = r.account.id;
  return `account #${r.account.id} "${r.account.label}"`;
});

await step('POST /api/accounts/:id/login (mo cua so dang nhap)', async () => {
  const res = await fetch(`${BASE}/api/accounts/${created.account}/login`, { method: 'POST' });
  if (res.status !== 202) throw new Error(`mong doi 202, nhan ${res.status}`);

  // Cho trang thai lang xuong (cua so dang nhap mo xong) truoc khi di tiep.
  const deadline = Date.now() + 30000;
  let status = 'pending_login';
  while (Date.now() < deadline) {
    const { accounts } = await call('GET', '/api/accounts');
    status = accounts.find((a) => a.id === created.account)?.status ?? '?';
    if (status !== 'pending_login') break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (status === 'pending_login') throw new Error('cua so dang nhap khong bao ket qua sau 30s');
  if (status === 'error') throw new Error('khong mo duoc trinh duyet (kiem tra BROWSER_CHANNEL)');
  return `202 Accepted, trang thai -> "${status}"`;
});

await step('POST /api/targets/import (import nhom)', async () => {
  const r = await call('POST', '/api/targets/import', {
    accountId: created.account,
    text: [
      'https://www.facebook.com/groups/111111111',
      'https://www.facebook.com/groups/222222222 | Nhóm thử nghiệm 2',
      '# dong nay bi bo qua',
      'https://example.com/khong-hop-le',
    ].join('\n'),
  });
  if (r.imported.length !== 2) throw new Error(`import ${r.imported.length} (mong doi 2)`);
  if (r.skipped.length !== 1) throw new Error(`bo qua ${r.skipped.length} (mong doi 1)`);
  return `${r.imported.length} nhom, ${r.skipped.length} dong bi bo qua`;
});

await step('POST /api/media (upload anh)', async () => {
  const r = await call('POST', `/api/media?name=${TAG}.png`, undefined, PNG);
  created.media = r.file.name;
  if (r.file.type !== 'image') throw new Error(`loai file sai: ${r.file.type}`);
  return `${r.file.name} (${r.file.size} byte)`;
});

await step('POST /api/posts (tao bai viet + dinh anh)', async () => {
  const r = await call('POST', '/api/posts', {
    title: `Bài thử nghiệm ${TAG}`,
    caption: 'Nội dung kiểm tra tự động.\nDòng thứ hai.',
    hashtags: '#smoketest',
    link: 'https://example.com',
    media: [created.media],
  });
  created.post = r.post.id;
  if (r.post.media.length !== 1) throw new Error('media khong duoc dinh kem');
  return `post #${r.post.id} voi ${r.post.media.length} media`;
});

await step('POST /api/jobs/preview (du doan so luot)', async () => {
  const r = await call('POST', '/api/jobs/preview', {
    postIds: [created.post],
    targetIds: [1, 2],
    strategy: 'cross',
  });
  if (r.items !== 2) throw new Error(`du doan ${r.items} (mong doi 2)`);
  return `${r.postCount} bai x ${r.targetCount} nhom = ${r.items} luot (${r.strategy})`;
});

await step('POST /api/jobs (tao chien dich hen tuong lai)', async () => {
  const { targets } = await call('GET', `/api/targets?accountId=${created.account}`);
  const future = new Date(Date.now() + 86400000).toISOString();
  const r = await call('POST', '/api/jobs', {
    name: `Chiến dịch thử ${TAG}`,
    postIds: [created.post],
    targetIds: targets.map((t) => t.id),
    strategy: 'cross',
    scheduledAt: future,
    dryRun: true,
  });
  created.job = r.job.id;
  if (r.job.status !== 'scheduled') throw new Error(`trang thai sai: ${r.job.status}`);
  return `job #${r.job.id} voi ${r.preview.items} luot dang (dry-run, hen tuong lai)`;
});

await step('GET /api/jobs/:id/items', async () => {
  const r = await call('GET', `/api/jobs/${created.job}/items`);
  if (!r.items.length) throw new Error('khong co item nao');
  const allPending = r.items.every((i) => i.status === 'pending');
  if (!allPending) throw new Error('co item khong o trang thai pending');
  return `${r.items.length} luot dang, tat ca pending`;
});

await step('POST /api/jobs/:id/cancel', async () => {
  const r = await call('POST', `/api/jobs/${created.job}/cancel`);
  return `da huy ${r.canceled} luot dang`;
});

await step('GET /api/stats', async () => {
  const s = await call('GET', '/api/stats');
  return `${s.counts.accounts} account, ${s.counts.targets} nhom, ${s.counts.posts} bai, ${s.counts.jobs} chien dich`;
});

await step('GET /api/reports/summary', async () => {
  const r = await call('GET', '/api/reports/summary?days=7');
  if (!r.overall) throw new Error('thieu truong overall');
  return `overall.total=${r.overall.total}`;
});

await step('GET /api/platforms/facebook/flow', async () => {
  const r = await call('GET', '/api/platforms/facebook/flow');
  const steps = r.flows.group?.length ?? 0;
  if (!steps) throw new Error('flow rong');
  const submits = r.flows.group.filter((s) => s.submit).length;
  return `${steps} buoc, ${submits} buoc danh dau submit`;
});

await step('GET / (dashboard)', async () => {
  const res = await fetch(`${BASE}/`);
  const html = await res.text();
  if (!res.ok || !html.includes('AutoTool')) throw new Error(`status ${res.status}`);
  return `${html.length} byte HTML`;
});

await step('GET /js/app.js (module ES)', async () => {
  const res = await fetch(`${BASE}/js/app.js`);
  const ct = res.headers.get('content-type') ?? '';
  if (!ct.includes('javascript')) throw new Error(`content-type sai: ${ct}`);
  return `${ct}`;
});

/* ----------------------------- Don dep ---------------------------------- */

console.log('\n--- Don dep ---');
await step('Xoa chien dich / bai viet / media / tai khoan', async () => {
  const profileDir = path.join(config.paths.profiles, `${created.account}-facebook`);
  const existedBefore = fs.existsSync(profileDir);

  if (created.job) await call('DELETE', `/api/jobs/${created.job}`);
  if (created.post) await call('DELETE', `/api/posts/${created.post}`);
  if (created.media) await call('DELETE', `/api/media/${encodeURIComponent(created.media)}`);
  if (created.account) await call('DELETE', `/api/accounts/${created.account}`);

  const after = await call('GET', '/api/stats');
  if (after.counts.accounts !== 0) throw new Error(`con ${after.counts.accounts} account chua xoa`);
  if (existedBefore && fs.existsSync(profileDir)) {
    throw new Error('profile trinh duyet (chua phien dang nhap) van con tren dia');
  }
  return `da xoa sach${existedBefore ? ' (kem profile trinh duyet)' : ''}`;
});

console.log(`\n=== Ket qua: ${passed} pass, ${failed} fail ===\n`);
process.exit(failed ? 1 : 0);
