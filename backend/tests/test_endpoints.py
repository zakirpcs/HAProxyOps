"""Endpoint tests for the metrics and alerts APIs.

These exist because of how `/nodes/{id}/config` broke: it had page-level tests
in the frontend and none of its own, so a driver method vanishing left it
returning 500 while every suite stayed green. Metrics and alerts had the same
shape - a page that mocks `fetch`, and nothing exercising the route itself.

The app is assembled per test rather than imported: the real one has a lifespan
that runs migrations and starts the poller, none of which a route test wants.
"""

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.deps import current_user, get_session
from app.models import Base, Node, Role, User
from app.routers import fleet as fleet_router
from app.routers import metrics as metrics_router


def _user(role: Role = Role.ADMIN) -> User:
    return User(id=1, username="tester", password_hash="x", role=role, is_active=True)


@pytest_asyncio.fixture
async def ctx():
    """App, client, and a session factory sharing one throwaway database."""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    app = FastAPI()
    app.include_router(metrics_router.router)
    app.include_router(fleet_router.router)

    async def _session():
        async with maker() as session:
            yield session

    role = {"value": Role.ADMIN}

    async def _user_dep():
        return _user(role["value"])

    app.dependency_overrides[get_session] = _session
    app.dependency_overrides[current_user] = _user_dep

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield {"client": client, "maker": maker, "role": role}
    await engine.dispose()


async def _add_node(maker, name="lb-1", node_id=1):
    async with maker() as session:
        session.add(Node(id=node_id, name=name, base_url="http://x:5555",
                         driver="dataplane", api_prefix="/v3"))
        await session.commit()


# --- metrics ----------------------------------------------------------------

@pytest.mark.asyncio
async def test_metrics_status_says_disabled_without_prometheus(ctx, monkeypatch):
    monkeypatch.setattr(metrics_router.settings, "prometheus_url", "")
    r = await ctx["client"].get("/api/metrics/status")
    assert r.status_code == 200
    assert r.json() == {"enabled": False}


@pytest.mark.asyncio
async def test_metrics_status_says_enabled_when_configured(ctx, monkeypatch):
    monkeypatch.setattr(metrics_router.settings, "prometheus_url", "http://prom:9090")
    r = await ctx["client"].get("/api/metrics/status")
    assert r.json() == {"enabled": True}


@pytest.mark.asyncio
async def test_node_metrics_returns_panels(ctx, monkeypatch):
    await _add_node(ctx["maker"])
    panels = [{"key": "sessions", "title": "Current sessions", "unit": "sessions",
               "description": "d", "series": []}]

    async def fake_query_range(node, minutes):
        assert minutes == 60
        return panels

    monkeypatch.setattr(metrics_router, "query_range", fake_query_range)
    r = await ctx["client"].get("/api/nodes/1/metrics")

    assert r.status_code == 200
    assert r.json() == {"node_id": 1, "minutes": 60, "panels": panels}


@pytest.mark.asyncio
async def test_node_metrics_404s_for_an_unknown_node(ctx):
    r = await ctx["client"].get("/api/nodes/999/metrics")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_node_metrics_reports_prometheus_being_down_as_503(ctx, monkeypatch):
    """Not 502: the dashboard is fine, the history source is not.

    A 502 would send an operator looking at the node, which is the wrong place.
    """
    await _add_node(ctx["maker"])
    from app.metrics import MetricsUnavailable

    async def boom(node, minutes):
        raise MetricsUnavailable("prometheus unreachable")

    monkeypatch.setattr(metrics_router, "query_range", boom)
    r = await ctx["client"].get("/api/nodes/1/metrics")

    assert r.status_code == 503
    assert "prometheus" in r.json()["detail"].lower()


@pytest.mark.asyncio
@pytest.mark.parametrize("minutes,expected", [(4, 422), (5, 200), (1440, 200), (1441, 422)])
async def test_the_lookback_window_is_bounded(ctx, monkeypatch, minutes, expected):
    # An unbounded window is a way to ask Prometheus for a year of data by
    # editing a URL.
    await _add_node(ctx["maker"])

    async def fake(node, m):
        return []

    monkeypatch.setattr(metrics_router, "query_range", fake)
    r = await ctx["client"].get(f"/api/nodes/1/metrics?minutes={minutes}")
    assert r.status_code == expected


# --- alerts -----------------------------------------------------------------

def _snapshot(node_id=1, name="lb-1", reachable=True, backends=()):
    return {"node_id": node_id, "node_name": name, "reachable": reachable,
            "enabled": True, "error": None, "backends": list(backends)}


def _backend(name, servers):
    return {"name": name, "servers": [
        {"name": s, "is_up": up, "backup": bk} for s, up, bk in servers]}


