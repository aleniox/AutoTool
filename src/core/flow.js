import path from 'node:path';
import { findVisible, requireVisible, anyVisible, sleep, describe } from './locator.js';

/* -------------------------------------------------------------------------- */
/* Template / context                                                         */
/* -------------------------------------------------------------------------- */

export function lookupPath(obj, dotted) {
  const parts = String(dotted)
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** Gia tri co the la ham (ctx)=>value, hoac chuoi co {{placeholder}}. */
export function resolveValue(value, ctx) {
  if (typeof value === 'function') return value(ctx);
  if (typeof value !== 'string') return value;

  // Placeholder dung MOT MINH -> tra ve nguyen gia tri goc (giu duoc mang/so/object).
  // Vi du '{{imagePaths}}' phai la string[] chu khong phai "a,b,c".
  const whole = /^\s*\{\{\s*([\w.[\]]+)\s*\}\}\s*$/.exec(value);
  if (whole) return lookupPath(ctx, whole[1]);

  return value.replace(/\{\{\s*([\w.[\]]+)\s*\}\}/g, (_m, p) => {
    const v = lookupPath(ctx, p);
    return v === undefined || v === null ? '' : String(v);
  });
}

/** Noi caption + hashtags + link theo tuy chon cua tung bai. */
export function composeText(post, { includeLink = true, includeHashtags = true } = {}) {
  const chunks = [];
  if (post.title) chunks.push(String(post.title).trim());
  if (post.caption) chunks.push(String(post.caption).trim());
  if (includeHashtags && post.hashtags) chunks.push(String(post.hashtags).trim());
  if (includeLink && post.link) chunks.push(String(post.link).trim());
  return chunks.filter(Boolean).join('\n\n');
}

export function buildContext({ account, target, post, job, media = [], extra = {} }) {  const mediaList = media.map((m) => ({
    ...m,
    path: m.path,
    absolute: m.path ? path.resolve(m.path) : '',
    name: m.name || path.basename(m.path || ''),
  }));
  return {
    account: { ...account },
    target: { ...target },
    post: { ...post, media: mediaList },
    job: job ? { ...job } : null,
    media: mediaList,
    text: composeText(post),
    mediaPaths: mediaList.map((m) => m.absolute).filter(Boolean),
    imagePaths: mediaList.filter((m) => m.type !== 'video').map((m) => m.absolute),
    videoPaths: mediaList.filter((m) => m.type === 'video').map((m) => m.absolute),
    now: new Date(),
    ...extra,
  };
}

/**
 * Tinh URL xuat phat cua mot flow va gan vao ctx.startUrl de template
 * `{{startUrl}}` dung duoc. Dung chung cho runner va cho test.
 */
export function resolveStartUrl(flow, target, ctx, fallback = '') {
  const raw =
    typeof flow?.startUrl === 'function'
      ? flow.startUrl(target, ctx)
      : flow?.startUrl || target?.url || fallback;
  const url = String(raw ?? '').trim();
  if (!url) {
    throw new Error(
      `Flow khong xac dinh duoc URL xuat phat (startUrl). Kiem tra dinh nghia flow hoac URL cua muc tieu "${target?.name ?? '?'}".`,
    );
  }
  ctx.startUrl = url;
  return url;
}

/* -------------------------------------------------------------------------- */
/* Step executor                                                              */
/* -------------------------------------------------------------------------- */

const NOOP = () => {};

/**
 * Chay mot "flow" (mang cac buoc khai bao) tren mot Page.
 *
 * @param {import('playwright').Page} page
 * @param {Array|Object} steps
 * @param {object} ctx        bien de render template
 * @param {object} opts
 * @param {boolean} opts.dryRun   bo qua moi buoc co `submit: true`
 * @param {Function} opts.onStep  callback({ index, action, detail })
 * @param {number} opts.timeout   timeout mac dinh cho moi buoc
 */
export async function runFlow(page, steps, ctx, opts = {}) {
  const { dryRun = false, onStep = NOOP, timeout } = opts;
  const list = Array.isArray(steps) ? steps : [steps];
  let skippedSubmit = 0;

  for (let i = 0; i < list.length; i += 1) {
    const step = list[i];
    if (!step || typeof step !== 'object') continue;

    if (dryRun && step.submit) {
      skippedSubmit += 1;
      onStep({ index: i, action: 'skip-submit', detail: firstKey(step) });
      continue;
    }

    const action = firstKey(step);
    onStep({ index: i, action, detail: describeStep(step) });
    await execStep(page, step, ctx, { dryRun, onStep, timeout, index: i });
  }

  return { skippedSubmit };
}

function firstKey(step) {
  return Object.keys(step).find((k) => k !== 'optional' && k !== 'timeout' && k !== 'submit' && k !== 'label') ?? 'unknown';
}

function describeStep(step) {
  const k = firstKey(step);
  const v = step[k];
  if (typeof v === 'string' || typeof v === 'number') return v;
  if (Array.isArray(v)) return describe(v);
  if (v && typeof v === 'object') return describe(v.desc ?? v.locator ?? v.target ?? v);
  return '';
}

async function execStep(page, step, ctx, opts) {
  const to = step.timeout ?? opts.timeout ?? 20000;
  const optional = !!step.optional;

  if (step.goto !== undefined) {
    const url = resolveValue(step.goto, ctx);
    if (!url || !/^(https?|file|data|about):/i.test(String(url))) {
      throw new Error(
        `Buoc goto co URL khong hop le: ${JSON.stringify(url)}. ` +
          'Thuong do flow thieu startUrl hoac muc tieu chua co URL.',
      );
    }
    await page.goto(url, { waitUntil: step.waitUntil || 'domcontentloaded', timeout: Math.max(to, 45000) });
    return;
  }

  if (step.click !== undefined) {
    const loc = await resolve(page, step.click, ctx, { timeout: to, optional, label: 'click' });
    if (!loc) return;
    await loc.scrollIntoViewIfNeeded().catch(NOOP);
    await loc.click({ timeout: to, force: !!step.force }).catch(async (err) => {
      if (optional) return;
      // Nhieu nut bi overlay che -> thu click bang JS nhu phuong an cuoi.
      await loc.evaluate((el) => el.click()).catch(() => {
        throw err;
      });
    });
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.fill !== undefined) {
    const desc = Array.isArray(step.fill) ? step.fill[0] : step.fill;
    const value = resolveValue(step.value ?? '', ctx);
    const loc = await resolve(page, desc, ctx, { timeout: to, optional, label: 'fill' });
    if (!loc) return;
    await fillElement(page, loc, value, { timeout: to });
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.type !== undefined) {
    const value = resolveValue(step.value ?? '', ctx);
    const loc = await resolve(page, step.type, ctx, { timeout: to, optional, label: 'type' });
    if (!loc) return;
    await loc.scrollIntoViewIfNeeded().catch(NOOP);
    await loc.click({ timeout: to }).catch(NOOP);
    if (step.clear !== false) {
      await page.keyboard.press('Control+A').catch(NOOP);
      await page.keyboard.press('Delete').catch(NOOP);
    }
    await page.keyboard.type(value, { delay: step.delay ?? 25 });
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.insertText !== undefined) {
    const value = resolveValue(step.value ?? '', ctx);
    const loc = await resolve(page, step.insertText, ctx, { timeout: to, optional, label: 'insertText' });
    if (!loc) return;
    await loc.click({ timeout: to }).catch(NOOP);
    await page.keyboard.insertText(value);
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.press !== undefined) {
    if (step.on !== undefined) {
      const loc = await resolve(page, step.on, ctx, { timeout: to, optional, label: 'press' });
      if (!loc) return;
      await loc.press(step.press, { timeout: to });
    } else {
      await page.keyboard.press(step.press);
    }
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.upload !== undefined) {
    const files = resolveValue(step.files, ctx);
    const arr = (Array.isArray(files) ? files : [files]).filter(Boolean);
    if (!arr.length) return;
    const loc = await resolve(page, step.upload, ctx, { timeout: to, optional, label: 'upload' });
    if (!loc) return;
    await loc.setInputFiles(arr, { timeout: Math.max(to, 60000) });
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.waitFor !== undefined) {
    const loc = await resolve(page, step.waitFor, ctx, {
      timeout: to,
      optional,
      label: 'waitFor',
      state: step.state,
    });
    if (!loc) return;
    if (step.after) await sleep(step.after);
    return;
  }

  if (step.waitForAny !== undefined) {
    const deadline = Date.now() + to;
    for (;;) {
      for (const cand of step.waitForAny) {
        if (await findVisible(page, cand, { timeout: 0 })) return;
      }
      if (Date.now() > deadline) {
        if (!optional) throw new Error(`waitForAny het thoi gian: ${describe(step.waitForAny)}`);
        return;
      }
      await sleep(300);
    }
  }

  if (step.waitForGone !== undefined) {
    const deadline = Date.now() + to;
    while (Date.now() < deadline) {
      if (!(await anyVisible(page, step.waitForGone))) return;
      await sleep(300);
    }
    if (!optional) throw new Error(`Phan tu van con hien thi: ${describe(step.waitForGone)}`);
    return;
  }

  if (step.waitForUrl !== undefined) {
    await page.waitForURL(step.waitForUrl, { timeout: to });
    return;
  }

  if (step.wait !== undefined) {
    await sleep(step.wait);
    return;
  }

  if (step.eval !== undefined) {
    const fn = typeof step.eval === 'function' ? step.eval : new Function('ctx', 'page', `return (${step.eval});`);
    const out = await fn(ctx, page);
    if (step.saveAs) ctx[step.saveAs] = out;
    return;
  }

  if (step.when !== undefined) {
    const fn =
      typeof step.when === 'function' ? step.when : new Function('ctx', 'page', `return (${step.when});`);
    const branch = (await fn(ctx, page)) ? step.then : step.else;
    if (branch) await runFlow(page, branch, ctx, opts);
    return;
  }

  if (step.ifFound !== undefined) {
    const found = await findVisible(page, step.ifFound, { timeout: step.timeout ?? 5000 });
    const branch = found ? step.then : step.else;
    if (branch) await runFlow(page, branch, ctx, opts);
    return;
  }

  if (step.retry !== undefined) {
    let lastErr;
    for (let attempt = 1; attempt <= step.retry; attempt += 1) {
      try {
        await runFlow(page, step.steps, ctx, opts);
        return;
      } catch (err) {
        lastErr = err;
        await sleep(step.backoff ?? 1500);
      }
    }
    throw lastErr;
  }

  if (step.assert !== undefined) {
    const fn = typeof step.assert === 'function' ? step.assert : new Function('ctx', 'page', `return (${step.assert});`);
    const ok = await fn(ctx, page);
    if (!ok) throw new Error(step.message || 'Dieu kien assert khong dung');
    return;
  }

  if (step.log !== undefined) {
    opts.onStep({ index: opts.index, action: 'log', detail: resolveValue(step.log, ctx) });
    return;
  }

  throw new Error(`Buoc khong duoc ho tro: ${JSON.stringify(Object.keys(step))}`);
}

async function resolve(page, desc, ctx, { timeout, optional, label, state }) {
  const resolvedDesc = typeof desc === 'function' ? desc(ctx) : desc;
  if (state === 'detached' || state === 'hidden') {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (!(await anyVisible(page, resolvedDesc))) return null;
      await sleep(300);
    }
    if (!optional) throw new Error(`${label}: phan tu khong bien mat: ${describe(resolvedDesc)}`);
    return null;
  }
  if (optional) {
    const loc = await findVisible(page, resolvedDesc, { timeout });
    if (!loc && label !== 'waitFor') return null;
    if (!loc) return null;
    return loc;
  }
  return requireVisible(page, resolvedDesc, { timeout, label });
}

