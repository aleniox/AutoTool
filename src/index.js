import config, { ensureDirs, ROOT } from './config.js';
import { createLogger } from './logger.js';
import { pruneLogs, run, nowIso } from './db.js';
import { createApp } from './server/http.js';
import { startWorker, stopWorker, workerStatus } from './core/worker.js';
import { closeAll, detectBrowsers } from './core/browser.js';

import coreRoutes from './server/routes/core.js';
import accountRoutes from './server/routes/accounts.js';
import contentRoutes from './server/routes/content.js';
import jobRoutes from './server/routes/jobs.js';

const log = createLogger('server');

ensureDirs();

// Don sach item bi treo tu lan chay truoc (process bi kill giua chung)
const orphans = run(
  `UPDATE job_items SET status = 'pending', started_at = NULL, run_at = ?
    WHERE status = 'running' AND started_at < ?`,
  nowIso(),
  new Date(Date.now() - 3600_000).toISOString(),
);
if (orphans.changes) log.warn(`Khoi phuc ${orphans.changes} luot dang bi treo tu lan chay truoc`);

const app = createApp([
  { path: '/api', router: coreRoutes },
  { path: '/api', router: accountRoutes },
  { path: '/api', router: contentRoutes },
  { path: '/api', router: jobRoutes },
]);

const server = app.listen(config.port, config.host, () => {
  const url = `http://${config.host}:${config.port}`;
  const browsers = detectBrowsers();
  log.info('─'.repeat(64));
  log.info(`  AutoTool dang chay tai ${url}`);
  log.info(`  Thu muc du lieu : ${config.dataDir}`);
  log.info(`  Browser engine  : ${config.browser.channel}${browsers.length ? '' : ' (KHONG TIM THAY!)'}`);
  log.info(`  Che do          : ${config.browser.headless ? 'an (headless)' : 'hien cua so'}`);
  log.info('─'.repeat(64));
  if (!browsers.length && config.browser.channel !== 'chromium') {
    log.warn('Khong tim thay Chrome/Edge. Chay `npm run cli -- doctor` de kiem tra.');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(`Cong ${config.port} dang duoc dung. Doi PORT trong .env hoac tat tien trinh cu.`);
  } else {
    log.error(err.stack || err.message);
  }
  process.exit(1);
});

startWorker();

const pruner = setInterval(() => pruneLogs(14), 12 * 3600_000);
pruner.unref?.();

/* -------------------------------------------------------------------------- */
/* Tat gon gang                                                               */
/* -------------------------------------------------------------------------- */

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Nhan ${signal}, dang tat...`);

  const force = setTimeout(() => {
    log.warn('Qua thoi gian cho, thoat ngay.');
    process.exit(1);
  }, 30000);
  force.unref?.();

  server.close();
  await stopWorker({ drain: true, timeoutMs: 20000 });
  await closeAll();
  clearInterval(pruner);
  log.info('Da tat sach se.');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error(`unhandledRejection: ${err?.stack || err}`));
process.on('uncaughtException', (err) => {
  log.error(`uncaughtException: ${err?.stack || err}`);
});

export { app, server, workerStatus, ROOT };
