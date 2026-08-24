"""Runtime settings editable from the UI - currently just the alert webhook."""
from fastapi import APIRouter, HTTPException, Request, status

from .. import settings_store
from ..deps import RequireAdmin, SessionDep, write_audit
from ..schemas import AlertWebhookStatus, AlertWebhookUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/alert-webhook", response_model=AlertWebhookStatus)
async def get_alert_webhook(_: RequireAdmin, session: SessionDep) -> AlertWebhookStatus:
    configured, source = await settings_store.alert_webhook_status(session)
    return AlertWebhookStatus(configured=configured, source=source)


@router.put("/alert-webhook", response_model=AlertWebhookStatus)
async def set_alert_webhook(
    payload: AlertWebhookUpdate, user: RequireAdmin, session: SessionDep, request: Request,
) -> AlertWebhookStatus:
    if not payload.clear and not payload.webhook_url:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            "Provide webhook_url, or set clear to remove the stored one.",
        )

    await settings_store.set_alert_webhook_url(session, None if payload.clear else payload.webhook_url)
    await write_audit(
        session, request, user, "settings.alert_webhook",
        detail="cleared" if payload.clear else "updated",
    )
    await session.commit()

    configured, source = await settings_store.alert_webhook_status(session)
    return AlertWebhookStatus(configured=configured, source=source)
