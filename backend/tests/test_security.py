"""Log redaction and login throttling."""
import logging
from typing import ClassVar

import pytest

from app import ratelimit
from app.logging_filters import RedactSecrets, redact


class FakeRedis:
    def __init__(self):
        self.store, self.ttls = {}, {}

    async def get(self, k):
        return self.store.get(k)

    async def incr(self, k):
        self.store[k] = int(self.store.get(k, 0)) + 1
        return self.store[k]

    async def expire(self, k, s):
        self.ttls[k] = s

    async def ttl(self, k):
        return self.ttls.get(k, -1)

    async def delete(self, *keys):
        for k in keys:
            self.store.pop(k, None)
            self.ttls.pop(k, None)


@pytest.fixture
def redis(monkeypatch):
    fake = FakeRedis()
    monkeypatch.setattr(ratelimit, "get_redis", lambda: fake)
    return fake


# --- redaction --------------------------------------------------------------

def test_sse_token_is_removed_from_a_request_line():
    line = 'GET /api/events?token=eyJhbGciOi.payload.sig HTTP/1.1'
    assert "eyJhbGciOi" not in redact(line)
    assert "token=[REDACTED]" in redact(line)


def test_other_query_parameters_survive():
    out = redact("GET /api/events?token=abc&minutes=60 HTTP/1.1")
    assert "minutes=60" in out and "abc" not in out


def test_paths_without_secrets_are_untouched():
    line = "GET /api/fleet HTTP/1.1"
    assert redact(line) == line


def test_filter_scrubs_positional_args_not_just_the_message():
    # uvicorn passes the request line as an arg and formats later, so scrubbing
    # only record.msg would leave the token in the emitted line.
    record = logging.LogRecord(
        "uvicorn.access", logging.INFO, __file__, 1,
        '%s - "%s" %d', ("1.2.3.4", "GET /api/events?token=SECRET", 200), None,
    )
    RedactSecrets().filter(record)
    assert "SECRET" not in record.getMessage()
    assert "[REDACTED]" in record.getMessage()


# --- login throttling -------------------------------------------------------

@pytest.mark.asyncio
async def test_attempts_are_allowed_below_the_threshold(redis):
    for _ in range(ratelimit.MAX_ATTEMPTS - 1):
        await ratelimit.record_failure("1.2.3.4", "admin")
    assert await ratelimit.check("1.2.3.4", "admin") is None


@pytest.mark.asyncio
async def test_the_threshold_locks_further_attempts(redis):
    for _ in range(ratelimit.MAX_ATTEMPTS):
        await ratelimit.record_failure("1.2.3.4", "admin")
    assert await ratelimit.check("1.2.3.4", "admin") is not None


@pytest.mark.asyncio
async def test_a_success_clears_the_counters(redis):
    for _ in range(ratelimit.MAX_ATTEMPTS):
        await ratelimit.record_failure("1.2.3.4", "admin")
    await ratelimit.clear("1.2.3.4", "admin")
    assert await ratelimit.check("1.2.3.4", "admin") is None


@pytest.mark.asyncio
async def test_one_username_is_throttled_across_many_addresses(redis):
    # The point of the per-username counter: rotating source addresses must not
    # buy an attacker a fresh allowance against the same account.
    for i in range(ratelimit.MAX_ATTEMPTS):
        await ratelimit.record_failure(f"10.0.0.{i}", "admin")
    assert await ratelimit.check("10.0.0.99", "admin") is not None


@pytest.mark.asyncio
async def test_one_address_is_throttled_across_many_usernames(redis):
    for i in range(ratelimit.MAX_ATTEMPTS):
        await ratelimit.record_failure("1.2.3.4", f"user{i}")
    assert await ratelimit.check("1.2.3.4", "someone-else") is not None


