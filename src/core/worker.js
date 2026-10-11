import config from '../config.js';
import { all, get, run, nowIso } from '../db.js';
import { createLogger } from '../logger.js';
import { runItem } from './runner.js';

const log = createLogger('worker');

/** itemId -> Promise */
const inFlight = new Map();
let timer = null;
let stopping = false;
let lastTickAt = null;
let startedAt = null;

const randInt = (min, max) => {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return Math.floor(lo + Math.random() * (hi - lo + 1));
};

/* -------------------------------------------------------------------------- */
/* Vong lap                                                                   */
/* -------------------------------------------------------------------------- */

export function startWorker() {
  if (timer) return;
  stopping = false;
  startedAt = nowIso();
  timer = setInterval(() => {
    tick().catch((err) => log.error(`Loi trong tick: ${err.stack || err.message}`));
  }, config.worker.tickMs);
  timer.unref?.();
  log.info(`Worker khoi dong (concurrency=${config.worker.concurrency}, tick=${config.worker.tickMs}ms)`);
}

export async function stopWorker({ drain = true, timeoutMs = 60000 } = {}) {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  if (drain && inFlight.size) {
    log.info(`Cho ${inFlight.size} tac vu dang chay hoan tat...`);
    await Promise.race([
      Promise.allSettled([...inFlight.values()]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }
}

export function workerStatus() {
  return {
    running: inFlight.size,
    concurrency: config.worker.concurrency,
    lastTickAt,
    startedAt,
    items: [...inFlight.keys()],
  };
}

async function tick() {
  if (stopping) return;
  lastTickAt = nowIso();
  const now = nowIso();

  // Job den gio -> chay
  const activated = run(
    `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?)
     WHERE status = 'scheduled' AND scheduled_at <= ?`,
    now,
    now,
  );
  if (activated.changes) log.info(`Kich hoat ${activated.changes} chien dich den han`);

  const slots = config.worker.concurrency - inFlight.size;
  if (slots <= 0) return;

  const items = claimItems(slots, now);
  for (const item of items) {
    const p = execute(item)
      .catch((err) => log.error(`Item #${item.id} loi khong xu ly duoc: ${err.stack || err.message}`))
      .finally(() => inFlight.delete(item.id));
    inFlight.set(item.id, p);
  }
}

/* -------------------------------------------------------------------------- */
/* Chiem item                                                                 */
/* -------------------------------------------------------------------------- */

function claimItems(limit, now) {
  const rows = all(
    `SELECT i.*, j.dry_run, j.min_delay_sec AS job_min_delay, j.max_delay_sec AS job_max_delay,
            j.max_attempts AS job_max_attempts, j.status AS job_status
       FROM job_items i
       JOIN jobs j     ON j.id = i.job_id
       JOIN accounts a ON a.id = i.account_id
      WHERE i.status = 'pending'
        AND i.run_at <= ?
        AND j.status = 'running'
        AND a.enabled = 1
        AND i.account_id NOT IN (SELECT account_id FROM job_items WHERE status = 'running')
      ORDER BY i.run_at ASC, i.id ASC
      LIMIT ?`,
    now,
    limit,
  );

  if (!rows.length) return [];

  const stmt = `UPDATE job_items SET status = 'running', started_at = ? WHERE id = ? AND status = 'pending'`;
  const claimed = [];
  for (const row of rows) {
    const res = run(stmt, now, row.id);
    if (res.changes === 1) claimed.push(row);
  }
  return claimed;
}

/* -------------------------------------------------------------------------- */
/* Thuc thi                                                                   */
/* -------------------------------------------------------------------------- */

async function execute(item) {
  const job = get('SELECT * FROM jobs WHERE id = ?', item.job_id);
  const account = get('SELECT * FROM accounts WHERE id = ?', item.account_id);
  const target = get('SELECT * FROM targets WHERE id = ?', item.target_id);
  const post = get('SELECT * FROM posts WHERE id = ?', item.post_id);

  if (!job || !account || !target || !post) {
    markFailed(item, job, 'Du lieu khong con ton tai (job/account/target/post da bi xoa).');
    return;
  }
  if (job.status !== 'running') {
    run(`UPDATE job_items SET status = 'pending', started_at = NULL WHERE id = ?`, item.id);
    return;
  }

  // --- Gioi han theo ngay ---------------------------------------------------
  const capped = checkDailyCap(account, item);
  if (capped === 'deferred') return;
  if (capped === 'exhausted') return;

  const minDelay = item.job_min_delay ?? account.min_delay_sec ?? config.worker.defaultMinDelaySec;
  const maxDelay = item.job_max_delay ?? account.max_delay_sec ?? config.worker.defaultMaxDelaySec;
  const maxAttempts = item.job_max_attempts || item.max_attempts || config.worker.defaultMaxAttempts;

  try {
    const result = await runItem({
      account,
      target,
      post,
      job,
      dryRun: !!job.dry_run,
    });

    run(
      `UPDATE job_items SET status='success', finished_at=?, remote_url=?, error='' WHERE id=?`,
      nowIso(),
      result.remoteUrl ?? '',
      item.id,
    );
    run(`UPDATE targets SET last_post_at=? WHERE id=?`, nowIso(), target.id);
    log.info(
      `${job.dry_run ? '[THU] ' : ''}THANH CONG: bai #${post.id} -> ${target.name} (${account.label})`,
      { accountId: account.id, jobId: job.id, itemId: item.id },
    );
    paceNextForAccount(account.id, minDelay, maxDelay);
  } catch (err) {
    await handleFailure({ item, job, account, err, maxAttempts, minDelay, maxDelay });
  }

  refreshJob(job.id);
}

async function handleFailure({ item, job, account, err, maxAttempts, minDelay, maxDelay }) {
  const attempts = item.attempts + 1;
  const message = String(err.message ?? err).slice(0, 1000);
  const kind = err.kind ?? classify(message);

  if (kind === 'auth') {
    run(
      `UPDATE accounts SET status='expired', status_message=?, last_check_at=? WHERE id=?`,
      message,
      nowIso(),
      account.id,
    );
    log.error(`Phien dang nhap het han voi ${account.label}: ${message}`, {
      accountId: account.id,
      jobId: job.id,
      itemId: item.id,
    });
    // Tam dung cac chien dich con viec cua account nay de khong dot het danh sach
    const paused = run(
      `UPDATE jobs SET status='paused'
        WHERE status='running'
          AND id IN (SELECT DISTINCT job_id FROM job_items WHERE account_id=? AND status='pending')`,
      account.id,
    );
    if (paused.changes) log.warn(`Da tam dung ${paused.changes} chien dich do account het phien dang nhap.`);
  }

  if (kind === 'rate_limit') {
    const waitSec = randInt(15 * 60, 45 * 60);
    run(
      `UPDATE job_items SET status='pending', attempts=?, started_at=NULL, run_at=?, error=? WHERE id=?`,
      attempts,
      new Date(Date.now() + waitSec * 1000).toISOString(),
      message,
      item.id,
    );
    log.warn(`Bi gioi han tan suat - hoan lai sau ${Math.round(waitSec / 60)} phut: ${message}`, {
      accountId: account.id,
      jobId: job.id,
      itemId: item.id,
    });
    return;
  }

  if (attempts < maxAttempts && kind !== 'blocked') {
    const backoffSec = Math.min(30 * 60, 60 * 2 ** (attempts - 1)) + randInt(0, 30);
    run(
      `UPDATE job_items SET status='pending', attempts=?, started_at=NULL, run_at=?, error=? WHERE id=?`,
      attempts,
      new Date(Date.now() + backoffSec * 1000).toISOString(),
      message,
      item.id,
    );
    log.warn(
      `That bai (lan ${attempts}/${maxAttempts}) - thu lai sau ${Math.round(backoffSec / 60)} phut: ${message}`,
      { accountId: account.id, jobId: job.id, itemId: item.id },
    );
    paceNextForAccount(account.id, minDelay, maxDelay);
    return;
  }

  run(
    `UPDATE job_items SET status='failed', attempts=?, finished_at=?, error=? WHERE id=?`,
    attempts,
    nowIso(),
    message,
    item.id,
  );
  const screenshot = /\[anh loi: ([^\]]+)\]/.exec(message)?.[1];
  if (screenshot) run(`UPDATE job_items SET screenshot=? WHERE id=?`, screenshot, item.id);
  log.error(`THAT BAI: bai #${item.post_id} -> target #${item.target_id}: ${message}`, {
    accountId: account.id,
    jobId: job.id,
    itemId: item.id,
  });
  paceNextForAccount(account.id, minDelay, maxDelay);
}

function classify(message) {
  const m = String(message).toLowerCase();
  if (/het han|expired|dang nhap|log ?in|login/.test(m)) return 'auth';
  if (/gioi han|rate|temporarily blocked|flood|too many/.test(m)) return 'rate_limit';
  if (/bi chan|blocked/.test(m)) return 'blocked';
  return 'error';
}

/* -------------------------------------------------------------------------- */
/* Gioi han theo ngay                                                         */
/* -------------------------------------------------------------------------- */

function checkDailyCap(account, item) {
  const limit = account.daily_limit ?? config.worker.defaultDailyLimit;
  if (!limit || limit <= 0) return null;

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const row = get(
    `SELECT COUNT(*) AS c FROM job_items WHERE account_id = ? AND status = 'success' AND finished_at >= ?`,
    account.id,
    start.toISOString(),
  );
  if ((row?.c ?? 0) < limit) return null;

  if (item.defers >= config.worker.maxDefers) {
    run(
      `UPDATE job_items SET status='skipped', finished_at=?, error=? WHERE id=?`,
      nowIso(),
      `Da dat gioi han ${limit} bai/ngay cua account.`,
      item.id,
    );
    log.warn(`Bo qua item #${item.id}: account ${account.label} da dat gioi han ${limit} bai/ngay`, {
      accountId: account.id,
      jobId: item.job_id,
      itemId: item.id,
    });
    return 'exhausted';
  }

  const next = new Date();
  next.setDate(next.getDate() + 1);
  next.setHours(7, randInt(0, 90), 0, 0);
  run(
    `UPDATE job_items SET status='pending', defers=defers+1, run_at=?, started_at=NULL, error=? WHERE id=?`,
    next.toISOString(),
    `Hoan sang ngay mai: da dat gioi han ${limit} bai/ngay.`,
    item.id,
  );
  log.info(`Hoan item #${item.id} sang ${next.toLocaleString('vi-VN')} (gioi han ngay)`, {
    accountId: account.id,
    jobId: item.job_id,
    itemId: item.id,
  });
  return 'deferred';
}

/* -------------------------------------------------------------------------- */
/* Gian cach giua 2 bai cua cung account                                      */
/* -------------------------------------------------------------------------- */

function paceNextForAccount(accountId, minDelay, maxDelay) {
  const next = get(
    `SELECT id, run_at FROM job_items WHERE account_id = ? AND status = 'pending' ORDER BY run_at ASC, id ASC LIMIT 1`,
    accountId,
  );
  if (!next) return;
  const earliest = new Date(Date.now() + randInt(minDelay, maxDelay) * 1000).toISOString();
  if (new Date(next.run_at).getTime() < new Date(earliest).getTime()) {
    run(`UPDATE job_items SET run_at = ? WHERE id = ?`, earliest, next.id);
  }
}

/* -------------------------------------------------------------------------- */
/* Trang thai job                                                             */
/* -------------------------------------------------------------------------- */

export function refreshJob(jobId) {
  const job = get('SELECT * FROM jobs WHERE id = ?', jobId);
  if (!job) return;

  const c = get(
    `SELECT
       COALESCE(SUM(status='pending'),0)  AS pending,
       COALESCE(SUM(status='running'),0)  AS running,
       COALESCE(SUM(status='success'),0)  AS success,
       COALESCE(SUM(status='failed'),0)   AS failed,
       COALESCE(SUM(status='skipped'),0)  AS skipped,
       COALESCE(SUM(status='canceled'),0) AS canceled,
       COUNT(*) AS total
     FROM job_items WHERE job_id = ?`,
    jobId,
  );

  const active = c.pending + c.running;
  let status = job.status;
  let finishedAt = job.finished_at;

  if (active === 0) {
    if (job.status === 'running' || job.status === 'scheduled') {
      status = c.success > 0 ? 'done' : c.failed > 0 ? 'failed' : 'done';
      finishedAt = nowIso();
      log.info(
        `Chien dich #${jobId} "${job.name}" ket thuc: ${c.success} thanh cong, ${c.failed} that bai, ${c.skipped} bo qua.`,
      );
    }
  }
  // Job 'scheduled' chi duoc chuyen sang 'running' boi tick() khi da den scheduled_at.

  run(
    `UPDATE jobs SET status=?, total=?, success_count=?, failed_count=?, skipped_count=?, finished_at=? WHERE id=?`,
    status,
    c.total,
    c.success,
    c.failed,
    c.skipped,
    finishedAt,
    jobId,
  );
}

/** Goi khi tao job moi. */
export function touchJob(jobId) {
  refreshJob(jobId);
}

export default { startWorker, stopWorker, workerStatus, refreshJob, touchJob };
