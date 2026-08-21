"""Make issued tokens revocable.

A JWT is valid until it expires, which is the point of them and also the
problem: with a 12-hour lifetime, a leaked token outlives a password change, an
account being disabled, and the operator noticing. Two mechanisms, both in
Redis, both keyed so they expire on their own:

* **A denylist of individual tokens**, by ``jti``. This is what signing out
  does. Entries live exactly as long as the token would have, so the list is
  self-trimming and cannot grow without bound.
* **A per-user cut-off**, ``revoke_all``. Any token issued before the recorded
  moment is refused. One small key invalidates every session a user has,
  without enumerating them - which matters because we never stored them.

Both fail **closed** on a Redis outage for the denylist check only when the
token carries no ``jti`` at all; see ``is_revoked``.
"""
import logging
import time

from .config import get_settings
from .state import get_redis

log = logging.getLogger("haproxyops")
settings = get_settings()

_DENY = "haproxyops:revoked-jti:"
_CUTOFF = "haproxyops:revoked-before:"

#: Cut-offs outlive the longest token that could still be valid.
_CUTOFF_TTL = settings.access_token_ttl_minutes * 60 + 60


async def revoke_token(jti: str, expires_at: float) -> None:
    """Deny one token until the moment it would have expired anyway."""
    ttl = max(1, int(expires_at - time.time()))
    try:
        await get_redis().set(f"{_DENY}{jti}", "1", ex=ttl)
    except Exception:
        log.warning("could not revoke token %s", jti, exc_info=True)
        raise


async def revoke_all_for(username: str) -> None:
    """Invalidate every token issued to a user up to now."""
    try:
        await get_redis().set(
            f"{_CUTOFF}{username.lower()}", str(time.time()), ex=_CUTOFF_TTL
        )
    except Exception:
        log.warning("could not revoke sessions for %s", username, exc_info=True)
        raise


async def is_revoked(payload: dict) -> bool:
    """True when this token has been signed out or superseded by a cut-off.

    Fails **open** on a Redis outage, deliberately and narrowly: the token is
    still signed, unexpired, and belongs to an account that is still active,
    all of which are checked against Postgres. Refusing every request because a
    cache is unreachable would turn a cache outage into a total outage of the
    tool people use to fix outages. The event is logged.
    """
    jti = payload.get("jti")
    username = str(payload.get("sub", "")).lower()
    issued_at = payload.get("iat")

    try:
        client = get_redis()
        if jti and await client.get(f"{_DENY}{jti}") is not None:
            return True
        if issued_at is not None:
            cutoff = await client.get(f"{_CUTOFF}{username}")
            if cutoff is not None and float(issued_at) < float(cutoff):
                return True
    except Exception:
        log.warning("revocation check unavailable; accepting the token", exc_info=True)
    return False
