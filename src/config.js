import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');

function envStr(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : String(v);
}

function envInt(name, def) {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}

function envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

const dataDir = path.resolve(envStr('AUTOTOOL_DATA_DIR', path.join(ROOT, 'data')));

export const config = {
  root: ROOT,
  dataDir,
  paths: {
    dataDir,
    db: path.join(dataDir, 'autotool.sqlite'),
    media: path.join(dataDir, 'media'),
    profiles: path.join(dataDir, 'profiles'),
    screenshots: path.join(dataDir, 'screenshots'),
    logs: path.join(dataDir, 'logs'),
    web: path.join(ROOT, 'src', 'web'),
  },

  host: envStr('HOST', '127.0.0.1'),
  port: envInt('PORT', 8787),

  browser: {
    channel: envStr('BROWSER_CHANNEL', 'msedge'),
    headless: envBool('HEADLESS', false),
    locale: envStr('BROWSER_LOCALE', 'vi-VN'),
    timezoneId: envStr('BROWSER_TIMEZONE', 'Asia/Ho_Chi_Minh'),
    viewport: {
      width: envInt('BROWSER_VIEWPORT_WIDTH', 1440),
      height: envInt('BROWSER_VIEWPORT_HEIGHT', 900),
    },
    /** Thoi gian toi da cho 1 buoc trong flow (ms) */
    stepTimeoutMs: envInt('BROWSER_STEP_TIMEOUT_MS', 30000),
    /** Thoi gian toi da cho ca 1 lan dang bai (ms) */
    itemTimeoutMs: envInt('BROWSER_ITEM_TIMEOUT_MS', 240000),
  },

  worker: {
    concurrency: Math.max(1, envInt('WORKER_CONCURRENCY', 2)),
    tickMs: Math.max(500, envInt('WORKER_TICK_MS', 3000)),
    defaultDailyLimit: envInt('DEFAULT_DAILY_LIMIT', 15),
    defaultMinDelaySec: envInt('DEFAULT_MIN_DELAY_SEC', 120),
    defaultMaxDelaySec: envInt('DEFAULT_MAX_DELAY_SEC', 360),
    defaultMaxAttempts: envInt('DEFAULT_MAX_ATTEMPTS', 3),
    maxDefers: envInt('WORKER_MAX_DEFERS', 3),
  },

  allowDryRun: envBool('ALLOW_DRY_RUN', true),
  allowLoginWindow: envBool('ALLOW_LOGIN_WINDOW', true),

  /** Gioi han kich thuoc 1 file media (byte) */
  maxUploadBytes: envInt('MAX_UPLOAD_MB', 64) * 1024 * 1024,
};

export function ensureDirs() {
  for (const dir of [
    config.paths.dataDir,
    config.paths.media,
    config.paths.profiles,
    config.paths.screenshots,
    config.paths.logs,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export default config;
