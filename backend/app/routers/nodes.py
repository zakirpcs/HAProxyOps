"""Node inventory CRUD plus an on-demand connection test."""
import time

from fastapi import APIRouter, HTTPException, Request, status
from sqlalchemy import select

from ..config import get_settings
from ..deps import CurrentUser, RequireAdmin, SessionDep, write_audit
from ..drivers import build_driver
from ..drivers.base import DriverError
from ..models import Node
from ..schemas import ConnectionTest, NodeCreate, NodeOut, NodeUpdate
from ..security import decrypt_secret, encrypt_secret
from ..state import drop_snapshot

router = APIRouter(prefix="/api/nodes", tags=["nodes"])
settings = get_settings()

SECRET_FIELDS = {"password"}


def _to_out(node: Node) -> NodeOut:
    out = NodeOut.model_validate(node)
    out.has_password = node.password_encrypted is not None
    return out


async def _get_or_404(session: SessionDep, node_id: int) -> Node:
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    return node


@router.get("", response_model=list[NodeOut])
async def list_nodes(_: CurrentUser, session: SessionDep) -> list[NodeOut]:
    nodes = (await session.scalars(select(Node).order_by(Node.group, Node.name))).all()
    return [_to_out(n) for n in nodes]


@router.post("", response_model=NodeOut, status_code=status.HTTP_201_CREATED)
async def create_node(
    payload: NodeCreate, user: RequireAdmin, session: SessionDep, request: Request
) -> NodeOut:
    if await session.scalar(select(Node).where(Node.name == payload.name)):
        raise HTTPException(status.HTTP_409_CONFLICT, "A node with that name already exists")
    data = payload.model_dump(exclude=SECRET_FIELDS)
    node = Node(**data)
    if payload.password:
        node.password_encrypted = encrypt_secret(payload.password)
    session.add(node)
    await session.commit()
    await session.refresh(node)
    await write_audit(session, request, user, "node.create", node_name=node.name)
    return _to_out(node)


@router.patch("/{node_id}", response_model=NodeOut)
async def update_node(
    node_id: int,
    payload: NodeUpdate,
    user: RequireAdmin,
    session: SessionDep,
    request: Request,
) -> NodeOut:
    node = await _get_or_404(session, node_id)
    if payload.name and payload.name != node.name:
        clash = await session.scalar(select(Node).where(Node.name == payload.name))
        if clash is not None:
            raise HTTPException(status.HTTP_409_CONFLICT, "A node with that name already exists")
    changes = payload.model_dump(exclude_unset=True, exclude=SECRET_FIELDS)
    for key, value in changes.items():
        setattr(node, key, value)
    if payload.password is not None:
        # Empty string clears the stored credential.
        node.password_encrypted = encrypt_secret(payload.password) if payload.password else None
    await session.commit()
    await session.refresh(node)
    await write_audit(
        session, request, user, "node.update",
        node_name=node.name, detail=",".join(sorted(changes)) or "credentials",
    )
    return _to_out(node)


@router.delete("/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(
    node_id: int, user: RequireAdmin, session: SessionDep, request: Request
) -> None:
    node = await _get_or_404(session, node_id)
    name = node.name
    await session.delete(node)
    await session.commit()
    await drop_snapshot(node_id)
    await write_audit(session, request, user, "node.delete", node_name=name)


@router.post("/{node_id}/test", response_model=ConnectionTest)
async def test_node(node_id: int, _: CurrentUser, session: SessionDep) -> ConnectionTest:
    """Probe a node right now, bypassing the poll cache. Useful right after adding one."""
    node = await _get_or_404(session, node_id)
    started = time.perf_counter()
    driver = None
    try:
        password = decrypt_secret(node.password_encrypted) if node.password_encrypted else None
        driver = build_driver(node, password=password, timeout=settings.poll_timeout_seconds)
        snapshot = await driver.fetch_snapshot()
        return ConnectionTest(
            reachable=True,
            version=snapshot.info.version,
            duration_ms=int((time.perf_counter() - started) * 1000),
            capabilities=[str(c) for c in snapshot.capabilities],
        )
    except (DriverError, ValueError) as exc:
        return ConnectionTest(
            reachable=False,
            error=str(exc),
            duration_ms=int((time.perf_counter() - started) * 1000),
        )
    finally:
        if driver is not None:
            await driver.aclose()
