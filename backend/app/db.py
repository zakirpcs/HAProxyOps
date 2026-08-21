"""Async SQLAlchemy engine/session wiring."""
import logging
from collections.abc import AsyncIterator

from sqlalchemy import inspect as sa_inspect
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

log = logging.getLogger("haproxyops.db")

from .config import get_settings


class Base(DeclarativeBase):
    pass


_settings = get_settings()
engine = create_async_engine(_settings.database_url, pool_pre_ping=True)
SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


async def get_session() -> AsyncIterator[AsyncSession]:
    async with SessionLocal() as session:
        yield session


def _add_missing_columns(connection) -> list[str]:
    """Add nullable columns that exist on the models but not yet in the database.

    A stopgap, not a migration system: it handles the additive case only and
    silently skips anything it cannot apply safely (NOT NULL without a default,
    type changes, renames, drops). Introduce Alembic before the first change
    that is not a nullable column addition.
    """
    inspector = sa_inspect(connection)
    added: list[str] = []
    for table in Base.metadata.sorted_tables:
        if not inspector.has_table(table.name):
            continue  # create_all will make it
        existing = {c["name"] for c in inspector.get_columns(table.name)}
        for column in table.columns:
            if column.name in existing:
                continue
            if not column.nullable and column.default is None and column.server_default is None:
                log.warning(
                    "Cannot auto-add NOT NULL column %s.%s - migrate it by hand.",
                    table.name, column.name,
                )
                continue
            ddl = (
                f"ALTER TABLE {table.name} "
                f"ADD COLUMN {column.name} {column.type.compile(connection.dialect)}"
            )
            connection.exec_driver_sql(ddl)
            added.append(f"{table.name}.{column.name}")
    return added


async def init_models() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        added = await conn.run_sync(_add_missing_columns)
    if added:
        log.info("Added missing columns: %s", ", ".join(added))
