"""Throttle repeated failed logins.

Backed by Redis rather than process memory because the API runs behind a
process manager and can be scaled out: a per-worker counter would multiply the
allowance by the number of workers and reset on every restart.

Two independent counters are kept:

* per **source address**, which stops one host grinding through a password list;
* per **username**, which stops a distributed attempt from spreading the same
  guesses for one account across many addresses.

Only failures count. A correct password clears both, so ordinary use - a typo,
then the right password - never trips it.
"""
import logging
import time

from .state import get_redis

log = logging.getLogger("haproxyops")

#: Failures allowed inside the window before the key is refused.
MAX_ATTEMPTS = 10
#: Sliding window, in seconds. Also how long a lockout lasts.
WINDOW_SECONDS = 300

_PREFIX = "haproxyops:login-fail:"


def _keys(ip: str, username: str) -> list[str]:
    # Usernames are lower-cased so casing variations share a bucket; the
    # address is kept verbatim.
    return [f"{_PREFIX}ip:{ip}", f"{_PREFIX}user:{username.strip().lower()}"]


async def check(ip: str, username: str) -> int | None:
    """Seconds to wait, or None when the attempt may proceed.

    Fails **open**: if Redis is unavailable the login is allowed rather than
    locking every user out of the dashboard because a cache is down. The event
    is logged, because silently losing a security control is worse than the
    outage itself.
    """
    try:
        client = get_redis()
        for key in _keys(ip, username):
            count = await client.get(key)
            if count is not None and int(count) >= MAX_ATTEMPTS:
                ttl = await client.ttl(key)
                return max(1, ttl) if ttl and ttl > 0 else WINDOW_SECONDS
    except Exception:
        log.warning("login rate limiting unavailable; allowing the attempt", exc_info=True)
    return None


async def record_failure(ip: str, username: str) -> None:
    try:
        client = get_redis()
        for key in _keys(ip, username):
            # INCR then EXPIRE only on the first failure, so the window is
            # fixed from the first bad attempt rather than extending with each
            # one - an attacker cannot hold a victim locked out indefinitely.
            count = await client.incr(key)
            if count == 1:
                await client.expire(key, WINDOW_SECONDS)
    except Exception:
        log.warning("could not record a failed login", exc_info=True)


async def clear(ip: str, username: str) -> None:
    try:
        await get_redis().delete(*_keys(ip, username))
    except Exception:
        log.warning("could not clear login failures", exc_info=True)


def client_ip(request) -> str:
    """Source address, honouring one layer of trusted proxy.

    The dashboard sits behind nginx on the same host, so X-Forwarded-For is
    written by our own proxy. Only the last hop is trusted; a client-supplied
    chain is ignored beyond that.
    """
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[-1].strip()
    return request.client.host if request.client else "unknown"


def now() -> float:
    return time.monotonic()
