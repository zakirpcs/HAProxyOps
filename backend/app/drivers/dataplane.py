"""Driver for the official HAProxy Data Plane API.

The version lives in ``Node.api_prefix`` ("/v3" or "/v2"). Most endpoints are
identical across the two, but not all: v3 nests sub-resources under their
parent where v2 takes the parent as a query parameter, and v3 alone exposes a
configuration version. Those differences are isolated in the small path
helpers below rather than scattered through the reads.
"""
from __future__ import annotations

import asyncio
import logging
import ssl
import time
from typing import Any

import httpx

from ..models import Node
from .base import (
    AdminState,
    BackendStat,
    Capability,
    DriverError,
    FrontendStat,
    NodeInfo,
    NodeSnapshot,
    ServerStat,
    UnsupportedOperation,
    as_int,
    pick,
)


def build_http_client(node: Node, password: str | None, timeout: float) -> httpx.AsyncClient:
    """Construct the httpx client for a node, honouring its TLS settings."""
    verify: Any = node.verify_tls
    if node.verify_tls and node.ca_cert_path:
        verify = ssl.create_default_context(cafile=node.ca_cert_path)
    cert: Any = None
    if node.client_cert_path:
        cert = (
            (node.client_cert_path, node.client_key_path)
            if node.client_key_path
            else node.client_cert_path
        )
    auth = httpx.BasicAuth(node.username, password or "") if node.username else None
    return httpx.AsyncClient(
        base_url=node.base_url.rstrip("/"),
        timeout=timeout,
        verify=verify,
        cert=cert,
        auth=auth,
        follow_redirects=False,
    )


#: How long routing may be reused on v2, which has no configuration version to
#: invalidate against. Topology changes on deploys, not between polls.
log = logging.getLogger("haproxyops")

CONFIG_TTL_SECONDS = 300.0

#: Routing cache, keyed by node id: ``{node_id: (config_key, routing)}``.
#:
#: Deliberately module-level rather than per-instance. The poller constructs a
#: driver for every node on every tick and closes it immediately afterwards, so
#: an instance attribute would be thrown away before it could ever be reused
#: and every poll would refetch the whole topology.
#:
#: Bounded by the size of the fleet. A deleted node leaves one small entry
#: behind until the process restarts.
_ROUTING_CACHE: dict[int, tuple[str | None, dict[str, tuple[str | None, list[str]]]]] = {}


