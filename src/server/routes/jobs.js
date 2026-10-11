import express from 'express';
import { all, get, run, insert, nowIso, tx } from '../../db.js';
import config from '../../config.js';
import { h, requireFields, toInt, toBool, badRequest, notFound } from '../http.js';
import { refreshJob } from '../../core/worker.js';
import { createLogger } from '../../logger.js';

const router = express.Router();
const log = createLogger('api:jobs');

const STRATEGIES = {
  cross: 'Moi bai -> moi nhom (cartesian, nhieu luot nhat)',
  zip: 'Ghep 1-1 theo thu tu (bai i -> nhom i)',
  round_robin: 'Chia deu: xoay vong bai cho tung nhom, khong lap trong cung nhom',
};

const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

/* -------------------------------------------------------------------------- */
/* Tao chien dich                                                             */
/* -------------------------------------------------------------------------- */

router.post(
  '/jobs',
  h(async (req, res) => {
    requireFields(req.body, ['name']);
    const body = req.body;

    const dryRun = toBool(body.dryRun, false);
    if (dryRun && !config.allowDryRun) throw badRequest('Che do thu dang bi tat (ALLOW_DRY_RUN=false)');

    const projectId = toInt(body.projectId);

    /* --- Chon bai viet --- */
    let posts;
    if (Array.isArray(body.postIds) && body.postIds.length) {
      const ids = body.postIds.map((i) => toInt(i)).filter(Boolean);
      const ph = ids.map(() => '?').join(',');
      posts = all(`SELECT * FROM posts WHERE id IN (${ph}) ORDER BY id`, ...ids);
      if (posts.length !== ids.length) throw badRequest('Mot so bai viet khong ton tai');
    } else if (body.useAllPosts) {
      posts = all(
        `SELECT * FROM posts ${projectId ? 'WHERE project_id = ?' : ''} ORDER BY id`,
        ...(projectId ? [projectId] : []),
      );
    } else {
      throw badRequest('Chua chon bai viet nao');
    }
    if (!posts.length) throw badRequest('Khong co bai viet nao de dang');

    /* --- Chon nhom --- */
    let targets;
    if (Array.isArray(body.targetIds) && body.targetIds.length) {
      const ids = body.targetIds.map((i) => toInt(i)).filter(Boolean);
      const ph = ids.map(() => '?').join(',');
      targets = all(
        `SELECT t.* FROM targets t JOIN accounts a ON a.id = t.account_id
          WHERE t.id IN (${ph}) AND t.enabled = 1 AND a.enabled = 1 ORDER BY t.account_id, t.id`,
        ...ids,
      );
      if (!targets.length) throw badRequest('Khong co nhom nao hop le (da bat) trong danh sach chon');
    } else if (body.useAllTargets) {
      const accountId = toInt(body.accountId);
      const where = ['t.enabled = 1', 'a.enabled = 1'];
      const params = [];
      if (projectId) {
        where.push('t.project_id = ?');
        params.push(projectId);
      }
      if (accountId) {
        where.push('t.account_id = ?');
        params.push(accountId);
      }
      targets = all(
        `SELECT t.* FROM targets t JOIN accounts a ON a.id = t.account_id
          WHERE ${where.join(' AND ')} ORDER BY t.account_id, t.id`,
        ...params,
      );
    } else {
      throw badRequest('Chua chon nhom nao');
    }
    if (!targets.length) throw badRequest('Khong co nhom nao de dang');

    /* --- Ghep bai x nhom --- */
    const strategy = String(body.strategy ?? 'cross');
    if (!STRATEGIES[strategy]) throw badRequest(`Chien luoc khong hop le: ${strategy}`);

    const pairs = buildPairs(strategy, posts, targets);
    if (!pairs.length) throw badRequest('Khong tao duoc luot dang nao tu lua chon nay');

    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
    if (Number.isNaN(scheduledAt.getTime())) throw badRequest('scheduledAt khong hop le');

    const maxAttempts = Math.max(
      1,
      toInt(body.maxAttempts, config.worker.defaultMaxAttempts),
    );

    // Dan xen theo account + lech nhe thoi diem bat dau giua cac account
    const accountIndex = new Map();
    for (const t of targets) {
      if (!accountIndex.has(t.account_id)) accountIndex.set(t.account_id, accountIndex.size);
    }
    const ordered = [...pairs].sort(
      (a, b) => accountIndex.get(a.account_id) - accountIndex.get(b.account_id),
    );

    const jobId = tx(() => {
      const jid = insert('jobs', {
        project_id: projectId,
        name: String(body.name).trim(),
        strategy,
        status: scheduledAt.getTime() <= Date.now() + 1000 ? 'running' : 'scheduled',
        dry_run: dryRun ? 1 : 0,
        scheduled_at: scheduledAt.toISOString(),
        min_delay_sec: body.minDelaySec !== undefined && body.minDelaySec !== '' ? toInt(body.minDelaySec) : null,
        max_delay_sec: body.maxDelaySec !== undefined && body.maxDelaySec !== '' ? toInt(body.maxDelaySec) : null,
        max_attempts: maxAttempts,
        total: ordered.length,
        created_at: nowIso(),
        started_at: scheduledAt.getTime() <= Date.now() + 1000 ? nowIso() : null,
      });

      for (const pair of ordered) {
        const offsetSec = accountIndex.get(pair.account_id) * randInt(5, 45);
        insert('job_items', {
          job_id: jid,
          account_id: pair.account_id,
          target_id: pair.target_id,
          post_id: pair.post_id,
          status: 'pending',
          attempts: 0,
          max_attempts: maxAttempts,
          defers: 0,
          run_at: new Date(scheduledAt.getTime() + offsetSec * 1000).toISOString(),
        });
      }
      return jid;
    });

    refreshJob(jobId);
    log.info(
      `Tao chien dich #${jobId} "${body.name}": ${ordered.length} luot dang (${posts.length} bai x ${targets.length} nhom, chien luoc ${strategy})${dryRun ? ' [CHE DO THU]' : ''}`,
    );

    res.status(201).json({
      job: get('SELECT * FROM jobs WHERE id = ?', jobId),
      preview: {
        posts: posts.length,
        targets: targets.length,
        items: ordered.length,
        accounts: accountIndex.size,
        strategy,
      },
    });
  }),
);

