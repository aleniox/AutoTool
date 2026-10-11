import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { findVisible } from './locator.js';

const log = createLogger('browser');

let playwrightModule = null;
export async function getChromium() {
  if (!playwrightModule) {
    try {
      playwrightModule = (await import('playwright')).chromium;
    } catch (err) {
      throw new Error(
        'Chua cai Playwright. Chay: npm install  (chi can thiet mot lan).\n' + err.message,
      );
    }
  }
  return playwrightModule;
}

/* -------------------------------------------------------------------------- */
/* Khoa theo account: 1 profile chi duoc mo boi 1 context tai mot thoi diem    */
/* -------------------------------------------------------------------------- */

/** accountId -> Promise (duoi cung cua chuoi thao tac da xep hang) */
const chains = new Map();

/** accountId dang bi dong/xoa: chan moi lan mo trinh duyet moi */
const closing = new Set();

/**
 * Xep hang thao tac tren cung mot account. Tranh tinh huong xoa tai khoan
 * dung luc cua so dang nhap con dang khoi dong (khien profile bi khoa).
 */
function withLock(accountId, fn) {
  const id = Number(accountId);
  const prev = chains.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(
    id,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/* -------------------------------------------------------------------------- */
/* Context cache                                                              */
/* -------------------------------------------------------------------------- */

/** accountId -> { context, mode: 'job'|'login', lastUsed } */
const live = new Map();

export function profileDirFor(account) {
  const dir = path.join(config.paths.profiles, `${account.id}-${account.platform}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isOpen(accountId) {
  return live.has(Number(accountId));
}

export function launchOptions({ headless }) {
  const opts = {
    headless,
    viewport: config.browser.viewport,
    locale: config.browser.locale,
    timezoneId: config.browser.timezoneId,
    acceptDownloads: true,
    ignoreHTTPSErrors: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,OptimizationHints',
      '--start-maximized',
    ],
  };
  if (config.browser.channel && config.browser.channel !== 'chromium') {
    opts.channel = config.browser.channel;
  }
  return opts;
}

async function openContext(account, { headless, mode }) {
  const chromium = await getChromium();
  const userDataDir = profileDirFor(account);
  const context = await chromium.launchPersistentContext(userDataDir, launchOptions({ headless }));
  context.setDefaultTimeout(config.browser.stepTimeoutMs);
  context.setDefaultNavigationTimeout(60000);

  // Tai khoan bi xoa/dong trong luc dang khoi dong -> dong ngay, khong de lai context mo coi.
  if (closing.has(Number(account.id))) {
    await context.close().catch(() => {});
    throw new Error('Tai khoan vua bi dong hoac xoa trong luc trinh duyet dang mo.');
  }

  context.on('close', () => {
    const entry = live.get(account.id);
    if (entry && entry.context === context) live.delete(account.id);
  });

  live.set(account.id, { context, mode, lastUsed: Date.now(), accountId: account.id });
  log.info(`Mo profile ${account.platform}/${account.label} (${mode}, headless=${headless})`);
  return context;
}

/**
 * Lay (hoac mo) context cho account. Neu dang co cua so dang nhap mo san thi dung lai.
 */
export async function getContext(account, { headless = config.browser.headless, mode = 'job' } = {}) {
  return withLock(account.id, async () => {
    const entry = live.get(account.id);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.context;
    }
    return openContext(account, { headless, mode });
  });
}

/** Mo context va dam bao co it nhat 1 page. */
export async function getPage(account, opts = {}) {
  const context = await getContext(account, opts);
  const pages = context.pages();
  const page = pages.length ? pages[0] : await context.newPage();
  return page;
}

/**
 * Mo cua so that de nguoi dung dang nhap thu cong. Context duoc giu mo
 * (mode='login') de worker dung lai sau khi dang nhap xong.
 */
export async function openLoginWindow(account, { url } = {}) {
  return withLock(account.id, async () => {
    const existing = live.get(account.id);
    if (existing) {
      // Da mo -> chi can focus va dieu huong.
      existing.mode = 'login';
      const page = existing.context.pages()[0] ?? (await existing.context.newPage());
      await page.bringToFront().catch(() => {});
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
      return { reused: true };
    }
    const context = await openContext(account, { headless: false, mode: 'login' });
    const page = context.pages()[0] ?? (await context.newPage());
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.bringToFront().catch(() => {});
    return { reused: false };
  });
}

export async function closeAccount(accountId) {
  const id = Number(accountId);
  return withLock(id, async () => {
    // Chan moi lan mo moi trong luc dang dong, va bao cho lan mo dang do biet.
    closing.add(id);
    try {
      const entry = live.get(id);
      if (!entry) return false;
      live.delete(id);
      await entry.context.close().catch(() => {});
      log.info(`Dong profile account #${id}`);
      return true;
    } finally {
      closing.delete(id);
    }
  });
}

export async function closeAll() {
  const ids = [...live.keys()];
  await Promise.all(ids.map((id) => closeAccount(id)));
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Session probe                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Kiem tra profile con dang nhap hay khong.
 * @returns {Promise<{status:'logged_in'|'logged_out'|'unknown', message:string, url:string}>}
 */
export async function probeSession(account, platform) {
  return withLock(account.id, async () => {
    let context;
    let ownContext = false;
    try {
      const entry = live.get(account.id);
      if (entry) {
        context = entry.context;
      } else {
        context = await openContext(account, { headless: true, mode: 'job' });
        ownContext = true;
      }

      const page = await context.newPage();
      try {
        const probe = platform.session ?? {};
        await page.goto(probe.probeUrl || platform.homeUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(2500);

        if (probe.loggedOut) {
          const out = await findVisible(page, probe.loggedOut, { timeout: 1500 });
          if (out) return { status: 'logged_out', message: 'Phat hien form dang nhap', url: page.url() };
        }
        if (probe.loggedIn) {
          const inside = await findVisible(page, probe.loggedIn, { timeout: 8000 });
          if (inside) return { status: 'logged_in', message: 'Phien dang nhap con hieu luc', url: page.url() };
          return { status: 'logged_out', message: 'Khong tim thay dau hieu da dang nhap', url: page.url() };
        }
        return { status: 'unknown', message: 'Nen tang chua khai bao cach kiem tra phien', url: page.url() };
      } finally {
        await page.close().catch(() => {});
      }
    } catch (err) {
      return { status: 'unknown', message: `Loi kiem tra: ${err.message}`, url: '' };
    } finally {
      if (ownContext && context) {
        live.delete(account.id);
        await context.close().catch(() => {});
      }
    }
  });
}

/** Dung cho lenh doctor: liet ke browser co the dung. */
export function detectBrowsers() {
  const candidates = [
    ['msedge', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['msedge', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['chrome', process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['chrome', process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')],
  ];
  const found = [];
  for (const [channel, p] of candidates) {
    if (p && fs.existsSync(p) && !found.some((f) => f.channel === channel)) {
      found.push({ channel, path: p });
    }
  }
  return found;
}

export default {
  getContext,
  getPage,
  openLoginWindow,
  closeAccount,
  closeAll,
  probeSession,
  isOpen,
  profileDirFor,
  detectBrowsers,
};
