"""Request/response models. Node secrets are write-only by construction."""
from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from .models import DriverKind, Role


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"
    username: str
    role: Role


class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    role: Role
    is_active: bool
    created_at: datetime


class UserCreate(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=8, max_length=256)
    role: Role = Role.VIEWER


class NodeBase(BaseModel):
    name: str = Field(min_length=1, max_length=128)
    group: str = "default"
    driver: DriverKind = DriverKind.DATAPLANE
    base_url: str
    api_prefix: str = "/v3"
    stats_path: str = "/stats;csv;norefresh"
    username: str | None = None
    prometheus_instance: str | None = None
    verify_tls: bool = True
    client_cert_path: str | None = None
    client_key_path: str | None = None
    ca_cert_path: str | None = None
    enabled: bool = True

    @field_validator("base_url")
    @classmethod
    def _require_scheme(cls, value: str) -> str:
        if not value.startswith(("http://", "https://")):
            raise ValueError("base_url must start with http:// or https://")
        return value.rstrip("/")

    @field_validator("api_prefix")
    @classmethod
    def _known_prefix(cls, value: str) -> str:
        normalised = "/" + value.strip("/")
        if normalised not in ("/v2", "/v3"):
            raise ValueError("api_prefix must be /v2 or /v3")
        return normalised


class NodeCreate(NodeBase):
    #: Write-only. Stored encrypted, never returned.
    password: str | None = None


class NodeUpdate(BaseModel):
    """Partial update. Unset fields are left alone; explicit null clears them.

    Carries the same validators as NodeCreate - without them an edit could
    store an endpoint that a create would have rejected.
    """

    name: str | None = None
    group: str | None = None
    driver: DriverKind | None = None
    base_url: str | None = None
    api_prefix: str | None = None
    stats_path: str | None = None
    username: str | None = None
    password: str | None = None
    prometheus_instance: str | None = None
    verify_tls: bool | None = None
    client_cert_path: str | None = None
    client_key_path: str | None = None
    ca_cert_path: str | None = None
    enabled: bool | None = None

    _check_base_url = field_validator("base_url")(NodeBase._require_scheme.__func__)
    _check_api_prefix = field_validator("api_prefix")(NodeBase._known_prefix.__func__)


class NodeOut(NodeBase):
    model_config = ConfigDict(from_attributes=True)
    id: int
    created_at: datetime
    has_password: bool = False


class ConnectionTest(BaseModel):
    reachable: bool
    error: str | None = None
    version: str | None = None
    duration_ms: int = 0
    capabilities: list[str] = []


class RawConfigRequest(BaseModel):
    #: The whole configuration file. Partial writes are not offered: HAProxy
    #: validates a complete config, and a merge done here would be a second
    #: parser to get wrong.
    config: str = Field(min_length=1, max_length=1_000_000)
    #: The version the edit was based on. HAProxy refuses the write if the
    #: config has changed since, so a concurrent edit cannot be clobbered.
    version: str


class AdminStateRequest(BaseModel):
    state: str = Field(pattern="^(ready|maint|drain)$")
    #: Minutes after which the server returns to rotation on its own. Omit for
    #: an open-ended change, which is the previous behaviour and still the
    #: default - a timed window has to be asked for.
    for_minutes: int | None = Field(default=None, ge=1, le=10080)
    reason: str | None = Field(default=None, max_length=500)


class HoldOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    node_id: int
    backend: str
    server: str
    state: str
    revert_to: str
    created_at: datetime
    expires_at: datetime
    created_by: str
    reason: str | None


class WeightRequest(BaseModel):
    weight: int = Field(ge=0, le=256)


class AlertWebhookStatus(BaseModel):
    configured: bool
    #: "ui" (set here), "env" (HAPROXYOPS_ALERT_WEBHOOK_URL only), or "none".
    #: Never the URL itself - like a node password, it is write-only once
    #: saved, since a webhook URL routinely embeds a bearer secret.
    source: Literal["ui", "env", "none"]


class AlertWebhookUpdate(BaseModel):
    #: Ignored when clear is true. Required otherwise - PUT always expresses
    #: one clear intent, never "leave it alone" (there is nothing to edit
    #: blindly, unlike a node form pre-filled with other fields).
    webhook_url: str | None = None
    clear: bool = False

    @field_validator("webhook_url")
    @classmethod
    def _require_http(cls, value: str | None) -> str | None:
        if value and not value.startswith(("http://", "https://")):
            raise ValueError("webhook_url must start with http:// or https://")
        return value


class AuditOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    at: datetime
    username: str
    action: str
    node_name: str | None
    target: str | None
    detail: str | None
    success: bool
    source_ip: str | None
