"""Prometheus-backed history for a single node.

HAProxyOps stores no time series of its own - it owns control and current
state. Trends come from Prometheus scraping the exporter that HAProxy 2.0+
serves natively on its stats port.

Panels are defined here, server-side, rather than accepting PromQL from the
browser. An authenticated dashboard that forwards arbitrary queries is an open
proxy into the metrics estate; a fixed set of panels is also what lets the UI
stay a dumb renderer.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from .config import get_settings
from .models import Node

settings = get_settings()

#: Series shown per panel. Beyond this the tail is folded into "Other" - adding
#: more colours past the validated palette makes series indistinguishable.
MAX_SERIES = 6


class MetricsUnavailable(RuntimeError):
    """Prometheus is not configured, unreachable, or rejected the query."""


@dataclass(frozen=True)
class Panel:
    key: str
    title: str
    unit: str
    #: One entry per query: (promql, label, fixed_name).
    #: The literal token SEL is replaced by the node's braced label selector -
    #: PromQL is full of braces, so str.format() is not usable here.
    queries: tuple[tuple[str, str | None, str | None], ...]
    description: str = ""


_K = str(MAX_SERIES)

PANELS: tuple[Panel, ...] = (
    Panel(
        key="sessions",
        title="Current sessions",
        unit="sessions",
        description="Concurrent sessions per frontend.",
        queries=(
            ("topk(" + _K + ", haproxy_frontend_current_sessionsSEL)", "proxy", None),
        ),
    ),
    Panel(
        key="request_rate",
        title="HTTP requests",
        unit="req/s",
        description="Request rate per frontend, averaged over 2 minutes.",
        queries=(
            ("topk(" + _K + ", rate(haproxy_frontend_http_requests_totalSEL[2m]))",
             "proxy", None),
        ),
    ),
    Panel(
        key="errors",
        title="Backend errors",
        unit="errors/s",
        description="Connection plus response errors per backend.",
        queries=(
            ("topk(" + _K + ", rate(haproxy_backend_connection_errors_totalSEL[2m])"
             " + rate(haproxy_backend_response_errors_totalSEL[2m]))", "proxy", None),
        ),
    ),
    Panel(
        key="throughput",
        title="Frontend throughput",
        unit="bytes/s",
        description="Bytes in and out across all frontends.",
        queries=(
            ("sum(rate(haproxy_frontend_bytes_in_totalSEL[2m]))", None, "in"),
            ("sum(rate(haproxy_frontend_bytes_out_totalSEL[2m]))", None, "out"),
        ),
    ),
)


def instance_selector(node: Node) -> str:
    """PromQL label selector matching this node's scrape target.

    Uses the node's explicit `prometheus_instance` when set. Otherwise it falls
    back to matching any port on the same host, because the scrape target is
    the stats port (8404) while `base_url` points at the Data Plane API (5555).
    """
    explicit = getattr(node, "prometheus_instance", None)
    if explicit:
        return f'instance="{explicit}"'
    host = urlparse(node.base_url).hostname or node.name
    return f'instance=~"{host}:.*"'


def _step_for(minutes: int) -> int:
    """Target ~240 points: enough resolution without oversized payloads."""
    return max(15, int(minutes * 60 / 240))


async def query_range(node: Node, minutes: int) -> list[dict[str, Any]]:
    """Fetch every panel for a node over the last `minutes`."""
    if not settings.prometheus_url:
        raise MetricsUnavailable(
            "No Prometheus configured. Set HAPROXYOPS_PROMETHEUS_URL to enable graphs."
        )

    end = time.time()
    start = end - minutes * 60
    step = _step_for(minutes)
    sel = instance_selector(node)

    async with httpx.AsyncClient(
        base_url=settings.prometheus_url.rstrip("/"),
        timeout=settings.prometheus_timeout_seconds,
    ) as client:
        panels = []
        for panel in PANELS:
            series: list[dict[str, Any]] = []
            for template, label, fixed_name in panel.queries:
                promql = template.replace("SEL", "{" + sel + "}")
                series.extend(
                    await _run(client, promql, start, end, step, label, fixed_name)
                )
            panels.append({
                "key": panel.key,
                "title": panel.title,
                "unit": panel.unit,
                "description": panel.description,
                "series": series,
            })

    return panels


async def _run(
    client: httpx.AsyncClient,
    promql: str,
    start: float,
    end: float,
    step: int,
    label: str | None,
    fixed_name: str | None,
) -> list[dict[str, Any]]:
    try:
        response = await client.get(
            "/api/v1/query_range",
            params={"query": promql, "start": start, "end": end, "step": step},
        )
    except httpx.HTTPError as exc:
        raise MetricsUnavailable(f"Prometheus unreachable: {exc}") from exc

    if response.status_code >= 400:
        # Prometheus puts the parse error in the body; surfacing it beats a 502.
        detail = response.text[:300]
        raise MetricsUnavailable(f"Prometheus returned {response.status_code}: {detail}")

    payload = response.json()
    if payload.get("status") != "success":
        raise MetricsUnavailable(payload.get("error", "Prometheus query failed"))

    out = []
    for result in payload["data"]["result"]:
        name = fixed_name or (result["metric"].get(label) if label else None) or "value"
        out.append({
            "name": name,
            # [[unix_seconds, value], ...]; nulls mark real gaps so the chart
            # can break the line instead of interpolating across an outage.
            "points": [
                [float(ts), None if v in ("NaN", "+Inf", "-Inf") else float(v)]
                for ts, v in result["values"]
            ],
        })
    return out
