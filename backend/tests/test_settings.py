"""The alert webhook endpoints: admin-only, and never round-tripping the URL.

Same reasoning as test_endpoints.py: a route test, not just a page test that
mocks fetch, because that is exactly the gap that let /nodes/{id}/config
regress silently once before.
"""
import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.deps import current_user, get_session
from app.models import Base, Role, User
from app.routers import settings as settings_router


def _user(role: Role = Role.ADMIN) -> User:
    return User(id=1, username="tester", password_hash="x", role=role, is_active=True)


@pytest_asyncio.fixture
async def ctx():
    engine = create_async_engine("sqlite+aiosqlite://")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False)

    app = FastAPI()
    app.include_router(settings_router.router)

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
        yield {"client": client, "role": role, "maker": maker}
    await engine.dispose()


@pytest.mark.asyncio
async def test_starts_unconfigured(ctx, monkeypatch):
    monkeypatch.setattr(settings_router.settings_store.settings, "alert_webhook_url", "")
    r = await ctx["client"].get("/api/settings/alert-webhook")
    assert r.json() == {"configured": False, "source": "none"}


@pytest.mark.asyncio
async def test_setting_it_reports_the_ui_source(ctx, monkeypatch):
    monkeypatch.setattr(settings_router.settings_store.settings, "alert_webhook_url", "")
    r = await ctx["client"].put(
        "/api/settings/alert-webhook", json={"webhook_url": "https://hooks.example.com/x"},
    )
    assert r.json() == {"configured": True, "source": "ui"}

    r = await ctx["client"].get("/api/settings/alert-webhook")
    assert r.json() == {"configured": True, "source": "ui"}


@pytest.mark.asyncio
async def test_the_url_is_never_returned():
    """Like a node password: write-only once saved, since a webhook URL
    routinely embeds a bearer secret (Slack/Discord put it in the path)."""
    import json as jsonlib

    from app.routers.settings import AlertWebhookStatus

    assert "webhook_url" not in AlertWebhookStatus.model_fields
    assert jsonlib.dumps(AlertWebhookStatus(configured=True, source="ui").model_dump())


@pytest.mark.asyncio
async def test_a_ui_value_overrides_the_env_var(ctx, monkeypatch):
    monkeypatch.setattr(settings_router.settings_store.settings, "alert_webhook_url", "https://env-hook")
    await ctx["client"].put(
        "/api/settings/alert-webhook", json={"webhook_url": "https://ui-hook"},
    )
    r = await ctx["client"].get("/api/settings/alert-webhook")
    assert r.json() == {"configured": True, "source": "ui"}


@pytest.mark.asyncio
async def test_clearing_falls_back_to_the_env_var(ctx, monkeypatch):
    monkeypatch.setattr(settings_router.settings_store.settings, "alert_webhook_url", "https://env-hook")
    await ctx["client"].put("/api/settings/alert-webhook", json={"webhook_url": "https://ui-hook"})

    r = await ctx["client"].put("/api/settings/alert-webhook", json={"clear": True})
    assert r.json() == {"configured": True, "source": "env"}


@pytest.mark.asyncio
async def test_clearing_with_nothing_in_the_env_is_unconfigured(ctx, monkeypatch):
    monkeypatch.setattr(settings_router.settings_store.settings, "alert_webhook_url", "")
    await ctx["client"].put("/api/settings/alert-webhook", json={"webhook_url": "https://ui-hook"})

    r = await ctx["client"].put("/api/settings/alert-webhook", json={"clear": True})
    assert r.json() == {"configured": False, "source": "none"}


@pytest.mark.asyncio
async def test_neither_url_nor_clear_is_rejected(ctx):
    r = await ctx["client"].put("/api/settings/alert-webhook", json={})
    assert r.status_code == 422


@pytest.mark.asyncio
async def test_a_non_http_url_is_rejected(ctx):
    r = await ctx["client"].put(
        "/api/settings/alert-webhook", json={"webhook_url": "not-a-url"},
    )
    assert r.status_code == 422


@pytest.mark.asyncio
@pytest.mark.parametrize("method", ["get", "put"])
async def test_admin_only(ctx, method):
    ctx["role"]["value"] = Role.OPERATOR
    kwargs = {"json": {"webhook_url": "https://hook"}} if method == "put" else {}
    r = await getattr(ctx["client"], method)("/api/settings/alert-webhook", **kwargs)
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_change_is_audited(ctx):
    from sqlalchemy import select

    from app.models import AuditLog

    await ctx["client"].put(
        "/api/settings/alert-webhook", json={"webhook_url": "https://hooks.example.com/x"},
    )

    async with ctx["maker"]() as session:
        rows = (await session.scalars(select(AuditLog))).all()
    assert [r.action for r in rows] == ["settings.alert_webhook"]
    assert rows[0].detail == "updated"
    # The audited detail says whether it changed, never the URL itself.
    assert "hooks.example.com" not in (rows[0].detail or "")