function buildPairs(strategy, posts, targets) {
  const pairs = [];
  if (strategy === 'cross') {
    for (const t of targets) {
      for (const p of posts) {
        pairs.push({ account_id: t.account_id, target_id: t.id, post_id: p.id });
      }
    }
    return pairs;
  }

  if (strategy === 'zip') {
    const n = Math.min(posts.length, targets.length);
    for (let i = 0; i < n; i += 1) {
      pairs.push({ account_id: targets[i].account_id, target_id: targets[i].id, post_id: posts[i].id });
    }
    return pairs;
  }

  // round_robin: moi nhom nhan cac bai xoay vong, khong trung bai trong cung nhom
  const perTarget = Math.max(1, Math.ceil(posts.length / targets.length));
  for (let ti = 0; ti < targets.length; ti += 1) {
    const t = targets[ti];
    for (let k = 0; k < perTarget; k += 1) {
      const p = posts[(ti + k * targets.length) % posts.length];
      pairs.push({ account_id: t.account_id, target_id: t.id, post_id: p.id });
    }
  }
  // Bo trung (cung nhom + cung bai)
  const seen = new Set();
  return pairs.filter((p) => {
    const key = `${p.target_id}:${p.post_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/* Danh sach / chi tiet                                                       */
/* -------------------------------------------------------------------------- */

router.get(
  '/jobs',
  h(async (req, res) => {
    const status = req.query.status;
    const projectId = toInt(req.query.projectId);
    const where = [];
    const params = [];
    if (status && status !== 'all') {
      where.push('j.status = ?');
      params.push(status);
    }
    if (projectId) {
      where.push('j.project_id = ?');
      params.push(projectId);
    }
    const limit = Math.min(200, toInt(req.query.limit, 50));

    const rows = all(
      `SELECT j.*, p.name AS project_name
         FROM jobs j LEFT JOIN projects p ON p.id = j.project_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY j.id DESC LIMIT ?`,
      ...params,
      limit,
    );
    res.json({
      jobs: rows,
      strategies: STRATEGIES,
      summary: get(`
        SELECT
          COALESCE(SUM(status IN ('pending','running')),0) AS active_items,
          COALESCE(SUM(status='failed'),0) AS failed_items
        FROM job_items
      `),
    });
  }),
);

router.get(
  '/jobs/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw notFound('Khong tim thay chien dich');
    const counts = get(
      `SELECT
         COALESCE(SUM(status='pending'),0)  AS pending,
         COALESCE(SUM(status='running'),0)  AS running,
         COALESCE(SUM(status='success'),0)  AS success,
         COALESCE(SUM(status='failed'),0)   AS failed,
         COALESCE(SUM(status='skipped'),0)  AS skipped,
         COALESCE(SUM(status='canceled'),0) AS canceled
       FROM job_items WHERE job_id = ?`,
      id,
    );
    res.json({ job, counts });
  }),
);

router.get(
  '/jobs/:id/items',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM jobs WHERE id = ?', id)) throw notFound('Khong tim thay chien dich');
    const status = req.query.status;
    const limit = Math.min(500, toInt(req.query.limit, 100));
    const offset = Math.max(0, toInt(req.query.offset, 0));

    const where = ['i.job_id = ?'];
    const params = [id];
    if (status && status !== 'all') {
      where.push('i.status = ?');
      params.push(status);
    }

    const items = all(
      `SELECT i.*,
              p.title AS post_title, substr(p.caption, 1, 120) AS post_excerpt,
              t.name AS target_name, t.kind AS target_kind,
              a.label AS account_label, a.platform
         FROM job_items i
         JOIN posts p    ON p.id = i.post_id
         JOIN targets t  ON t.id = i.target_id
         JOIN accounts a ON a.id = i.account_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.run_at ASC, i.id ASC
        LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );

    const total = get(
      `SELECT COUNT(*) AS c FROM job_items i WHERE ${where.join(' AND ')}`,
      ...params,
    ).c;

    res.json({ items, total, limit, offset });
  }),
);