class DataPlaneDriver:
    def __init__(self, node: Node, password: str | None = None, timeout: float = 5.0) -> None:
        self.node = node
        self.prefix = "/" + node.api_prefix.strip("/")
        self._client = build_http_client(node, password, timeout)
        # SET_WEIGHT is deliberately absent. The Data Plane API's runtime_server
        # model exposes only address / admin_state / operational_state / port -
        # there is no weight field in v2 or v3, so a weight change has to go
        # through a configuration transaction and a reload. Verified against
        # the v3 /specification on HAProxy 3.0.
        self.capabilities = (
            Capability.READ_STATE,
            Capability.READ_CONFIG,
            Capability.SET_ADMIN_STATE,
        )

    # -- transport ----------------------------------------------------------

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        url = f"{self.prefix}/services/haproxy{path}"
        try:
            response = await self._client.request(method, url, **kwargs)
        except httpx.HTTPError as exc:
            raise DriverError(f"{type(exc).__name__}: {exc}") from exc
        if response.status_code == 401:
            raise DriverError("authentication rejected by Data Plane API (401)")
        if response.status_code == 404:
            raise UnsupportedOperation(f"endpoint not available on this node: {url}")
        if response.status_code >= 400:
            raise DriverError(f"HTTP {response.status_code}: {response.text[:300]}")
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise DriverError("Data Plane API returned a non-JSON body") from exc

    async def aclose(self) -> None:
        await self._client.aclose()

    # -- reads --------------------------------------------------------------

    async def fetch_snapshot(self) -> NodeSnapshot:
        snapshot = NodeSnapshot(
            node_id=self.node.id,
            node_name=self.node.name,
            group=self.node.group,
            capabilities=list(self.capabilities),
        )
        snapshot.info = _parse_info(await self._request("GET", "/runtime/info"))
        frontends, backends = _parse_native_stats(await self._request("GET", "/stats/native"))
        routing = await self._routing_map()
        for frontend in frontends:
            default, rules = routing.get(frontend.name, (None, []))
            frontend.default_backend = default
            frontend.rule_backends = rules
        snapshot.frontends = frontends
        snapshot.backends = backends
        snapshot.reachable = True
        return snapshot

    async def _routing_map(self) -> dict[str, tuple[str | None, list[str]]]:
        """Frontend name -> (default_backend, use_backend targets).

        Never raises: routing is decoration on top of the stats, so a node that
        will not serve its configuration still produces a usable snapshot.
        """
        cached_key, cached = _ROUTING_CACHE.get(self.node.id, (None, {}))
        try:
            key = await self._config_key()
            if key is not None and key == cached_key and cached:
                return cached
            routing = await self._fetch_routing()
        except (DriverError, UnsupportedOperation):
            # Keep whatever was cached; stale routing beats none at all.
            return cached
        _ROUTING_CACHE[self.node.id] = (key, routing)
        return routing

    async def _config_key(self) -> str | None:
        """Cache key for the current configuration.

        v3 exposes a version counter that bumps on every config change. v2 has
        no such endpoint, so it falls back to a coarse time bucket - routing is
        then at most CONFIG_TTL_SECONDS stale, which is fine for a topology
        that changes on deploys.
        """
        try:
            version = await self._request("GET", "/configuration/version")
        except UnsupportedOperation:
            return f"ttl:{int(time.monotonic() / CONFIG_TTL_SECONDS)}"
        return f"v:{version}"

    def _switching_rules_path(self, frontend: str) -> tuple[str, dict]:
        """v3 nests the rules under the frontend; v2 takes it as a query."""
        if self.prefix == "/v3":
            return f"/configuration/frontends/{frontend}/backend_switching_rules", {}
        return "/configuration/backend_switching_rules", {"frontend": frontend}

    async def _fetch_routing(self) -> dict[str, tuple[str | None, list[str]]]:
        raw = _unwrap(await self._request("GET", "/configuration/frontends")) or []
        # Filter first and keep one list: rule lookups are zipped back against
        # these entries, so the two must not drift apart.
        frontends = [f for f in raw if isinstance(f, dict) and f.get("name")]

        async def rules_for(name: str) -> list[str]:
            path, params = self._switching_rules_path(name)
            try:
                rules = _unwrap(await self._request("GET", path, params=params)) or []
            except (DriverError, UnsupportedOperation):
                # One frontend's rules failing must not lose the whole map.
                return []
            return [r["name"] for r in rules if isinstance(r, dict) and r.get("name")]

        # Concurrent: this is one request per frontend, and a busy edge node can
        # easily have dozens.
        rule_lists = await asyncio.gather(*(rules_for(f["name"]) for f in frontends))
        return {
            f["name"]: (f.get("default_backend") or None, rules)
            for f, rules in zip(frontends, rule_lists, strict=True)
        }

    def _runtime_server_path(self, backend: str, server: str) -> tuple[str, dict]:
        """Path and query for one runtime server. The two API versions differ.

        v3 nests the server under its backend; v2 takes the backend as a query
        parameter. Getting this wrong returns 404, not a helpful error.
        """
        if self.prefix == "/v3":
            return f"/runtime/backends/{backend}/servers/{server}", {}
        return f"/runtime/servers/{server}", {"backend": backend}

    async def set_server_admin_state(
        self, backend: str, server: str, state: AdminState
    ) -> None:
        path, params = self._runtime_server_path(backend, server)
        await self._request("PUT", path, params=params, json={"admin_state": str(state)})

    async def set_server_weight(self, backend: str, server: str, weight: int) -> None:
        raise UnsupportedOperation(
            "The Data Plane API does not expose server weight at runtime - its "
            "runtime_server model has no weight field in either v2 or v3. Changing a "
            "weight requires editing the backend's configuration and reloading."
        )


# --- response parsing -------------------------------------------------------
# The Data Plane API wraps payloads differently across versions (bare array,
# {"data": ...}, or {"_version": N, "data": ...}), so unwrap defensively.

def _unwrap(payload: Any) -> Any:
    if isinstance(payload, dict) and "data" in payload:
        return payload["data"]
    return payload


def _parse_info(payload: Any) -> NodeInfo:
    data = _unwrap(payload)
    if isinstance(data, list):
        data = data[0] if data else {}
    if isinstance(data, dict) and "info" in data:
        data = data["info"]
    if not isinstance(data, dict):
        return NodeInfo()
    return NodeInfo(
        version=pick(data, "version", "haproxy_version"),
        uptime_seconds=as_int(pick(data, "uptime", "uptime_sec"), 0) or None,
        process_id=as_int(pick(data, "pid", "process_num"), 0) or None,
        node_name=pick(data, "node", "node_name"),
        release_date=pick(data, "release_date"),
    )


