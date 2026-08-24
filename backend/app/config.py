"""Application settings, loaded from environment / .env / mounted secrets."""
import os
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

# Container runtimes mount secrets here as files, one per variable, which keeps
# them out of the environment and so out of `docker inspect`. Files are named
# with the env prefix (/run/secrets/HAPROXYOPS_SECRET_KEY). Probed rather than
# hard-coded: pydantic-settings warns on every start if the directory is absent,
# which it is for local development.
_SECRETS_DIR = "/run/secrets"


class Settings(BaseSettings):
    # Precedence is environment first, then .env, then secrets files - so an
    # explicit variable still overrides a mounted secret.
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="HAPROXYOPS_",
        extra="ignore",
        secrets_dir=_SECRETS_DIR if os.path.isdir(_SECRETS_DIR) else None,
    )

    # Core
    secret_key: str = "change-me-in-production"
    database_url: str = "sqlite+aiosqlite:///./haproxyops.db"
    redis_url: str = "redis://localhost:6379/0"
    cors_origins: list[str] = ["http://localhost:5173"]

    # Auth
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = 720

    # Bootstrap admin, created on first start if no users exist.
    initial_admin_username: str = "admin"
    initial_admin_password: str = "changeme"

    # Prometheus (optional). Without it, the node detail page hides its graphs.
    prometheus_url: str = ""
    prometheus_timeout_seconds: float = 10.0
    # Shared secret Prometheus must send as ?token= to /api/prometheus/nodes.
    # That endpoint has no browser session to check, since Prometheus is a
    # machine scraper - empty means unauthenticated, fine only if the
    # endpoint is reachable exclusively from a trusted network (e.g. the
    # docker-compose network) rather than the public internet.
    metrics_export_token: str = ""

    # Alerting. Without a webhook URL the whole subsystem is inert - no state
    # is kept and no evaluation runs, so it costs nothing until configured.
    alert_webhook_url: str = ""
    #: How long a problem must persist before it is announced. Short enough to
    #: be useful, long enough that a restarting node is not an incident.
    alert_for_seconds: float = 60.0
    #: How long a firing alert waits before repeating. 0 disables repeats.
    alert_repeat_seconds: float = 3600.0
    alert_timeout_seconds: float = 10.0

    # Polling
    poll_interval_seconds: float = 10.0
    poll_timeout_seconds: float = 5.0
    # Nodes are polled concurrently; this caps simultaneous in-flight requests
    # so a large fleet does not exhaust file descriptors.
    poll_concurrency: int = 32
    state_ttl_seconds: int = 120


@lru_cache
def get_settings() -> Settings:
    return Settings()
