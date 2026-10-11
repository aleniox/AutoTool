import asyncio
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional
from backend.config import config
from backend.logger import create_logger
from backend.db import parse_json
from backend.platforms import get_platform
from backend.core.browser import get_context
from backend.core.flow import build_context, run_flow, detect_blocker, resolve_start_url

log = create_logger('runner')

class ItemTimeoutError(Exception):
    pass

class BlockerError(Exception):
    def __init__(self, message: str, kind: str = 'blocked'):
        super().__init__(message)
        self.kind = kind

async def save_screenshot(page: Any, item_id: Any) -> str:
    try:
        shot_dir = Path(config.paths['screenshots'])
        shot_dir.mkdir(parents=True, exist_ok=True)
        name = f"item-{item_id}-{int(time.time() * 1000)}.png"
        full = shot_dir / name
        await page.screenshot(path=str(full), full_page=False)
        return name
    except Exception as err:
        log.warn(f"Khong chup duoc screenshot: {err}")
        return ''

async def run_item(account: dict, target: dict, post: dict, job: Optional[dict] = None, dry_run: bool = False) -> dict:
    platform = get_platform(account['platform'])
    flows = platform.get('flows', {})
    kind = target.get('kind')
    if not kind or kind not in flows:
        kind = list(flows.keys())[0] if flows else None

    flow = flows.get(kind)
    if not flow:
        raise ValueError(f"Nen tang {platform['id']} khong ho tro dang len '{target.get('kind')}'")

    media = parse_json(post.get('media'), [])
    ctx = build_context(account=account, target=target, post=post, job=job, media=media)

    prepare_fn = platform.get('prepare')
    if callable(prepare_fn):
        prep_res = prepare_fn(ctx)
        if isinstance(prep_res, dict):
            ctx.update(prep_res)

    resolve_start_url(flow, target, ctx, fallback=platform.get('homeUrl', ''))

    context = await get_context(account, headless=config.browser.headless, mode='job')
    page = await context.new_page()
    page.set_default_timeout(config.browser.step_timeout_ms)

    trace: List[str] = []
    def on_step(info: dict):
        line = f"#{info.get('index')} {info.get('action')}"
        detail = info.get('detail')
        if detail:
            line += f" -> {str(detail)[:120]}"
        trace.append(line)
        if len(trace) > 60:
            trace.pop(0)
        log.debug(line, {'accountId': account.get('id'), 'jobId': job.get('id') if job else None, 'itemId': None})

    log.info(
        f"{'[THU] ' if dry_run else ''}Dang bai #{post.get('id')} len {platform['name']}/{kind} '{target.get('name')}' bang {account.get('label')}",
        {'accountId': account.get('id')}
    )

    try:
        flow_coro = run_flow(
            page,
            flow.get('steps', []),
            ctx,
            {
                'dryRun': dry_run,
                'onStep': on_step,
                'timeout': config.browser.step_timeout_ms,
            },
        )
        
        timeout_sec = config.browser.item_timeout_ms / 1000.0
        try:
            flow_res = await asyncio.wait_for(flow_coro, timeout=timeout_sec)
        except asyncio.TimeoutError:
            raise ItemTimeoutError(f"Dang bai #{post.get('id')} -> {target.get('name')} qua thoi gian ({int(timeout_sec)}s)")

        blocker = await detect_blocker(page, platform.get('blockers', []))
        if blocker:
            raise BlockerError(blocker)

        await page.wait_for_timeout(1200)
        return {
            'remoteUrl': page.url,
            'trace': trace,
            'dryRun': dry_run,
            'skippedSubmit': flow_res.get('skippedSubmit', 0),
        }
    except Exception as err:
        shot = await save_screenshot(page, post.get('id'))
        suffix = f" [anh loi: {shot}]" if shot else ""
        if isinstance(err, (ItemTimeoutError, BlockerError)):
            err.args = (f"{err}{suffix}",)
            raise
        
        new_msg = f"{err}{suffix}"
        exc = RuntimeError(new_msg)
        exc.trace = trace[-10:]
        raise exc from err
    finally:
        try:
            await page.close()
        except Exception:
            pass
