"""Background task that refreshes every enabled node on a fixed interval."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import UTC, datetime

from sqlalchemy import select

from . import alerting, maintenance, settings_store
from .config import get_settings
from .db import SessionLocal
from .drivers import build_driver
from .drivers.base import DriverError, NodeSnapshot
from .models import Node
from .security import decrypt_secret
from .state import snapshot_to_dict, store_snapshot

log = logging.getLogger("haproxyops.poller")
settings = get_settings()


async def poll_node(node: Node, semaphore: asyncio.Semaphore) -> NodeSnapshot:
    """Poll one node. Never raises - unreachable nodes become an error snapshot."""
    started = time.perf_counter()
    snapshot = NodeSnapshot(node_id=node.id, node_name=node.name, group=node.group)
    driver = None
    async with semaphore:
        try:
            password = decrypt_secret(node.password_encrypted) if node.password_encrypted else None
            driver = build_driver(node, password=password, timeout=settings.poll_timeout_seconds)
            snapshot = await driver.fetch_snapshot()
        except DriverError as exc:
            snapshot.error = str(exc)
        except ValueError as exc:  # credential decryption failure
            snapshot.error = str(exc)
        except Exception as exc:
            log.exception("unexpected error polling node %s", node.name)
            snapshot.error = f"unexpected error: {exc}"
        finally:
            if driver is not None:
                await driver.aclose()

    snapshot.polled_at = datetime.now(UTC)
    snapshot.duration_ms = int((time.perf_counter() - started) * 1000)
    return snapshot


async def poll_once() -> int:
    """Poll all enabled nodes concurrently. Returns the number polled."""
    async with SessionLocal() as session:
        nodes = list((await session.scalars(select(Node).where(Node.enabled.is_(True)))).all())
    if not nodes:
        return 0

    semaphore = asyncio.Semaphore(settings.poll_concurrency)
    snapshots = await asyncio.gather(*(poll_node(n, semaphore) for n in nodes))
    await asyncio.gather(*(store_snapshot(s) for s in snapshots), return_exceptions=True)

    unreachable = [s.node_name for s in snapshots if not s.reachable]
    if unreachable:
        log.warning("unreachable nodes: %s", ", ".join(unreachable))

    as_dicts = [snapshot_to_dict(s) for s in snapshots]

    # After storing, so the dashboard is never waiting on a webhook, and
    # guarded so a broken receiver cannot stop the fleet being polled.
    try:
        async with SessionLocal() as session:
            webhook_url = await settings_store.effective_alert_webhook_url(session)
        await alerting.run(as_dicts, webhook_url)
    except Exception:
        log.exception("alert evaluation failed")

    # Expired maintenance windows, checked against the snapshots just taken so
    # a hold is never enforced against a state it no longer matches.
    try:
        async with SessionLocal() as session:
            await maintenance.sweep(
                session,
                {d["node_id"]: d for d in as_dicts},
                settings.poll_timeout_seconds,
            )
    except Exception:
        log.exception("maintenance sweep failed")

    return len(snapshots)


async def poll_loop(stop: asyncio.Event) -> None:
    log.info("poller started (interval=%ss)", settings.poll_interval_seconds)
    while not stop.is_set():
        try:
            count = await poll_once()
            log.debug("polled %d node(s)", count)
        except Exception:
            log.exception("poll cycle failed")
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.poll_interval_seconds)
        except TimeoutError:
            continue
    log.info("poller stopped")
