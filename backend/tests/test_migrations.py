"""The migration setup, including adopting a database that predates it."""
import sqlite3

import pytest
from sqlalchemy import inspect as sa_inspect

from app.db import BASELINE_REVISION, _upgrade


def _sync_url(tmp_path):
    return tmp_path / "t.db"


@pytest.fixture
def engine(tmp_path, monkeypatch):
    from sqlalchemy import create_engine

    from app import db

    path = _sync_url(tmp_path)
    monkeypatch.setattr(db._settings, "database_url", f"sqlite:///{path}")
    return create_engine(f"sqlite:///{path}"), path


def test_a_fresh_database_is_built_by_migrations(engine):
    eng, _ = engine
    with eng.begin() as conn:
        _upgrade(conn)

    tables = set(sa_inspect(eng).get_table_names())
    assert {"users", "nodes", "audit_log", "maintenance_holds"} <= tables
    assert "alembic_version" in tables


def test_it_is_stamped_at_head_afterwards(engine):
    eng, path = engine
    with eng.begin() as conn:
        _upgrade(conn)

    version = sqlite3.connect(path).execute("select version_num from alembic_version").fetchone()
    assert version[0] == BASELINE_REVISION


def test_a_database_from_before_migrations_is_adopted_not_rebuilt(engine):
    """The case that would break every existing deployment.

    A database made by the old create_all path has every table but no
    alembic_version, so running the baseline against it would fail on
    "table already exists".
    """
    eng, path = engine
    from app.db import Base

    Base.metadata.create_all(eng)
    with eng.begin() as conn:
        conn.exec_driver_sql(
            "insert into users (username, password_hash, role, is_active, created_at) "
            "values ('admin', 'x', 'admin', 1, '2026-01-01')"
        )

    with eng.begin() as conn:
        _upgrade(conn)  # must not raise

    rows = sqlite3.connect(path).execute("select count(*) from users").fetchone()
    assert rows[0] == 1, "adoption must not destroy existing data"


def test_running_twice_is_a_no_op(engine):
    # Every API restart calls this; it has to be safe to repeat.
    eng, _ = engine
    with eng.begin() as conn:
        _upgrade(conn)
    with eng.begin() as conn:
        _upgrade(conn)


def test_the_baseline_revision_constant_matches_a_real_migration():
    # A typo here would silently stamp a nonexistent revision and then fail on
    # the next upgrade, long after the change that caused it.

    import re
    from pathlib import Path

    versions = Path(__file__).resolve().parent.parent / "migrations" / "versions"
    # Alembic writes the revision with either quote style depending on version.
    pattern = re.compile(r"""^revision(?:: str)? = ['"]([^'"]+)['"]""", re.MULTILINE)
    revisions = {
        m.group(1) for f in versions.glob("*.py") for m in pattern.finditer(f.read_text())
    }
    assert revisions, "no migrations found at all"
    assert BASELINE_REVISION in revisions
