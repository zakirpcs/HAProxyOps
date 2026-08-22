"""Transport-agnostic view of one HAProxy instance.

Every driver normalises whatever its wire format is into the same dataclasses,
so the API and the UI never learn which transport a node uses. Adding a new
transport (raw Runtime API socket, an SSH agent, ...) means implementing this
protocol and registering it in ``build_driver`` - nothing else changes.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any, Protocol


class Capability(StrEnum):
    READ_STATE = "read_state"
    READ_CONFIG = "read_config"
    SET_ADMIN_STATE = "set_admin_state"
    SET_WEIGHT = "set_weight"
    WRITE_CONFIG = "write_config"


class AdminState(StrEnum):
    READY = "ready"
    MAINT = "maint"
    DRAIN = "drain"


@dataclass(slots=True)
class ServerStat:
    name: str
    backend: str
    status: str = "UNKNOWN"
    address: str | None = None
    weight: int | None = None
    active: bool = True
    backup: bool = False
    sessions_current: int = 0
    sessions_max: int = 0
    sessions_total: int = 0
    queue_current: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    connection_errors: int = 0
    response_errors: int = 0
    check_status: str | None = None
    check_failures: int = 0
    downtime_seconds: int = 0
    last_change_seconds: int = 0

    @property
    def is_up(self) -> bool:
        return self.status.upper().startswith("UP") or self.status.upper() == "OPEN"


@dataclass(slots=True)
class BackendStat:
    name: str
    status: str = "UNKNOWN"
    sessions_current: int = 0
    sessions_max: int = 0
    sessions_total: int = 0
    queue_current: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    connection_errors: int = 0
    response_errors: int = 0
    servers: list[ServerStat] = field(default_factory=list)

    @property
    def servers_up(self) -> int:
        return sum(1 for s in self.servers if s.is_up)


@dataclass(slots=True)
class FrontendStat:
    name: str
    status: str = "UNKNOWN"
    sessions_current: int = 0
    sessions_max: int = 0
    sessions_limit: int = 0
    sessions_total: int = 0
    bytes_in: int = 0
    bytes_out: int = 0
    request_errors: int = 0
    requests_denied: int = 0
    rate: int = 0
    #: Where this frontend sends traffic. Runtime stats carry no routing, so
    #: these come from the configuration and stay empty on transports that
    #: cannot read it - the UI falls back to flat lists when they are.
    default_backend: str | None = None
    #: Backends reachable through ``use_backend`` rules, in config order.
    rule_backends: list[str] = field(default_factory=list)
    #: Lua actions this frontend runs. A Lua script can select a backend, and
    #: nothing in the configuration says which - so a frontend with one of
    #: these may reach backends this view cannot show.
    lua_actions: list[str] = field(default_factory=list)

    @property
    def routed_backends(self) -> list[str]:
        """Every backend this frontend can reach, default first, deduplicated.

        A frontend often lists the same backend both as a rule target and as
        the default, and the same backend is frequently shared between
        frontends - so order matters more than uniqueness of ownership.
        """
        names = ([self.default_backend] if self.default_backend else []) + self.rule_backends
        seen: dict[str, None] = {}
        for name in names:
            seen.setdefault(name, None)
        return list(seen)


@dataclass(slots=True)
class NodeInfo:
    version: str | None = None
    uptime_seconds: int | None = None
    process_id: int | None = None
    node_name: str | None = None
    release_date: str | None = None


@dataclass(slots=True)
class NodeSnapshot:
    """Everything the dashboard knows about one node at one instant."""

    node_id: int
    node_name: str
    group: str = "default"
    reachable: bool = False
    error: str | None = None
    polled_at: datetime = field(default_factory=lambda: datetime.now(UTC))
    duration_ms: int = 0
    info: NodeInfo = field(default_factory=NodeInfo)
    frontends: list[FrontendStat] = field(default_factory=list)
    backends: list[BackendStat] = field(default_factory=list)
    capabilities: list[Capability] = field(default_factory=list)


class DriverError(RuntimeError):
    """A node could not be reached or answered with an error."""


class UnsupportedOperation(DriverError):
    """The node's transport cannot perform this action."""


class ConfigRejected(DriverError):
    """HAProxy refused the configuration.

    Separate from DriverError because the two need opposite responses: a
    rejected config is the operator's to fix and carries HAProxy's own
    diagnostics, while a transport failure says nothing about the config.
    """


class ConfigConflict(DriverError):
    """The node's configuration changed since it was read.

    Applying anyway would silently discard whoever got there first.
    """


class HAProxyDriver(Protocol):
    capabilities: tuple[Capability, ...]

    async def fetch_snapshot(self) -> NodeSnapshot: ...

    async def fetch_config(self) -> dict[str, Any]: ...

    async def fetch_raw_config(self) -> tuple[str, str]: ...

    async def push_raw_config(
        self, config: str, version: str, *, validate_only: bool
    ) -> None: ...

    async def set_server_admin_state(
        self, backend: str, server: str, state: AdminState
    ) -> None: ...

    async def set_server_weight(self, backend: str, server: str, weight: int) -> None: ...

    async def aclose(self) -> None: ...


# --- shared parsing helpers -------------------------------------------------

def as_int(value: Any, default: int = 0) -> int:
    """HAProxy stats leave irrelevant counters as empty strings; coerce safely."""
    if value is None or value == "":
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def pick(data: dict[str, Any], *keys: str, default: Any = None) -> Any:
    """Return the first present key.

    Field names drift between HAProxy versions and between the CSV export and
    the Data Plane API's JSON, so every lookup lists its known aliases.
    """
    for key in keys:
        if key in data and data[key] not in (None, ""):
            return data[key]
    return default
