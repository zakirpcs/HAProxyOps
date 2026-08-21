"""Live fleet state: Redis-backed cache plus a pub/sub fan-out for SSE clients.

Browsers never trigger a poll. The poller owns every connection to every node
and writes here; the API reads here. That keeps load on the HAProxy boxes flat
no matter how many dashboards are open.
"""
from __future__ import annotations

import json
from dataclasses import asdict, is_dataclass
from datetime import datetime
from enum import Enum
from typing import Any

import redis.asyncio as redis

from .config import get_settings
from .drivers.base import NodeSnapshot

CHANNEL = "haproxyops:snapshots"
KEY_PREFIX = "haproxyops:node:"

settings = get_settings()
_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    global _client
    if _client is None:
        _client = redis.from_url(settings.redis_url, decode_responses=True)
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


def _encode(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, Enum):
        return str(value)
    raise TypeError(f"cannot serialise {type(value)!r}")


def snapshot_to_dict(snapshot: NodeSnapshot) -> dict[str, Any]:
    if not is_dataclass(snapshot):
        raise TypeError("expected a NodeSnapshot")
    data = asdict(snapshot)
    # Re-attach the derived fields the UI renders but asdict() skips.
    for frontend, src_frontend in zip(data["frontends"], snapshot.frontends, strict=True):
        frontend["routed_backends"] = src_frontend.routed_backends
    for backend, source in zip(data["backends"], snapshot.backends, strict=True):
        backend["servers_up"] = source.servers_up
        backend["servers_total"] = len(source.servers)
        for server, src_server in zip(backend["servers"], source.servers, strict=True):
            server["is_up"] = src_server.is_up
    return data


async def store_snapshot(snapshot: NodeSnapshot) -> None:
    payload = json.dumps(snapshot_to_dict(snapshot), default=_encode)
    client = get_redis()
    await client.set(f"{KEY_PREFIX}{snapshot.node_id}", payload, ex=settings.state_ttl_seconds)
    await client.publish(CHANNEL, payload)


async def get_snapshot(node_id: int) -> dict[str, Any] | None:
    raw = await get_redis().get(f"{KEY_PREFIX}{node_id}")
    return json.loads(raw) if raw else None


async def get_all_snapshots() -> list[dict[str, Any]]:
    client = get_redis()
    keys = [key async for key in client.scan_iter(match=f"{KEY_PREFIX}*", count=500)]
    if not keys:
        return []
    values = await client.mget(keys)
    return [json.loads(v) for v in values if v]


async def drop_snapshot(node_id: int) -> None:
    await get_redis().delete(f"{KEY_PREFIX}{node_id}")