/* -------------------------------------------------------------------------- */
/* Dieu khien chien dich                                                      */
/* -------------------------------------------------------------------------- */

router.post(
  '/jobs/:id/pause',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw notFound('Khong tim thay chien dich');
    run(`UPDATE jobs SET status = 'paused' WHERE id = ?`, id);
    log.info(`Tam dung chien dich #${id}`);
    res.json({ job: get('SELECT * FROM jobs WHERE id = ?', id) });
  }),
);

router.post(
  '/jobs/:id/resume',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw notFound('Khong tim thay chien dich');
    if (job.status === 'done' || job.status === 'canceled') {
      throw badRequest('Chien dich da ket thuc, khong the tiep tuc');
    }
    run(
      `UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ?`,
      nowIso(),
      id,
    );
    refreshJob(id);
    log.info(`Tiep tuc chien dich #${id}`);
    res.json({ job: get('SELECT * FROM jobs WHERE id = ?', id) });
  }),
);

router.post(
  '/jobs/:id/cancel',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM jobs WHERE id = ?', id)) throw notFound('Khong tim thay chien dich');
    const canceled = run(
      `UPDATE job_items SET status='canceled', finished_at=? WHERE job_id = ? AND status IN ('pending','running')`,
      nowIso(),
      id,
    );
    run(`UPDATE jobs SET status='canceled', finished_at=? WHERE id = ?`, nowIso(), id);
    refreshJob(id);
    log.warn(`Huy chien dich #${id} (${canceled.changes} luot dang bi huy)`);
    res.json({ ok: true, canceled: canceled.changes });
  }),
);

