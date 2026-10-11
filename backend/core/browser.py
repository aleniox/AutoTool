import asyncio
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from playwright.async_api import async_playwright, Playwright, BrowserContext, Page
from backend.config import config
from backend.logger import create_logger
from backend.core.locator import find_visible

log = create_logger('browser')

_playwright_instance: Optional[Playwright] = None
_playwright_lock = asyncio.Lock()

async def get_playwright() -> Playwright:
    global _playwright_instance
    async with _playwright_lock:
        if _playwright_instance is None:
            _playwright_instance = await async_playwright().start()
        return _playwright_instance

# Per-account async locks to prevent concurrent profile accesses
_account_locks: Dict[int, asyncio.Lock] = {}
_locks_lock = asyncio.Lock()

async def _get_account_lock(account_id: int) -> asyncio.Lock:
    async with _locks_lock:
        if account_id not in _account_locks:
            _account_locks[account_id] = asyncio.Lock()
        return _account_locks[account_id]

# Live active contexts: account_id -> dict(context=..., mode=..., last_used=..., account_id=...)
_live: Dict[int, dict] = {}
_closing: set = set()

def profile_dir_for(account: dict) -> str:
    acc_id = account.get('id')
    platform = account.get('platform')
    d = Path(config.paths['profiles']) / f"{acc_id}-{platform}"
    d.mkdir(parents=True, exist_ok=True)
    return str(d)

def is_open(account_id: int) -> bool:
    return int(account_id) in _live

def launch_options(headless: bool) -> dict:
    opts = {
        'headless': headless,
        'viewport': config.browser.viewport,
        'locale': config.browser.locale,
        'timezone_id': config.browser.timezone_id,
        'accept_downloads': True,
        'ignore_https_errors': True,
        'args': [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=Translate,OptimizationHints',
            '--start-maximized',
        ],
    }
    if config.browser.channel and config.browser.channel != 'chromium':
        opts['channel'] = config.browser.channel
    return opts

async def _open_context(account: dict, headless: bool, mode: str) -> BrowserContext:
    acc_id = int(account['id'])
    pw = await get_playwright()
    user_data_dir = profile_dir_for(account)
    opts = launch_options(headless)
    
    try:
        context = await pw.chromium.launch_persistent_context(user_data_dir, **opts)
    except Exception as e:
        # If specific channel fails (e.g. edge not found), try default chromium
        if 'channel' in opts:
            opts_fallback = dict(opts)
            del opts_fallback['channel']
            log.warn(f"Khong mo duoc channel '{config.browser.channel}', thu lai voi Chromium: {e}")
            context = await pw.chromium.launch_persistent_context(user_data_dir, **opts_fallback)
        else:
            raise

    context.set_default_timeout(config.browser.step_timeout_ms)
    context.set_default_navigation_timeout(60000)

    if acc_id in _closing:
        await context.close()
        raise RuntimeError('Tai khoan vua bi dong hoac xoa trong luc trinh duyet dang mo.')

    def _on_close():
        entry = _live.get(acc_id)
        if entry and entry.get('context') == context:
            _live.pop(acc_id, None)

    context.on('close', lambda _: _on_close())
    _live[acc_id] = {
        'context': context,
        'mode': mode,
        'last_used': time.time(),
        'account_id': acc_id,
    }
    log.info(f"Mo profile {account.get('platform')}/{account.get('label')} ({mode}, headless={headless})")
    return context

async def get_context(account: dict, headless: Optional[bool] = None, mode: str = 'job') -> BrowserContext:
    acc_id = int(account['id'])
    if headless is None:
        headless = config.browser.headless

    lock = await _get_account_lock(acc_id)
    async with lock:
        entry = _live.get(acc_id)
        if entry:
            entry['last_used'] = time.time()
            return entry['context']
        return await _open_context(account, headless=headless, mode=mode)

async def get_page(account: dict, opts: dict = None) -> Page:
    opts = opts or {}
    context = await get_context(account, headless=opts.get('headless'), mode=opts.get('mode', 'job'))
    pages = context.pages
    if pages:
        return pages[0]
    return await context.new_page()

