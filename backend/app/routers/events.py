"""Server-Sent Events stream of snapshot updates.

EventSource cannot set an Authorization header, so this endpoint also accepts
`?token=`. Keep that in mind when configuring access logs on the reverse proxy -
see deploy/nginx/haproxyops.conf, which strips the query string from its logs.
"""
import json
import logging

import jwt
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from ..security import decode_access_token
from ..state import CHANNEL, get_all_snapshots, get_redis

router = APIRouter(prefix="/api", tags=["events"])
log = logging.getLogger("haproxyops.events")

HEARTBEAT_SECONDS = 20


def _authorise(request: Request, token: str | None) -> str:
    raw = token
    if raw is None:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            raw = header[7:]
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        return decode_access_token(raw)["sub"]
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token") from None


@router.get("/events")
async def events(request: Request, token: str | None = Query(default=None)) -> StreamingResponse:
    username = _authorise(request, token)

    async def stream():
        pubsub = get_redis().pubsub()
        await pubsub.subscribe(CHANNEL)
        try:
            # Prime the client with current state so it renders immediately
            # instead of waiting out a poll interval.
            for snapshot in await get_all_snapshots():
                yield f"event: snapshot\ndata: {json.dumps(snapshot)}\n\n"
            while True:
                if await request.is_disconnected():
                    break
                message = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=HEARTBEAT_SECONDS
                )
                if message is None:
                    # Comment frame: keeps idle proxies from dropping the stream.
                    yield ": keepalive\n\n"
                    continue
                yield f"event: snapshot\ndata: {message['data']}\n\n"
        finally:
            # Cancellation propagates on its own; this block is what matters,
            # and it runs whether the client disconnected or the task was
            # cancelled out from under us.
            await pubsub.unsubscribe(CHANNEL)
            await pubsub.aclose()
            log.debug("SSE stream closed for %s", username)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",  # nginx: do not buffer this response
        },
    )
