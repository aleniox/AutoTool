import asyncio
import json
import time
from typing import Any, List, Optional, Union

async def sleep(ms: Union[int, float]):
    await asyncio.sleep(max(0, ms) / 1000.0)

def candidates(desc: Any) -> List[Any]:
    if desc is None:
        return []
    if isinstance(desc, (list, tuple)):
        out = []
        for d in desc:
            out.extend(candidates(d))
        return out
    return [desc]

def build_locator(scope: Any, desc: Any) -> Any:
    if isinstance(desc, str):
        return scope.locator(desc)
    if not isinstance(desc, dict):
        raise ValueError(f"Locator descriptor khong hop le: {repr(desc)}")
    
    if 'css' in desc:
        return scope.locator(desc['css'])
    if 'xpath' in desc:
        return scope.locator(f"xpath={desc['xpath']}")
    if 'text' in desc:
        return scope.get_by_text(desc['text'], exact=bool(desc.get('exact', False)))
    if 'role' in desc:
        return scope.get_by_role(desc['role'], name=desc.get('name'), exact=bool(desc.get('exact', False)))
    if 'placeholder' in desc:
        return scope.get_by_placeholder(desc['placeholder'], exact=bool(desc.get('exact', False)))
    if 'label' in desc:
        return scope.get_by_label(desc['label'], exact=bool(desc.get('exact', False)))
    if 'testid' in desc:
        return scope.get_by_test_id(desc['testid'])
    if 'title' in desc:
        return scope.get_by_title(desc['title'], exact=bool(desc.get('exact', False)))
    if 'alt' in desc:
        return scope.get_by_alt_text(desc['alt'], exact=bool(desc.get('exact', False)))
    if 'selector' in desc:
        return scope.locator(desc['selector'])

    raise ValueError(f"Locator descriptor khong hop le: {repr(desc)}")

async def is_visible(loc: Any) -> bool:
    try:
        if (await loc.count()) == 0:
            return False
        return await loc.first.is_visible()
    except Exception:
        return False

def apply_index(loc: Any, desc: Any) -> Any:
    if isinstance(desc, dict) and isinstance(desc.get('index'), int):
        return loc.nth(desc['index'])
    return loc.first

async def find_visible(scope: Any, desc: Any, timeout: int = 15000, poll_ms: int = 250) -> Optional[Any]:
    cands = candidates(desc)
    if not cands:
        return None
    deadline = time.time() + (max(0, timeout) / 1000.0)

    while True:
        for c in cands:
            try:
                loc = build_locator(scope, c)
            except Exception:
                continue
            target = apply_index(loc, c)
            if await is_visible(target):
                return target

        if time.time() >= deadline:
            break
        await sleep(poll_ms)

    return None

async def find_attached(scope: Any, desc: Any, timeout: int = 15000, poll_ms: int = 250) -> Optional[Any]:
    cands = candidates(desc)
    if not cands:
        return None
    deadline = time.time() + (max(0, timeout) / 1000.0)

    while True:
        for c in cands:
            try:
                loc = build_locator(scope, c)
            except Exception:
                continue
            target = apply_index(loc, c)
            try:
                if (await target.count()) > 0:
                    return target
            except Exception:
                continue

        if time.time() >= deadline:
            break
        await sleep(poll_ms)

    return None

async def require_visible(scope: Any, desc: Any, timeout: int = 15000, label: str = '') -> Any:
    loc = await find_visible(scope, desc, timeout=timeout)
    if not loc:
        prefix = f" ({label})" if label else ""
        raise RuntimeError(f"Khong tim thay phan tu{prefix}: {describe(desc)}")
    return loc

async def any_visible(scope: Any, desc: Any) -> bool:
    return (await find_visible(scope, desc, timeout=0)) is not None

def describe(desc: Any) -> str:
    cands = candidates(desc)
    parts = []
    for d in cands:
        if isinstance(d, str):
            parts.append(d)
        else:
            try:
                parts.append(json.dumps(d, ensure_ascii=False))
            except Exception:
                parts.append(str(d))
    return ' | '.join(parts)
