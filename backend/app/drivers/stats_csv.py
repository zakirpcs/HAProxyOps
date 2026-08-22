"""Read-only driver for nodes that only expose HAProxy's HTTP stats page.

Useful for legacy instances where the Data Plane API cannot be installed: they
show up in the dashboard as normal, just without action buttons.

Known gap: HAProxy leaves the CSV ``addr`` column empty on the HTTP stats page
regardless of ``stats admin`` - server addresses are only populated by the
Runtime API. Nodes on this driver therefore show "-" for server addresses.
Verified against HAProxy 3.0.
"""
from __future__ import annotations

import csv
import io
from typing import Any

import httpx

from ..models import Node
from .base import (
    AdminState,
    BackendStat,
    Capability,
    DriverError,
    NodeSnapshot,
    ServerStat,
    UnsupportedOperation,
)
from .dataplane import _backend_from, _frontend_from, _server_from, build_http_client

# HAProxy's CSV "type" column.
FRONTEND, BACKEND, SERVER, LISTENER = "0", "1", "2", "3"


class StatsCsvDriver:
    capabilities = (Capability.READ_STATE,)

    def __init__(self, node: Node, password: str | None = None, timeout: float = 5.0) -> None:
        self.node = node
        self._client = build_http_client(node, password, timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def fetch_snapshot(self) -> NodeSnapshot:
        try:
            response = await self._client.get(self.node.stats_path)
        except httpx.HTTPError as exc:
            raise DriverError(f"{type(exc).__name__}: {exc}") from exc
        if response.status_code >= 400:
            raise DriverError(f"HTTP {response.status_code}: {response.text[:200]}")

        frontends, backends = _parse_csv(response.text)
        return NodeSnapshot(
            node_id=self.node.id,
            node_name=self.node.name,
            group=self.node.group,
            reachable=True,
            frontends=frontends,
            backends=backends,
            capabilities=list(self.capabilities),
        )

    async def fetch_config(self) -> dict[str, Any]:
        raise UnsupportedOperation(
            "The stats page does not expose configuration. Install the Data Plane API "
            "on this node to view its configuration."
        )

    async def set_server_admin_state(self, backend: str, server: str, state: AdminState) -> None:
        raise UnsupportedOperation(
            "This node is read-only (stats page transport). Install the Data Plane API "
            "to enable runtime actions."
        )

    async def set_server_weight(self, backend: str, server: str, weight: int) -> None:
        raise UnsupportedOperation(
            "This node is read-only (stats page transport). Install the Data Plane API "
            "to enable runtime actions."
        )

    async def fetch_raw_config(self) -> tuple[str, str]:
        raise UnsupportedOperation(
            "the stats page exposes runtime state only, never the configuration"
        )

    async def push_raw_config(
        self, config: str, version: str, *, validate_only: bool
    ) -> None:
        raise UnsupportedOperation(
            "the stats page is read-only; register the node with the Data Plane "
            "API driver to change its configuration"
        )


def _parse_csv(text: str) -> tuple[list, list[BackendStat]]:
    lines = text.splitlines()
    if not lines:
        raise DriverError("stats endpoint returned an empty body")
    # Header line is commented: "# pxname,svname,qcur,..."
    lines[0] = lines[0].lstrip("# ").strip()
    reader = csv.DictReader(io.StringIO("\n".join(lines)))

    frontends = []
    backends: dict[str, BackendStat] = {}
    servers: list[ServerStat] = []

    for row in reader:
        proxy = (row.get("pxname") or "").strip()
        svname = (row.get("svname") or "").strip()
        if not proxy:
            continue
        kind = (row.get("type") or "").strip()
        if kind == FRONTEND:
            frontends.append(_frontend_from(proxy, row))
        elif kind == BACKEND:
            backends[proxy] = _backend_from(proxy, row)
        elif kind == SERVER:
            servers.append(_server_from(svname, proxy, row))

    for server in servers:
        backends.setdefault(server.backend, BackendStat(name=server.backend)).servers.append(server)

    return frontends, sorted(backends.values(), key=lambda b: b.name)
