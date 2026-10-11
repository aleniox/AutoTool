import asyncio
import os
import re
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Union
from backend.core.locator import find_visible, find_attached, require_visible, any_visible, sleep, describe

def lookup_path(obj: Any, dotted: str) -> Any:
    cleaned = re.sub(r'\[(\d+)\]', r'.\1', str(dotted))
    parts = [p for p in cleaned.split('.') if p]
    cur = obj
    for p in parts:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(p)
        elif isinstance(cur, (list, tuple)):
            try:
                idx = int(p)
                cur = cur[idx] if 0 <= idx < len(cur) else None
            except ValueError:
                return None
        elif hasattr(cur, p):
            cur = getattr(cur, p)
        else:
            return None
    return cur

def resolve_value(value: Any, ctx: dict) -> Any:
    if callable(value):
        return value(ctx)
    if not isinstance(value, str):
        return value

    whole_match = re.match(r'^\s*\{\{\s*([\w.[\]]+)\s*\}\}\s*$', value)
    if whole_match:
        return lookup_path(ctx, whole_match.group(1))

    def _replace(match):
        v = lookup_path(ctx, match.group(1))
        return '' if v is None else str(v)

    return re.sub(r'\{\{\s*([\w.[\]]+)\s*\}\}', _replace, value)

def compose_text(post: dict, include_link: bool = True, include_hashtags: bool = True) -> str:
    chunks = []
    title = str(post.get('title') or '').strip()
    caption = str(post.get('caption') or '').strip()
    hashtags = str(post.get('hashtags') or '').strip()
    link = str(post.get('link') or '').strip()

    if title:
        chunks.append(title)
    if caption:
        chunks.append(caption)
    if include_hashtags and hashtags:
        chunks.append(hashtags)
    if include_link and link:
        chunks.append(link)
    return '\n\n'.join(chunks)

def build_context(account: dict, target: dict, post: dict, job: Optional[dict] = None, media: List[dict] = None, extra: dict = None) -> dict:
    media_list = []
    for m in (media or []):
        p = m.get('path') or ''
        abs_p = str(Path(p).resolve()) if p else ''
        name = m.get('name') or (Path(p).name if p else '')
        item = dict(m)
        item['path'] = p
        item['absolute'] = abs_p
        item['name'] = name
        media_list.append(item)

    ctx = {
        'account': dict(account),
        'target': dict(target),
        'post': {**dict(post), 'media': media_list},
        'job': dict(job) if job else None,
        'media': media_list,
        'text': compose_text(post),
        'mediaPaths': [m['absolute'] for m in media_list if m['absolute']],
        'imagePaths': [m['absolute'] for m in media_list if m.get('type') != 'video' and m['absolute']],
        'videoPaths': [m['absolute'] for m in media_list if m.get('type') == 'video' and m['absolute']],
        'now': datetime.now(),
    }
    if extra:
        ctx.update(extra)
    return ctx

def resolve_start_url(flow: Any, target: dict, ctx: dict, fallback: str = '') -> str:
    raw = None
    start_url_def = getattr(flow, 'start_url', None) or (flow.get('startUrl') if isinstance(flow, dict) else None)
    if callable(start_url_def):
        raw = start_url_def(target, ctx) if start_url_def.__code__.co_argcount > 1 else start_url_def(target)
    elif start_url_def:
        raw = start_url_def
    elif target and target.get('url'):
        raw = target.get('url')
    else:
        raw = fallback

    url = str(raw or '').strip()
    if not url:
        name = target.get('name', '?') if target else '?'
        raise RuntimeError(f"Flow khong xac dinh duoc URL xuat phat (startUrl). Kiem tra muc tieu '{name}'.")
    ctx['startUrl'] = url
    return url

async def run_flow(page: Any, steps: Any, ctx: dict, opts: dict = None) -> dict:
    opts = opts or {}
    dry_run = bool(opts.get('dryRun', False))
    on_step = opts.get('onStep', lambda info: None)
    timeout = opts.get('timeout', 20000)

    step_list = steps if isinstance(steps, list) else [steps]
    skipped_submit = 0

    for i, step in enumerate(step_list):
        if not step or not isinstance(step, dict):
            continue

        if dry_run and step.get('submit'):
            skipped_submit += 1
            on_step({'index': i, 'action': 'skip-submit', 'detail': _first_key(step)})
            continue

        action = _first_key(step)
        on_step({'index': i, 'action': action, 'detail': _describe_step(step)})
        await _exec_step(page, step, ctx, {'dryRun': dry_run, 'onStep': on_step, 'timeout': timeout, 'index': i})

    return {'skippedSubmit': skipped_submit}

def _first_key(step: dict) -> str:
    for k in step.keys():
        if k not in ('optional', 'timeout', 'submit', 'label', 'after'):
            return k
    return 'unknown'

