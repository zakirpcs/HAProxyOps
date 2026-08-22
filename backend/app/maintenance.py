"""Put servers back into rotation when their maintenance window ends.

Draining a server and forgetting to restore it is the most common way to cause
an outage with this tool: capacity stays quietly halved until someone notices,
often days later. A hold records the intent - *out for thirty minutes* - and
this puts it back.

Auto-revert is a machine performing a runtime action unprompted, which deserves
scrutiny. Three things make it safe:

* **Restoring means "stop holding it out", not "send it traffic".** Setting
  ``ready`` clears the administrative block; HAProxy's own health checks still
  decide whether the server receives anything. A server that is still broken
  stays out, and the revert costs nothing.
* **A hold that no longer matches reality is abandoned, not enforced.** If an
  operator has since set the server to something else by hand, that is a
  deliberate decision made after the hold, and overriding it would be worse
  than leaving the server held.
* **Failure is retried, never swallowed.** A node unreachable at expiry keeps
  its hold and is tried again next cycle, because dropping it silently is how a
  server stays drained forever.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .drivers import build_driver
from .drivers.base import AdminState, DriverError
from .models import AuditLog, MaintenanceHold, Node
from .security import decrypt_secret

log = logging.getLogger("haproxyops")


def _now() -> datetime:
    return datetime.now(UTC)


def observed_state(snapshot: dict, backend: str, server: str) -> str | None:
    """The server's current admin state, as the last poll saw it.

    Returns None when the server is not in the snapshot at all - a node that
    could not be reached, or a server that has since been removed from the
    configuration.
    """
    for candidate in snapshot.get("backends", []):
        if candidate.get("name") != backend:
            continue
        for entry in candidate.get("servers", []):
            if entry.get("name") == server:
                return str(entry.get("status", "")).upper()
    return None


def still_held(status: str | None, state: str) -> bool:
    """Whether the server is still in the state its hold applied.

    HAProxy reports a drained server as DRAIN and a maintained one as MAINT,
    both sometimes suffixed. Anything else means somebody changed it after the
    hold was created, and their decision is newer than ours.
    """
    if status is None:
        return False
    return status.startswith(state.upper())


async def due_holds(session: AsyncSession, now: datetime | None = None) -> list[MaintenanceHold]:
    """Active holds whose window has closed."""
    moment = now or _now()
    return list(
        (
            await session.scalars(
                select(MaintenanceHold)
                .where(MaintenanceHold.released_at.is_(None))
                .where(MaintenanceHold.expires_at <= moment)
                .order_by(MaintenanceHold.expires_at)
            )
        ).all()
    )


async def release(
    session: AsyncSession,
    hold: MaintenanceHold,
    reason: str,
    *,
    node_name: str | None = None,
    detail: str | None = None,
    success: bool = True,
) -> None:
    """Close a hold and record why, so the audit log explains itself."""
    hold.released_at = _now()
    hold.release_reason = reason
    session.add(
        AuditLog(
            username="system",
            action=f"maintenance.{reason}",
            node_name=node_name,
            target=f"{hold.backend}/{hold.server}",
            detail=detail or f"Hold created by {hold.created_by} ended ({reason}).",
            success=success,
        )
    )


async def sweep(session: AsyncSession, snapshots: dict[int, dict], timeout: float) -> int:
    """Revert every hold whose window has closed. Returns how many were acted on.

    ``snapshots`` maps node id to the latest snapshot, so a hold can be checked
    against reality before anything is changed.
    """
    holds = await due_holds(session)
    if not holds:
        return 0

    acted = 0
    for hold in holds:
        node = await session.get(Node, hold.node_id)
        if node is None:
            # The node was deleted; there is nothing left to restore.
            await release(session, hold, "superseded",
                          detail="The node was removed while the hold was active.")
            continue

        snapshot = snapshots.get(hold.node_id)
        if snapshot is None or not snapshot.get("reachable"):
            # Keep the hold and try again next cycle. Dropping it here is how a
            # server stays drained forever.
            log.info(
                "maintenance: %s/%s is due but %s is unreachable; will retry",
                hold.backend, hold.server, node.name,
            )
            continue

        status = observed_state(snapshot, hold.backend, hold.server)
        if status is None:
            await release(session, hold, "superseded", node_name=node.name,
                          detail="The server is no longer in this backend.")
            continue

        if not still_held(status, hold.state):
            # Somebody changed it after the hold was created. Their decision is
            # newer than ours, so abandon the hold rather than override it.
            await release(
                session, hold, "superseded", node_name=node.name,
                detail=(
                    f"Left alone: expected {hold.state.upper()} but found {status}, "
                    "so the state was changed after the hold was created."
                ),
            )
            continue

        driver = None
        try:
            password = decrypt_secret(node.password_encrypted) if node.password_encrypted else None
            driver = build_driver(node, password=password, timeout=timeout)
            await driver.set_server_admin_state(
                hold.backend, hold.server, AdminState(hold.revert_to)
            )
        except (DriverError, ValueError) as exc:
            # Left active on purpose, so the next cycle tries again.
            log.warning(
                "maintenance: could not revert %s/%s on %s: %s",
                hold.backend, hold.server, node.name, exc,
            )
            continue
        finally:
            if driver is not None:
                await driver.aclose()

        await release(
            session, hold, "expired", node_name=node.name,
            detail=(
                f"Returned to {hold.revert_to} after the {hold.state} window set by "
                f"{hold.created_by} ended."
            ),
        )
        acted += 1
        log.info(
            "maintenance: returned %s/%s on %s to %s",
            hold.backend, hold.server, node.name, hold.revert_to,
        )

    await session.commit()
    return acted
