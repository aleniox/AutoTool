import express from 'express';
import fs from 'node:fs';
import { all, get, run, insert, update, nowIso, parseJson, getSetting } from '../../db.js';
import config from '../../config.js';
import { h, requireFields, toInt, badRequest, notFound } from '../http.js';
import { getPlatform, hasPlatform, parseTargetUrl, kindLabel } from '../../platforms/index.js';
import { openLoginWindow, probeSession, closeAccount, profileDirFor, isOpen } from '../../core/browser.js';
import { createLogger } from '../../logger.js';

const router = express.Router();
const log = createLogger('api:accounts');

/* -------------------------------------------------------------------------- */
/* Accounts                                                                   */
/* -------------------------------------------------------------------------- */

router.get(
  '/accounts',
  h(async (req, res) => {
    const projectId = toInt(req.query.projectId);
    const where = projectId ? 'WHERE a.project_id = ?' : '';
    const params = projectId ? [projectId] : [];

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const rows = all(
      `SELECT a.*,
              p.name AS project_name,
              (SELECT COUNT(*) FROM targets t WHERE t.account_id = a.id) AS target_count,
              (SELECT COUNT(*) FROM targets t WHERE t.account_id = a.id AND t.enabled = 1) AS enabled_target_count,
              (SELECT COUNT(*) FROM job_items i
                WHERE i.account_id = a.id AND i.status = 'success' AND i.finished_at >= ?) AS posted_today
         FROM accounts a
         LEFT JOIN projects p ON p.id = a.project_id
         ${where}
        ORDER BY a.id DESC`,
      today.toISOString(),
      ...params,
    );

    res.json({
      accounts: rows.map((r) => ({
        ...r,
        meta: parseJson(r.meta, {}),
        browserOpen: isOpen(r.id),
        platformName: hasPlatform(r.platform) ? getPlatform(r.platform).name : r.platform,
        platformColor: hasPlatform(r.platform) ? getPlatform(r.platform).color : '#888',
      })),
    });
  }),
);

router.post(
  '/accounts',
  h(async (req, res) => {
    requireFields(req.body, ['platform', 'label']);
    const platformId = String(req.body.platform).toLowerCase();
    if (!hasPlatform(platformId)) throw badRequest(`Nen tang khong duoc ho tro: ${platformId}`);
    const platform = getPlatform(platformId);

    const label = String(req.body.label).trim();
    if (!label) throw badRequest('Nhan tai khoan khong duoc de trong');

    const dupe = get('SELECT id FROM accounts WHERE platform = ? AND label = ?', platformId, label);
    if (dupe) throw badRequest(`Da ton tai tai khoan "${label}" tren ${platform.name}`);

    const settings = getSetting('settings', {}) ?? {};
    const id = insert('accounts', {
      project_id: toInt(req.body.projectId),
      platform: platformId,
      label,
      profile_dir: '',
      status: 'new',
      status_message: 'Chua dang nhap',
      daily_limit: toInt(req.body.dailyLimit, settings.defaultDailyLimit ?? config.worker.defaultDailyLimit),
      min_delay_sec: toInt(req.body.minDelaySec, settings.defaultMinDelaySec ?? config.worker.defaultMinDelaySec),
      max_delay_sec: toInt(req.body.maxDelaySec, settings.defaultMaxDelaySec ?? config.worker.defaultMaxDelaySec),
      enabled: req.body.enabled === false ? 0 : 1,
      meta: JSON.stringify(req.body.meta ?? {}),
      created_at: nowIso(),
    });

    const account = get('SELECT * FROM accounts WHERE id = ?', id);
    run('UPDATE accounts SET profile_dir = ? WHERE id = ?', profileDirFor(account), id);

    // Nen tang chi co trang ca nhan -> tao san 1 target mac dinh
    let createdTarget = null;
    if (!(platform.targetKinds ?? []).length) {
      const tid = insert('targets', {
        project_id: toInt(req.body.projectId),
        account_id: id,
        platform: platformId,
        kind: 'profile',
        external_id: '',
        name: label,
        url: platform.homeUrl,
        enabled: 1,
        meta: '{}',
        created_at: nowIso(),
      });
      createdTarget = get('SELECT * FROM targets WHERE id = ?', tid);
    }

    log.info(`Tao tai khoan #${id} ${platform.name}/${label}`);
    res.status(201).json({
      account: get('SELECT * FROM accounts WHERE id = ?', id),
      target: createdTarget,
    });
  }),
);