def _describe_step(step: dict) -> str:
    k = _first_key(step)
    v = step.get(k)
    if isinstance(v, (str, int, float)):
        return str(v)
    if isinstance(v, list):
        return describe(v)
    if isinstance(v, dict):
        return describe(v.get('desc') or v.get('locator') or v.get('target') or v)
    return ''

async def _resolve_step_element(page: Any, desc: Any, ctx: dict, timeout: int, optional: bool, label: str, state: str = None) -> Optional[Any]:
    resolved_desc = desc(ctx) if callable(desc) else desc
    if state in ('detached', 'hidden'):
        deadline = time.time() + (timeout / 1000.0)
        while time.time() < deadline:
            if not (await any_visible(page, resolved_desc)):
                return None
            await sleep(300)
        if not optional:
            raise RuntimeError(f"{label}: phan tu khong bien mat: {describe(resolved_desc)}")
        return None

    if optional:
        loc = await find_visible(page, resolved_desc, timeout=timeout)
        if not loc:
            return None
        return loc
    return await require_visible(page, resolved_desc, timeout=timeout, label=label)

async def _fill_element(page: Any, loc: Any, value: Any, timeout: int):
    val_str = str(value or '')
    is_editable = False
    try:
        is_editable = await loc.evaluate("el => el.isContentEditable || el.getAttribute('contenteditable') === 'true'")
    except Exception:
        is_editable = False

    if not is_editable:
        await loc.fill(val_str, timeout=timeout)
        return

    try:
        await loc.scroll_into_view_if_needed()
    except Exception:
        pass
    try:
        await loc.click(timeout=timeout)
    except Exception:
        pass
    await sleep(150)

    try:
        await page.keyboard.press('Control+A')
        await page.keyboard.press('Delete')
    except Exception:
        pass
    await sleep(100)

    await page.keyboard.insert_text(val_str)
    await sleep(250)

    try:
        got = await loc.inner_text() or ''
        want = re.sub(r'\s+', ' ', val_str).strip()
        have = re.sub(r'\s+', ' ', got).strip()
        if want and want[:min(40, len(want))] not in have:
            await page.keyboard.press('Control+A')
            await page.keyboard.press('Delete')
            await page.keyboard.type(val_str, delay=20)
    except Exception:
        pass

