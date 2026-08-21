"""Routing lookups: the frontend -> backend links the service view groups by.

These exercise the request layer rather than a parser, because the interesting
behaviour is *which* calls the driver makes: routing lives in the configuration
and must not be refetched on every stats poll.
"""
import pytest

from app.drivers.base import Capability
from app.drivers.dataplane import _ROUTING_CACHE, CONFIG_TTL_SECONDS, DataPlaneDriver


@pytest.fixture(autouse=True)
def _clear_routing_cache():
    # The cache is module-level on purpose (see dataplane.py); tests must not
    # inherit each other's entries.
    _ROUTING_CACHE.clear()
    yield
    _ROUTING_CACHE.clear()


class FakeNode:
    id = 1
    name = "lb-1"
    group = "edge"
    base_url = "http://node:5555"
    api_prefix = "/v3"
    username = "u"
    verify_tls = False
    driver = "dataplane"


def build(prefix="/v3", **responses):
    driver = DataPlaneDriver.__new__(DataPlaneDriver)
    driver.node = FakeNode()
    driver.prefix = prefix
    driver.capabilities = (Capability.READ_STATE, Capability.READ_CONFIG)
    driver.calls = []

    async def _request(method, path, **kwargs):
        driver.calls.append(path)
        if path in responses:
            value = responses[path]
            return value() if callable(value) else value
        return []

    driver._request = _request
    return driver


FRONTENDS = [
    {"name": "stats"},
    {"name": "http-in", "default_backend": "app-back"},
    {"name": "api-in", "default_backend": "app-back"},
]


@pytest.mark.asyncio
async def test_routing_combines_default_and_use_backend():
    driver = build(**{
        "/configuration/version": 7,
        "/configuration/frontends": FRONTENDS,
        "/configuration/frontends/api-in/backend_switching_rules": [
            {"name": "health-back", "cond": "if", "cond_test": "is_health"},
        ],
    })
    routing = await driver._routing_map()

    assert routing["stats"] == (None, [])
    assert routing["http-in"] == ("app-back", [])
    assert routing["api-in"] == ("app-back", ["health-back"])


@pytest.mark.asyncio
async def test_routing_is_cached_until_the_config_version_changes():
    version = 7
    driver = build(**{
        "/configuration/version": lambda: version,
        "/configuration/frontends": FRONTENDS,
    })

    await driver._routing_map()
    first = len([c for c in driver.calls if c == "/configuration/frontends"])
    await driver._routing_map()
    await driver._routing_map()
    # Only the cheap version probe repeats; the frontend list does not.
    assert len([c for c in driver.calls if c == "/configuration/frontends"]) == first == 1

    version = 8
    await driver._routing_map()
    assert len([c for c in driver.calls if c == "/configuration/frontends"]) == 2


@pytest.mark.asyncio
async def test_v2_falls_back_to_a_time_bucket_when_version_is_absent():
    from app.drivers.base import UnsupportedOperation

    def missing():
        raise UnsupportedOperation("no version endpoint on v2")

    driver = build(prefix="/v2", **{
        "/configuration/version": missing,
        "/configuration/frontends": FRONTENDS,
    })
    key = await driver._config_key()
    assert key.startswith("ttl:")
    assert CONFIG_TTL_SECONDS > 0


@pytest.mark.asyncio
async def test_v2_uses_the_query_parameter_form_for_switching_rules():
    driver = build(prefix="/v2")
    path, params = driver._switching_rules_path("api-in")
    assert path == "/configuration/backend_switching_rules"
    assert params == {"frontend": "api-in"}

    driver = build(prefix="/v3")
    path, params = driver._switching_rules_path("api-in")
    assert path == "/configuration/frontends/api-in/backend_switching_rules"
    assert params == {}


@pytest.mark.asyncio
async def test_unreadable_config_never_breaks_the_snapshot():
    from app.drivers.base import DriverError

    def boom():
        raise DriverError("connection reset")

    driver = build(**{"/configuration/version": boom})
    assert await driver._routing_map() == {}


@pytest.mark.asyncio
async def test_stale_routing_is_kept_when_a_refetch_fails():
    state = {"version": 7, "fail": False}

    def version():
        if state["fail"]:
            raise __import__("app.drivers.base", fromlist=["DriverError"]).DriverError("down")
        return state["version"]

    driver = build(**{
        "/configuration/version": version,
        "/configuration/frontends": FRONTENDS,
    })
    good = await driver._routing_map()
    assert good["http-in"] == ("app-back", [])

    state["fail"] = True
    # A blip must not empty the map and make every backend look unrouted.
    assert await driver._routing_map() == good


@pytest.mark.asyncio
async def test_cache_survives_the_driver_being_rebuilt():
    """The poller builds a fresh driver per node per tick.

    A cache stored on the instance looks correct in isolation and refetches the
    whole topology on every poll in production, so this asserts the thing that
    actually matters: a *new* driver for the same node reuses the entry.
    """
    responses = {
        "/configuration/version": 7,
        "/configuration/frontends": FRONTENDS,
    }
    first = build(**responses)
    await first._routing_map()
    assert first.calls.count("/configuration/frontends") == 1

    second = build(**responses)
    routing = await second._routing_map()

    assert routing["http-in"] == ("app-back", [])
    # Only the cheap version probe; the topology came from the cache.
    assert second.calls == ["/configuration/version"]
