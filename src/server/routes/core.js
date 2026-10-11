import express from 'express';
import config from '../../config.js';
import { all, get, run, nowIso, getSetting, setSetting } from '../../db.js';
import { h, toInt, badRequest } from '../http.js';
import { listPlatforms, allPlatforms, parseTargetUrl } from '../../platforms/index.js';
import { workerStatus } from '../../core/worker.js';
import { detectBrowsers, isOpen } from '../../core/browser.js';

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* GET /api/health                                                            */
/* -------------------------------------------------------------------------- */

router.get(
  '/health',
  h(async (_req, res) => {
    let dbOk = true;
    try {
      get('SELECT 1 AS ok');
    } catch {
      dbOk = false;
    }
    res.json({
      ok: dbOk,
      version: process.env.npm_package_version ?? '0.1.0',
      time: nowIso(),
      uptimeSec: Math.round(process.uptime()),
      node: process.version,
      dataDir: config.dataDir,
      browser: {
        channel: config.browser.channel,
        headless: config.browser.headless,
        installed: detectBrowsers(),
      },
      worker: workerStatus(),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET /api/platforms                                                         */
/* -------------------------------------------------------------------------- */

router.get('/platforms', (_req, res) => {
  res.json({ platforms: listPlatforms() });
});

/** Doan nhan dang nhom/trang tu danh sach URL. */
router.post(
  '/platforms/resolve',
  h(async (req, res) => {
    const urls = Array.isArray(req.body?.urls) ? req.body.urls : [];
    const platformHint = req.body?.platform;
    const results = urls.map((url) => ({
      url,
      parsed: parseTargetUrl(url, { platformHint }),
    }));
    res.json({ results });
  }),
);

/* -------------------------------------------------------------------------- */
/* GET /api/stats - so lieu cho dashboard                                     */
/* -------------------------------------------------------------------------- */

router.get(
  '/stats',
  h(async (_req, res) => {
    const counts = get(`
      SELECT
        (SELECT COUNT(*) FROM accounts)  AS accounts,
        (SELECT COUNT(*) FROM targets)   AS targets,
        (SELECT COUNT(*) FROM posts)     AS posts,
        (SELECT COUNT(*) FROM jobs)      AS jobs
    `);

    const items = get(`
      SELECT
        COALESCE(SUM(status='pending'),0)  AS pending,
        COALESCE(SUM(status='running'),0)  AS running,
        COALESCE(SUM(status='success'),0)  AS success,
        COALESCE(SUM(status='failed'),0)   AS failed,
        COALESCE(SUM(status='skipped'),0)  AS skipped,
        COALESCE(SUM(status='canceled'),0) AS canceled
      FROM job_items
    `);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayRow = get(
      `SELECT
         COALESCE(SUM(status='success'),0) AS success,
         COALESCE(SUM(status='failed'),0)  AS failed
       FROM job_items WHERE COALESCE(finished_at, started_at) >= ?`,
      today.toISOString(),
    );

    const byPlatform = all(`
      SELECT a.platform,
             COUNT(*) AS total,
             COALESCE(SUM(i.status='success'),0) AS success,
             COALESCE(SUM(i.status='failed'),0)  AS failed
        FROM job_items i
        JOIN accounts a ON a.id = i.account_id
       GROUP BY a.platform
       ORDER BY total DESC
    `);

    const accounts = all(
      `SELECT a.id, a.platform, a.label, a.status, a.enabled, a.daily_limit,
              (SELECT COUNT(*) FROM targets t WHERE t.account_id = a.id) AS targets,
              (SELECT COUNT(*) FROM job_items i
                WHERE i.account_id = a.id AND i.status='success' AND i.finished_at >= ?) AS posted_today
         FROM accounts a
        ORDER BY a.id`,
      today.toISOString(),
    );

    const upcoming = all(`
      SELECT j.id, j.name, j.status, j.scheduled_at, j.total, j.success_count, j.failed_count,
             j.dry_run
        FROM jobs j
       WHERE j.status IN ('scheduled','running','paused')
       ORDER BY j.scheduled_at ASC
       LIMIT 10
    `);

    const recent = all(`
      SELECT i.id, i.status, i.finished_at, i.error, i.remote_url,
             p.title AS post_title, t.name AS target_name, a.label AS account_label,
             a.platform
        FROM job_items i
        JOIN posts p    ON p.id = i.post_id
        JOIN targets t  ON t.id = i.target_id
        JOIN accounts a ON a.id = i.account_id
       WHERE i.status IN ('success','failed')
       ORDER BY COALESCE(i.finished_at, i.started_at) DESC
       LIMIT 15
    `);

    res.json({
      counts: { ...counts, ...items, today },
      today: todayRow,
      byPlatform,
      accounts,
      upcoming,
      recent,
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Logs                                                                       */
/* -------------------------------------------------------------------------- */

router.get(
  '/logs',
  h(async (req, res) => {
    const limit = Math.min(1000, toInt(req.query.limit, 200));
    const level = req.query.level;
    const jobId = toInt(req.query.jobId);

    const where = [];
    const params = [];
    if (level && level !== 'all') {
      where.push(`level = ?`);
      params.push(level);
    }
    if (jobId) {
      where.push(`job_id = ?`);
      params.push(jobId);
    }
    const sql = `SELECT * FROM logs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    res.json({ logs: all(sql, ...params, limit) });
  }),
);

router.delete(
  '/logs',
  h(async (_req, res) => {
    run('DELETE FROM logs');
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Cai dat                                                                    */
/* -------------------------------------------------------------------------- */

const DEFAULTS = {
  defaultDailyLimit: config.worker.defaultDailyLimit,
  defaultMinDelaySec: config.worker.defaultMinDelaySec,
  defaultMaxDelaySec: config.worker.defaultMaxDelaySec,
  defaultMaxAttempts: config.worker.defaultMaxAttempts,
  headless: config.browser.headless,
};

router.get(
  '/settings',
  h(async (_req, res) => {
    res.json({
      settings: { ...DEFAULTS, ...(getSetting('settings', {}) ?? {}) },
      runtime: {
        concurrency: config.worker.concurrency,
        browserChannel: config.browser.channel,
        dataDir: config.dataDir,
        allowDryRun: config.allowDryRun,
        allowLoginWindow: config.allowLoginWindow,
      },
    });
  }),
);

router.put(
  '/settings',
  h(async (req, res) => {
    const incoming = req.body ?? {};
    const next = { ...(getSetting('settings', {}) ?? {}) };
    for (const key of Object.keys(DEFAULTS)) {
      if (incoming[key] !== undefined) {
        const n = Number(incoming[key]);
        if (!Number.isFinite(n) || n < 0) throw badRequest(`Gia tri khong hop le cho ${key}`);
        next[key] = n;
      }
    }
    setSetting('settings', next);
    res.json({ settings: { ...DEFAULTS, ...next } });
  }),
);

/* -------------------------------------------------------------------------- */
/* Worker + browser                                                           */
/* -------------------------------------------------------------------------- */

router.get('/worker', (_req, res) => res.json(workerStatus()));

router.get(
  '/browsers',
  h(async (_req, res) => {
    const accounts = all('SELECT id, platform, label FROM accounts ORDER BY id');
    res.json({
      installed: detectBrowsers(),
      configuredChannel: config.browser.channel,
      open: accounts.filter((a) => isOpen(a.id)).map((a) => a.id),
    });
  }),
);

/* -------------------------------------------------------------------------- */
/* Debug: kiem tra selector cua mot nen tang                                  */
/* -------------------------------------------------------------------------- */

router.get(
  '/platforms/:id/flow',
  h(async (req, res) => {
    const platform = allPlatforms().find((p) => p.id === req.params.id);
    if (!platform) throw badRequest(`Nen tang khong ton tai: ${req.params.id}`);

    const summarize = (steps) =>
      (Array.isArray(steps) ? steps : [steps]).map((s, i) => {
        const key = Object.keys(s ?? {}).find(
          (k) => !['optional', 'timeout', 'submit', 'label', 'after'].includes(k),
        );
        const val = s?.[key];
        const detail =
          typeof val === 'function'
            ? '(ham dong)'
            : typeof val === 'string' || typeof val === 'number'
              ? val
              : JSON.stringify(val);
        return { index: i, action: key, submit: !!s?.submit, optional: !!s?.optional, detail: String(detail).slice(0, 300) };
      });

    res.json({
      id: platform.id,
      name: platform.name,
      verified: platform.verified,
      experimental: platform.experimental,
      notes: platform.notes,
      flows: Object.fromEntries(Object.entries(platform.flows).map(([k, f]) => [k, summarize(f.steps)])),
    });
  }),
);

export default router;
