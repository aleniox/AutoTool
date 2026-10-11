import os
import sys
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from backend.config import config, ensure_dirs
from backend.db import run, now_iso, prune_logs
from backend.logger import create_logger
from backend.core.worker import start_worker, stop_worker
from backend.core.browser import close_all, detect_browsers
from backend.server.routes.core import router as core_router
from backend.server.routes.accounts import router as accounts_router
from backend.server.routes.content import router as content_router
from backend.server.routes.jobs import router as jobs_router

log = create_logger('server')

@asynccontextmanager
async def lifespan(app: FastAPI):
    ensure_dirs()

    # Don sach item bi treo tu lan chay truoc (process bi kill giua chung)
    one_hour_ago = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat().replace('+00:00', 'Z')
    orphans = run(
        """UPDATE job_items SET status = 'pending', started_at = NULL, run_at = ?
            WHERE status = 'running' AND started_at < ?""",
        now_iso(),
        one_hour_ago,
    )
    if orphans.changes:
        log.warn(f"Khoi phuc {orphans.changes} luot dang bi treo tu lan chay truoc")

    browsers = detect_browsers()
    url = f"http://{config.host}:{config.port}"
    log.info('─' * 64)
    log.info(f"  AutoTool (Python/FastAPI) dang chay tai {url}")
    log.info(f"  Thu muc du lieu : {config.data_dir}")
    log.info(f"  Browser engine  : {config.browser.channel}{'' if browsers else ' (KHONG TIM THAY!)'}")
    log.info(f"  Che do          : {'an (headless)' if config.browser.headless else 'hien cua so'}")
    log.info('─' * 64)

    start_worker()

    yield

    log.info("Dang tat AutoTool...")
    await stop_worker(drain=True, timeout_ms=20000)
    await close_all()
    log.info("Da tat sach se.")

app = FastAPI(title="AutoTool", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def log_api_requests(request: Request, call_next):
    if request.url.path.startswith("/api") and request.method != "GET":
        log.debug(f"{request.method} {request.url.path}")
    return await call_next(request)

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": exc.detail},
    )

@app.exception_handler(Exception)
async def general_exception_handler(request: Request, exc: Exception):
    log.error(f"500 Internal Error: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)},
    )

# API Routers
app.include_router(core_router, prefix="/api")
app.include_router(accounts_router, prefix="/api")
app.include_router(content_router, prefix="/api")
app.include_router(jobs_router, prefix="/api")

# Static media and screenshots
app.mount("/media", StaticFiles(directory=config.paths['media'], check_dir=False), name="media")
app.mount("/screenshots", StaticFiles(directory=config.paths['screenshots'], check_dir=False), name="screenshots")

# Frontend static files and SPA fallback
web_dir = Path(config.paths['web']).resolve()

@app.get("/{full_path:path}")
async def serve_spa_or_static(full_path: str):
    if full_path.startswith(("api", "media", "screenshots")):
        raise HTTPException(status_code=404, detail="Endpoint khong ton tai")

    no_cache_headers = {"Cache-Control": "no-cache, must-revalidate"}
    target_file = (web_dir / full_path).resolve()
    if target_file.is_relative_to(web_dir) and target_file.is_file():
        return FileResponse(target_file, headers=no_cache_headers)

    index_html = web_dir / "index.html"
    if index_html.exists():
        return FileResponse(index_html, headers=no_cache_headers)

    raise HTTPException(status_code=404, detail="File not found")