async def open_login_window(account: dict, url: str = None) -> dict:
    acc_id = int(account['id'])
    lock = await _get_account_lock(acc_id)
    async with lock:
        entry = _live.get(acc_id)
        if entry:
            entry['mode'] = 'login'
            context = entry['context']
            pages = context.pages
            page = pages[0] if pages else await context.new_page()
            try:
                await page.bring_to_front()
            except Exception:
                pass
            if url:
                try:
                    await page.goto(url, wait_until='domcontentloaded')
                except Exception:
                    pass
            return {'reused': True}

        context = await _open_context(account, headless=False, mode='login')
        pages = context.pages
        page = pages[0] if pages else await context.new_page()
        if url:
            try:
                await page.goto(url, wait_until='domcontentloaded')
            except Exception:
                pass
        try:
            await page.bring_to_front()
        except Exception:
            pass
        return {'reused': False}

async def close_account(account_id: int) -> bool:
    acc_id = int(account_id)
    lock = await _get_account_lock(acc_id)
    async with lock:
        _closing.add(acc_id)
        try:
            entry = _live.pop(acc_id, None)
            if not entry:
                return False
            try:
                await entry['context'].close()
            except Exception:
                pass
            log.info(f"Dong profile account #{acc_id}")
            return True
        finally:
            _closing.discard(acc_id)

async def close_all() -> List[int]:
    ids = list(_live.keys())
    for acc_id in ids:
        await close_account(acc_id)
    global _playwright_instance
    if _playwright_instance:
        try:
            await _playwright_instance.stop()
        except Exception:
            pass
        _playwright_instance = None
    return ids

async def probe_session(account: dict, platform: Any) -> dict:
    acc_id = int(account['id'])
    lock = await _get_account_lock(acc_id)
    async with lock:
        context = None
        own_context = False
        try:
            entry = _live.get(acc_id)
            if entry:
                context = entry['context']
            else:
                context = await _open_context(account, headless=True, mode='job')
                own_context = True

            page = await context.new_page()
            try:
                probe = getattr(platform, 'session', {}) or (platform.get('session', {}) if isinstance(platform, dict) else {})
                probe_url = probe.get('probeUrl') or getattr(platform, 'home_url', None) or platform.get('homeUrl')
                await page.goto(probe_url, wait_until='domcontentloaded', timeout=45000)
                await page.wait_for_timeout(2500)

                logged_out_desc = probe.get('loggedOut')
                if logged_out_desc:
                    out = await find_visible(page, logged_out_desc, timeout=1500)
                    if out:
                        return {'status': 'logged_out', 'message': 'Phat hien form dang nhap', 'url': page.url}

                logged_in_desc = probe.get('loggedIn')
                if logged_in_desc:
                    inside = await find_visible(page, logged_in_desc, timeout=8000)
                    if inside:
                        return {'status': 'logged_in', 'message': 'Phien dang nhap con hieu luc', 'url': page.url}
                    return {'status': 'logged_out', 'message': 'Khong tim thay dau hieu da dang nhap', 'url': page.url}

                return {'status': 'unknown', 'message': 'Nen tang chua khai bao cach kiem tra phien', 'url': page.url}
            finally:
                try:
                    await page.close()
                except Exception:
                    pass
        except Exception as err:
            return {'status': 'unknown', 'message': f"Loi kiem tra: {err}", 'url': ''}
        finally:
            if own_context and context:
                _live.pop(acc_id, None)
                try:
                    await context.close()
                except Exception:
                    pass

def detect_browsers() -> List[dict]:
    candidates = []
    p86 = os.environ.get('ProgramFiles(x86)')
    pf = os.environ.get('ProgramFiles')
    local_app_data = os.environ.get('LOCALAPPDATA')

    if p86:
        candidates.append(('msedge', str(Path(p86) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe')))
    if pf:
        candidates.append(('msedge', str(Path(pf) / 'Microsoft' / 'Edge' / 'Application' / 'msedge.exe')))
        candidates.append(('chrome', str(Path(pf) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe')))
    if p86:
        candidates.append(('chrome', str(Path(p86) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe')))
    if local_app_data:
        candidates.append(('chrome', str(Path(local_app_data) / 'Google' / 'Chrome' / 'Application' / 'chrome.exe')))

    found = []
    seen = set()
    for channel, path_str in candidates:
        p = Path(path_str)
        if p.exists() and channel not in seen:
            seen.add(channel)
            found.append({'channel': channel, 'path': path_str})
    return found