@pytest.mark.asyncio
async def test_alerts_is_empty_for_a_healthy_fleet(ctx, monkeypatch):
    async def snaps():
        return [_snapshot(backends=[_backend("app", [("w1", True, False)])])]

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)
    r = await ctx["client"].get("/api/alerts")

    assert r.status_code == 200
    assert r.json()["count"] == 0


@pytest.mark.asyncio
async def test_alerts_reports_a_backend_with_nothing_up(ctx, monkeypatch):
    async def snaps():
        return [_snapshot(backends=[_backend("app", [("w1", False, False)])])]

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)
    r = await ctx["client"].get("/api/alerts")

    body = r.json()
    assert body["count"] == 1
    assert body["alerts"][0]["severity"] == "critical"
    assert "no active servers" in body["alerts"][0]["title"]


@pytest.mark.asyncio
async def test_an_alert_is_pending_until_it_has_been_announced(ctx, monkeypatch):
    """"pending" is a real state, not a rounding of "firing".

    Reporting an un-sent alert as sent would tell an operator a notification
    went out when none did.
    """
    async def snaps():
        return [_snapshot(backends=[_backend("app", [("w1", False, False)])])]

    async def no_state():
        return {}

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)
    monkeypatch.setattr(fleet_router.alerting, "load_state", no_state)
    r = await ctx["client"].get("/api/alerts")

    assert r.json()["alerts"][0]["state"] == "pending"


@pytest.mark.asyncio
async def test_an_alert_already_sent_reads_as_firing(ctx, monkeypatch):
    import time

    async def snaps():
        return [_snapshot(node_id=1, backends=[_backend("app", [("w1", False, False)])])]

    async def state():
        return {"backend-down:1:app": {"since": time.time() - 300,
                                       "notified": time.time() - 240}}

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)
    monkeypatch.setattr(fleet_router.alerting, "load_state", state)
    r = await ctx["client"].get("/api/alerts")

    alert = r.json()["alerts"][0]
    assert alert["state"] == "firing"
    assert alert["for_seconds"] > 200


@pytest.mark.asyncio
async def test_critical_alerts_sort_above_warnings(ctx, monkeypatch):
    async def snaps():
        return [
            _snapshot(node_id=1, name="a",
                      backends=[_backend("warn", [("w1", True, False), ("w2", False, False)])]),
            _snapshot(node_id=2, name="b",
                      backends=[_backend("crit", [("w1", False, False)])]),
        ]

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)
    r = await ctx["client"].get("/api/alerts")

    severities = [a["severity"] for a in r.json()["alerts"]]
    assert severities == ["critical", "warning"]


@pytest.mark.asyncio
async def test_alerts_says_whether_anything_is_actually_delivered(ctx, monkeypatch):
    """Silence must not be mistaken for health.

    The page is useful with no webhook, but it has to be obvious that nothing
    is being sent anywhere.
    """
    async def snaps():
        return []

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)

    monkeypatch.setattr(fleet_router.settings, "alert_webhook_url", "")
    assert (await ctx["client"].get("/api/alerts")).json()["delivery_configured"] is False

    monkeypatch.setattr(fleet_router.settings, "alert_webhook_url", "https://hook")
    assert (await ctx["client"].get("/api/alerts")).json()["delivery_configured"] is True


@pytest.mark.asyncio
async def test_a_disabled_node_raises_nothing(ctx, monkeypatch):
    async def snaps():
        snap = _snapshot(reachable=False)
        snap["enabled"] = False
        return [snap]

    monkeypatch.setattr(fleet_router, "get_all_snapshots", snaps)
    # Polling is off deliberately; alerting on it punishes the operator for
    # having said so.
    assert (await ctx["client"].get("/api/alerts")).json()["count"] == 0


# --- authentication ---------------------------------------------------------

@pytest_asyncio.fixture
async def anon_client():
    """The same routes with no auth override, so the real guard runs."""
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    app = FastAPI()
    app.include_router(metrics_router.router)
    app.include_router(fleet_router.router)

    async def _session():
        async with maker() as session:
            yield session

    app.dependency_overrides[get_session] = _session
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://test") as client:
        yield client
    await engine.dispose()


@pytest.mark.asyncio
@pytest.mark.parametrize("path", [
    "/api/metrics/status",
    "/api/nodes/1/metrics",
    "/api/alerts",
    "/api/fleet",
])
async def test_every_route_refuses_an_anonymous_caller(anon_client, path):
    # The fixture used above overrides the auth dependency, which would hide a
    # route that had lost its guard entirely.
    r = await anon_client.get(path)
    assert r.status_code in (401, 403), f"{path} answered {r.status_code} unauthenticated"


@pytest.mark.asyncio
async def test_the_audit_log_is_admin_only(ctx):
    ctx["role"]["value"] = Role.VIEWER
    r = await ctx["client"].get("/api/audit")
    assert r.status_code == 403