async def _exec_step(page: Any, step: dict, ctx: dict, opts: dict):
    to = step.get('timeout') or opts.get('timeout') or 20000
    optional = bool(step.get('optional', False))

    if 'goto' in step:
        url = resolve_value(step['goto'], ctx)
        if not url or not re.match(r'^(https?|file|data|about):', str(url), re.I):
            raise ValueError(f"Buoc goto co URL khong hop le: {repr(url)}")
        wait_until = step.get('waitUntil', 'domcontentloaded')
        await page.goto(str(url), wait_until=wait_until, timeout=max(to, 45000))
        return

    if 'click' in step:
        loc = await _resolve_step_element(page, step['click'], ctx, timeout=to, optional=optional, label='click')
        if not loc:
            return
        try:
            await loc.scroll_into_view_if_needed()
        except Exception:
            pass
        try:
            await loc.click(timeout=to, force=bool(step.get('force', False)))
        except Exception as err:
            if optional:
                return
            try:
                await loc.evaluate("el => el.click()")
            except Exception:
                raise err
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'fill' in step:
        desc = step['fill'][0] if isinstance(step['fill'], list) else step['fill']
        value = resolve_value(step.get('value', ''), ctx)
        loc = await _resolve_step_element(page, desc, ctx, timeout=to, optional=optional, label='fill')
        if not loc:
            return
        await _fill_element(page, loc, value, timeout=to)
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'type' in step:
        value = resolve_value(step.get('value', ''), ctx)
        loc = await _resolve_step_element(page, step['type'], ctx, timeout=to, optional=optional, label='type')
        if not loc:
            return
        try:
            await loc.scroll_into_view_if_needed()
            await loc.click(timeout=to)
        except Exception:
            pass
        if step.get('clear') is not False:
            try:
                await page.keyboard.press('Control+A')
                await page.keyboard.press('Delete')
            except Exception:
                pass
        await page.keyboard.type(str(value), delay=step.get('delay', 25))
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'insertText' in step or 'insert_text' in step:
        key = 'insertText' if 'insertText' in step else 'insert_text'
        value = resolve_value(step.get('value', ''), ctx)
        loc = await _resolve_step_element(page, step[key], ctx, timeout=to, optional=optional, label='insertText')
        if not loc:
            return
        try:
            await loc.click(timeout=to)
        except Exception:
            pass
        await page.keyboard.insert_text(str(value))
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'press' in step:
        key_press = step['press']
        if 'on' in step:
            loc = await _resolve_step_element(page, step['on'], ctx, timeout=to, optional=optional, label='press')
            if not loc:
                return
            await loc.press(key_press, timeout=to)
        else:
            await page.keyboard.press(key_press)
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'upload' in step:
        files = resolve_value(step.get('files'), ctx)
        arr = [str(f) for f in (files if isinstance(files, list) else [files]) if f]
        if not arr:
            return
        loc = await find_attached(page, step['upload'], timeout=to)
        if not loc:
            if not optional:
                raise RuntimeError(f"upload: Khong tim thay phan tu file input: {describe(step['upload'])}")
            return
        await loc.set_input_files(arr, timeout=max(to, 60000))
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'waitFor' in step or 'wait_for' in step:
        key = 'waitFor' if 'waitFor' in step else 'wait_for'
        loc = await _resolve_step_element(page, step[key], ctx, timeout=to, optional=optional, label='waitFor', state=step.get('state'))
        if not loc:
            return
        if step.get('after'):
            await sleep(step['after'])
        return

    if 'waitForAny' in step or 'wait_for_any' in step:
        key = 'waitForAny' if 'waitForAny' in step else 'wait_for_any'
        deadline = time.time() + (to / 1000.0)
        cands = step[key]
        while True:
            for cand in cands:
                if await find_visible(page, cand, timeout=0):
                    return
            if time.time() > deadline:
                if not optional:
                    raise RuntimeError(f"waitForAny het thoi gian: {describe(cands)}")
                return
            await sleep(300)

    if 'waitForGone' in step or 'wait_for_gone' in step:
        key = 'waitForGone' if 'waitForGone' in step else 'wait_for_gone'
        deadline = time.time() + (to / 1000.0)
        target = step[key]
        while time.time() < deadline:
            if not (await any_visible(page, target)):
                return
            await sleep(300)
        if not optional:
            raise RuntimeError(f"Phan tu van con hien thi: {describe(target)}")
        return

    if 'waitForUrl' in step or 'wait_for_url' in step:
        key = 'waitForUrl' if 'waitForUrl' in step else 'wait_for_url'
        target_url = step[key]
        if isinstance(target_url, str):
            await page.wait_for_url(target_url, timeout=to)
        else:
            # Regex match
            await page.wait_for_url(re.compile(target_url.pattern if hasattr(target_url, 'pattern') else str(target_url)), timeout=to)
        return

    if 'wait' in step:
        await sleep(step['wait'])
        return

    if 'eval' in step:
        fn = step['eval']
        out = None
        if callable(fn):
            out = await fn(ctx, page) if asyncio.iscoroutinefunction(fn) else fn(ctx, page)
        if step.get('saveAs'):
            ctx[step['saveAs']] = out
        return

    if 'when' in step:
        cond_fn = step['when']
        is_true = False
        if callable(cond_fn):
            is_true = bool(await cond_fn(ctx, page) if asyncio.iscoroutinefunction(cond_fn) else cond_fn(ctx))
        branch = step.get('then') if is_true else step.get('else')
        if branch:
            await run_flow(page, branch, ctx, opts)
        return

    if 'ifFound' in step or 'if_found' in step:
        key = 'ifFound' if 'ifFound' in step else 'if_found'
        target_desc = step[key]
        use_attached = bool(step.get('attached')) or ('input[type="file"]' in str(target_desc)) or ('input' in str(target_desc) and 'file' in str(target_desc))
        if use_attached:
            found = await find_attached(page, target_desc, timeout=step.get('timeout', 5000))
        else:
            found = await find_visible(page, target_desc, timeout=step.get('timeout', 5000))
        branch = step.get('then') if found else step.get('else')
        if branch:
            await run_flow(page, branch, ctx, opts)
        return

    if 'retry' in step:
        retries = int(step['retry'])
        last_err = None
        for _ in range(retries):
            try:
                await run_flow(page, step.get('steps', []), ctx, opts)
                return
            except Exception as err:
                last_err = err
                await sleep(step.get('backoff', 1500))
        if last_err:
            raise last_err

    if 'assert' in step:
        assert_fn = step['assert']
        ok = False
        if callable(assert_fn):
            ok = bool(await assert_fn(ctx, page) if asyncio.iscoroutinefunction(assert_fn) else assert_fn(ctx))
        if not ok:
            raise RuntimeError(step.get('message', 'Dieu kien assert khong dung'))
        return

    if 'log' in step:
        opts['onStep']({
            'index': opts.get('index', 0),
            'action': 'log',
            'detail': resolve_value(step['log'], ctx),
        })
        return

    raise NotImplementedError(f"Buoc khong duoc ho tro: {list(step.keys())}")

async def detect_blocker(page: Any, blockers: List[dict] = None) -> Optional[str]:
    for b in (blockers or []):
        when = b.get('when')
        if when and (await any_visible(page, when)):
            return b.get('message') or describe(when)
    return None