router.patch(
  '/accounts/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const account = get('SELECT * FROM accounts WHERE id = ?', id);
    if (!account) throw notFound('Khong tim thay tai khoan');

    const patch = {};
    if (req.body.label !== undefined) {
      const label = String(req.body.label).trim();
      if (!label) throw badRequest('Nhan tai khoan khong duoc de trong');
      const dupe = get(
        'SELECT id FROM accounts WHERE platform = ? AND label = ? AND id <> ?',
        account.platform,
        label,
        id,
      );
      if (dupe) throw badRequest(`Da ton tai tai khoan "${label}"`);
      patch.label = label;
    }
    if (req.body.projectId !== undefined) patch.project_id = toInt(req.body.projectId);
    if (req.body.dailyLimit !== undefined) patch.daily_limit = Math.max(0, toInt(req.body.dailyLimit, 0));
    if (req.body.minDelaySec !== undefined) patch.min_delay_sec = Math.max(0, toInt(req.body.minDelaySec, 0));
    if (req.body.maxDelaySec !== undefined) patch.max_delay_sec = Math.max(0, toInt(req.body.maxDelaySec, 0));
    if (req.body.enabled !== undefined) patch.enabled = req.body.enabled ? 1 : 0;
    if (req.body.meta !== undefined) patch.meta = JSON.stringify(req.body.meta ?? {});

    if (patch.min_delay_sec !== undefined && patch.max_delay_sec !== undefined && patch.max_delay_sec < patch.min_delay_sec) {
      throw badRequest('maxDelaySec phai lon hon hoac bang minDelaySec');
    }

    if (Object.keys(patch).length) update('accounts', id, patch);
    res.json({ account: get('SELECT * FROM accounts WHERE id = ?', id) });
  }),
);

router.delete(
  '/accounts/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const account = get('SELECT * FROM accounts WHERE id = ?', id);
    if (!account) throw notFound('Khong tim thay tai khoan');

    await closeAccount(id);
    run('DELETE FROM accounts WHERE id = ?', id);

    // Xoa luon profile trinh duyet: no chua phien dang nhap, de lai la ro ri bao mat.
    // Tren Windows, trinh duyet co the con giu file them vai tram ms sau khi dong -> thu lai.
    let profileRemoved = false;
    const dir = account.profile_dir || profileDirFor(account);
    if (dir && dir.startsWith(config.paths.profiles) && fs.existsSync(dir)) {
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 });
          profileRemoved = true;
          break;
        } catch (err) {
          if (attempt === 5) {
            log.warn(
              `Da xoa tai khoan #${id} nhung khong xoa duoc profile ${dir}: ${err.message}. ` +
                'Hay dong trinh duyet cua tai khoan nay roi xoa thu cong.',
            );
          } else {
            await new Promise((r) => setTimeout(r, 250 * attempt));
          }
        }
      }
    }

    log.info(`Xoa tai khoan #${id}${profileRemoved ? ' (kem profile trinh duyet)' : ''}`);
    res.json({ ok: true, profileRemoved });
  }),
);

/**
 * Mo cua so trinh duyet de dang nhap thu cong.
 * Tool KHONG BAO GIO luu mat khau - chi luu profile da dang nhap.
 */
