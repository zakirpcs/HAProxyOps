"""Prometheus-backed graphs for one node."""
from fastapi import APIRouter, HTTPException, Query, Response, status

from .. import prom_export
from ..config import get_settings
from ..deps import CurrentUser, SessionDep
from ..metrics import MetricsUnavailable, query_range
from ..models import Node

router = APIRouter(prefix="/api", tags=["metrics"])
settings = get_settings()


@router.get("/metrics/status")
async def metrics_status(_: CurrentUser) -> dict:
    """Whether graphs are available at all, so the UI can hide them cleanly."""
    return {"enabled": bool(settings.prometheus_url)}


@router.get("/prometheus/nodes")
async def prometheus_export(token: str | None = None) -> Response:
    """Exposition text for every node's latest cached snapshot.

    No CurrentUser dependency: Prometheus is a machine scraper with no
    browser session to check. Guarded instead by an optional shared-secret
    query param - see metrics_export_token in config.py.
    """
    if settings.metrics_export_token and token != settings.metrics_export_token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid or missing token")
    body = await prom_export.render()
    return Response(content=body, media_type="text/plain; version=0.0.4")


@router.get("/nodes/{node_id}/metrics")
async def node_metrics(
    node_id: int,
    _: CurrentUser,
    session: SessionDep,
    minutes: int = Query(60, ge=5, le=1440, description="Look-back window"),
) -> dict:
    node = await session.get(Node, node_id)
    if node is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Node not found")
    try:
        panels = await query_range(node, minutes)
    except MetricsUnavailable as exc:
        # 503 rather than 502: the dashboard is fine, the history source is not.
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, str(exc)) from exc
    return {"node_id": node_id, "minutes": minutes, "panels": panels}
