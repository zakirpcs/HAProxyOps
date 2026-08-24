"""HAProxyOps API entrypoint."""
import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select

from .config import get_settings
from .db import SessionLocal, init_models
from .logging_filters import install as install_log_redaction
from .models import Role, User
from .poller import poll_loop
from .routers import actions, auth, events, fleet, metrics, nodes
from .routers import settings as settings_router
from .security import hash_password
from .state import close_redis, get_redis

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s"
)
# Before anything can log a request line carrying the SSE token.
install_log_redaction()
log = logging.getLogger("haproxyops")
settings = get_settings()


async def bootstrap_admin() -> None:
    """Create the first admin account if the user table is empty."""
    async with SessionLocal() as session:
        if await session.scalar(select(User.id).limit(1)):
            return
        session.add(
            User(
                username=settings.initial_admin_username,
                password_hash=hash_password(settings.initial_admin_password),
                role=Role.ADMIN,
            )
        )
        await session.commit()
    log.warning(
        "Created initial admin '%s'. Change this password immediately.",
        settings.initial_admin_username,
    )


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_models()
    await bootstrap_admin()
    stop = asyncio.Event()
    poller = asyncio.create_task(poll_loop(stop), name="poller")
    try:
        yield
    finally:
        stop.set()
        poller.cancel()
        await asyncio.gather(poller, return_exceptions=True)
        await close_redis()


app = FastAPI(
    title="HAProxyOps",
    version="0.1.0",
    summary="Central dashboard for multiple HAProxy instances",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

for router in (auth.router, nodes.router, fleet.router, actions.router,
               events.router, metrics.router, settings_router.router):
    app.include_router(router)


@app.get("/api/health", tags=["meta"])
async def health() -> dict:
    """Liveness + dependency check, for the reverse proxy and monitoring."""
    redis_ok = True
    try:
        await get_redis().ping()
    except Exception:  # noqa: BLE001
        redis_ok = False
    return {"status": "ok" if redis_ok else "degraded", "redis": redis_ok}
