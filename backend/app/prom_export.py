"""Self-hosted Prometheus exporter, built from data HAProxyOps already polls.

Some nodes cannot run a Prometheus scrape target of their own - the HAProxy
build predates the native exporter service (added in 2.0), or the distro
package was not compiled with it, and installing a sidecar exporter on every
box is more moving parts than a fleet wants. This renders the same counters
from the snapshot the poller already fetched over the node's normal API/CSV
transport and cached in Redis - no extra request to the node, nothing to
install there. Point Prometheus at this endpoint instead of the node itself.
"""
from __future__ import annotations

from urllib.parse import urlparse

from sqlalchemy import select

from .db import SessionLocal
from .models import Node
from .state import get_all_snapshots

#: (Prometheus type, HELP text) for every series this exporter emits. Names
#: match the native HAProxy exporter exactly, so a node can move between this
#: and a real exporter without changing anything in metrics.py's PANELS.
_METRICS: tuple[tuple[str, str, str], ...] = (
    ("haproxy_frontend_current_sessions", "gauge", "Current number of active sessions."),
    ("haproxy_frontend_http_requests_total", "counter", "Total number of HTTP requests received."),
    ("haproxy_frontend_bytes_in_total", "counter", "Total bytes received by the frontend."),
    ("haproxy_frontend_bytes_out_total", "counter", "Total bytes sent by the frontend."),
    ("haproxy_backend_connection_errors_total", "counter", "Total number of connection errors."),
    ("haproxy_backend_response_errors_total", "counter", "Total number of response errors."),
)


def _instance_label(base_url: str, name: str) -> str:
    """Must satisfy instance_selector()'s fallback: instance=~"{host}:.*" ."""
    host = urlparse(base_url).hostname or name
    return f"{host}:export"


def _line(metric: str, labels: dict[str, str], value: float) -> str:
    rendered = ",".join(f'{k}="{v}"' for k, v in labels.items())
    return f"{metric}{{{rendered}}} {value}"


async def render() -> str:
    """Full exposition text for every node's latest cached snapshot."""
    async with SessionLocal() as session:
        nodes = (await session.scalars(select(Node))).all()
    instances = {node.id: _instance_label(node.base_url, node.name) for node in nodes}

    lines: list[str] = []
    for metric, kind, help_text in _METRICS:
        lines.append(f"# HELP {metric} {help_text}")
        lines.append(f"# TYPE {metric} {kind}")

    for snapshot in await get_all_snapshots():
        if not snapshot.get("reachable"):
            continue
        instance = instances.get(snapshot["node_id"])
        if instance is None:
            continue  # node deleted since the last poll

        for frontend in snapshot.get("frontends", []):
            labels = {"instance": instance, "proxy": frontend["name"]}
            lines.append(_line("haproxy_frontend_current_sessions", labels,
                                frontend.get("sessions_current", 0)))
            lines.append(_line("haproxy_frontend_http_requests_total", labels,
                                frontend.get("requests_total", 0)))
            lines.append(_line("haproxy_frontend_bytes_in_total", labels,
                                frontend.get("bytes_in", 0)))
            lines.append(_line("haproxy_frontend_bytes_out_total", labels,
                                frontend.get("bytes_out", 0)))

        for backend in snapshot.get("backends", []):
            labels = {"instance": instance, "proxy": backend["name"]}
            lines.append(_line("haproxy_backend_connection_errors_total", labels,
                                backend.get("connection_errors", 0)))
            lines.append(_line("haproxy_backend_response_errors_total", labels,
                                backend.get("response_errors", 0)))

    return "\n".join(lines) + "\n"
