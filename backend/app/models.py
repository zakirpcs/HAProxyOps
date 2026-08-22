"""Persistent inventory: nodes, users, audit trail."""
from datetime import UTC, datetime
from enum import StrEnum

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def _utcnow() -> datetime:
    return datetime.now(UTC)


class Role(StrEnum):
    VIEWER = "viewer"
    OPERATOR = "operator"
    ADMIN = "admin"


class DriverKind(StrEnum):
    #: Official HAProxy Data Plane API. Live state + runtime actions.
    DATAPLANE = "dataplane"
    #: Legacy nodes: HTTP stats page CSV export. Read-only.
    STATS_CSV = "stats_csv"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default=Role.VIEWER)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class Node(Base):
    """One managed HAProxy instance."""

    __tablename__ = "nodes"
    __table_args__ = (UniqueConstraint("name", name="uq_nodes_name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(128), index=True)
    #: Free-form grouping, e.g. "edge-dc1" or "internal". Used to cluster the fleet view.
    group: Mapped[str] = mapped_column(String(128), default="default")
    driver: Mapped[str] = mapped_column(String(32), default=DriverKind.DATAPLANE)

    #: Base URL of the node's management endpoint,
    #: e.g. https://lb1.example.com:5555 (dataplane) or https://lb1.example.com:8404 (stats).
    base_url: Mapped[str] = mapped_column(String(512))
    #: API prefix for the dataplane driver: "/v3" (default) or "/v2" for older nodes.
    api_prefix: Mapped[str] = mapped_column(String(16), default="/v3")
    #: Path of the CSV stats export, stats_csv driver only.
    stats_path: Mapped[str] = mapped_column(String(255), default="/stats;csv;norefresh")

    username: Mapped[str | None] = mapped_column(String(128), nullable=True)
    #: Fernet-encrypted at rest; never returned by the API.
    password_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)

    verify_tls: Mapped[bool] = mapped_column(Boolean, default=True)
    #: Optional PEM paths on the dashboard host for mTLS to this node.
    client_cert_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    client_key_path: Mapped[str | None] = mapped_column(String(512), nullable=True)
    ca_cert_path: Mapped[str | None] = mapped_column(String(512), nullable=True)

    #: Prometheus `instance` label for this node's scrape target, e.g.
    #: "lb1.example.com:8404". When unset, metrics queries fall back to matching
    #: any port on the host in base_url - the scrape target is the stats port
    #: while base_url points at the Data Plane API.
    prometheus_instance: Mapped[str | None] = mapped_column(String(255), nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)


class AuditLog(Base):
    """Append-only record of every mutating action."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow, index=True)
    username: Mapped[str] = mapped_column(String(64), index=True)
    action: Mapped[str] = mapped_column(String(64))
    node_name: Mapped[str | None] = mapped_column(String(128), nullable=True, index=True)
    target: Mapped[str | None] = mapped_column(String(255), nullable=True)
    detail: Mapped[str | None] = mapped_column(Text, nullable=True)
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    source_ip: Mapped[str | None] = mapped_column(String(64), nullable=True)


class MaintenanceHold(Base):
    """A server held out of rotation, with a time it should come back.

    Forgetting to restore a drained server is the most common way to cause an
    outage with this tool: capacity quietly stays halved until someone notices.
    A hold records the intent - "out for thirty minutes" - so the poller can put
    it back without anyone remembering to.

    Kept in Postgres rather than Redis deliberately. If this state is lost the
    server never returns, which is precisely the failure the feature exists to
    prevent, so it belongs somewhere durable rather than in a cache that is
    safe to flush.
    """

    __tablename__ = "maintenance_holds"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    node_id: Mapped[int] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), index=True)
    backend: Mapped[str] = mapped_column(String(255))
    server: Mapped[str] = mapped_column(String(255))

    #: The state the server was put into: "drain" or "maint".
    state: Mapped[str] = mapped_column(String(16))
    #: What to restore it to when the hold expires.
    revert_to: Mapped[str] = mapped_column(String(16), default="ready")

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    created_by: Mapped[str] = mapped_column(String(64))
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    #: Null while the hold is active. Set when it expires, is cancelled, or is
    #: abandoned because someone changed the server's state by hand.
    released_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, index=True
    )
    #: "expired" | "cancelled" | "superseded"
    release_reason: Mapped[str | None] = mapped_column(String(32), nullable=True)
