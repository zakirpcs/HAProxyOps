"""Read paths: fleet rollup, per-node detail, config view, search, audit."""
import time

from fastapi import APIRouter, HTTPException, Query, Request, status
from sqlalchemy import select

from .. import alerting, settings_store
from ..config import get_settings
from ..deps import CurrentUser, RequireAdmin, SessionDep, write_audit
from ..drivers import build_driver
from ..drivers.base import (
    Capability,
    ConfigConflict,
    ConfigRejected,
    DriverError,
    UnsupportedOperation,
)
from ..models import AuditLog, Node
from ..schemas import AuditOut, RawConfigRequest
from ..security import decrypt_secret
from ..state import get_all_snapshots, get_snapshot

router = APIRouter(prefix="/api", tags=["fleet"])
settings = get_settings()


@router.get("/fleet")
async def fleet(_: CurrentUser, session: SessionDep) -> dict:
    """Every node with its latest snapshot, plus fleet-wide rollup counters.

    Nodes with no cached snapshot yet (just added, or the poller has not run)
    are returned as pending rather than omitted, so the UI can say so.
    """
    nodes = (await session.scalars(select(Node).order_by(Node.group, Node.name))).all()
    snapshots = {s["node_id"]: s for s in await get_all_snapshots()}

    items = []
    for node in nodes:
        snapshot = snapshots.get(node.id)
        if snapshot is None:
            items.append(
                {
                    "node_id": node.id,
                    "node_name": node.name,
                    "group": node.group,
                    "enabled": node.enabled,
                    "pending": True,
                    "reachable": False,
                    "error": None if node.enabled else "polling disabled for this node",
                }
            )
            continue
        items.append({**snapshot, "enabled": node.enabled, "pending": False})

    reachable = [i for i in items if i.get("reachable")]
    servers = [s for i in reachable for b in i.get("backends", []) for s in b.get("servers", [])]
    return {
        "nodes": items,
        "summary": {
            "nodes_total": len(items),
            "nodes_up": len(reachable),
            "nodes_down": sum(1 for i in items if i.get("enabled") and not i.get("reachable")),
            "frontends": sum(len(i.get("frontends", [])) for i in reachable),
            "backends": sum(len(i.get("backends", [])) for i in reachable),
            "servers_total": len(servers),
            # Active servers only. A backup is meant to sit down while the
            # primaries are healthy, so counting it here would mark every node
            # with a standby as degraded forever and drain the word of meaning.
            "servers_down": sum(
                1 for s in servers if not s.get("is_up") and not s.get("backup")
            ),
            # Still reported, because a dead backup means the fallback is gone
            # even though traffic is unaffected.
            "backups_down": sum(
                1 for s in servers if not s.get("is_up") and s.get("backup")
            ),
            "sessions_current": sum(
                f.get("sessions_current", 0) for i in reachable for f in i.get("frontends", [])
            ),
        },
    }


@router.get("/nodes/{node_id}/state")
async def node_state(node_id: int, _: CurrentUser, session: SessionDep) -> dict:
    if await session.get(Node, node_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    snapshot = await get_snapshot(node_id)
    if snapshot is None:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "No snapshot yet - the node has not been polled successfully.",
        )
    return snapshot


@router.get("/nodes/{node_id}/config")
async def node_config(node_id: int, _: CurrentUser, session: SessionDep) -> dict:
    """Live read of the node's declared frontends and backends."""
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    driver = None
    try:
        password = decrypt_secret(node.password_encrypted) if node.password_encrypted else None
        driver = build_driver(node, password=password, timeout=settings.poll_timeout_seconds)
        return await driver.fetch_config()
    except UnsupportedOperation as exc:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc
    except (DriverError, ValueError) as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        if driver is not None:
            await driver.aclose()


@router.get("/nodes/{node_id}/config/raw")
async def node_raw_config(node_id: int, _: RequireAdmin, session: SessionDep) -> dict:
    """The configuration file and the version needed to write it back.

    Admin only, and admin only for reading too: a full config can contain
    credentials in `userlist` blocks, TLS paths, and internal addressing that
    an operator with drain rights has no reason to see.
    """
    node, driver = await _config_driver(session, node_id)
    try:
        config, version = await driver.fetch_raw_config()
        return {"node": node.name, "config": config, "version": version}
    except UnsupportedOperation as exc:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc
    except DriverError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        await driver.aclose()


@router.post("/nodes/{node_id}/config/validate")
async def validate_config(
    node_id: int, payload: RawConfigRequest, user: RequireAdmin,
    session: SessionDep, request: Request,
) -> dict:
    """Check a configuration without applying it.

    HAProxy does the checking, so this is the same validation the apply path
    runs - a dry run, not a weaker approximation of one.
    """
    node, driver = await _config_driver(session, node_id)
    try:
        await driver.push_raw_config(payload.config, payload.version, validate_only=True)
    except ConfigRejected as exc:
        # Not an error condition: finding out a config is bad is the point.
        return {"valid": False, "message": str(exc)}
    except ConfigConflict as exc:
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except UnsupportedOperation as exc:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc
    except DriverError as exc:
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        await driver.aclose()

    await write_audit(session, request, user, "config.validate", node_name=node.name,
                      detail=f"{len(payload.config.splitlines())} lines validated")
    await session.commit()
    return {"valid": True, "message": "HAProxy accepted this configuration."}


