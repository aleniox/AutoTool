import express from 'express';
import config from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('http');

/** Bao loi co ma trang thai tra ve client. */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new ApiError(400, msg, details);
export const notFound = (msg = 'Khong tim thay') => new ApiError(404, msg);

/** Boc handler async de loi duoc chuyen cho error middleware. */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function toInt(value, def = null) {
  if (value === undefined || value === null || value === '') return def;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : def;
}

export function toBool(value, def = false) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body?.[f] === undefined || body?.[f] === null || body?.[f] === '');
  if (missing.length) throw badRequest(`Thieu truong bat buoc: ${missing.join(', ')}`);
}

export function createApp(routers) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '8mb' }));

  app.use((req, _res, next) => {
    if (req.path.startsWith('/api') && req.method !== 'GET') {
      log.debug(`${req.method} ${req.path}`);
    }
    next();
  });

  for (const { path: mountPath, router } of routers) {
    app.use(mountPath, router);
  }

  // File tinh: dashboard, media da upload, anh chup loi
  app.use('/media', express.static(config.paths.media, { fallthrough: true }));
  app.use('/screenshots', express.static(config.paths.screenshots, { fallthrough: true }));
  app.use(express.static(config.paths.web));

  app.use('/api', (_req, res) => res.status(404).json({ error: 'Endpoint khong ton tai' }));

  // SPA fallback
  app.get(/^\/(?!api|media|screenshots).*/, (_req, res) => {
    res.sendFile(`${config.paths.web}/index.html`);
  });

  app.use((err, _req, res, _next) => {
    const status = err.status ?? 500;
    if (status >= 500) log.error(err.stack || err.message);
    else log.warn(`${status}: ${err.message}`);
    res.status(status).json({
      error: err.message || 'Loi khong xac dinh',
      ...(err.details ? { details: err.details } : {}),
    });
  });

  return app;
}

export default createApp;