router.post(
  '/accounts/:id/login',
  h(async (req, res) => {
    if (!config.allowLoginWindow) throw badRequest('Chuc nang mo cua so dang nhap dang bi tat (ALLOW_LOGIN_WINDOW=false)');
    const id = toInt(req.params.id);
    const account = get('SELECT * FROM accounts WHERE id = ?', id);
    if (!account) throw notFound('Khong tim thay tai khoan');
    const platform = getPlatform(account.platform);

    run(
      `UPDATE accounts SET status = 'pending_login', status_message = ?, last_check_at = ? WHERE id = ?`,
      'Dang cho dang nhap trong cua so trinh duyet...',
      nowIso(),
      id,
    );

    // Khong await: cua so mo lai va giu mo cho nguoi dung thao tac.
    openLoginWindow(account, { url: platform.loginUrl })
      .then((r) => {
        run(
          `UPDATE accounts SET status = 'awaiting_login', status_message = ? WHERE id = ?`,
          r.reused ? 'Cua so dang nhap da mo (dung lai)' : 'Da mo cua so dang nhap. Hay dang nhap roi bam "Kiem tra phien".',
          id,
        );
      })
      .catch((err) => {
        run(`UPDATE accounts SET status = 'error', status_message = ? WHERE id = ?`, err.message, id);
        log.error(`Khong mo duoc cua so dang nhap: ${err.message}`);
      });

    res.status(202).json({
      ok: true,
      message: `Dang mo trinh duyet toi ${platform.loginUrl}. Hay dang nhap trong cua so vua mo, roi bam "Kiem tra phien".`,
      loginUrl: platform.loginUrl,
    });
  }),
);

router.post(
  '/accounts/:id/check',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    const account = get('SELECT * FROM accounts WHERE id = ?', id);
    if (!account) throw notFound('Khong tim thay tai khoan');
    const platform = getPlatform(account.platform);

    const result = await probeSession(account, platform);
    const status = result.status === 'logged_out' ? 'expired' : result.status;
    run(
      `UPDATE accounts SET status = ?, status_message = ?, last_check_at = ? WHERE id = ?`,
      status,
      result.message,
      nowIso(),
      id,
    );
    log.info(`Kiem tra phien ${account.label}: ${result.status} - ${result.message}`);
    res.json({ result, account: get('SELECT * FROM accounts WHERE id = ?', id) });
  }),
);

router.post(
  '/accounts/:id/close',
  h(async (req, res) => {
    const closed = await closeAccount(toInt(req.params.id));
    res.json({ ok: true, closed });
  }),
);

/* -------------------------------------------------------------------------- */
/* Targets (nhom / trang / kenh)                                              */
/* -------------------------------------------------------------------------- */

router.get(
  '/targets',
  h(async (req, res) => {
    const accountId = toInt(req.query.accountId);
    const projectId = toInt(req.query.projectId);
    const kind = req.query.kind;

    const where = [];
    const params = [];
    if (accountId) {
      where.push('t.account_id = ?');
      params.push(accountId);
    }
    if (projectId) {
      where.push('t.project_id = ?');
      params.push(projectId);
    }
    if (kind && kind !== 'all') {
      where.push('t.kind = ?');
      params.push(kind);
    }

    const rows = all(
      `SELECT t.*, a.label AS account_label, a.platform AS account_platform, a.status AS account_status
         FROM targets t
         JOIN accounts a ON a.id = t.account_id
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY t.account_id, t.name COLLATE NOCASE`,
      ...params,
    );

    res.json({
      targets: rows.map((t) => ({
        ...t,
        meta: parseJson(t.meta, {}),
        kindLabel: kindLabel(t.kind),
      })),
    });
  }),
);

router.post(
  '/targets',
  h(async (req, res) => {
    requireFields(req.body, ['accountId', 'name']);
    const account = get('SELECT * FROM accounts WHERE id = ?', toInt(req.body.accountId));
    if (!account) throw notFound('Khong tim thay tai khoan');

    const url = String(req.body.url ?? '').trim();
    const parsed = url ? parseTargetUrl(url, { platformHint: account.platform }) : null;

    const id = insert('targets', {
      project_id: toInt(req.body.projectId, account.project_id),
      account_id: account.id,
      platform: account.platform,
      kind: String(req.body.kind || parsed?.kind || 'group'),
      external_id: String(req.body.externalId || parsed?.externalId || ''),
      name: String(req.body.name).trim(),
      url,
      enabled: req.body.enabled === false ? 0 : 1,
      meta: JSON.stringify(req.body.meta ?? {}),
      created_at: nowIso(),
    });

    res.status(201).json({ target: get('SELECT * FROM targets WHERE id = ?', id), parsed });
  }),
);

