"""Alembic environment.

The database URL comes from the application's own settings rather than
``alembic.ini``. In production that URL contains the Postgres password and is
read from a mounted secret file; duplicating it into a config file would put a
credential back into the repo, which is exactly what the secrets handling
exists to avoid.
"""
import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app import models  # noqa: F401 - imported for its side effect on metadata

# Importing the models is what populates Base.metadata, which autogenerate
# compares the database against.
from app.config import get_settings
from app.db import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name)

config.set_main_option("sqlalchemy.url", get_settings().database_url)

target_metadata = Base.metadata


def _configure(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        # Without this a column changing type or nullability is not detected,
        # which is half the reason for having migrations at all.
        compare_type=True,
        compare_server_default=True,
        # SQLite cannot ALTER most things in place; batch mode rewrites the
        # table instead, so the same migration works on dev and production.
        render_as_batch=connection.dialect.name == "sqlite",
    )


def run_migrations_offline() -> None:
    """Emit SQL to stdout instead of running it, for review before a deploy."""
    context.configure(
        url=config.get_main_option("sqlalchemy.url"),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    _configure(connection)
    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    connectable = async_engine_from_config(
        config.get_section(config.config_ini_section, {}),
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )
    async with connectable.connect() as connection:
        await connection.run_sync(do_run_migrations)
    await connectable.dispose()


def run_migrations_online() -> None:
    """Run migrations, reusing a caller's connection when one is provided.

    The application applies migrations at startup from inside a running event
    loop, so it hands its own connection over via ``config.attributes``. Making
    a fresh engine here would mean calling asyncio.run() inside a live loop,
    which raises. The standalone `alembic upgrade` path has no connection to
    reuse and creates one.
    """
    connection = config.attributes.get("connection")
    if connection is not None:
        do_run_migrations(connection)
        return
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