@router.put("/nodes/{node_id}/config/raw")
async def apply_config(
    node_id: int, payload: RawConfigRequest, user: RequireAdmin,
    session: SessionDep, request: Request,
) -> dict:
    """Apply a configuration and reload the node.

    The version is checked by HAProxy, not here: anything else would be a
    race, because the config can change between our read and our write. A
    mismatch is a 409 and nothing is written.

    Audited before the attempt as well as after, so a config that takes the
    node down still leaves a record of who applied it and what they sent.
    """
    node, driver = await _config_driver(session, node_id)
    lines = len(payload.config.splitlines())
    try:
        await driver.push_raw_config(payload.config, payload.version, validate_only=False)
    except ConfigRejected as exc:
        await write_audit(session, request, user, "config.apply", node_name=node.name,
                          detail=f"rejected: {exc}", success=False)
        await session.commit()
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    except ConfigConflict as exc:
        await write_audit(session, request, user, "config.apply", node_name=node.name,
                          detail=f"conflict: {exc}", success=False)
        await session.commit()
        raise HTTPException(status.HTTP_409_CONFLICT, str(exc)) from exc
    except UnsupportedOperation as exc:
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc
    except DriverError as exc:
        await write_audit(session, request, user, "config.apply", node_name=node.name,
                          detail=f"failed: {exc}", success=False)
        await session.commit()
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        await driver.aclose()

    await write_audit(session, request, user, "config.apply", node_name=node.name,
                      detail=f"{lines} lines applied and reloaded")
    await session.commit()
    return {"ok": True, "node": node.name, "lines": lines}


async def _config_driver(session, node_id: int):
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    password = decrypt_secret(node.password_encrypted) if node.password_encrypted else None
    driver = build_driver(node, password=password, timeout=settings.poll_timeout_seconds)
    if Capability.WRITE_CONFIG not in getattr(driver, "capabilities", ()):
        await driver.aclose()
        raise HTTPException(
            status.HTTP_501_NOT_IMPLEMENTED,
            "This node's transport cannot read or write configuration.",
        )
    return node, driver


@router.get("/search")
async def search(
    _: CurrentUser,
    q: str = Query(min_length=1, description="Match against frontend, backend or server names"),
) -> dict:
    """Fleet-wide name search - 'which node serves this backend?' answered in one call."""
    needle = q.lower()
    hits: list[dict] = []
    for snapshot in await get_all_snapshots():
        node = {"node_id": snapshot["node_id"], "node_name": snapshot["node_name"]}
        for frontend in snapshot.get("frontends", []):
            if needle in frontend["name"].lower():
                hits.append({**node, "kind": "frontend", "name": frontend["name"],
                             "status": frontend["status"]})
        for backend in snapshot.get("backends", []):
            if needle in backend["name"].lower():
                hits.append({**node, "kind": "backend", "name": backend["name"],
                             "status": backend["status"]})
            for server in backend.get("servers", []):
                if needle in server["name"].lower() or needle in (server.get("address") or ""):
                    hits.append({**node, "kind": "server", "name": server["name"],
                                 "backend": backend["name"], "status": server["status"]})
    return {"query": q, "count": len(hits), "results": hits[:200]}


@router.get("/alerts")
async def alerts(_: CurrentUser, session: SessionDep) -> dict:
    """What is wrong right now, and what has been announced.

    Evaluated on demand from the cached snapshots, so the page works whether or
    not a webhook is configured: seeing the current problems is useful either
    way, and it doubles as a preview of what alerting *would* send once one is
    set. Delivery is the only part that needs the webhook.
    """
    delivery_configured, _source = await settings_store.alert_webhook_status(session)
    known = await alerting.load_state()
    now = time.time()

    items = []
    for alert in alerting.evaluate(await get_all_snapshots()):
        entry = known.get(alert.key, {})
        since = entry.get("since", now)
        notified = entry.get("notified")
        items.append({
            "key": alert.key,
            "severity": alert.severity,
            "title": alert.title,
            "detail": alert.detail,
            "node": alert.node,
            "labels": alert.labels,
            "since": since,
            "for_seconds": max(0.0, now - since),
            # "pending" is a real state, not a rounding of "firing": the problem
            # is live but has not lasted long enough to be worth a message.
            "state": "firing" if notified else "pending",
        })

    order = {"critical": 0, "warning": 1}
    items.sort(key=lambda a: (order.get(a["severity"], 9), -a["for_seconds"]))
    return {
        "delivery_configured": delivery_configured,
        "for_seconds": settings.alert_for_seconds,
        "count": len(items),
        "alerts": items,
    }


@router.get("/audit", response_model=list[AuditOut])
async def audit(
    _: RequireAdmin,
    session: SessionDep,
    limit: int = Query(100, ge=1, le=1000),
) -> list[AuditLog]:
    return list(
        (await session.scalars(select(AuditLog).order_by(AuditLog.at.desc()).limit(limit))).all()
    )
