"""Runtime actions against a server. Operator role and above; all audited."""
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from .. import maintenance
from ..config import get_settings
from ..deps import CurrentUser, RequireOperator, SessionDep, write_audit
from ..drivers import build_driver
from ..drivers.base import AdminState, DriverError, UnsupportedOperation
from ..models import MaintenanceHold, Node
from ..schemas import AdminStateRequest, HoldOut, WeightRequest
from ..security import decrypt_secret

router = APIRouter(prefix="/api/nodes/{node_id}/backends/{backend}/servers/{server}",
                   tags=["actions"])
settings = get_settings()


async def _driver_for(session: SessionDep, node_id: int) -> tuple[Node, object]:
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    password = decrypt_secret(node.password_encrypted) if node.password_encrypted else None
    return node, build_driver(node, password=password, timeout=settings.poll_timeout_seconds)


@router.put("/admin-state")
async def set_admin_state(
    node_id: int,
    backend: str,
    server: str,
    payload: AdminStateRequest,
    user: RequireOperator,
    session: SessionDep,
    request: Request,
) -> dict:
    """Put a server into ready / drain / maint.

    drain stops new sessions but lets existing ones finish - use it before
    maint when taking a backend server out for patching.
    """
    node, driver = await _driver_for(session, node_id)
    target = f"{backend}/{server}"
    try:
        await driver.set_server_admin_state(backend, server, AdminState(payload.state))
    except UnsupportedOperation as exc:
        await write_audit(session, request, user, "server.admin_state", node_name=node.name,
                          target=target, detail=payload.state, success=False)
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc
    except (DriverError, ValueError) as exc:
        await write_audit(session, request, user, "server.admin_state", node_name=node.name,
                          target=target, detail=f"{payload.state}: {exc}", success=False)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        await driver.aclose()

    await write_audit(session, request, user, "server.admin_state", node_name=node.name,
                      target=target, detail=payload.state)

    # Any manual change supersedes an open hold on the same server: the
    # operator has just said what they want, and a timer set earlier should not
    # override it later.
    await _supersede_holds(session, node_id, backend, server)

    expires_at = None
    if payload.for_minutes and payload.state != "ready":
        expires_at = datetime.now(UTC) + timedelta(minutes=payload.for_minutes)
        session.add(MaintenanceHold(
            node_id=node_id, backend=backend, server=server,
            state=payload.state, revert_to="ready",
            expires_at=expires_at, created_by=user.username, reason=payload.reason,
        ))
        await write_audit(
            session, request, user, "maintenance.scheduled", node_name=node.name,
            target=target,
            detail=f"Returns to ready at {expires_at.isoformat()} ({payload.for_minutes}m).",
        )
    await session.commit()

    return {"ok": True, "node": node.name, "backend": backend, "server": server,
            "admin_state": payload.state,
            "expires_at": expires_at.isoformat() if expires_at else None}


async def _supersede_holds(session, node_id: int, backend: str, server: str) -> None:
    open_holds = list((await session.scalars(
        select(MaintenanceHold)
        .where(MaintenanceHold.node_id == node_id)
        .where(MaintenanceHold.backend == backend)
        .where(MaintenanceHold.server == server)
        .where(MaintenanceHold.released_at.is_(None))
    )).all())
    for hold in open_holds:
        await maintenance.release(
            session, hold, "superseded",
            detail="Replaced by a later manual change to this server.",
        )


@router.get("/holds", response_model=list[HoldOut])
async def list_holds(
    node_id: int, backend: str, server: str, _: CurrentUser, session: SessionDep,
) -> list[MaintenanceHold]:
    """Open maintenance windows for one server."""
    return list((await session.scalars(
        select(MaintenanceHold)
        .where(MaintenanceHold.node_id == node_id)
        .where(MaintenanceHold.backend == backend)
        .where(MaintenanceHold.server == server)
        .where(MaintenanceHold.released_at.is_(None))
    )).all())


@router.put("/weight")
async def set_weight(
    node_id: int,
    backend: str,
    server: str,
    payload: WeightRequest,
    user: RequireOperator,
    session: SessionDep,
    request: Request,
) -> dict:
    node, driver = await _driver_for(session, node_id)
    target = f"{backend}/{server}"
    try:
        await driver.set_server_weight(backend, server, payload.weight)
    except UnsupportedOperation as exc:
        await write_audit(session, request, user, "server.weight", node_name=node.name,
                          target=target, detail=str(payload.weight), success=False)
        raise HTTPException(status.HTTP_501_NOT_IMPLEMENTED, str(exc)) from exc
    except (DriverError, ValueError) as exc:
        await write_audit(session, request, user, "server.weight", node_name=node.name,
                          target=target, detail=f"{payload.weight}: {exc}", success=False)
        raise HTTPException(status.HTTP_502_BAD_GATEWAY, str(exc)) from exc
    finally:
        await driver.aclose()

    await write_audit(session, request, user, "server.weight", node_name=node.name,
                      target=target, detail=str(payload.weight))
    return {"ok": True, "node": node.name, "backend": backend, "server": server,
            "weight": payload.weight}