/** Day cac luot dang con lai cua chien dich chay ngay lap tuc. */
router.post(
  '/jobs/:id/run-now',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw notFound('Khong tim thay chien dich');
    const moved = tx(() => {
      const r = run(
        `UPDATE job_items SET run_at = ? WHERE job_id = ? AND status = 'pending'`,
        nowIso(),
        id,
      );
      run(
        `UPDATE jobs SET status='running', scheduled_at=?, started_at=COALESCE(started_at, ?) WHERE id=?`,
        nowIso(),
        nowIso(),
        id,
      );
      return r.changes;
    });
    refreshJob(id);
    log.info(`Chay ngay chien dich #${id} (${moved} luot dang)`);
    res.json({ ok: true, moved });
  }),
);

/** Thu lai toan bo cac luot dang that bai. */
router.post(
  '/jobs/:id/retry-failed',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const job = get('SELECT * FROM jobs WHERE id = ?', id);
    if (!job) throw notFound('Khong tim thay chien dich');
    const retried = run(
      `UPDATE job_items SET status='pending', attempts=0, error='', finished_at=NULL, run_at=?
        WHERE job_id = ? AND status = 'failed'`,
      nowIso(),
      id,
    );
    run(`UPDATE jobs SET status='running', finished_at=NULL WHERE id = ?`, id);
    refreshJob(id);
    log.info(`Thu lai ${retried.changes} luot dang that bai cua chien dich #${id}`);
    res.json({ ok: true, retried: retried.changes });
  }),
);

router.delete(
  '/jobs/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM jobs WHERE id = ?', id)) throw notFound('Khong tim thay chien dich');
    run('DELETE FROM jobs WHERE id = ?', id);
    res.json({ ok: true });
  }),
);

/* -------------------------------------------------------------------------- */
/* Du doan so luot dang truoc khi tao                                         */
/* -------------------------------------------------------------------------- */

router.post(
  '/jobs/preview',
  h(async (req, res) => {
    const body = req.body ?? {};
    const projectId = toInt(body.projectId);
    const postCount = Array.isArray(body.postIds) && body.postIds.length
      ? body.postIds.length
      : get(
          `SELECT COUNT(*) AS c FROM posts ${projectId ? 'WHERE project_id = ?' : ''}`,
          ...(projectId ? [projectId] : []),
        ).c;

    let targetCount;
    if (Array.isArray(body.targetIds) && body.targetIds.length) {
      targetCount = body.targetIds.length;
    } else {
      const where = ['t.enabled = 1', 'a.enabled = 1'];
      const params = [];
      if (projectId) {
        where.push('t.project_id = ?');
        params.push(projectId);
      }
      if (toInt(body.accountId)) {
        where.push('t.account_id = ?');
        params.push(toInt(body.accountId));
      }
      targetCount = get(
        `SELECT COUNT(*) AS c FROM targets t JOIN accounts a ON a.id = t.account_id WHERE ${where.join(' AND ')}`,
        ...params,
      ).c;
    }

    const strategy = String(body.strategy ?? 'cross');
    const items =
      strategy === 'cross'
        ? postCount * targetCount
        : strategy === 'zip'
          ? Math.min(postCount, targetCount)
          : Math.min(postCount, targetCount) * Math.max(1, Math.ceil(postCount / Math.max(1, targetCount)));

    res.json({ postCount, targetCount, strategy, items });
  }),
);

/* -------------------------------------------------------------------------- */
/* Bao cao                                                                    */
/* -------------------------------------------------------------------------- */

