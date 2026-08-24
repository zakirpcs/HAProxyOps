"""The alert webhook URL, editable from the UI instead of only by env var.

Kept in Postgres (the AppSettings singleton row) rather than Redis: like
MaintenanceHold, losing it silently would be worse than the cost of a real
table, and it needs to survive a restart the same way a node's own stored
credentials do.
"""
from __future__ import annotations

from typing import Literal

from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .models import AppSettings
from .security import decrypt_secret, encrypt_secret

_ROW_ID = 1
settings = get_settings()

Source = Literal["ui", "env", "none"]


async def _get_row(session: AsyncSession) -> AppSettings:
    row = await session.get(AppSettings, _ROW_ID)
    if row is None:
        row = AppSettings(id=_ROW_ID)
        session.add(row)
        await session.flush()
    return row


async def alert_webhook_status(session: AsyncSession) -> tuple[bool, Source]:
    """Whether delivery is configured, and where it comes from.

    A value set in the UI always wins over the environment variable - it is
    the more specific, more recently expressed intent - but the env var still
    works untouched for anyone who only ever set it there.
    """
    row = await _get_row(session)
    if row.alert_webhook_url_encrypted:
        return True, "ui"
    if settings.alert_webhook_url:
        return True, "env"
    return False, "none"


async def effective_alert_webhook_url(session: AsyncSession) -> str | None:
    row = await _get_row(session)
    if row.alert_webhook_url_encrypted:
        return decrypt_secret(row.alert_webhook_url_encrypted)
    return settings.alert_webhook_url or None


async def set_alert_webhook_url(session: AsyncSession, url: str | None) -> None:
    """Set or clear the UI-stored webhook. Clearing falls back to the env var,
    it does not disable delivery outright if that is still set."""
    row = await _get_row(session)
    row.alert_webhook_url_encrypted = encrypt_secret(url) if url else None
