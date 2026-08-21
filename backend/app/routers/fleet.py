"""Read paths: fleet rollup, per-node detail, config view, search, audit."""
from fastapi import APIRouter, HTTPException, Query, status
from sqlalchemy import select

from ..config import get_settings
from ..deps import CurrentUser, RequireAdmin, SessionDep
from ..drivers import build_driver
from ..drivers.base import DriverError, UnsupportedOperation
from ..models import AuditLog, Node
from ..schemas import AuditOut
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


@router.get("/audit", response_model=list[AuditOut])
async def audit(
    _: RequireAdmin,
    session: SessionDep,
    limit: int = Query(100, ge=1, le=1000),
) -> list[AuditLog]:
    return list(
        (await session.scalars(select(AuditLog).order_by(AuditLog.at.desc()).limit(limit))).all()
    )