def _iter_stat_records(payload: Any):
    """Yield (type, name, backend_name, stats_dict) from a /stats/native response.

    Shape varies by version: a list of per-process objects each holding a
    ``stats`` list, or a flat list of stat records. In the nested form the
    ``type`` lives on the *outer* object while name/backend_name live on the
    inner record, so the outer values are threaded down as fallbacks.
    """
    data = _unwrap(payload)
    if not isinstance(data, list):
        data = [data]
    for entry in data:
        if not isinstance(entry, dict):
            continue
        inner = entry.get("stats")
        if isinstance(inner, list):
            for record in inner:
                if isinstance(record, dict):
                    yield _record_parts(record, parent=entry)
        else:
            yield _record_parts(entry)


def _record_parts(record: dict, parent: dict | None = None) -> tuple[str, str, str, dict]:
    stats = record.get("stats") if isinstance(record.get("stats"), dict) else record
    parent = parent or {}
    kind = str(
        pick(record, "type", default=pick(stats, "type", default=pick(parent, "type", default="")))
    ).lower()
    name = pick(record, "name", default=pick(stats, "svname", "pxname", default=""))
    backend = pick(
        record,
        "backend_name",
        default=pick(stats, "pxname", default=pick(parent, "name", default="")),
    )
    return kind, str(name or ""), str(backend or ""), stats


def _parse_native_stats(payload: Any) -> tuple[list[FrontendStat], list[BackendStat]]:
    frontends: list[FrontendStat] = []
    backends: dict[str, BackendStat] = {}
    pending_servers: list[ServerStat] = []

    for kind, name, backend_name, stats in _iter_stat_records(payload):
        if kind == "frontend":
            frontends.append(_frontend_from(name, stats))
        elif kind == "backend":
            backends[name] = _backend_from(name, stats)
        elif kind == "server":
            pending_servers.append(_server_from(name, backend_name, stats))
        # "listener" / socket rows are intentionally dropped: they duplicate
        # frontend counters per bind line and add noise to the fleet view.

    for server in pending_servers:
        parent = backends.get(server.backend)
        if parent is None:
            parent = BackendStat(name=server.backend)
            backends[server.backend] = parent
        parent.servers.append(server)

    return frontends, sorted(backends.values(), key=lambda b: b.name)


def _frontend_from(name: str, s: dict) -> FrontendStat:
    return FrontendStat(
        name=name or str(pick(s, "pxname", default="?")),
        status=str(pick(s, "status", default="UNKNOWN")),
        sessions_current=as_int(pick(s, "scur")),
        sessions_max=as_int(pick(s, "smax")),
        sessions_limit=as_int(pick(s, "slim")),
        sessions_total=as_int(pick(s, "stot")),
        bytes_in=as_int(pick(s, "bin")),
        bytes_out=as_int(pick(s, "bout")),
        request_errors=as_int(pick(s, "ereq")),
        requests_denied=as_int(pick(s, "dreq")),
        rate=as_int(pick(s, "rate", "req_rate")),
    )


def _backend_from(name: str, s: dict) -> BackendStat:
    return BackendStat(
        name=name or str(pick(s, "pxname", default="?")),
        status=str(pick(s, "status", default="UNKNOWN")),
        sessions_current=as_int(pick(s, "scur")),
        sessions_max=as_int(pick(s, "smax")),
        sessions_total=as_int(pick(s, "stot")),
        queue_current=as_int(pick(s, "qcur")),
        bytes_in=as_int(pick(s, "bin")),
        bytes_out=as_int(pick(s, "bout")),
        connection_errors=as_int(pick(s, "econ")),
        response_errors=as_int(pick(s, "eresp")),
    )


def _server_from(name: str, backend: str, s: dict) -> ServerStat:
    return ServerStat(
        name=name or str(pick(s, "svname", default="?")),
        backend=backend or str(pick(s, "pxname", default="?")),
        status=str(pick(s, "status", default="UNKNOWN")),
        address=pick(s, "addr", "address"),
        weight=as_int(pick(s, "weight"), 0),
        active=bool(as_int(pick(s, "act"), 1)),
        backup=bool(as_int(pick(s, "bck"), 0)),
        sessions_current=as_int(pick(s, "scur")),
        sessions_max=as_int(pick(s, "smax")),
        sessions_total=as_int(pick(s, "stot")),
        queue_current=as_int(pick(s, "qcur")),
        bytes_in=as_int(pick(s, "bin")),
        bytes_out=as_int(pick(s, "bout")),
        connection_errors=as_int(pick(s, "econ")),
        response_errors=as_int(pick(s, "eresp")),
        check_status=pick(s, "check_status"),
        check_failures=as_int(pick(s, "chkfail")),
        downtime_seconds=as_int(pick(s, "downtime")),
        last_change_seconds=as_int(pick(s, "lastchg")),
    )