/** Dien text vao input/textarea hoac contenteditable (rich text editor). */
async function fillElement(page, loc, value, { timeout }) {
  const isEditable = await loc
    .evaluate((el) => el.isContentEditable || el.getAttribute('contenteditable') === 'true')
    .catch(() => false);

  if (!isEditable) {
    await loc.fill(value, { timeout });
    return;
  }

  await loc.scrollIntoViewIfNeeded().catch(NOOP);
  await loc.click({ timeout }).catch(NOOP);
  await sleep(150);

  // Xoa noi dung cu (nhieu editor la Draft.js/Slate khong ho tro fill()).
  await page.keyboard.press('Control+A').catch(NOOP);
  await page.keyboard.press('Delete').catch(NOOP);
  await sleep(100);

  // insertText ban ra su kien input that, an toan voi React/Draft.js.
  await page.keyboard.insertText(value);
  await sleep(250);

  const got = (await loc.innerText().catch(() => '')) || '';
  const want = String(value).replace(/\s+/g, ' ').trim();
  const have = got.replace(/\s+/g, ' ').trim();
  if (want && !have.includes(want.slice(0, Math.min(40, want.length)))) {
    // Fallback: go tung ky tu voi do tre nhu nguoi that.
    await page.keyboard.press('Control+A').catch(NOOP);
    await page.keyboard.press('Delete').catch(NOOP);
    await page.keyboard.type(String(value), { delay: 20 });
  }
}

/* -------------------------------------------------------------------------- */
/* Blocker detection                                                          */
/* -------------------------------------------------------------------------- */

export async function detectBlocker(page, blockers = []) {
  for (const b of blockers) {
    if (await anyVisible(page, b.when)) return b.message || describe(b.when);
  }
  return null;
}

export default { runFlow, buildContext, resolveValue, composeText, detectBlocker, lookupPath, resolveStartUrl };
