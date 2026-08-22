"""Async SQLAlchemy engine/session wiring, and schema migration at startup."""
import logging
from collections.abc import AsyncIterator
from pathlib import Path
from typing import TYPE_CHECKING

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

if TYPE_CHECKING:
    from alembic.config import Config

log = logging.getLogger("haproxyops.db")

#: The migration that matches what the old create_all path produced. A database
#: from before migrations existed is stamped here rather than rebuilt.
BASELINE_REVISION = "94414278fed7"

from .config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()
engine = create_async_engine(_settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


def _alembic_config() -> "Config":
    """Alembic config pointed at this package's migrations directory.

    Resolved relative to this file so it works from any working directory -
    the API container starts in /opt/app-root/src, not in backend/.
    """
    from alembic.config import Config

    root = Path(__file__).resolve().parent.parent
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", _settings.database_url)
    return config


def _upgrade(connection) -> None:
    """Bring the database to head, adopting one that predates migrations.

    A database created by the old ``create_all`` path already has every table
    but no ``alembic_version``, so running the baseline against it would fail on
    "table already exists". Stamping it first records that the baseline is
    already satisfied, and later migrations then apply normally.
    """
    from alembic import command
    from alembic.runtime.migration import MigrationContext

    config = _alembic_config()
    config.attributes["connection"] = connection

    context = MigrationContext.configure(connection)
    if context.get_current_revision() is None:
        inspector = sa_inspect(connection)
        if "users" in inspector.get_table_names():
            log.info("Adopting a pre-migration database: stamping the baseline")
            command.stamp(config, "base")
            command.stamp(config, BASELINE_REVISION)

    command.upgrade(config, "head")


async def init_models() -> None:
    """Apply migrations at startup.

    Automatic on purpose: the deployment is a single API container behind
    nginx, and an operator upgrading the image should not also have to remember
    a manual step. Run several replicas and this needs to move to a job that
    runs once before they start, because two of them migrating at the same time
    is a race.
    """
    async with engine.begin() as conn:
        await conn.run_sync(_upgrade)
    log.info("Database schema is up to date")
