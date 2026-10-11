import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { parseJson } from '../db.js';
import { getPlatform } from '../platforms/index.js';
import { getContext } from './browser.js';
import { buildContext, runFlow, detectBlocker, resolveStartUrl } from './flow.js';

const log = createLogger('runner');

class TimeoutError extends Error {}
class BlockerError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${label} qua thoi gian (${Math.round(ms / 1000)}s)`)), ms);
    }),
  ]);
}

async function saveScreenshot(page, itemId) {
  try {
    fs.mkdirSync(config.paths.screenshots, { recursive: true });
    const name = `item-${itemId}-${Date.now()}.png`;
    const full = path.join(config.paths.screenshots, name);
    await page.screenshot({ path: full, fullPage: false });
    return name;
  } catch (err) {
    log.warn(`Khong chup duoc screenshot: ${err.message}`);
    return '';
  }
}

/**
 * Thuc thi mot luot dang bai.
 *
 * @param {object} args
 * @param {object} args.account  row tu bang accounts
 * @param {object} args.target   row tu bang targets
 * @param {object} args.post     row tu bang posts
 * @param {object} [args.job]
 * @param {boolean} [args.dryRun]
 * @returns {Promise<{remoteUrl:string, trace:string[]}>}
 */
export async function runItem({ account, target, post, job = null, dryRun = false }) {
  const platform = getPlatform(account.platform);
  const kind = target.kind && platform.flows[target.kind] ? target.kind : Object.keys(platform.flows)[0];
  const flow = platform.flows[kind];
  if (!flow) throw new Error(`Nen tang ${platform.id} khong ho tro dang len "${target.kind}"`);

  const media = parseJson(post.media, []);
  const ctx = buildContext({ account, target, post, job, media });

  // Cho phep nen tang chuan hoa noi dung (cat bot, doi format...)
  if (typeof platform.prepare === 'function') {
    Object.assign(ctx, platform.prepare(ctx) ?? {});
  }

  const startUrl = resolveStartUrl(flow, target, ctx, platform.homeUrl);

  const context = await getContext(account, { headless: config.browser.headless, mode: 'job' });
  const page = await context.newPage();
  page.setDefaultTimeout(config.browser.stepTimeoutMs);

  const trace = [];
  const onStep = ({ index, action, detail }) => {
    const line = `#${index} ${action}${detail ? ` -> ${String(detail).slice(0, 120)}` : ''}`;
    trace.push(line);
    if (trace.length > 60) trace.shift();
    log.debug(line, { accountId: account.id, jobId: job?.id ?? null, itemId: null });
  };

  log.info(
    `${dryRun ? '[THU] ' : ''}Dang bai #${post.id} len ${platform.name}/${kind} "${target.name}" bang ${account.label}`,
    { accountId: account.id },
  );

  try {
    const { skippedSubmit } = await withTimeout(
      runFlow(page, flow.steps, ctx, {
        dryRun,
        onStep,
        timeout: config.browser.stepTimeoutMs,
      }),
      config.browser.itemTimeoutMs,
      `Dang bai #${post.id} -> ${target.name}`,
    );

    const blocker = await detectBlocker(page, platform.blockers ?? []);
    if (blocker) throw new BlockerError(blocker);

    await page.waitForTimeout(1200);
    return { remoteUrl: page.url(), trace, dryRun, skippedSubmit };
  } catch (err) {
    const shot = await saveScreenshot(page, post.id);
    const suffix = shot ? ` [anh loi: ${shot}]` : '';
    if (err instanceof TimeoutError) {
      err.message += suffix;
      throw err;
    }
    if (err instanceof BlockerError) {
      err.message = `${err.message}${suffix}`;
      err.kind = err.kind;
      throw err;
    }
    err.message = `${err.message}${suffix}`;
    err.trace = trace.slice(-10);
    throw err;
  } finally {
    await page.close().catch(() => {});
  }
}

export { TimeoutError, BlockerError };
export default { runItem };
