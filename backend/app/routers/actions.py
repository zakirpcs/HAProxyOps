"""Runtime actions against a server. Operator role and above; all audited."""
from fastapi import APIRouter, HTTPException, Request, status

from ..config import get_settings
from ..deps import RequireOperator, SessionDep, write_audit
from ..drivers import build_driver
from ..drivers.base import AdminState, DriverError, UnsupportedOperation
from ..models import Node
from ..schemas import AdminStateRequest, WeightRequest
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
    return {"ok": True, "node": node.name, "backend": backend, "server": server,
            "admin_state": payload.state}


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