/**
 * Import hang loat tu text. Moi dong mot nhom, ho tro:
 *   https://facebook.com/groups/123
 *   https://facebook.com/groups/123 | Ten nhom
 *   Ten nhom | https://facebook.com/groups/123
 */
router.post(
  '/targets/import',
  h(async (req, res) => {
    requireFields(req.body, ['accountId', 'text']);
    const account = get('SELECT * FROM accounts WHERE id = ?', toInt(req.body.accountId));
    if (!account) throw notFound('Khong tim thay tai khoan');

    const projectId = toInt(req.body.projectId, account.project_id);
    const kindOverride = req.body.kind && req.body.kind !== 'auto' ? String(req.body.kind) : null;

    const lines = String(req.body.text)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));

    const imported = [];
    const skipped = [];

    for (const line of lines) {
      const parts = line.split('|').map((p) => p.trim());
      let url = parts.find((p) => /^https?:\/\//i.test(p) || /^@[\w]+$/.test(p)) ?? '';
      let name = parts.find((p) => p !== url) ?? '';

      if (!url && parts.length === 1) {
        // Cho phep dong chi co ten (vd Telegram tim theo ten)
        name = parts[0];
      }

      const parsed = url ? parseTargetUrl(url, { platformHint: account.platform }) : null;
      if (url && !parsed) {
        skipped.push({ line, reason: 'Khong nhan dang duoc URL cho nen tang nay' });
        continue;
      }
      if (!url && !name) {
        skipped.push({ line, reason: 'Dong trong' });
        continue;
      }

      const finalUrl = url || `local:${account.platform}:${name}`;
      if (get('SELECT id FROM targets WHERE account_id = ? AND url = ?', account.id, finalUrl)) {
        skipped.push({ line, reason: 'Da ton tai' });
        continue;
      }

      const id = insert('targets', {
        project_id: projectId,
        account_id: account.id,
        platform: account.platform,
        kind: kindOverride || parsed?.kind || 'group',
        external_id: parsed?.externalId || '',
        name: name || parsed?.externalId || url,
        url: finalUrl,
        enabled: 1,
        meta: '{}',
        created_at: nowIso(),
      });
      imported.push(get('SELECT * FROM targets WHERE id = ?', id));
    }

    log.info(`Import ${imported.length} nhom vao tai khoan ${account.label} (bo qua ${skipped.length})`);
    res.json({ imported, skipped, total: lines.length });
  }),
);

router.patch(
  '/targets/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM targets WHERE id = ?', id)) throw notFound('Khong tim thay nhom');

    const patch = {};
    if (req.body.name !== undefined) patch.name = String(req.body.name).trim();
    if (req.body.kind !== undefined) patch.kind = String(req.body.kind);
    if (req.body.url !== undefined) patch.url = String(req.body.url).trim();
    if (req.body.externalId !== undefined) patch.external_id = String(req.body.externalId);
    if (req.body.projectId !== undefined) patch.project_id = toInt(req.body.projectId);
    if (req.body.enabled !== undefined) patch.enabled = req.body.enabled ? 1 : 0;
    if (req.body.meta !== undefined) patch.meta = JSON.stringify(req.body.meta ?? {});

    if (Object.keys(patch).length) update('targets', id, patch);
    res.json({ target: get('SELECT * FROM targets WHERE id = ?', id) });
  }),
);

router.delete(
  '/targets/:id',
  h(async (req, res) => {
    const id = toInt(req.params.id);
    if (!get('SELECT id FROM targets WHERE id = ?', id)) throw notFound('Khong tim thay nhom');
    run('DELETE FROM targets WHERE id = ?', id);
    res.json({ ok: true });
  }),
);

router.post(
  '/targets/delete-bulk',
  h(async (req, res) => {
    const ids = (req.body?.ids ?? []).map((i) => toInt(i)).filter(Boolean);
    if (!ids.length) throw badRequest('Chua chon nhom nao');
    const placeholders = ids.map(() => '?').join(',');
    const result = run(`DELETE FROM targets WHERE id IN (${placeholders})`, ...ids);
    res.json({ ok: true, deleted: result.changes });
  }),
);

export default router;