@pytest.mark.asyncio
async def test_the_window_does_not_extend_with_each_failure(redis):
    # Otherwise an attacker could keep a victim locked out indefinitely by
    # failing once per window.
    await ratelimit.record_failure("1.2.3.4", "admin")
    first = dict(redis.ttls)
    for _ in range(3):
        await ratelimit.record_failure("1.2.3.4", "admin")
    assert redis.ttls == first


@pytest.mark.asyncio
async def test_it_fails_open_when_redis_is_down(monkeypatch):
    def boom():
        raise ConnectionError("redis unavailable")

    monkeypatch.setattr(ratelimit, "get_redis", boom)
    # Availability beats enforcement: a cache outage must not lock everyone out.
    assert await ratelimit.check("1.2.3.4", "admin") is None


def test_client_ip_trusts_only_the_last_proxy_hop():
    class Req:
        headers: ClassVar[dict[str, str]] = {"x-forwarded-for": "9.9.9.9, 10.0.0.1"}
        client = None

    # A client-supplied chain must not let an attacker forge a fresh bucket.
    assert ratelimit.client_ip(Req()) == "10.0.0.1"


# --- token revocation -------------------------------------------------------

@pytest.fixture
def revoke_redis(monkeypatch):
    from app import revocation
    fake = FakeRedis()

    async def _set(k, v, ex=None):
        fake.store[k] = v
        fake.ttls[k] = ex
    fake.set = _set
    monkeypatch.setattr(revocation, "get_redis", lambda: fake)
    return fake


@pytest.mark.asyncio
async def test_a_fresh_token_is_not_revoked(revoke_redis):
    from app import revocation
    assert await revocation.is_revoked({"sub": "admin", "jti": "a", "iat": 1000}) is False


@pytest.mark.asyncio
async def test_signing_out_revokes_exactly_that_token(revoke_redis):
    import time as _t

    from app import revocation
    await revocation.revoke_token("a", _t.time() + 60)

    assert await revocation.is_revoked({"sub": "admin", "jti": "a", "iat": 1000}) is True
    # A different session of the same user keeps working.
    assert await revocation.is_revoked({"sub": "admin", "jti": "b", "iat": 1000}) is False


@pytest.mark.asyncio
async def test_revoking_a_user_ends_every_session_at_once(revoke_redis):
    import time as _t

    from app import revocation
    await revocation.revoke_all_for("admin")

    old = _t.time() - 10
    assert await revocation.is_revoked({"sub": "admin", "jti": "a", "iat": old}) is True
    assert await revocation.is_revoked({"sub": "admin", "jti": "b", "iat": old}) is True


@pytest.mark.asyncio
async def test_a_cutoff_does_not_block_tokens_issued_afterwards(revoke_redis):
    import time as _t

    from app import revocation
    await revocation.revoke_all_for("admin")

    # Signing back in must work; otherwise revoke-all locks the account out.
    fresh = _t.time() + 5
    assert await revocation.is_revoked({"sub": "admin", "jti": "c", "iat": fresh}) is False


@pytest.mark.asyncio
async def test_a_cutoff_is_scoped_to_one_user(revoke_redis):
    import time as _t

    from app import revocation
    await revocation.revoke_all_for("admin")
    old = _t.time() - 10
    assert await revocation.is_revoked({"sub": "someone", "jti": "d", "iat": old}) is False


@pytest.mark.asyncio
async def test_revocation_fails_open_when_redis_is_down(monkeypatch):
    from app import revocation

    def boom():
        raise ConnectionError("redis unavailable")

    monkeypatch.setattr(revocation, "get_redis", boom)
    # The token is still signed, unexpired, and its account still active - all
    # checked against Postgres. A cache outage must not black out the tool.
    assert await revocation.is_revoked({"sub": "admin", "jti": "a", "iat": 1}) is False


def test_every_issued_token_carries_a_unique_jti():
    from app.security import create_access_token, decode_access_token
    a = decode_access_token(create_access_token("admin", "admin"))
    b = decode_access_token(create_access_token("admin", "admin"))
    assert a["jti"] and b["jti"] and a["jti"] != b["jti"]