router.get(
  '/reports/summary',
  h(async (req, res) => {
    const days = Math.min(180, Math.max(1, toInt(req.query.days, 30)));
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const overall = get(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(status='success'),0) AS success,
         COALESCE(SUM(status='failed'),0)  AS failed,
         COALESCE(SUM(status='skipped'),0) AS skipped,
         COALESCE(SUM(status IN ('pending','running')),0) AS pending
       FROM job_items WHERE COALESCE(finished_at, started_at, run_at) >= ?`,
      since,
    );

    const byDay = all(
      `SELECT substr(COALESCE(finished_at, started_at), 1, 10) AS day,
              COALESCE(SUM(status='success'),0) AS success,
              COALESCE(SUM(status='failed'),0)  AS failed
         FROM job_items
        WHERE COALESCE(finished_at, started_at) >= ?
        GROUP BY day ORDER BY day ASC`,
      since,
    );

    const byPlatform = all(
      `SELECT a.platform,
              COUNT(*) AS total,
              COALESCE(SUM(i.status='success'),0) AS success,
              COALESCE(SUM(i.status='failed'),0)  AS failed
         FROM job_items i JOIN accounts a ON a.id = i.account_id
        WHERE i.finished_at >= ?
        GROUP BY a.platform ORDER BY total DESC`,
      since,
    );

    const byAccount = all(
      `SELECT a.id, a.label, a.platform,
              COUNT(*) AS total,
              COALESCE(SUM(i.status='success'),0) AS success,
              COALESCE(SUM(i.status='failed'),0)  AS failed
         FROM job_items i JOIN accounts a ON a.id = i.account_id
        WHERE i.finished_at >= ?
        GROUP BY a.id ORDER BY total DESC`,
      since,
    );

    const byJob = all(
      `SELECT j.id, j.name, j.status, j.dry_run, j.scheduled_at, j.finished_at,
              j.total, j.success_count, j.failed_count, j.skipped_count
         FROM jobs j
        WHERE j.created_at >= ?
        ORDER BY j.id DESC LIMIT 50`,
      since,
    );

    const topErrors = all(
      `SELECT substr(error, 1, 160) AS error, COUNT(*) AS count
         FROM job_items
        WHERE status = 'failed' AND error <> '' AND finished_at >= ?
        GROUP BY substr(error, 1, 160)
        ORDER BY count DESC LIMIT 15`,
      since,
    );

    res.json({ days, since, overall, byDay, byPlatform, byAccount, byJob, topErrors });
  }),
);

/* -------------------------------------------------------------------------- */
/* Projects (nhom chien dich theo du an)                                      */
/* -------------------------------------------------------------------------- */

router.get('/projects', (_req, res) => {
  res.json({
    projects: all(`
      SELECT p.*,
             (SELECT COUNT(*) FROM accounts a WHERE a.project_id = p.id) AS accounts,
             (SELECT COUNT(*) FROM targets t WHERE t.project_id = p.id)  AS targets,
             (SELECT COUNT(*) FROM posts ps WHERE ps.project_id = p.id)  AS posts,
             (SELECT COUNT(*) FROM jobs j WHERE j.project_id = p.id)     AS jobs
        FROM projects p ORDER BY p.id
    `),
  });
});

router.post(
  '/projects',
  h(async (req, res) => {
    requireFields(req.body, ['name']);
    const name = String(req.body.name).trim();
    if (get('SELECT id FROM projects WHERE name = ?', name)) throw badRequest('Ten du an da ton tai');
    const id = insert('projects', {
      name,
      description: String(req.body.description ?? ''),
      color: String(req.body.color ?? '#4f8cff'),
      created_at: nowIso(),
    });
    res.status(201).json({ project: get('SELECT * FROM projects WHERE id = ?', id) });
  }),
);

router.delete(
  '/projects/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM projects WHERE id = ?', id)) throw notFound('Khong tim thay du an');
    run('DELETE FROM projects WHERE id = ?', id);
    res.json({ ok: true });
  }),
);

export default router;
